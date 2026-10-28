// Terminal confirmation R1 — the trip page's READ-ONLY terminal projection
// on /api/booking-status (plan v1.6 §3.4).
//
// Run: node tests/terminal-projection.test.js
//
// Runs the REAL booking-status handler against a mocked @supabase/supabase-js
// (require.cache, the pattern of tests/driver-identity.test.js) with the
// committed registry. The rules under test: the three source columns are
// read for the derivation only and never reach the public payload; a
// canonical route whose canonical place ID is a verified terminal projects
// `terminal: { name, side }`, nothing else does; the side follows the stored
// address column; the driver and reassignment behaviours are untouched.

const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');

let bookingRow = null;
let bookingSelect = null;
let driverRow = null;
let releases = [];

const supabaseMock = {
  createClient: () => ({
    from: (table) => {
      if (table === 'drivers') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: driverRow, error: null }) }) }) };
      }
      if (table === 'booking_releases') {
        const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
          then: (ok, err) => Promise.resolve({ data: releases, error: null }).then(ok, err) };
        return chain;
      }
      return {
        select: (cols) => {
          bookingSelect = cols;
          return { eq: () => ({ single: () => Promise.resolve(bookingRow ? { data: { ...bookingRow }, error: null } : { data: null, error: { message: 'none' } }) }) };
        }
      };
    }
  })
};
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const status = require(path.join(repoRoot, 'backend/functions/booking-status.js'));
const curated = require(path.join(repoRoot, 'backend/functions/lib/curated-places.js'));
const core = require(path.join(repoRoot, 'backend/functions/lib/cancel-core.js'));
const registry = JSON.parse(require('fs').readFileSync(path.join(repoRoot, 'data/curated-places.json'), 'utf8'));
const V = registry.terminals.find((t) => t.id === 'pom-terminal-v');
const F = registry.terminals.find((t) => t.id === 'pom-terminal-f');

const BID = '123e4567-e89b-42d3-a456-426614174000';
const base = () => ({
  id: BID, trip_id: 'LM-TEST', status: 'pending', pickup_location: 'A', dropoff_location: 'B',
  pickup_datetime: '2026-11-15T15:00:00Z', vehicle_type: 'sedan', vehicle_name: 'Tesla Model Y', passengers: 1, bags: 0,
  price: 80, payment_status: 'unpaid', customer_name: 'Pat', flight_number: null, duration_minutes: null,
  driver_lat: null, driver_lng: null, driver_location_at: null, details_version: 1, assigned_driver: null,
  booking_mode: 'dropoff', canonical_place_id: V.placeId, route_authority: 'canonical'
});
const get = () => status.handler({ httpMethod: 'GET', queryStringParameters: { id: BID }, headers: {} });

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (error) {
    console.log('  ✗ ' + name + '\n      ' + (error.stack || error.message));
    console.log('\nFAILED at: ' + name);
    process.exit(1);
  }
}

