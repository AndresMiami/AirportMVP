// Driver push-subscription endpoint harness.
//
// Run: node tests/driver-push-subscription.test.js
//
// Pattern (tests/driver-identity.test.js): mock @supabase/supabase-js
// via require.cache and run the REAL handler. The contract under test:
// authenticated driver + device binding, strict payload validation
// (junk is 400 and never stored), 409 on a cross-driver endpoint (never
// reassigned), activated_at stamped on every enable, and — above all —
// endpoints and encryption keys NEVER leaving the server (GET exposes
// only a sha256 fingerprint).

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.VAPID_PUBLIC_KEY = Buffer.alloc(65, 1).toString('base64url');
process.env.VAPID_PRIVATE_KEY = Buffer.alloc(32, 2).toString('base64url');
process.env.VAPID_SUBJECT = 'mailto:test@example.test';

// ---------- fixtures ----------
const TOKENS = {
  'tok-andres': { id: 'auth-a' },
  'tok-nodrv': { id: 'auth-x' }
};
const DRIVERS_BY_USER = {
  'auth-a': { id: 'drv-a', name: 'Andres', status: 'active' }
};
const DEV_A = '11111111-2222-4333-8444-555555555555';
const DEV_B = '99999999-8888-4777-8666-555555555555';
const GOOD_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const GOOD_KEYS = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };

let SUBS = [];
let capturedUpsert = null;
let capturedDeletes = [];
let upsertError = null;   // inject returned error
let upsertEmpty = false;  // inject empty success
let upsertThrow = null;   // inject thrown client/network error

function resetState() {
  SUBS = [];
  capturedUpsert = null;
  capturedDeletes = [];
  upsertError = null;
  upsertEmpty = false;
  upsertThrow = null;
}

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => TOKENS[token]
        ? { data: { user: TOKENS[token] }, error: null }
        : { data: { user: null }, error: { status: 401, message: 'bad' } }
    },
    from: (table) => {
      if (table === 'drivers') {
        return {
          select: () => ({
            eq: (col, val) => ({
              single: async () => {
                const row = DRIVERS_BY_USER[val];
                return row ? { data: row, error: null } : { data: null, error: { message: 'none' } };
              }
            })
          })
        };
      }
      if (table === 'push_subscriptions') {
        return {
          select: (cols) => ({
            eq: (c1, v1) => ({
              eq: (c2, v2) => ({
                maybeSingle: async () => ({
                  data: SUBS.find((s) => s[c1] === v1 && s[c2] === v2) || null,
                  error: null
                })
              }),
              maybeSingle: async () => ({
                data: SUBS.find((s) => s[c1] === v1) || null,
                error: null
              })
            })
          }),
          delete: () => {
            const filters = [];
            const chain = {
              eq(col, val) { filters.push({ t: 'eq', col, val }); return chain; },
              neq(col, val) { filters.push({ t: 'neq', col, val }); return chain; },
              then(res, rej) {
                capturedDeletes.push(filters.slice());
                SUBS = SUBS.filter((s) => !filters.every((f) =>
                  f.t === 'eq' ? s[f.col] === f.val : s[f.col] !== f.val));
                return Promise.resolve({ data: null, error: null }).then(res, rej);
              }
            };
            return chain;
          },
          upsert: (rows) => ({
            select: async () => {
              if (upsertThrow) throw upsertThrow;
              if (upsertError) return { data: null, error: upsertError };
              capturedUpsert = rows[0];
              if (upsertEmpty) return { data: [], error: null };
              return { data: [{ id: 'sub-new' }], error: null };
            }
          })
        };
      }
      throw new Error('unexpected table: ' + table);
    }
  })
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const fn = require(path.join(repoRoot, 'backend/functions/driver-push-subscription.js'));

const call = (method, { token, query, body } = {}) => fn.handler({
  httpMethod: method,
  headers: token ? { authorization: `Bearer ${token}`, 'user-agent': 'test-agent' } : {},
  queryStringParameters: query || null,
  body: body ? JSON.stringify(body) : null
});
let passed = 0;
function check(name, f) { f(); passed++; console.log('✓ ' + name); }

