// Driver actions on a booking (Authorization: Bearer <supabase session JWT>).
//   POST /api/update-booking-status {bookingId, action, paymentMethod?, lat?, lng?}
//
// Identity: CreditEngine requireDriver pattern — JWT verified with the
// anon-key client, then a matching drivers row is required (active or
// busy; busy drivers may finish their own rides but cannot accept new
// ones). Accept — and only accept — stamps assigned_driver, atomically
// with the transition and only on an UNASSIGNED pending request, so one
// driver can ever win a ride. Every later action requires an EXACT
// ownership match; legacy rows are assigned by the migration-009 cutover,
// never by opportunistic claiming. A retried request whose first attempt
// committed is recognized as success ONLY here, after verifying both the
// resulting status and ownership (client 409s are never success).
// Transitions are enforced server-side; a stale click (booking already moved
// on) matches 0 rows and returns 409 instead of clobbering state.
//
// Checkpoint model: on_my_way / arrived / start_trip may carry the driver's
// verified location, stamped in the SAME atomic update as the status — one
// request per checkpoint, no separate location endpoint to coordinate with.
// A transition never fails because of missing or bad coordinates — but a
// checkpoint WITHOUT fresh valid coordinates CLEARS the stored location.
// The passenger label derives from the current status, so preserving an
// older coordinate would relabel it as this checkpoint (e.g. the departure
// point shown as "arrived at pickup"). Honest absence beats a stale lie.

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHECKPOINT_ACTIONS = ['on_my_way', 'arrived', 'start_trip'];

function validCoords(lat, lng) {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
         typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

async function requireDriver(event, supabaseUrl, anonKey, db) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { status: 401, error: 'Not authenticated' };

  const authClient = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user) return { status: 401, error: 'Invalid session' };

  const { data: driver, error: driverError } = await db
    .from('drivers')
    .select('id, name, phone, status')
    .eq('user_id', userData.user.id)
    .single();
  if (driverError || !driver) return { status: 403, error: 'No driver account' };
  if (driver.status !== 'active' && driver.status !== 'busy') {
    return { status: 403, error: 'Driver account inactive' };
  }

  return { driver };
}

// No driver-side decline: with shared pending requests, one driver
// declining would kill the offer for the whole company. Not accepting IS
// the per-driver decline; the `declined` status remains in the DB for
// legacy rows and future admin tooling.
const TRANSITIONS = {
  accept:     { from: ['pending'],                              set: { status: 'confirmed' } },
  on_my_way:  { from: ['confirmed'],                            set: { status: 'on_the_way' } },
  arrived:    { from: ['on_the_way'],                           set: { status: 'arrived' } },
  start_trip: { from: ['arrived'],                              set: { status: 'in_progress' } },
  complete:   { from: ['in_progress', 'arrived', 'on_the_way'], set: { status: 'completed' } }
};

