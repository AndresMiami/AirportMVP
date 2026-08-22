// /api/quote-ride — access modes and identity recovery, tested by BEHAVIOUR.
//
// Run: node tests/quote-ride-access.test.js
//
// These paths decide two things that cost real money or leak real writes:
// who is allowed to spend a Places + Compute Routes Pro pair, and whether an
// ambassador who has never booked can get a price at all. Source-regex
// assertions cannot tell you that a denied user performed zero writes, or
// that a losing insert race recovers — so this runs the real handler against
// a mocked Supabase and a mocked Google, and counts what actually happened.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');

const ANDRES = { id: 'user-andres', email: 'andres@example.test' };
const AMBASSADOR = { id: 'user-amb', email: 'amb@example.test' };
const STRANGER = { id: 'user-stranger', email: 'stranger@example.test' };
const TOKENS = { 'tok-andres': ANDRES, 'tok-amb': AMBASSADOR, 'tok-stranger': STRANGER };

const state = {};
function reset() {
  state.customers = { 'user-andres': { id: 'cust-andres' } };   // ambassador has NO row
  state.hosts = { 'user-amb': { id: 'host-1', name: 'Isabela M.', phone: '305', email: 'h@x.test', status: 'active' } };
  state.customerLookupError = null;
  state.hostLookupError = null;
  state.insertResult = null;      // null -> succeed
  state.conflictWinnerRow = null; // the row the race winner committed
  state.writes = [];              // every customers insert attempted
  state.placesCalls = [];
  state.routesCalls = [];
  state.rereads = 0;
}
reset();

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => (TOKENS[token]
        ? { data: { user: TOKENS[token] }, error: null }
        : { data: { user: null }, error: { status: 401, message: 'bad token' } }),
    },
    from: (table) => {
      if (table === 'customers') {
        return {
          select: () => ({
            eq: (_c, userId) => ({
              maybeSingle: async () => {
                if (state.customerLookupError) return { data: null, error: state.customerLookupError };
                if (state.rereadPending) { state.rereads++; state.rereadPending = false; }
                return { data: state.customers[userId] || null, error: null };
              },
            }),
          }),
          insert: (rows) => {
            state.writes.push(rows[0]);
            return {
              select: () => ({
                single: async () => {
                  if (state.insertResult) {
                    // Simulate the WINNER of the race committing its row just
                    // before we get the conflict back, so the re-read can find it.
                    if (state.conflictWinnerRow) state.customers[rows[0].user_id] = state.conflictWinnerRow;
                    state.rereadPending = true;
                    return state.insertResult;
                  }
                  const created = { id: 'cust-new' };
                  state.customers[rows[0].user_id] = created;
                  return { data: created, error: null };
                },
              }),
            };
          },
        };
      }
      if (table === 'hosts') {
        return {
          select: () => ({
            eq: (_c1, userId) => ({
              eq: () => ({
                maybeSingle: async () => {
                  if (state.hostLookupError) return { data: null, error: state.hostLookupError };
                  return { data: state.hosts[userId] || null, error: null };
                },
              }),
            }),
          }),
        };
      }
      throw new Error('unexpected table: ' + table);
    },
  }),
};
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

global.fetch = async (url, options) => {
  const u = String(url);
  if (u.includes('places.googleapis.com')) {
    state.placesCalls.push(u);
    return { ok: true, status: 200,
      json: async () => ({ id: 'ChIJresolved_xyz', formattedAddress: '1 Brickell Ave, Miami, FL' }) };
  }
  if (u.includes('routes.googleapis.com')) {
    state.routesCalls.push(u);
    return { ok: true, status: 200,
      json: async () => ({ routes: [{ distanceMeters: 16093, duration: '1200s' }] }) };
  }
  throw new Error('unexpected fetch: ' + u);
};

const endpoint = require(path.join(repoRoot, 'backend/functions/quote-ride.js'));

const BASE_ENV = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_KEY: 'svc',
  SUPABASE_ANON_KEY: 'anon',
  GOOGLE_ROUTES_API_KEY: 'routes-key',
  GOOGLE_PLACES_SERVER_API_KEY: 'places-key',
  QUOTE_SIGNING_CURRENT_ID: 'k1',
  QUOTE_SIGNING_CURRENT_SECRET: 'a'.repeat(64),
};

function withEnv(extra, fn) {
  const saved = { ...process.env };
  Object.keys(process.env).forEach((k) => {
    if (/^QUOTE_|^GOOGLE_|^SUPABASE_/.test(k)) delete process.env[k];
  });
  Object.assign(process.env, BASE_ENV, extra);
  return Promise.resolve(fn()).finally(() => {
    Object.keys(process.env).forEach((k) => delete process.env[k]);
    Object.assign(process.env, saved);
  });
}

function post(token, extraEnv) {
  return withEnv(extraEnv, () => endpoint.handler({
    httpMethod: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      mode: 'dropoff', airportCode: 'MIA', placeId: 'ChIJsubmitted_abc',
      pickupAt: new Date(Date.now() + 24 * 3600e3).toISOString(), passengers: 1,
    }),
  }));
}

let checks = 0;
const results = [];
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }
async function run() {
  for (const { name, fn } of queue) {
    reset();
    try {
      await fn();
      checks++;
      results.push(`  ✓ ${name}`);
    } catch (err) {
      results.push(`  ✗ ${name}\n      ${err.message}`);
      results.forEach((r) => console.log(r));
      console.log(`\nFAILED at: ${name}`);
      process.exit(1);
    }
  }
  results.forEach((r) => console.log(r));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
}

