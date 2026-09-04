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
//
// Readiness (PR 1): `ready` records the driver's explicit T-150
// confirmation (driver_ready_by/at/source='web') — internal operational
// state only, never a passenger status, never a location capture, and
// the T-180 window is enforced server-side (the UI gate is not
// security). Recent acceptance (accept at/after T-180) satisfies
// readiness at accept time ('recent_accept'). On my way stamps
// on_the_way_at and clears at_risk_at but NEVER writes driver_ready_* —
// the on_the_way status itself is the implicit readiness proof, and a
// read-then-write here could race an explicit confirmation and
// overwrite 'web' with 'implicit'. Every transition also stamps its
// durable timestamp (accepted_at, on_the_way_at, arrived_at,
// started_at) atomically with the status — the scheduling anchors for
// the notification watchdog.

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

// Recent acceptance IS readiness: accepting a ride that starts within
// 3 hours is itself the commitment check — the readiness chain is never
// generated and the driver is never nagged for a ride they just took.
const RECENT_ACCEPT_MS = 180 * 60 * 1000;

// DEPARTURE WINDOW (initial LinkMia operator policy, 2026-09-04): "On my
// way" means the driver is actually leaving, so it opens TOGETHER with the
// readiness window at T-180 and never earlier — one boundary in the
// system, no second clock. Reliability is the product: a passenger must
// never see "On the way" for a ride that is still days or hours away.
// Later a dashboard-configurable dispatch setting; there is deliberately
// NO late bound (a late driver must always be able to report the truth).
const DEPARTURE_WINDOW_MS = RECENT_ACCEPT_MS;

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
    const { bookingId, action, paymentMethod, lat, lng, expectedDetailsVersion } = JSON.parse(event.body || '{}');

    if (!bookingId || !UUID_RE.test(bookingId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid bookingId' }) };
    }

    let fromStatuses;
    let updates;
    // ONE captured server instant drives every time decision in this
    // request (departure cutoff, verdict, and the on_the_way_at stamp).
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    // Departure window cutoff, set only for on_my_way: the guarded UPDATE
    // itself requires pickup_datetime <= now + window, so the time gate is
    // ATOMIC with the transition (a reschedule between a read and the
    // write can never let a far-future ride become on_the_way).
    let departureCutoffIso = null;

    if (action === 'payment_collected') {
      fromStatuses = PAYMENT_ALLOWED_STATUSES;
      updates = {
        payment_status: 'paid_by_guest',
        payment_method: paymentMethod === 'zelle' ? 'zelle' : 'cash'
      };
    } else if (action === 'ready') {
      // Explicit readiness confirmation (the T-150 check). Internal
      // operational state ONLY: no passenger status change, no location
      // capture. Records WHO confirmed — readiness is valid only while
      // driver_ready_by still matches assigned_driver — and clears any
      // at-risk mark in the same atomic update.
      //
      // The T-180 window is enforced HERE, server-side — the UI gate is
      // convenience, not security. FAIL CLOSED: a read failure is a real
      // 500; a booking whose pickup time is missing or unparseable gets
      // 409 (readiness timing cannot be verified, so readiness is never
      // recorded). Only a MISSING booking falls through to the guarded
      // update, which yields the normal not-found/conflict response.
      const { data: pre, error: preError } = await supabase
        .from('bookings').select('pickup_datetime').eq('id', bookingId).maybeSingle();
      if (preError) {
        console.error('❌ ready: pickup window read failed:', preError.message || preError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Readiness check failed' }) };
      }
      if (pre) {
        const readyPickupMs = Date.parse(pre.pickup_datetime);
        if (!Number.isFinite(readyPickupMs)) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({ error: 'Booking has no valid pickup time — readiness unavailable' })
          };
        }
        if (readyPickupMs - Date.now() > RECENT_ACCEPT_MS) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({ error: 'Too early — readiness confirmation opens 3 hours before pickup' })
          };
        }
      }
      fromStatuses = ['confirmed'];
      updates = {
        driver_ready_by: driver.id,
        driver_ready_at: nowIso,
        driver_ready_source: 'web',
        at_risk_at: null
      };
    } else if (TRANSITIONS[action]) {
      if (action === 'accept' && driver.status !== 'active') {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Busy drivers cannot accept new rides' }) };
      }
      if (action === 'accept' &&
          (!Number.isInteger(expectedDetailsVersion) || expectedDetailsVersion < 1)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid details version' }) };
      }
      fromStatuses = TRANSITIONS[action].from;
      updates = { ...TRANSITIONS[action].set };
      // Accept — and only accept — claims the ride. Legacy rows are
      // assigned explicitly by the migration-009 cutover, never claimed.
      if (action === 'accept') {
        updates.assigned_driver = driver.id;
        // Durable anchor: stamped atomically with the transition so the
        // watchdog can derive readiness timing from it.
        updates.accepted_at = nowIso;
        // Recent acceptance IS readiness (accept at/after T-180). The
        // The pre-read can race a pending edit, but the guarded UPDATE also
        // matches details_version. If the edit commits first, Accept matches
        // zero rows and the driver refreshes the revised offer; if Accept
        // commits first, the passenger edit matches zero rows. No stale
        // pickup time can therefore be stamped onto an accepted ride.
        // (Tolerant on read failure: accepting the ride is the critical
        // path; a missed recent-accept stamp only means the readiness
        // chain runs — annoying, never wrong.)
        const { data: pre } = await supabase
          .from('bookings').select('pickup_datetime').eq('id', bookingId).maybeSingle();
        const pickupMs = pre ? Date.parse(pre.pickup_datetime) : NaN;
        if (Number.isFinite(pickupMs) && pickupMs - Date.now() <= RECENT_ACCEPT_MS) {
          updates.driver_ready_by = driver.id;
          updates.driver_ready_at = nowIso;
          updates.driver_ready_source = 'recent_accept';
        }
      }
      if (action === 'on_my_way') {
        // DEPARTURE WINDOW — enforced with SERVER time INSIDE the guarded
        // UPDATE (see the pickup_datetime cutoff predicate below), so it is
        // atomic with the status transition: no read-then-write gap, and a
        // NULL/invalid pickup time can never match (fail closed). The
        // driver UI's disabled button is convenience, not security — a
        // stale open tab and a direct
        // request hit the same predicate (/driver is deliberately uncached).
        // A zero-row result is classified AFTER the verified-idempotency
        // checks (an already-departed owned ride answers 200 regardless of
        // its pickup time), then as a typed departure refusal for the
        // OWNER only; a non-owner gets the ordinary conflict with no
        // window information. Exactly T-180 is allowed; NO late bound.
        departureCutoffIso = new Date(nowMs + DEPARTURE_WINDOW_MS).toISOString();
        // Durable anchor + at-risk clear. driver_ready_* is deliberately
        // NOT written here: the on_the_way status and on_the_way_at stamp
        // ARE the implicit readiness proof (the watchdog suppresses the
        // chain for active rides), and any read-then-write of readiness
        // fields could race a concurrent explicit 'web' confirmation and
        // overwrite it with 'implicit'. An existing explicit or
        // recent-accept record is therefore always preserved.
        updates.on_the_way_at = nowIso;
        updates.at_risk_at = null;
      }
      if (action === 'arrived') {
        updates.arrived_at = nowIso;
      }
      if (action === 'start_trip') {
        updates.started_at = nowIso;
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
      query = query
        .is('assigned_driver', null)
        .eq('details_version', expectedDetailsVersion);
    } else {
      query = query.eq('assigned_driver', driver.id);
    }
    if (action === 'on_my_way') {
      // The time gate lives in the SAME predicate as status + ownership:
      // pickup within the window, evaluated by the database against the
      // captured server instant. NULL pickup_datetime never satisfies it.
      query = query.lte('pickup_datetime', departureCutoffIso);
    }
    if (action === 'ready') {
      // First confirmation wins; a second tap matches 0 rows and is
      // recognized below as a verified idempotent duplicate.
      query = query.is('driver_ready_at', null);
    }
    // Explicit allowlist (PR 3C-2C-B PR-1): migration 017 added internal
    // pricing columns (price_authority, active_slot, assignment_epoch,
    // canonical_place_id, multi_booking_exempt) that a bare select() would
    // leak into driver client responses. Selection = the driver-bookings
    // DRIVER_FIELDS contract plus host_commission, which only the Telegram
    // receipt reads and which is stripped from the client response below.
    const UPDATE_SELECT_FIELDS = 'id, trip_id, status, pickup_datetime, pickup_location, dropoff_location, vehicle_type, vehicle_name, passengers, bags, price, driver_payout, payment_status, flight_number, duration_minutes, customer_name, customer_phone, booker_name, booker_phone, pickup_sign, notes, accepted_at, driver_ready_at, driver_ready_source, details_version, host_commission';
    const { data, error } = await query.select(UPDATE_SELECT_FIELDS);

    if (error) {
      // Release reaccept guard (migration 016): the database refuses to
      // assign a booking to a driver who previously released it — on ANY
      // path, this endpoint included. Surface it as an honest conflict
      // WITH live truth (the 409 re-read discipline; a failed re-read is
      // a real 500, never a guessed conflict). Everything else stays a
      // real 500.
      if (error.code === 'P0001' && /released_by_this_driver/.test(error.message || '')) {
        const { data: current, error: rereadError } = await supabase
          .from('bookings')
          .select('status, details_version')
          .eq('id', bookingId)
          .maybeSingle();
        if (rereadError) {
          console.error('❌ reaccept-guard conflict re-read failed:', rereadError.message || rereadError);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
        }
        if (!current) {
          return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
        }
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: 'You released this ride — it\'s now with other drivers',
            code: 'released_by_you',
            currentStatus: current.status,
            currentDetailsVersion: current.details_version ?? null
          })
        };
      }
      console.error(`❌ ${action} failed:`, error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Update failed' }) };
    }

    if (!data || data.length === 0) {
      // Honest truth re-read: a genuine read failure is a real 500 (this
      // endpoint's established rule for a failed re-read), never a guessed
      // conflict the driver would silently reconcile. A MISSING row (no
      // error) keeps the ordinary conflict answer below.
      const { data: current, error: rereadError } = await supabase
        .from('bookings')
        .select('status, assigned_driver, driver_ready_at, driver_ready_by, details_version, pickup_datetime')
        .eq('id', bookingId)
        .maybeSingle();
      if (rereadError) {
        console.error(`❌ ${action}: zero-row re-read failed:`, rereadError.message || rereadError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
      }
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
      // ready: already confirmed ready BY THIS DRIVER on a ride this
      // driver still owns = verified duplicate. Anyone/anything else: 409.
      if (current && action === 'ready' &&
          current.status === 'confirmed' &&
          current.assigned_driver === driver.id &&
          current.driver_ready_at && current.driver_ready_by === driver.id) {
        console.log(`✅ Booking ${bookingId}: ready (idempotent duplicate)`);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, idempotent: true }) };
      }
      // Departure window classification — OWNER of a still-confirmed ride
      // only, and only AFTER the idempotency checks above. The predicate
      // matched zero rows: decide from the fresh re-read against the SAME
      // captured instant whether the window is closed (typed, with the
      // exact opening) or the pickup time cannot be verified (typed, fail
      // closed). An open window with zero rows is some other conflict and
      // falls through to the ordinary 409.
      if (current && action === 'on_my_way' &&
          current.status === 'confirmed' &&
          current.assigned_driver === driver.id) {
        const pickupMs = Date.parse(current.pickup_datetime);
        if (!Number.isFinite(pickupMs)) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: 'Booking has no valid pickup time — On my way unavailable',
              code: 'departure_window_unverifiable',
              currentStatus: current.status
            })
          };
        }
        const opensAtMs = pickupMs - DEPARTURE_WINDOW_MS;
        if (nowMs < opensAtMs) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: 'Too early — On my way opens 3 hours before pickup',
              code: 'departure_window_closed',
              opensAt: new Date(opensAtMs).toISOString(),
              currentStatus: current.status
            })
          };
        }
      }
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'Invalid transition',
          currentStatus: current?.status || 'unknown',
          currentDetailsVersion: current?.details_version || null
        })
      };
    }

    console.log(`✅ Booking ${bookingId}: ${action}`);

    // Telegram receipts to the admin: ride started, and a closing receipt
    // on completion. Informational only — all control stays in the web app.
    await sendReceipt(action, data[0]);

    // host_commission is deliberately excluded from driver payloads
    // (driver-bookings parity) — it feeds only the admin receipt above.
    const { host_commission, ...driverSafeBooking } = data[0];
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, booking: driverSafeBooking }) };
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