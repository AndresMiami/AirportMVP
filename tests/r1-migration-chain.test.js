// R1 — machine-attested migration chain (real PostgreSQL via PGlite/WASM).
//
// Run: node tests/r1-migration-chain.test.js   (needs `npm install`)
//
// This executes the ACTUAL SQL, not text assertions: the full schema chain
// (linkmia-schema + migrations 001..017) on a fresh replica with
// Supabase-shaped roles, then EXACT 018, behavioral/ACL/catalog proofs, FIVE
// executed MUTANTS that must abort (privilege, passthrough projection,
// dropped edit key, stripped search_path, rollback privilege drift), the
// EXACT rollback file, a behavioral proof that 017 semantics returned, and a
// same-session 018 re-apply.
// This is the protection class that caught 017's former outage defects.
// Bootstrap ported from the Codex review harness (pglite-harness/README.md),
// made repo-relative and self-contained.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const mig = (f) => fs.readFileSync(path.join(repoRoot, 'database/migrations', f), 'utf8');

let checks = 0;
const results = [];
async function check(name, f) {
  try { await f(); checks++; results.push(`  ✓ ${name}`); }
  catch (err) {
    results.push(`  ✗ ${name}\n      ${String(err.message).slice(0, 300)}`);
    results.forEach((x) => console.log(x));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

async function freshDb(PGlite, pgcrypto) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE supabase_admin SUPERUSER;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO anon, authenticated, service_role;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text, created_at timestamptz DEFAULT now());
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
  `);
  // schema + 001..017 (exclude the 017 preflight and both 018 files)
  await db.exec(fs.readFileSync(path.join(repoRoot, 'database/linkmia-schema.sql'), 'utf8'));
  const files = fs.readdirSync(path.join(repoRoot, 'database/migrations'))
    .filter((f) => /^0\d\d_/.test(f) && !/preflight|^018_/.test(f)).sort();
  for (const f of files) await db.exec(mig(f));
  return db;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
async function tryExec(db, sql) {
  try { await db.exec(sql); return { ok: true }; }
  catch (e) { try { await db.exec('ROLLBACK'); } catch (_) {} return { ok: false, error: e.message }; }
}

const uuid = () => require('crypto').randomUUID();

// The EDIT acceptance projection block: the jsonb_build_object that carries
// 'assignmentEpoch' (only the edit projection has it).
function s018EditProjection(sql) {
  const at = sql.indexOf("'assignmentEpoch', p_payload->'assignmentEpoch'");
  assert.ok(at > 0, 'edit projection not found');
  const start = sql.lastIndexOf('jsonb_build_object(', at);
  const end = sql.indexOf(')\n      );', at);
  return sql.slice(start, end);
}

async function seedCustomer(db, name) {
  const authUserId = uuid();
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`,
    [authUserId, `${authUserId}@example.invalid`]);
  const c = await one(db,
    `INSERT INTO customers (name, phone, email, type, source, user_id)
     VALUES ($1,'0000000018',$2,'guest','website',$3) RETURNING id`,
    [name, `${authUserId}@example.invalid`, authUserId]);
  return { authUserId, customerId: c.id };
}

function bookingJson(trip, name, extra = {}, pickupMs = Date.now() + 86400000) {
  // ONE timestamp for payload AND booking: 017 cross-checks the payload's
  // pickupAtMs against the booking's pickup_datetime, and two separate
  // Date.now() calls straddling a millisecond tick fail it intermittently
  // (caught by the determinism loop, not by review).
  const pickup = new Date(pickupMs).toISOString();
  return JSON.stringify({
    trip_id: trip, customer_name: name, customer_phone: '0000000018',
    pickup_location: 'chain-origin', dropoff_location: 'chain-destination',
    pickup_datetime: pickup, passengers: 1, bags: 0,
    vehicle_type: 'sedan', vehicle_name: 'Tesla Model Y',
    booking_mode: 'dropoff', source: 'website', ...extra,
  });
}

function verifiedPayload({ jti, authUserId, customerId, pickupMs }) {
  const now = Date.now();
  return JSON.stringify({
    v: 2, kid: 'chain-smoke', jti, purpose: 'create',
    authUserId, customerId, vehicle: 'tesla',
    pickupAtMs: pickupMs, commitment: 'a'.repeat(64),
    routeQuality: 'traffic_aware', finalCents: 5678,
    pricingVersion: 'smoke', engineVersion: 'smoke', resolvedVersion: 'smoke',
    iat: now - 1000, exp: now + 899000,
  });
}