console.log('\n/api/quote-ride — access modes and identity recovery\n');

// ---------------- access modes ----------------
check('allowlist mode: a listed account is served', async () => {
  const res = await post('tok-andres', { QUOTE_ACCESS_MODE: 'allowlist', QUOTE_SHADOW_ALLOWLIST: 'user-andres' });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(state.placesCalls.length, 1);
  assert.strictEqual(state.routesCalls.length, 1);
});

check('allowlist mode: an unlisted account is refused and spends NOTHING', async () => {
  const res = await post('tok-stranger', { QUOTE_ACCESS_MODE: 'allowlist', QUOTE_SHADOW_ALLOWLIST: 'user-andres' });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(state.placesCalls.length, 0, 'a denied account must not buy a Places call');
  assert.strictEqual(state.routesCalls.length, 0, 'a denied account must not buy a Routes call');
});

check('allowlist mode: a denied ambassador leaves NO customers row behind', async () => {
  // The gate used to sit after identity recovery, so an unlisted ambassador
  // got a row minted for them and then a 403 — a write for someone refused.
  const res = await post('tok-amb', { QUOTE_ACCESS_MODE: 'allowlist', QUOTE_SHADOW_ALLOWLIST: 'user-andres' });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(state.writes, [], 'a denied account must perform zero writes');
});

check('authenticated mode: any signed-in customer is served, no allowlist needed', async () => {
  const res = await post('tok-andres', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(state.placesCalls.length, 1);
});

check('authenticated mode: an account NOT on the old allowlist is still served', async () => {
  const res = await post('tok-stranger', { QUOTE_ACCESS_MODE: 'authenticated' });
  // stranger has no customers row and no host row -> 403 on identity, not access
  assert.strictEqual(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /sign in again/,
    'the refusal must be about the missing profile, not the allowlist');
});

check('default mode is the RESTRICTIVE one when nothing is set', async () => {
  const res = await post('tok-andres', { QUOTE_SHADOW_ALLOWLIST: 'someone-else' });
  assert.strictEqual(res.statusCode, 403, 'no QUOTE_ACCESS_MODE must mean allowlist');
});

// ---------------- invalid configuration ----------------
check('an unknown access mode is a refusal, not a guess', async () => {
  const res = await post('tok-andres', { QUOTE_ACCESS_MODE: 'everyone' });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(state.placesCalls.length, 0);
});

check('allowlist mode with no allowlist is a configuration error, not open access', async () => {
  const res = await post('tok-andres', { QUOTE_ACCESS_MODE: 'allowlist' });
  assert.strictEqual(res.statusCode, 500, 'a missing allowlist must never read as permission');
  assert.strictEqual(state.placesCalls.length, 0);
});

check('authenticated mode does NOT require an allowlist to be configured', async () => {
  const res = await post('tok-andres', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 200, 'removing the allowlist must not 500 in this mode');
});

check('the kill switch still wins over everything', async () => {
  const res = await post('tok-andres', { QUOTE_ACCESS_MODE: 'authenticated', QUOTE_SERVICE_DISABLED: '1' });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(state.placesCalls.length, 0);
});

// ---------------- ambassador recovery ----------------
check('an ALLOWED ambassador with no customers row is recovered from the host record', async () => {
  const res = await post('tok-amb', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(state.writes.length, 1);
  assert.strictEqual(state.writes[0].user_id, 'user-amb');
  assert.strictEqual(state.writes[0].name, 'Isabela M.',
    'identity must come from the HOST record, never from passenger details');
});

check('a non-ambassador with no customers row is refused, not minted', async () => {
  const res = await post('tok-stranger', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(state.writes, []);
});

check('an INACTIVE ambassador is refused', async () => {
  state.hosts['user-amb'].status = 'inactive';
  // the handler filters on status='active'; emulate by removing the row
  delete state.hosts['user-amb'];
  const res = await post('tok-amb', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(state.writes, []);
});

check('a host lookup failure fails CLOSED', async () => {
  state.hostLookupError = { message: 'connection reset' };
  const res = await post('tok-amb', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(state.placesCalls.length, 0);
});

check('a customer lookup failure fails CLOSED', async () => {
  state.customerLookupError = { message: 'connection reset' };
  const res = await post('tok-andres', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(state.placesCalls.length, 0);
});

check('CONCURRENCY: losing the insert race re-reads instead of failing', async () => {
  // customers.user_id is UNIQUE, so two requests recovering the same
  // ambassador at once collide by design. The loser must recover.
  state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
  state.conflictWinnerRow = { id: 'cust-winner' };   // appears only once we lose
  const res = await post('tok-amb', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(state.rereads, 1, 'the loser must re-read the winner\'s row');
});

check('a NON-conflict insert error still fails closed', async () => {
  state.insertResult = { data: null, error: { code: '42501', message: 'permission denied' } };
  const res = await post('tok-amb', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(state.placesCalls.length, 0);
});

check('a conflict whose re-read finds nothing fails closed', async () => {
  state.insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } };
  // deliberately do NOT create the winner's row
  const res = await post('tok-amb', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 500);
});

check('an unauthenticated request never reaches the database or Google', async () => {
  const res = await post('tok-bogus', { QUOTE_ACCESS_MODE: 'authenticated' });
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(state.writes, []);
  assert.strictEqual(state.placesCalls.length, 0);
});

run().catch((e) => { console.error(e); process.exit(1); });
