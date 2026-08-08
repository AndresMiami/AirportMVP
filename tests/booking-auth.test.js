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
//   401  missing/invalid/expired token
//   500  auth verification unreachable, customer lookup/creation failure
//   200  authenticated -> booking inserted with customer_id ALWAYS stamped
//        (existing customers row, or ensure-row created from the booker
//        identity — the branch that keeps admin-provisioned ambassadors
//        bookable; 403 remains only as the fail-closed branch when no
//        usable identity exists, which required-field validation makes
//        unreachable in practice)
// Referral attribution, guest columns, and required-field validation are
// unchanged and asserted.

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
  'auth-a': { id: 'host-amb', name: 'Andrea Ambassador', commission_rate: 0.06 }
};
const HOSTS_BY_CODE = {
  gold: { id: 'host-gold', name: 'Goldie', commission_rate: 0.05 }
};

let capturedCustomerInsert = null;
let capturedBookingInsert = null;
let customerLookupError = null; // inject
let customerInsertError = null; // inject
let getUserThrows = false;      // inject

function resetCaptures() {
  capturedCustomerInsert = null;
  capturedBookingInsert = null;
  customerLookupError = null;
  customerInsertError = null;
  getUserThrows = false;
}

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => {
        if (getUserThrows) throw new Error('auth service unreachable');
        return TOKENS[token]
          ? { data: { user: TOKENS[token] }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } };
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
                maybeSingle: async () => ({
                  data: (col === 'user_id' ? HOSTS_BY_USER[val] : HOSTS_BY_CODE[val]) || null,
                  error: null
                })
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
  resetCaptures();
  getUserThrows = true;
  r = await post(mkPayload(), 'tok-pat');
  check('auth verification unreachable -> 500, never a guess', () => {
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

  // ---------- ensure-row: authenticated user without a customers row ----------
  resetCaptures();
  r = await post(mkPayload(), 'tok-new');
  check('no customers row: ensure-row created and stamped (never anonymous)', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.ok(capturedCustomerInsert, 'customers row must be created');
    assert.strictEqual(capturedCustomerInsert.user_id, 'auth-n');
    assert.strictEqual(capturedCustomerInsert.name, 'Pat Passenger');
    assert.strictEqual(capturedCustomerInsert.phone, '+1 305 555 0100');
    assert.strictEqual(capturedCustomerInsert.email, 'new@example.com'); // user.email fallback
    assert.strictEqual(capturedCustomerInsert.type, 'guest');
    assert.strictEqual(capturedCustomerInsert.source, 'website');
    assert.strictEqual(capturedBookingInsert.customer_id, 'cust-new');
  });
  resetCaptures();
  r = await post(mkPayload({
    bookerName: 'Booker Bob',
    bookerPhone: '+1 786 555 0200'
  }), 'tok-new');
  check('ensure-row prefers the BOOKER identity over the passenger', () => {
    assert.strictEqual(capturedCustomerInsert.name, 'Booker Bob');
    assert.strictEqual(capturedCustomerInsert.phone, '+1 786 555 0200');
    assert.strictEqual(capturedBookingInsert.booker_name, 'Booker Bob',
      '"book for someone else" stays functional');
    assert.strictEqual(capturedBookingInsert.customer_name, 'Pat Passenger');
  });

  // ---------- fail closed on database problems ----------
  resetCaptures();
  customerLookupError = { message: 'db down' };
  r = await post(mkPayload(), 'tok-pat');
  check('customer lookup failure -> 500, no booking insert', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(capturedBookingInsert, null);
  });
  resetCaptures();
  customerInsertError = { message: 'insert down' };
  r = await post(mkPayload(), 'tok-new');
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
  resetCaptures();
  r = await post(mkPayload({ refCode: 'GOLD' }), 'tok-amb');
  check('ambassador (no customers row, active hosts row): books via ensure-row, own attribution wins', () => {
    assert.strictEqual(r.statusCode, 200, 'admin-provisioned ambassadors must not be locked out');
    assert.ok(capturedCustomerInsert, 'ambassador customers row ensured');
    assert.strictEqual(capturedBookingInsert.customer_id, 'cust-new');
    assert.strictEqual(capturedBookingInsert.referred_by_host, 'host-amb');
    assert.strictEqual(capturedBookingInsert.host_commission, 7.92); // 132 * 0.06
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
