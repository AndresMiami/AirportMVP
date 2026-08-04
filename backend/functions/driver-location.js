// Live driver location updates (header x-driver-secret required).
//   POST /api/driver-location {bookingId, lat, lng}
// Coordinates are stored only while the ride is active, so a stale or
// stray ping can never attach location to a finished booking.

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ['on_the_way', 'arrived', 'in_progress'];

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
    const { bookingId, lat, lng } = JSON.parse(event.body || '{}');
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    if (!bookingId || !UUID_RE.test(bookingId) ||
        !isFinite(latNum) || !isFinite(lngNum) ||
        Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid payload' }) };
    }

    const { data, error } = await supabase
      .from('bookings')
      .update({
        driver_lat: latNum,
        driver_lng: lngNum,
        driver_location_at: new Date().toISOString()
      })
      .eq('id', bookingId)
      .in('status', ACTIVE_STATUSES)
      .select('id');

    if (error) {
      console.error('❌ Location update failed:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Update failed' }) };
    }

    // 0 rows = ride no longer active; tell the broadcaster to stop
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, active: (data || []).length > 0 })
    };
  } catch (error) {
    console.error('❌ driver-location error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
