// Passenger-facing booking status endpoint.
//   GET  /api/booking-status?id=<uuid>          -> whitelisted booking fields
//   POST /api/booking-status {id, action:'cancel'} -> cancel while still pending
//
// The Supabase UUID acts as the READ access token — it is unguessable and
// only given to the passenger who created the booking. CANCELLATION is
// tighter since PR 1A: an account-owned booking (customer_id set) requires
// its signed-in owner's Bearer JWT; only legacy guest bookings
// (customer_id NULL) keep bare-UUID cancellation. The authorization,
// audit stamps, and guarded update live in lib/cancel-core — shared
// verbatim with /api/cancel-booking so the two paths can never diverge.
// This endpoint keeps its legacy response shapes for old open tabs.

const { createClient } = require('@supabase/supabase-js');
const core = require('./lib/cancel-core');

const UUID_RE = core.UUID_RE;

// Whitelisted booking fields exclude private contact data, internal ids,
// and all cancellation audit fields (single source: lib/cancel-core).
// The assigned driver's PUBLIC contact (name + phone) is intentionally
// returned separately for the pairing message and WhatsApp button.
const PASSENGER_FIELDS = core.PASSENGER_FIELDS;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

      // Reassignment notice (PR 3C-1): a pending booking WITH release
      // history is waiting for a replacement driver — the trip page shows
      // the explicit notice and re-anchors its pending poll window to
      // reassigningSince (the latest release moment: a persistent
      // identity across reloads — a reload with the same value reuses
      // the stored anchor; only a NEW release grants a fresh window).
      // FAIL CLOSED: a lookup failure is a real 500, never a silently
      // wrong flag. Additive fields — older pages ignore them.
      let reassigning = false;
      let reassigningSince = null;
      if (data.status === 'pending') {
        const { data: releases, error: releasesError } = await supabase
          .from('booking_releases')
          .select('released_at')
          .eq('booking_id', id)
          .order('released_at', { ascending: false })
          .limit(1);
        if (releasesError) {
          console.error('❌ Release lookup failed:', releasesError);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
        }
        if (releases && releases.length > 0) {
          reassigning = true;
          reassigningSince = releases[0].released_at;
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          booking: data,
          driver: driverInfo,
          ...(reassigning ? { reassigning: true, reassigningSince } : {})
        })
      };
    }

    if (event.httpMethod === 'POST') {
      const { id, action } = JSON.parse(event.body || '{}');
      if (!id || !UUID_RE.test(id)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid booking id' }) };
      }
      if (action !== 'cancel') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unsupported action' }) };
      }

      const anonKey = process.env.SUPABASE_ANON_KEY;
      if (!anonKey) {
        console.error('❌ Missing SUPABASE_ANON_KEY — cannot verify cancel authorization');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
      }

      const read = await core.readBookingForCancel(supabase, id);
      if (!read.booking) {
        return { statusCode: read.status, headers, body: JSON.stringify({ error: read.error }) };
      }
      const booking = read.booking;

      // Account-owned bookings require their signed-in owner; legacy guest
      // bookings (customer_id NULL) keep the UUID capability.
      const auth = await core.authorizeCancel(event, booking, {
        supabaseUrl, anonKey, db: supabase
      });
      if (!auth.actor) {
        return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
      }

      // This legacy action stays PENDING-only (its historical contract).
      // Legacy 409 shape preserved for old open tabs: {error, status}.
      if (booking.status !== 'pending') {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ error: 'Cannot cancel', status: booking.status })
        };
      }

      const nowMs = Date.now();
      const quote = core.computeQuote(booking, nowMs);
      const result = await core.performCancel(supabase, booking, quote, auth.actor, nowMs);

      if (result.dbError) {
        console.error('❌ Cancel failed:', result.dbError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to cancel booking' }) };
      }
      if (result.conflict) {
        // Lost the race to a concurrent accept/cancel — report live truth,
        // and report it honestly: a booking present answers 409 with its
        // real status, a genuinely missing booking is 404, and a failed
        // re-read is a real 500 — never the old '409 unknown' guess, and
        // never success.
        const reread = await core.readBookingForCancel(supabase, id);
        if (!reread.booking) {
          return { statusCode: reread.status, headers, body: JSON.stringify({ error: reread.error }) };
        }
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: 'Cannot cancel',
            status: reread.booking.status
          })
        };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, booking: result.row }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error) {
    console.error('❌ booking-status error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
