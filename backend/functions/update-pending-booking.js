// Authenticated, in-place editing for an account-owned pending ride.
// The booking identity never changes: id, trip_id, customer_id and created_at
// are deliberately absent from the update payload. A guarded status + version
// UPDATE arbitrates the passenger Edit-vs-driver Accept race.

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VEHICLE_TYPE = {
  Sedan: 'sedan', sedan: 'sedan', 'Tesla Model Y': 'sedan',
  SUV: 'suv', suv: 'suv', Escalade: 'suv', escalade: 'suv',
  'Black Escalade': 'suv', 'Cadillac Escalade': 'suv',
  Sprinter: 'sprinter', sprinter: 'sprinter', 'Mercedes Sprinter': 'sprinter'
};

const RESPONSE_FIELDS = 'id, trip_id, status, pickup_location, dropoff_location, pickup_datetime, vehicle_type, vehicle_name, passengers, bags, price, payment_status, customer_name, flight_number, duration_minutes, details_version';

function text(value, max, required = false) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if (required && !cleaned) return null;
  return cleaned ? cleaned.slice(0, max) : null;
}

function authUnavailable(error) {
  return error?.name === 'AuthRetryableFetchError' || !error?.status || error.status >= 500;
}

async function requirePassenger(event, supabaseUrl, anonKey, db) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { status: 401, error: 'Not authenticated' };

  try {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError) {
      if (authUnavailable(userError)) return { status: 500, error: 'Could not verify sign-in' };
      return { status: 401, error: 'Invalid session' };
    }
    if (!userData?.user) return { status: 401, error: 'Invalid session' };

    const { data: customer, error: customerError } = await db
      .from('customers')
      .select('id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (customerError) {
      console.error('pending-edit customer lookup failed:', customerError.code || 'db_error');
      return { status: 500, error: 'Could not verify account' };
    }
    if (!customer) return { status: 403, error: 'Account profile incomplete' };
    return { customerId: customer.id };
  } catch (error) {
    console.error('pending-edit auth failed:', error.code || error.name || 'auth_error');
    return { status: 500, error: 'Could not verify sign-in' };
  }
}

function parseEdit(body) {
  const bookingId = body.bookingId;
  const expectedVersion = Number(body.expectedDetailsVersion);
  const customerName = text(body.customerName, 120, true);
  const phone = text(body.phone, 40, true);
  const pickup = text(body.pickup, 500, true);
  const dropoff = text(body.dropoff, 500, true);
  const vehicleName = text(body.vehicle, 120, true);
  const price = Number(body.price);
  const pickupMs = Date.parse(body.dateTime);
  const passengers = Number.parseInt(body.passengers, 10);
  const bags = Number.parseInt(body.bags, 10);
  const duration = body.durationMinutes == null || body.durationMinutes === ''
    ? null : Number.parseInt(body.durationMinutes, 10);

  if (!UUID_RE.test(bookingId || '') || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { error: 'Invalid booking edit identity' };
  }
  if (!customerName || !phone || !pickup || !dropoff || !vehicleName ||
      !Number.isFinite(price) || price <= 0 || price > 100000 ||
      !Number.isFinite(pickupMs) ||
      !Number.isInteger(passengers) || passengers < 1 || passengers > 12 ||
      !Number.isInteger(bags) || bags < 0 || bags > 15 ||
      (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1440))) {
    return { error: 'Invalid ride details' };
  }

  const vehicleType = VEHICLE_TYPE[vehicleName];
  if (!vehicleType) return { error: 'Invalid vehicle' };

  return {
    bookingId,
    expectedVersion,
    // Required ride details: always full-replace (the form re-validates
    // them on every edit).
    values: {
      customer_name: customerName,
      customer_phone: phone,
      pickup_location: pickup,
      dropoff_location: dropoff,
      pickup_datetime: new Date(pickupMs).toISOString(),
      passengers,
      bags,
      vehicle_type: vehicleType,
      vehicle_name: vehicleName,
      price: Math.round(price * 100) / 100,
      payment_method: text(body.paymentMethod, 30) || 'cash',
      booking_mode: body.mode === 'pickup' ? 'pickup' : 'dropoff',
      duration_minutes: duration
    },
    // Optional personal details: null here means "not submitted/blank" —
    // the handler PRESERVES the stored value in that case (a restored
    // session or fresh device starts from an empty form and must never
    // silently erase data the passenger didn't retype).
    optional: {
      customer_email: text(body.email, 254),
      flight_number: text(body.flightNumber, 80),
      notes: text(body.notes, 2000),
      pickup_sign: text(body.pickupSign, 160),
      promo_code: text(body.promoCode, 80)
    },
    // Booker pair, resolved coherently against the stored row in the
    // handler (a phone may only ever be stored alongside a name).
    booker: {
      name: text(body.bookerName, 120),
      phone: text(body.bookerPhone, 40)
    }
  };
}

