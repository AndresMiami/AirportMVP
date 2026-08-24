// Account-gate + writer-swap test harness — create-booking (PR 3C-2C-B PR-1).
//
// Run (after `npm install` per LOCAL_DEVELOPMENT.md):
//   node tests/booking-auth.test.js
// Exits 0 with "ALL n CHECKS PASS" on success, nonzero otherwise.
//
// Pattern (same as tests/driver-identity.test.js): mock
// @supabase/supabase-js via require.cache and run the REAL create-booking
// handler. The mock SIMULATES migration 017's accept_quote_create contract
// (the endpoint no longer inserts directly — the RPC is the only writer);
// the REAL RPC is exercised by the PGlite behavioral harness before merge.
// TELEGRAM_BOT_TOKEN is deleted so the doorbell is silent.
//
// Contract under test: new bookings are AUTHENTICATED-ONLY.
//   401  missing token, or an auth error that is a real credential
//        rejection (invalid/expired)
//   500  retryable/network/service auth failures (returned OR thrown),
//        customer lookup / host lookup / ensure-row creation failures,
//        RPC errors (sanitized — raw SQL/constraint text never leaks)
//   403  authenticated user with no customers row and no active host
//   200  identity resolved -> RPC 'created'/'idempotent', customer_id
//        ALWAYS stamped (p_customer_id), doorbell only on 'created'.

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.TELEGRAM_BOT_TOKEN; // silence the doorbell
delete process.env.ADMIN_TELEGRAM_CHAT_ID;
// PR-1 dark contract: the no-token path never touches signing config.
delete process.env.QUOTE_SIGNING_CURRENT_ID;
delete process.env.QUOTE_SIGNING_CURRENT_SECRET;
delete process.env.QUOTE_SIGNING_PREVIOUS_ID;
delete process.env.QUOTE_SIGNING_PREVIOUS_SECRET;

// ---------- fixtures & capture state ----------
const TOKENS = {
  'tok-pat': { id: 'auth-p', email: 'pat@example.com' },
  'tok-new': { id: 'auth-n', email: 'new@example.com' },
  'tok-amb': { id: 'auth-a', email: 'amb@example.com' }
};
const CUSTOMERS_BY_USER = {
  'auth-p': { id: 'cust-pat' }
};
const HOSTS_BY_USER = {
  'auth-a': {
    id: 'host-amb', name: 'Andrea Ambassador',
    phone: '+1 786 555 0300', email: 'andrea@casamiami.com',
    commission_rate: 0.06
  }
};
const HOSTS_BY_CODE = {
  gold: { id: 'host-gold', name: 'Goldie', commission_rate: 0.05 }
};
const OP_ID = '9f8e7d6c-5b4a-4321-8abc-def012345678';
const NEW_BOOKING_ID = 'aaaa1111-2222-4333-8444-555566667777';

let capturedCustomerInsert = null;
let capturedRpc = null;
let storedRow = null;            // what the post-RPC re-read returns
let customerLookupError = null;  // inject
let customerInsertError = null;  // inject
let hostLookupError = null;      // inject
let activeBooking = null;        // inject (bare-legacy pre-check)
let activeBookingLookupError = null; // inject
let getUserErrorResult = null;   // inject: RETURNED auth error object
let getUserThrows = false;       // inject: THROWN auth failure
let rpcError = null;             // inject
let rpcForcedResult = null;      // inject
let receiptRow = null;           // inject: operation_receipts row
let acceptanceRow = null;        // inject: quote_acceptances row

function resetCaptures() {
  capturedCustomerInsert = null;
  capturedRpc = null;
  storedRow = null;
  customerLookupError = null;
  customerInsertError = null;
  hostLookupError = null;
  activeBooking = null;
  activeBookingLookupError = null;
  getUserErrorResult = null;
  getUserThrows = false;
  rpcError = null;
  rpcForcedResult = null;
  receiptRow = null;
  acceptanceRow = null;
}

// Simulate accept_quote_create's no_token off-mode contract: store the
// row, force status pending, derive nothing the endpoint sent wrong.
function simulateCreateRpc(a) {
  storedRow = {
    id: NEW_BOOKING_ID,
    status: 'pending',
    price: a.p_client_price,
    details_version: 1,
    ...a.p_booking
  };
  return { outcome: 'created', booking_id: NEW_BOOKING_ID, authority: 'client_legacy' };
}

