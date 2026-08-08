// Account-gate test harness — create-booking authentication enforcement.
//
// Run (after `npm install` per LOCAL_DEVELOPMENT.md):
//   node tests/booking-auth.test.js
// Exits 0 with "ALL n CHECKS PASS" on success, nonzero otherwise.
//
// Pattern (same as tests/driver-identity.test.js): mock
// @supabase/supabase-js via require.cache and run the REAL
// create-booking handler, asserting status codes and the exact insert
// payloads. TELEGRAM_BOT_TOKEN is deleted so the doorbell is silent.
//
// Contract under test: new bookings are AUTHENTICATED-ONLY.
//   401  missing token, or an auth error that is a real credential
//        rejection (invalid/expired)
//   500  retryable/network/service auth failures (returned OR thrown —
//        Supabase reports outages as error results), customer lookup /
//        host lookup / ensure-row creation failures
//   403  authenticated user with no customers row and no active host —
//        the payload carries the TRAVELING PASSENGER's details and must
//        never become the account's identity
//   200  identity resolved -> booking inserted, customer_id ALWAYS
//        stamped. Ensure-row exists ONLY as ambassador recovery, sourced
//        from the HOSTS record (never trip-passenger data).

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.TELEGRAM_BOT_TOKEN; // silence the doorbell
delete process.env.ADMIN_TELEGRAM_CHAT_ID;

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

let capturedCustomerInsert = null;
let capturedBookingInsert = null;
let customerLookupError = null;  // inject
let customerInsertError = null;  // inject
let hostLookupError = null;      // inject
let getUserErrorResult = null;   // inject: RETURNED auth error object
let getUserThrows = false;       // inject: THROWN auth failure