async function rpcCreate(db, { authUserId, customerId }, opId, verdict, jti, payload, place, trip, name, extra, pickupMs) {
  await db.exec('SET ROLE service_role');
  try {
    const r = await one(db,
      `SELECT accept_quote_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS r`,
      [authUserId, customerId, opId,
       require('crypto').createHash('sha256').update(opId).digest('hex'), verdict,
       jti, jti ? require('crypto').createHash('sha256').update(jti + ':tok').digest('hex') : null,
       payload, 40.0,
       place, place ? 'MIA' : null, place ? 'tesla' : null,
       bookingJson(trip, name, extra, pickupMs)]);
    return r.r;
  } finally { await db.exec('RESET ROLE'); }
}

(async () => {
  console.log('\nR1 — executed migration chain (PGlite)\n');

  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');

  const m018 = mig('018_r1_route_content_non_retention.sql');
  const rollback = mig('018_r1_rollback.sql');
  const db = await freshDb(PGlite, pgcrypto);

  const CREATE_SIG = "public.accept_quote_create(uuid,uuid,uuid,text,text,uuid,text,jsonb,numeric,text,text,text,jsonb)";
  const preCatalog = await one(db, `
    SELECT p.oid::text AS oid, p.proowner::text AS owner, p.proacl::text AS acl
    FROM pg_proc p WHERE p.oid = '${CREATE_SIG}'::regprocedure`);

  await check('the full chain (schema + 001..017) applies to a fresh replica', async () => {
    const mode = await one(db, `SELECT mode FROM pricing_state`);
    assert.strictEqual(mode.mode, 'off');
  });

  await check('UNDER 017: the verified-duration requirement really is enforced', async () => {
    const cust = await seedCustomer(db, 'CHAIN-PRE-B');
    const jti = uuid();
    let threw = null;
    try {
      const pickupMs = Date.now() + 86400000;
      await rpcCreate(db, cust, uuid(), 'verified', jti,
        verifiedPayload({ jti, authUserId: cust.authUserId, customerId: cust.customerId, pickupMs }),
        'chain-place-1', 'CHAIN-PRE-2', 'CHAIN-PRE-B', {}, pickupMs);
    } catch (e) { threw = e.message; }
    assert.ok(threw && /booking ride details are invalid/.test(threw),
      `017 must refuse a verified create without duration, got: ${threw}`);
  });

  await check('MUTANT A: 018 ABORTS if service_role EXECUTE was revoked (the round-1 escape)', async () => {
    await db.exec(`REVOKE EXECUTE ON FUNCTION ${CREATE_SIG.replace('public.', '')} FROM service_role`);
    const r = await tryExec(db, m018);
    assert.ok(!r.ok, '018 must not commit over broken privileges');
    assert.ok(/service_role lost EXECUTE/.test(r.error), r.error);
    await db.exec(`GRANT EXECUTE ON FUNCTION ${CREATE_SIG.replace('public.', '')} TO service_role`);
  });

  await check('MUTANT B: 018 ABORTS if the projection is a raw p_payload passthrough (the round-1 escape)', async () => {
    // Put the raw passthrough back in BOTH acceptance inserts.
    const projStart = /        jsonb_build_object\(\n[\s\S]*?\n        \)\n      \);/g;
    const mutated = m018.replace(projStart, '        p_payload\n      );');
    assert.notStrictEqual(mutated, m018, 'mutation must apply');
    const r = await tryExec(db, mutated);
    assert.ok(!r.ok, '018 must not commit with a passthrough projection');
    assert.ok(/projection allowlist is missing/.test(r.error), r.error);
  });

  await check('MUTANT C: 018 ABORTS if the EDIT projection drops a key (kid) — the 17-key smoke bites', async () => {
    const editProj = s018EditProjection(m018);
    const mutated = m018.replace(editProj, editProj.replace("          'kid', p_payload->'kid',\n", ''));
    assert.notStrictEqual(mutated, m018, 'mutation must apply');
    const r = await tryExec(db, mutated);
    assert.ok(!r.ok, '018 must not commit with a truncated edit projection');
    assert.ok(/EDIT acceptance projection is not the exact allowlist/.test(r.error), r.error);
  });

  await check('MUTANT D: 018 ABORTS if a replacement body drops `extensions` from search_path', async () => {
    const mutated = m018.replace(/SET search_path = public, extensions/g, 'SET search_path = public');
    assert.notStrictEqual(mutated, m018, 'mutation must apply');
    const r = await tryExec(db, mutated);
    assert.ok(!r.ok, '018 must not commit with drifted proconfig');
    assert.ok(/search_path\/config drifted/.test(r.error), r.error);
  });

  await check('EXACT 018 applies clean — verification and rollback-contained smoke pass on real SQL', async () => {
    const r = await tryExec(db, m018);
    assert.ok(r.ok, r.error);
  });

  await check('AFTER 018: create/edit persist NULL duration; the projection is the exact 15-key allowlist', async () => {
    const cust = await seedCustomer(db, 'CHAIN-POST-A');
    const jti = uuid();
    const pickupMs = Date.now() + 86400000;
    const r = await rpcCreate(db, cust, uuid(), 'verified', jti,
      verifiedPayload({ jti, authUserId: cust.authUserId, customerId: cust.customerId, pickupMs }),
      'chain-place-2', 'CHAIN-POST-1', 'CHAIN-POST-A', { duration_minutes: 777 }, pickupMs);
    assert.strictEqual(r.outcome, 'created', JSON.stringify(r));
    const row = await one(db, `SELECT duration_minutes FROM bookings WHERE id = $1`, [r.booking_id]);
    assert.strictEqual(row.duration_minutes, null, 'duration must not persist');
    const proj = await one(db, `
      SELECT (SELECT count(*) FROM jsonb_object_keys(payload_projection)) AS n,
             (payload_projection ? 'routeQuality') AS has_rq,
             (payload_projection ? 'commitment') AS has_commit
      FROM quote_acceptances WHERE jti = $1`, [jti]);
    assert.strictEqual(Number(proj.n), 15);
    assert.strictEqual(proj.has_rq, false, 'routeQuality must not be stored');
    assert.strictEqual(proj.has_commit, true);
  });

  await check('AFTER 018: catalog identity held — same oid, owner and ACL; client roles still barred', async () => {
    const post = await one(db, `
      SELECT p.oid::text AS oid, p.proowner::text AS owner, p.proacl::text AS acl,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS an,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS au
      FROM pg_proc p WHERE p.oid = '${CREATE_SIG}'::regprocedure`);
    assert.strictEqual(post.oid, preCatalog.oid, 'CREATE OR REPLACE must keep the oid');
    assert.strictEqual(post.owner, preCatalog.owner);
    assert.strictEqual(post.acl, preCatalog.acl);
    assert.strictEqual(post.sr, true);
    assert.strictEqual(post.an, false);
    assert.strictEqual(post.au, false);
  });

  await check('EXACT ROLLBACK applies — and RESTORES 017 behavior (duration required and persisted again)', async () => {
    const r = await tryExec(db, rollback);
    assert.ok(r.ok, r.error);
    // requirement returns
    const cust = await seedCustomer(db, 'CHAIN-RB-A');
    const jti = uuid();
    let threw = null;
    try {
      const pickupMs = Date.now() + 86400000;
      await rpcCreate(db, cust, uuid(), 'verified', jti,
        verifiedPayload({ jti, authUserId: cust.authUserId, customerId: cust.customerId, pickupMs }),
        'chain-place-3', 'CHAIN-RB-1', 'CHAIN-RB-A', {}, pickupMs);
    } catch (e) { threw = e.message; }
    assert.ok(threw && /booking ride details are invalid/.test(threw),
      'post-rollback, a verified create without duration must be refused again');
    // persistence returns
    const cust2 = await seedCustomer(db, 'CHAIN-RB-B');
    const r2 = await rpcCreate(db, cust2, uuid(), 'no_token', null, null,
      null, 'CHAIN-RB-2', 'CHAIN-RB-B', { duration_minutes: 55 });
    assert.strictEqual(r2.outcome, 'created');
    const row = await one(db, `SELECT duration_minutes FROM bookings WHERE id = $1`, [r2.booking_id]);
    assert.strictEqual(row.duration_minutes, 55, 'post-rollback, 017 persists duration again');
  });

  await check('ROLLBACK MUTANT: the exact rollback ABORTS over client-role privilege drift', async () => {
    // Codex round-2 executed reproduction: grant anon EXECUTE, apply the
    // exact rollback — it committed. Now it must refuse before COMMIT.
    await db.exec(`GRANT EXECUTE ON FUNCTION ${CREATE_SIG.replace('public.', '')} TO anon`);
    const r = await tryExec(db, rollback);
    assert.ok(!r.ok, 'rollback must not commit over client-role EXECUTE');
    assert.ok(/client role holds EXECUTE/.test(r.error), r.error);
    await db.exec(`REVOKE EXECUTE ON FUNCTION ${CREATE_SIG.replace('public.', '')} FROM anon`);
  });

  await check('SAME-SESSION RE-APPLY: exact 018 goes back on cleanly and NULLs again', async () => {
    const r = await tryExec(db, m018);
    assert.ok(r.ok, r.error);
    const cust = await seedCustomer(db, 'CHAIN-RE-A');
    const r2 = await rpcCreate(db, cust, uuid(), 'no_token', null, null,
      null, 'CHAIN-RE-1', 'CHAIN-RE-A', { duration_minutes: 66 });
    assert.strictEqual(r2.outcome, 'created');
    const row = await one(db, `SELECT duration_minutes FROM bookings WHERE id = $1`, [r2.booking_id]);
    assert.strictEqual(row.duration_minutes, null);
  });

  results.forEach((x) => console.log(x));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  process.exit(0);
})();
