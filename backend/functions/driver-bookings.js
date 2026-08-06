// Driver-facing booking list.
//   GET /api/driver-bookings  (Authorization: Bearer <supabase session JWT>)
// Returns all actionable bookings: pending requests + active rides, plus
// the authenticated driver's identity for the page header.
// Also serves as the login-verification endpoint for the driver page gate.
//
// Auth = CreditEngine requireDriver pattern: verify the caller's JWT with
// the anon-key client, then require a matching ACTIVE drivers row
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
  if (driver.status !== 'active') return { status: 403, error: 'Driver account inactive' };

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
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .in('status', ['pending', 'confirmed', 'on_the_way', 'arrived', 'in_progress'])
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
        driver: { id: auth.driver.id, name: auth.driver.name }
      })
    };
  } catch (error) {
    console.error('❌ driver-bookings error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
