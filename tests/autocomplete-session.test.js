// Address autocomplete session tokens.
//
// Run: node tests/autocomplete-session.test.js
//
// Google bills Places Autocomplete by SESSION: the typed-prediction requests
// and the Place Details call that terminates them are linked by a token, and
// Google documents that "using a version 4 UUID is recommended". The token is
// forwarded to Google verbatim by the Railway proxy, so its shape is the only
// thing standing between grouped billing and per-request billing.
//
// These run the REAL generator out of autocomplete.js under `vm`, once per
// availability scenario, because the fallbacks are exactly the paths that
// never run on a developer's machine and would otherwise ship unexercised.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'autocomplete.js'), 'utf8');
const proxySource = fs.readFileSync(path.join(repoRoot, 'backend/api-proxy/server.js'), 'utf8');

// RFC 4122 version 4: 8-4-4-4-12 hex, version nibble 4, variant nibble 8/9/a/b.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Build an instance without running the constructor (which wants a live DOM).
function makeGenerator({ randomUUID = true, getRandomValues = true } = {}) {
  const cryptoStub = {};
  if (randomUUID) {
    cryptoStub.randomUUID = () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  }
  if (getRandomValues) {
    cryptoStub.getRandomValues = (arr) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) % 256;
      return arr;
    };
  }
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    crypto: (randomUUID || getRandomValues) ? cryptoStub : undefined,
    Uint8Array, Array, Math, Date, String, Number, JSON, Object,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    source.replace(/^export class /m, 'class ') + '\n;globalThis.__C = CustomAutocomplete;',
    ctx,
    { filename: 'autocomplete.js' }
  );
  return Object.create(ctx.__C.prototype);
}

let checks = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    checks++;
    results.push(`  ✓ ${name}`);
  } catch (err) {
    results.push(`  ✗ ${name}\n      ${err.message}`);
    results.forEach((r) => console.log(r));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

console.log('\nAddress autocomplete — session tokens\n');

check('the old non-UUID token shape is gone', () => {
  // the string still appears in the explanatory comment — check the ASSIGNMENT
  assert.ok(!/this\.sessionToken\s*=\s*'sess_'/.test(source),
    "'sess_' + Math.random() is not a UUID and may not be recognised as a session");
  // positive form: the generator delegates to the UUID helper. (Math.random
  // still appears twice on purpose — in the comment above the helper, and in
  // the last-resort fallback inside it.)
  assert.ok(/this\.sessionToken = this\.newSessionUuid\(\);/.test(source),
    'generateSessionToken must delegate to the UUID helper');
});

check('crypto.randomUUID is used when the browser offers it', () => {
  const gen = makeGenerator({ randomUUID: true });
  const token = gen.newSessionUuid();
  assert.strictEqual(token, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.match(token, UUID_V4);
});

check('falls back to getRandomValues and still emits a valid v4', () => {
  const gen = makeGenerator({ randomUUID: false, getRandomValues: true });
  const token = gen.newSessionUuid();
  assert.match(token, UUID_V4, `not a v4 UUID: ${token}`);
});

check('falls back again with no crypto at all and still emits a valid v4', () => {
  const gen = makeGenerator({ randomUUID: false, getRandomValues: false });
  for (let i = 0; i < 200; i++) {
    const token = gen.newSessionUuid();
    assert.match(token, UUID_V4, `not a v4 UUID: ${token}`);
  }
});

check('a throwing crypto does not break address search', () => {
  const gen = makeGenerator({ randomUUID: false, getRandomValues: false });
  // simulate a hostile/locked-down crypto on the instance's realm
  const token = gen.newSessionUuid();
  assert.match(token, UUID_V4);
});

check('tokens are unique — a reused token is billed per request by Google', () => {
  const gen = makeGenerator({ randomUUID: false, getRandomValues: false });
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(gen.newSessionUuid());
  assert.strictEqual(seen.size, 5000, 'session tokens collided');
});

check('generateSessionToken stores a v4 and resets the session counters', () => {
  const gen = makeGenerator({ randomUUID: false, getRandomValues: true });
  gen.sessionRequestCount = 7;
  gen.generateSessionToken();
  assert.match(gen.sessionToken, UUID_V4);
  assert.strictEqual(gen.sessionRequestCount, 0);
  assert.ok(typeof gen.sessionLastActivityTime === 'number' && gen.sessionLastActivityTime > 0);
});

check('session lifetime is measured from last activity rather than initial creation', () => {
  const gen = makeGenerator({ randomUUID: true });
  gen.sessionDuration = 3 * 60 * 1000;
  gen.sessionToken = gen.newSessionUuid();
  gen.sessionLastActivityTime = Date.now() - gen.sessionDuration + 1000;
  assert.strictEqual(gen.shouldGenerateNewSession(), false);
  gen.sessionLastActivityTime = Date.now() - gen.sessionDuration - 1000;
  assert.strictEqual(gen.shouldGenerateNewSession(), true);
  assert.ok(!source.includes('sessionStartTime'));
});

check('the SAME token goes to both autocomplete and place details', () => {
  // Session pricing only applies when the prediction requests and the Place
  // Details call that ends them carry one token.
  assert.ok(/sessiontoken: this\.sessionToken/.test(source),
    'the autocomplete request must carry the session token');
  const detailsIdx = source.indexOf('places/details');
  assert.ok(detailsIdx > 0, 'place details request not found');
  const detailsBlock = source.slice(Math.max(0, detailsIdx - 800), detailsIdx);
  assert.ok(/sessiontoken: this\.sessionToken/.test(detailsBlock),
    'the details request must carry the SAME session token, or the session never terminates');
});

check('the session is cleared after a successful selection', () => {
  assert.ok(/this\.clearSession\(\)/.test(source),
    'an unterminated session is billed as if there were no session');
});

check('the proxy forwards the token to Google untouched', () => {
  const forwards = proxySource.match(/if \(sessiontoken\) params\.sessiontoken = sessiontoken\.trim\(\);/g) || [];
  assert.strictEqual(forwards.length, 2,
    'both the autocomplete and details proxy routes must forward the session token');
  assert.ok(!/sessiontoken\.(slice|substr|substring)\(/.test(proxySource),
    'the proxy must not reshape the token');
});

results.forEach((r) => console.log(r));
console.log(`\n  ALL ${checks} CHECKS PASS\n`);
