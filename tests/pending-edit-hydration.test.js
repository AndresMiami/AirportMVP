// PR-A — authenticated hydration read + the dark pending-edit model.
// Plan v8.6 §3A (the GET/DTO) and §3B (snapshot/draft/adapters).
//
// Two things this suite exists to prove:
//   1. the endpoint's ORDER is the contract — a bad id, a foreign row, a
//      non-editable row or an invalid stored row must cost ZERO rate-card
//      resolver calls, and every post-authentication failure that is not a
//      typed 400/404/409 answers ONE fixed body that leaks nothing;
//   2. PR-A is dark for PASSENGERS — no page loads the new model, no
//      precached asset changes, and no cache name moves.
//
// Run: node tests/pending-edit-hydration.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const repoRoot = path.join(__dirname, '..');
const BID = '123e4567-e89b-42d3-a456-426614174000';

let booking = null;
let bookingReadError = null;
let customer = { id: 'cust-a' };
let customerError = null;
let authUser = { id: 'auth-a' };
let authError = null;
let resolverCalls = [];
let resolverResult = null;
let resolverThrows = false;
let capturedFilters = null;

function baseRow(overrides = {}) {
  return {
    id: BID,
    trip_id: 'LM-HYDR',
    status: 'pending',
    assigned_driver: null,
    details_version: 3,
    pickup_location: 'MIA',
    dropoff_location: '4441 Collins Ave',
    pickup_datetime: '2026-12-01T15:00:00.000Z',
    booking_mode: 'pickup',
    route_authority: 'canonical',
    airport_code: 'MIA',
    canonical_place_id: 'ChIJEcHIDqKw2YgRZU-t3XHylv8',
    vehicle_type: 'sedan',
    vehicle_name: 'Tesla Model Y',
    passengers: 2,
    bags: 4,
    price: 120,
    price_cents: 12000,
    customer_name: 'Pat Passenger',
    customer_phone: '+1 305 555 0100',
    customer_email: 'pat@example.com',
    booker_name: null,
    booker_phone: null,
    notes: 'Meet at door 3',
    pickup_sign: 'PAT',
    ...overrides
  };
}

function reset(overrides = {}) {
  booking = baseRow(overrides);
  bookingReadError = null;
  customer = { id: 'cust-a' };
  customerError = null;
  authUser = { id: 'auth-a' };
  authError = null;
  resolverCalls = [];
  resolverThrows = false;
  capturedFilters = null;
  resolverResult = {
    ok: true,
    source: 'code',
    resolvedVersion: 'test',
    card: {
      vehicles: {
        tesla: { name: 'Tesla Model Y', capacity: { passengers: 4, bags: 4 } },
        escalade: { name: 'Cadillac Escalade', capacity: { passengers: 7, bags: 8 } },
        sprinter: { name: 'Mercedes Sprinter', capacity: { passengers: 12, bags: 15 } }
      }
    }
  };
}

// ---- mock @supabase/supabase-js -------------------------------------------
const dbClient = {
  rpc: async () => { throw new Error('the hydration GET must never call an RPC'); },
  from(table) {
    if (table === 'customers') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: customer, error: customerError }) }) }) };
    }
    if (table === 'bookings') {
      const filters = {};
      const chain = {
        select: () => chain,
        eq: (col, val) => { filters[col] = val; return chain; },
        maybeSingle: async () => {
          capturedFilters = { ...filters };
          if (bookingReadError) return { data: null, error: bookingReadError };
          const match = booking && booking.id === filters.id &&
            booking.customer_id_for_test !== undefined
            ? booking.customer_id_for_test === filters.customer_id
            : filters.customer_id === 'cust-a';
          return { data: match && booking && booking.id === filters.id ? booking : null, error: null };
        }
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  }
};
const authClient = { auth: { getUser: async () => ({ data: authUser ? { user: authUser } : null, error: authError }) } };

const supaPath = require.resolve('@supabase/supabase-js');
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true, exports: {
    createClient: (_url, key) => (key === process.env.SUPABASE_ANON_KEY ? authClient : dbClient)
  }
};

// ---- mock the rate-card resolver (call-counted) ---------------------------
const resolverPath = require.resolve('../backend/functions/lib/rate-card-resolver');
require.cache[resolverPath] = {
  id: resolverPath, filename: resolverPath, loaded: true, exports: {
    resolveRateCard: async (context) => {
      resolverCalls.push(context);
      if (resolverThrows) throw new Error('resolver exploded');
      return resolverResult;
    }
  }
};

const { handler } = require('../backend/functions/update-pending-booking');
const MODEL = require('../js/pending-edit-model');
const CONTRACT = require('../backend/functions/lib/vehicle-contract');

