// Real HTTP boundary for the Railway Maps proxy.
//
// GitHub CI must execute the actual loopback server, proving Express request
// parsing and Morgan output. Codex's managed filesystem sandbox prohibits all
// socket listening (EPERM), so only that environment uses the explicit source
// fallback below. Run: node tests/maps-proxy-http-integration.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_MAPS_API_KEY = 'AIza_HTTP_TEST_KEY';

const { startServer, testSeam } = require('../backend/api-proxy/server');
const source = fs.readFileSync(
  path.join(__dirname, '..', 'backend', 'api-proxy', 'server.js'), 'utf8');

const ADDRESS = '9123 HTTP Boundary Street';
const TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let checks = 0;

async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('\nRailway Maps proxy — real HTTP integration\n');
  const accessLogs = [];
  const diagnosticLogs = [];
  const providerCalls = [];
  let server;

  testSeam.setAccessLogSink((line) => accessLogs.push(line));
  testSeam.setDiagnosticLogSink((line) => diagnosticLogs.push(line));
  testSeam.setMapsGet(async (url, config = {}) => {
    providerCalls.push({ url, params: config.params });
    return { data: { status: 'OK', predictions: [] } };
  });

  try {
    try {
      server = startServer(0, '127.0.0.1');
      await once(server, 'listening');
    } catch (error) {
      if (process.env.GITHUB_ACTIONS === 'true' || error?.code !== 'EPERM') throw error;

      await check('managed sandbox fallback keeps the production listen guard pinned', async () => {
        assert.match(source, /if \(require\.main === module\)\s*\{\s*startServer\(\);\s*\}/);
        assert.match(source, /module\.exports = \{ app, startServer, testSeam \};/);
      });
      await check('managed sandbox fallback pins path-only logging and fixed parser errors', async () => {
        assert.match(source, /morgan\(':method :safe-path :status :response-time ms',\s*\{/);
        assert.match(source, /safeAccessPath\(req\.originalUrl\)/);
        assert.match(source, /maps_proxy_request_failure status=\$\{safeStatus\}/);
        assert.ok(!/morgan\([^\n]*:url/.test(source));
      });
      console.log('\n  Managed sandbox blocked loopback listen; GitHub CI must run the HTTP branch.');
      console.log(`\n  ALL ${checks} CHECKS PASS\n`);
      return;
    }

    const base = `http://127.0.0.1:${server.address().port}`;

    await check('real Express + Morgan path logs omit address and session token', async () => {
      const query = new URLSearchParams({ input: ADDRESS, sessiontoken: TOKEN });
      const response = await fetch(`${base}/api/places/autocomplete?${query}`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.strictEqual(providerCalls.length, 1);
      await new Promise((resolve) => setImmediate(resolve));
      const logs = accessLogs.join('\n');
      assert.match(logs, /GET \/api\/places\/autocomplete 200/);
      assert.ok(!logs.includes(ADDRESS));
      assert.ok(!logs.includes(TOKEN));
    });

    await check('hostile path segments are reduced to a fixed unmatched-route label', async () => {
      accessLogs.length = 0;
      const encodedAddress = encodeURIComponent(ADDRESS);
      const response = await fetch(
        `${base}/api/places/details/${encodedAddress}?sessiontoken=${encodeURIComponent(TOKEN)}`
      );
      assert.strictEqual(response.status, 404);
      await new Promise((resolve) => setImmediate(resolve));
      const logs = accessLogs.join('\n');
      assert.match(logs, /GET \/api\/:unmatched 404/);
      assert.ok(!logs.includes(ADDRESS));
      assert.ok(!logs.includes(encodedAddress));
      assert.ok(!logs.includes(TOKEN));
      assert.strictEqual(providerCalls.length, 1);
    });

    await check('real JSON parser errors expose and log no submitted body', async () => {
      diagnosticLogs.length = 0;
      const response = await fetch(`${base}/api/directions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"origin":"${ADDRESS}",BROKEN`
      });
      assert.strictEqual(response.status, 400);
      const body = await response.json();
      assert.deepStrictEqual(body, {
        error: 'Bad Request',
        message: 'Request could not be processed'
      });
      assert.deepStrictEqual(diagnosticLogs, ['maps_proxy_request_failure status=400']);
      assert.ok(!diagnosticLogs.join('\n').includes(ADDRESS));
    });

    console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  } catch (error) {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  } finally {
    testSeam.resetMapsGet();
    testSeam.resetLogSinks();
    if (server?.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  }
})();
