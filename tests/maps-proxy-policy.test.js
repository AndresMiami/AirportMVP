// Railway Maps proxy policy and cost boundaries.
//
// This is intentionally a runtime test: it executes the real Express route
// middleware in memory and substitutes only the outbound Google transport.
// No listening socket is needed, so the suite also runs in restricted CI.
// Run: node tests/maps-proxy-policy.test.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_MAPS_API_KEY = 'TEST_MAPS_KEY_MUST_NOT_APPEAR_IN_LOGS';

const { app, testSeam } = require('../backend/api-proxy/server');

const ADDRESS_SENTINEL = '7315 Policy Secret Street';
const TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PLACE_ID = 'ChIJPolicyBoundary123';
const MIA_PLACE_ID = 'ChIJLSeUuFi32YgRgpwdRDtxYkg';
const LONG_PLACE_ID = 'Ep' + 'A1b2C3d4_-'.repeat(70);

let checks = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    checks++;
    results.push(`  ✓ ${name}`);
  } catch (error) {
    results.push(`  ✗ ${name}\n      ${error.message}`);
    throw error;
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(String(name).toLowerCase()) || null; },
    set(values) {
      Object.entries(values).forEach(([name, value]) => this.setHeader(name, value));
      return this;
    },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

function routeLayer(method, pathname) {
  return app._router.stack.find((layer) =>
    layer.route?.path === pathname && layer.route.methods[method.toLowerCase()]);
}

async function invokeRoute(method, requestPath, options = {}) {
  const url = new URL(requestPath, 'https://linkmia.test');
  const layer = routeLayer(method, url.pathname);
  assert.ok(layer, `route not found: ${method} ${url.pathname}`);
  const req = {
    method: method.toUpperCase(),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    body: options.body ? JSON.parse(options.body) : {},
    headers: options.headers || {},
  };
  const res = makeResponse();
  for (const item of layer.route.stack) {
    let nextCalled = false;
    let nextError = null;
    const result = item.handle(req, res, (error) => {
      nextCalled = true;
      nextError = error || null;
    });
    await result;
    if (nextError) throw nextError;
    if (!nextCalled) break;
  }
  return {
    status: res.statusCode,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers: { get: (name) => res.getHeader(name) },
    json: async () => res.body,
  };
}

async function invokeError(error) {
  const layer = app._router.stack.find((candidate) =>
    !candidate.route && candidate.handle?.length === 4);
  assert.ok(layer, 'Express error middleware not found');
  const res = makeResponse();
  await layer.handle(error, { path: '/api/directions' }, res, () => {});
  return { status: res.statusCode, json: async () => res.body };
}

