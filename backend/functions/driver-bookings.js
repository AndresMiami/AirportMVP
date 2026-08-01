// Driver-facing booking list.
//   GET /api/driver-bookings  (header x-driver-secret required)
// Returns all actionable bookings: pending requests + active rides.
// Also serves as the passcode-verification endpoint for the driver page gate.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-driver-secret',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
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
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .in('status', ['pending', 'confirmed', 'on_the_way', 'arrived'])
      .order('pickup_datetime', { ascending: true });

    if (error) {
      console.error('❌ Driver bookings query failed:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load bookings' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ bookings: data || [] }) };
  } catch (error) {
    console.error('❌ driver-bookings error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
