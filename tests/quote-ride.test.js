// PR 3C-2B1 — dark quote service: trusted-intent boundary, dark-phase
// allowlist, provider discipline (field mask / departureTime rules /
// strict parsing / one attempt), quantization parity with the browser
// formula, signed-token contract with key rotation, telemetry
// sanitization, and the kill switch. All provider behavior runs
// against mocks — the real keys are rollout gates.
//
// Run: node tests/quote-ride.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.GOOGLE_ROUTES_API_KEY = 'routes-key-test';
process.env.GOOGLE_PLACES_SERVER_API_KEY = 'places-key-test';
// Signing secrets must clear the resolver's 32-byte floor: a present
// but weak secret is NOT a configured key (resolveSigningKeys).
const CURRENT_SECRET = 'current-secret-0123456789abcdef01234567';
const PREVIOUS_SECRET = 'previous-secret-0123456789abcdef0123456';
process.env.QUOTE_SIGNING_CURRENT_ID = 'k-2026-08';
process.env.QUOTE_SIGNING_CURRENT_SECRET = CURRENT_SECRET;
process.env.QUOTE_SIGNING_PREVIOUS_ID = 'k-2026-07';
process.env.QUOTE_SIGNING_PREVIOUS_SECRET = PREVIOUS_SECRET;
process.env.QUOTE_SHADOW_ALLOWLIST = '11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222';
delete process.env.QUOTE_SERVICE_DISABLED;

const repoRoot = path.resolve(__dirname, '..');

const TOKENS = {
  'tok-andres': { id: '11111111-1111-4111-8111-111111111111' },
  'tok-passenger': { id: 'auth-passenger' } // signed in, NOT allowlisted
};
const CUSTOMERS = {
  '11111111-1111-4111-8111-111111111111': { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  'auth-passenger': { id: 'cust-passenger' }
};

const ADDRESS_PLACE_ID = 'ChIJTESTaddressPLACEid1234';
const EXPECTED_AIRPORTS = Object.freeze({
  MIA: Object.freeze({
    placeId: 'ChIJLSeUuFi32YgRgpwdRDtxYkg',
    formattedAddress: 'Miami International Airport (MIA), 2100 NW 42nd Ave, Miami, FL 33142'
  }),
  FLL: Object.freeze({
    placeId: 'ChIJhTflH4aq2YgR9m9hZLFOmoo',
    formattedAddress: 'Fort Lauderdale-Hollywood International Airport (FLL), 100 Terminal Dr, Fort Lauderdale, FL 33315'
  }),
  PBI: Object.freeze({
    placeId: 'ChIJCboyqy3W2IgRdLKci4qxznw',
    formattedAddress: 'Palm Beach International Airport (PBI), 1000 James L Turnage Blvd, West Palm Beach, FL 33406'
  })
});
const PREVIOUS_AIRPORT_PLACE_IDS = Object.freeze([
  'ChIJQ2DP_4u02YgRPNlKgMr9gBE',
  'ChIJ9frI5Hq42YgR4bCqA7w1_Ww',
  'ChIJd_cFKRUu2YgR6Me7ie5YMO0'
]);
const MIA_PLACE_ID = EXPECTED_AIRPORTS.MIA.placeId;

// ---------- mock state ----------
const state = {};
function resetState() {
  state.authOutage = false;
  state.customerError = null;
  state.placesCalls = [];
  state.routesCalls = [];
  state.placesResponse = () => ({
    ok: true, status: 200,
    json: async () => ({ id: ADDRESS_PLACE_ID, formattedAddress: '123 Test St, Miami Beach, FL 33139' })
  });
  state.routesResponse = () => ({
    ok: true, status: 200,
    json: async () => ({ routes: [{ distanceMeters: 16093, duration: '1680s' }] })
  });
  state.logLines = [];
  state.bookings = {};
  state.bookingError = null;
  state.bookingLookups = [];
}
resetState();

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => {
        if (state.authOutage) return { data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } };
        return TOKENS[token]
          ? { data: { user: TOKENS[token] }, error: null }
          : { data: { user: null }, error: { status: 401, message: 'bad token' } };
      }
    },
    from: (table) => {
      if (table === 'bookings') {
        return {
          select: (cols) => ({
            eq: (col, val) => ({
              maybeSingle: async () => {
                state.bookingLookups.push({ cols, col, val, googleCallsAtLookup: googleCalls() });
                if (state.bookingError) return { data: null, error: state.bookingError };
                return { data: state.bookings[val] || null, error: null };
              }
            })
          })
        };
      }
      if (table !== 'customers') throw new Error('unexpected table: ' + table);
      return {
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (state.customerError) return { data: null, error: state.customerError };
              return { data: CUSTOMERS[val] || null, error: null };
            }
          })
        })
      };
    }
  })
};

const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

global.fetch = async (url, options) => {
  if (String(url).includes('places.googleapis.com')) {
    state.placesCalls.push({ url: String(url), options });
    return state.placesResponse();
  }
  if (String(url).includes('routes.googleapis.com')) {
    state.routesCalls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return state.routesResponse();
  }
  throw new Error('unexpected fetch: ' + url);
};

const quoteRideEndpoint = require(path.join(repoRoot, 'backend/functions/quote-ride.js'));
const { quantizeMiles, quantizeMinutes, FIELD_MASK } = require(path.join(repoRoot, 'backend/functions/lib/route-facts.js'));
const { computeCommitment, tokenDigest, newJti, verifyQuoteToken, signQuoteToken, resolveSigningKeys, QUOTE_TTL_MS } = require(path.join(repoRoot, 'backend/functions/lib/quote-token.js'));
const { resolveRateCard } = require(path.join(repoRoot, 'backend/functions/lib/rate-card-resolver.js'));
const { AIRPORTS, airportByCode, isValidPlaceId } = require(path.join(repoRoot, 'backend/functions/lib/place-identity.js'));
const { quoteRide: engineQuote } = require(path.join(repoRoot, 'backend/functions/lib/ride-quote.js'));

const FUTURE_PICKUP = () => new Date(Date.now() + 24 * 3600e3).toISOString();

function goodIntent(overrides = {}) {
  return {
    mode: 'dropoff',
    airportCode: 'MIA',
    placeId: ADDRESS_PLACE_ID,
    pickupAt: FUTURE_PICKUP(),
    passengers: 2,
    ...overrides
  };
}