function resetCaptures() {
  capturedCustomerInsert = null;
  capturedBookingInsert = null;
  customerLookupError = null;
  customerInsertError = null;
  hostLookupError = null;
  getUserErrorResult = null;
  getUserThrows = false;
}

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => {
        if (getUserThrows) throw new Error('auth service unreachable');
        if (getUserErrorResult) return { data: { user: null }, error: getUserErrorResult };
        return TOKENS[token]
          ? { data: { user: TOKENS[token] }, error: null }
          : { data: { user: null }, error: { status: 401, message: 'bad token' } };
      }
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
      if (table === 'bookings') {
        return {
          insert: (rows) => {
            capturedBookingInsert = rows[0];
            return {
              select: () => ({
                single: async () => ({ data: { id: 'bk-uuid-1', ...rows[0] }, error: null })
              })
            };
          }
        };
      }
      throw new Error('unexpected table: ' + table);
    }
  })
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
  // ---------- the gate: no anonymous path ----------
  resetCaptures();
  let r = await post(mkPayload());
  check('no token -> 401, nothing inserted', () => {
    assert.strictEqual(r.statusCode, 401);
    assert.strictEqual(capturedBookingInsert, null);
    assert.strictEqual(capturedCustomerInsert, null);
  });
  resetCaptures();
  r = await post(mkPayload(), 'tok-nope');
  check('invalid/expired token -> 401, nothing inserted', () => {
    assert.strictEqual(r.statusCode, 401);
    assert.strictEqual(capturedBookingInsert, null);
  });

  // ---------- auth outages are 500, never mislabeled "expired" ----------
  resetCaptures();
  getUserErrorResult = { status: 401, message: 'invalid JWT' };
  r = await post(mkPayload(), 'tok-pat');
  check('RETURNED credential rejection (status 401) -> 401', () =>
    assert.strictEqual(r.statusCode, 401));
  resetCaptures();
  getUserErrorResult = { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' };
  r = await post(mkPayload(), 'tok-pat');
  check('RETURNED retryable/network auth error -> 500, not 401', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedBookingInsert, null);
  });
  resetCaptures();
  getUserErrorResult = { status: 503, message: 'service unavailable' };
  r = await post(mkPayload(), 'tok-pat');
  check('RETURNED 5xx auth service error -> 500, not 401', () =>
    assert.strictEqual(r.statusCode, 500));
  resetCaptures();
  getUserThrows = true;
  r = await post(mkPayload(), 'tok-pat');
  check('THROWN auth failure -> 500', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedBookingInsert, null);
  });

  // ---------- authenticated happy path ----------
  resetCaptures();
  r = await post(mkPayload(), 'tok-pat');
  check('existing customers row: booking inserted with customer_id stamped', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).bookingId, 'bk-uuid-1');
    assert.strictEqual(capturedBookingInsert.customer_id, 'cust-pat');
    assert.strictEqual(capturedCustomerInsert, null, 'no ensure-row when one exists');
  });
  check('guest columns still written for an authenticated booking', () => {
    assert.strictEqual(capturedBookingInsert.customer_name, 'Pat Passenger');
    assert.strictEqual(capturedBookingInsert.customer_phone, '+1 305 555 0100');
    assert.strictEqual(capturedBookingInsert.status, 'pending');
    assert.strictEqual(capturedBookingInsert.source, 'website');
  });
  resetCaptures();
  r = await post(mkPayload({ bookerName: 'Booker Bob', bookerPhone: '+1 786 555 0200' }), 'tok-pat');
  check('"book for someone else" unchanged: booker columns written', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedBookingInsert.booker_name, 'Booker Bob');
    assert.strictEqual(capturedBookingInsert.customer_name, 'Pat Passenger');
  });

  // ---------- identity recovery: ambassadors ONLY, from the HOST record ----------
  resetCaptures();
  r = await post(mkPayload(), 'tok-new');
  check('no customers row + no host -> 403, no inserts (payload data never becomes identity)', () => {
    assert.strictEqual(r.statusCode, 403);
    assert.ok(/profile incomplete/i.test(JSON.parse(r.body).error));
    assert.strictEqual(capturedCustomerInsert, null);
    assert.strictEqual(capturedBookingInsert, null);
  });
  resetCaptures();
  r = await post(mkAmbassadorPayload(), 'tok-amb');
  check('ambassador recovery: account row created from the HOST record, never the traveler', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.ok(capturedCustomerInsert, 'ambassador customers row ensured');
    assert.strictEqual(capturedCustomerInsert.user_id, 'auth-a');
    assert.strictEqual(capturedCustomerInsert.name, 'Andrea Ambassador');
    assert.strictEqual(capturedCustomerInsert.phone, '+1 786 555 0300');
    assert.strictEqual(capturedCustomerInsert.email, 'andrea@casamiami.com');
    assert.notStrictEqual(capturedCustomerInsert.name, 'Maria Traveler');
    assert.notStrictEqual(capturedCustomerInsert.email, 'maria@example.com',
      "the traveling passenger's email must never become the account's");
    assert.strictEqual(capturedBookingInsert.customer_id, 'cust-new');
    assert.strictEqual(capturedBookingInsert.customer_name, 'Maria Traveler',
      'the TRIP still records the traveler');
  });
  check('ambassador booking self-attributes', () => {
    assert.strictEqual(capturedBookingInsert.referred_by_host, 'host-amb');
    assert.strictEqual(capturedBookingInsert.host_commission, 7.92); // 132 * 0.06
  });
  resetCaptures();
  const savedEmail = HOSTS_BY_USER['auth-a'].email;
  HOSTS_BY_USER['auth-a'].email = null;
  r = await post(mkAmbassadorPayload(), 'tok-amb');
  check('host without email: falls back to the AUTH email, never the traveler email', () => {
    assert.strictEqual(capturedCustomerInsert.email, 'amb@example.com');
    assert.notStrictEqual(capturedCustomerInsert.email, 'maria@example.com');
  });
  HOSTS_BY_USER['auth-a'].email = savedEmail;

  // ---------- fail closed on database problems ----------
  resetCaptures();
  customerLookupError = { message: 'db down' };
  r = await post(mkPayload(), 'tok-pat');
  check('customer lookup failure -> 500, no booking insert', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedBookingInsert, null);
  });
  resetCaptures();
  hostLookupError = { message: 'hosts down' };
  r = await post(mkPayload(), 'tok-new');
  check('host lookup failure during recovery -> 500 (cannot decide 403 vs recovery)', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedBookingInsert, null);
  });
  resetCaptures();
  hostLookupError = { message: 'hosts down' };
  r = await post(mkPayload(), 'tok-pat');
  check('host lookup failure with a resolved customer: booking still succeeds (attribution optional)', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedBookingInsert.customer_id, 'cust-pat');
    assert.strictEqual(capturedBookingInsert.referred_by_host, null);
  });
  resetCaptures();
  customerInsertError = { message: 'insert down' };
  r = await post(mkAmbassadorPayload(), 'tok-amb');
  check('ensure-row creation failure -> 500, no booking insert', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedBookingInsert, null);
  });

  // ---------- referral attribution unchanged ----------
  resetCaptures();
  r = await post(mkPayload({ refCode: 'GOLD' }), 'tok-pat');
  check('stored ?ref= code still resolves and stamps commission', () => {
    assert.strictEqual(capturedBookingInsert.referred_by_host, 'host-gold');
    assert.strictEqual(capturedBookingInsert.host_commission, 6.6); // 132 * 0.05
  });

  // ---------- request validation unchanged ----------
  resetCaptures();
  const bad = mkPayload();
  delete bad.pickup;
  r = await post(bad, 'tok-pat');
  check('missing required fields -> 400 with the missing list', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.deepStrictEqual(JSON.parse(r.body).missing, ['pickup']);
    assert.strictEqual(capturedBookingInsert, null);
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
