// PR 1A — pending cancellation core: authorization matrix, server quote,
// expected-quote CAS, guarded update + shadow audit, legacy-endpoint
// parity, and the notification template.
//
// Run: node tests/pending-cancellation.test.js
//
// Pattern: mock @supabase/supabase-js via require.cache, run the real
// handlers, assert payloads/filters (tests/driver-identity.test.js
// precedent).

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.CANCEL_QUOTE_DISABLED;

const BOOKING_ID = '032f664e-20f6-4faa-bab5-3a5362a7cf06';
const PICKUP = '2026-08-11T01:30:00+00:00';
const HOURS = 60 * 60 * 1000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

// ---------- mock state ----------
const state = {};
function resetState() {
  state.bookingRow = {
    id: BOOKING_ID, trip_id: 'LM-HXA5', status: 'pending',
    customer_id: null, pickup_datetime: PICKUP, price: '55.00'
  };
  state.rereadRow = null;      // row served AFTER a conflict (defaults to bookingRow)
  state.rereadMissing = false; // second read finds no booking
  state.rereadError = null;    // second read fails at the database
  state.readError = null;
  state.customerRow = { id: 'cust-1' };
  state.customerError = null;
  state.getUser = async (token) => token === 'owner-token'
    ? { data: { user: { id: 'auth-user-1' } }, error: null }
    : { data: { user: null }, error: { status: 401 } };
  state.updateRows = null;     // null => echo a cancelled PASSENGER_FIELDS row
  state.updateError = null;
  state.captured = null;       // { payload, filters, selectFields }
  state.reads = 0;
  state.events = [];           // notification_events rows (outbox output)
  state.eventReadError = null;
  state.dispatchCalls = [];    // stubbed dispatcher invocations
  state.dispatchBehavior = null; // (ev) => mutate state per event
  delete process.env.CANCEL_FEE_DISPLAY;
}
resetState();

const supabaseMock = {
  createClient: () => ({
    auth: { getUser: (token) => state.getUser(token) },
    from: (table) => {
      if (table === 'customers') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.customerRow, error: state.customerError })
            })
          })
        };
      }
      if (table === 'bookings') {
        return {
          select: (fields) => ({
            eq: () => ({
              maybeSingle: async () => {
                state.reads++;
                if (state.readError) return { data: null, error: state.readError };
                if (state.reads > 1) {
                  if (state.rereadError) return { data: null, error: state.rereadError };
                  if (state.rereadMissing) return { data: null, error: null };
                  if (state.rereadRow) return { data: state.rereadRow, error: null };
                }
                return { data: state.bookingRow, error: null };
              },
              single: async () => {
                const row = state.rereadRow || state.bookingRow;
                return { data: row ? { status: row.status } : null, error: row ? null : { code: 'PGRST116' } };
              }
            })
          }),
          update: (payload) => {
            const captured = { payload, filters: [], selectFields: null };
            state.captured = captured;
            const chain = {
              eq: (col, val) => { captured.filters.push([col, val]); return chain; },
              select: async (fields) => {
                captured.selectFields = fields;
                if (state.updateError) return { data: null, error: state.updateError };
                if (state.updateRows) return { data: state.updateRows, error: null };
                return { data: [{ id: BOOKING_ID, trip_id: 'LM-HXA5', status: 'cancelled' }], error: null };
              }
            };
            return chain;
          }
        };
      }
      if (table === 'notification_events') {
        // Thenable filter chain for the endpoint's scoped readbacks.
        const q = { filters: {}, ins: [] };
        const chain = {
          select: () => chain,
          eq: (col, val) => { q.filters[col] = val; return chain; },
          in: (col, vals) => { q.ins.push([col, vals]); return chain; },
          then: (onOk, onErr) => {
            if (state.eventReadError) {
              return Promise.resolve({ data: null, error: state.eventReadError }).then(onOk, onErr);
            }
            let rows = state.events.filter((e) =>
              (!q.filters.booking_id || e.booking_id === q.filters.booking_id));
            for (const [col, vals] of q.ins) rows = rows.filter((e) => vals.includes(e[col]));
            return Promise.resolve({ data: rows, error: null }).then(onOk, onErr);
          }
        };
        return chain;
      }
      throw new Error('unexpected table: ' + table);
    }
  })
};

