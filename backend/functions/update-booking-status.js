// Driver actions on a booking (header x-driver-secret required).
//   POST /api/update-booking-status {bookingId, action, paymentMethod?}
// Transitions are enforced server-side; a stale click (booking already moved
// on) matches 0 rows and returns 409 instead of clobbering state.

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRANSITIONS = {
  accept:    { from: ['pending'],               set: { status: 'confirmed' } },
  decline:   { from: ['pending'],               set: { status: 'declined' } },
  on_my_way: { from: ['confirmed'],             set: { status: 'on_the_way' } },
  arrived:   { from: ['on_the_way'],            set: { status: 'arrived' } },
  complete:  { from: ['arrived', 'on_the_way'], set: { status: 'completed' } }
};

// payment_collected doesn't touch status — allowed on any live/finished ride
const PAYMENT_ALLOWED_STATUSES = ['confirmed', 'on_the_way', 'arrived', 'completed'];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-driver-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const passcode = process.env.DRIVER_PASSCODE;
  const provided = event.headers['x-driver-secret'];
  if (!passcode || !provided || provided !== passcode) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Missing Supabase configuration');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { bookingId, action, paymentMethod } = JSON.parse(event.body || '{}');

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
      fromStatuses = TRANSITIONS[action].from;
      updates = { ...TRANSITIONS[action].set };
      if (action === 'complete') {
        updates.completed_at = new Date().toISOString();
      }
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    const { data, error } = await supabase
      .from('bookings')
      .update(updates)
      .eq('id', bookingId)
      .in('status', fromStatuses)
      .select();

    if (error) {
      console.error(`❌ ${action} failed:`, error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Update failed' }) };
    }

    if (!data || data.length === 0) {
      const { data: current } = await supabase
        .from('bookings')
        .select('status')
        .eq('id', bookingId)
        .single();
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
