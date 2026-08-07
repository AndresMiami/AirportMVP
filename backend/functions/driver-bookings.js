// Driver-facing booking list.
//   GET /api/driver-bookings  (Authorization: Bearer <supabase session JWT>)
// Visibility by driver status:
//   active -> shared UNASSIGNED pending requests + this driver's own active
//             rides ("My rides" never contains another driver's work)
//   busy   -> own active rides ONLY (finish current work, no new offers)
//   inactive/other -> rejected by requireDriver
// Also serves as the login-verification endpoint for the driver page gate.
//
// Auth = CreditEngine requireDriver pattern: verify the caller's JWT with
// the anon-key client, then require a matching drivers row
// (drivers.user_id -> auth.users). Drivers are admin-provisioned only.

const { createClient } = require('@supabase/supabase-js');

// What a driver may ever see. Never `*`: no ambassador/commission internals
// (referred_by_host, host_commission, linkmia_commission), no customer
// email, no internal ids the client doesn't need (assigned_driver is a
// query filter, never a response field).
const DRIVER_FIELDS = 'id, trip_id, status, pickup_datetime, pickup_location, dropoff_location, vehicle_type, vehicle_name, passengers, bags, price, driver_payout, payment_status, flight_number, duration_minutes, customer_name, customer_phone, booker_name, booker_phone, pickup_sign, notes, accepted_at, driver_ready_at, driver_ready_source';

// Additionally hidden on UNACCEPTED (pending) offers — revealed at accept.
const PENDING_PRIVATE_FIELDS = ['customer_name', 'customer_phone', 'booker_name', 'booker_phone', 'pickup_sign', 'notes', 'payment_status', 'flight_number'];

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
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

  try {
    const ownActive = `and(status.in.(confirmed,on_the_way,arrived,in_progress),assigned_driver.eq.${auth.driver.id})`;
    const visibility = auth.driver.status === 'active'
      ? `and(status.eq.pending,assigned_driver.is.null),${ownActive}`
      : ownActive;

    const { data, error } = await supabase
      .from('bookings')
      .select(DRIVER_FIELDS)
      .or(visibility)
      .order('pickup_datetime', { ascending: true });

    if (error) {
      console.error('❌ Driver bookings query failed:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load bookings' }) };
    }

    // Pre-accept privacy: a shared pending request is an OFFER, not a
    // relationship — passenger identity, contact, notes, payment state,
    // and flight are revealed only to the driver who accepts. Strip them
    // from pending rows before they leave the server; assigned_driver is
    // never in the whitelist, deleted here as belt-and-braces.
    const bookings = (data || []).map((b) => {
      const row = { ...b };
      delete row.assigned_driver;
      if (row.status !== 'pending') return row;
      for (const f of PENDING_PRIVATE_FIELDS) delete row[f];
      return row;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        bookings,
        driver: { id: auth.driver.id, name: auth.driver.name, status: auth.driver.status }
      })
    };
  } catch (error) {
    console.error('❌ driver-bookings error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
