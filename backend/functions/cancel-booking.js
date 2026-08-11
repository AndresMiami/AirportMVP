// Passenger cancellation endpoint (PR 1A: PENDING rides only).
//   POST /api/cancel-booking {id, action:'quote'}
//     -> server-computed cancellation quote (pending: $0/$0)
//   POST /api/cancel-booking {id, action:'cancel', expected:{...}}
//     -> guarded cancellation; `expected` is the quote the passenger
//        REVIEWED (status, feePercent, policyAmount, policyVersion,
//        pickupAt) and is only ever compared against a fresh server
//        computation — any mismatch, or losing the status race to a
//        driver Accept, answers 409 with a fresh quote. The client never
//        treats a 409 as success.
//
// Authorization, policy, and the guarded update live in lib/cancel-core
// (shared verbatim with the legacy /api/booking-status cancel action).
// The migration-013 outbox trigger makes the admin ledger event atomic
// with the cancellation; the watchdog delivers it (~5 min bound) — this
// endpoint sends nothing itself (PR 1A contract: immediateSubmission is
// always 'deferred').
//
// Rollback lever: CANCEL_QUOTE_DISABLED=1 answers 503 and the trip page
// falls back to the legacy cancel path (which enforces the same
// authorization) — a production revert without a redeploy.

const { createClient } = require('@supabase/supabase-js');
const core = require('./lib/cancel-core');

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
      return { statusCode: 200, headers, body: JSON.stringify({ quote }) };
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
          quote
        })
      };
    }
    if (!core.expectedMatchesQuote(expected, quote)) {
      // Missing OR stale expectation: the passenger must review the
      // fresh numbers before the ride can be cancelled.
      return {
        statusCode: expected ? 409 : 400,
        headers,
        body: JSON.stringify({
          error: expected ? 'stale_quote' : 'Missing expected quote',
          currentStatus: booking.status,
          quote
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
          quote: core.computeQuote(reread.booking, Date.now())
        })
      };
    }

    console.log(`✅ Booking ${id}: cancelled from ${booking.status} (${auth.actor.cancelledBy})`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        booking: result.row,
        applied: {
          feePercent: quote.feePercent,
          policyAmount: quote.policyAmount,
          waiverAmount: quote.waiverAmount,
          dueNow: 0,
          policyVersion: quote.policyVersion
        },
        // The 013 outbox trigger committed the ledger event with the
        // cancellation; the watchdog delivers it. Nothing here can prove
        // a human SAW anything — 'deferred' is the honest 1A state.
        notificationQueued: true,
        immediateSubmission: 'deferred'
      })
    };
  } catch (error) {
    console.error('❌ cancel-booking error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