const supabasePath = require.resolve('@supabase/supabase-js');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, exports: supabaseMock
};

// Stub the shared dispatcher: its OWN behavior is proven in
// tests/dispatch-module.test.js — here we only verify the endpoint's
// scoping, honesty, and never-fail-the-cancel discipline around it.
const dispatchPath = require.resolve('../backend/functions/lib/dispatch.js');
require.cache[dispatchPath] = {
  id: dispatchPath, filename: dispatchPath, loaded: true,
  exports: {
    dispatchOne: async (db, ev, nowMs, opts) => {
      state.dispatchCalls.push({ ev, opts });
      if (state.dispatchBehavior) await state.dispatchBehavior(ev, opts);
    }
  }
};

const core = require('../backend/functions/lib/cancel-core.js');
const cancelBooking = require('../backend/functions/cancel-booking.js');
const bookingStatus = require('../backend/functions/booking-status.js');
const notify = require('../backend/functions/lib/notify.js');

function post(handler, body, token) {
  return handler.handler({
    httpMethod: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body)
  });
}

function goodExpected() {
  return {
    status: 'pending', feePercent: 0, policyAmount: 0,
    policyVersion: core.POLICY_VERSION, pickupAt: PICKUP
  };
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  resetState();
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}

(async () => {
  // ---------- field whitelists ----------
  await check('PASSENGER_FIELDS exposes no cancellation audit fields', () => {
    assert.ok(!/cancel/i.test(core.PASSENGER_FIELDS), 'audit fields must never leak into the public payload');
  });

  // ---------- quote ----------
  await check('guest pending quote (bare UUID): cancellable, versioned, SILENT (no fee fields)', async () => {
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(res.statusCode, 200);
    const { quote } = JSON.parse(res.body);
    assert.strictEqual(quote.cancellable, true);
    assert.strictEqual(quote.policyVersion, core.POLICY_VERSION);
    assert.strictEqual(quote.pickupAt, PICKUP);
    for (const hidden of ['feePercent', 'policyAmount', 'waiverAmount', 'dueNow']) {
      assert.ok(!(hidden in quote), hidden + ' must be silent by default');
    }
  });

  await check('clock brackets (internal computeQuote): time decides, status never does', () => {
    const q = (status, pickupInMs, extra = {}) => core.computeQuote({
      id: BOOKING_ID, status, customer_id: 'cust-1',
      pickup_datetime: iso(pickupInMs), price: '55.00', ...extra
    }, Date.now());
    assert.strictEqual(q('confirmed', 3 * HOURS).feePercent, 0);
    assert.strictEqual(q('confirmed', 3 * HOURS).reason, 'accepted_free_window');
    assert.strictEqual(q('confirmed', 2 * HOURS).feePercent, 50, 'exactly 2h is inside the window');
    assert.strictEqual(q('confirmed', 30 * 60 * 1000).feePercent, 50);
    assert.strictEqual(q('confirmed', -5 * 60 * 1000).feePercent, 100, 'past pickup -> 100');
    assert.strictEqual(q('on_the_way', 90 * 60 * 1000).feePercent, 50, 'on_the_way inside 2h is 50 — checkpoints never set the percent');
    assert.strictEqual(q('on_the_way', 3 * HOURS).feePercent, 0, 'on_the_way far out is FREE by the clock');
    assert.strictEqual(q('arrived', -10 * 60 * 1000).feePercent, 100);
    assert.strictEqual(q('arrived', 3 * HOURS).feePercent, 0, 'arrived far out is FREE by the clock');
    assert.strictEqual(q('confirmed', 90 * 60 * 1000).policyAmount, 27.5);
    assert.strictEqual(q('confirmed', -1).policyAmount, 55);
    // Invalid price never fabricates $0; a real $0 fare stays $0.
    assert.strictEqual(q('confirmed', 30 * 60 * 1000, { price: 'garbage' }).policyAmount, null);
    assert.strictEqual(q('confirmed', 30 * 60 * 1000, { price: 0 }).policyAmount, 0);
    // Eligibility gates
    assert.strictEqual(q('in_progress', -1).cancellable, false);
    assert.strictEqual(q('in_progress', -1).reason, 'in_progress');
    assert.strictEqual(q('assigned', 3 * HOURS).reason, 'requires_support');
    const guest = core.computeQuote({ id: BOOKING_ID, status: 'confirmed', customer_id: null,
      pickup_datetime: iso(3 * HOURS), price: '55.00' }, Date.now());
    assert.strictEqual(guest.cancellable, false);
    assert.strictEqual(guest.reason, 'requires_support');
  });

  await check('visibleQuote strips fees by default; CANCEL_FEE_DISPLAY restores them', () => {
    const full = core.computeQuote({ id: BOOKING_ID, status: 'confirmed', customer_id: 'cust-1',
      pickup_datetime: iso(30 * 60 * 1000), price: '55.00' }, Date.now());
    const silent = core.visibleQuote(full);
    for (const hidden of ['feePercent', 'policyAmount', 'waiverAmount', 'dueNow']) {
      assert.ok(!(hidden in silent));
    }
    assert.ok('serverTime' in silent, 'serverTime stays visible (informational, never compared)');
    process.env.CANCEL_FEE_DISPLAY = '1';
    const shown = core.visibleQuote(full);
    assert.strictEqual(shown.feePercent, 50);
    assert.strictEqual(shown.policyAmount, 27.5);
    delete process.env.CANCEL_FEE_DISPLAY;
  });

  await check('account-owned pending quote WITHOUT token -> 401 (leaked UUID is not enough)', async () => {
    state.bookingRow.customer_id = 'cust-1';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(res.statusCode, 401);
  });

  await check('account-owned pending quote with OWNER token -> 200', async () => {
    state.bookingRow.customer_id = 'cust-1';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' }, 'owner-token');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).quote.cancellable, true);
  });

  await check('authenticated NON-owner -> 403', async () => {
    state.bookingRow.customer_id = 'cust-OTHER';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' }, 'owner-token');
    assert.strictEqual(res.statusCode, 403);
  });

  await check('auth outage (retryable getUser error) -> 500, never 401', async () => {
    state.bookingRow.customer_id = 'cust-1';
    state.getUser = async () => ({ data: { user: null }, error: { name: 'AuthRetryableFetchError' } });
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' }, 'owner-token');
    assert.strictEqual(res.statusCode, 500);
  });

  await check('legacy-guest CONFIRMED ride -> requires_support (a bare UUID never cancels a committed driver)', async () => {
    state.bookingRow.status = 'confirmed';
    state.bookingRow.customer_id = null;
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(res.statusCode, 200);
    const { quote } = JSON.parse(res.body);
    assert.strictEqual(quote.cancellable, false);
    assert.strictEqual(quote.reason, 'requires_support');
  });

  await check('owner-authenticated CONFIRMED ride -> cancellable, silent', async () => {
    state.bookingRow.status = 'confirmed';
    state.bookingRow.customer_id = 'cust-1';
    state.bookingRow.pickup_datetime = iso(3 * HOURS);
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' }, 'owner-token');
    assert.strictEqual(res.statusCode, 200);
    const { quote } = JSON.parse(res.body);
    assert.strictEqual(quote.cancellable, true);
    assert.ok(!('feePercent' in quote), 'silent for accepted rides too');
  });

  await check('terminal ride -> reason terminal', async () => {
    state.bookingRow.status = 'cancelled';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(JSON.parse(res.body).quote.reason, 'terminal');
  });

  // ---------- cancel ----------
  await check('guest cancel happy path: audit stamped atomically, guarded on pending', async () => {
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: goodExpected() });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, true);
    assert.ok(!('applied' in body), 'silence extends to the final response by default');
    assert.strictEqual(body.notificationQueued, true);
    assert.strictEqual(body.immediateSubmission, 'deferred');
    const { payload, filters, selectFields } = state.captured;
    assert.strictEqual(payload.status, 'cancelled');
    assert.strictEqual(payload.cancelled_from_status, 'pending');
    assert.strictEqual(payload.cancelled_by, 'uuid_link');
    assert.strictEqual(payload.cancel_actor_user_id, null);
    assert.strictEqual(payload.cancel_pickup_at, PICKUP);
    assert.strictEqual(payload.cancel_policy_version, core.POLICY_VERSION);
    assert.strictEqual(payload.cancel_fee_percent, 0);
    assert.strictEqual(payload.cancel_fee_policy_amount, 0);
    assert.strictEqual(payload.cancel_fee_collected, 0);
    assert.strictEqual(payload.cancel_waiver_reason, null);
    assert.strictEqual(payload.cancel_waived_by, null);
    assert.strictEqual(payload.driver_lat, null);
    assert.strictEqual(payload.driver_lng, null);
    assert.strictEqual(payload.driver_location_at, null);
    assert.deepStrictEqual(filters, [['id', BOOKING_ID], ['status', 'pending']]);
    assert.strictEqual(selectFields, core.PASSENGER_FIELDS);
  });

  await check('account cancel by owner: passenger_auth + actor UUID recorded', async () => {
    state.bookingRow.customer_id = 'cust-1';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: goodExpected() }, 'owner-token');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.captured.payload.cancelled_by, 'passenger_auth');
    assert.strictEqual(state.captured.payload.cancel_actor_user_id, 'auth-user-1');
  });

  await check('cancel WITHOUT expected -> 400, nothing written', async () => {
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(state.captured, null);
  });

  await check('stale expected (policyVersion drift) -> 409 + fresh SILENT quote, nothing written', async () => {
    const exp = goodExpected();
    exp.policyVersion = 'pilot-1999-01';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp });
    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'stale_quote');
    assert.ok(body.quote && body.quote.cancellable === true);
    assert.ok(!('feePercent' in body.quote), '409 payloads are silent too');
    assert.strictEqual(state.captured, null);
  });

  await check('CAS: fee extras from older tabs are ignored while silent; serverTime never compared', async () => {
    const exp = goodExpected(); // carries feePercent/policyAmount extras
    exp.feePercent = 50;        // wrong on purpose — must be IGNORED (not exposed)
    exp.serverTime = '1999-01-01T00:00:00Z';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp });
    assert.strictEqual(res.statusCode, 200, 'extras and serverTime must not block the cancel');
  });

  await check('CAS with CANCEL_FEE_DISPLAY on: fee terms become load-bearing again', async () => {
    process.env.CANCEL_FEE_DISPLAY = '1';
    const exp = goodExpected();
    exp.feePercent = 50; // pending is 0 — displayed drift must 409
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp });
    delete process.env.CANCEL_FEE_DISPLAY;
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(state.captured, null);
  });

  await check('every CAS term is load-bearing: pickupAt, policyVersion, status drift each -> 409', async () => {
    for (const mutate of [
      (e) => { e.pickupAt = '2026-08-12T01:30:00+00:00'; },
      (e) => { e.policyVersion = 'pilot-1999-01'; },
      (e) => { e.status = 'confirmed'; }
    ]) {
      resetState();
      const exp = goodExpected();
      mutate(exp);
      const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp });
      assert.strictEqual(res.statusCode, 409, JSON.stringify(exp));
      assert.strictEqual(JSON.parse(res.body).error, 'stale_quote');
      assert.strictEqual(state.captured, null, 'nothing may be written on drift');
    }
  });

  await check('equivalent-instant pickupAt in another ISO format is ACCEPTED (Date.parse CAS)', async () => {
    const exp = goodExpected();
    exp.pickupAt = '2026-08-11T01:30:00.000Z'; // same instant as +00:00 form
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp });
    assert.strictEqual(res.statusCode, 200);
  });

  await check('booking read failure -> 500 Lookup failed (never 404)', async () => {
    state.readError = { message: 'db down' };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, 'Lookup failed');
  });

  await check('customers lookup failure -> 500, never misreported as 403 non-owner', async () => {
    state.bookingRow.customer_id = 'cust-1';
    state.customerError = { message: 'db down' };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' }, 'owner-token');
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, 'Could not verify account');
  });

  await check('guarded update failure -> 500, never a bogus 409 fresh quote', async () => {
    state.updateError = { message: 'db down' };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: goodExpected() });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, 'Failed to cancel booking');
  });

  await check('driver accepts between quote and confirm -> 409 with live status', async () => {
    state.updateRows = []; // guarded update loses the race
    state.rereadRow = { ...state.bookingRow, status: 'confirmed' };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: goodExpected() });
    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.currentStatus, 'confirmed');
    assert.strictEqual(body.quote.cancellable, false);
  });

  await check('cancel on a non-pending ride -> 409 not_cancellable', async () => {
    state.bookingRow.status = 'confirmed';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: goodExpected() });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(JSON.parse(res.body).error, 'not_cancellable');
    assert.strictEqual(state.captured, null);
  });

  await check('invalid id -> 400; unknown action -> 400; missing booking -> 404', async () => {
    let res = await post(cancelBooking, { id: 'nope', action: 'quote' });
    assert.strictEqual(res.statusCode, 400);
    res = await post(cancelBooking, { id: BOOKING_ID, action: 'destroy' });
    assert.strictEqual(res.statusCode, 400);
    state.bookingRow = null;
    res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(res.statusCode, 404);
  });

  await check('kill switch CANCEL_QUOTE_DISABLED -> 503', async () => {
    process.env.CANCEL_QUOTE_DISABLED = '1';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    delete process.env.CANCEL_QUOTE_DISABLED;
    assert.strictEqual(res.statusCode, 503);
  });

  // ---------- legacy endpoint parity ----------
  await check('legacy cancel: guest pending -> 200 legacy shape, same audit stamps', async () => {
    const res = await post(bookingStatus, { id: BOOKING_ID, action: 'cancel' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).success, true);
    assert.strictEqual(state.captured.payload.cancelled_by, 'uuid_link');
    assert.strictEqual(state.captured.payload.cancel_policy_version, core.POLICY_VERSION);
    assert.deepStrictEqual(state.captured.filters, [['id', BOOKING_ID], ['status', 'pending']]);
  });

  await check('legacy cancel: account-owned WITHOUT token -> 401 (tightened)', async () => {
    state.bookingRow.customer_id = 'cust-1';
    const res = await post(bookingStatus, { id: BOOKING_ID, action: 'cancel' });
    assert.strictEqual(res.statusCode, 401);
  });

  await check('legacy cancel: account-owned with owner token -> 200', async () => {
    state.bookingRow.customer_id = 'cust-1';
    const res = await post(bookingStatus, { id: BOOKING_ID, action: 'cancel' }, 'owner-token');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.captured.payload.cancelled_by, 'passenger_auth');
  });

  await check('legacy cancel: non-pending keeps the historical 409 shape', async () => {
    state.bookingRow.status = 'on_the_way';
    const res = await post(bookingStatus, { id: BOOKING_ID, action: 'cancel' });
    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Cannot cancel');
    assert.strictEqual(body.status, 'on_the_way');
  });

  await check('legacy cancel lost race: conflict re-read answers the historical shape with live status', async () => {
    state.updateRows = []; // guarded update matched 0 rows
    state.rereadRow = { ...state.bookingRow, status: 'confirmed' };
    const res = await post(bookingStatus, { id: BOOKING_ID, action: 'cancel' });
    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Cannot cancel');
    assert.strictEqual(body.status, 'confirmed');
  });

  await check('legacy cancel lost race: booking vanished on re-read -> 404, never 409 unknown', async () => {
    state.updateRows = [];
    state.rereadMissing = true;
    const res = await post(bookingStatus, { id: BOOKING_ID, action: 'cancel' });
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Booking not found');
    assert.ok(!res.body.includes('unknown'));
  });

  await check('legacy cancel lost race: re-read DB failure -> honest 500, never success or unknown', async () => {
    state.updateRows = [];
    state.rereadError = { message: 'db down' };
    const res = await post(bookingStatus, { id: BOOKING_ID, action: 'cancel' });
    assert.strictEqual(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Lookup failed');
    assert.ok(!body.success);
  });

  await check('both endpoints allow the Authorization header (CORS)', async () => {
    for (const handler of [cancelBooking, bookingStatus]) {
      const res = await handler.handler({ httpMethod: 'OPTIONS', headers: {} });
      assert.ok(res.headers['Access-Control-Allow-Headers'].includes('Authorization'));
    }
  });

  // ---------- notification template + pipeline wiring ----------
  await check('renderEvent: pending withdrawal variant', () => {
    const text = notify.renderEvent('ride_cancelled_admin', {
      trip_id: 'LM-HXA5', pickup_location: 'A', dropoff_location: 'B',
      pickup_datetime: PICKUP, cancelled_from_status: 'pending'
    });
    assert.ok(text.includes('withdrawn'));
    assert.ok(text.includes('LM-HXA5'));
    assert.ok(!text.includes('Policy:'));
  });

  await check('renderEvent: cancelled ride renders the stamped shadow-fee line', () => {
    const text = notify.renderEvent('ride_cancelled_admin', {
      trip_id: 'LM-HXA5', pickup_location: 'A', dropoff_location: 'B',
      pickup_datetime: PICKUP, cancelled_from_status: 'confirmed',
      cancel_fee_percent: '50.00', cancel_fee_policy_amount: '27.50',
      cancel_fee_collected: '0.00'
    });
    assert.ok(text.includes('CANCELLED'));
    assert.ok(text.includes('(was confirmed)'));
    assert.ok(text.includes('Policy: 50% = $27.50'));
    assert.ok(text.includes('$0.00 collected'));
  });

  await check('renderEvent: missing audit fields -> no invented fee line; unknown type -> null', () => {
    const text = notify.renderEvent('ride_cancelled_admin', {
      trip_id: 'LM-HXA5', pickup_location: 'A', dropoff_location: 'B',
      pickup_datetime: PICKUP, cancelled_from_status: 'confirmed'
    });
    assert.ok(!text.includes('Policy:'));
    assert.strictEqual(notify.renderEvent('never_a_real_event', {}), null);
  });

  await check('driver stop-notice: honest copy on both channels, no rideId deep link, readiness tag reuse', () => {
    const b = { id: BOOKING_ID, trip_id: 'LM-HXA5', pickup_datetime: PICKUP };
    const text = notify.renderEvent('ride_cancelled', b);
    assert.ok(text.includes('cancelled by the passenger'));
    assert.ok(text.includes('Do not proceed'));
    assert.ok(text.includes('No action is required'));
    const payload = notify.pushPayloadFor('ride_cancelled', b);
    assert.ok(payload.body.includes('Do not proceed'));
    assert.ok(!('rideId' in payload), 'no deep link to a ride that no longer renders — click opens /driver');
    assert.strictEqual(payload.tag, notify.readinessTopic(b), 'replaces any queued stale readiness banner');
    assert.ok(!/\+1|@|phone|address/i.test(payload.body), 'no PII in push payloads');
  });

  await check('CANCELLATION_TYPES exported and outside CHAIN_TYPES/DRIVER_ASKS', () => {
    assert.deepStrictEqual(notify.CANCELLATION_TYPES, ['ride_cancelled', 'ride_cancelled_admin']);
    for (const t of notify.CANCELLATION_TYPES) {
      assert.ok(!notify.CHAIN_TYPES.includes(t));
      assert.ok(!notify.DRIVER_ASKS.includes(t));
    }
  });

  // ---- PR 3B: accepted-ride cancel with scoped immediate dispatch ----
  await check('owner cancels confirmed ride: audit waiver stamped, dispatch scoped to THIS booking, honest submitted', async () => {
    state.bookingRow = {
      id: BOOKING_ID, trip_id: 'LM-HXA5', status: 'confirmed',
      customer_id: 'cust-1', pickup_datetime: iso(30 * 60 * 1000), price: '55.00'
    };
    // The outbox trigger's rows (plus an unrelated booking's event that
    // must NOT be dispatched by this request).
    state.events = [
      { id: 'ev-a', booking_id: BOOKING_ID, event_type: 'ride_cancelled_admin', state: 'pending' },
      { id: 'ev-d', booking_id: BOOKING_ID, event_type: 'ride_cancelled', state: 'pending' },
      { id: 'ev-x', booking_id: 'ffffffff-0000-4000-8000-000000000000', event_type: 'ride_cancelled_admin', state: 'pending' }
    ];
    state.dispatchBehavior = (ev) => { ev.state = 'submitted'; };
    const exp = { status: 'confirmed', policyVersion: core.POLICY_VERSION, pickupAt: state.bookingRow.pickup_datetime };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp }, 'owner-token');
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.immediateSubmission, 'submitted', 'stored truth says both events landed');
    assert.ok(!('applied' in body));
    assert.strictEqual(state.dispatchCalls.length, 2, 'ONLY this booking\'s two events are dispatched');
    assert.ok(state.dispatchCalls.every((c) => c.ev.booking_id === BOOKING_ID));
    assert.ok(state.dispatchCalls.every((c) => Number.isInteger(c.opts.maxAttempts) && c.opts.maxAttempts >= 1));
    const p = state.captured.payload;
    assert.strictEqual(p.cancelled_from_status, 'confirmed');
    assert.strictEqual(p.cancelled_by, 'passenger_auth');
    assert.strictEqual(p.cancel_fee_percent, 50);
    assert.strictEqual(p.cancel_fee_policy_amount, 27.5);
    assert.strictEqual(p.cancel_fee_collected, 0);
    assert.strictEqual(p.cancel_waiver_reason, 'pilot_waiver');
    assert.strictEqual(p.cancel_waived_by, 'system');
    assert.strictEqual(p.driver_lat, null);
    assert.ok(!('assigned_driver' in p), 'assigned driver is preserved for audit and routing');
  });

  await check('dispatch failure NEVER fails the committed cancel: 200 with deferred', async () => {
    state.bookingRow = {
      id: BOOKING_ID, trip_id: 'LM-HXA5', status: 'on_the_way',
      customer_id: 'cust-1', pickup_datetime: iso(-5 * 60 * 1000), price: '55.00'
    };
    state.events = [
      { id: 'ev-a', booking_id: BOOKING_ID, event_type: 'ride_cancelled_admin', state: 'pending' },
      { id: 'ev-d', booking_id: BOOKING_ID, event_type: 'ride_cancelled', state: 'pending' }
    ];
    state.dispatchBehavior = () => { throw new Error('provider exploded'); };
    const exp = { status: 'on_the_way', policyVersion: core.POLICY_VERSION, pickupAt: state.bookingRow.pickup_datetime };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp }, 'owner-token');
    assert.strictEqual(res.statusCode, 200, 'a committed cancellation never reports failure');
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.immediateSubmission, 'deferred', 'the watchdog recovers the pending events');
    assert.strictEqual(state.dispatchCalls.length, 1, 'a throw breaks the pass — the second event is the watchdog\'s');
    assert.strictEqual(state.captured.payload.cancel_fee_percent, 100, 'past pickup -> 100 regardless of status');
  });

  await check('first dispatch DB failure stops the immediate pass: second event untouched, still 200 deferred', async () => {
    state.bookingRow = {
      id: BOOKING_ID, trip_id: 'LM-HXA5', status: 'confirmed',
      customer_id: 'cust-1', pickup_datetime: iso(30 * 60 * 1000), price: '55.00'
    };
    state.events = [
      { id: 'ev-a', booking_id: BOOKING_ID, event_type: 'ride_cancelled_admin', state: 'pending' },
      { id: 'ev-d', booking_id: BOOKING_ID, event_type: 'ride_cancelled', state: 'pending' }
    ];
    // The dispatcher surfaces a broken database via dbFail (watchdog
    // contract) — the endpoint must break exactly like the watchdog loop.
    state.dispatchBehavior = (ev, opts) => { opts.dbFail('dispatch refetch', new Error('db down')); };
    const exp = { status: 'confirmed', policyVersion: core.POLICY_VERSION, pickupAt: state.bookingRow.pickup_datetime };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp }, 'owner-token');
    assert.strictEqual(res.statusCode, 200, 'a committed cancellation never reports failure');
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.immediateSubmission, 'deferred');
    assert.strictEqual(state.dispatchCalls.length, 1, 'no second dispatch on broken truth');
  });

  await check('invalid stored price on an accepted cancel: NULL amount recorded, cancel proceeds', async () => {
    state.bookingRow = {
      id: BOOKING_ID, trip_id: 'LM-HXA5', status: 'confirmed',
      customer_id: 'cust-1', pickup_datetime: iso(30 * 60 * 1000), price: 'not-a-number'
    };
    const exp = { status: 'confirmed', policyVersion: core.POLICY_VERSION, pickupAt: state.bookingRow.pickup_datetime };
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp }, 'owner-token');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.captured.payload.cancel_fee_percent, 50);
    assert.strictEqual(state.captured.payload.cancel_fee_policy_amount, null, 'never a fabricated $0');
    assert.strictEqual(state.captured.payload.cancel_waiver_reason, 'pilot_waiver');
  });

  await check('dispatcher wiring: DISPATCH_FIELDS refetch + not_cancelled relevance gate', () => {
    // Location check only — the BEHAVIOR is proven in
    // tests/notification-ledger.test.js (cancelled row dispatches /
    // non-cancelled row suppresses, through the real loop) and
    // tests/dispatch-module.test.js (direct module semantics). Since PR 3A
    // the per-event execution lives in the shared lib/dispatch.js.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'backend/functions/lib/dispatch.js'), 'utf8');
    assert.ok(src.includes("', price, cancelled_at, cancelled_from_status, '"),
      'dispatch refetch must include the audit fields');
    assert.ok(src.includes('.select(DISPATCH_FIELDS).eq(\'id\', ev.booking_id)'),
      'dispatchOne must refetch with DISPATCH_FIELDS');
    assert.ok(src.includes("notify.CANCELLATION_TYPES.includes(ev.event_type) && b.status !== 'cancelled'"),
      'cancellation events must be suppressed unless the row is cancelled');
    assert.ok(src.match(/suppress\('not_cancelled'\)/), 'not_cancelled suppress reason present');
    // The watchdog keeps its lean sweep and delegates per-event execution
    const wd = fs.readFileSync(path.join(__dirname, '..', 'backend/functions/notification-watchdog.js'), 'utf8');
    assert.ok(wd.includes('.select(SWEEP_FIELDS)'), 'sweep must still use SWEEP_FIELDS');
    assert.ok(wd.includes('dispatch.dispatchOne(db, ev, nowMs'), 'watchdog must delegate to the shared dispatcher');
  });

  await check('migration 013: trigger, ON CONFLICT idempotency, pilot CHECKs, smoke test', () => {
    const fs = require('fs');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'database/migrations/013_cancellation_policy.sql'), 'utf8');
    assert.ok(sql.includes('CREATE TRIGGER trg_bookings_cancellation_outbox'));
    assert.ok(sql.includes('ON CONFLICT ON CONSTRAINT notification_events_identity DO NOTHING'));
    assert.ok(sql.includes('SECURITY DEFINER'));
    assert.ok(sql.includes('CHECK (cancel_fee_collected = 0)'));
    assert.ok(sql.includes("CHECK (cancel_fee_percent IN (0, 50, 100))"));
    assert.ok(sql.includes("'ride_cancelled_admin'"));
    assert.ok(sql.includes('MIGRATION-013-SMOKE'));
    assert.ok(sql.includes('ON DELETE SET NULL'));
  });

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} FAILURE(S): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`ALL ${passed} CHECKS PASS`);
})();
