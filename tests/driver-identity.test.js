// Driver-identity test harness — two-driver authorization coverage.
//
// Run (after `npm install` per LOCAL_DEVELOPMENT.md):
//   node tests/driver-identity.test.js
// Exits 0 with "ALL n CHECKS PASS" on success, nonzero with the first
// failing assertion otherwise. No framework: mocks @supabase/supabase-js
// via require.cache and runs the REAL function handlers, asserting the
// exact update payloads and query filters they produce.

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.TELEGRAM_BOT_TOKEN; // silence receipts

// ---------- mock state ----------
const TOKENS = {
  'tok-andres': { id: 'auth-a' },
  'tok-carlos': { id: 'auth-c' },
  'tok-busy':   { id: 'auth-b' },
  'tok-nodrv':  { id: 'auth-x' }
};
const DRIVERS_BY_USER = {
  'auth-a': { id: 'drv-a', name: 'Andres',    phone: '+17865093955', status: 'active' },
  'auth-c': { id: 'drv-c', name: 'Carlos M.', phone: '+13055551212', status: 'active' },
  'auth-b': { id: 'drv-b', name: 'Busy Bee',  phone: '+13055550000', status: 'busy' }
};
const DRIVERS_BY_ID = {};
Object.values(DRIVERS_BY_USER).forEach((d) => { DRIVERS_BY_ID[d.id] = d; });

let lastUpdate = null;         // captured update payload
let lastFilters = null;        // captured eq/in filters on the update chain
let lastIsFilter = null;       // captured .is() on the update chain
let capturedListOr = null;     // captured .or() on the list query
let capturedListCols = null;   // captured column list on select()
let updateResult = { data: [], error: null };
let listResult = [];
let currentBookingResult = { data: null, error: { message: 'none' } };
let releasesResult = { data: [], error: null }; // booking_releases rows (PR 3C-1)
let releasesQueried = null;    // captured eq filter on the releases lookup
let driversLookupError = null; // injectable drivers maybeSingle failure

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => TOKENS[token]
        ? { data: { user: TOKENS[token] }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } }
    },
    from: (table) => {
      if (table === 'drivers') {
        return {
          select: () => ({
            eq: (col, val) => ({
              single: () => {
                const row = col === 'user_id' ? DRIVERS_BY_USER[val] : DRIVERS_BY_ID[val];
                return Promise.resolve(row
                  ? { data: row, error: null }
                  : { data: null, error: { message: 'none' } });
              },
              // booking-status's identity lookup (PR 3C-1: fail-closed on
              // ERROR, tolerant on ABSENCE — maybeSingle separates the two)
              maybeSingle: () => {
                if (driversLookupError) return Promise.resolve({ data: null, error: driversLookupError });
                const row = col === 'user_id' ? DRIVERS_BY_USER[val] : DRIVERS_BY_ID[val];
                return Promise.resolve({ data: row || null, error: null });
              }
            })
          })
        };
      }
      if (table === 'booking_releases') {
        // PR 3C-1: the requests-feed exclusion lookup (awaited directly
        // after .eq) and booking-status's pending reassigning lookup
        // (.order().limit() thenable).
        const chain = {
          select: () => chain,
          eq: (col, val) => { releasesQueried = { col, val }; return chain; },
          order: () => chain,
          limit: () => chain,
          then: (onOk, onErr) => Promise.resolve(releasesResult).then(onOk, onErr)
        };
        return chain;
      }
      // bookings
      return {
        update(payload) {
          lastUpdate = payload;
          const chain = {
            _f: {},
            eq(col, val) { chain._f[col] = val; lastFilters = chain._f; return chain; },
            in(col, val) { chain._f[col] = val; lastFilters = chain._f; return chain; },
            is(col, val) { lastIsFilter = { col, val }; return chain; },
            or() { throw new Error('update .or() must not be used post-corrections'); },
            select() { return Promise.resolve(updateResult); }
          };
          return chain;
        },
        select(cols) {
          capturedListCols = cols;
          const chain = {
            or(expr) { capturedListOr = expr; return chain; },
            order() { return Promise.resolve({ data: listResult, error: null }); },
            eq() { return chain; },
            single() { return Promise.resolve(currentBookingResult); },
            maybeSingle() { return Promise.resolve(currentBookingResult); }
          };
          return chain;
        }
      };
    }
  })
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const upd = require(path.join(repoRoot, 'backend/functions/update-booking-status.js'));
const list = require(path.join(repoRoot, 'backend/functions/driver-bookings.js'));
const stat = require(path.join(repoRoot, 'backend/functions/booking-status.js'));

