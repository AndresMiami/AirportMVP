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
process.env.QUOTE_SIGNING_CURRENT_ID = 'k-2026-08';
process.env.QUOTE_SIGNING_CURRENT_SECRET = 'current-secret';
process.env.QUOTE_SIGNING_PREVIOUS_ID = 'k-2026-07';
process.env.QUOTE_SIGNING_PREVIOUS_SECRET = 'previous-secret';
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
const { computeIntentHash, verifyQuoteToken, signQuoteToken, QUOTE_TTL_MS } = require(path.join(repoRoot, 'backend/functions/lib/quote-token.js'));
const { resolveRateCard } = require(path.join(repoRoot, 'backend/functions/lib/rate-card-resolver.js'));
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
      ['origin', 'MIA'], ['destination', 'x'], ['token', 'abc']
    ]) {
      const r = await post(goodIntent({ [field]: value }));
      assert.strictEqual(r.statusCode, 400, `field ${field} must be rejected`);
      assert.ok(JSON.parse(r.body).error.includes(field), `rejection must name ${field}`);
    }
    assert.strictEqual(googleCalls(), 0);
  });

  await check('intent validation: mode/airport/placeId/pickupAt/passengers/vehicle each refuse malformed values', async () => {
    const bads = [
      [{ mode: 'hourly' }], [{ airportCode: 'JFK' }], [{ airportCode: null }],
      [{ placeId: 'x' }], [{ placeId: 'bad place id!' }], [{ placeId: 'C'.repeat(300) }],
      [{ placeId: 42 }], [{ pickupAt: 'tomorrow' }], [{ pickupAt: 12345 }],
      [{ passengers: 0 }], [{ passengers: 2.5 }], [{ passengers: '2' }],
      [{ vehicle: 'suv' }], [{ vehicle: 'TESLA' }]
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

  await check('provider failures are honest 502s, never fabricated prices; Places failure skips Routes', async () => {
    state.placesResponse = () => ({ ok: false, status: 500, json: async () => ({}) });
    let r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502);
    assert.strictEqual(state.routesCalls.length, 0, 'no route call after a failed identity resolution');
    resetState();
    state.routesResponse = () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; };
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502);
    resetState();
    state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 16093, duration: '28min' }] }) });
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502, 'malformed duration format must refuse — strict parsing');
    resetState();
    state.routesResponse = () => ({ ok: true, status: 200, json: async () => ({ routes: [] }) });
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502);
    resetState();
    state.routesResponse = () => ({ ok: false, status: 429, json: async () => ({}) });
    r = await post(goodIntent());
    assert.strictEqual(r.statusCode, 502);
    assert.strictEqual(state.routesCalls.length, 1, 'exactly ONE attempt — no blind retries');
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
    const { card } = resolveRateCard({});
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
      pickupAtMs: Date.parse(pickupAt), passengers: 2, vehicle: null
    });
    assert.strictEqual(p.intentHash, expectedHash, 'the token binds the EXACT intent by hash');
    const raw = JSON.stringify(p);
    assert.ok(!raw.includes(ADDRESS_PLACE_ID) && !raw.includes('Test St') && !raw.includes('lat'),
      'no place IDs, addresses, or coordinates may transit the client inside a token');
    assert.ok(!('routeMiles' in p) && !('routeMinutes' in p),
      'intentHash INSTEAD of raw route facts — facts live in the response only (plan v3)');
    assert.strictEqual(p.routeQuality, 'traffic_aware', 'routeQuality is the one required route field');
    assert.strictEqual(p.exp - p.iat, QUOTE_TTL_MS);
    assert.strictEqual(q.ttlMinutes, 15, 'TTL is the deliberate 15-minute price-hold policy');
  });

  await check('token verification: current + previous keys, tamper/expiry/purpose/identity rejections', async () => {
    const keys = [
      { id: 'k-2026-08', secret: 'current-secret' },
      { id: 'k-2026-07', secret: 'previous-secret' }
    ];
    const base = {
      purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres',
      vehicle: 'tesla', pickupAtMs: Date.now() + 3600e3, intentHash: 'h'.repeat(64),
      routeQuality: 'traffic_aware',
      finalCents: 4500, pricingVersion: 'v', engineVersion: 'e', resolvedVersion: 'v'
    };
    const now = Date.now();
    const current = signQuoteToken(base, { keyId: 'k-2026-08', secret: 'current-secret', nowMs: now });
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now + 60000, expected: { purpose: 'create', authUserId: 'auth-andres', customerId: 'cust-andres' } }).ok, true);
    // Rotation: a token signed by the PREVIOUS key still verifies.
    const previous = signQuoteToken(base, { keyId: 'k-2026-07', secret: 'previous-secret', nowMs: now });
    assert.strictEqual(verifyQuoteToken(previous, { keys, nowMs: now + 60000, expected: {} }).ok, true);
    // Unknown kid refuses.
    const foreign = signQuoteToken(base, { keyId: 'k-9999', secret: 'x', nowMs: now });
    assert.strictEqual(verifyQuoteToken(foreign, { keys, nowMs: now }).reason, 'unknown_key');
    // Tampered cents break the seal.
    const [payloadB64, sig] = current.split('.');
    const tampered = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    tampered.finalCents = 100;
    const forged = Buffer.from(JSON.stringify(tampered)).toString('base64url') + '.' + sig;
    assert.strictEqual(verifyQuoteToken(forged, { keys, nowMs: now }).reason, 'bad_signature');
    // Expiry honors the 15-minute hold.
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now + QUOTE_TTL_MS + 1, expected: {} }).reason, 'expired');
    // Purpose and identity binding.
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { purpose: 'edit' } }).reason, 'wrong_purpose');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { customerId: 'cust-other' } }).reason, 'wrong_identity');
    assert.strictEqual(verifyQuoteToken(current, { keys, nowMs: now, expected: { authUserId: 'auth-other' } }).reason, 'wrong_identity');
    assert.strictEqual(verifyQuoteToken('garbage', { keys, nowMs: now }).reason, 'malformed');
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