function post(body, token = 'tok-andres') {
  return quoteRideEndpoint.handler({
    httpMethod: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function decodeTokenPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

function googleCalls() {
  return state.placesCalls.length + state.routesCalls.length;
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  resetState();
  const origLog = console.log;
  console.log = (...args) => { state.logLines.push(args.join(' ')); };
  try {
    await fn();
    passed++;
    origLog(`✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${e.message}`);
  } finally {
    console.log = origLog;
  }
}

(async () => {
  // ---------- gates ----------
  await check('kill switch: 503 before auth, before any Google call', async () => {
    process.env.QUOTE_SERVICE_DISABLED = '1';
    const r = await post(goodIntent());
    delete process.env.QUOTE_SERVICE_DISABLED;
    assert.strictEqual(r.statusCode, 503);
    assert.strictEqual(googleCalls(), 0);
  });

  await check('GET -> 405; OPTIONS -> 200; missing config -> 500', async () => {
    let r = await quoteRideEndpoint.handler({ httpMethod: 'GET', headers: {} });
    assert.strictEqual(r.statusCode, 405);
    r = await quoteRideEndpoint.handler({ httpMethod: 'OPTIONS', headers: {} });
    assert.strictEqual(r.statusCode, 200);
    const saved = process.env.QUOTE_SHADOW_ALLOWLIST;
    delete process.env.QUOTE_SHADOW_ALLOWLIST;
    r = await post(goodIntent());
    process.env.QUOTE_SHADOW_ALLOWLIST = saved;
    assert.strictEqual(r.statusCode, 500, 'an unconfigured allowlist must refuse, never default open');
  });

  await check('auth matrix: 401/500-outage/403 discipline, zero Google calls throughout', async () => {
    let r = await post(goodIntent(), null);
    assert.strictEqual(r.statusCode, 401);
    r = await post(goodIntent(), 'tok-bogus');
    assert.strictEqual(r.statusCode, 401);
    state.authOutage = true;
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 500, 'auth outage is 500, never mislabeled');
    state.authOutage = false;
    state.customerError = { message: 'db down' };
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 500);
    state.customerError = null;
    assert.strictEqual(googleCalls(), 0);
  });

  await check('DARK-PHASE ALLOWLIST: signed-in but unlisted -> 403 with ZERO Google calls', async () => {
    const r = await post(goodIntent(), 'tok-passenger');
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(googleCalls(), 0, 'curiosity must not spend Google quota');
  });

  // ---------- trusted-intent boundary ----------
  await check('intent boundary: every route-fact-shaped or unknown field is rejected by name', async () => {
    for (const [field, value] of [
      ['routeMiles', 10], ['routeMinutes', 20], ['distance', 10], ['duration', 20],
      ['durationMinutes', 20], ['price', 85], ['bags', 2], ['lat', 25.7],
      ['lng', -80.2], ['coordinates', { lat: 1, lng: 2 }], ['address', '123 Main St'],
      ['origin', 'MIA'], ['destination', 'x'], ['token', 'abc'],
      // vehicle preference is REMOVED from the contract: in an
      // all-vehicles response it could only perturb the keyed commitment.
      ['vehicle', 'tesla']
    ]) {
      const r = await post(goodIntent({ [field]: value }));
      assert.strictEqual(r.statusCode, 400, `field ${field} must be rejected`);
      assert.ok(JSON.parse(r.body).error.includes(field), `rejection must name ${field}`);
    }
    assert.strictEqual(googleCalls(), 0);
  });

  await check('intent validation: mode/airport/placeId/pickupAt/passengers each refuse malformed values', async () => {
    const bads = [
      [{ mode: 'hourly' }], [{ airportCode: 'JFK' }], [{ airportCode: null }],
      [{ placeId: 'x' }], [{ placeId: 'bad place id!' }], [{ placeId: 'C'.repeat(3000) }],
      [{ placeId: 42 }], [{ pickupAt: 'tomorrow' }], [{ pickupAt: 12345 }],
      [{ passengers: 0 }], [{ passengers: 2.5 }], [{ passengers: '2' }]
    ];
    for (const [patch] of bads) {
      const r = await post(goodIntent(patch));
      assert.strictEqual(r.statusCode, 400, JSON.stringify(patch));
    }
    assert.strictEqual(googleCalls(), 0);
  });

  // ---------- pickup-time rules ----------
  await check('pickup >5min past -> 400 REJECTED (never re-routed as now); boundary respected', async () => {
    let r = await post(goodIntent({ pickupAt: new Date(Date.now() - 6 * 60000).toISOString() }));
    assert.strictEqual(r.statusCode, 400);
    assert.ok(/past/i.test(JSON.parse(r.body).error));
    assert.strictEqual(googleCalls(), 0);
    r = await post(goodIntent({ pickupAt: new Date(Date.now() - 4 * 60000).toISOString() }));
    assert.strictEqual(r.statusCode, 200, 'within tolerance still quotes');
  });

  await check('departureTime: omitted inside the ±5min window, contractual instant verbatim beyond it', async () => {
    await post(goodIntent({ pickupAt: new Date(Date.now() + 3 * 60000).toISOString() }));
    assert.strictEqual(state.routesCalls.length, 1);
    assert.ok(!('departureTime' in state.routesCalls[0].body),
      'near-term pickups omit departureTime — the contract is never rewritten');
    resetState();
    const future = new Date(Date.now() + 3 * 3600e3).toISOString();
    await post(goodIntent({ pickupAt: future }));
    assert.strictEqual(state.routesCalls[0].body.departureTime, new Date(Date.parse(future)).toISOString(),
      'future pickups pass the contractual instant verbatim');
  });

  // ---------- provider discipline ----------
  await check('one Places + one Routes call; separate keys; exact field masks; placeId waypoints by mode', async () => {
    const r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(state.placesCalls.length, 1);
    assert.strictEqual(state.routesCalls.length, 1);
    assert.strictEqual(state.placesCalls[0].options.headers['X-Goog-Api-Key'], 'places-key-test');
    assert.strictEqual(state.routesCalls[0].options.headers['X-Goog-Api-Key'], 'routes-key-test');
    assert.strictEqual(state.placesCalls[0].options.headers['X-Goog-FieldMask'], 'id,formattedAddress');
    assert.strictEqual(state.routesCalls[0].options.headers['X-Goog-FieldMask'], FIELD_MASK);
    assert.strictEqual(FIELD_MASK, 'routes.distanceMeters,routes.duration,fallbackInfo',
      'fallbackInfo must be IN the mask — an excluded field is never returned');
    // dropoff: address -> airport
    assert.strictEqual(state.routesCalls[0].body.origin.placeId, ADDRESS_PLACE_ID);
    assert.strictEqual(state.routesCalls[0].body.destination.placeId, MIA_PLACE_ID);
    resetState();
    await post(goodIntent({ mode: 'pickup' }));
    assert.strictEqual(state.routesCalls[0].body.origin.placeId, MIA_PLACE_ID);
    assert.strictEqual(state.routesCalls[0].body.destination.placeId, ADDRESS_PLACE_ID);
  });

  await check('provider failures are classified: permanent 400/422 vs transient 502, ONE attempt', async () => {
    // Transient — a retry might work, so 502 is honest.
    state.placesResponse = () => ({ ok: false, status: 500, json: async () => ({}) });
    let r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502);
    assert.strictEqual(state.routesCalls.length, 0, 'no route call after a failed identity resolution');
    resetState();
    state.placesResponse = () => ({ ok: false, status: 429, json: async () => ({}) });
    assert.strictEqual((await post(goodIntent())).statusCode, 502, 'rate limiting is transient');
    resetState();
    // PERMANENT — a dead place id can never resolve, and a 502 would
    // invite retries that each buy another Places + Routes Pro pair.
    state.placesResponse = () => ({ ok: false, status: 404, json: async () => ({}) });
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 400, 'a dead place id is permanent, not a bad gateway');
    assert.strictEqual(state.routesCalls.length, 0);
    resetState();
    // Routes: no drivable route is an ANSWER (422), not a malfunction.
    state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [] }) });
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 422);
    assert.ok(/no drivable route/i.test(JSON.parse(r.body).error));
    resetState();
    // A Routes 400 means WE built a bad request; 401/403 means a broken
    // or wrongly-restricted key. Neither is the passenger's routing
    // problem, and neither may be dressed up as "no drivable route".
    for (const status of [400, 401, 403]) {
      state.routesResponse = () => ({ ok: false, status, json: async () => ({}) });
      const rr = await post(goodIntent());
      assert.strictEqual(rr.statusCode, 502, `Routes ${status} is a server/upstream failure`);
      assert.ok(!/drivable route/i.test(rr.body), `Routes ${status} must not be reported as "no route"`);
      resetState();
    }
    // Transient route failures stay 502, and there is exactly ONE attempt.
    state.routesResponse = () => ({ ok: false, status: 429, json: async () => ({}) });
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502, 'rate limiting is transient, never "no route"');
    assert.strictEqual(state.routesCalls.length, 1, 'exactly ONE attempt — no blind retries');
    resetState();
    state.routesResponse = () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; };
    assert.strictEqual((await post(goodIntent())).statusCode, 502);
    resetState();
    // A response we cannot understand is OUR problem, not the client's.
    state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 16093, duration: '28min' }] }) });
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502, 'malformed duration format must refuse — strict parsing');
    assert.ok(!/price|fare|\$/i.test(r.body), 'never a fabricated price');
  });

  await check('a party no vehicle can seat is refused BEFORE any paid Google call', async () => {
    // The rate card is already in hand and knows every seat count, so
    // 13..100 passengers must not buy a Places call plus a Compute
    // Routes Pro call only for the engine to refuse all three vehicles.
    for (const passengers of [13, 50, 100]) {
      const r = await post(goodIntent({ passengers }));
      assert.strictEqual(r.statusCode, 400, `${passengers} passengers must refuse`);
      assert.ok(/seats/i.test(JSON.parse(r.body).error));
    }
    assert.strictEqual(googleCalls(), 0, 'zero Google spend on an impossible party size');
    // The largest vehicle still quotes at its exact capacity.
    assert.strictEqual((await post(goodIntent({ passengers: 12 }))).statusCode, 200);
  });

  await check('the response says whether anything is bookable, without iterating vehicles', async () => {
    let q = JSON.parse((await post(goodIntent())).body).quote;
    assert.strictEqual(q.bookable, true);
    assert.strictEqual(q.vehiclesOk, 3);
    assert.strictEqual(q.vehiclesRefused, 0);
    resetState();
    // A route beyond the service area refuses every vehicle — but still
    // answers 200, so the consumer needs an explicit flag.
    state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 1200000, duration: '40000s' }] }) });
    const r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 200);
    q = JSON.parse(r.body).quote;
    assert.strictEqual(q.bookable, false, 'nothing is bookable and the response says so');
    assert.strictEqual(q.vehiclesOk, 0);
    assert.strictEqual(q.vehiclesRefused, 3);
    for (const v of Object.values(q.vehicles)) assert.strictEqual(v.ok, false);
  });

  await check('routeQuality: fallbackInfo stamps "fallback" into response AND token; absence stamps traffic_aware', async () => {
    state.routesResponse = () => ({
      ok: true, status: 200,
      json: async () => ({ routes: [{ distanceMeters: 16093, duration: '1680s' }], fallbackInfo: { reason: 'SERVER_ERROR' } })
    });
    let r = await post(goodIntent());
    let q = JSON.parse(r.body).quote;
    assert.strictEqual(q.route.quality, 'fallback');
    assert.strictEqual(decodeTokenPayload(q.vehicles.tesla.token).routeQuality, 'fallback',
      'a degraded route must never masquerade as scheduled-traffic truth downstream');
    resetState();
    r = await post(goodIntent());
    q = JSON.parse(r.body).quote;
    assert.strictEqual(q.route.quality, 'traffic_aware');
    assert.strictEqual(decodeTokenPayload(q.vehicles.tesla.token).routeQuality, 'traffic_aware');
  });

  // ---------- quantization parity ----------
  await check('quantization matches the browser formula exactly (0.1-mile rounding, whole minutes)', async () => {
    const browserMiles = (m) => Math.round(m * 0.000621371 * 10) / 10;
    const browserMinutes = (s) => Math.round(s / 60);
    for (const [meters, seconds] of [[16093, 1680], [1609, 90], [40233, 2429.5], [80467, 5400], [12874, 750], [241, 59]]) {
      assert.strictEqual(quantizeMiles(meters), browserMiles(meters), `miles ${meters}`);
      assert.strictEqual(quantizeMinutes(seconds), browserMinutes(seconds), `minutes ${seconds}`);
    }
    state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 40233, duration: '2429.5s' }] }) });
    const r = await post(goodIntent());
    const q = JSON.parse(r.body).quote;
    assert.strictEqual(q.route.miles, browserMiles(40233));
    assert.strictEqual(q.route.milesTenths, Math.round(browserMiles(40233) * 10));
    assert.strictEqual(q.route.minutes, browserMinutes(2429.5));
  });

  await check('quote issuance signs only the database-consumable 1..1440 minute boundary', async () => {
    for (const [minutes, expectedStatus] of [[0, 500], [1, 200], [1440, 200], [1441, 500]]) {
      resetState();
      // 29 positive provider seconds legitimately quantizes to 0 minutes;
      // unlike literal 0s it reaches the issuance boundary under test.
      const providerSeconds = minutes === 0 ? 29 : minutes * 60;
      state.routesResponse = () => ({
        ok: true,
        status: 200,
        json: async () => ({ routes: [{ distanceMeters: 16093, duration: `${providerSeconds}s` }] })
      });
      const response = await post(goodIntent());
      assert.strictEqual(response.statusCode, expectedStatus, `${minutes} minute route`);
      const parsed = JSON.parse(response.body);
      if (expectedStatus === 200) {
        assert.strictEqual(parsed.quote.route.minutes, minutes);
        assert.ok(parsed.quote.vehicles.tesla.token, `${minutes} minute quote must be signed`);
      } else {
        assert.deepStrictEqual(parsed, { error: 'Pricing unavailable' });
        assert.ok(!('quote' in parsed), `${minutes} minute refusal must carry no quote/token`);
      }
    }
  });

  // ---------- engine consumption + capacity honesty ----------
  await check('all-vehicles response matches the engine directly; capacity flags are honest; bags dormant', async () => {
    const pickupAt = FUTURE_PICKUP();
    const r = await post(goodIntent({ pickupAt, passengers: 5 }));
    const q = JSON.parse(r.body).quote;
    const { card } = await resolveRateCard({});
    // 5 passengers: tesla refuses, escalade + sprinter quote.
    assert.strictEqual(q.vehicles.tesla.ok, false);
    assert.strictEqual(q.vehicles.tesla.error.code, 'passenger_capacity_exceeded');
    for (const key of ['escalade', 'sprinter']) {
      const expected = engineQuote({
        vehicle: key, routeMiles: q.route.miles, routeMinutes: q.route.minutes,
        pickupAtMs: Date.parse(pickupAt), passengers: 5, bags: 0,
        bookingMode: 'dropoff', rateCard: card
      });
      assert.strictEqual(q.vehicles[key].ok, true);
      assert.strictEqual(q.vehicles[key].finalCents, expected.quote.finalCents,
        `${key} must price exactly what the engine prices`);
      assert.strictEqual(q.vehicles[key].passengerCapacityChecked, true);
      assert.strictEqual(q.vehicles[key].luggageCapacityChecked, false,
        'bags are DELIBERATELY unchecked — the UI collects no bag count');
    }
    assert.strictEqual(q.pricingVersion, card.pricingVersion);
    assert.strictEqual(q.cardSource, 'code');
  });

  // ---------- token contract ----------
  await check('token payload v2: jti shared per quote, keyed commitment, no location data, no edit fields', async () => {
    const pickupAt = FUTURE_PICKUP();
    const r = await post(goodIntent({ pickupAt }));
    const q = JSON.parse(r.body).quote;
    const p = decodeTokenPayload(q.vehicles.sprinter.token);
    assert.strictEqual(p.v, 2);
    assert.strictEqual(p.kid, 'k-2026-08');
    assert.strictEqual(p.purpose, 'create');
    assert.ok(!('bookingId' in p) && !('assignmentEpoch' in p),
      'edit-only fields are FORBIDDEN on a create token — the exact schema is per purpose');
    assert.match(p.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'the quote id is a random v4 UUID');
    // ONE jti per QUOTE: every vehicle token in one response shares it,
    // so consuming any vehicle consumes the quote — sibling tokens
    // cannot multiply one quote into several bookings.
    assert.strictEqual(decodeTokenPayload(q.vehicles.tesla.token).jti, p.jti);
    assert.strictEqual(decodeTokenPayload(q.vehicles.escalade.token).jti, p.jti);
    // ...while the exact-token DIGEST distinguishes the vehicles (the
    // retry identity for the consumption gate).
    assert.notStrictEqual(tokenDigest(q.vehicles.tesla.token), tokenDigest(q.vehicles.sprinter.token));
    assert.strictEqual(p.authUserId, '11111111-1111-4111-8111-111111111111');
    assert.strictEqual(p.customerId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.strictEqual(p.vehicle, 'sprinter');
    assert.strictEqual(p.pickupAtMs, Date.parse(pickupAt));
    assert.strictEqual(p.finalCents, q.vehicles.sprinter.finalCents);
    // KEYED commitment: recomputable only with the signing secret —
    // unlike v1's unkeyed hash, a leaked token is no longer an
    // address-confirmation oracle.
    const expectedCommitment = computeCommitment(
      { mode: 'dropoff', airportCode: 'MIA', placeId: ADDRESS_PLACE_ID,
        pickupAtMs: Date.parse(pickupAt), passengers: 2,
        routeMilesTenths: q.route.milesTenths, routeMinutes: q.route.minutes },
      'sprinter', q.vehicles.sprinter.finalCents, CURRENT_SECRET
    );
    assert.strictEqual(p.commitment, expectedCommitment,
      'each token binds the EXACT intent INCLUDING its own vehicle and cents, under the signing key');
    const raw = JSON.stringify(p);
    assert.ok(!raw.includes(ADDRESS_PLACE_ID) && !raw.includes('Test St') && !raw.includes('lat'),
      'no place IDs, addresses, or coordinates may transit the client inside a token');
    assert.ok(!('routeMiles' in p) && !('routeMilesTenths' in p) && !('routeMinutes' in p),
      'route facts are commitment-only — they stay out of the token payload/projection');
    assert.strictEqual(p.routeQuality, 'traffic_aware', 'routeQuality is the one required route field');
    assert.strictEqual(p.exp - p.iat, QUOTE_TTL_MS);
    assert.strictEqual(q.ttlMinutes, 15, 'TTL is the deliberate 15-minute price-hold policy');
  });

  await check('token verification FAILS CLOSED: exact v2 schema, mandatory expectations, strict encoding', async () => {
    const keys = [
      { id: 'k-2026-08', secret: CURRENT_SECRET },
      { id: 'k-2026-07', secret: PREVIOUS_SECRET }
    ];
    const now = Date.now();
    const INTENT = {
      mode: 'dropoff', airportCode: 'MIA', placeId: ADDRESS_PLACE_ID,
      pickupAtMs: now + 3600e3, passengers: 2,
      routeMilesTenths: 100, routeMinutes: 28
    };
    const JTI = newJti();
    // The commitment is key-dependent, so each signing key mints its own.
    const mkBase = (secret) => ({
      purpose: 'create', jti: JTI, authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vehicle: 'tesla', pickupAtMs: INTENT.pickupAtMs,
      commitment: computeCommitment(INTENT, 'tesla', 4500, secret),
      routeQuality: 'traffic_aware',
      finalCents: 4500, pricingVersion: 'v', engineVersion: 'e', resolvedVersion: 'v'
    });
    const base = mkBase(CURRENT_SECRET);
    const EXPECT = {
      purpose: 'create', authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vehicle: 'tesla', intent: INTENT
    };
    const current = signQuoteToken(base, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now });
    const ok = verifyQuoteToken(current, { keys, nowMs: now + 60000, expected: EXPECT });
    assert.strictEqual(ok.ok, true);
    assert.ok(Object.isFrozen(ok.payload), 'the returned projection is frozen');

    // The issuer must fail at issuance, not mint a token that dies later.
    assert.throws(() => signQuoteToken({ ...base, jti: 'not-a-v4-uuid' },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, authUserId: ' ' },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, customerId: '\0' },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, vehicle: ' premier suv ' },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, pickupAtMs: -1 },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, pricingVersion: '   ' },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, pricingVersion: 'v'.repeat(129) },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, finalCents: Number.MAX_SAFE_INTEGER + 1 },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken({ ...base, unsignedExtra: true },
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }), /invalid create payload/);
    assert.throws(() => signQuoteToken(base,
      { keyId: 'bad key', secret: CURRENT_SECRET, nowMs: now }), /invalid key id/);
    assert.throws(() => signQuoteToken(base,
      { keyId: 'k-2026-08', secret: 'weak', nowMs: now }), /invalid signing secret/);
    assert.throws(() => signQuoteToken(base,
      { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: NaN }), /invalid clock/);

    // Rotation: a token signed by the PREVIOUS key still verifies —
    // including its commitment, which the verifier recomputes under the
    // kid-selected key, never under a caller-guessed one.
    const previous = signQuoteToken(mkBase(PREVIOUS_SECRET), { keyId: 'k-2026-07', secret: PREVIOUS_SECRET, nowMs: now });
    assert.strictEqual(verifyQuoteToken(previous, { keys, nowMs: now + 60000, expected: EXPECT }).ok, true);

    // Unknown kid refuses.
    const foreign = signQuoteToken(base, { keyId: 'k-9999', secret: 'x'.repeat(40), nowMs: now });
    assert.strictEqual(verifyQuoteToken(foreign, { keys, nowMs: now, expected: EXPECT }).reason, 'unknown_key');

    // Tampered cents break the seal.
    const [payloadB64, sig] = current.split('.');
    const tampered = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    tampered.finalCents = 100;
    const forged = Buffer.from(JSON.stringify(tampered)).toString('base64url') + '.' + sig;
    assert.strictEqual(verifyQuoteToken(forged, { keys, nowMs: now, expected: EXPECT }).reason, 'bad_signature');

    // UNSIGNED EXTRA FIELDS: canonicalPayload MACs only the known
    // fields, so an appended property keeps the signature valid. It
    // must be REFUSED, never returned to a consumer as if signed.
    const withExtra = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    withExtra.bookingId = '11111111-2222-3333-4444-555555555555';
    const extraTok = Buffer.from(JSON.stringify(withExtra)).toString('base64url') + '.' + sig;
    assert.strictEqual(verifyQuoteToken(extraTok, { keys, nowMs: now, expected: EXPECT }).reason, 'schema_invalid',
      'an unsigned extra property is a rejection, not a passenger');

    // An injected OWN '__proto__' key (JSON.parse creates it as an own
    // property, unlike assignment) is unsigned AND would re-parent a
    // consumer that Object.assign'd the payload. The exact key count
    // refuses it before any of that.
    const payloadText = Buffer.from(payloadB64, 'base64url').toString();
    const poisoned = payloadText.replace(/^\{/, '{"__proto__":{"polluted":true},');
    const poisonTok = Buffer.from(poisoned).toString('base64url') + '.' + sig;
    assert.strictEqual(verifyQuoteToken(poisonTok, { keys, nowMs: now, expected: EXPECT }).reason, 'schema_invalid');
    assert.notStrictEqual({}.polluted, true, 'no prototype pollution reaches the process');

    // INCOMPLETE payload refuses too.
    const missing = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    delete missing.vehicle;
    const missTok = Buffer.from(JSON.stringify(missing)).toString('base64url') + '.' + sig;
    assert.strictEqual(verifyQuoteToken(missTok, { keys, nowMs: now, expected: EXPECT }).reason, 'schema_invalid');

    // CANONICALIZATION COLLISION: JSON.parse('1e999') is Infinity and
    // JSON.stringify(Infinity) is 'null', so '"exp":1e999' and
    // '"exp":null' MAC identically — an immortal token if exp is only
    // typeof-checked. The exact-schema projection kills it.
    const canonNull = JSON.stringify({
      v: 2, kid: 'k-2026-08', jti: JTI, purpose: 'create', authUserId: '11111111-1111-4111-8111-111111111111',
      customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', vehicle: 'tesla', pickupAtMs: 1,
      commitment: base.commitment,
      routeQuality: 'traffic_aware', finalCents: 4500, pricingVersion: 'v',
      engineVersion: 'e', resolvedVersion: 'v', iat: 0, exp: null
    });
    const collisionSig = require('crypto').createHmac('sha256', CURRENT_SECRET).update(canonNull).digest();
    const collision = Buffer.from(canonNull.replace('"exp":null', '"exp":1e999')).toString('base64url') +
      '.' + Buffer.from(collisionSig).toString('base64url');
    assert.strictEqual(verifyQuoteToken(collision, { keys, nowMs: now, expected: EXPECT }).reason, 'schema_invalid',
      'a non-finite exp that canonicalizes to null must never verify');

    // EXPIRY is inclusive at exp, and the TTL is exact.
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now + QUOTE_TTL_MS - 1, expected: EXPECT }).ok, true);
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now + QUOTE_TTL_MS, expected: EXPECT }).reason, 'expired',
      'expiry is nowMs >= exp — at exp the price hold is over');

    // A token minted in the future is refused rather than trusted.
    const future = signQuoteToken(base, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now + 5 * 60000 });
    assert.strictEqual(verifyQuoteToken(future, { keys, nowMs: now, expected: EXPECT }).reason, 'not_yet_valid');

    // CLOCK must be finite — a NaN clock previously made every token
    // immortal (NaN > exp is false).
    for (const bad of [NaN, undefined, null, 'abc', Infinity]) {
      assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: bad, expected: EXPECT }).reason, 'invalid_clock',
        `nowMs ${String(bad)} must refuse, never silently skip expiry`);
    }

    // EXPECTATIONS are mandatory — the old contract silently skipped
    // every binding check when they were omitted.
    for (const bad of [undefined, null, {}, { purpose: 'create' },
      { purpose: 'create', authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { purpose: 'create', authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', vehicle: 'tesla' }]) {
      const r = verifyQuoteToken(current, { keys, nowMs: now, expected: bad });
      assert.strictEqual(r.reason, 'missing_expectations',
        `incomplete expectations must refuse, not pass: ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(verifyQuoteToken(current, { keys: [], nowMs: now, expected: EXPECT }).reason, 'no_keys');

    // Every binding is enforced, including the two that were silently dropped.
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, purpose: 'edit' } }).reason, 'wrong_purpose');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, customerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }).reason, 'wrong_identity');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, authUserId: '33333333-3333-4333-8333-333333333333' } }).reason, 'wrong_identity');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, vehicle: 'sprinter' } }).reason, 'wrong_vehicle',
      'a vehicle expectation must be ENFORCED, never silently dropped');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now,
      expected: { ...EXPECT, intent: { ...INTENT, placeId: 'ChIJ_other_place_id' } } }).reason, 'wrong_intent',
      'the verifier recomputes the KEYED commitment from the submitted intent — a different place refuses');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now,
      expected: { ...EXPECT, intent: { ...INTENT, passengers: 3 } } }).reason, 'wrong_intent');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now,
      expected: { ...EXPECT, intent: { ...INTENT, routeMilesTenths: 101 } } }).reason, 'wrong_intent',
      'changing the authoritative distance must break the keyed commitment');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now,
      expected: { ...EXPECT, intent: { ...INTENT, routeMinutes: 29 } } }).reason, 'wrong_intent',
      'changing the authoritative duration must break the keyed commitment');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now,
      expected: { ...EXPECT, intent: { ...INTENT, routeMinutes: 28.5 } } }).reason, 'invalid_expectation');

    // DEFERRED TIME (the recorded amendment): the consumption path may
    // order the exact-digest idempotent lookup before the time verdict.
    // Authenticity and identity are still absolute; only expiry defers,
    // and the caller gets an explicit timeStatus to act on.
    const late = verifyQuoteToken(current, { keys, nowMs: now + QUOTE_TTL_MS + 1, expected: EXPECT, deferTime: true });
    assert.strictEqual(late.ok, true);
    assert.strictEqual(late.timeStatus, 'expired');
    assert.strictEqual(late.canConsume, false,
      'deferred expiry is authentic for retry lookup but cannot authorize a new write');
    const fresh = verifyQuoteToken(current, { keys, nowMs: now + 1000, expected: EXPECT, deferTime: true });
    assert.strictEqual(fresh.timeStatus, 'valid');
    assert.strictEqual(fresh.canConsume, true);
    const deferredFuture = verifyQuoteToken(future, {
      keys, nowMs: now, expected: EXPECT, deferTime: true
    });
    assert.strictEqual(deferredFuture.ok, true);
    assert.strictEqual(deferredFuture.timeStatus, 'not_yet_valid');
    assert.strictEqual(deferredFuture.canConsume, false);
    assert.strictEqual(verifyQuoteToken(current, {
      keys, nowMs: now, expected: EXPECT, deferTime: 'true'
    }).reason, 'invalid_options');
    const forgedLate = verifyQuoteToken(forged, { keys, nowMs: now + QUOTE_TTL_MS + 1, expected: EXPECT, deferTime: true });
    assert.strictEqual(forgedLate.ok, false, 'deferTime NEVER relaxes authenticity — only the clock');

    // EDIT PURPOSE: bookingId + assignmentEpoch are REQUIRED there and
    // FORBIDDEN on create — the exact field set is per purpose.
    const BOOKING = '99999999-8888-4777-a666-555555555555';
    const editBase = {
      ...mkBase(CURRENT_SECRET), purpose: 'edit', bookingId: BOOKING, assignmentEpoch: 2
    };
    const editTok = signQuoteToken(editBase, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now });
    const editOk = verifyQuoteToken(editTok, { keys, nowMs: now, expected: { ...EXPECT, purpose: 'edit' } });
    assert.strictEqual(editOk.ok, true);
    assert.strictEqual(editOk.payload.bookingId, BOOKING);
    assert.strictEqual(editOk.payload.assignmentEpoch, 2,
      'the edit RPC compares this against the row inside the guarded write');
    assert.strictEqual(verifyQuoteToken(editTok, { keys, nowMs: now, expected: EXPECT }).reason, 'wrong_purpose',
      'an edit token can never pass a create expectation');
    // the SIGNER refuses an incomplete edit payload at issue time —
    // JSON.stringify would silently drop the undefined field and mint a
    // token that dies far away as schema_invalid.
    const noBooking = { ...editBase };
    delete noBooking.bookingId;
    assert.throws(() => signQuoteToken(noBooking, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now }),
      /missing field bookingId/);
    // ...and a hand-FORGED edit token missing the field still refuses at
    // the verifier's exact schema (defense at both ends).
    const forgedNoBooking = (() => {
      const bytes = JSON.stringify({ ...JSON.parse(Buffer.from(editTok.split('.')[0], 'base64url').toString()) });
      const obj = JSON.parse(bytes);
      delete obj.bookingId;
      const text = JSON.stringify(obj);
      const sig2 = require('crypto').createHmac('sha256', CURRENT_SECRET).update(text).digest();
      return Buffer.from(text).toString('base64url') + '.' + Buffer.from(sig2).toString('base64url');
    })();
    assert.strictEqual(verifyQuoteToken(forgedNoBooking, { keys, nowMs: now, expected: { ...EXPECT, purpose: 'edit' } }).reason, 'schema_invalid');

    // DIGEST: deterministic over the exact string, distinct across
    // tokens — the consumption gate's retry identity.
    assert.strictEqual(tokenDigest(current), tokenDigest(current));
    assert.notStrictEqual(tokenDigest(current), tokenDigest(previous));
    assert.match(tokenDigest(current), /^[0-9a-f]{64}$/);

    // STRICT encoding: exactly two canonical base64url segments.
    for (const bad of ['garbage', current + '.extra', current + '=', current.replace('.', '.='),
      ' ' + current, current + '\n', '.' + current, current + '.']) {
      assert.strictEqual(verifyQuoteToken(bad, { keys, nowMs: now, expected: EXPECT }).reason, 'malformed',
        `non-canonical token encoding must refuse: ${JSON.stringify(bad.slice(-12))}`);
    }
  });

  await check('signing key configuration is validated centrally: weak secrets are NOT configured', async () => {
    const good = 'a'.repeat(40);
    // A one-character secret previously signed real tokens — from one
    // issued token the secret is brute-forceable, and forged prices verify.
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: 'x' }).reason, 'current_secret_weak');
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: 'a'.repeat(31) }).reason, 'current_secret_weak');
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: 'a b'.repeat(20) }).reason, 'current_secret_weak');
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_SECRET: good }).reason, 'current_key_id_invalid');
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k'.repeat(65), QUOTE_SIGNING_CURRENT_SECRET: good }).reason, 'current_key_id_invalid');
    // Real operator formats must NOT be false-rejected.
    for (const secret of ['a'.repeat(32), 'f'.repeat(64), 'A1b2C3d4'.repeat(8)]) {
      assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: secret }).ok, true);
    }
    // The previous pair is ALL-OR-NOTHING with a DISTINCT id.
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: good, QUOTE_SIGNING_PREVIOUS_ID: 'k0' }).reason, 'previous_pair_incomplete');
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: good, QUOTE_SIGNING_PREVIOUS_SECRET: good }).reason, 'previous_pair_incomplete');
    assert.strictEqual(resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: good, QUOTE_SIGNING_PREVIOUS_ID: 'k1', QUOTE_SIGNING_PREVIOUS_SECRET: 'b'.repeat(40) }).reason, 'previous_key_id_duplicate');
    const rotated = resolveSigningKeys({ QUOTE_SIGNING_CURRENT_ID: 'k1', QUOTE_SIGNING_CURRENT_SECRET: good, QUOTE_SIGNING_PREVIOUS_ID: 'k0', QUOTE_SIGNING_PREVIOUS_SECRET: 'b'.repeat(40) });
    assert.strictEqual(rotated.keys.length, 2);
    assert.strictEqual(rotated.current.id, 'k1', 'the CURRENT key signs');

    // The endpoint refuses to boot on a weak secret — and spends no quota.
    const saved = process.env.QUOTE_SIGNING_CURRENT_SECRET;
    process.env.QUOTE_SIGNING_CURRENT_SECRET = 'short';
    const r = await post(goodIntent());
    process.env.QUOTE_SIGNING_CURRENT_SECRET = saved;
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(googleCalls(), 0, 'a misconfigured signer never reaches Google');
  });

  // ---------- canonical place identity ----------
  await check('all three airport pins match the current rollout identities and Railway cache', async () => {
    assert.deepStrictEqual(Object.keys(AIRPORTS).sort(), Object.keys(EXPECTED_AIRPORTS).sort());
    const ids = new Set();
    for (const [code, expected] of Object.entries(EXPECTED_AIRPORTS)) {
      const actual = airportByCode(code);
      assert.ok(actual, `${code} must exist`);
      assert.strictEqual(actual.placeId, expected.placeId, `${code} place ID drifted`);
      assert.strictEqual(actual.formattedAddress, expected.formattedAddress, `${code} display address drifted`);
      assert.ok(isValidPlaceId(actual.placeId), `${code} place ID must satisfy the shared boundary`);
      ids.add(actual.placeId);
    }
    assert.strictEqual(ids.size, 3, 'each airport must have a distinct place identity');

    // Railway's custom autocomplete and route logic are deliberately
    // untouched. Its data-only popular Place Details cache must still
    // carry the same current IDs so the two runtimes do not drift.
    const proxySource = fs.readFileSync(path.join(repoRoot, 'backend/api-proxy/server.js'), 'utf8');
    for (const [code, expected] of Object.entries(EXPECTED_AIRPORTS)) {
      assert.ok(proxySource.includes(`['${expected.placeId}', { // ${code}`),
        `Railway's ${code} cache must match the quote-service registry`);
      assert.ok(proxySource.includes(`formatted_address: '${expected.formattedAddress}',`),
        `Railway's ${code} display address must match the quote-service registry`);
    }
    for (const previous of PREVIOUS_AIRPORT_PLACE_IDS) {
      assert.ok(!Object.values(AIRPORTS).some((airport) => airport.placeId === previous),
        'the quote service must not route with a replaced airport pin');
      assert.ok(!proxySource.includes(previous),
        'Railway must not advertise a replaced airport pin as current');
    }
  });

  await check('MIA/FLL/PBI use the current airport pin on the correct route side in both modes', async () => {
    for (const [code, expected] of Object.entries(EXPECTED_AIRPORTS)) {
      for (const mode of ['dropoff', 'pickup']) {
        const r = await post(goodIntent({ airportCode: code, mode }));
        assert.strictEqual(r.statusCode, 200, `${code} ${mode} must quote under mocked providers`);
        const routeBody = state.routesCalls.at(-1).body;
        if (mode === 'dropoff') {
          assert.strictEqual(routeBody.origin.placeId, ADDRESS_PLACE_ID);
          assert.strictEqual(routeBody.destination.placeId, expected.placeId);
        } else {
          assert.strictEqual(routeBody.origin.placeId, expected.placeId);
          assert.strictEqual(routeBody.destination.placeId, ADDRESS_PLACE_ID);
        }
      }
    }
    assert.strictEqual(state.placesCalls.length, 6);
    assert.strictEqual(state.routesCalls.length, 6);
  });

  await check('the RESOLVED place id is canonical: routing, response, and commitment all use it', async () => {
    // Google documents that Place Details MAY answer with a different
    // id (address-range inference, subpremise components — exactly
    // LinkMia's condo/hotel input class). The submitted id must not
    // then be routed while the resolved place supplies the address.
    const RESOLVED = 'ChIJRESOLVEDreplacementID99';
    state.placesResponse = () => ({
      ok: true, status: 200,
      json: async () => ({ id: RESOLVED, formattedAddress: '900 Resolved Ave, Miami, FL 33139' })
    });
    const pickupAt = FUTURE_PICKUP();
    const r = await post(goodIntent({ pickupAt }));
    assert.strictEqual(r.statusCode, 200);
    const q = JSON.parse(r.body).quote;

    // Places was asked with the SUBMITTED id...
    assert.ok(state.placesCalls[0].url.includes(ADDRESS_PLACE_ID));
    // ...but routing uses the RESOLVED one.
    assert.strictEqual(state.routesCalls[0].body.origin.placeId, RESOLVED,
      'routing must use the resolved id, never the superseded submitted id');
    assert.strictEqual(state.routesCalls[0].body.destination.placeId, MIA_PLACE_ID);
    // ...and so does the response the client will resubmit.
    assert.strictEqual(q.intent.placeId, RESOLVED,
      '2B2 resubmits quote.intent.placeId verbatim — it must be canonical');
    // ...and so does every token's keyed commitment.
    const p = decodeTokenPayload(q.vehicles.tesla.token);
    assert.strictEqual(p.commitment, computeCommitment(
      { mode: 'dropoff', airportCode: 'MIA', placeId: RESOLVED,
        pickupAtMs: Date.parse(pickupAt), passengers: 2,
        routeMilesTenths: q.route.milesTenths, routeMinutes: q.route.minutes },
      'tesla', q.vehicles.tesla.finalCents, CURRENT_SECRET
    ), 'the commitment 2C recomputes must cover the canonical id');
    // Substitution is observable in telemetry as a BOOLEAN, never an id.
    const tel = state.logLines.find((l) => l.includes('quote_telemetry'));
    assert.ok(tel.includes('"placeIdSubstituted":true'));
    assert.ok(!tel.includes(RESOLVED) && !tel.includes(ADDRESS_PLACE_ID));
  });

  await check('place ids follow ONE contract in both directions; Google-documented long ids quote', async () => {
    // Google states verbatim that there is no maximum length for place
    // IDs, and its own documented long-form example runs past 600
    // characters — a 512 bound would refuse a place ID straight out of
    // the documentation.
    const LONG = 'Ep' + 'A1b2C3d4_-'.repeat(70); // 702 chars, Google's URL-safe-base64 shape
    assert.ok(LONG.length > 600);
    state.placesResponse = () => ({
      ok: true, status: 200,
      json: async () => ({ id: LONG, formattedAddress: '1 Long Id Way, Miami, FL' })
    });
    const r = await post(goodIntent({ placeId: LONG }));
    assert.strictEqual(r.statusCode, 200, 'a 700-char place id must not be refused');
    assert.strictEqual(JSON.parse(r.body).quote.intent.placeId, LONG);
    // A declared operational bound still exists, well clear of Google's example.
    assert.strictEqual((await post(goodIntent({ placeId: 'C'.repeat(3000) }))).statusCode, 400);

    // ONE CONTRACT: whatever the service returns as canonical must
    // satisfy the SAME rules its own next request will apply. Anything
    // Google returns that fails them is a response we do not
    // understand — never a silent fallback to the submitted id while
    // keeping the resolved place's address.
    for (const badId of ['ChIJ+has+plus', 'short', 'id.with.dots', 'has/slash', 'ünicode', 'C'.repeat(3000), '', null, undefined, 42]) {
      resetState();
      state.placesResponse = () => ({
        ok: true, status: 200,
        json: async () => ({ id: badId, formattedAddress: '9 Split Identity Rd, Miami, FL' })
      });
      const rr = await post(goodIntent());
      assert.strictEqual(rr.statusCode, 502, `a returned id of ${JSON.stringify(badId)} must fail closed`);
      assert.strictEqual(state.routesCalls.length, 0, 'never route on an identity we could not pin');
      assert.ok(!/Split Identity/.test(rr.body), 'never pair the resolved address with the submitted id');
    }
    // Every id the service DOES hand back round-trips through its own validator.
    resetState();
    const q = JSON.parse((await post(goodIntent())).body).quote;
    assert.strictEqual((await post(goodIntent({ placeId: q.intent.placeId }))).statusCode, 200,
      'the canonical id the service returns must be resubmittable');
  });

  await check('provider failures keep passenger-correctable identity separate from configuration outages', async () => {
    // Rollout provisions two brand-new restricted keys, so a wrong
    // restriction is the single most likely early failure. It must read
    // as a server fault, not as "reselect your address".
    for (const status of [401, 403]) {
      state.placesResponse = () => ({ ok: false, status, json: async () => ({}) });
      const r = await post(goodIntent());
      assert.strictEqual(r.statusCode, 502, `Places ${status} is a configuration failure`);
      assert.ok(!/reselect/i.test(r.body), `Places ${status} must not be dressed up as passenger error`);
      resetState();
    }
    // Google documents INVALID_REQUEST for a truncated or modified
    // place id. It is permanent and reselecting is actionable; it must
    // not become a retryable-looking 502 that rebuys the same call.
    state.placesResponse = () => ({ ok: false, status: 400, json: async () => ({}) });
    const r400 = await post(goodIntent());
    assert.strictEqual(r400.statusCode, 400);
    assert.ok(/reselect/i.test(r400.body));
    assert.strictEqual(state.routesCalls.length, 0);
    assert.ok(state.logLines.some((line) => line.includes('places_invalid_request')),
      'Places 400 keeps its own sanitized telemetry class');
    resetState();
    // ONLY an obsolete/unknown place id is the passenger's to correct.
    state.placesResponse = () => ({ ok: false, status: 404, json: async () => ({}) });
    const r404 = await post(goodIntent());
    assert.strictEqual(r404.statusCode, 400);
    assert.ok(/reselect/i.test(r404.body));
  });

  await check('every vehicle token binds its OWN vehicle in both the payload and the commitment', async () => {
    const pickupAt = FUTURE_PICKUP();
    const q = JSON.parse((await post(goodIntent({ pickupAt }))).body).quote;
    const INTENT = {
      mode: 'dropoff', airportCode: 'MIA', placeId: ADDRESS_PLACE_ID,
      pickupAtMs: Date.parse(pickupAt), passengers: 2,
      routeMilesTenths: q.route.milesTenths, routeMinutes: q.route.minutes
    };
    const commitments = new Set();
    for (const key of Object.keys(q.vehicles)) {
      if (!q.vehicles[key].ok) continue;
      const p = decodeTokenPayload(q.vehicles[key].token);
      assert.strictEqual(p.vehicle, key);
      assert.strictEqual(p.commitment, computeCommitment(
        INTENT, key, q.vehicles[key].finalCents, CURRENT_SECRET
      ), `${key}'s commitment must cover ${key} and ITS cents, not a shared preference`);
      commitments.add(p.commitment);
      // The token verifies ONLY against its own vehicle.
      const keys = [{ id: 'k-2026-08', secret: CURRENT_SECRET }];
      const expected = {
        purpose: 'create', authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        vehicle: key, intent: INTENT
      };
      assert.strictEqual(verifyQuoteToken(q.vehicles[key].token, { keys, nowMs: Date.now(), expected }).ok, true);
    }
    assert.strictEqual(commitments.size, Object.keys(q.vehicles).filter((k) => q.vehicles[k].ok).length,
      'each vehicle gets a DISTINCT commitment — never one shared, contradictory binding');
  });

  // ---------- input strictness ----------
  await check('pickupAt must be RFC 3339 WITH an offset — an ambiguous instant is never assumed', async () => {
    const day = new Date(Date.now() + 24 * 3600e3).toISOString().slice(0, 10);
    for (const bad of [day, `${day}T10:00:00`, `${day}T10:00`, 'August 20, 2099',
      `${day} 10:00:00Z`, `${day}T10:00:00+04`, '']) {
      const r = await post(goodIntent({ pickupAt: bad }));
      assert.strictEqual(r.statusCode, 400, `offset-less/ambiguous pickupAt must refuse: ${bad}`);
    }
    // A real datetime that the regex admits but the calendar rejects.
    assert.strictEqual((await post(goodIntent({ pickupAt: '2099-02-30T10:00:00Z' }))).statusCode, 400);
    assert.strictEqual(googleCalls(), 0);
    // Offset forms are accepted and mean exactly what they say.
    const withOffset = new Date(Date.now() + 6 * 3600e3).toISOString().replace('Z', '+00:00');
    assert.strictEqual((await post(goodIntent({ pickupAt: withOffset }))).statusCode, 200);
  });

  await check('a JSON null, array, or primitive body is a 400 request error, never a 500', async () => {
    for (const raw of ['null', '[]', '[{"mode":"dropoff"}]', '"str"', '5', 'true']) {
      const r = await post(raw);
      assert.strictEqual(r.statusCode, 400, `body ${raw} must be a 400`);
      assert.ok(!/Internal error/.test(r.body), `body ${raw} must not surface as a server fault`);
    }
    assert.strictEqual(googleCalls(), 0);
  });

  await check('airport codes are matched by OWN property — prototype members never reach a paid call', async () => {
    // A bare AIRPORTS[code] answers truthily for 'constructor',
    // 'toString' and '__proto__', carrying an unknown code past the
    // whitelist and into billable Places + Routes calls.
    for (const code of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      const r = await post(goodIntent({ airportCode: code }));
      assert.strictEqual(r.statusCode, 400, `${code} must be rejected as an unknown airport`);
      assert.ok(/airport/i.test(JSON.parse(r.body).error));
    }
    assert.strictEqual(googleCalls(), 0, 'a prototype-member code must spend ZERO Google quota');
    assert.strictEqual(airportByCode('constructor'), null);
    assert.ok(airportByCode('MIA'));
  });

  await check('provider values are validated at the boundary: integer metres, protobuf duration, bounded', async () => {
    const bad = [
      { distanceMeters: 16093.7, duration: '1680s' },
      { distanceMeters: '16093', duration: '1680s' },
      { distanceMeters: 0, duration: '1680s' },
      { distanceMeters: -5, duration: '1680s' },
      { distanceMeters: 20000001, duration: '1680s' },
      { distanceMeters: Number.MAX_VALUE, duration: '1680s' },
      { distanceMeters: 16093, duration: '1680' },
      { distanceMeters: 16093, duration: '1680.1234567891s' },
      { distanceMeters: 16093, duration: '1e3s' },
      { distanceMeters: 16093, duration: '604801s' },
      { distanceMeters: 16093, duration: 1680 }
    ];
    for (const route of bad) {
      state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [route] }) });
      const r = await post(goodIntent());
      assert.strictEqual(r.statusCode, 502, `must refuse ${JSON.stringify(route)} rather than price it`);
      assert.ok(!/NaN|Infinity/.test(r.body));
    }
    // Fractional-second precision within protobuf range is fine.
    state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 16093, duration: '1680.123456789s' }] }) });
    assert.strictEqual((await post(goodIntent())).statusCode, 200);
  });

  await check('the token STRING is canonical — one quote cannot mint many valid strings', async () => {
    // Without a byte-equality check the verifier MACs a RE-SERIALIZED
    // copy, so a token holder can mint unlimited DISTINCT strings for
    // one quote (reordered keys, whitespace, 4.5e3 for 4500) that all
    // verify — leaving 2C's mandated single-use gate no stable key.
    const keys = [{ id: 'k-2026-08', secret: CURRENT_SECRET }];
    const now = Date.now();
    const INTENT = {
      mode: 'dropoff', airportCode: 'MIA', placeId: ADDRESS_PLACE_ID,
      pickupAtMs: now + 3600e3, passengers: 2,
      routeMilesTenths: 100, routeMinutes: 28
    };
    const tok = signQuoteToken({
      purpose: 'create', jti: newJti(), authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vehicle: 'tesla', pickupAtMs: INTENT.pickupAtMs,
      commitment: computeCommitment(INTENT, 'tesla', 4500, CURRENT_SECRET),
      routeQuality: 'traffic_aware', finalCents: 4500,
      pricingVersion: 'v', engineVersion: 'e', resolvedVersion: 'v'
    }, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now });
    const EXPECT = {
      purpose: 'create', authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vehicle: 'tesla', intent: INTENT
    };
    const [pb, sig] = tok.split('.');
    const obj = JSON.parse(Buffer.from(pb, 'base64url').toString());
    const variants = {
      'pretty-printed': JSON.stringify(obj, null, 2),
      'reversed key order': JSON.stringify(Object.fromEntries(Object.entries(obj).reverse())),
      'exponent notation': JSON.stringify(obj).replace('"finalCents":4500', '"finalCents":4.5e3'),
      'trailing whitespace': JSON.stringify(obj) + ' '
    };
    for (const [label, text] of Object.entries(variants)) {
      const variant = Buffer.from(text).toString('base64url') + '.' + sig;
      assert.notStrictEqual(variant, tok, `${label} must be a DIFFERENT string`);
      assert.strictEqual(verifyQuoteToken(variant, { keys, nowMs: now, expected: EXPECT }).reason, 'not_canonical',
        `${label} must not verify — the token string is canonical`);
    }
    assert.strictEqual(verifyQuoteToken(tok, { keys, nowMs: now, expected: EXPECT }).ok, true);
  });

  await check('an expectation key outside the contract is refused, never silently dropped', async () => {
    const keys = [{ id: 'k-2026-08', secret: CURRENT_SECRET }];
    const now = Date.now();
    const INTENT = {
      mode: 'dropoff', airportCode: 'MIA', placeId: ADDRESS_PLACE_ID,
      pickupAtMs: now + 3600e3, passengers: 2,
      routeMilesTenths: 100, routeMinutes: 28
    };
    const tok = signQuoteToken({
      purpose: 'create', jti: newJti(), authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vehicle: 'tesla', pickupAtMs: INTENT.pickupAtMs,
      commitment: computeCommitment(INTENT, 'tesla', 4500, CURRENT_SECRET),
      routeQuality: 'traffic_aware', finalCents: 4500,
      pricingVersion: 'v', engineVersion: 'e', resolvedVersion: 'v'
    }, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now });
    const EXPECT = {
      purpose: 'create', authUserId: '11111111-1111-4111-8111-111111111111', customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      vehicle: 'tesla', intent: INTENT
    };
    // A 2C author who "pins" the price or the instant this way would
    // otherwise get ok:true with neither actually enforced.
    for (const extra of [{ finalCents: 999999 }, { pickupAtMs: 1 }, { routeQuality: 'fallback' }]) {
      assert.strictEqual(
        verifyQuoteToken(tok, { keys, nowMs: now, expected: { ...EXPECT, ...extra } }).reason,
        'unknown_expectation',
        `expected.${Object.keys(extra)[0]} must fail loudly rather than be ignored`);
    }
    // The same discipline applies INSIDE the intent object.
    assert.strictEqual(
      verifyQuoteToken(tok, { keys, nowMs: now,
        expected: { ...EXPECT, intent: { ...INTENT, routeMiles: 10 } } }).reason,
      'unknown_expectation', 'an unknown intent field must fail loudly too');
    // What a consumer legitimately wants is on the frozen projection.
    assert.strictEqual(verifyQuoteToken(tok, { keys, nowMs: now, expected: EXPECT }).payload.finalCents, 4500);
  });

  await check('a rotation that reuses the same secret under a new id is refused', async () => {
    const leaked = 'a'.repeat(40);
    assert.strictEqual(resolveSigningKeys({
      QUOTE_SIGNING_CURRENT_ID: 'k2', QUOTE_SIGNING_CURRENT_SECRET: leaked,
      QUOTE_SIGNING_PREVIOUS_ID: 'k1', QUOTE_SIGNING_PREVIOUS_SECRET: leaked
    }).reason, 'previous_secret_duplicate',
      'moving a leaked secret to a new key id rotates nothing');
  });

  await check('provider calls share ONE deadline — a quote is bounded by OUR latency budget', async () => {
    const { resolvePlace } = require(path.join(repoRoot, 'backend/functions/lib/place-identity.js'));
    const { computeRouteFacts } = require(path.join(repoRoot, 'backend/functions/lib/route-facts.js'));
    let called = 0;
    const spy = async () => { called++; return { ok: true, status: 200, json: async () => ({}) }; };
    // An already-spent budget refuses WITHOUT dispatching a paid call.
    const past = Date.now() - 1;
    assert.strictEqual((await resolvePlace(ADDRESS_PLACE_ID, { apiKey: 'k', fetchImpl: spy, deadlineMs: past })).reason, 'places_timeout');
    assert.strictEqual((await computeRouteFacts({ originPlaceId: 'a', destinationPlaceId: 'b', pickupAtMs: Date.now() + 3600e3, nowMs: Date.now() }, { apiKey: 'k', fetchImpl: spy, deadlineMs: past })).reason, 'routes_timeout');
    assert.strictEqual(called, 0, 'an exhausted budget spends nothing');
    // The endpoint passes a real shared deadline to both providers.
    // The budget is a PRODUCT choice, not a platform constraint —
    // Netlify's synchronous limit is 60s and is not configurable, so
    // nothing external forces this number. It exists so a
    // passenger-facing quote cannot hang, and so a late-dying
    // invocation cannot first pay for two Google calls.
    const endpoint = require('fs').readFileSync(path.join(repoRoot, 'backend/functions/quote-ride.js'), 'utf8');
    assert.ok(/PROVIDER_BUDGET_MS\s*=\s*(\d+)/.test(endpoint));
    const budget = Number(RegExp.$1);
    assert.ok(budget > 0 && budget <= 15000, 'the shared budget is a deliberate latency guard');
    assert.ok(!/10s|10 ?second/i.test(endpoint), 'no stale 10-second platform-limit rationale');
    assert.strictEqual((endpoint.match(/deadlineMs: providerDeadline/g) || []).length, 2,
      'BOTH provider calls share the one deadline');
  });

  // ---------- telemetry ----------
  await check('telemetry is sanitized: latency + outcome classes only, never identity or location', async () => {
    await post(goodIntent());
    state.placesResponse = () => ({ ok: false, status: 500, json: async () => ({ error: 'raw provider secret text' }) });
    await post(goodIntent());
    const telemetry = state.logLines.filter((l) => l.includes('quote_telemetry'));
    assert.ok(telemetry.length >= 2, 'success and failure both emit telemetry');
    for (const line of state.logLines) {
      assert.ok(!line.includes(ADDRESS_PLACE_ID), 'no place IDs in logs');
      assert.ok(!line.includes('Test St'), 'no addresses in logs');
      assert.ok(!line.includes('11111111-1111-4111-8111-111111111111') && !line.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'no identities in logs');
      assert.ok(!line.includes('raw provider secret text'), 'no raw provider errors in logs');
    }
    assert.ok(telemetry[0].includes('totalMs'));
  });

  // ---------- static shape ----------
  await check('netlify routes /api/quote-ride; engine and rate card are consumed, never modified', async () => {
    const fs = require('fs');
    const toml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
    assert.ok(toml.includes('from = "/api/quote-ride"'));
    assert.ok(toml.includes('to = "/.netlify/functions/quote-ride"'));
    const endpoint = fs.readFileSync(path.join(repoRoot, 'backend/functions/quote-ride.js'), 'utf8');
    assert.ok(endpoint.includes("require('./lib/ride-quote')"), 'the 3C-2A engine is the only calculator');
    assert.ok(!endpoint.includes('pricing.js'), 'the browser calculator is never touched');
  });

  // ============ PR-2: edit-purpose quote issuance ============
  const EDIT_BOOKING_ID = '99999999-9999-4999-8999-999999999999';
  const OWNER_CUSTOMER = CUSTOMERS['11111111-1111-4111-8111-111111111111'].id;
  function editableBookingRow(overrides = {}) {
    return {
      id: EDIT_BOOKING_ID, customer_id: OWNER_CUSTOMER, status: 'pending',
      assigned_driver: null, details_version: 3, assignment_epoch: 7,
      ...overrides
    };
  }

  await check('EDIT shape: bookingId and expectedDetailsVersion travel together or not at all', async () => {
    resetState();
    for (const body of [
      goodIntent({ bookingId: EDIT_BOOKING_ID }),                    // id without version
      goodIntent({ expectedDetailsVersion: 3 }),                     // version without id
    ]) {
      const res = await post(body);
      assert.strictEqual(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /supplied together/);
    }
    for (const body of [
      goodIntent({ bookingId: 'not-a-uuid', expectedDetailsVersion: 3 }),
      goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 0 }),
      goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 3.5 }),
      goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: '3' }),
    ]) {
      const res = await post(body);
      assert.strictEqual(res.statusCode, 400);
    }
    assert.strictEqual(googleCalls(), 0, 'shape refusals must never buy a provider call');
    assert.strictEqual(state.bookingLookups.length, 0, 'shape refusals precede the lookup');
  });

  await check('EDIT gates run BEFORE any paid provider call; missing and foreign are one 404', async () => {
    resetState();
    const missing = await post(goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 3 }));
    assert.strictEqual(missing.statusCode, 404);

    resetState();
    state.bookings[EDIT_BOOKING_ID] = editableBookingRow({ customer_id: 'someone-elses-customer' });
    const foreign = await post(goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 3 }));
    assert.strictEqual(foreign.statusCode, 404);
    assert.strictEqual(foreign.body, missing.body,
      'a foreign booking must be indistinguishable from a missing one');
    assert.strictEqual(googleCalls(), 0, 'refused edits never reach Places or Routes');

    resetState();
    state.bookingError = { message: 'db down' };
    const outage = await post(goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 3 }));
    assert.strictEqual(outage.statusCode, 500, 'a lookup outage is an outage, never a 404');
    assert.strictEqual(googleCalls(), 0);
  });

  await check('EDIT gates: accepted or assigned rows answer edit_stale/not_editable with the live status', async () => {
    for (const row of [
      editableBookingRow({ status: 'confirmed', assigned_driver: 'driver-1' }),
      editableBookingRow({ assigned_driver: 'driver-1' }),           // pending but claimed
      editableBookingRow({ status: 'cancelled' }),
    ]) {
      resetState();
      state.bookings[EDIT_BOOKING_ID] = row;
      const res = await post(goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 3 }));
      assert.strictEqual(res.statusCode, 409);
      const payload = JSON.parse(res.body);
      assert.strictEqual(payload.error, 'edit_stale');
      assert.strictEqual(payload.reason, 'not_editable');
      assert.strictEqual(payload.currentStatus, row.status);
      assert.strictEqual(googleCalls(), 0);
    }
  });

  await check('EDIT gates: a stale captured version answers edit_stale/version with ZERO provider spend', async () => {
    resetState();
    state.bookings[EDIT_BOOKING_ID] = editableBookingRow({ details_version: 5 });
    const res = await post(goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 3 }));
    assert.strictEqual(res.statusCode, 409);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.error, 'edit_stale');
    assert.strictEqual(payload.reason, 'version');
    assert.strictEqual(payload.currentDetailsVersion, 5);
    assert.strictEqual(googleCalls(), 0,
      'the whole point of the pre-provider gate: a stale form buys nothing');
  });

  await check('EDIT issuance: purpose:edit tokens bind booking + assignment epoch; response echoes edit', async () => {
    resetState();
    state.bookings[EDIT_BOOKING_ID] = editableBookingRow();
    const res = await post(goodIntent({ bookingId: EDIT_BOOKING_ID, expectedDetailsVersion: 3 }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.bookingLookups.length, 1);
    assert.strictEqual(state.bookingLookups[0].googleCallsAtLookup, 0,
      'the lookup happens BEFORE the first provider call');
    assert.strictEqual(googleCalls(), 2, 'a passing edit gate buys the normal one Places + one Routes');

    const quote = JSON.parse(res.body).quote;
    assert.deepStrictEqual(quote.edit, { bookingId: EDIT_BOOKING_ID, detailsVersion: 3 },
      'the edit echo is display-only truth from the live row');
    for (const key of ['tesla', 'escalade', 'sprinter']) {
      const payload = decodeTokenPayload(quote.vehicles[key].token);
      assert.strictEqual(payload.purpose, 'edit');
      assert.strictEqual(payload.bookingId, EDIT_BOOKING_ID);
      assert.strictEqual(payload.assignmentEpoch, 7);
    }
  });

  await check('CREATE issuance is untouched: purpose:create, no edit fields, edit echo null', async () => {
    resetState();
    const res = await post(goodIntent());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.bookingLookups.length, 0, 'creates never look up a booking');
    const quote = JSON.parse(res.body).quote;
    assert.strictEqual(quote.edit, null);
    for (const key of ['tesla', 'escalade', 'sprinter']) {
      const payload = decodeTokenPayload(quote.vehicles[key].token);
      assert.strictEqual(payload.purpose, 'create');
      assert.ok(!('bookingId' in payload) && !('assignmentEpoch' in payload),
        'create tokens carry no edit binding');
    }
  });

  await check('calculate-price retirement is complete and pinned behind the cache refresh', async () => {
    const fs = require('fs');
    const retiredHandlerPath = path.join(repoRoot, 'backend/functions/calculate-price.js');
    assert.strictEqual(fs.existsSync(retiredHandlerPath), true,
      'reserved direct function path requires a fail-closed stub');
    const retiredSource = fs.readFileSync(retiredHandlerPath, 'utf8');
    assert.ok(!/ride-quote|ride-rate-card|pricing\.js|calculatePrice|fetch\s*\(/.test(retiredSource),
      'retired stub contains no calculator or provider path');
    const directResponse = await require(retiredHandlerPath).handler({
      httpMethod: 'POST', body: JSON.stringify({ distance: 1, duration: 1 })
    });
    assert.strictEqual(directResponse.statusCode, 404);
    assert.deepStrictEqual(JSON.parse(directResponse.body), { error: 'calculate-price retired' });
    assert.strictEqual(directResponse.headers['Cache-Control'], 'private, no-store');
    const toml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
    const catchAllAt = toml.indexOf('from = "/*"');
    const aliasAt = toml.indexOf('from = "/api/calculate-price"');
    assert.ok(aliasAt >= 0 && (catchAllAt < 0 || aliasAt < catchAllAt),
      'public calculate-price 404 must precede catch-all');
    const aliasBlock = toml.slice(aliasAt, toml.indexOf('[[redirects]]', aliasAt + 1));
    assert.ok(/to\s*=\s*"\/admin-retired\.html"/.test(aliasBlock));
    assert.ok(/status\s*=\s*404/.test(aliasBlock));
    assert.strictEqual(toml.includes('from = "/.netlify/functions/calculate-price"'), false,
      'Netlify rejects redirect rules in its reserved function namespace');
    const apiConfig = fs.readFileSync(path.join(repoRoot, 'api-config.js'), 'utf8');
    assert.ok(!apiConfig.includes('/api/calculate-price'));
    assert.ok(!apiConfig.includes('calculatePrice'));
    const worker = fs.readFileSync(path.join(repoRoot, 'service-worker.js'), 'utf8');
    assert.ok(worker.includes("'/api-config.js'"), 'changed API config remains a precached asset');
    const cacheName = worker.match(/const CACHE_NAME\s*=\s*'([^']+)'/)?.[1];
    assert.strictEqual(cacheName, 'linkmia-v1.3.21', 'PR-2 ships with the reviewed cache bump');
  });

  if (failures.length) {
    console.error(`\n${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
