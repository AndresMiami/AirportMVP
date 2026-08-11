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

// ---------- mock state ----------
const state = {};
function resetState() {
  state.bookingRow = {
    id: BOOKING_ID, trip_id: 'LM-HXA5', status: 'pending',
    customer_id: null, pickup_datetime: PICKUP, price: '55.00'
  };
  state.rereadRow = null;      // row served AFTER a conflict (defaults to bookingRow)
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
                const row = state.reads > 1 && state.rereadRow ? state.rereadRow : state.bookingRow;
                return { data: row, error: null };
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
      throw new Error('unexpected table: ' + table);
    }
  })
};

const supabasePath = require.resolve('@supabase/supabase-js');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true, exports: supabaseMock
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
  await check('guest pending quote (bare UUID): $0, cancellable, versioned', async () => {
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(res.statusCode, 200);
    const { quote } = JSON.parse(res.body);
    assert.strictEqual(quote.cancellable, true);
    assert.strictEqual(quote.feePercent, 0);
    assert.strictEqual(quote.policyAmount, 0);
    assert.strictEqual(quote.dueNow, 0);
    assert.strictEqual(quote.policyVersion, core.POLICY_VERSION);
    assert.strictEqual(quote.pickupAt, PICKUP);
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

  await check('confirmed ride -> not self-service in 1A (unsupported_status)', async () => {
    state.bookingRow.status = 'confirmed';
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'quote' });
    assert.strictEqual(res.statusCode, 200);
    const { quote } = JSON.parse(res.body);
    assert.strictEqual(quote.cancellable, false);
    assert.strictEqual(quote.reason, 'unsupported_status');
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
    assert.strictEqual(body.applied.dueNow, 0);
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

  await check('stale expected (wrong fee) -> 409 + fresh quote, nothing written', async () => {
    const exp = goodExpected();
    exp.feePercent = 50;
    const res = await post(cancelBooking, { id: BOOKING_ID, action: 'cancel', expected: exp });
    assert.strictEqual(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'stale_quote');
    assert.ok(body.quote && body.quote.cancellable === true);
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
    assert.strictEqual(notify.renderEvent('ride_cancelled', {}), null);
  });

  await check('CANCELLATION_TYPES exported and outside CHAIN_TYPES/DRIVER_ASKS', () => {
    assert.deepStrictEqual(notify.CANCELLATION_TYPES, ['ride_cancelled_admin']);
    for (const t of notify.CANCELLATION_TYPES) {
      assert.ok(!notify.CHAIN_TYPES.includes(t));
      assert.ok(!notify.DRIVER_ASKS.includes(t));
    }
  });

  await check('watchdog wiring: DISPATCH_FIELDS refetch + not_cancelled relevance gate', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'backend/functions/notification-watchdog.js'), 'utf8');
    assert.ok(src.includes("const DISPATCH_FIELDS = SWEEP_FIELDS + ', price, cancelled_at, cancelled_from_status"),
      'dispatch refetch must include the audit fields');
    assert.ok(src.includes('.select(DISPATCH_FIELDS).eq(\'id\', ev.booking_id)'),
      'dispatchOne must refetch with DISPATCH_FIELDS');
    assert.ok(src.includes("notify.CANCELLATION_TYPES.includes(ev.event_type) && b.status !== 'cancelled'"),
      'cancellation events must be suppressed unless the row is cancelled');
    assert.ok(src.match(/suppress\('not_cancelled'\)/), 'not_cancelled suppress reason present');
    // The sweep itself stays lean
    assert.ok(src.includes('.select(SWEEP_FIELDS)'), 'sweep must still use SWEEP_FIELDS');
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