const BID = '123e4567-e89b-42d3-a456-426614174000';
const post = (body, token) => upd.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body)
});
const getList = (token) => list.handler({
  httpMethod: 'GET',
  headers: token ? { authorization: `Bearer ${token}` } : {}
});

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

(async () => {
  // ---------- authentication ----------
  let r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 });
  check('no token -> 401', () => assert.strictEqual(r.statusCode, 401));
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-invalid');
  check('invalid token -> 401', () => assert.strictEqual(r.statusCode, 401));
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-nodrv');
  check('no drivers row -> 403', () => assert.strictEqual(r.statusCode, 403));
  DRIVERS_BY_USER['auth-c'].status = 'inactive';
  r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-carlos');
  check('inactive driver -> 403', () => assert.strictEqual(r.statusCode, 403));
  r = await getList('tok-carlos');
  check('inactive driver -> 403 on list too', () => assert.strictEqual(r.statusCode, 403));
  DRIVERS_BY_USER['auth-c'].status = 'active';

  // ---------- visibility ----------
  capturedListOr = null;
  r = await getList('tok-andres');
  check('active: shared unassigned pending + OWN active rides only', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store',
      'driver data must never be browser/proxy-cacheable');
    assert.strictEqual(capturedListOr,
      'and(status.eq.pending,assigned_driver.is.null),and(status.in.(confirmed,on_the_way,arrived,in_progress),assigned_driver.eq.drv-a)');
    assert.deepStrictEqual(JSON.parse(r.body).driver, { id: 'drv-a', name: 'Andres', status: 'active' });
  });
  capturedListOr = null;
  r = await getList('tok-carlos');
  check('second active driver: same shared pending, own rides scoped to drv-c', () => {
    assert.ok(capturedListOr.includes('status.eq.pending,assigned_driver.is.null'));
    assert.ok(capturedListOr.includes('assigned_driver.eq.drv-c'));
    assert.ok(!capturedListOr.includes('drv-a'));
  });
  capturedListOr = null;
  r = await getList('tok-busy');
  check('busy: own active rides ONLY, no pending clause', () => {
    assert.strictEqual(capturedListOr,
      'and(status.in.(confirmed,on_the_way,arrived,in_progress),assigned_driver.eq.drv-b)');
  });

  // ---------- pre-accept privacy ----------
  listResult = [
    { id: 'p1', status: 'pending', details_version: 3, customer_name: 'Pat', customer_phone: '+15551234567',
      booker_name: 'Booker', booker_phone: '+15559876543', pickup_sign: 'SIGN', notes: 'gate code 1234',
      payment_status: 'unpaid', flight_number: 'AA123', assigned_driver: null, price: 80 },
    { id: 'a1', status: 'on_the_way', customer_name: 'Pat', customer_phone: '+15551234567',
      notes: 'gate code 1234', payment_status: 'unpaid', flight_number: 'AA123',
      assigned_driver: 'drv-a', price: 80 }
  ];
  r = await getList('tok-andres');
  check('driver query uses an explicit whitelist, never *', () => {
    assert.ok(typeof capturedListCols === 'string' && capturedListCols !== '*');
    assert.ok(!capturedListCols.includes('host_commission'), 'commission internals leaked');
    assert.ok(!capturedListCols.includes('referred_by_host'), 'ambassador internals leaked');
    assert.ok(!capturedListCols.includes('linkmia_commission'), 'commission internals leaked');
    assert.ok(!capturedListCols.includes('customer_email'), 'customer email leaked');
    assert.ok(!capturedListCols.includes('assigned_driver'), 'assigned_driver should be filter-only');
  });
  check('pending offers fully redacted; own rides keep operational details', () => {
    const rows = JSON.parse(r.body).bookings;
    const offer = rows.find((x) => x.id === 'p1');
    const mine = rows.find((x) => x.id === 'a1');
    ['customer_name', 'customer_phone', 'booker_name', 'booker_phone', 'pickup_sign', 'notes',
     'payment_status', 'flight_number']
      .forEach((f) => assert.ok(!(f in offer), f + ' leaked on a pending offer'));
    assert.strictEqual(offer.price, 80); // operational fields survive
    assert.strictEqual(mine.customer_phone, '+15551234567');
    assert.strictEqual(mine.notes, 'gate code 1234');
    assert.strictEqual(mine.payment_status, 'unpaid');   // assigned ride keeps these
    assert.strictEqual(mine.flight_number, 'AA123');
    rows.forEach((x) => assert.ok(!('assigned_driver' in x), 'assigned_driver returned to client'));
  });
  listResult = [];

  // ---------- accept ----------
  lastUpdate = null; lastIsFilter = null; lastFilters = null;
  updateResult = { data: [{ id: BID, status: 'confirmed' }], error: null };
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-andres');
  check('accept: stamps assigned_driver atomically, requires UNASSIGNED pending', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(lastUpdate.status, 'confirmed');
    assert.strictEqual(lastUpdate.assigned_driver, 'drv-a');
    assert.deepStrictEqual(lastIsFilter, { col: 'assigned_driver', val: null });
    assert.deepStrictEqual(lastFilters.status, ['pending']);
    assert.strictEqual(lastFilters.details_version, 1,
      'Accept must match the exact offer version the driver saw');
  });
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-busy');
  check('busy driver cannot accept -> 403', () => assert.strictEqual(r.statusCode, 403));

  updateResult = { data: [], error: null };
  currentBookingResult = {
    data: {
      status: 'pending', assigned_driver: null, details_version: 2,
      pickup_datetime: new Date(Date.now() + 4 * 3600e3).toISOString()
    },
    error: null
  };
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-andres');
  check('stale offer version cannot be accepted -> 409 with current version', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).currentDetailsVersion, 2);
  });

  // ---------- ownership on later actions ----------
  lastUpdate = null; lastIsFilter = null; lastFilters = null;
  updateResult = { data: [{ id: BID, status: 'on_the_way' }], error: null };
  r = await post({ bookingId: BID, action: 'on_my_way', lat: 25.7, lng: -80.2 }, 'tok-andres');
  check('checkpoint: EXACT ownership filter, atomic coords, NO re-stamp', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(lastFilters.assigned_driver, 'drv-a');
    assert.strictEqual(lastIsFilter, null);
    assert.strictEqual(lastUpdate.driver_lat, 25.7);
    assert.ok(!('assigned_driver' in lastUpdate));
  });
  lastFilters = null;
  updateResult = { data: [{ id: BID, status: 'on_the_way' }], error: null };
  r = await post({ bookingId: BID, action: 'payment_collected', paymentMethod: 'cash' }, 'tok-andres');
  check('payment_collected: exact ownership filter applies', () =>
    assert.strictEqual(lastFilters.assigned_driver, 'drv-a'));
  lastUpdate = null;
  updateResult = { data: [{ id: BID, status: 'completed' }], error: null };
  r = await post({ bookingId: BID, action: 'complete' }, 'tok-andres');
  check('complete: coordinates wiped (regression)', () => {
    assert.strictEqual(lastUpdate.driver_lat, null);
    assert.strictEqual(lastUpdate.driver_location_at, null);
  });

  // ---------- idempotency: backend-verified, owner-only ----------
  updateResult = { data: [], error: null }; // 0 rows matched
  currentBookingResult = { data: { status: 'on_the_way', assigned_driver: 'drv-a' }, error: null };
  r = await post({ bookingId: BID, action: 'on_my_way', lat: 25.7, lng: -80.2 }, 'tok-andres');
  check('owner duplicate resend -> 200 idempotent', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).idempotent, true);
  });
  r = await post({ bookingId: BID, action: 'on_my_way', lat: 25.7, lng: -80.2 }, 'tok-carlos');
  check('NON-owner conflict on matching status -> 409, never success', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).currentStatus, 'on_the_way');
  });
  r = await post({ bookingId: BID, action: 'complete' }, 'tok-carlos');
  check('non-owner complete -> 409', () => assert.strictEqual(r.statusCode, 409));
  r = await post({ bookingId: BID, action: 'payment_collected', paymentMethod: 'cash' }, 'tok-carlos');
  check('non-owner payment -> 409 (payment has no idempotent path)', () =>
    assert.strictEqual(r.statusCode, 409));

  // ---------- decline removed ----------
  r = await post({ bookingId: BID, action: 'decline' }, 'tok-andres');
  check('decline -> 400 Unknown action', () => assert.strictEqual(r.statusCode, 400));

  // ---------- durable transition timestamps + readiness (PR 1) ----------
  lastUpdate = null;
  updateResult = { data: [{ id: BID, status: 'confirmed' }], error: null };
  currentBookingResult = {
    data: { pickup_datetime: new Date(Date.now() + 10 * 3600e3).toISOString() },
    error: null
  };
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-andres');
  check('accept stamps accepted_at; far pickup -> NO recent-accept readiness', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.ok(lastUpdate.accepted_at, 'accepted_at anchor missing');
    assert.ok(!('driver_ready_source' in lastUpdate), 'readiness must not stamp on far accepts');
  });
  lastUpdate = null;
  currentBookingResult = {
    data: { pickup_datetime: new Date(Date.now() + 2 * 3600e3).toISOString() },
    error: null
  };
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-andres');
  check('accept at/after T-180 IS readiness: recent_accept stamped in the SAME update', () => {
    assert.strictEqual(lastUpdate.driver_ready_source, 'recent_accept');
    assert.strictEqual(lastUpdate.driver_ready_by, 'drv-a');
    assert.ok(lastUpdate.driver_ready_at);
    assert.ok(lastUpdate.accepted_at);
  });
  lastUpdate = null;
  updateResult = { data: [{ id: BID, status: 'on_the_way' }], error: null };
  r = await post({ bookingId: BID, action: 'on_my_way', lat: 25.7, lng: -80.2 }, 'tok-andres');
  check('on_my_way: stamps on_the_way_at + clears at_risk_at; NEVER writes readiness fields', () => {
    assert.ok(lastUpdate.on_the_way_at, 'on_the_way_at anchor missing');
    assert.strictEqual(lastUpdate.at_risk_at, null, 'On my way must clear at_risk_at');
    assert.ok(!('driver_ready_source' in lastUpdate));
    assert.ok(!('driver_ready_at' in lastUpdate));
    assert.ok(!('driver_ready_by' in lastUpdate));
  });
  // Interleaving regression: an explicit web confirmation lands moments
  // before On my way. Because on_my_way has NO readiness write path at
  // all (the on_the_way status + on_the_way_at ARE the implicit proof),
  // no interleaving can ever downgrade 'web' to 'implicit'.
  currentBookingResult = {
    data: { pickup_datetime: new Date(Date.now() + 2 * 3600e3).toISOString() },
    error: null
  };
  updateResult = { data: [{ id: BID, status: 'confirmed' }], error: null };
  await post({ bookingId: BID, action: 'ready' }, 'tok-andres'); // web confirm lands first
  lastUpdate = null;
  updateResult = { data: [{ id: BID, status: 'on_the_way' }], error: null };
  r = await post({ bookingId: BID, action: 'on_my_way', lat: 25.7, lng: -80.2 }, 'tok-andres');
  check('race regression: web readiness can never become implicit via On my way', () => {
    assert.ok(!('driver_ready_source' in lastUpdate), 'readiness field written by on_my_way');
    assert.ok(!('driver_ready_at' in lastUpdate));
    assert.ok(!('driver_ready_by' in lastUpdate));
    assert.ok(lastUpdate.on_the_way_at);
    assert.strictEqual(lastUpdate.at_risk_at, null);
  });
  lastUpdate = null;
  updateResult = { data: [{ id: BID, status: 'arrived' }], error: null };
  r = await post({ bookingId: BID, action: 'arrived' }, 'tok-andres');
  check('arrived stamps arrived_at (durable milestone anchor)', () =>
    assert.ok(lastUpdate.arrived_at));
  lastUpdate = null;
  updateResult = { data: [{ id: BID, status: 'in_progress' }], error: null };
  r = await post({ bookingId: BID, action: 'start_trip' }, 'tok-andres');
  check('start_trip stamps started_at (durable milestone anchor)', () =>
    assert.ok(lastUpdate.started_at));

  // ---------- ready action ----------
  // Server-side T-180 window: the UI gate is convenience, not security.
  lastUpdate = null;
  currentBookingResult = {
    data: { pickup_datetime: new Date(Date.now() + 10 * 3600e3).toISOString() },
    error: null
  };
  r = await post({ bookingId: BID, action: 'ready' }, 'tok-andres');
  check('ready more than T-180 out -> 409 rejected SERVER-side, no update attempted', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.ok(/too early/i.test(JSON.parse(r.body).error));
    assert.strictEqual(lastUpdate, null, 'premature ready must never reach the update');
  });
  currentBookingResult = { data: null, error: { message: 'read exploded' } };
  r = await post({ bookingId: BID, action: 'ready' }, 'tok-andres');
  check('ready window read failure -> 500, never a silent pass-through', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(lastUpdate, null);
  });
  currentBookingResult = { data: { pickup_datetime: 'not-a-date' }, error: null };
  r = await post({ bookingId: BID, action: 'ready' }, 'tok-andres');
  check('ready with an UNPARSEABLE pickup time: fails CLOSED (409), no readiness recorded', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(lastUpdate, null, 'invalid timing must never reach the update');
  });
  currentBookingResult = { data: {}, error: null }; // booking exists, pickup missing
  r = await post({ bookingId: BID, action: 'ready' }, 'tok-andres');
  check('ready with a MISSING pickup time: fails CLOSED (409), no readiness recorded', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(lastUpdate, null);
  });
  lastUpdate = null; lastFilters = null; lastIsFilter = null;
  currentBookingResult = {
    data: { pickup_datetime: new Date(Date.now() + 2 * 3600e3).toISOString() },
    error: null
  };
  updateResult = { data: [{ id: BID, status: 'confirmed' }], error: null };
  r = await post({ bookingId: BID, action: 'ready' }, 'tok-andres');
  check('ready inside T-180: confirmed-only + owner-guarded + first-confirm-wins; records WHO; clears at-risk', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(lastFilters.status, ['confirmed']);
    assert.strictEqual(lastFilters.assigned_driver, 'drv-a');
    assert.deepStrictEqual(lastIsFilter, { col: 'driver_ready_at', val: null });
    assert.strictEqual(lastUpdate.driver_ready_by, 'drv-a');
    assert.strictEqual(lastUpdate.driver_ready_source, 'web');
    assert.ok(lastUpdate.driver_ready_at);
    assert.strictEqual(lastUpdate.at_risk_at, null);
    assert.ok(!('status' in lastUpdate), 'ready must never change the passenger lifecycle status');
    assert.ok(!('driver_lat' in lastUpdate), 'ready must never capture location');
  });
  updateResult = { data: [], error: null }; // 0 rows: already ready
  currentBookingResult = {
    data: { status: 'confirmed', assigned_driver: 'drv-a',
            driver_ready_at: '2026-08-07T10:00:00Z', driver_ready_by: 'drv-a',
            pickup_datetime: new Date(Date.now() + 2 * 3600e3).toISOString() },
    error: null
  };
  r = await post({ bookingId: BID, action: 'ready' }, 'tok-andres');
  check('ready duplicate by the SAME owner -> 200 idempotent', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).idempotent, true);
  });
  r = await post({ bookingId: BID, action: 'ready' }, 'tok-carlos');
  check('ready by a NON-owner -> 409, never success', () =>
    assert.strictEqual(r.statusCode, 409));

  // ---------- passenger-facing driver exposure ----------
  currentBookingResult = { data: { id: BID, status: 'confirmed', assigned_driver: 'drv-c' }, error: null };
  r = await stat.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });
  check('booking-status: driver name+phone exposed, internal id stripped', () => {
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(body.driver, { name: 'Carlos M.', phone: '+13055551212' });
    assert.ok(!('assigned_driver' in body.booking));
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store',
      'passenger booking data must never be browser/proxy-cacheable');
  });
  DRIVERS_BY_ID['drv-c'].phone = null;
  // fresh fixture: the handler deletes assigned_driver from the row object
  currentBookingResult = { data: { id: BID, status: 'confirmed', assigned_driver: 'drv-c' }, error: null };
  r = await stat.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });
  check('phoneless driver: name exposed with empty phone (client hides WhatsApp)', () => {
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(body.driver, { name: 'Carlos M.', phone: '' });
  });
  DRIVERS_BY_ID['drv-c'].phone = '+13055551212';

  // ---------- PR 3C-1: release reaccept guard + feed exclusion ----------
  updateResult = { data: null, error: { code: 'P0001', message: 'released_by_this_driver' } };
  currentBookingResult = { data: { status: 'confirmed', details_version: 4 }, error: null };
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-andres');
  check('accept blocked by the DB reaccept guard -> honest 409 WITH live truth, never a 500', () => {
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.code, 'released_by_you');
    assert.ok(/released this ride/i.test(body.error));
    assert.strictEqual(body.currentStatus, 'confirmed', 'the conflict re-read reports live status');
    assert.strictEqual(body.currentDetailsVersion, 4);
  });

  updateResult = { data: null, error: { code: 'P0001', message: 'released_by_this_driver' } };
  currentBookingResult = { data: null, error: { message: 'db down' } };
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-andres');
  check('guard conflict with a FAILED re-read -> 500, never a guessed 409', () => {
    assert.strictEqual(r.statusCode, 500);
  });

  updateResult = { data: null, error: { code: '57014', message: 'statement timeout' } };
  r = await post({ bookingId: BID, action: 'accept', expectedDetailsVersion: 1 }, 'tok-andres');
  check('any OTHER update error stays a real 500 (the guard mapping is narrow)', () => {
    assert.strictEqual(r.statusCode, 500);
  });
  updateResult = { data: [], error: null };

  releasesResult = { data: [{ booking_id: 'p-released' }], error: null };
  listResult = [
    { id: 'p-released', status: 'pending', details_version: 1, customer_name: 'Sam', assigned_driver: null },
    { id: 'p-fresh', status: 'pending', details_version: 1, customer_name: 'Kim', assigned_driver: null },
    { id: 'own-1', status: 'confirmed', details_version: 1, customer_name: 'Pat', assigned_driver: 'drv-a' }
  ];
  r = await getList('tok-andres');
  check('requests feed excludes bookings THIS driver released; other offers + own rides intact', () => {
    const body = JSON.parse(r.body);
    const ids = body.bookings.map((b) => b.id);
    assert.ok(!ids.includes('p-released'), 'a released booking must never be re-offered to its releaser');
    assert.ok(ids.includes('p-fresh'));
    assert.ok(ids.includes('own-1'));
    assert.deepStrictEqual(releasesQueried, { col: 'driver_id', val: 'drv-a' });
  });

  releasesResult = { data: null, error: { message: 'db down' } };
  r = await getList('tok-andres');
  check('release-exclusion lookup failure -> 500, NEVER an unfiltered feed (fail closed)', () => {
    assert.strictEqual(r.statusCode, 500);
  });
  releasesResult = { data: [], error: null };

  releasesQueried = null;
  listResult = [
    { id: 'own-b', status: 'confirmed', details_version: 1, customer_name: 'Pat', assigned_driver: 'drv-b' }
  ];
  r = await getList('tok-busy');
  check('busy driver (no pending arm) skips the exclusion lookup entirely', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(releasesQueried, null, 'no releases query without a requests feed');
  });

  // ---------- PR 3C-1: passenger reassignment flag ----------
  releasesResult = { data: [{ released_at: '2026-08-14T20:00:00.000Z' }], error: null };
  currentBookingResult = { data: { id: BID, status: 'pending', assigned_driver: null }, error: null };
  r = await stat.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });
  check('booking-status: released pending booking answers reassigning + persistent reassigningSince', () => {
    const body = JSON.parse(r.body);
    assert.strictEqual(body.reassigning, true);
    assert.strictEqual(body.reassigningSince, '2026-08-14T20:00:00.000Z');
    assert.strictEqual(body.driver, undefined, 'no former-driver identity in the payload');
  });

  releasesQueried = null;
  currentBookingResult = { data: { id: BID, status: 'confirmed', assigned_driver: 'drv-c' }, error: null };
  r = await stat.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });
  check('booking-status: non-pending rows never query releases and never carry the flag', () => {
    const body = JSON.parse(r.body);
    assert.ok(!('reassigning' in body));
    assert.strictEqual(releasesQueried, null);
  });

  releasesResult = { data: null, error: { message: 'db down' } };
  currentBookingResult = { data: { id: BID, status: 'pending', assigned_driver: null }, error: null };
  r = await stat.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });
  check('booking-status: release lookup failure -> 500 (fail closed, never a silently wrong flag)', () => {
    assert.strictEqual(r.statusCode, 500);
  });
  releasesResult = { data: [], error: null };

  // ---------- PR 3C-1: driver identity lookup is fail-closed ----------
  driversLookupError = { message: 'db down' };
  currentBookingResult = { data: { id: BID, status: 'confirmed', assigned_driver: 'drv-c' }, error: null };
  r = await stat.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });
  check('booking-status: driver identity lookup FAILURE on an assigned ride -> 500, never a silent driver-less payload', () => {
    assert.strictEqual(r.statusCode, 500);
  });
  driversLookupError = null;

  currentBookingResult = { data: { id: BID, status: 'confirmed', assigned_driver: 'drv-gone' }, error: null };
  r = await stat.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });
  check('booking-status: genuinely ABSENT drivers row stays tolerated (legacy data) — 200, no driver key', () => {
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.ok(!('driver' in body) || body.driver === undefined);
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
