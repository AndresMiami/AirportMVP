// Flight sensor — read side (decision D1, plan step 3).
//   GET /api/flight-watchlist   (Authorization: Bearer <FLIGHT_SENSOR_TOKEN>)
//
// The ONLY thing the external flight sensor may read: the arrivals worth
// tracking right now, and the minimum it needs to find each flight. No
// passenger name, phone, address, notes, price, or driver identity ever
// leaves here — the sensor needs a flight, not a person.
//
// A ride is listed when ALL hold:
//   * booking_mode 'pickup' (picking someone UP at the airport: an
//     arrival; decision D10 — departures later, if ever)
//   * confirmed / on_the_way / arrived, with a driver committed
//     (an alert needs someone to receive it)
//   * that driver is in FLIGHT_SENSOR_DRIVER_ALLOWLIST ("*" = everyone;
//     unset = nobody — the trial is opened deliberately)
//   * a flight number that is a real ident (legacy invoice-style
//     references are skipped, never guessed at)
//   * pickup within the window below
//
// pickupDate is the booking's MIAMI date, returned for the sensor to echo
// back with each observation: it is how /api/flight-facts knows the
// sensor is still describing the ride as it stands.

const { createClient } = require('@supabase/supabase-js');
const ff = require('./lib/flight-facts');

const PAST_HOURS = 6;     // a ride already under way can still be delayed
const AHEAD_HOURS = 72;   // the sensor starts relaxed and accelerates
const MAX_ROWS = 200;

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store'
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed' });

  const auth = ff.checkSensorAuth(event.headers, process.env);
  if (!auth.ok) return reply(auth.status, { error: auth.error });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('❌ flight-watchlist: missing Supabase configuration');
    return reply(500, { error: 'Server configuration error' });
  }
  const db = createClient(supabaseUrl, serviceKey);
  const allowlist = ff.parseDriverAllowlist(process.env.FLIGHT_SENSOR_DRIVER_ALLOWLIST);

  const nowMs = Date.now();
  const { data, error } = await db
    .from('bookings')
    .select('id, flight_number, airport_code, booking_mode, status, pickup_datetime, assigned_driver')
    .eq('booking_mode', 'pickup')
    .in('status', ff.TRACKED_RIDE_STATUSES)
    .not('assigned_driver', 'is', null)
    .not('flight_number', 'is', null)
    .gte('pickup_datetime', new Date(nowMs - PAST_HOURS * 3600e3).toISOString())
    .lte('pickup_datetime', new Date(nowMs + AHEAD_HOURS * 3600e3).toISOString())
    .order('pickup_datetime', { ascending: true })
    .limit(MAX_ROWS);
  if (error) {
    console.error('❌ flight-watchlist: bookings read failed:', error.message || error);
    return reply(500, { error: 'Could not read the watchlist' });
  }

  const flights = [];
  for (const b of data || []) {
    if (!ff.driverAllowed(allowlist, b.assigned_driver)) continue;
    const flightNumber = ff.normalizeFlightNumber(b.flight_number);
    if (!ff.isFlightIdent(flightNumber)) continue;
    if (typeof b.airport_code !== 'string' || !/^[A-Z]{3}$/.test(b.airport_code)) continue;
    flights.push({
      bookingId: b.id,
      flightNumber,
      pickupDate: ff.miamiDay(b.pickup_datetime),
      airportCode: b.airport_code,
      pickupAt: new Date(b.pickup_datetime).toISOString(),
      rideStatus: b.status
    });
  }

  return reply(200, {
    generatedAt: new Date(nowMs).toISOString(),
    window: { pastHours: PAST_HOURS, aheadHours: AHEAD_HOURS },
    flights
  });
};
