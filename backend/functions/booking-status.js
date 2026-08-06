// Passenger-facing booking status endpoint.
// The Supabase UUID acts as the access token — it is unguessable and only
// given to the passenger who created the booking.
//   GET  /api/booking-status?id=<uuid>          -> whitelisted booking fields
//   POST /api/booking-status {id, action:'cancel'} -> cancel while still pending

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never expose phone numbers or internal fields to the public status page
const PASSENGER_FIELDS = 'id, trip_id, status, pickup_location, dropoff_location, pickup_datetime, vehicle_type, vehicle_name, passengers, bags, price, payment_status, customer_name, flight_number, duration_minutes, driver_lat, driver_lng, driver_location_at';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Missing Supabase configuration');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error' })
    };
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    if (event.httpMethod === 'GET') {
      const id = event.queryStringParameters?.id;
      if (!id || !UUID_RE.test(id)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid booking id' }) };
      }

      const { data, error } = await supabase
        .from('bookings')
        .select(PASSENGER_FIELDS + ', assigned_driver')
        .eq('id', id)
        .single();

      if (error || !data) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      }

      // Personalization: resolve the assigned driver's public identity
      // (name + phone only — never internal fields). Absent or failed
      // lookup -> no driver key; the page falls back to its defaults.
      let driverInfo;
      if (data.assigned_driver) {
        const { data: drv } = await supabase
          .from('drivers')
          .select('name, phone')
          .eq('id', data.assigned_driver)
          .single();
        if (drv && drv.name) driverInfo = { name: drv.name, phone: drv.phone || '' };
      }
      delete data.assigned_driver; // internal id — not for the public payload

      return { statusCode: 200, headers, body: JSON.stringify({ booking: data, driver: driverInfo }) };
    }

    if (event.httpMethod === 'POST') {
      const { id, action } = JSON.parse(event.body || '{}');
      if (!id || !UUID_RE.test(id)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid booking id' }) };
      }
      if (action !== 'cancel') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unsupported action' }) };
      }

      // Only a still-pending booking can be cancelled by the passenger.
      // The status filter makes this race-safe against a concurrent accept.
      const { data, error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .eq('status', 'pending')
        .select(PASSENGER_FIELDS);

      if (error) {
        console.error('❌ Cancel failed:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to cancel booking' }) };
      }

      if (!data || data.length === 0) {
        const { data: current } = await supabase
          .from('bookings')
          .select('status')
          .eq('id', id)
          .single();
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: 'Cannot cancel',
            status: current?.status || 'unknown'
          })
        };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, booking: data[0] }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error) {
    console.error('❌ booking-status error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