const dbClient = {
  rpc: async (name, args) => {
    assert.strictEqual(name, 'accept_quote_create');
    capturedRpc = args;
    if (rpcError) return { data: null, error: rpcError };
    if (rpcForcedResult) return { data: rpcForcedResult, error: null };
    return { data: simulateCreateRpc(args), error: null };
  },
  from: (table) => {
    if (table === 'customers') {
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => customerLookupError
              ? { data: null, error: customerLookupError }
              : { data: CUSTOMERS_BY_USER[val] || null, error: null }
          })
        }),
        insert: (rows) => {
          capturedCustomerInsert = rows[0];
          return {
            select: () => ({
              single: async () => customerInsertError
                ? { data: null, error: customerInsertError }
                : { data: { id: 'cust-new' }, error: null }
            })
          };
        }
      };
    }
    if (table === 'hosts') {
      return {
        select: () => ({
          eq: (col, val) => ({
            eq: () => ({
              maybeSingle: async () => {
                if (col === 'user_id' && hostLookupError) {
                  return { data: null, error: hostLookupError };
                }
                return {
                  data: (col === 'user_id' ? HOSTS_BY_USER[val] : HOSTS_BY_CODE[val]) || null,
                  error: null
                };
              }
            })
          })
        })
      };
    }
    if (table === 'operation_receipts') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: receiptRow, error: null }) })
        })
      };
    }
    if (table === 'quote_acceptances') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: acceptanceRow, error: null }) })
        })
      };
    }
    if (table === 'bookings') {
      const chain = (filters) => ({
        eq(col, val) { filters[col] = val; return chain(filters); },
        in() { return chain(filters); },
        order() { return chain(filters); },
        limit() { return chain(filters); },
        async maybeSingle() {
          // Re-read by id -> the stored row; pre-check -> injected active.
          if (filters.id) {
            if (storedRow && filters.id === storedRow.id) return { data: storedRow, error: null };
            return { data: null, error: null };
          }
          return activeBookingLookupError
            ? { data: null, error: activeBookingLookupError }
            : { data: activeBooking, error: null };
        }
      });
      return {
        select: () => chain({}),
        insert: () => { throw new Error('direct bookings INSERT is forbidden — the RPC is the only writer'); }
      };
    }
    throw new Error('unexpected table: ' + table);
  }
};

const supabaseMock = {
  createClient: (url, key) => key === 'anon-key'
    ? {
        auth: {
          getUser: async (token) => {
            if (getUserThrows) throw new Error('auth service unreachable');
            if (getUserErrorResult) return { data: { user: null }, error: getUserErrorResult };
            return TOKENS[token]
              ? { data: { user: TOKENS[token] }, error: null }
              : { data: { user: null }, error: { status: 401, message: 'bad token' } };
          }
        }
      }
    : dbClient
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const fn = require(path.join(repoRoot, 'backend/functions/create-booking.js'));

function mkPayload(overrides) {
  return {
    customerName: 'Pat Passenger',
    phone: '+1 305 555 0100',
    pickup: 'Brickell City Centre',
    dropoff: 'MIA Terminal D',
    dateTime: new Date(Date.now() + 24 * 3600e3).toISOString(),
    vehicle: 'Tesla Model Y',
    price: 132,
    mode: 'dropoff',
    passengers: 2,
    tripId: 'LM-TEST',
    ...overrides
  };
}
// What the REAL ambassador browser flow sends: the passenger modal clears
// the account holder's info — the payload carries only the TRAVELER.
function mkAmbassadorPayload() {
  return mkPayload({
    customerName: 'Maria Traveler',
    phone: '+1 954 555 0400',
    email: 'maria@example.com',
    bookerName: null,
    bookerPhone: null
  });
}
const post = (payload, token) => fn.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(payload)
});

let passed = 0;
function check(name, f) { f(); passed++; console.log('✓ ' + name); }

