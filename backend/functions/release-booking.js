// Driver release endpoint (PR 3C-1).
//   POST /api/release-booking {bookingId, reason, note?}
//     -> returns a CONFIRMED ride this driver owns to the shared pending
//        pool via the release_booking() RPC — the ONLY supported release
//        path: guarded status flip + full commitment-state clear + the
//        booking_releases audit row + the admin outbox event, all in ONE
//        database transaction (migration 016). Busy drivers may release
//        (escaping a ride is the point); the reaccept guard trigger makes
//        sure a releaser never gets the booking back on any path.
//
// After the commit this endpoint gives THE release event one bounded pass
// through the shared dispatcher (cancel-booking discipline): a
// notification failure never reverses or falsely fails a committed
// release; the watchdog recovers anything unfinished (<= ~5 min).
//
// Success is never client-declared: {released:false} triggers an honest
// re-read (409 with live status / 404 / 500) — never a guessed conflict.

const { createClient } = require('@supabase/supabase-js');
const dispatch = require('./lib/dispatch');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['schedule_conflict', 'ride_details_changed', 'vehicle_issue', 'emergency', 'other'];
const NOTE_MAX = 500;

// CreditEngine requireDriver pattern (driver-bookings.js parity): verify
// the caller's JWT with the anon-key client, then require a matching
// drivers row. active OR busy — a busy driver must be able to release.
async function requireDriver(event, supabaseUrl, anonKey, db) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { status: 401, error: 'Not authenticated' };

  const authClient = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user) return { status: 401, error: 'Invalid session' };

  const { data: driver, error: driverError } = await db
    .from('drivers')
    .select('id, name, status')
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
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('❌ Missing Supabase configuration');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const db = createClient(supabaseUrl, serviceKey);

  const auth = await requireDriver(event, supabaseUrl, anonKey, db);
  if (!auth.driver) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }
  const driver = auth.driver;

  try {
    const { bookingId, reason, note: rawNote } = JSON.parse(event.body || '{}');

    if (!bookingId || !UUID_RE.test(bookingId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid bookingId' }) };
    }
    if (!REASONS.includes(reason)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid reason' }) };
    }
    // Note normalization BEFORE the RPC: trimmed, blank -> NULL, so the
    // database CHECKs can only ever fire for a bypassing caller.
    let note = typeof rawNote === 'string' ? rawNote.trim() : '';
    if (note.length > NOTE_MAX) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Note is too long (max ${NOTE_MAX} characters)` }) };
    }
    if (reason === 'other' && !note) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A short note is required for "Other"' }) };
    }

    const { data: rpcResult, error: rpcError } = await db.rpc('release_booking', {
      p_booking_id: bookingId,
      p_driver_id: driver.id,
      p_reason: reason,
      p_note: note || null
    });
    if (rpcError) {
      console.error('❌ release_booking RPC failed:', rpcError.message || rpcError);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to release ride' }) };
    }

    if (!rpcResult || rpcResult.released !== true) {
      // Lost the race (checkpoint, cancel, or a concurrent release landed
      // first). FAIL-CLOSED conflict lookup: report live truth honestly —
      // a re-read failure is a real 500, never a guessed 409.
      const { data: current, error: rereadError } = await db
        .from('bookings')
        .select('status')
        .eq('id', bookingId)
        .maybeSingle();
      if (rereadError) {
        console.error('❌ release conflict re-read failed:', rereadError.message || rereadError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
      }
      if (!current) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      }
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'Ride is no longer releasable', currentStatus: current.status })
      };
    }

    console.log(`✅ Booking ${bookingId}: released by driver ${driver.id} (${reason})`);

    // ---- Immediate notification dispatch (bounded; NEVER fails the
    // committed release). The outbox trigger created THE release event
    // atomically with the history insert; give exactly it one bounded
    // pass. Watchdog discipline: the FIRST database failure — reported
    // via dbFail or thrown — ends the pass; deferred stays honest.
    let immediateSubmission = 'deferred';
    try {
      const readReleaseEvent = () => db
        .from('notification_events')
        .select('*')
        .eq('booking_id', bookingId)
        .eq('event_type', 'ride_released')
        .eq('recipient_key', driver.id);

      const { data: pendingEvents, error: eventsError } = await readReleaseEvent()
        .in('state', ['pending']);
      if (!eventsError && pendingEvents && pendingEvents.length > 0) {
        const dispatchSummary = { attempts: 0, submitted: 0 };
        let dispatchDbErrors = 0;
        const dispatchFail = (site, err) => {
          dispatchDbErrors++;
          console.error(`❌ release dispatch @ ${site}:`, (err && err.message) || err);
        };
        try {
          await dispatch.dispatchOne(db, pendingEvents[0], Date.now(),
            { summary: dispatchSummary, dbFail: dispatchFail, maxAttempts: 4 });
        } catch (dispatchError) {
          dispatchDbErrors++;
          console.error('❌ release dispatch failed:', dispatchError.message);
        }
        if (dispatchDbErrors === 0) {
          // Honest submission state from STORED truth, not local counters.
          const { data: after, error: afterError } = await readReleaseEvent();
          if (!afterError && after && after.length > 0 &&
              after.every((e) => e.state === 'submitted' || e.state === 'suppressed')) {
            immediateSubmission = 'submitted';
          }
        }
      }
    } catch (notifyError) {
      console.error('❌ release notification pass failed:', notifyError.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        status: 'pending',
        notificationQueued: true,
        immediateSubmission
      })
    };
  } catch (error) {
    console.error('❌ release-booking error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