// payment_collected doesn't touch status — allowed on any live/finished ride
const PAYMENT_ALLOWED_STATUSES = ['confirmed', 'on_the_way', 'arrived', 'in_progress', 'completed'];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseServiceKey || !anonKey) {
    console.error('❌ Missing Supabase configuration');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const auth = await requireDriver(event, supabaseUrl, anonKey, supabase);
  if (!auth.driver) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }
  const driver = auth.driver;

  try {
    const { bookingId, action, paymentMethod, lat, lng } = JSON.parse(event.body || '{}');

    if (!bookingId || !UUID_RE.test(bookingId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid bookingId' }) };
    }

    let fromStatuses;
    let updates;

    if (action === 'payment_collected') {
      fromStatuses = PAYMENT_ALLOWED_STATUSES;
      updates = {
        payment_status: 'paid_by_guest',
        payment_method: paymentMethod === 'zelle' ? 'zelle' : 'cash'
      };
    } else if (TRANSITIONS[action]) {
      if (action === 'accept' && driver.status !== 'active') {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Busy drivers cannot accept new rides' }) };
      }
      fromStatuses = TRANSITIONS[action].from;
      updates = { ...TRANSITIONS[action].set };
      // Accept — and only accept — claims the ride. Legacy rows are
      // assigned explicitly by the migration-009 cutover, never claimed.
      if (action === 'accept') {
        updates.assigned_driver = driver.id;
      }
      if (CHECKPOINT_ACTIONS.includes(action)) {
        const fresh = validCoords(lat, lng);
        updates.driver_lat = fresh ? lat : null;
        updates.driver_lng = fresh ? lng : null;
        updates.driver_location_at = fresh ? new Date().toISOString() : null;
      }
      if (action === 'complete') {
        updates.completed_at = new Date().toISOString();
        // Privacy: wipe the driver's last stored position when the ride
        // ends. `complete` is the only terminal transition reachable from
        // the active tracking window (cancel/decline are pending-only), so
        // this fully covers coordinate cleanup.
        updates.driver_lat = null;
        updates.driver_lng = null;
        updates.driver_location_at = null;
      }
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    // Ownership: accept only ever wins an UNASSIGNED pending request;
    // everything else requires an EXACT ownership match. Enforced in the
    // same guarded UPDATE as the status race check — a non-owner matches
    // 0 rows and falls through to the 409/idempotency logic below.
    let query = supabase
      .from('bookings')
      .update(updates)
      .eq('id', bookingId)
      .in('status', fromStatuses);
    if (action === 'accept') {
      query = query.is('assigned_driver', null);
    } else {
      query = query.eq('assigned_driver', driver.id);
    }
    const { data, error } = await query.select();

    if (error) {
      console.error(`❌ ${action} failed:`, error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Update failed' }) };
    }

    if (!data || data.length === 0) {
      const { data: current } = await supabase
        .from('bookings')
        .select('status, assigned_driver')
        .eq('id', bookingId)
        .single();
      // VERIFIED idempotent success — only the backend may declare it, and
      // only when the booking already sits at exactly this action's result
      // AND belongs to exactly this driver (a retried request whose first
      // attempt committed but whose response was lost). A non-owner's
      // conflict is never success.
      if (current && TRANSITIONS[action] &&
          current.status === TRANSITIONS[action].set.status &&
          current.assigned_driver === driver.id) {
        console.log(`✅ Booking ${bookingId}: ${action} (idempotent duplicate)`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, idempotent: true }) };
      }
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'Invalid transition',
          currentStatus: current?.status || 'unknown'
        })
      };
    }

    console.log(`✅ Booking ${bookingId}: ${action}`);

    // Telegram receipts to the admin: ride started, and a closing receipt
    // on completion. Informational only — all control stays in the web app.
    await sendReceipt(action, data[0]);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, booking: data[0] }) };
  } catch (error) {
    console.error('❌ update-booking-status error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

async function sendReceipt(action, b) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.ADMIN_TELEGRAM_CHAT_ID) return;

  let text = null;
  if (action === 'on_my_way') {
    text = `🚗 Trip ${b.trip_id || b.id.slice(0, 8)} started
${b.pickup_location} → ${b.dropoff_location}
👤 ${b.customer_name}`;
  } else if (action === 'complete') {
    const commission = parseFloat(b.host_commission) > 0
      ? `\n★ Ambassador commission: $${b.host_commission}`
      : '';
    text = `🏁 Trip ${b.trip_id || b.id.slice(0, 8)} completed — receipt
${b.pickup_location} → ${b.dropoff_location}
👤 ${b.customer_name}
⏱ ${b.duration_minutes ? `~${b.duration_minutes} min ride` : 'duration n/a'}
💵 $${b.price} · ${b.payment_status === 'unpaid' ? 'NOT yet collected' : 'collected'}${commission}`;
  }
  if (!text) return;

  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.ADMIN_TELEGRAM_CHAT_ID, text })
    });
  } catch (e) {
    console.warn('⚠️ Receipt send failed:', e.message);
  }
}
