// Passenger cancellation endpoint (PR 3B: pending / confirmed /
// on_the_way / arrived — the CLOCK-based silent shadow policy).
//   POST /api/cancel-booking {id, action:'quote'}
//     -> server-computed eligibility quote. SILENT: fee arithmetic is
//        stripped from every passenger-facing payload (quote, 409s,
//        applied) unless CANCEL_FEE_DISPLAY is set — internally the full
//        0/50/100 is still computed and audited on every cancellation.
//   POST /api/cancel-booking {id, action:'cancel', expected:{...}}
//     -> guarded cancellation; `expected` is the quote the passenger
//        REVIEWED, compared on exactly the visible CAS fields (status,
//        pickupAt, policyVersion — fee fields only while displayed;
//        serverTime never). Any mismatch, or losing the status race,
//        answers 409 with a fresh visible quote. 409 is never success.
//
// Authorization, policy, and the guarded update live in lib/cancel-core
// (shared verbatim with the legacy /api/booking-status cancel action).
// The outbox trigger (013 admin + 015 driver) makes the ledger events
// atomic with the cancellation; after commit THIS endpoint gives each of
// this booking's cancellation events one bounded pass through the shared
// dispatcher — a notification failure can never turn a committed
// cancellation into an apparent failure; the watchdog recovers anything
// unfinished (<= ~5 min).
//
// Rollback lever: CANCEL_QUOTE_DISABLED=1 answers 503; the trip page
// falls back to the legacy path for PENDING rides and shows the support
// message for accepted ones (no doomed confirmation dialog).

const { createClient } = require('@supabase/supabase-js');
const core = require('./lib/cancel-core');
const dispatch = require('./lib/dispatch');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (process.env.CANCEL_QUOTE_DISABLED === '1' || process.env.CANCEL_QUOTE_DISABLED === 'true') {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'Cancellation service temporarily unavailable' })
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('❌ Missing Supabase configuration');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const db = createClient(supabaseUrl, serviceKey);

  try {
    const { id, action, expected } = JSON.parse(event.body || '{}');

    if (!id || !core.UUID_RE.test(id)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid booking id' }) };
    }
    if (action !== 'quote' && action !== 'cancel') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unsupported action' }) };
    }

    const read = await core.readBookingForCancel(db, id);
    if (!read.booking) {
      return { statusCode: read.status, headers, body: JSON.stringify({ error: read.error }) };
    }
    const booking = read.booking;

    const auth = await core.authorizeCancel(event, booking, { supabaseUrl, anonKey, db });
    if (!auth.actor) {
      return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
    }

    const nowMs = Date.now();
    const quote = core.computeQuote(booking, nowMs);

    if (action === 'quote') {
      return { statusCode: 200, headers, body: JSON.stringify({ quote: core.visibleQuote(quote) }) };
    }

    // ---- action === 'cancel' ----
    if (!quote.cancellable) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'not_cancellable',
          reason: quote.reason,
          currentStatus: booking.status,
          quote: core.visibleQuote(quote)
        })
      };
    }
    if (!core.expectedMatchesQuote(expected, quote)) {
      // Missing OR stale expectation: the passenger must review the
      // fresh terms before the ride can be cancelled.
      return {
        statusCode: expected ? 409 : 400,
        headers,
        body: JSON.stringify({
          error: expected ? 'stale_quote' : 'Missing expected quote',
          currentStatus: booking.status,
          quote: core.visibleQuote(quote)
        })
      };
    }

    const result = await core.performCancel(db, booking, quote, auth.actor, nowMs);
    if (result.dbError) {
      console.error('❌ Cancel failed:', result.dbError.message || result.dbError);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to cancel booking' }) };
    }
    if (result.conflict) {
      // Lost the race (driver accepted between quote and confirm, or a
      // concurrent cancel already landed). Fresh truth, fresh quote — and
      // a failed re-read keeps its real status (a DB outage is 500,
      // never disguised as a missing booking).
      const reread = await core.readBookingForCancel(db, id);
      if (!reread.booking) {
        return { statusCode: reread.status, headers, body: JSON.stringify({ error: reread.error }) };
      }
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'stale_quote',
          currentStatus: reread.booking.status,
          quote: core.visibleQuote(core.computeQuote(reread.booking, Date.now()))
        })
      };
    }

    console.log(`✅ Booking ${id}: cancelled from ${booking.status} (${auth.actor.cancelledBy})`);

    // ---- Immediate notification dispatch (bounded; NEVER fails the
    // committed cancellation). The outbox trigger created this booking's
    // cancellation events atomically with the UPDATE above; give each of
    // them — and ONLY them — one bounded pass through the shared
    // dispatcher. Anything unfinished (or any failure here) is left for
    // the watchdog to recover from stored truth (<= ~5 min).
    let immediateSubmission = 'deferred';
    try {
      const readCancellationEvents = () => db
        .from('notification_events')
        .select('*')
        .eq('booking_id', id)
        .in('event_type', ['ride_cancelled', 'ride_cancelled_admin']);

      const { data: pendingEvents, error: eventsError } = await readCancellationEvents()
        .in('state', ['pending']);
      if (!eventsError && pendingEvents) {
        const dispatchSummary = { attempts: 0, submitted: 0 };
        // Watchdog discipline (its per-event loop does the same): the
        // FIRST database failure — reported via dbFail or thrown — ends
        // the pass. Truth is broken; no further event may act on it.
        // The cancellation stays committed and reports 'deferred'; the
        // watchdog re-dispatches the remainder from stored truth.
        let dispatchDbErrors = 0;
        const dispatchFail = (site, err) => {
          dispatchDbErrors++;
          console.error(`❌ cancel dispatch @ ${site}:`, (err && err.message) || err);
        };
        for (const evRow of pendingEvents) {
          try {
            await dispatch.dispatchOne(db, evRow, Date.now(),
              { summary: dispatchSummary, dbFail: dispatchFail, maxAttempts: 4 });
          } catch (dispatchError) {
            dispatchDbErrors++;
            console.error('❌ cancel dispatch failed:', dispatchError.message);
          }
          if (dispatchDbErrors > 0) break;
        }
        // Honest submission state from STORED truth, not local counters.
        // 'suppressed' counts as handled (duplicate_target is a
        // deliberate terminal decision, not a miss). A broken pass never
        // claims submission — deferred is the honest answer even if the
        // failure hit only the final rollup.
        if (dispatchDbErrors === 0) {
          const { data: after, error: afterError } = await readCancellationEvents();
          if (!afterError && after && after.length > 0 &&
              after.every((e) => e.state === 'submitted' || e.state === 'suppressed')) {
            immediateSubmission = 'submitted';
          }
        }
      }
    } catch (notifyError) {
      console.error('❌ cancel notification pass failed:', notifyError.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        booking: result.row,
        // SILENCE extends to the final response: the applied fee summary
        // exists only while the display flag is on. Internally the full
        // policy was stamped into the audit either way.
        ...(core.feeDisplayEnabled() ? {
          applied: {
            feePercent: quote.feePercent,
            policyAmount: quote.policyAmount,
            waiverAmount: quote.waiverAmount,
            dueNow: 0,
            policyVersion: quote.policyVersion
          }
        } : {}),
        notificationQueued: true,
        immediateSubmission
      })
    };
  } catch (error) {
    console.error('❌ cancel-booking error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