(async () => {
  resetCaptures();
  let r = await post(mkPayload(), null);
  check('no token -> 401, nothing written', () => {
    assert.strictEqual(r.statusCode, 401);
    assert.strictEqual(capturedRpc, null);
  });

  r = await post(mkPayload(), 'tok-unknown');
  check('invalid/expired token -> 401, nothing written', () => {
    assert.strictEqual(r.statusCode, 401);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures(); getUserErrorResult = { status: 401, message: 'expired' };
  r = await post(mkPayload(), 'tok-pat');
  check('RETURNED credential rejection (status 401) -> 401', () =>
    assert.strictEqual(r.statusCode, 401));

  resetCaptures(); getUserErrorResult = { name: 'AuthRetryableFetchError', message: 'down' };
  r = await post(mkPayload(), 'tok-pat');
  check('RETURNED retryable/network auth error -> 500, not 401', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures(); getUserErrorResult = { status: 503, message: 'unavailable' };
  r = await post(mkPayload(), 'tok-pat');
  check('RETURNED 5xx auth service error -> 500, not 401', () =>
    assert.strictEqual(r.statusCode, 500));

  resetCaptures(); getUserThrows = true;
  r = await post(mkPayload(), 'tok-pat');
  check('THROWN auth failure -> 500', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures();
  r = await post(mkPayload(), 'tok-pat');
  check('existing customers row: RPC called with customer_id stamped', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedRpc.p_customer_id, 'cust-pat');
    assert.strictEqual(capturedRpc.p_auth_user_id, 'auth-p');
    assert.strictEqual(capturedRpc.p_verdict, 'no_token');
    assert.strictEqual(capturedRpc.p_client_price, 132);
  });

  check('guest columns still written for an authenticated booking', () => {
    assert.strictEqual(capturedRpc.p_booking.customer_name, 'Pat Passenger');
    assert.strictEqual(capturedRpc.p_booking.customer_phone, '+1 305 555 0100');
    assert.strictEqual(capturedRpc.p_booking.booking_mode, 'dropoff');
    assert.strictEqual(capturedRpc.p_booking.trip_id, 'LM-TEST');
  });

  check('response carries the STORED trip id — no fabricated B<epoch> fallback', () => {
    const body = JSON.parse(r.body);
    assert.strictEqual(body.bookingId, NEW_BOOKING_ID);
    assert.strictEqual(body.tripId, 'LM-TEST');
    assert.strictEqual(body.success, true);
  });

  resetCaptures(); activeBooking = { id: 'bk-live', trip_id: 'LM-LIVE', status: 'confirmed' };
  r = await post(mkPayload(), 'tok-pat');
  check('existing nonterminal booking -> 409 with trusted id (bare legacy pre-check)', () => {
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.existingBookingId, 'bk-live');
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures(); activeBookingLookupError = { code: 'XX000' };
  r = await post(mkPayload(), 'tok-pat');
  check('active-booking lookup failure -> 500 fail closed, no write', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures(); activeBooking = { id: 'bk-live', trip_id: 'LM-LIVE', status: 'confirmed' };
  r = await post(mkPayload({ operationId: OP_ID }), 'tok-pat');
  check('operationId request BYPASSES the pre-check — the RPC arbitrates retries', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.ok(capturedRpc, 'RPC must be reached');
    assert.strictEqual(capturedRpc.p_operation_request_id, OP_ID);
    assert.ok(/^[0-9a-f]{64}$/.test(capturedRpc.p_request_digest));
  });

  resetCaptures(); rpcForcedResult = { outcome: 'idempotent', booking_id: NEW_BOOKING_ID };
  storedRow = { id: NEW_BOOKING_ID, trip_id: 'LM-TEST', status: 'pending', pickup_datetime: new Date(Date.now() + 24 * 3600e3).toISOString(), price: 132 };
  r = await post(mkPayload({ operationId: OP_ID }), 'tok-pat');
  check('lost response + exact retry -> idempotent 200, doorbell suppressed', () => {
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.idempotent, true);
    assert.strictEqual(body.telegramSent, false);
  });

  resetCaptures(); rpcForcedResult = { outcome: 'active_exists', booking_id: 'bk-live' };
  storedRow = { id: 'bk-live', trip_id: 'LM-LIVE', status: 'pending' };
  r = await post(mkPayload({ operationId: OP_ID }), 'tok-pat');
  check('RPC active_exists -> legacy 409 reopen shape', () => {
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.error, 'Active booking already exists');
    assert.strictEqual(body.existingBookingId, 'bk-live');
    assert.strictEqual(body.tripId, 'LM-LIVE');
  });

  resetCaptures(); rpcForcedResult = { outcome: 'active_exists', booking_id: null };
  r = await post(mkPayload({ operationId: OP_ID }), 'tok-pat');
  check('active_exists with NULL booking id -> generic conflict, no disclosure', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).error, 'Could not process this request');
  });

  for (const [outcome, status, errText] of [
    ['outdated_client', 428, 'outdated_client'],
    ['quote_required', 428, 'quote_required'],
    ['quote_invalid', 409, 'quote_invalid'],
    ['quote_expired', 409, 'quote_expired'],
    ['quote_not_yet_valid', 409, 'quote_expired'],
    ['conflict', 409, null],
    ['refused', 409, null],
    ['blocked', 503, null]
  ]) {
    resetCaptures(); rpcForcedResult = { outcome };
    r = await post(mkPayload({ operationId: OP_ID }), 'tok-pat');
    check(`outcome ${outcome} -> ${status}`, () => {
      assert.strictEqual(r.statusCode, status);
      if (errText) assert.strictEqual(JSON.parse(r.body).error, errText);
    });
  }

  resetCaptures(); rpcForcedResult = { outcome: 'brand_new_thing' };
  r = await post(mkPayload({ operationId: OP_ID }), 'tok-pat');
  check('unknown RPC outcome fails closed as sanitized 500', () =>
    assert.strictEqual(r.statusCode, 500));

  resetCaptures(); rpcError = { code: '23505', message: 'duplicate key value violates unique constraint "bookings_one_active_per_customer"' };
  r = await post(mkPayload({ operationId: OP_ID }), 'tok-pat');
  check('RPC error (incl. 23505) -> sanitized 500, raw constraint text never leaks', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.ok(!r.body.includes('constraint'));
    assert.ok(!r.body.includes('23505'));
  });

  resetCaptures();
  r = await post(mkPayload(), 'tok-new');
  check('no customers row + no host -> 403, no writes (payload data never becomes identity)', () => {
    assert.strictEqual(r.statusCode, 403);
    assert.ok(/profile incomplete/i.test(JSON.parse(r.body).error));
    assert.strictEqual(capturedCustomerInsert, null);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures();
  r = await post(mkAmbassadorPayload(), 'tok-amb');
  check('ambassador recovery stays multi-ride: host bypasses passenger guard and uses host identity', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedCustomerInsert.name, 'Andrea Ambassador');
    assert.strictEqual(capturedCustomerInsert.phone, '+1 786 555 0300');
    assert.strictEqual(capturedCustomerInsert.email, 'andrea@casamiami.com');
    assert.strictEqual(capturedRpc.p_customer_id, 'cust-new');
    assert.strictEqual(capturedRpc.p_booking.customer_name, 'Maria Traveler');
  });

  check('ambassador booking self-attributes (commission derived by the RPC, not the endpoint)', () => {
    assert.strictEqual(capturedRpc.p_booking.referred_by_host, 'host-amb');
    assert.ok(!('host_commission' in capturedRpc.p_booking));
  });

  resetCaptures(); HOSTS_BY_USER['auth-a'].email = null;
  r = await post(mkAmbassadorPayload(), 'tok-amb');
  check('host without email: falls back to the AUTH email, never the traveler email', () => {
    assert.strictEqual(capturedCustomerInsert.email, 'amb@example.com');
  });
  HOSTS_BY_USER['auth-a'].email = 'andrea@casamiami.com';

  resetCaptures(); customerLookupError = { message: 'db down' };
  r = await post(mkPayload(), 'tok-pat');
  check('customer lookup failure -> 500, no write', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures(); hostLookupError = { message: 'db down' };
  r = await post(mkPayload(), 'tok-new');
  check('host lookup failure during recovery -> 500 (cannot decide 403 vs recovery)', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures(); hostLookupError = { message: 'db down' };
  r = await post(mkPayload(), 'tok-pat');
  check('host lookup failure with a resolved customer: booking still succeeds (attribution optional)', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedRpc.p_booking.referred_by_host, null);
  });

  resetCaptures(); customerInsertError = { message: 'insert failed' };
  r = await post(mkAmbassadorPayload(), 'tok-amb');
  check('ensure-row creation failure -> 500, no write', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures(); customerInsertError = { code: '23505', message: 'duplicate' };
  CUSTOMERS_BY_USER['auth-a'] = { id: 'cust-raced' };
  r = await post(mkAmbassadorPayload(), 'tok-amb');
  check('ensure-row unique race -> re-read winner, booking succeeds (concurrency-safe)', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedRpc.p_customer_id, 'cust-raced');
  });
  delete CUSTOMERS_BY_USER['auth-a'];

  resetCaptures();
  r = await post(mkPayload({ refCode: 'GOLD ' }), 'tok-pat');
  check('stored ?ref= code still resolves and attributes the host', () => {
    assert.strictEqual(capturedRpc.p_booking.referred_by_host, 'host-gold');
  });

  resetCaptures();
  r = await post(mkPayload({ price: null }), 'tok-pat');
  check('missing required fields -> 400 with the missing list', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.deepStrictEqual(JSON.parse(r.body).missing, ['price']);
  });

  resetCaptures();
  r = await post(mkPayload({ vehicle: 'Hovercraft' }), 'tok-pat');
  check('unknown vehicle -> sanitized 400, no silent sedan substitution', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(JSON.parse(r.body).error, 'Invalid vehicle');
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures();
  r = await post(mkPayload({ dateTime: 'not-a-date' }), 'tok-pat');
  check('unparseable dateTime -> 400 (was an unhandled 500)', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures();
  r = await post(mkPayload({ mode: 'one-way' }), 'tok-pat');
  check('booking_mode normalized to pickup|dropoff before the RPC', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedRpc.p_booking.booking_mode, 'dropoff');
  });

  // ---- keys-unavailable recovery (plan v3.1 §3.2(c)) ----
  const FAKE_TOKEN = 'abc.def';
  const quoteFields = {
    quoteToken: FAKE_TOKEN, vehicleKey: 'tesla', airportCode: 'MIA',
    placeId: 'ChIJvalidplace1234567', routeMilesTenths: 123, routeMinutes: 25
  };

  resetCaptures();
  receiptRow = {
    operation_request_id: OP_ID, kind: 'create',
    auth_user_id: 'auth-p', customer_id: 'cust-pat',
    request_digest: null, // patched below to the real digest
    booking_id: NEW_BOOKING_ID
  };
  // Compute the exact digest the endpoint will produce for these bytes.
  const crypto = require('crypto');
  const payloadForRecovery = mkPayload({ operationId: OP_ID, ...quoteFields });
  receiptRow.request_digest = crypto.createHash('sha256')
    .update(JSON.stringify(payloadForRecovery), 'utf8').digest('hex');
  storedRow = { id: NEW_BOOKING_ID, trip_id: 'LM-TEST', status: 'pending', pickup_datetime: new Date(Date.now() + 24 * 3600e3).toISOString(), price: 132 };
  r = await post(payloadForRecovery, 'tok-pat');
  check('keys unavailable + exact receipt match -> idempotent 200, NO RPC, no doorbell', () => {
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.idempotent, true);
    assert.strictEqual(body.telegramSent, false);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures();
  receiptRow = {
    operation_request_id: OP_ID, kind: 'edit', // wrong kind — must not match
    auth_user_id: 'auth-p', customer_id: 'cust-pat',
    request_digest: crypto.createHash('sha256')
      .update(JSON.stringify(payloadForRecovery), 'utf8').digest('hex'),
    booking_id: NEW_BOOKING_ID
  };
  r = await post(payloadForRecovery, 'tok-pat');
  check('keys unavailable + kind mismatch -> sanitized 500, NO RPC, no disclosure', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
    assert.ok(!r.body.includes(NEW_BOOKING_ID));
  });

  resetCaptures();
  acceptanceRow = {
    token_digest: crypto.createHash('sha256').update(FAKE_TOKEN, 'utf8').digest('hex'),
    purpose: 'create', auth_user_id: 'auth-p', customer_id: 'cust-pat',
    booking_id: NEW_BOOKING_ID
  };
  storedRow = { id: NEW_BOOKING_ID, trip_id: 'LM-TEST', status: 'pending', pickup_datetime: new Date(Date.now() + 24 * 3600e3).toISOString(), price: 132 };
  r = await post(mkPayload(quoteFields), 'tok-pat');
  check('keys unavailable + token-only acceptance match -> idempotent recovery', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).idempotent, true);
    assert.strictEqual(capturedRpc, null);
  });

  resetCaptures();
  r = await post(mkPayload(quoteFields), 'tok-pat');
  check('keys unavailable + no match -> sanitized 500, NO RPC, no write', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedRpc, null);
    assert.strictEqual(storedRow, null);
  });

  resetCaptures();
  process.env.QUOTE_SIGNING_CURRENT_ID = 'k1';
  process.env.QUOTE_SIGNING_CURRENT_SECRET = 'auth-test-secret-0123456789abcdef0123456789abcd';
  r = await post(mkPayload({ ...quoteFields, quoteToken: 'garbage.token' }), 'tok-pat');
  check('verify_failed with a valid contract keeps the validated routeMinutes as duration', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedRpc.p_verdict, 'verify_failed');
    assert.ok(/^[0-9a-f]{64}$/.test(capturedRpc.p_token_digest));
    assert.strictEqual(capturedRpc.p_payload, null);
    assert.strictEqual(capturedRpc.p_booking.duration_minutes, 25);
  });
  delete process.env.QUOTE_SIGNING_CURRENT_ID;
  delete process.env.QUOTE_SIGNING_CURRENT_SECRET;

  resetCaptures();
  r = await post(mkPayload({ ...quoteFields, routeMinutes: 1441 }), 'tok-pat');
  check('routeMinutes 1441 refused at the endpoint (1..1440) -> requote', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).requote, true);
  });

  resetCaptures();
  r = await post(mkPayload({ ...quoteFields, quoteToken: 'x'.repeat(9000) }), 'tok-pat');
  check('oversize token refused before hashing -> requote, no RPC', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).requote, true);
    assert.strictEqual(capturedRpc, null);
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
