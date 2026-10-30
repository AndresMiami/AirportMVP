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
  const savedEnv = {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    ALLOWED_PREVIEW_SITE: process.env.ALLOWED_PREVIEW_SITE,
  };
  function setEnv(name, value) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
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
      await check('managed sandbox fallback pins the preview-origin rule: bounded site name, anchored pattern, placed before the rejection', async () => {
        assert.ok(source.includes('const NETLIFY_SITE_NAME_RE = /^[a-z0-9-]{1,63}$/;'));
        assert.ok(source.includes('`^https://deploy-preview-\\\\d+--${site}\\\\.netlify\\\\.app$`'));
        const ruleAt = source.indexOf('if (isAllowedPreviewOrigin(origin)) {');
        const rejectAt = source.indexOf("callback(new Error('Not allowed by CORS'));");
        assert.ok(ruleAt !== -1 && rejectAt !== -1 && ruleAt < rejectAt);
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

    // ------------------------------------------------------------------
    // CORS origin policy at the real HTTP boundary. The in-memory decision
    // matrix lives in tests/maps-proxy-policy.test.js; this proves the real
    // header round trip (Origin in, Access-Control-Allow-Origin out, real
    // preflight) and that a refused origin keeps today's sanitized 500
    // shape with no origin in any log line.
    // ------------------------------------------------------------------
    const PREVIEW = 'https://deploy-preview-122--i-love-miami.netlify.app';
    const PRODUCTION_ORIGINS = 'https://linkmia.com,https://www.linkmia.com,https://i-love-miami.netlify.app';

    async function corsProbe(origin, { method = 'GET', route = '/health' } = {}) {
      accessLogs.length = 0;
      diagnosticLogs.length = 0;
      const headers = { origin };
      if (method === 'OPTIONS') headers['access-control-request-method'] = 'GET';
      const response = await fetch(`${base}${route}`, { method, headers });
      const text = await response.text();
      await new Promise((resolve) => setImmediate(resolve));
      return {
        status: response.status,
        allowOrigin: response.headers.get('access-control-allow-origin'),
        allowCredentials: response.headers.get('access-control-allow-credentials'),
        allowMethods: response.headers.get('access-control-allow-methods'),
        vary: response.headers.get('vary'),
        contentLength: response.headers.get('content-length'),
        text,
        accessLog: accessLogs.join('\n'),
        diagnostics: [...diagnosticLogs],
      };
    }

    function assertRefusedAsToday(probe, origin) {
      assert.strictEqual(probe.status, 500, `${origin} must be refused`);
      assert.strictEqual(probe.allowOrigin, null, `${origin} must get no Access-Control-Allow-Origin`);
      assert.deepStrictEqual(JSON.parse(probe.text), {
        error: 'Internal server error',
        message: 'Something went wrong!'
      });
      assert.deepStrictEqual(probe.diagnostics, ['maps_proxy_request_failure status=500']);
      // The cors error skips every later middleware, Morgan included, so a
      // refused origin leaves no access-log line at all: the sanitized
      // diagnostic line above is its only trace, and it names no origin.
      assert.strictEqual(probe.accessLog, '', `${origin} must leave no access-log line`);
    }

    await check('ALLOWED_PREVIEW_SITE unset: LinkMia\'s own Deploy Preview origin is refused exactly as today (500 shape, no Access-Control-Allow-Origin, origin never logged) on a GET and on a preflight', async () => {
      setEnv('ALLOWED_PREVIEW_SITE', undefined);
      setEnv('ALLOWED_ORIGINS', PRODUCTION_ORIGINS);
      const providerCallsBefore = providerCalls.length;
      assertRefusedAsToday(await corsProbe(PREVIEW), PREVIEW);
      assertRefusedAsToday(await corsProbe(PREVIEW, { method: 'OPTIONS', route: '/api/places/autocomplete' }), PREVIEW);
      assert.strictEqual(providerCalls.length, providerCallsBefore, 'a refused origin never reaches the provider');
    });

    await check('ALLOWED_PREVIEW_SITE=i-love-miami: the preview origin round-trips a real GET and a real preflight, and the origin is still never logged', async () => {
      setEnv('ALLOWED_PREVIEW_SITE', 'i-love-miami');
      const providerCallsBefore = providerCalls.length;
      const get = await corsProbe(PREVIEW);
      assert.strictEqual(get.status, 200);
      assert.strictEqual(get.allowOrigin, PREVIEW);
      assert.strictEqual(get.allowCredentials, 'true');
      assert.match(get.vary || '', /\bOrigin\b/);
      assert.strictEqual(JSON.parse(get.text).status, 'OK');
      assert.deepStrictEqual(get.diagnostics, []);
      assert.match(get.accessLog, /GET \/health 200/);
      assert.ok(!get.accessLog.includes('deploy-preview'));
      const preflight = await corsProbe(PREVIEW, { method: 'OPTIONS', route: '/api/places/autocomplete' });
      assert.strictEqual(preflight.status, 200);
      assert.strictEqual(preflight.allowOrigin, PREVIEW);
      assert.match(preflight.allowMethods || '', /\bGET\b/);
      assert.strictEqual(preflight.contentLength, '0');
      assert.strictEqual(preflight.text, '');
      assert.deepStrictEqual(preflight.diagnostics, []);
      // cors answers an admitted preflight itself, before Morgan is reached
      // (today's behaviour): no access-log line, so no origin anywhere.
      assert.strictEqual(preflight.accessLog, '');
      assert.strictEqual(providerCalls.length, providerCallsBefore, 'a preflight never reaches the provider');
    });

    await check('ALLOWED_PREVIEW_SITE=i-love-miami admits no other Netlify site\'s preview, no http variant, no look-alike host or path', async () => {
      for (const origin of [
        'https://deploy-preview-7--other-site.netlify.app',
        'http://deploy-preview-122--i-love-miami.netlify.app',
        'https://evil.example/deploy-preview-1--i-love-miami.netlify.app',
        'https://deploy-preview-122--i-love-miami.netlify.app/',
        'https://deploy-preview-122--i-love-miami.netlify.app.evil.example',
        'https://deploy-preview-122--i-love-miami-evil.netlify.app',
      ]) {
        assertRefusedAsToday(await corsProbe(origin), origin);
        assertRefusedAsToday(await corsProbe(origin, { method: 'OPTIONS', route: '/api/places/autocomplete' }), origin);
      }
    });

    await check('the ALLOWED_ORIGINS allowlist is untouched: production origins pass with the preview rule on and off, an unlisted origin never does', async () => {
      for (const site of ['i-love-miami', undefined]) {
        setEnv('ALLOWED_PREVIEW_SITE', site);
        for (const origin of ['https://linkmia.com', 'https://www.linkmia.com', 'https://i-love-miami.netlify.app']) {
          const probe = await corsProbe(origin);
          assert.strictEqual(probe.status, 200, `${origin} with site=${site}`);
          assert.strictEqual(probe.allowOrigin, origin);
        }
        assertRefusedAsToday(await corsProbe('https://evil.example'), 'https://evil.example');
      }
    });

    console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  } catch (error) {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  } finally {
    testSeam.resetMapsGet();
    testSeam.resetLogSinks();
    setEnv('ALLOWED_ORIGINS', savedEnv.ALLOWED_ORIGINS);
    setEnv('ALLOWED_PREVIEW_SITE', savedEnv.ALLOWED_PREVIEW_SITE);
    if (server?.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  }
})();