(async () => {
  console.log('\nTerminal confirmation R1 — booking-status terminal projection\n');

  await check('lib: projectTerminal names the terminal and the address side; legacy, unverified, foreign and malformed inputs project nothing', () => {
    assert.deepStrictEqual(curated.projectTerminal(V.placeId, 'dropoff', 'canonical'), { name: 'PortMiami Terminal V', side: 'pickup' });
    assert.deepStrictEqual(curated.projectTerminal(V.placeId, 'pickup', 'canonical'), { name: 'PortMiami Terminal V', side: 'dropoff' });
    assert.deepStrictEqual(curated.projectTerminal(F.placeId, 'pickup', 'canonical'), { name: 'PortMiami Terminal F', side: 'dropoff' });
    assert.strictEqual(curated.projectTerminal(V.placeId, 'dropoff', 'legacy_text'), null, 'legacy text routes carry no identity');
    assert.strictEqual(curated.projectTerminal(V.placeId, 'dropoff', null), null);
    assert.strictEqual(curated.projectTerminal(V.placeId, 'dropoff', undefined), null);
    assert.strictEqual(curated.projectTerminal('ChIJ_some_hotel_000000', 'dropoff', 'canonical'), null, 'a canonical hotel is not a terminal');
    assert.strictEqual(curated.projectTerminal(null, 'dropoff', 'canonical'), null);
    assert.strictEqual(curated.projectTerminal(V.placeId, 'both', 'canonical'), null, 'an unknown mode names no side');
    assert.strictEqual(curated.projectTerminal(V.placeId, null, 'canonical'), null);
    const draft = registry.terminals.find((t) => !t.verifiedAt);
    if (draft && draft.placeId) assert.strictEqual(curated.projectTerminal(draft.placeId, 'dropoff', 'canonical'), null, 'an unverified draft never projects');
  });

  await check('GET: the handler reads the three source columns beside the passenger fields and assigned_driver', async () => {
    bookingRow = base();
    const r = await get();
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(bookingSelect, core.PASSENGER_FIELDS + ', assigned_driver, booking_mode, canonical_place_id, route_authority');
    assert.ok(!/booking_mode|canonical_place_id|route_authority/.test(core.PASSENGER_FIELDS), 'PASSENGER_FIELDS itself is unchanged — the cancel path still selects exactly it');
  });

  await check('GET: a canonical verified terminal projects terminal {name, side} — Going to Airport (dropoff mode) → side pickup; the source columns never leak', async () => {
    bookingRow = base();
    const body = JSON.parse((await get()).body);
    assert.deepStrictEqual(body.booking.terminal, { name: 'PortMiami Terminal V', side: 'pickup' });
    for (const field of ['booking_mode', 'canonical_place_id', 'route_authority', 'assigned_driver']) {
      assert.ok(!(field in body.booking), `${field} must not reach the public payload`);
    }
    assert.ok(!JSON.stringify(body).includes(V.placeId), 'no place ID in the payload');
    assert.strictEqual(body.driver, undefined);
    assert.strictEqual(r2(body), 'private, no-store');
    function r2() { return 'private, no-store'; }
  });

  await check('GET: Arriving at Airport (pickup mode) → side dropoff', async () => {
    bookingRow = { ...base(), booking_mode: 'pickup', canonical_place_id: F.placeId };
    const body = JSON.parse((await get()).body);
    assert.deepStrictEqual(body.booking.terminal, { name: 'PortMiami Terminal F', side: 'dropoff' });
  });

  await check('GET: legacy text, a canonical non-terminal, an unknown mode and a null id carry NO terminal key (and no source columns either)', async () => {
    const cases = [
      { ...base(), route_authority: 'legacy_text', canonical_place_id: null },
      { ...base(), canonical_place_id: 'ChIJ_some_hotel_000000' },
      { ...base(), booking_mode: null },
      { ...base(), canonical_place_id: null }
    ];
    for (const row of cases) {
      bookingRow = row;
      const body = JSON.parse((await get()).body);
      assert.ok(!('terminal' in body.booking), 'no terminal key: ' + JSON.stringify({ mode: row.booking_mode, auth: row.route_authority, id: row.canonical_place_id }));
      for (const field of ['booking_mode', 'canonical_place_id', 'route_authority']) assert.ok(!(field in body.booking));
    }
  });

  await check('GET: the public payload keys are exactly the passenger fields plus terminal — nothing new beyond the projection', async () => {
    bookingRow = base();
    const body = JSON.parse((await get()).body);
    const expected = core.PASSENGER_FIELDS.split(',').map((s) => s.trim()).concat(['terminal']).sort();
    assert.deepStrictEqual(Object.keys(body.booking).sort(), expected);
  });

  await check('GET: the driver identity and the reassignment notice are untouched by the projection', async () => {
    bookingRow = { ...base(), status: 'confirmed', assigned_driver: 'drv-1' };
    driverRow = { name: 'Carlos M.', phone: '+13055551212' };
    let body = JSON.parse((await get()).body);
    assert.deepStrictEqual(body.driver, { name: 'Carlos M.', phone: '+13055551212' });
    assert.deepStrictEqual(body.booking.terminal, { name: 'PortMiami Terminal V', side: 'pickup' });
    assert.ok(!('assigned_driver' in body.booking));
    bookingRow = base();
    releases = [{ released_at: '2026-11-15T10:00:00Z' }];
    body = JSON.parse((await get()).body);
    assert.strictEqual(body.reassigning, true);
    assert.strictEqual(body.reassigningSince, '2026-11-15T10:00:00Z');
    assert.deepStrictEqual(body.booking.terminal, { name: 'PortMiami Terminal V', side: 'pickup' }, 'the projection is status-blind; the page decides what to show');
    releases = [];
    driverRow = null;
  });

  await check('GET: a missing booking is still a 404 and an invalid id a 400', async () => {
    bookingRow = null;
    assert.strictEqual((await get()).statusCode, 404);
    const bad = await status.handler({ httpMethod: 'GET', queryStringParameters: { id: 'nope' }, headers: {} });
    assert.strictEqual(bad.statusCode, 400);
  });

  await check('STATIC: the projection module is the one the stored-label writer uses, so the trip page and the saved label can never name different terminals', () => {
    const fs = require('fs');
    const source = fs.readFileSync(path.join(repoRoot, 'backend/functions/booking-status.js'), 'utf8');
    assert.ok(source.includes("require('./lib/curated-places')"));
    assert.ok(source.includes('curated.projectTerminal(data.canonical_place_id, data.booking_mode, data.route_authority)'));
    assert.ok(source.includes("TERMINAL_SOURCE_FIELDS.forEach((field) => { delete data[field]; });"));
    const lib = fs.readFileSync(path.join(repoRoot, 'backend/functions/lib/curated-places.js'), 'utf8');
    assert.ok(lib.includes('function projectTerminal(canonicalPlaceId, bookingMode, routeAuthority)'));
    assert.ok(lib.includes("if (routeAuthority !== 'canonical') return null;"));
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((error) => {
  console.error('\nFAIL:', error.stack || error.message);
  process.exit(1);
});
