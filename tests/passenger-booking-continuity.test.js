// Passenger account continuity — authenticated profile lookup returns the
// nearest nonterminal booking so a fresh login can restore its trip sheet.
//
// Run: node tests/passenger-booking-continuity.test.js

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

let activeBooking = {
  id: 'bk-live',
  trip_id: 'LM-LIVE',
  status: 'confirmed',
  pickup_datetime: '2026-08-11T16:00:00Z',
  details_version: 1
};
let activeLookupError = null;
let capturedStatuses = null;
let bookingQueries = 0;
let profileExists = true;
let hostExists = false;

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => token === 'good'
        ? { data: { user: { id: 'auth-p', email: 'pat@example.com' } }, error: null }
        : { data: { user: null }, error: { status: 401 } }
    },
    from: (table) => {
      if (table === 'customers') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: profileExists
                  ? { id: 'cust-p', name: 'Pat', phone: '+13055550100', email: 'pat@example.com' }
                  : null,
                error: null
              })
            })
          })
        };
      }
      if (table === 'hosts') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: hostExists
                    ? { id: 'host-a', name: 'Ambassador', property_name: 'Hotel' }
                    : null,
                  error: null
                })
              })
            })
          })
        };
      }
      if (table === 'bookings') {
        bookingQueries++;
        return {
          select: () => ({
            eq: () => ({
              in: (_column, statuses) => {
                capturedStatuses = statuses;
                return {
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => activeLookupError
                        ? { data: null, error: activeLookupError }
                        : { data: activeBooking, error: null }
                    })
                  })
                };
              }
            })
          })
        };
      }
      throw new Error('unexpected table ' + table);
    }
  })
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = {
  id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock
};
const fn = require(path.join(repoRoot, 'backend/functions/profile.js'));
const get = (token = 'good') => fn.handler({
  httpMethod: 'GET',
  headers: { authorization: 'Bearer ' + token }
});

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

(async () => {
  let r = await get('bad');
  check('invalid session -> 401', () => assert.strictEqual(r.statusCode, 401));

  r = await get();
  let body = JSON.parse(r.body);
  check('active account booking is returned with only continuity fields', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(body.activeBooking, activeBooking);
    assert.deepStrictEqual(Object.keys(body.activeBooking).sort(),
      ['details_version', 'id', 'pickup_datetime', 'status', 'trip_id']);
  });
  check('lookup includes every nonterminal status and excludes terminal states', () => {
    assert.deepStrictEqual(capturedStatuses,
      ['pending', 'confirmed', 'on_the_way', 'arrived', 'in_progress']);
    for (const terminal of ['completed', 'cancelled', 'declined']) {
      assert.ok(!capturedStatuses.includes(terminal));
    }
  });

  activeBooking = null;
  r = await get();
  body = JSON.parse(r.body);
  check('no active ride -> explicit null', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(body.activeBooking, null);
  });

  activeBooking = {
    id: 'bk-guest', trip_id: 'LM-GUEST',
    status: 'confirmed', pickup_datetime: '2026-08-11T18:00:00Z', details_version: 1
  };
  hostExists = true;
  const beforeHost = bookingQueries;
  r = await get();
  body = JSON.parse(r.body);
  check('ambassador accounts remain multi-ride and never auto-resume one guest trip', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(body.activeBooking, null);
    assert.ok(body.ambassador);
    assert.strictEqual(bookingQueries, beforeHost);
  });
  hostExists = false;
  activeBooking = null;

  activeLookupError = { code: 'DB_ACTIVE' };
  r = await get();
  check('active-booking lookup failure -> 500, never an empty-form lie', () =>
    assert.strictEqual(r.statusCode, 500));

  activeLookupError = null;
  profileExists = false;
  const before = bookingQueries;
  r = await get();
  body = JSON.parse(r.body);
  check('account without a customer profile cannot inherit another booking', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(body.activeBooking, null);
    assert.strictEqual(bookingQueries, before);
  });

  console.log('\nALL ' + passed + ' CHECKS PASS');
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
