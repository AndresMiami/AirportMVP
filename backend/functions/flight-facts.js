// Flight sensor — write side (decisions D1 + D2, plan step 3).
//   POST /api/flight-facts   (Authorization: Bearer <FLIGHT_SENSOR_TOKEN>)
//   body: one observation — see lib/flight-facts.js FIELDS and
//         docs/FLIGHT-FACTS-RUNBOOK.md for the contract.
//
// The sensor's ONLY way in. It records one flight observation and, when
// that observation is news, gets it to the driver in seconds:
//
//   1. authenticate the sensor token (lib/flight-facts.js)
//   2. validate strictly and DERIVE the band from the times — the sensor
//      decides when to write, never what the band is
//   3. re-read the booking and refuse anything that no longer describes
//      it as it stands (the sensor should refresh its watchlist)
//   4. INSERT into flight_observations — migration 021's AFTER INSERT
//      trigger writes the driver event in the SAME statement
//   5. after commit, give THAT event one bounded pass through the shared
//      dispatcher — release-booking.js / cancel-booking.js discipline: a
//      notification failure never fails the stored observation, and the
//      untouched 5-minute watchdog sends whatever this pass did not
//
// TELL ONLY (D3): this endpoint never writes to bookings.
//
// Responses never echo database or provider error text: failures are
// logged server-side and answered with a fixed sentence.

const { createClient } = require('@supabase/supabase-js');
const dispatch = require('./lib/dispatch');
const ff = require('./lib/flight-facts');

const MAX_BODY_BYTES = 4096;

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store'
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  const auth = ff.checkSensorAuth(event.headers, process.env);
  if (!auth.ok) return reply(auth.status, { error: auth.error });

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return reply(413, { error: 'Observation too large' });
  }
  let body;
  try { body = JSON.parse(raw); } catch (_) { return reply(400, { error: 'Body must be JSON' }); }

  const checked = ff.validateObservation(body, Date.now());
  if (!checked.ok) return reply(400, { error: checked.error });
  const obs = checked.value;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('❌ flight-facts: missing Supabase configuration');
    return reply(500, { error: 'Server configuration error' });
  }
  const db = createClient(supabaseUrl, serviceKey);

  // ---- The booking as it stands NOW ----
  const { data: booking, error: bookingError } = await db
    .from('bookings')
    .select('id, booking_mode, status, assigned_driver, flight_number, airport_code, pickup_datetime')
    .eq('id', obs.bookingId)
    .maybeSingle();
  if (bookingError) {
    console.error('❌ flight-facts: booking read failed:', bookingError.message || bookingError);
    return reply(500, { error: 'Could not read the booking' });
  }
  if (!booking) return reply(404, { error: 'booking_not_found' });

  const mismatch = ff.mismatchReason(obs, booking);
  if (mismatch) return reply(409, { error: mismatch, refreshWatchlist: true });

  // The trial allowlist is enforced HERE, not only in the watchlist: a row
  // stored for a driver outside the trial would still produce an event,
  // and the watchdog would deliver it within five minutes.
  const allowlist = ff.parseDriverAllowlist(process.env.FLIGHT_SENSOR_DRIVER_ALLOWLIST);
  if (!ff.driverAllowed(allowlist, booking.assigned_driver)) {
    return reply(409, { error: 'not_tracked', refreshWatchlist: true });
  }

  // ---- Store (the trigger writes the event in this same statement) ----
  const row = {
    booking_id: obs.bookingId,
    flight_number: obs.flightNumber,
    pickup_date: obs.pickupDate,
    airport_code: obs.airportCode,
    band: obs.band,
    delay_minutes: obs.delayMinutes,
    scheduled_arrival: obs.scheduledArrival,
    estimated_arrival: obs.estimatedArrival,
    actual_arrival: obs.actualArrival,
    observed_at: obs.observedAt,
    source: obs.source
  };
  const { data: stored, error: insertError } = await db
    .from('flight_observations')
    .insert(row)
    .select('id')
    .maybeSingle();
  if (insertError) {
    // The same reading again (a sensor retry) is the SAME observation:
    // idempotent success, and no second event can exist for it.
    if (insertError.code === '23505') {
      return reply(200, { ok: true, duplicate: true, band: obs.band, delayMinutes: obs.delayMinutes });
    }
    console.error('❌ flight-facts: insert failed:', insertError.message || insertError);
    return reply(500, { error: 'Could not store the observation' });
  }
  if (!stored) {
    console.error('❌ flight-facts: insert returned no row');
    return reply(500, { error: 'Could not store the observation' });
  }

  console.log(`✈️ flight-facts: booking ${obs.bookingId} ${obs.band} (${obs.source})`);

  // ---- Immediate notification pass (bounded; NEVER fails the stored
  // observation). Only a news band has an event; give exactly that event
  // for THIS driver one pass. The first database failure ends the pass;
  // the answer is read back from STORED truth, never from local counters.
  const eventType = ff.eventTypeForBand(obs.band);
  let notification = null;
  if (eventType) {
    // Unknown until stored truth says otherwise: whatever exists is the
    // watchdog's to deliver.
    notification = 'deferred';
    try {
      const readEvent = () => db
        .from('notification_events')
        .select('*')
        .eq('booking_id', obs.bookingId)
        .eq('event_type', eventType)
        .eq('recipient_key', booking.assigned_driver);

      const { data: pendingEvents, error: eventsError } = await readEvent().in('state', ['pending']);
      if (!eventsError && pendingEvents && pendingEvents.length > 0) {
        // THIS observation created news: one bounded pass, then read back.
        const dispatchSummary = { attempts: 0, submitted: 0 };
        const dispatchFail = (site, err) => {
          console.error(`❌ flight-facts dispatch @ ${site}:`, (err && err.message) || err);
        };
        try {
          await dispatch.dispatchOne(db, pendingEvents[0], Date.now(),
            { summary: dispatchSummary, dbFail: dispatchFail, maxAttempts: 4 });
        } catch (dispatchError) {
          console.error('❌ flight-facts dispatch failed:', dispatchError.message);
        }
        const { data: after, error: afterError } = await readEvent();
        if (!afterError && after && after.length > 0) {
          const s = after[0].state;
          notification = s === 'submitted' ? 'submitted'
            : s === 'suppressed' ? 'suppressed'
              : s === 'exhausted' ? 'failed'
                : 'deferred';
        }
      } else if (!eventsError) {
        // Nothing pending: either this band was already announced for this
        // driver (the ledger's one-per-band identity), or the trigger
        // created nothing because the ride changed between our check and
        // the insert. Say which — never claim a send this request made.
        const { data: existing, error: existingError } = await readEvent();
        if (!existingError) {
          notification = existing && existing.length > 0 ? 'already_notified' : 'not_created';
        }
      }
    } catch (notifyError) {
      console.error('❌ flight-facts notification pass failed:', notifyError.message);
    }
  }

  return reply(201, {
    ok: true,
    observationId: stored.id,
    band: obs.band,
    delayMinutes: obs.delayMinutes,
    // null              this band tells no one (on_time, landed)
    // submitted         sent by THIS request; a provider accepted it —
    //                   not proof the driver read it
    // deferred          stored; the watchdog will deliver it (<= ~5 min)
    // suppressed        the dispatcher judged it not news for this driver
    // failed            every channel attempt was used up
    // already_notified  this band was announced earlier; nothing new sent
    // not_created       the ride changed before the insert; nothing to send
    notification
  });
};