function get(id, { auth = 'Bearer tok' } = {}) {
  return handler({
    httpMethod: 'GET',
    headers: auth ? { authorization: auth } : {},
    queryStringParameters: id === undefined ? null : { id }
  });
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

(async () => {
  console.log('\nPR-A — hydration GET\n');

  // ============ auth and identity ============
  await check('GET with no Authorization header -> 401, and no booking read', async () => {
    reset();
    const r = await get(BID, { auth: null });
    assert.strictEqual(r.statusCode, 401);
    assert.strictEqual(capturedFilters, null, 'no booking was read');
    assert.strictEqual(resolverCalls.length, 0);
  });

  await check('an authenticated user with no customer row -> 403 (auth stage keeps its own body)', async () => {
    reset(); customer = null;
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(JSON.parse(r.body).error, 'Account profile incomplete');
    assert.strictEqual(resolverCalls.length, 0);
  });

  await check('a customer-lookup failure keeps the auth stage 500 body, not the hydration body', async () => {
    reset(); customerError = { code: 'db_error' };
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(JSON.parse(r.body).error, 'Could not verify account');
  });

  // ============ typed refusals, and the ORDER rule ============
  await check('a malformed id -> 400 with ZERO resolver calls and no booking read', async () => {
    reset();
    const r = await get('not-a-uuid');
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(capturedFilters, null);
    assert.strictEqual(resolverCalls.length, 0);
  });

  await check('a missing id parameter -> 400', async () => {
    reset();
    const r = await get(undefined);
    assert.strictEqual(r.statusCode, 400);
  });

  await check('the read is filtered by BOTH id and the authenticated customer', async () => {
    reset();
    await get(BID);
    assert.deepStrictEqual(capturedFilters, { id: BID, customer_id: 'cust-a' });
  });

  await check('a FOREIGN row answers 404 byte-identically to a missing row, with ZERO resolver calls', async () => {
    reset(); booking.customer_id_for_test = 'someone-else';
    const foreign = await get(BID);
    reset(); booking = null;
    const missing = await get(BID);
    assert.strictEqual(foreign.statusCode, 404);
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(foreign.body, missing.body, 'non-disclosure: the two are indistinguishable');
    assert.strictEqual(resolverCalls.length, 0);
  });

  await check('an assigned or non-pending ride -> 409 not_editable + currentStatus, ZERO resolver calls', async () => {
    reset({ status: 'confirmed', assigned_driver: 'driver-1' });
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 409);
    assert.deepStrictEqual(JSON.parse(r.body), { error: 'not_editable', currentStatus: 'confirmed' });
    assert.strictEqual(resolverCalls.length, 0, 'editability is decided before the resolver');
  });

  await check('a pending row that still carries a driver is NOT editable', async () => {
    reset({ status: 'pending', assigned_driver: 'driver-1' });
    assert.strictEqual((await get(BID)).statusCode, 409);
  });

  // ============ the one fixed failure body ============
  const FIXED = JSON.stringify({ error: 'Ride details unavailable' });

  await check('the owner-read database failure -> the fixed 500 body, no raw message', async () => {
    reset(); bookingReadError = { code: '42P01', message: 'relation "bookings" does not exist' };
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(r.body, FIXED);
    assert.ok(!r.body.includes('relation'), 'no provider text leaks');
  });

  await check('a resolver throw and a resolver {ok:false} both answer the SAME fixed 500', async () => {
    reset(); resolverThrows = true;
    const thrown = await get(BID);
    reset(); resolverResult = { ok: false };
    const refused = await get(BID);
    assert.strictEqual(thrown.statusCode, 500);
    assert.strictEqual(thrown.body, FIXED);
    assert.strictEqual(refused.body, FIXED);
  });

  const invalidRows = {
    'NULL booking_mode is never defaulted to dropoff': { booking_mode: null },
    'an out-of-band booking_mode': { booking_mode: 'sideways' },
    'an unparseable pickup time': { pickup_datetime: 'garbage' },
    'passengers above the writer ceiling': { passengers: 13 },
    'bags above the writer ceiling': { bags: 16 },
    'NULL passengers': { passengers: null },
    'a details_version below 1': { details_version: 0 },
    'a blank customer name': { customer_name: '   ' },
    'a PADDED stored string an edit would silently trim': { customer_name: ' Pat Passenger ' },
    'an over-long stored string an edit would silently truncate': { pickup_location: 'x'.repeat(501) },
    'a booker phone with no booker name': { booker_phone: '+1 305 555 0111' },
    'a booker name equal to the traveller name (the writer CLEAR command)':
      { booker_name: 'Pat Passenger', booker_phone: '+1 305 555 0111' },
    'a legacy vehicle_type alias an edit would silently canonicalize':
      { vehicle_type: 'escalade', vehicle_name: 'Cadillac Escalade' },
    'a legacy vehicle NAME alias': { vehicle_type: 'suv', vehicle_name: 'Black Escalade' },
    'a canonical route missing its airport code': { airport_code: null },
    'a canonical route missing its place id': { canonical_place_id: null },
    'a legacy_text route that still carries an identity':
      { route_authority: 'legacy_text', airport_code: 'MIA' },
    'an unknown route authority': { route_authority: 'something_else', airport_code: null, canonical_place_id: null },
    'a price beyond the endpoint ceiling': { price_cents: 100000 * 100 + 1, price: 100001 },
    'sub-millisecond stored precision a JS Date would truncate':
      { pickup_datetime: '2026-12-01T15:00:00.123456Z' },
    'a PRESENT-but-empty booker phone the writer would NULLIF away':
      { booker_name: 'Sam Booker', booker_phone: '' }
  };
  for (const [label, override] of Object.entries(invalidRows)) {
    await check(`invalid stored row -> fixed 500 with ZERO resolver calls: ${label}`, async () => {
      reset(override);
      const r = await get(BID);
      assert.strictEqual(r.statusCode, 500, 'must be 500, never 409 — the ride is not "not editable"');
      assert.strictEqual(r.body, FIXED);
      assert.strictEqual(resolverCalls.length, 0, 'stored-row validity is decided BEFORE the resolver');
    });
  }

  // ============ card compatibility ============
  const badCards = {
    'a swapped vehicle name': (c) => { c.vehicles.tesla.name = 'Cadillac Escalade'; },
    'WITHIN-ceiling per-vehicle drift (Tesla 4 -> 5)': (c) => { c.vehicles.tesla.capacity.passengers = 5; },
    'a capacity beyond the writer ceiling': (c) => { c.vehicles.sprinter.capacity.passengers = 13; },
    'a bag capacity beyond the writer ceiling': (c) => { c.vehicles.sprinter.capacity.bags = 16; },
    // The BOOKED key is the one that may never be missing: without it the DTO
    // cannot state what this booking already carries. A missing NON-selected
    // key is a legitimate partial card and is proved to succeed below.
    'a missing SELECTED key': (c) => { delete c.vehicles.tesla; },
    'an unknown exposed key': (c) => { c.vehicles.limo = { name: 'Limo', capacity: { passengers: 4, bags: 4 } }; },
    'an empty vehicles map': (c) => { c.vehicles = {}; },
    'an INHERITED canonical key rather than an own one':
      (c) => { c.vehicles = Object.create({ tesla: c.vehicles.tesla }); }
  };
  for (const [label, mutate] of Object.entries(badCards)) {
    await check(`malformed/incompatible card -> fixed 500: ${label}`, async () => {
      reset(); mutate(resolverResult.card);
      const r = await get(BID);
      assert.strictEqual(r.statusCode, 500);
      assert.strictEqual(r.body, FIXED);
    });
  }

  // A card may legitimately expose fewer than all three vehicles (the rate-card
  // validator refuses only an EMPTY map: ride-rate-card.js:203-205). Refusing
  // such a card would take an operator's booked ride hostage to an unrelated
  // vehicle being unavailable.
  await check('a PARTIAL card keeping the booked key -> 200 with only the exposed alternatives', async () => {
    reset(); delete resolverResult.card.vehicles.escalade;
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(r.body).vehicles, [
      { key: 'tesla', name: 'Tesla Model Y', passengerCapacity: 4, bagCapacity: 4 },
      { key: 'sprinter', name: 'Mercedes Sprinter', passengerCapacity: 12, bagCapacity: 15 }
    ]);
  });

  await check('a card exposing ONLY the booked vehicle still hydrates', async () => {
    reset();
    resolverResult.card.vehicles = { tesla: { name: 'Tesla Model Y', capacity: { passengers: 4, bags: 4 } } };
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(r.body).vehicles, [
      { key: 'tesla', name: 'Tesla Model Y', passengerCapacity: 4, bagCapacity: 4 }
    ]);
  });

  await check('projection order is the CONTRACT order, never the card key order', async () => {
    reset();
    const v = resolverResult.card.vehicles;
    resolverResult.card.vehicles = { sprinter: v.sprinter, escalade: v.escalade, tesla: v.tesla };
    const r = await get(BID);
    assert.deepStrictEqual(
      JSON.parse(r.body).vehicles.map((x) => x.key), ['tesla', 'escalade', 'sprinter']
    );
  });

  await check('a PARTIAL card is still capacity-checked on the keys it DOES expose', async () => {
    reset();
    delete resolverResult.card.vehicles.escalade;
    resolverResult.card.vehicles.sprinter.capacity.bags = 16;
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(r.body, FIXED);
  });

  await check('an INHERITED-property vehicle name never satisfies the VEHICLE_TYPE check', async () => {
    reset(); resolverResult.card.vehicles.tesla.name = 'constructor';
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(r.body, FIXED);
  });

  // ============ the DTO ============
  await check('millisecond precision that DOES round-trip is accepted unchanged', async () => {
    reset({ pickup_datetime: '2026-12-01T15:00:00.120Z' });
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).pickupAt, '2026-12-01T15:00:00.120Z');
  });

  await check('all THREE canonical stored pairs hydrate; only they do', async () => {
    for (const [type, name, key] of [
      ['sedan', 'Tesla Model Y', 'tesla'],
      ['suv', 'Cadillac Escalade', 'escalade'],
      ['sprinter', 'Mercedes Sprinter', 'sprinter']
    ]) {
      reset({ vehicle_type: type, vehicle_name: name, passengers: 1, bags: 0 });
      const r = await get(BID);
      assert.strictEqual(r.statusCode, 200, `${type}/${name} must hydrate`);
      assert.strictEqual(JSON.parse(r.body).vehicle.key, key);
    }
  });

  await check('WITHIN-ceiling BAG drift is caught too (Tesla 4 -> 5 bags)', async () => {
    reset(); resolverResult.card.vehicles.tesla.capacity.bags = 5;
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(r.body, FIXED);
  });

  await check('an owner gets 200 with the EXACT key inventory and private, no-store', async () => {
    reset();
    const r = await get(BID);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store');
    const dto = JSON.parse(r.body);
    assert.deepStrictEqual(Object.keys(dto).sort(), [
      'bags', 'bookedPriceCents', 'bookingId', 'booker', 'detailsVersion', 'optional',
      'passengers', 'pickupAt', 'route', 'status', 'traveler', 'tripCode', 'vehicle', 'vehicles'
    ].sort());
  });

  await check('the never-list is absent from the DTO', async () => {
    reset();
    const body = (await get(BID)).body;
    for (const forbidden of ['price_authority', 'assigned_driver', 'assignment_epoch',
      'customer_id', 'flight_number', 'promo_code', 'driver_payout', 'host_commission',
      'linkmia_commission', 'duration_minutes', 'quoteToken', 'routeMinutes']) {
      assert.ok(!body.includes(forbidden), `${forbidden} must never leave the endpoint`);
    }
  });

  await check('bookedPriceCents comes from stored cents; vehicle/vehicles come from the resolved card', async () => {
    reset();
    const dto = JSON.parse((await get(BID)).body);
    assert.strictEqual(dto.bookedPriceCents, 12000);
    assert.deepStrictEqual(dto.vehicle, { key: 'tesla', name: 'Tesla Model Y' });
    assert.deepStrictEqual(dto.vehicles, [
      { key: 'tesla', name: 'Tesla Model Y', passengerCapacity: 4, bagCapacity: 4 },
      { key: 'escalade', name: 'Cadillac Escalade', passengerCapacity: 7, bagCapacity: 8 },
      { key: 'sprinter', name: 'Mercedes Sprinter', passengerCapacity: 12, bagCapacity: 15 }
    ]);
  });

  await check('the resolver receives the SAME context shape the quote endpoint supplies', async () => {
    reset();
    await get(BID);
    assert.strictEqual(resolverCalls.length, 1);
    assert.deepStrictEqual(Object.keys(resolverCalls[0]).sort(), ['authUserId', 'customerId', 'pickupAtMs']);
    assert.strictEqual(resolverCalls[0].pickupAtMs, Date.parse('2026-12-01T15:00:00.000Z'));
  });

  await check('a canonical row is classified airport_transfer_v1 with its identity', async () => {
    reset();
    const dto = JSON.parse((await get(BID)).body);
    assert.deepStrictEqual(dto.route, {
      kind: 'airport_transfer_v1', authority: 'canonical', bookingMode: 'pickup',
      airportCode: 'MIA', canonicalPlaceId: 'ChIJEcHIDqKw2YgRZU-t3XHylv8',
      pickupLabel: 'MIA', dropoffLabel: '4441 Collins Ave'
    });
  });

  await check('a coherent legacy_text row is legacy_unclassified_v1 — labels only, never an airport transfer', async () => {
    reset({ route_authority: 'legacy_text', airport_code: null, canonical_place_id: null });
    const dto = JSON.parse((await get(BID)).body);
    assert.strictEqual(dto.route.kind, 'legacy_unclassified_v1');
    assert.strictEqual(dto.route.airportCode, null);
    assert.strictEqual(dto.route.canonicalPlaceId, null);
    assert.strictEqual(dto.route.pickupLabel, 'MIA');
  });

  await check('a stored booker pair is returned AS STORED; absent means null, never "self"', async () => {
    reset({ booker_name: 'Sam Booker', booker_phone: '+1 305 555 0199' });
    const withBooker = JSON.parse((await get(BID)).body);
    assert.deepStrictEqual(withBooker.booker, { name: 'Sam Booker', phone: '+1 305 555 0199' });
    reset();
    assert.strictEqual(JSON.parse((await get(BID)).body).booker, null);
  });

  await check('a booker name with no phone is preserved (phone null), not dropped', async () => {
    reset({ booker_name: 'Sam Booker' });
    assert.deepStrictEqual(JSON.parse((await get(BID)).body).booker, { name: 'Sam Booker', phone: null });
  });

  await check('the GET performs no writes and never calls an RPC', async () => {
    reset();
    assert.strictEqual((await get(BID)).statusCode, 200);
  });

  // T-3h belongs ONLY to the driver's departure window
  // (update-booking-status.js:88-100). A pending, unassigned ride stays
  // editable at EVERY hour, including inside and after that window — this pins
  // that a departure-window gate never leaks into passenger editing.
  await check('a pending unassigned ride hydrates at and INSIDE T-3h, and even past pickup', async () => {
    const now = Date.now();
    const cases = {
      'four hours out': now + 4 * 3600e3,
      'exactly three hours out': now + 3 * 3600e3,
      'ninety minutes out': now + 90 * 60e3,
      'five minutes out': now + 5 * 60e3,
      'already past pickup': now - 30 * 60e3
    };
    for (const [label, ms] of Object.entries(cases)) {
      reset({ pickup_datetime: new Date(ms).toISOString() });
      const r = await get(BID);
      assert.strictEqual(r.statusCode, 200, `${label} must still hydrate`);
      assert.strictEqual(JSON.parse(r.body).pickupAt, new Date(ms).toISOString());
    }
  });

  // ============ full-form round-trip closure (plan v8.6:1297-1306) ============
  // PR-B resubmits the WHOLE form for a time-only edit, so every field the
  // passenger did not touch travels out through this DTO and back into the
  // installed writer. If any one of them fails to round-trip exactly, an edit
  // that only moved the clock silently rewrites something else. This executes
  // that claim per canonical write-eligible fixture rather than asserting it.
  const roundTripFixtures = {
    'a Tesla with optionals and no booker': {},
    'an Escalade with a booker and blank optionals': {
      vehicle_type: 'suv', vehicle_name: 'Cadillac Escalade', passengers: 6, bags: 7,
      booker_name: 'Sam Booker', booker_phone: '+1 305 555 0199',
      notes: null, pickup_sign: null
    },
    'a Sprinter at full capacity with a dropoff-mode route': {
      vehicle_type: 'sprinter', vehicle_name: 'Mercedes Sprinter', passengers: 12, bags: 15,
      booking_mode: 'dropoff', pickup_location: '4441 Collins Ave', dropoff_location: 'FLL',
      airport_code: 'FLL', customer_email: null
    }
  };
  for (const [label, overrides] of Object.entries(roundTripFixtures)) {
    await check(`a time-only edit round-trips every untouched field: ${label}`, async () => {
      reset(overrides);
      const row = booking;
      const dto = JSON.parse((await get(BID)).body);

      // the route tuple
      assert.strictEqual(dto.route.pickupLabel, row.pickup_location);
      assert.strictEqual(dto.route.dropoffLabel, row.dropoff_location);
      assert.strictEqual(dto.route.bookingMode, row.booking_mode);
      assert.strictEqual(dto.route.airportCode, row.airport_code);
      assert.strictEqual(dto.route.canonicalPlaceId, row.canonical_place_id);
      // the pickup instant itself — byte-exact, so an untouched clock cannot drift
      assert.strictEqual(dto.pickupAt, row.pickup_datetime);
      // party size
      assert.strictEqual(dto.passengers, row.passengers);
      assert.strictEqual(dto.bags, row.bags);
      // the canonical vehicle PAIR the writer will persist, both halves
      assert.strictEqual(dto.vehicle.name, row.vehicle_name);
      assert.strictEqual(CONTRACT.VEHICLE_CONTRACT[dto.vehicle.key].category, row.vehicle_type);
      assert.strictEqual(CONTRACT.storedPairToKey(row.vehicle_type, row.vehicle_name), dto.vehicle.key);
      // traveler and booker
      assert.strictEqual(dto.traveler.name, row.customer_name);
      assert.strictEqual(dto.traveler.phone, row.customer_phone);
      assert.strictEqual(dto.traveler.email, row.customer_email);
      assert.strictEqual(dto.booker && dto.booker.name, row.booker_name);
      assert.strictEqual(dto.booker && dto.booker.phone, row.booker_phone);
      // omitted optionals stay omitted rather than becoming empty strings
      assert.strictEqual(dto.optional.notes, row.notes);
      assert.strictEqual(dto.optional.pickupSign, row.pickup_sign);
    });
  }

  await check('the round-trip carries NO pricing, version or duration field to resubmit', async () => {
    reset();
    const dto = JSON.parse((await get(BID)).body);
    // Price is re-quoted, the version is the CAS the browser echoes separately,
    // and duration is never persisted at all (R1 / migration 018).
    assert.ok(!('durationMinutes' in dto) && !('duration_minutes' in dto));
    assert.ok(!('priceCents' in dto) && !('price' in dto), 'only bookedPriceCents, as a display fact');
    assert.strictEqual(dto.bookedPriceCents, 12000);
    assert.strictEqual(dto.detailsVersion, 3);
  });

  // ============ the shared prologue ============
  await check('the shared header advertises GET, and PUT/DELETE still answer 405', async () => {
    reset();
    const r = await get(BID);
    assert.strictEqual(r.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      const other = await handler({ httpMethod: m, headers: {}, body: '' });
      assert.strictEqual(other.statusCode, 405, `${m} must still be refused`);
    }
  });

  await check('OPTIONS still answers 200 with an empty body', async () => {
    const r = await handler({ httpMethod: 'OPTIONS', headers: {} });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body, '');
  });

  await check('POST never invokes the hydration resolver', async () => {
    reset();
    await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '{}' });
    assert.strictEqual(resolverCalls.length, 0, 'the POST path must not touch the GET resolver');
  });

  // ============ PR-B activation ============
  // PR-A shipped these files dark and this suite pinned that darkness. PR-B
  // ends it deliberately, so the pins now assert the ACTIVATED state — the
  // model is loaded and precached, the cache rungs moved to PR-B's reserved
  // numbers, and the edit entry point hydrates.
  console.log('\nPR-B — activation pins\n');

  // Both PR-B modules are requested by indexMVP with a cache-busting query
  // (./js/<name>.js?v=N). The SW's cacheFirst/networkFirst fallbacks call
  // caches.match(request) WITHOUT ignoreSearch, so a precache entry can serve
  // that request ONLY when its URL — query included — is byte-identical to
  // the src the page asks for. Derive the expected literal FROM THE PAGE and
  // pin it exactly; the earlier basename pin accepted an unversioned entry
  // that was stored on install yet never served anything (reviewer P2).
  function assertPrecachedExactly(basename, idx, sw) {
    const m = idx.match(new RegExp(`<script src="\\./js/${basename}\\.js(\\?v=\\d+)?"`));
    assert.ok(m, `indexMVP must load ./js/${basename}.js`);
    const query = m[1] || '';
    const literal = `'/js/${basename}.js${query}'`;
    const listStart = sw.indexOf('const STATIC_CACHE_URLS = [');
    assert.ok(listStart >= 0, 'STATIC_CACHE_URLS is declared');
    const list = sw.slice(listStart, sw.indexOf('];', listStart));
    assert.ok(list.includes(literal), `${literal} must be in STATIC_CACHE_URLS — the EXACT URL the page requests`);
    if (query) {
      assert.ok(!sw.includes(`'/js/${basename}.js'`),
        `a stale unversioned '/js/${basename}.js' entry must not remain anywhere in the SW`);
    }
    const entries = sw.match(new RegExp(`'/js/${basename}\\.js(\\?[^']*)?'`, 'g')) || [];
    assert.deepStrictEqual(entries, [literal], `exactly one ${basename} precache entry, and it is the requested URL`);
    return literal;
  }

  await check('the model is loaded by the booking page and precached', async () => {
    const sw = fs.readFileSync(path.join(repoRoot, 'service-worker.js'), 'utf8');
    const idx = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
    assert.ok(/<script src="\.\/js\/pending-edit-model\.js/.test(idx), 'indexMVP must load it');
    assertPrecachedExactly('pending-edit-model', idx, sw);
    // It stays out of every OTHER page: nothing else has an editor.
    for (const page of ['trip.html', 'driver.html', 'index.html', 'login.html']) {
      const html = fs.readFileSync(path.join(repoRoot, page), 'utf8');
      assert.ok(!html.includes('pending-edit-model'), page + ' must not load it');
    }
  });

  await check('both cache rungs moved together to PR-B\'s pair, v1.3.30 / runtime-v7 (PR-T shipped 28/5; 29/6 retired unused)', async () => {
    const sw = fs.readFileSync(path.join(repoRoot, 'service-worker.js'), 'utf8');
    // Cache names only ever move FORWARD, and the runtime cache moves with the
    // static one because it can retain booking HTML.
    assert.ok(/const CACHE_NAME = 'linkmia-v1\.3\.30';/.test(sw), 'static rung');
    assert.ok(/const RUNTIME_CACHE = 'linkmia-runtime-v7';/.test(sw), 'runtime rung');
  });

  // Plan v8.6 §3D: cache names only ever move FORWARD, and every rung-moving
  // commit moves the complete literal-site inventory. This REPO-WIDE pin
  // reads the shipped pair from service-worker.js and refuses any file on
  // main that still names a burned rung as "next"/"reserved" or as a
  // rollback/revert target (the class Codex seq:204 found in a test message).
  await check('REPO-WIDE burned-rung pin: no file names a rung at or below the shipped pair as next/reserved or as a rollback target; the inventory sites name the §3D ladder exactly', async () => {
    const read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');
    const sw = read('service-worker.js');
    const cur = Number(/const CACHE_NAME = 'linkmia-v1\.3\.(\d+)';/.exec(sw)[1]);
    const curRt = Number(/const RUNTIME_CACHE = 'linkmia-runtime-v(\d+)';/.exec(sw)[1]);
    const list = (dir, ext) => fs.readdirSync(path.join(repoRoot, dir)).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);
    const files = ['CLAUDE.md', 'indexMVP.html', 'service-worker.js', '.github/workflows/tests.yml', ...list('tests', '.js'), ...list('docs', '.md')];
    const offenders = [];
    for (const f of files) {
      read(f).split('\n').forEach((line, i) => {
        // historical/ownership statements are not claims about the future
        if (/\b(belong|burned|historical|shipped|superseded|retired|deployed)\b/i.test(line)) return;
        const forward = /\b(next|rollback|revert)\b/i.test(line);
        const reserved = /\breserved\b/i.test(line);
        if (!forward && !reserved) return;
        for (const m of line.matchAll(/v1\.3\.(\d+)/g)) {
          const n = Number(m[1]);
          if ((forward && n <= cur) || (reserved && n < cur)) offenders.push(`${f}:${i + 1} names v1.3.${n} (shipped ${cur}): ${line.trim().slice(0, 120)}`);
        }
        for (const m of line.matchAll(/runtime[- ]?(?:cache )?v(\d+)\b/gi)) {
          const n = Number(m[1]);
          if ((forward && n <= curRt) || (reserved && n < curRt)) offenders.push(`${f}:${i + 1} names runtime v${n} (shipped ${curRt}): ${line.trim().slice(0, 120)}`);
        }
      });
    }
    assert.deepStrictEqual(offenders, [], 'burned rungs named as next/reserved/rollback targets');
    // the inventory sites (plan v8.6 §3D, [v6]/[v8.5]) name the ladder exactly
    const act = read('docs/BROWSER-FLAG-ACTIVATION.md');
    assert.ok(act.includes('| Browser-flag rollback (reserved)                | `linkmia-v1.3.32` | `linkmia-runtime-v9` |'), 'activation table: browser-flag rollback rung');
    assert.ok(act.includes("`CACHE_NAME` → `'linkmia-v1.3.32'`") && act.includes("`RUNTIME_CACHE` → `'linkmia-runtime-v9'`"), 'activation rollback steps');
    const r1 = read('docs/R1-MIGRATION-RUNBOOK.md');
    assert.ok(r1.includes('SW v1.3.32 + runtime cache v9') && r1.includes('`linkmia-v1.3.33` + `linkmia-runtime-v10`'), 'R1 runbook steps 1 and 2');
    assert.ok(read('CLAUDE.md').includes('v1.3.32 + runtime v9'), 'CLAUDE.md activation entry');
    assert.ok(read('indexMVP.html').includes('bump CACHE_NAME to v1.3.32'), 'flag-site comment');
    assert.ok(read('tests/quote-browser-integration.test.js').includes('SW v1.3.32 + runtime v9'), 'the assertion message names the browser-flag rung');
    for (const rung of ['v1.3.28 / runtime-v5', 'v1.3.29 / runtime-v6', 'v1.3.30 / runtime-v7', 'v1.3.31 / runtime-v8', 'v1.3.32 / runtime-v9', 'v1.3.33 / runtime-v10']) {
      assert.ok(sw.includes(rung), `SW ladder comment lists ${rung}`);
    }
  });

  await check('the edit entry point hydrates and no longer demands re-entry', async () => {
    const idx = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
    const sw = fs.readFileSync(path.join(repoRoot, 'service-worker.js'), 'utf8');
    assert.ok(idx.includes('update-pending-booking?id='), 'wires the hydration GET');
    assert.ok(idx.includes('this.editCard().open(dto'), 'hands the snapshot to the review card');
    assertPrecachedExactly('pending-edit-card', idx, sw); // the card module is precached too
    assert.ok(!idx.includes('Re-enter your trip details'),
      'the re-enter-everything instruction is gone — that was the defect');
  });

  await check('EXECUTED: the real fetch fallback serves the page\'s versioned request from the precache — the pre-fix unversioned entry never could', async () => {
    const idx = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
    const swSource = fs.readFileSync(path.join(repoRoot, 'service-worker.js'), 'utf8');
    const ORIGIN = 'https://linkmia.com';
    // Drive the real worker: run its install handler against a fake Cache
    // Storage keyed on the FULL URL (the Cache API's default — no
    // ignoreSearch), take the network away, then ask for the page's src.
    const driveWorker = async (source, pathWithQuery) => {
      const listeners = {};
      const stores = new Map();
      const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
      const context = vm.createContext({
        self: {
          location: { origin: ORIGIN },
          clients: { claim: async () => {} },
          skipWaiting: async () => {},
          addEventListener(type, fn) { listeners[type] = fn; }
        },
        caches: {
          open: async (name) => {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name);
            return {
              add: async (url) => { store.set(keyOf(url), { precached: url }); },
              put: async (req, res) => { store.set(keyOf(req), res); },
              delete: async (req) => store.delete(keyOf(req))
            };
          },
          keys: async () => [...stores.keys()],
          match: async (req) => {
            const key = keyOf(req);
            for (const store of stores.values()) if (store.has(key)) return store.get(key);
            return null;
          },
          delete: async (name) => stores.delete(name)
        },
        fetch: async () => { throw new Error('offline'); },
        URL,
        Response: class FakeResponse { constructor(body, init) { this.body = body; this.status = init && init.status; } },
        console: { log() {}, warn() {}, error() {} }
      });
      vm.runInContext(source, context, { filename: 'service-worker.js' });
      let installing = null;
      listeners.install({ waitUntil(p) { installing = p; } });
      await installing;
      let responding = null;
      listeners.fetch({
        request: { method: 'GET', url: `${ORIGIN}${pathWithQuery}`, mode: 'same-origin' },
        respondWith(p) { responding = p; }
      });
      assert.ok(responding, 'the worker must intercept a same-origin script request');
      return responding;
    };
    for (const basename of ['pending-edit-model', 'pending-edit-card']) {
      const m = idx.match(new RegExp(`<script src="\\./js/${basename}\\.js(\\?v=\\d+)?"`));
      assert.ok(m && m[1], `${basename} is requested with a cache-busting query`);
      const requested = `/js/${basename}.js${m[1]}`;
      // Fixed worker: the precache answers the exact request with the network down.
      assert.deepStrictEqual(await driveWorker(swSource, requested), { precached: requested },
        `${requested} must be served from the precache offline`);
      // Pre-fix worker (identical source, the query stripped from the list
      // entry): the entry is stored on install, yet the request falls all the
      // way through to the 408 error response — the P2 defect, reproduced.
      const preFix = swSource.replace(`'${requested}'`, `'/js/${basename}.js'`);
      assert.notStrictEqual(preFix, swSource, 'the pre-fix source differs only in the list entry');
      const miss = await driveWorker(preFix, requested);
      assert.strictEqual(miss && miss.status, 408, 'an unversioned precache entry never serves the versioned request');
    }
  });

  // ============ the dark model ============
  console.log('\nPR-A — snapshot/draft model and route adapters\n');

  const DTO = {
    bookingId: BID, tripCode: 'LM-HYDR', detailsVersion: 3, status: 'pending',
    route: {
      kind: 'airport_transfer_v1', authority: 'canonical', bookingMode: 'pickup',
      airportCode: 'MIA', canonicalPlaceId: 'place-1',
      pickupLabel: 'MIA', dropoffLabel: '4441 Collins Ave'
    },
    pickupAt: '2026-12-01T15:00:00.000Z', passengers: 2, bags: 4, bookedPriceCents: 12000,
    vehicle: { key: 'tesla', name: 'Tesla Model Y' },
    vehicles: [{ key: 'tesla', name: 'Tesla Model Y', passengerCapacity: 4, bagCapacity: 4 }],
    traveler: { name: 'Pat', phone: '+1 305 555 0100', email: null },
    booker: null, optional: { notes: null, pickupSign: null }
  };

  await check('the snapshot is DEEP frozen and the draft is independently deep-cloned', async () => {
    const snap = MODEL.createSnapshot(DTO);
    const draft = MODEL.createDraft(snap);
    assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.route) && Object.isFrozen(snap.traveler));
    draft.route.airportCode = 'FLL';
    draft.traveler.name = 'Changed';
    draft.vehicles[0].passengerCapacity = 99;
    assert.strictEqual(snap.route.airportCode, 'MIA', 'nested draft mutation cannot reach the snapshot');
    assert.strictEqual(snap.traveler.name, 'Pat');
    assert.strictEqual(snap.vehicles[0].passengerCapacity, 4);
  });

  await check('isolation holds across EVERY nested branch of the snapshot', async () => {
    const rich = JSON.parse(JSON.stringify(DTO));
    rich.route.addressCoordinates = { lat: 25.7, lng: -80.2 };
    rich.route.addressAttributions = [{ segments: [{ text: 'Provider', href: 'https://x' }] }];
    rich.booker = { name: 'Sam', phone: '+1 305 555 0199' };
    rich.optional = { notes: 'note', pickupSign: 'SIGN' };
    const snap = MODEL.createSnapshot(rich);
    const draft = MODEL.createDraft(snap);
    draft.route.addressCoordinates.lat = 0;
    draft.route.addressAttributions[0].segments[0].text = 'Tampered';
    draft.booker.name = 'Changed';
    draft.optional.notes = 'Changed';
    draft.vehicle.key = 'sprinter';
    assert.strictEqual(snap.route.addressCoordinates.lat, 25.7);
    assert.strictEqual(snap.route.addressAttributions[0].segments[0].text, 'Provider');
    assert.strictEqual(snap.booker.name, 'Sam');
    assert.strictEqual(snap.optional.notes, 'note');
    assert.strictEqual(snap.vehicle.key, 'tesla');
  });

  await check('hydration COMPLETES the route tuple with null coordinates and no attributions', async () => {
    const snap = MODEL.createSnapshot(DTO);
    assert.strictEqual(snap.route.addressCoordinates, null);
    assert.deepStrictEqual(snap.route.addressAttributions, []);
  });

  await check('an INHERITED bundle is refused: the six operations must be OWN methods', async () => {
    const inherited = Object.create(MODEL.ROUTE_ADAPTERS.airport_transfer_v1);
    for (const op of MODEL.ADAPTER_OPS) {
      assert.strictEqual(typeof inherited[op], 'function', 'inherited methods are reachable...');
      assert.ok(!Object.prototype.hasOwnProperty.call(inherited, op), '...but not OWN');
    }
    assert.ok(Object.isFrozen(MODEL.ROUTE_ADAPTERS), 'registry frozen');
    assert.ok(Object.isFrozen(MODEL.ADAPTER_OPS), 'operation list frozen');
    assert.ok(Object.isFrozen(MODEL.ROUTE_ADAPTERS.airport_transfer_v1), 'bundle frozen');
    assert.throws(() => { 'use strict'; MODEL.ROUTE_ADAPTERS.fake = {}; });
  });

  await check('completeness admits ONLY the three supported airports', async () => {
    const a = MODEL.adapterFor('airport_transfer_v1');
    for (const code of ['MIA', 'FLL', 'PBI']) {
      const r = a.fromRouteDraft({ mode: 'pickup', airport: code, address: { placeId: 'p', label: 'L' } });
      assert.ok(r && a.routeIsComplete(r), `${code} must be sellable`);
    }
    for (const code of ['ZZZ', 'JFK', '', 'mia']) {
      assert.strictEqual(
        a.fromRouteDraft({ mode: 'pickup', airport: code, address: { placeId: 'p', label: 'L' } }),
        null, `${code} must not become a complete route`);
    }
  });

  await check('a legacy draft converts up through fromRouteDraft on a COMPLETE fresh selection', async () => {
    const legacy = MODEL.adapterFor('legacy_unclassified_v1');
    const converted = legacy.fromRouteDraft({
      mode: 'dropoff', airport: 'FLL', address: { placeId: 'p-9', label: 'Hotel' }
    });
    assert.strictEqual(converted.kind, 'airport_transfer_v1');
    assert.strictEqual(converted.pickupLabel, 'Hotel');
    assert.strictEqual(converted.dropoffLabel, 'FLL');
    assert.strictEqual(legacy.fromRouteDraft({ mode: 'dropoff', airport: 'FLL', address: {} }), null,
      'an INCOMPLETE selection converts nothing');
  });

  await check('legacy canonical adoption FAILS CLOSED rather than returning a route', async () => {
    assert.strictEqual(
      MODEL.adapterFor('legacy_unclassified_v1').adoptCanonicalPlaceId({}, { placeId: 'x' }), null);
  });

  await check('a replacement id that canonicalizes BACK to the snapshot collapses to no route change', async () => {
    const snap = MODEL.createSnapshot(DTO);
    const draft = MODEL.createDraft(snap);
    const a = MODEL.adapterFor('airport_transfer_v1');
    // the passenger re-picks and Google answers with a replacement raw id
    draft.route = a.fromRouteDraft({ mode: 'pickup', airport: 'MIA', address: { placeId: 'replacement-raw', label: '4441 Collins Ave' } });
    assert.ok(MODEL.compareDraft(snap, draft).changed.includes('route'), 'reads as a change first');
    // the server echo canonicalizes it back to the snapshot identity
    draft.route = a.adoptCanonicalPlaceId(draft.route, { placeId: 'place-1' });
    assert.ok(!MODEL.compareDraft(snap, draft).changed.includes('route'), 'then collapses');
  });

  // Labels are DELIBERATELY excluded from route identity (plan:557-586,
  // 1504-1507): a re-pick that returns the same place with a transient
  // display label must not read as a route change, or a time-only edit would
  // full-replace a stored label the comparator called unchanged.
  await check('the SAME place id with a different transient label is NOT a route change', async () => {
    const snap = MODEL.createSnapshot(DTO);
    const draft = MODEL.createDraft(snap);
    const a = MODEL.adapterFor('airport_transfer_v1');
    draft.route = a.fromRouteDraft({
      mode: 'pickup', airport: 'MIA',
      address: { placeId: 'place-1', label: '4441 Collins Avenue, Miami Beach, FL 33140, USA' }
    });
    assert.notStrictEqual(draft.route.dropoffLabel, snap.route.dropoffLabel, 'the label really did differ');
    assert.ok(!MODEL.compareDraft(snap, draft).changed.includes('route'));
  });

  await check('the traveler key distinguishes an ABSENT booker from a present blank one', async () => {
    const t = { name: 'Pat', phone: '+1', email: null };
    assert.notStrictEqual(MODEL.travelerKey(t, null), MODEL.travelerKey(t, { name: '', phone: '' }));
    assert.strictEqual(MODEL.travelerKey(t, null), MODEL.travelerKey(t, null));
  });

  // These are the exact inputs that collided under the delimiter-joined
  // encoding this file used before round 2 — the defect that also put three
  // raw NUL bytes into the source. Serialization is JSON now, so the whole
  // class is gone; these pin it staying gone.
  await check('cross-field identity COLLISIONS are impossible for traveler and booker', async () => {
    const key = MODEL.travelerKey;
    for (const sep of ['\u0000', '|', ':', ',', '"']) {
      assert.notStrictEqual(
        key({ name: `a${sep}b`, phone: 'c', email: null }, null),
        key({ name: 'a', phone: `b${sep}c`, email: null }, null),
        `traveler name/phone must not merge across ${JSON.stringify(sep)}`);
      assert.notStrictEqual(
        key({ name: 'a', phone: 'b', email: `c${sep}d` }, null),
        key({ name: 'a', phone: 'b', email: 'c' }, { name: `d`, phone: '' }),
        `traveler email must not merge into the booker across ${JSON.stringify(sep)}`);
    }
  });

  await check('cross-field identity COLLISIONS are impossible for the legacy route labels', async () => {
    const id = MODEL.adapterFor('legacy_unclassified_v1').routeIdentity;
    for (const sep of ['\u0000', '|', ':', ',', '"']) {
      assert.notStrictEqual(
        id({ bookingMode: 'pickup', pickupLabel: `a${sep}b`, dropoffLabel: 'c' }),
        id({ bookingMode: 'pickup', pickupLabel: 'a', dropoffLabel: `b${sep}c` }),
        `the two stored labels must not merge across ${JSON.stringify(sep)}`);
    }
  });

  await check('the SOURCES are text: zero NUL bytes, and identities never emit one', async () => {
    // This suite is checked alongside the model deliberately: the raw-NUL
    // defect appeared TWICE while authoring PR-A, the second time in this very
    // file. A byte-level tripwire is the only thing that catches it, because a
    // NUL is a legal string separator at runtime — every behavioural test
    // passes while Git and `file` see the source as binary.
    for (const rel of ['js/pending-edit-model.js', 'tests/pending-edit-hydration.test.js',
      'backend/functions/lib/vehicle-contract.js', 'backend/functions/update-pending-booking.js']) {
      const raw = fs.readFileSync(path.join(repoRoot, rel));
      assert.strictEqual(raw.indexOf(0x00), -1, rel + ' contains a raw NUL — Git would treat it as binary');
    }
    // A NUL arriving as DATA must be ESCAPED by the serializer, never passed through.
    const withNul = MODEL.travelerKey({ name: 'a\u0000b', phone: 'c', email: null }, null);
    assert.strictEqual(Buffer.from(withNul, 'utf8').indexOf(0x00), -1, 'JSON escapes it');
  });

  await check('a booker-only change is detected', async () => {
    const snap = MODEL.createSnapshot({ ...DTO, booker: { name: 'Sam', phone: '+1 305 555 0199' } });
    const draft = MODEL.createDraft(snap);
    draft.booker = null;
    assert.ok(MODEL.compareDraft(snap, draft).changed.includes('traveler'));
  });

  await check('adapter dispatch is OWN-property: prototype keys resolve to nothing', async () => {
    for (const hostile of ['__proto__', 'constructor', 'toString', 'valueOf', 'isPrototypeOf', 'hasOwnProperty']) {
      assert.strictEqual(MODEL.adapterFor(hostile), null, `${hostile} must not resolve to an adapter`);
    }
    assert.strictEqual(MODEL.adapterFor('airport_transfer_v1').kind, 'airport_transfer_v1');
    assert.strictEqual(MODEL.adapterFor('legacy_unclassified_v1').kind, 'legacy_unclassified_v1');
  });

  await check('every registered kind implements the COMPLETE six-operation bundle', async () => {
    for (const kind of Object.keys(MODEL.ROUTE_ADAPTERS)) {
      const a = MODEL.adapterFor(kind);
      assert.ok(a, `${kind} must resolve`);
      for (const op of MODEL.ADAPTER_OPS) {
        assert.strictEqual(typeof a[op], 'function', `${kind} is missing ${op}`);
      }
    }
  });

  await check('projectRoute maps pickup to airport-first and dropoff to address-first', async () => {
    const a = MODEL.adapterFor('airport_transfer_v1');
    const pickup = a.projectRoute(DTO.route);
    assert.strictEqual(pickup.origin.label, 'MIA');
    assert.strictEqual(pickup.destination.label, '4441 Collins Ave');
    const dropoffRoute = { ...DTO.route, bookingMode: 'dropoff', pickupLabel: '4441 Collins Ave', dropoffLabel: 'MIA' };
    const dropoff = a.projectRoute(dropoffRoute);
    assert.strictEqual(dropoff.origin.label, '4441 Collins Ave');
    assert.strictEqual(dropoff.destination.label, 'MIA');
  });

  await check('projectRoute projects the STORED airport-side label byte for byte (the code only when the tuple carries none); fromRouteDraft honours the host\'s airportLabel and falls back to the code', async () => {
    const a = MODEL.adapterFor('airport_transfer_v1');
    const stored = { ...DTO.route, pickupLabel: 'Miami International' };
    assert.strictEqual(a.projectRoute(stored).origin.label, 'Miami International', 'pickup mode: origin = stored airport label');
    assert.strictEqual(a.projectRoute(stored).destination.label, '4441 Collins Ave');
    const storedDrop = { ...DTO.route, bookingMode: 'dropoff', airportCode: 'PBI', pickupLabel: '4441 Collins Ave', dropoffLabel: ' Palm Beach ' };
    assert.strictEqual(a.projectRoute(storedDrop).destination.label, ' Palm Beach ', 'dropoff mode: destination = stored label, verbatim and untrimmed');
    assert.strictEqual(a.projectRoute(storedDrop).origin.label, '4441 Collins Ave');
    assert.strictEqual(a.projectRoute({ ...DTO.route, pickupLabel: '' }).origin.label, 'MIA', 'the code is only the fallback');
    const withLabel = a.fromRouteDraft({ mode: 'pickup', airport: 'FLL', airportLabel: 'Fort Lauderdale', address: { placeId: 'p', label: 'L' } });
    assert.strictEqual(withLabel.pickupLabel, 'Fort Lauderdale');
    assert.strictEqual(withLabel.dropoffLabel, 'L');
    const dropLabel = a.fromRouteDraft({ mode: 'dropoff', airport: 'PBI', airportLabel: 'Palm Beach', address: { placeId: 'p', label: 'L' } });
    assert.strictEqual(dropLabel.pickupLabel, 'L');
    assert.strictEqual(dropLabel.dropoffLabel, 'Palm Beach');
    assert.strictEqual(a.fromRouteDraft({ mode: 'pickup', airport: 'FLL', airportLabel: '   ', address: { placeId: 'p', label: 'L' } }).pickupLabel, 'FLL', 'a blank label falls back to the code');
    assert.strictEqual(a.fromRouteDraft({ mode: 'pickup', airport: 'FLL', address: { placeId: 'p', label: 'L' } }).pickupLabel, 'FLL', 'no label → the code');
    assert.strictEqual(a.routeIdentity(withLabel), a.routeIdentity({ ...withLabel, pickupLabel: 'FLL' }), 'labels stay OUT of identity');
  });

  await check('the legacy kind projects labels, is ALWAYS incomplete, and can never be quoted', async () => {
    const legacy = {
      kind: 'legacy_unclassified_v1', authority: 'legacy_text', bookingMode: 'pickup',
      airportCode: null, canonicalPlaceId: null, pickupLabel: 'Old A', dropoffLabel: 'Old B'
    };
    const a = MODEL.adapterFor('legacy_unclassified_v1');
    assert.deepStrictEqual(
      [a.projectRoute(legacy).origin.label, a.projectRoute(legacy).destination.label],
      ['Old A', 'Old B']
    );
    assert.strictEqual(a.routeIsComplete(legacy), false, 'never complete, whatever it contains');
    assert.strictEqual(a.toQuoteIntent(legacy), null, 'never quotable');
    assert.strictEqual(a.adoptCanonicalPlaceId({}, { placeId: 'x' }), null, 'adoption fails closed');
  });

  await check('a legacy snapshot yields NO quote and a disabled Save', async () => {
    const legacyDto = { ...DTO, route: {
      kind: 'legacy_unclassified_v1', authority: 'legacy_text', bookingMode: 'pickup',
      airportCode: null, canonicalPlaceId: null, pickupLabel: 'Old A', dropoffLabel: 'Old B' } };
    const snap = MODEL.createSnapshot(legacyDto);
    const draft = MODEL.createDraft(snap);
    draft.pickupAt = '2026-12-02T15:00:00.000Z';
    const cmp = MODEL.compareDraft(snap, draft);
    assert.ok(cmp.changed.includes('pickupAt'), 'the time change is still detected');
    assert.strictEqual(cmp.isComplete, false);
    assert.strictEqual(cmp.needsQuote, false, 'an incomplete route must buy nothing');
  });

  await check('identity is KIND-NAMESPACED, so converting a legacy route reads as a real change', async () => {
    const legacyDto = { ...DTO, route: {
      kind: 'legacy_unclassified_v1', authority: 'legacy_text', bookingMode: 'pickup',
      airportCode: null, canonicalPlaceId: null, pickupLabel: 'MIA', dropoffLabel: '4441 Collins Ave' } };
    const snap = MODEL.createSnapshot(legacyDto);
    const draft = MODEL.createDraft(snap);
    draft.route = MODEL.adapterFor('airport_transfer_v1').fromRouteDraft({
      mode: 'pickup', airport: 'MIA', address: { placeId: 'place-1', label: '4441 Collins Ave' }
    });
    const cmp = MODEL.compareDraft(snap, draft);
    assert.ok(cmp.changed.includes('route'), 'the conversion is a genuine route change, never silent');
    assert.strictEqual(cmp.isComplete, true);
    assert.strictEqual(cmp.needsQuote, true);
  });

  await check('an unchanged draft reports no changes and needs no quote', async () => {
    const snap = MODEL.createSnapshot(DTO);
    const cmp = MODEL.compareDraft(snap, MODEL.createDraft(snap));
    assert.deepStrictEqual(cmp.changed, []);
    assert.strictEqual(cmp.needsQuote, false);
  });

  await check('adoptCanonicalPlaceId replaces the id and leaves everything else alone', async () => {
    const a = MODEL.adapterFor('airport_transfer_v1');
    const adopted = a.adoptCanonicalPlaceId(DTO.route, { placeId: 'canonical-2' });
    assert.strictEqual(adopted.canonicalPlaceId, 'canonical-2');
    assert.strictEqual(adopted.pickupLabel, DTO.route.pickupLabel);
    assert.strictEqual(DTO.route.canonicalPlaceId, 'place-1', 'the input is not mutated');
    assert.strictEqual(a.adoptCanonicalPlaceId(DTO.route, null), DTO.route, 'no echo, no change');
  });

  await check('toQuoteIntent yields exactly the three route fields the quote request is built from', async () => {
    const intent = MODEL.adapterFor('airport_transfer_v1').toQuoteIntent(DTO.route);
    assert.deepStrictEqual(intent, { mode: 'pickup', airportCode: 'MIA', placeId: 'place-1' });
  });

  await check('the Miami controller omits a spring-forward gap and exposes BOTH fall-back instants', async () => {
    // 2026-03-08 02:30 America/New_York never happens; 2026-11-01 01:30 happens twice.
    const gap = MODEL.resolveMiamiWallClock({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 });
    assert.strictEqual(gap.length, 0, 'a nonexistent local time offers nothing');
    const fold = MODEL.resolveMiamiWallClock({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    assert.strictEqual(fold.length, 2, 'the repeated hour is offered once per instant');
    assert.deepStrictEqual(fold.map((f) => f.label), ['EDT', 'EST']);
    assert.notStrictEqual(fold[0].iso, fold[1].iso);
  });

  await check('the controller is root-scoped: it uses the elements handed to it, never a global id', async () => {
    const els = { dateInput: { value: '' } };
    const c = MODEL.createEditTimeController(els);
    c.setFromSnapshot('2026-12-01T15:00:00.000Z');
    assert.strictEqual(els.dateInput.value, '2026-12-01');
    // Miami wall clock, never the UTC date: 04:30Z on Dec 25 is Dec 24 here.
    const els2 = { dateInput: { value: '' }, timeInput: { value: '' } };
    const c2 = MODEL.createEditTimeController(els2);
    c2.setFromSnapshot('2026-12-25T04:30:00Z');
    assert.strictEqual(els2.dateInput.value, '2026-12-24');
    assert.strictEqual(els2.timeInput.value, '23:30');
    let picked = null;
    const c3 = MODEL.createEditTimeController(els2, { onPick: (iso) => { picked = iso; } });
    assert.strictEqual(c3.pick('2026-12-25T04:30:00Z'), '2026-12-25T04:30:00.000Z');
    assert.strictEqual(picked, '2026-12-25T04:30:00.000Z');
    assert.strictEqual(c3.selected(), '2026-12-25T04:30:00.000Z');
    const src = fs.readFileSync(path.join(repoRoot, 'js/pending-edit-model.js'), 'utf8');
    assert.ok(!/getElementById|querySelector/.test(src), 'the model never reaches for the document');
  });

  // The PUBLIC controller path, not the helper behind it: PR-B calls
  // candidates() and hands one of its results back to pick().
  await check('controller.candidates returns RFC3339 instants that survive a pick round-trip', async () => {
    const els = { dateInput: { value: '' }, timeInput: { value: '' } };
    const c = MODEL.createEditTimeController(els);
    const wall = { year: 2026, month: 12, day: 24, hour: 23, minute: 30 };
    const cands = c.candidates(wall);
    assert.strictEqual(cands.length, 1, 'an ordinary winter minute is unambiguous');
    assert.match(cands[0].iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'RFC3339, UTC offset explicit');
    assert.strictEqual(cands[0].label, 'EST');
    // picking it back reproduces the SAME Miami wall clock the passenger asked for
    assert.strictEqual(c.pick(cands[0].iso), cands[0].iso);
    assert.strictEqual(els.dateInput.value, '2026-12-24');
    assert.strictEqual(els.timeInput.value, '23:30');
    const parts = c.miamiParts(c.selected());
    assert.strictEqual(parts.year, wall.year);
    assert.strictEqual(parts.month, wall.month);
    assert.strictEqual(parts.day, wall.day);
    assert.strictEqual(parts.hour, wall.hour);
    assert.strictEqual(parts.minute, wall.minute);
    // and the summer side carries the other offset label
    const summer = c.candidates({ year: 2026, month: 7, day: 4, hour: 14, minute: 30 });
    assert.strictEqual(summer.length, 1);
    assert.strictEqual(summer[0].label, 'EDT');
    assert.strictEqual(summer[0].iso, '2026-07-04T18:30:00.000Z');
  });

  await check('Miami formatting is zoned regardless of the device clock', async () => {
    const saved = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      assert.match(MODEL.formatMiami('2026-07-04T18:30:00Z'), /Jul 4, 2:30 PM EDT/);
      assert.match(MODEL.formatMiami('2026-12-25T04:30:00Z'), /Dec 24, 11:30 PM EST/);
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  });

  // ============ the shared contract ============
  await check('the vehicle contract is frozen root AND nested, and refuses legacy pairs', async () => {
    assert.ok(Object.isFrozen(CONTRACT.VEHICLE_CONTRACT));
    // EVERY canonical record, not just the first one a reader happens to check.
    for (const key of CONTRACT.VEHICLE_KEYS) {
      assert.ok(Object.isFrozen(CONTRACT.VEHICLE_CONTRACT[key]), `${key} record must be frozen`);
      assert.throws(() => { 'use strict'; CONTRACT.VEHICLE_CONTRACT[key].passengers = 9; },
        `${key} capacity must not be writable`);
      assert.throws(() => { 'use strict'; CONTRACT.VEHICLE_CONTRACT[key].name = 'Other'; },
        `${key} name must not be writable`);
      const cat = CONTRACT.VEHICLE_CONTRACT[key].category;
      assert.ok(Object.isFrozen(CONTRACT.CATEGORY_CONTRACT[cat]), `${cat} projection must be frozen`);
    }
    assert.ok(Object.isFrozen(CONTRACT.CATEGORY_CONTRACT));
    assert.ok(Object.isFrozen(CONTRACT.VEHICLE_KEYS));
    assert.ok(Object.isFrozen(CONTRACT.WRITER_CEILINGS));
    assert.strictEqual(CONTRACT.storedPairToKey('sedan', 'Tesla Model Y'), 'tesla');
    assert.strictEqual(CONTRACT.storedPairToKey('escalade', 'Cadillac Escalade'), null, 'legacy alias never round-trips');
    assert.strictEqual(CONTRACT.storedPairToKey('suv', 'Black Escalade'), null);
    assert.strictEqual(CONTRACT.ownVehicle('constructor'), null);
  });

  console.log(`\n  ${failed ? `${failed} CHECK(S) FAILED` : `ALL ${passed} CHECKS PASS`}\n`);
  process.exit(failed ? 1 : 0);
})();