(async () => {
  const accessLogs = [];
  const diagnosticLogs = [];
  let providerCalls = [];

  function installProviderStub() {
    providerCalls = [];
    testSeam.setMapsGet(async (url, config = {}) => {
      providerCalls.push({ url, params: { ...(config.params || {}) } });

      if (url.includes('/place/autocomplete/')) {
        return {
          data: {
            status: 'OK',
            predictions: [{
              place_id: PLACE_ID,
              description: `${ADDRESS_SENTINEL}, Miami, FL`,
              structured_formatting: {
                main_text: ADDRESS_SENTINEL,
                secondary_text: 'Miami, FL'
              },
              types: ['street_address']
            }]
          }
        };
      }

      if (url.includes('/place/details/')) {
        return {
          data: {
            status: 'OK',
            // Google returns html_attributions regardless of the field mask;
            // policy requires DISPLAYING third-party attribution. The second
            // entry is a hostile fixture: the sanitizer must strip markup and
            // refuse the javascript: href.
            html_attributions: [
              '<a href="https://listings.example.com/p/1">Listings by Example</a>',
              '<script>alert(1)</script><a href="javascript:alert(2)">Evil Co</a>'
            ],
            result: {
              formatted_address: `${ADDRESS_SENTINEL}, Miami, FL 33101`,
              name: 'UNREQUESTED_NAME',
              photos: ['UNREQUESTED_PHOTO'],
              geometry: {
                location: { lat: 25.76, lng: -80.19 },
                viewport: { secret: 'UNREQUESTED_VIEWPORT' }
              }
            }
          }
        };
      }

      if (url.includes('/directions/')) {
        return {
          data: {
            status: 'OK',
            routes: [{
              overview_polyline: { points: 'UNREQUESTED_POLYLINE' },
              legs: [{
                distance: { text: '10 mi', value: 16093 },
                duration: { text: '20 mins', value: 1200 },
                duration_in_traffic: { text: '24 mins', value: 1440 }
              }]
            }]
          }
        };
      }

      if (url.includes('/geocode/')) {
        return { data: { status: 'OK', results: [] } };
      }

      throw new Error('unexpected outbound URL');
    });
  }

  try {
    testSeam.setAccessLogSink((line) => accessLogs.push(line));
    testSeam.setDiagnosticLogSink((line) => diagnosticLogs.push(line));
    installProviderStub();

    async function request(requestPath, options) {
      return invokeRoute(options?.method || 'GET', requestPath, options);
    }

    console.log('\nRailway Maps proxy policy boundaries\n');

    await check('Importing the server neither listens nor leaves its daily timer referenced', async () => {
      const child = spawnSync(process.execPath, ['-e', [
        "require('./backend/api-proxy/server')",
        "process.stdout.write('module-loaded')"
      ].join(';')], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 2000
      });
      assert.strictEqual(child.error, undefined, child.error?.message);
      assert.strictEqual(child.status, 0, child.stderr);
      assert.strictEqual(child.stdout, 'module-loaded');
      assert.ok(!child.stderr.includes('running on port'));
    });

    await check('Access-log labels derive from immutable originalUrl and never expose unmatched path data', async () => {
      assert.strictEqual(
        testSeam.safeAccessPath(`/api/places/autocomplete?input=${encodeURIComponent(ADDRESS_SENTINEL)}&sessiontoken=${TOKEN}`),
        '/api/places/autocomplete'
      );
      assert.strictEqual(
        testSeam.safeAccessPath(`/api/places/details/${encodeURIComponent(ADDRESS_SENTINEL)}?sessiontoken=${TOKEN}`),
        '/api/:unmatched'
      );
      assert.strictEqual(testSeam.safeAccessPath(`/tracking/${TOKEN}`), '/tracking/:tripId');
      // Express serves trailing-slash and case variants of real routes, so
      // classification must too — a request the router answered must never
      // be logged as unmatched (telemetry correctness, Codex round 2).
      assert.strictEqual(testSeam.safeAccessPath('/api/places/details/?place_id=x'), '/api/places/details');
      assert.strictEqual(testSeam.safeAccessPath('/API/Places/Autocomplete?input=x'), '/api/places/autocomplete');
      assert.strictEqual(testSeam.safeAccessPath('/api/directions///'), '/api/directions');
      assert.strictEqual(testSeam.safeAccessPath('/api/definitely-not-a-route'), '/api/:unmatched');
      assert.strictEqual(testSeam.safeAccessPath('/HEALTH/'), '/health');
    });

    await check('Third-party attributions pass through SANITIZED — text and https hrefs only, hostile markup dies', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const query = new URLSearchParams({ place_id: PLACE_ID, sessiontoken: TOKEN });
      const response = await request(`/api/places/details?${query}`);
      const body = await response.json();
      assert.deepStrictEqual(body.attributions, [
        { text: 'Listings by Example', href: 'https://listings.example.com/p/1' },
        { text: 'alert(1) Evil Co', href: null }
      ], 'markup stripped, javascript: href refused, text preserved');
      assert.ok(!JSON.stringify(body.attributions).includes('<'),
        'no raw markup may cross the proxy boundary');

      // Pure-function edges: non-arrays, oversized entries, and bounded count.
      assert.deepStrictEqual(testSeam.sanitizeAttributions(undefined), []);
      assert.deepStrictEqual(testSeam.sanitizeAttributions('nope'), []);
      assert.deepStrictEqual(testSeam.sanitizeAttributions(['x'.repeat(1001)]), []);
      assert.strictEqual(testSeam.sanitizeAttributions(
        Array(10).fill('<a href="https://a.example">A</a>')).length, 4,
        'attribution count is bounded');
      assert.deepStrictEqual(testSeam.sanitizeAttributions(
        ['<a href=\'https://b.example/x\'>B</a>']),
        [{ text: 'B', href: 'https://b.example/x' }], 'single-quoted hrefs parse too');
    });

    await check('The proxy is deployment-layout safe and its place-ID rules match the quote service exactly', async () => {
      const proxySource = fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'api-proxy', 'server.js'), 'utf8');
      assert.ok(!/require\(['"]\.\.\/functions/.test(proxySource),
        'Railway\'s documented root is /backend/api-proxy — no import may reach outside it');
      const identity = require('../backend/functions/lib/place-identity');
      assert.strictEqual(testSeam.MAX_PLACE_ID_LEN, identity.MAX_PLACE_ID_LEN,
        'the local bound must equal the ratified place-identity bound');
      for (const [candidate, expected] of [
        [LONG_PLACE_ID, true],
        ['ChIJLSeUuFi32YgRgpwdRDtxYkg', true],
        ['C'.repeat(2048), true],
        ['C'.repeat(2049), false],
        ['short', false],
        ['ChIJ!bad$chars', false],
        [12345, false]
      ]) {
        assert.strictEqual(testSeam.isValidPlaceId(candidate), expected,
          `proxy verdict for ${String(candidate).slice(0, 24)}…`);
        if (typeof candidate === 'string') {
          assert.strictEqual(identity.isValidPlaceId(candidate), expected,
            'the two validators must agree on every candidate');
        }
      }
    });

    await check('Autocomplete is live-only, no-store and uses only pinned provider params', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      accessLogs.length = 0;

      const query = new URLSearchParams({
        input: ADDRESS_SENTINEL,
        sessiontoken: TOKEN,
        location: '1,2',
        radius: '999999',
        types: 'airport',
        components: 'country:xx'
      });
      const first = await request(`/api/places/autocomplete?${query}`);
      const second = await request(`/api/places/autocomplete?${query}`);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(first.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.strictEqual(providerCalls.length, 2, 'identical requests must both reach Google');

      for (const call of providerCalls) {
        assert.deepStrictEqual(call.params, {
          input: ADDRESS_SENTINEL,
          key: process.env.GOOGLE_MAPS_API_KEY,
          components: 'country:us',
          location: '25.7617,-80.1918',
          radius: '30000',
          sessiontoken: TOKEN
        });
      }

      const stats = testSeam.getApiUsageStats().autocomplete;
      assert.deepStrictEqual(stats, { acceptedRouteRequests: 2, providerAttempts: 2 });
    });

    await check('Rejected route input counts after admission but never as a provider attempt', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const response = await request('/api/places/autocomplete?input=&sessiontoken=not-a-uuid');
      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.strictEqual(providerCalls.length, 0);
      assert.deepStrictEqual(testSeam.getApiUsageStats().autocomplete,
        { acceptedRouteRequests: 1, providerAttempts: 0 });
    });

    await check('Place Details is live-only and hostile fields never reach Google or the response', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const query = new URLSearchParams({
        place_id: PLACE_ID,
        sessiontoken: TOKEN,
        fields: 'name,photos,reviews,geometry,formatted_address'
      });
      const first = await request(`/api/places/details?${query}`);
      const firstBody = await first.json();
      const second = await request(`/api/places/details?${query}`);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(first.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.strictEqual(providerCalls.length, 2);
      for (const call of providerCalls) {
        assert.strictEqual(call.params.fields, 'geometry,formatted_address');
        assert.ok(!Object.hasOwn(call.params, 'name'));
      }
      assert.deepStrictEqual(firstBody.result.geometry, {
        location: { lat: 25.76, lng: -80.19 }
      });
      assert.ok(!Object.hasOwn(firstBody.result, 'name'));
      assert.ok(!JSON.stringify(firstBody).includes('UNREQUESTED'));
      assert.deepStrictEqual(testSeam.getApiUsageStats().placeDetails,
        { acceptedRouteRequests: 2, providerAttempts: 2 });
    });

    await check('A former airport shortcut cannot bypass live Place Details', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const query = new URLSearchParams({ place_id: MIA_PLACE_ID, sessiontoken: TOKEN });
      await request(`/api/places/details?${query}`);
      await request(`/api/places/details?${query}`);
      assert.strictEqual(providerCalls.length, 2,
        'the former MIA shortcut must not answer from local content');
      assert.deepStrictEqual(testSeam.getApiUsageStats().placeDetails,
        { acceptedRouteRequests: 2, providerAttempts: 2 });
    });

    await check('Place Details shares the quote service 2048-character Place ID boundary', async () => {
      assert.ok(LONG_PLACE_ID.length > 600 && LONG_PLACE_ID.length < 2048);
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const accepted = new URLSearchParams({ place_id: LONG_PLACE_ID, sessiontoken: TOKEN });
      const response = await request(`/api/places/details?${accepted}`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(providerCalls.length, 1);
      assert.strictEqual(providerCalls[0].params.place_id, LONG_PLACE_ID);

      providerCalls = [];
      const refused = new URLSearchParams({ place_id: 'C'.repeat(2049), sessiontoken: TOKEN });
      const tooLong = await request(`/api/places/details?${refused}`);
      assert.strictEqual(tooLong.status, 400);
      assert.strictEqual(providerCalls.length, 0);
    });

    await check('Directions is live-only and ignores unapproved route-expansion parameters', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const body = JSON.stringify({
        origin: ADDRESS_SENTINEL,
        destination: '25.7931,-80.2906',
        mode: 'walking',
        waypoints: 'SECRET_WAYPOINT',
        alternatives: true,
        avoid: 'tolls'
      });
      const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
      const first = await request('/api/directions', options);
      const firstBody = await first.json();
      const second = await request('/api/directions', options);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(first.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.strictEqual(providerCalls.length, 2);
      for (const call of providerCalls) {
        assert.deepStrictEqual(call.params, {
          origin: ADDRESS_SENTINEL,
          destination: '25.7931,-80.2906',
          key: process.env.GOOGLE_MAPS_API_KEY,
          mode: 'driving',
          departure_time: 'now',
          traffic_model: 'best_guess'
        });
      }
      assert.ok(!JSON.stringify(firstBody).includes('POLYLINE'));
      assert.deepStrictEqual(firstBody.route, {
        distance: { value: 16093 },
        duration: { value: 1200 },
        duration_in_traffic: { value: 1440 }
      });
      assert.deepStrictEqual(testSeam.getApiUsageStats().directions,
        { acceptedRouteRequests: 2, providerAttempts: 2 });
    });

    await check('Geocoding is no-store and forwards only its bounded public contract', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const query = new URLSearchParams({
        address: ADDRESS_SENTINEL,
        components: 'country:US',
        extra: 'MUST_NOT_REACH_PROVIDER'
      });
      const response = await request(`/api/geocoding?${query}`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.strictEqual(providerCalls.length, 1);
      assert.deepStrictEqual(providerCalls[0].params, {
        key: process.env.GOOGLE_MAPS_API_KEY,
        address: ADDRESS_SENTINEL,
        components: 'country:US'
      });
      assert.deepStrictEqual(testSeam.getApiUsageStats().geocoding,
        { acceptedRouteRequests: 1, providerAttempts: 1 });
    });

    await check('Out-of-range coordinates are rejected before a provider attempt', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      const response = await request('/api/geocoding?latlng=999%2C999');
      assert.strictEqual(response.status, 400);
      assert.strictEqual(providerCalls.length, 0);
      assert.deepStrictEqual(testSeam.getApiUsageStats().geocoding,
        { acceptedRouteRequests: 1, providerAttempts: 0 });
    });

    await check('HTTP-200 provider diagnostics are mapped to a fixed geocoding failure', async () => {
      testSeam.resetApiUsageStats();
      diagnosticLogs.length = 0;
      testSeam.setMapsGet(async () => ({
        data: {
          status: 'REQUEST_DENIED',
          error_message: `${ADDRESS_SENTINEL} ${process.env.GOOGLE_MAPS_API_KEY}`
        }
      }));
      const response = await request('/api/geocoding?address=Miami');
      const body = await response.json();
      assert.strictEqual(response.status, 502);
      assert.deepStrictEqual(body, { error: 'Provider request failed', status: 'ERROR' });
      assert.deepStrictEqual(diagnosticLogs,
        ['maps_provider_failure endpoint=geocoding status=semantic_failure']);
      assert.ok(!JSON.stringify(body).includes('REQUEST_DENIED'));
      assert.ok(!diagnosticLogs.join('\n').includes(ADDRESS_SENTINEL));
      assert.deepStrictEqual(testSeam.getApiUsageStats().geocoding,
        { acceptedRouteRequests: 1, providerAttempts: 1 });
      installProviderStub();
    });

    await check('Provider failures expose and log only fixed classifications', async () => {
      testSeam.resetApiUsageStats();
      diagnosticLogs.length = 0;
      testSeam.setMapsGet(async () => {
        const error = new Error(`${ADDRESS_SENTINEL} ${TOKEN} ${process.env.GOOGLE_MAPS_API_KEY}`);
        error.response = { status: 403, data: { place_id: PLACE_ID } };
        throw error;
      });
      const query = new URLSearchParams({ place_id: PLACE_ID, sessiontoken: TOKEN });
      const response = await request(`/api/places/details?${query}`);
      const body = await response.json();
      assert.strictEqual(response.status, 500);
      assert.deepStrictEqual(body, { error: 'Internal Server Error', status: 'ERROR' });
      assert.deepStrictEqual(diagnosticLogs, ['maps_provider_failure endpoint=placeDetails status=403']);
      const logs = diagnosticLogs.join('\n');
      for (const secret of [ADDRESS_SENTINEL, TOKEN, PLACE_ID, process.env.GOOGLE_MAPS_API_KEY]) {
      assert.ok(!logs.includes(secret), `diagnostic log leaked ${secret}`);
      }
      assert.deepStrictEqual(testSeam.getApiUsageStats().placeDetails,
        { acceptedRouteRequests: 1, providerAttempts: 1 });
      installProviderStub();
    });

    await check('Request parser failures are sanitized without logging the body or stack', async () => {
      diagnosticLogs.length = 0;
      const error = new SyntaxError(`Malformed ${ADDRESS_SENTINEL}`);
      error.status = 400;
      const response = await invokeError(error);
      assert.strictEqual(response.status, 400);
      assert.deepStrictEqual(diagnosticLogs, ['maps_proxy_request_failure status=400']);
      assert.ok(!diagnosticLogs.join('\n').includes(ADDRESS_SENTINEL));
    });

    await check('Usage summary reports route-admitted requests and actual provider attempts, never a dollar estimate', async () => {
      testSeam.resetApiUsageStats();
      providerCalls = [];
      await request('/api/places/autocomplete?input=');
      const valid = new URLSearchParams({ input: ADDRESS_SENTINEL, sessiontoken: TOKEN });
      await request(`/api/places/autocomplete?${valid}`);
      const response = await request('/api/usage-stats');
      const body = await response.json();
      assert.strictEqual(body.summary.acceptedRouteRequests, 2);
      assert.strictEqual(body.summary.providerAttempts, 1);
      assert.ok(!Object.hasOwn(body.summary, 'estimatedMonthlyCost'));
      assert.ok(!JSON.stringify(body).includes('monthlyCredit'));
    });

    await check('The nonexistent runtime cost dashboard stays retired', async () => {
      assert.strictEqual(routeLayer('GET', '/dashboard.html'), undefined);
    });

    results.forEach((line) => console.log(line));
    console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  } catch (error) {
    results.forEach((line) => console.log(line));
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  } finally {
    testSeam.resetMapsGet();
    testSeam.resetLogSinks();
  }
})();
