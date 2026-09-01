// R1 — POST /api/operation-status (read-only settled-result recovery).
//
// Run: node tests/operation-status.test.js
//
// Plan v3's R1 gate: the sessionStorage envelope may not stop carrying the
// exact request bytes "until endpoint tests prove settled create/edit
// recovery, mismatch refusal, a delayed original result, and ambassador
// no-duplicate behavior". These are those tests, plus the read-only proof:
// the mock THROWS on any insert/update/rpc, so any write attempt fails the
// suite structurally rather than by inspection.

const assert = require('assert');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// ---- supabase mock via require.cache (repo pattern) ----
const RECEIPTS = new Map(); // operation_request_id -> row
const BOOKINGS = new Map(); // id -> row
let receiptLookupError = null;
let bookingLookupError = null;
let authUser = null;        // { id } or null
let authError = null;       // injected auth failure
let authThrow = null;       // injected THROWN auth failure

function readOnlyTable(rows, keyCol) {
  return {
    select: () => ({
      eq: (col, val) => ({
        maybeSingle: async () => {
          if (keyCol === 'operation_request_id' && receiptLookupError) {
            return { data: null, error: receiptLookupError };
          }
          if (keyCol === 'id' && bookingLookupError) {
            return { data: null, error: bookingLookupError };
          }
          assert.strictEqual(col, keyCol, `unexpected filter column ${col}`);
          return { data: rows.get(val) || null, error: null };
        }
      })
    }),
    insert: () => { throw new Error('WRITE ATTEMPTED: insert on a read-only recovery path'); },
    update: () => { throw new Error('WRITE ATTEMPTED: update on a read-only recovery path'); },
    upsert: () => { throw new Error('WRITE ATTEMPTED: upsert on a read-only recovery path'); },
    delete: () => { throw new Error('WRITE ATTEMPTED: delete on a read-only recovery path'); }
  };
}

const mockClient = {
  auth: {
    getUser: async () => {
      if (authThrow) throw authThrow;
      if (authError) return { data: null, error: authError };
      return { data: { user: authUser }, error: null };
    }
  },
  rpc: async () => { throw new Error('RPC ATTEMPTED: recovery must never call a writer'); },
  from: (table) => {
    if (table === 'operation_receipts') return readOnlyTable(RECEIPTS, 'operation_request_id');
    if (table === 'bookings') return readOnlyTable(BOOKINGS, 'id');
    throw new Error(`unexpected table ${table}`);
  }
};

require.cache[require.resolve('@supabase/supabase-js')] = {
  exports: { createClient: () => mockClient }
};

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-test';
process.env.SUPABASE_ANON_KEY = 'anon-test';

const fn = require(path.join(repoRoot, 'backend/functions/operation-status.js'));

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const OP_CREATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_EDIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOOKING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function reset() {
  RECEIPTS.clear(); BOOKINGS.clear();
  receiptLookupError = null; bookingLookupError = null;
  authUser = { id: OWNER }; authError = null; authThrow = null;
}

const post = (body, headers = {}) => fn.handler({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer tok', ...headers },
  body: JSON.stringify(body)
});

const parsed = async (p) => { const r = await p; return { ...r, json: JSON.parse(r.body) }; };

