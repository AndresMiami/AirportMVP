// PR 3C-2B1 — dark quote service: trusted-intent boundary, dark-phase
// allowlist, provider discipline (field mask / departureTime rules /
// strict parsing / one attempt), quantization parity with the browser
// formula, signed-token contract with key rotation, telemetry
// sanitization, and the kill switch. All provider behavior runs
// against mocks — the real keys are rollout gates.
//
// Run: node tests/quote-ride.test.js

const path = require('path');
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
process.env.QUOTE_SHADOW_ALLOWLIST = 'auth-andres, auth-second';
delete process.env.QUOTE_SERVICE_DISABLED;

const repoRoot = path.resolve(__dirname, '..');

const TOKENS = {
  'tok-andres': { id: 'auth-andres' },
  'tok-passenger': { id: 'auth-passenger' } // signed in, NOT allowlisted
};
const CUSTOMERS = {
  'auth-andres': { id: 'cust-andres' },
  'auth-passenger': { id: 'cust-passenger' }
};

const ADDRESS_PLACE_ID = 'ChIJTESTaddressPLACEid1234';
const MIA_PLACE_ID = 'ChIJQ2DP_4u02YgRPNlKgMr9gBE';

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
const { computeIntentHash, verifyQuoteToken, signQuoteToken, resolveSigningKeys, QUOTE_TTL_MS } = require(path.join(repoRoot, 'backend/functions/lib/quote-token.js'));
const { resolveRateCard } = require(path.join(repoRoot, 'backend/functions/lib/rate-card-resolver.js'));
const { airportByCode } = require(path.join(repoRoot, 'backend/functions/lib/place-identity.js'));
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
      // all-vehicles response it could only perturb the intentHash.
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
    assert.strictEqual(q.route.minutes, browserMinutes(2429.5));
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
  await check('token payload: v1, kid, purpose create, dual identity, intentHash, no location data', async () => {
    const pickupAt = FUTURE_PICKUP();
    const r = await post(goodIntent({ pickupAt }));
    const q = JSON.parse(r.body).quote;
    const p = decodeTokenPayload(q.vehicles.sprinter.token);
    assert.strictEqual(p.v, 1);
    assert.strictEqual(p.kid, 'k-2026-08');
    assert.strictEqual(p.purpose, 'create', '2B1 is honestly create-only — no editContext exists');
    assert.ok(!('editContext' in p));
    assert.strictEqual(p.authUserId, 'auth-andres');
    assert.strictEqual(p.customerId, 'cust-andres');
    assert.strictEqual(p.vehicle, 'sprinter');
    assert.strictEqual(p.pickupAtMs, Date.parse(pickupAt));
    assert.strictEqual(p.finalCents, q.vehicles.sprinter.finalCents);
    const expectedHash = computeIntentHash({
      mode: 'dropoff', airportCode: 'MIA', placeId: ADDRESS_PLACE_ID,
      pickupAtMs: Date.parse(pickupAt), passengers: 2, vehicle: 'sprinter'
    });
    assert.strictEqual(p.intentHash, expectedHash,
      'each token binds the EXACT intent INCLUDING its own vehicle');
    const raw = JSON.stringify(p);
    assert.ok(!raw.includes(ADDRESS_PLACE_ID) && !raw.includes('Test St') && !raw.includes('lat'),
      'no place IDs, addresses, or coordinates may transit the client inside a token');
    assert.ok(!('routeMiles' in p) && !('routeMinutes' in p),
      'intentHash INSTEAD of raw route facts — facts live in the response only (plan v3)');
    assert.strictEqual(p.routeQuality, 'traffic_aware', 'routeQuality is the one required route field');
    assert.strictEqual(p.exp - p.iat, QUOTE_TTL_MS);
    assert.strictEqual(q.ttlMinutes, 15, 'TTL is the deliberate 15-minute price-hold policy');
  });

  await check('token verification FAILS CLOSED: exact v1 schema, mandatory expectations, strict encoding', async () => {
    const keys = [
      { id: 'k-2026-08', secret: CURRENT_SECRET },
      { id: 'k-2026-07', secret: PREVIOUS_SECRET }
    ];
    const HASH = 'a1b2c3d4'.repeat(8); // a real 64-char hex digest shape
    const base = {
      purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
      vehicle: 'tesla', pickupAtMs: Date.now() + 3600e3, intentHash: HASH,
      routeQuality: 'traffic_aware',
      finalCents: 4500, pricingVersion: 'v', engineVersion: 'e', resolvedVersion: 'v'
    };
    const now = Date.now();
    const EXPECT = {
      purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
      vehicle: 'tesla', intentHash: HASH
    };
    const current = signQuoteToken(base, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now });
    const ok = verifyQuoteToken(current, { keys, nowMs: now + 60000, expected: EXPECT });
    assert.strictEqual(ok.ok, true);
    assert.ok(Object.isFrozen(ok.payload), 'the returned projection is frozen');

    // Rotation: a token signed by the PREVIOUS key still verifies.
    const previous = signQuoteToken(base, { keyId: 'k-2026-07', secret: PREVIOUS_SECRET, nowMs: now });
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
    withExtra.bookingId = 'attacker-supplied';
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
      v: 1, kid: 'k-2026-08', purpose: 'create', authUserId: 'auth-andres',
      customerId: 'cust-andres', vehicle: 'tesla', pickupAtMs: 1, intentHash: HASH,
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
      { purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres' },
      { purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres', vehicle: 'tesla' }]) {
      const r = verifyQuoteToken(current, { keys, nowMs: now, expected: bad });
      assert.strictEqual(r.reason, 'missing_expectations',
        `incomplete expectations must refuse, not pass: ${JSON.stringify(bad)}`);
    }
    assert.strictEqual(verifyQuoteToken(current, { keys: [], nowMs: now, expected: EXPECT }).reason, 'no_keys');

    // Every binding is enforced, including the two that were silently dropped.
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, purpose: 'edit' } }).reason, 'wrong_purpose');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, customerId: 'cust-other' } }).reason, 'wrong_identity');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, authUserId: 'auth-other' } }).reason, 'wrong_identity');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, vehicle: 'sprinter' } }).reason, 'wrong_vehicle',
      'a vehicle expectation must be ENFORCED, never silently dropped');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { ...EXPECT, intentHash: 'f'.repeat(64) } }).reason, 'wrong_intent',
      'an intentHash expectation must be ENFORCED, never silently dropped');

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
  await check('the RESOLVED place id is canonical: routing, response, and intentHash all use it', async () => {
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
    // ...and so does every token's intentHash.
    const p = decodeTokenPayload(q.vehicles.tesla.token);
    assert.strictEqual(p.intentHash, computeIntentHash({
      mode: 'dropoff', airportCode: 'MIA', placeId: RESOLVED,
      pickupAtMs: Date.parse(pickupAt), passengers: 2, vehicle: 'tesla'
    }), 'the hash 2C recomputes must cover the canonical id');
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

  await check('every vehicle token binds its OWN vehicle in both the payload and the intentHash', async () => {
    const pickupAt = FUTURE_PICKUP();
    const q = JSON.parse((await post(goodIntent({ pickupAt }))).body).quote;
    const hashes = new Set();
    for (const key of Object.keys(q.vehicles)) {
      if (!q.vehicles[key].ok) continue;
      const p = decodeTokenPayload(q.vehicles[key].token);
      assert.strictEqual(p.vehicle, key);
      assert.strictEqual(p.intentHash, computeIntentHash({
        mode: 'dropoff', airportCode: 'MIA', placeId: ADDRESS_PLACE_ID,
        pickupAtMs: Date.parse(pickupAt), passengers: 2, vehicle: key
      }), `${key}'s hash must cover ${key}, not a shared preference`);
      hashes.add(p.intentHash);
      // The token verifies ONLY against its own vehicle.
      const keys = [{ id: 'k-2026-08', secret: CURRENT_SECRET }];
      const expected = {
        purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
        vehicle: key, intentHash: p.intentHash
      };
      assert.strictEqual(verifyQuoteToken(q.vehicles[key].token, { keys, nowMs: Date.now(), expected }).ok, true);
    }
    assert.strictEqual(hashes.size, Object.keys(q.vehicles).filter((k) => q.vehicles[k].ok).length,
      'each vehicle gets a DISTINCT hash — never one shared, contradictory hash');
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
    const HASH = 'a1b2c3d4'.repeat(8);
    const now = Date.now();
    const tok = signQuoteToken({
      purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
      vehicle: 'tesla', pickupAtMs: now + 3600e3, intentHash: HASH,
      routeQuality: 'traffic_aware', finalCents: 4500,
      pricingVersion: 'v', engineVersion: 'e', resolvedVersion: 'v'
    }, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now });
    const EXPECT = {
      purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
      vehicle: 'tesla', intentHash: HASH
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
    const HASH = 'a1b2c3d4'.repeat(8);
    const now = Date.now();
    const tok = signQuoteToken({
      purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
      vehicle: 'tesla', pickupAtMs: now + 3600e3, intentHash: HASH,
      routeQuality: 'traffic_aware', finalCents: 4500,
      pricingVersion: 'v', engineVersion: 'e', resolvedVersion: 'v'
    }, { keyId: 'k-2026-08', secret: CURRENT_SECRET, nowMs: now });
    const EXPECT = {
      purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
      vehicle: 'tesla', intentHash: HASH
    };
    // A 2C author who "pins" the price or the instant this way would
    // otherwise get ok:true with neither actually enforced.
    for (const extra of [{ finalCents: 999999 }, { pickupAtMs: 1 }, { routeQuality: 'fallback' }]) {
      assert.strictEqual(
        verifyQuoteToken(tok, { keys, nowMs: now, expected: { ...EXPECT, ...extra } }).reason,
        'unknown_expectation',
        `expected.${Object.keys(extra)[0]} must fail loudly rather than be ignored`);
    }
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
      assert.ok(!line.includes('auth-andres') && !line.includes('cust-andres'), 'no identities in logs');
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

  if (failures.length) {
    console.error(`\n${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