(async () => {
  // ---------- auth ----------
  resetState();
  let r = await call('GET', { query: { deviceId: DEV_A } });
  check('no token -> 401', () => assert.strictEqual(r.statusCode, 401));
  r = await call('GET', { token: 'tok-nodrv', query: { deviceId: DEV_A } });
  check('no drivers row -> 403', () => assert.strictEqual(r.statusCode, 403));

  // ---------- GET states + secret discipline ----------
  resetState();
  r = await call('GET', { token: 'tok-andres', query: { deviceId: 'not-a-uuid' } });
  check('GET invalid deviceId -> 400', () => assert.strictEqual(r.statusCode, 400));
  r = await call('GET', { token: 'tok-andres', query: { deviceId: DEV_A } });
  check('GET no row -> state none + fully validated VAPID public key', () => {
    const body = JSON.parse(r.body);
    assert.strictEqual(body.state, 'none');
    assert.strictEqual(body.pushConfigured, true);
    assert.strictEqual(body.vapidPublicKey, process.env.VAPID_PUBLIC_KEY);
    assert.ok(!('endpointFingerprint' in body));
  });
  const validPublicKey = process.env.VAPID_PUBLIC_KEY;
  process.env.VAPID_PUBLIC_KEY = 'truncated-but-nonempty';
  r = await call('GET', { token: 'tok-andres', query: { deviceId: DEV_A } });
  check('GET with corrupt VAPID config does not advertise Push availability', () => {
    const body = JSON.parse(r.body);
    assert.strictEqual(body.pushConfigured, false);
    assert.strictEqual(body.vapidPublicKey, null);
  });
  process.env.VAPID_PUBLIC_KEY = validPublicKey;
  SUBS.push({ driver_id: 'drv-a', device_id: DEV_A, endpoint: GOOD_ENDPOINT, disabled_at: null });
  r = await call('GET', { token: 'tok-andres', query: { deviceId: DEV_A } });
  check('GET active row -> enabled + sha256 fingerprint, NEVER the endpoint or keys', () => {
    const body = JSON.parse(r.body);
    assert.strictEqual(body.state, 'enabled');
    assert.strictEqual(body.endpointFingerprint,
      crypto.createHash('sha256').update(GOOD_ENDPOINT).digest('hex'));
    assert.ok(!r.body.includes(GOOD_ENDPOINT), 'endpoint must never leave the server');
    assert.ok(!r.body.includes('p256dh'));
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store');
  });
  SUBS[0].disabled_at = '2026-08-08T00:00:00Z';
  r = await call('GET', { token: 'tok-andres', query: { deviceId: DEV_A } });
  check('GET disabled row -> expired, no fingerprint', () => {
    const body = JSON.parse(r.body);
    assert.strictEqual(body.state, 'expired');
    assert.ok(!('endpointFingerprint' in body));
  });

  // ---------- POST validation: junk is 400 and never stored ----------
  resetState();
  const postSub = (deviceId, subscription) =>
    call('POST', { token: 'tok-andres', body: { deviceId, subscription } });
  r = await postSub('nope', { endpoint: GOOD_ENDPOINT, keys: GOOD_KEYS });
  check('POST invalid deviceId -> 400', () => assert.strictEqual(r.statusCode, 400));
  r = await postSub(DEV_A, { endpoint: 'http://insecure.example/x', keys: GOOD_KEYS });
  check('POST non-https endpoint -> 400', () => assert.strictEqual(r.statusCode, 400));
  r = await postSub(DEV_A, { endpoint: 'https://x.example/' + 'a'.repeat(3000), keys: GOOD_KEYS });
  check('POST oversized endpoint -> 400', () => assert.strictEqual(r.statusCode, 400));
  r = await postSub(DEV_A, { endpoint: GOOD_ENDPOINT, keys: { p256dh: 'short', auth: 'x!' } });
  check('POST malformed keys -> 400, nothing stored', () => {
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(capturedUpsert, null);
  });

  // ---------- endpoint host allowlist: server-side requests go ONLY to
  // recognized push services ----------
  const rejected = [
    'https://attacker.example.com/collect',          // arbitrary https destination
    'https://10.0.0.5/push',                         // IP literal / private
    'https://127.0.0.1/push',                        // loopback
    'https://localhost/push',                        // localhost
    'https://mything.local/push',                    // mDNS name
    'https://user:pw@fcm.googleapis.com/fcm/send/x', // embedded credentials
    'https://fcm.googleapis.com:8443/fcm/send/x',    // nonstandard port
    'https://evilfcm.googleapis.com.attacker.net/x', // suffix spoof
    'https://push.apple.com/x'                       // bare suffix (no shard label)
  ];
  for (const ep of rejected) {
    r = await postSub(DEV_A, { endpoint: ep, keys: GOOD_KEYS });
    check(`POST rejects non-push-service endpoint: ${new URL(ep).host}${new URL(ep).port ? ' (port)' : ''}${ep.includes('@') ? ' (creds)' : ''}`, () => {
      assert.strictEqual(r.statusCode, 400);
      assert.strictEqual(capturedUpsert, null);
    });
  }
  const accepted = [
    'https://fcm.googleapis.com/fcm/send/tok',
    'https://web.push.apple.com/QGxyz',
    'https://abc123.push.apple.com/QGxyz',
    'https://updates.push.services.mozilla.com/wpush/v2/tok',
    'https://autopush7.push.services.mozilla.com/wpush/v2/tok',
    'https://wns2-bl2p.notify.windows.com/w/?token=x'
  ];
  for (const ep of accepted) {
    resetState();
    r = await postSub(DEV_A, { endpoint: ep, keys: GOOD_KEYS });
    check(`POST accepts recognized push service: ${new URL(ep).host}`, () => {
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(capturedUpsert.endpoint, ep);
    });
  }

  // ---------- concurrent ownership race: 23505 -> sanitized 409 ----------
  resetState();
  upsertError = { code: '23505', message: 'duplicate key value violates unique constraint "push_subscriptions_endpoint" DETAIL: (endpoint)=(SECRET)' };
  r = await postSub(DEV_A, { endpoint: GOOD_ENDPOINT, keys: GOOD_KEYS });
  check('concurrent cross-driver upsert (23505) -> 409, never a 500, endpoint never echoed', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.ok(!r.body.includes(GOOD_ENDPOINT));
    assert.ok(!r.body.includes('SECRET'));
  });
  resetState();
  upsertEmpty = true;
  r = await postSub(DEV_A, { endpoint: GOOD_ENDPOINT, keys: GOOD_KEYS });
  check('upsert returning no row is a FAILED save -> 500', () => {
    assert.strictEqual(r.statusCode, 500);
  });
  resetState();
  upsertThrow = new Error(`network wrapper leaked ${GOOD_ENDPOINT} p256dh=SECRET`);
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errorLogs.push(args.join(' '));
  try {
    r = await postSub(DEV_A, { endpoint: GOOD_ENDPOINT, keys: GOOD_KEYS });
  } finally {
    console.error = originalConsoleError;
  }
  check('thrown endpoint-handler error is sanitized: code/name only, no endpoint or keys', () => {
    assert.strictEqual(r.statusCode, 500);
    const joined = errorLogs.join('\n');
    assert.ok(!joined.includes(GOOD_ENDPOINT));
    assert.ok(!joined.includes('SECRET'));
    assert.ok(joined.includes('Error'));
  });

  // ---------- POST happy path ----------
  resetState();
  r = await postSub(DEV_A, { endpoint: GOOD_ENDPOINT, keys: GOOD_KEYS });
  check('POST enable: upsert bound to driver+device, activated_at stamped, state reset', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(capturedUpsert.driver_id, 'drv-a');
    assert.strictEqual(capturedUpsert.device_id, DEV_A);
    assert.strictEqual(capturedUpsert.endpoint, GOOD_ENDPOINT);
    assert.ok(capturedUpsert.activated_at, 'activated_at is the device-selection key');
    assert.strictEqual(capturedUpsert.disabled_at, null);
    assert.strictEqual(capturedUpsert.disabled_reason, null);
    assert.ok(!r.body.includes(GOOD_ENDPOINT), 'response never echoes the endpoint');
  });

  // ---------- 409: an endpoint is NEVER reassigned between accounts ----------
  resetState();
  SUBS.push({ driver_id: 'drv-OTHER', device_id: DEV_B, endpoint: GOOD_ENDPOINT, disabled_at: null });
  r = await postSub(DEV_A, { endpoint: GOOD_ENDPOINT, keys: GOOD_KEYS });
  check('POST cross-driver endpoint -> 409, no upsert, no reassignment', () => {
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(capturedUpsert, null);
    assert.strictEqual(SUBS[0].driver_id, 'drv-OTHER', 'ownership untouched');
  });

  // ---------- same driver, endpoint moving devices: stale row retired ----------
  resetState();
  SUBS.push({ driver_id: 'drv-a', device_id: DEV_B, endpoint: GOOD_ENDPOINT, disabled_at: null });
  r = await postSub(DEV_A, { endpoint: GOOD_ENDPOINT, keys: GOOD_KEYS });
  check('POST same-driver endpoint on a new device: stale row deleted, upsert proceeds', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.ok(capturedDeletes.length >= 1, 'stale-row cleanup ran');
    assert.strictEqual(capturedUpsert.device_id, DEV_A);
  });

  // ---------- DELETE (sign-out) ----------
  resetState();
  SUBS.push({ driver_id: 'drv-a', device_id: DEV_A, endpoint: GOOD_ENDPOINT, disabled_at: null });
  r = await call('DELETE', { token: 'tok-andres', body: { deviceId: DEV_A } });
  check('DELETE removes the driver+device row', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(SUBS.length, 0);
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