let checks = 0;
const results = [];
async function check(name, f) {
  try { await f(); checks++; results.push(`  ✓ ${name}`); }
  catch (err) {
    results.push(`  ✗ ${name}\n      ${err.message}`);
    results.forEach((x) => console.log(x));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

(async () => {
  console.log('\nR1 — operation-status recovery endpoint\n');

  await check('settled CREATE recovery returns the exact allowlist and nothing else', async () => {
    reset();
    RECEIPTS.set(OP_CREATE, { operation_request_id: OP_CREATE, kind: 'create', auth_user_id: OWNER, booking_id: BOOKING, details_version: 1 });
    BOOKINGS.set(BOOKING, { id: BOOKING, trip_id: 'MIA123', details_version: 1, pickup_location: 'MUST NOT LEAK', price: 165 });
    const r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.json, { settled: true, bookingId: BOOKING, tripId: 'MIA123' });
    assert.ok(!r.body.includes('MUST NOT LEAK') && !r.body.includes('165'),
      'nothing outside the allowlist may leave');
  });

  await check('settled EDIT recovery adds detailsVersion — and only for edits', async () => {
    reset();
    RECEIPTS.set(OP_EDIT, { operation_request_id: OP_EDIT, kind: 'edit_quoted', auth_user_id: OWNER, booking_id: BOOKING, details_version: 3 });
    BOOKINGS.set(BOOKING, { id: BOOKING, trip_id: 'MIA123', details_version: 4 });
    const r = await parsed(post({ operationId: OP_EDIT, kind: 'edit', bookingId: BOOKING }));
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(r.json, { settled: true, bookingId: BOOKING, tripId: 'MIA123', detailsVersion: 4 });
  });

  await check('miss and EVERY mismatch return the IDENTICAL sanitized body', async () => {
    reset();
    RECEIPTS.set(OP_EDIT, { operation_request_id: OP_EDIT, kind: 'edit_quoted', auth_user_id: OWNER, booking_id: BOOKING, details_version: 3 });
    BOOKINGS.set(BOOKING, { id: BOOKING, trip_id: 'MIA123', details_version: 4 });
    const cases = [
      post({ operationId: OP_CREATE, kind: 'create' }),                          // pure miss
      post({ operationId: OP_EDIT, kind: 'create' }),                            // wrong kind
      post({ operationId: OP_EDIT, kind: 'edit', bookingId: OP_CREATE }),        // wrong booking
    ];
    authUser = { id: STRANGER };
    cases.push(post({ operationId: OP_EDIT, kind: 'edit', bookingId: BOOKING })); // wrong owner
    const bodies = [];
    for (const c of cases) bodies.push((await parsed(c)));
    for (const b of bodies) {
      assert.strictEqual(b.statusCode, 200);
      assert.deepStrictEqual(b.json, { settled: false },
        'a mismatch must be indistinguishable from a miss');
    }
  });

  await check('DELAYED ORIGINAL: a miss now, the receipt lands, the next check settles', async () => {
    reset();
    let r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.deepStrictEqual(r.json, { settled: false });
    // the original write settles between checks
    RECEIPTS.set(OP_CREATE, { operation_request_id: OP_CREATE, kind: 'create', auth_user_id: OWNER, booking_id: BOOKING, details_version: 1 });
    BOOKINGS.set(BOOKING, { id: BOOKING, trip_id: 'MIA123', details_version: 1 });
    r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.json.settled, true);
    assert.strictEqual(r.json.bookingId, BOOKING);
  });

  await check('AMBASSADOR NO-DUPLICATE: recovery is structurally a READ — a write throws the suite', async () => {
    // Ambassadors are exempt from the one-active-booking rule (NULL
    // active_slot, 017:216-224), so the receipt is their only duplicate
    // defence. This endpoint must therefore never reach a writer: the mock
    // throws on insert/update/rpc, so if any path attempted one, every test
    // above would have failed. Here we drive the full settled path once more
    // and assert it completed against a mock where every write throws.
    reset();
    RECEIPTS.set(OP_CREATE, { operation_request_id: OP_CREATE, kind: 'create', auth_user_id: OWNER, booking_id: BOOKING, details_version: 1 });
    BOOKINGS.set(BOOKING, { id: BOOKING, trip_id: 'MIA123', details_version: 1 });
    const r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.json.settled, true, 'settled through a throw-on-write mock = zero writes occurred');
  });

  await check('input strictness: bad UUID, bad kind, edit without bookingId, create WITH bookingId — all 400', async () => {
    reset();
    for (const body of [
      { operationId: 'not-a-uuid', kind: 'create' },
      // 3-hex third group: the repo's strict UUID shape must refuse it at
      // the 400 boundary, before any database read (regex-drift finding).
      { operationId: 'aaaaaaaa-bbbb-4cc-8ddd-eeeeeeeeeeee', kind: 'create' },
      { operationId: OP_CREATE, kind: 'delete' },
      { operationId: OP_CREATE, kind: 'edit' },
      { operationId: OP_CREATE, kind: 'create', bookingId: BOOKING },
      // round-2 executed probes: prototype-chain kinds and coerced bookingIds
      { operationId: OP_CREATE, kind: 'toString' },
      { operationId: OP_CREATE, kind: 'constructor' },
      { operationId: OP_CREATE, kind: 'create', bookingId: 42 },
      { operationId: OP_CREATE, kind: 'create', bookingId: null },
      { operationId: OP_EDIT, kind: 'edit', bookingId: 42 },
      { operationId: OP_EDIT, kind: 'edit', bookingId: null },
    ]) {
      const r = await parsed(post(body));
      assert.strictEqual(r.statusCode, 400, JSON.stringify(body));
      assert.ok(!('settled' in r.json), 'a 400 must not look like a status answer');
    }
  });

  await check('auth discipline: no token 401, invalid 401, outage 500 — never a fake miss', async () => {
    reset();
    let r = await parsed(fn.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ operationId: OP_CREATE, kind: 'create' }) }));
    assert.strictEqual(r.statusCode, 401);
    authError = { status: 401, name: 'AuthApiError' };
    r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.statusCode, 401);
    authError = { status: 503, name: 'AuthRetryableFetchError' };
    r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.statusCode, 500, 'an auth outage must read as an outage');
    assert.ok(!('settled' in r.json));
    // A NETWORK-SHAPED returned error carries no status at all — the
    // canonical classifier treats missing status as an outage, never as an
    // invalid session (Codex round-1 executed probe).
    authError = { name: 'TypeError', message: 'fetch failed' };
    r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.statusCode, 500, 'no-status errors are outages, not 401s');
    // A THROWN auth failure must also be a sanitized 500, never an
    // unhandled rejection.
    authThrow = new Error('socket hang up');
    r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.statusCode, 500);
    authThrow = null;
  });

  await check('JSON shape strictness: null, arrays and primitives are 400, never a crash', async () => {
    reset();
    for (const raw of ['null', '[]', '"a-string"', '42']) {
      const r = await parsed(fn.handler({
        httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: raw
      }));
      assert.strictEqual(r.statusCode, 400, `body ${raw} must 400`);
      assert.ok(!('settled' in r.json));
    }
  });

  await check('lookup failures are 500, never a fake {settled:false}', async () => {
    reset();
    receiptLookupError = { code: 'PGRST000' };
    let r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.statusCode, 500);
    reset();
    RECEIPTS.set(OP_CREATE, { operation_request_id: OP_CREATE, kind: 'create', auth_user_id: OWNER, booking_id: BOOKING, details_version: 1 });
    bookingLookupError = { code: 'PGRST000' };
    r = await parsed(post({ operationId: OP_CREATE, kind: 'create' }));
    assert.strictEqual(r.statusCode, 500,
      'a receipt without a readable booking is a server inconsistency, not a miss');
  });

  await check('GET is refused; responses are private no-store', async () => {
    reset();
    const r = await fn.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer tok' }, body: '' });
    assert.strictEqual(r.statusCode, 405);
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store');
  });

  results.forEach((x) => console.log(x));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})();