async function sendUpdatedDoorbell(booking) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const pickup = new Date(booking.pickup_datetime);
  const when = pickup.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York'
  });
  const message = `✏️ Ride ${booking.trip_id || booking.id.slice(0, 8)} updated\n${when}\n${booking.pickup_location} → ${booking.dropoff_location}\n🚘 ${booking.vehicle_name || booking.vehicle_type} · 👥 ${booking.passengers} · 🧳 ${booking.bags}\n💵 $${booking.price}\nOpen driver page: ${(process.env.URL || 'https://linkmia.com')}/driver`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: controller.signal
    });
    if (!res.ok) {
      // Sanitized: status code only — never the token, chat id, or body.
      console.warn('pending-edit Telegram rejected:', res.status);
    }
  } catch (error) {
    // The database is authoritative; an ops notification failure must not
    // turn a committed edit into a false passenger failure.
    console.warn('pending-edit Telegram unavailable:', error.code || error.name || 'send_error');
  } finally {
    clearTimeout(timeout);
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const db = createClient(supabaseUrl, serviceKey);
  const auth = await requirePassenger(event, supabaseUrl, anonKey, db);
  if (!auth.customerId) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const edit = parseEdit(body);
  if (edit.error) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: edit.error }) };
  }

  try {
    const { data: current, error: readError } = await db
      .from('bookings')
      .select('id, trip_id, status, assigned_driver, customer_id, details_version, price, host_commission, customer_email, booker_name, booker_phone, flight_number, notes, pickup_sign, promo_code')
      .eq('id', edit.bookingId)
      .maybeSingle();
    if (readError) {
      console.error('pending-edit booking lookup failed:', readError.code || 'db_error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not load booking' }) };
    }
    if (!current) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
    if (current.customer_id !== auth.customerId) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not your booking' }) };
    }
    if (current.status !== 'pending' || current.assigned_driver) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Ride is no longer editable', currentStatus: current.status })
      };
    }

    // Preserve the commission percentage agreed at creation instead of
    // silently applying a host's possibly-changed current rate.
    const oldPrice = Number(current.price);
    const oldHostCommission = Number(current.host_commission);
    const commissionRate = oldPrice > 0 && oldHostCommission > 0
      ? oldHostCommission / oldPrice : 0;

    // Optional-field preservation: a non-empty submitted value replaces;
    // a missing/blank one preserves the stored value. Explicitly CLEARING
    // an optional field is DEFERRED until the editor receives protected
    // server-side prefill data — until then a blank input cannot be
    // distinguished from an untouched one.
    const preserved = {};
    for (const [col, submitted] of Object.entries(edit.optional)) {
      preserved[col] = submitted !== null ? submitted : (current[col] ?? null);
    }

    // Booker pair coherence (create-booking parity): booker_phone may only
    // be stored alongside a meaningful booker_name. Submitting the
    // passenger's own name is an explicit "for myself" and clears the
    // pair; a blank name preserves the stored pair; an orphaned phone is
    // never written.
    let bookerName = null;
    let bookerPhone = null;
    if (edit.booker.name) {
      if (edit.booker.name !== edit.values.customer_name) {
        bookerName = edit.booker.name;
        bookerPhone = edit.booker.phone;
      }
    } else if (current.booker_name) {
      bookerName = current.booker_name;
      bookerPhone = current.booker_phone || null;
    }

    const updates = {
      ...edit.values,
      ...preserved,
      booker_name: bookerName,
      booker_phone: bookerPhone,
      host_commission: Math.round(edit.values.price * commissionRate * 100) / 100,
      details_version: edit.expectedVersion + 1,
      updated_at: new Date().toISOString()
    };

    const { data: updated, error: updateError } = await db
      .from('bookings')
      .update(updates)
      .eq('id', edit.bookingId)
      .eq('customer_id', auth.customerId)
      .eq('status', 'pending')
      .eq('details_version', edit.expectedVersion)
      .is('assigned_driver', null)
      .select(RESPONSE_FIELDS)
      .maybeSingle();

    if (updateError) {
      console.error('pending-edit update failed:', updateError.code || 'db_error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Changes were not saved' }) };
    }
    if (!updated) {
      // Lost the guarded race — report live truth HONESTLY (the same
      // discipline as cancellation): a present booking answers 409 with
      // its real status + version, a genuinely missing booking is 404,
      // and a failed re-read is a real 500 — never a guessed 409
      // 'unknown' that could disguise a database outage as a race.
      const { data: latest, error: rereadError } = await db
        .from('bookings')
        .select('status, details_version')
        .eq('id', edit.bookingId)
        .maybeSingle();
      if (rereadError) {
        console.error('pending-edit conflict re-read failed:', rereadError.code || 'db_error');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
      }
      if (!latest) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      }
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'Booking changed while you were editing',
          currentStatus: latest.status,
          currentDetailsVersion: latest.details_version
        })
      };
    }

    await sendUpdatedDoorbell(updated);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        bookingId: updated.id,
        tripId: updated.trip_id,
        detailsVersion: updated.details_version,
        booking: updated
      })
    };
  } catch (error) {
    console.error('pending-edit unexpected failure:', error.code || error.name || 'unexpected');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Changes were not saved' }) };
  }
};
