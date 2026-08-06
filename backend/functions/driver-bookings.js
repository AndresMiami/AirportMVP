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
      .select('*')
      .or(visibility)
      .order('pickup_datetime', { ascending: true });

    if (error) {
      console.error('❌ Driver bookings query failed:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load bookings' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        bookings: data || [],
        driver: { id: auth.driver.id, name: auth.driver.name, status: auth.driver.status }
      })
    };
  } catch (error) {
    console.error('❌ driver-bookings error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
