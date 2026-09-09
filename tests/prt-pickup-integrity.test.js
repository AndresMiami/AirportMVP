// PR-T — pickup-time integrity, EXECUTED on real PostgreSQL (PGlite/WASM).
//
// Run: node tests/prt-pickup-integrity.test.js   (needs `npm install`)
//
// Plan v8.6 §3E + Codex seq:201/204. This suite:
//   * asserts both PR-T SQL artifacts equal the guard transform's output
//     byte-for-byte (they are generated, never hand-edited);
//   * pins the guard STATICALLY: statement order, one ZQ019 raise + one
//     handler per body, ZQ017 quote-time-only, no table constraint, the helper
//     referenced by exactly the two writers, no other status/cancel path;
//   * chains schema + 001..017 -> 018 -> 019 and proves the COMPARATOR on the
//     transaction-stable clock (exact now refused, one microsecond later
//     passes) and that a `>` -> `>=` mutation would be caught;
//   * EXECUTES THE RATIFIED AUTHORITY MATRIX for BOTH writers:
//     {off, observe} x {verified, no_token, verify_failed} — elapsed refused
//     with ZERO writes, future accepted (verified provably records an
//     acceptance), elapsed edit proposal refused, elapsed stored row RESCUED —
//     plus enforce x verified; observe/enforce are reached ONLY through
//     set_pricing_mode(), never a direct pricing_state write;
//   * proves receipt-first replay per token kind (an exact retry after the
//     pickup elapsed lands on its receipt before any clock);
//   * proves the FINAL live-clock guard rolls back booking, acceptance,
//     receipt AND telemetry for VERIFIED create/edit in off and observe and
//     for non-token observe paths — each verified crossing paired with a
//     control proving the identical call enters the acceptance path;
//   * EXECUTES MUTANTS on scratch replicas: guards nested under the verified
//     branch, the edit judging the stored old value, the create guard moved
//     before receipt recovery, the final guard returning after DML instead of
//     raising, the final guard neutralized, the handler inserting a verdict
//     row — every one is caught by a row of this suite;
//   * proves the regenerated rollback is phase-safe on THREE baselines, that
//     the helper-less mutant installs a latent runtime outage, that the
//     helper ACL is canonicalized to EXACTLY the captured writer owners
//     (rogue grantee + PUBLIC revoked on rollback and re-apply; a transform
//     without the canonicalization FAILS its own verification);
//   * EXECUTES the operator preflight on the 018 baseline and after 019.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const mig = (f) => fs.readFileSync(path.join(repoRoot, 'database/migrations', f), 'utf8');
const gen = require(path.join(repoRoot, 'database/migrations/tools/prt-guard-transform.js'));

let checks = 0;
const results = [];
async function check(name, f) {
  try { await f(); checks++; results.push(`  ✓ ${name}`); }
  catch (err) {
    results.push(`  ✗ ${name}\n      ${String(err.message).slice(0, 600)}`);
    results.forEach((x) => console.log(x));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

let PGlite, pgcrypto;
async function freshDb() {
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
  await db.exec(fs.readFileSync(path.join(repoRoot, 'database/linkmia-schema.sql'), 'utf8'));
  const files = fs.readdirSync(path.join(repoRoot, 'database/migrations'))
    .filter((f) => /^0\d\d_/.test(f) && !/preflight|^018_|^019_/.test(f)).sort();
  for (const f of files) await db.exec(mig(f));
  return db;
}
// 018 baseline, optionally + an artifact (the real 019 or a mutant). Every
// artifact must COMMIT on its own — a mutant that cannot even install is a
// different (static) class and is asserted separately.
async function baselineDb(...artifacts) {
  const db = await freshDb();
  let r = await tryExec(db, mig('018_r1_route_content_non_retention.sql'));
  assert.ok(r.ok, r.error);
  for (const a of artifacts) { r = await tryExec(db, a); assert.ok(r.ok, 'artifact must commit: ' + (r.error || '')); }
  return db;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
async function tryExec(db, sql) {
  try { await db.exec(sql); return { ok: true }; }
  catch (e) { try { await db.exec('ROLLBACK'); } catch (_) {} return { ok: false, error: e.message }; }
}
const uuid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedCustomer(db, name) {
  const authUserId = uuid();
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [authUserId, `${authUserId}@example.invalid`]);
  const c = await one(db,
    `INSERT INTO customers (name, phone, email, type, source, user_id)
     VALUES ($1,'0000000019',$2,'guest','website',$3) RETURNING id`,
    [name, `${authUserId}@example.invalid`, authUserId]);
  return { authUserId, customerId: c.id };
}

function bookingJson(trip, name, pickupIso, extra = {}) {
  return JSON.stringify({
    trip_id: trip, customer_name: name, customer_phone: '0000000019',
    pickup_location: 'prt-origin', dropoff_location: 'prt-destination',
    pickup_datetime: pickupIso, passengers: 1, bags: 0,
    vehicle_type: 'sedan', vehicle_name: 'Tesla Model Y',
    booking_mode: 'dropoff', source: 'website', ...extra,
  });
}

// ---- token kinds (018 verdict contract) -----------------------------------
// verified     : jti + digest + the exact signed projection + canonical intent
// no_token     : nothing token-shaped at all
// verify_failed: ONLY the presented token digest
const KINDS = ['verified', 'no_token', 'verify_failed'];
function tokenArgs(kind, who, purpose, pickupMs, extra = {}) {
  if (kind === 'no_token') return { verdict: 'no_token', jti: null, digest: null, payload: null, place: null, airport: null, vehicle: null };
  if (kind === 'verify_failed') return { verdict: 'verify_failed', jti: null, digest: sha('bad-' + uuid()), payload: null, place: null, airport: null, vehicle: null };
  const jti = uuid();
  const iat = Date.now() - 1000;
  const payload = {
    v: 2, kid: 'prt-test', jti, purpose, authUserId: who.authUserId, customerId: who.customerId,
    ...(purpose === 'edit' ? { bookingId: extra.bookingId, assignmentEpoch: 0 } : {}),
    vehicle: 'tesla', pickupAtMs: pickupMs, commitment: 'a'.repeat(64), routeQuality: 'traffic_aware',
    finalCents: 4000, pricingVersion: 'prt-test', engineVersion: 'prt-test', resolvedVersion: 'prt-test',
    iat, exp: iat + 900000,
  };
  return { verdict: 'verified', jti, digest: sha('tok-' + jti), payload: JSON.stringify(payload),
    place: 'prt-canonical-place', airport: 'MIA', vehicle: 'tesla' };
}
const isoOf = (ms) => new Date(ms).toISOString();

// Writers as service_role (the endpoints' role). `kind` selects the token
// contract; `token` lets an exact retry reuse the identical arguments.
// opts.noOpId: an operationId-less caller (p_operation_request_id AND
// p_request_digest NULL) — the legacy lane update-pending-booking tolerates in
// off/observe; the browser never takes it.
async function rpcCreate(db, who, opId, pickupMs, opts = {}) {
  const kind = opts.kind || 'no_token';
  const t = opts.token || tokenArgs(kind, who, 'create', pickupMs);
  const trip = opts.trip || 'PRT-' + (opId || uuid()).slice(0, 8);
  const reqId = opts.noOpId ? null : opId;
  await db.exec('SET ROLE service_role');
  try {
    const r = await one(db,
      `SELECT accept_quote_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS r`,
      [who.authUserId, who.customerId, reqId, reqId ? sha(reqId) : null, t.verdict, t.jti, t.digest, t.payload,
       opts.price ?? 40.0, t.place, t.airport, t.vehicle, bookingJson(trip, 'PRT Passenger', isoOf(pickupMs))]);
    return r.r;
  } finally { await db.exec('RESET ROLE'); }
}
async function rpcEdit(db, who, opId, bookingId, version, edit, opts = {}) {
  const kind = opts.kind || 'no_token';
  const pickupMs = opts.pickupMs;
  const t = opts.token || tokenArgs(kind, who, 'edit', pickupMs, { bookingId });
  const editJson = { ...edit };
  if (pickupMs !== undefined && pickupMs !== null) editJson.pickup_datetime = isoOf(pickupMs);
  const reqId = opts.noOpId ? null : opId;
  await db.exec('SET ROLE service_role');
  try {
    const r = await one(db,
      `SELECT accept_quote_edit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) AS r`,
      [who.authUserId, who.customerId, reqId, reqId ? sha(reqId) : null, bookingId, version, t.verdict, t.jti, t.digest, t.payload,
       opts.price ?? 41.0, t.place, t.airport, t.vehicle, JSON.stringify(editJson)]);
    return r.r;
  } finally { await db.exec('RESET ROLE'); }
}
const installedFp = async (db) => {
  const rows = (await db.query(`SELECT proname, encode(extensions.digest(prosrc,'sha256'),'hex') AS fp FROM pg_proc WHERE proname IN ('accept_quote_create','accept_quote_edit')`)).rows;
  return Object.fromEntries(rows.map((r) => [r.proname === 'accept_quote_create' ? 'create' : 'edit', r.fp]));
};
async function counts(db) {
  return one(db, `SELECT (SELECT count(*) FROM bookings)::int AS b, (SELECT count(*) FROM quote_acceptances)::int AS a,
    (SELECT count(*) FROM operation_receipts)::int AS r, (SELECT count(*) FROM quote_verifications)::int AS v`);
}
const futureMs = (ms = 86400000) => Date.now() + ms;
const pastMs = (ms = 60000) => Date.now() - ms;

async function setMode(db, mode) {
  const row = await one(db, `SELECT * FROM set_pricing_mode($1, 'test')`, [mode]);
  assert.strictEqual(row.mode, mode);
  return row;
}
async function modeRow(db) { return one(db, `SELECT mode, enforcement_started_at FROM pricing_state WHERE singleton`); }

// FINAL-guard crossing: inside ONE transaction the pickup is fixed at
// transaction_timestamp() + 20 ms (so the pre-mutation guard, which reads the
// transaction-stable clock, PASSES), then the session sleeps 50 ms BEFORE the
// writer runs, so clock_timestamp() at the final guard is already past the
// pickup. Deterministic on any engine speed; verified tokens carry the SAME
// millisecond in pickupAtMs (the RPC requires exact equality).
async function crossing(db, who, writer, kind, extra = {}) {
  await db.exec('SET ROLE service_role');
  let out;
  try {
    await db.exec('BEGIN');
    const { ms } = await one(db, `SELECT (floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint + 20)::text AS ms`);
    const pickupMs = Number(ms);
    await db.query(`SELECT pg_sleep(0.05)`);
    if (writer === 'create') {
      const opId = extra.noOpId ? null : uuid();
      const t = tokenArgs(kind, who, 'create', pickupMs);
      const r = await one(db,
        `SELECT accept_quote_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS r`,
        [who.authUserId, who.customerId, opId, opId ? sha(opId) : null, t.verdict, t.jti, t.digest, t.payload,
         40.0, t.place, t.airport, t.vehicle, bookingJson('PRT-X-' + (opId || uuid()).slice(0, 8), 'PRT Passenger', isoOf(pickupMs))]);
      out = r.r;
    } else {
      const opId = extra.noOpId ? null : uuid();
      const t = tokenArgs(kind, who, 'edit', pickupMs, { bookingId: extra.bookingId });
      const r = await one(db,
        `SELECT accept_quote_edit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) AS r`,
        [who.authUserId, who.customerId, opId, opId ? sha(opId) : null, extra.bookingId, extra.version, t.verdict, t.jti, t.digest, t.payload,
         41.0, t.place, t.airport, t.vehicle, JSON.stringify({ pickup_datetime: isoOf(pickupMs) })]);
      out = r.r;
    }
    // The rpc_writer GUC is set with set_config(..., TRUE) — TRANSACTION-LOCAL —
    // so it must be read INSIDE the transaction, before COMMIT reverts it.
    // (Reading it after COMMIT is vacuous: it is '' whatever the handler did.)
    const guc = await one(db, `SELECT current_setting('linkmia.rpc_writer', true) AS w`);
    out = { ...out, rpc_writer_after: guc.w };
    await db.exec('COMMIT');
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch (_) {}
    await db.exec('RESET ROLE');
    throw e;
  }
  await db.exec('RESET ROLE');
  return out;
}

// ---- artifact surgery for executed mutants --------------------------------
// A mutant models a REGENERATED artifact whose generator produced a different
// body: the embedded post-replacement fingerprint for that writer is recomputed
// to match, exactly as a regenerated artifact would carry it. (An artifact whose
// body was altered WITHOUT that recomputation is refused by the artifact itself —
// proven by its own row below.)
function withBody(artifact, name, fn, opts = {}) {
  const body = gen.extract(artifact, name);
  const mutated = fn(body);
  assert.notStrictEqual(mutated, body, `${name}: mutation must change the body`);
  // function replacer: the bodies are $$-quoted and a string replacement would interpret `$$`
  let out = artifact.replace(body, () => mutated);
  if (!opts.keepFingerprint) {
    const oldFp = gen.sha256(gen.bodyOf(body));
    const newFp = gen.sha256(gen.bodyOf(mutated));
    assert.strictEqual(out.split(oldFp).length - 1, 1, `${name}: the artifact embeds its post-replacement fingerprint exactly once`);
    out = out.replace(oldFp, newFp);
  }
  return out;
}
const PRE_GUARD_LINE = 'IF NOT public.linkmia_pickup_is_future(v_pickup_at, transaction_timestamp()) THEN';
const FINAL_RAISE = "RAISE EXCEPTION USING ERRCODE = 'ZQ019', MESSAGE = 'pickup_time_elapsed';";

// ---- operator preflight, executed --------------------------------------------
// Every BEGIN..ROLLBACK unit is counted; a unit without a `-- X1.` label is
// reported, never silently skipped (an operator would run it; the suite must).
function preflightUnits(sql) {
  const units = {}; const unlabeled = []; let total = 0;
  for (const raw of sql.split(/\nROLLBACK;\n?/)) {
    const stmt = raw.split('\n').filter((l) => !/^\s*--/.test(l))
      .join('\n').replace(/BEGIN;/g, '').replace(/SET TRANSACTION READ ONLY;/g, '').trim();
    if (!stmt) continue;
    total++;
    const label = /--\s*([A-Z]\d+)\./.exec(raw);
    if (!label) { unlabeled.push(stmt.slice(0, 80)); continue; }
    if (units[label[1]]) { unlabeled.push('DUPLICATE ' + label[1]); continue; }
    units[label[1]] = stmt;
  }
  return { units, unlabeled, total };
}
async function runPreflight(db) {
  const { units, unlabeled, total } = preflightUnits(mig('019_prt_preflight.sql'));
  assert.deepStrictEqual(unlabeled, [], 'every preflight unit carries a unique label — otherwise it would be silently skipped');
  assert.strictEqual(Object.keys(units).length, total, 'every unit is executed');
  const out = {};
  for (const [k, stmt] of Object.entries(units)) out[k] = (await db.query(stmt)).rows;
  return out;
}

(async () => {
  console.log('\nPR-T — pickup-time integrity (executed on PGlite)\n');

  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  const m018 = mig('018_r1_route_content_non_retention.sql');
  const m019 = mig('019_prt_pickup_time_integrity.sql');
  const rollback = mig('018_r1_rollback.sql');
  const WRITERS = [['accept_quote_create', 'created'], ['accept_quote_edit', 'updated']];

  // ================================================================ artifacts
  await check('both artifacts, the preflight fingerprint block and the runbook checksum table equal the guard transform byte-for-byte (generated, never hand-edited); the recorded checksums are the files\' sha256', async () => {
    const g = gen.generate();
    assert.strictEqual(m019, g.migration, '019 drifted from the generator');
    assert.strictEqual(rollback, g.rollback, 'the rollback drifted from the generator');
    const c = gen.check();
    assert.deepStrictEqual(c, { migration: true, rollback: true, preflight: true, runbook: true }, JSON.stringify(c));
    assert.strictEqual(gen.sha256(m019), g.checksums.migration);
    assert.strictEqual(gen.sha256(rollback), g.checksums.rollback);
    const runbook = fs.readFileSync(path.join(repoRoot, 'docs/PRT-MIGRATION-RUNBOOK.md'), 'utf8');
    assert.ok(runbook.includes(g.checksums.migration) && runbook.includes(g.checksums.rollback), 'the runbook records both file checksums');
    for (const k of ['reviewed018', 'target019', 'rollback']) for (const w of ['create', 'edit']) {
      assert.ok(runbook.includes(g.fps.fp[k][w]), `runbook records the ${k}/${w} body fingerprint`);
    }
    const pre = fs.readFileSync(path.join(repoRoot, 'database/migrations/019_prt_preflight.sql'), 'utf8');
    assert.ok(pre.includes(g.fps.fp.reviewed018.create) && pre.includes(g.fps.fp.reviewed018.edit) && pre.includes(g.fps.fp.target019.create), 'preflight A2 carries the expected fingerprints');
    // the artifacts embed ORDERED PAIRS: 019 exactly the reviewed-018 pair; the rollback the three coherent pairs — never a mixed one
    const pair = (p) => `('${p.create}', '${p.edit}')`;
    const f = g.fps.fp;
    assert.ok(m019.includes(`IN (${pair(f.reviewed018)}))`), '019 accepts only the reviewed 018 pair');
    assert.ok(!m019.includes(pair(f.target019)) && !m019.includes(pair(f.rollback)), '019 accepts no other pair');
    assert.ok(rollback.includes(`IN (${pair(f.reviewed018)}, ${pair(f.target019)}, ${pair(f.rollback)}))`), 'the rollback accepts exactly the three coherent pairs');
    for (const [a, b] of [[f.target019.create, f.reviewed018.edit], [f.reviewed018.create, f.target019.edit], [f.rollback.create, f.target019.edit]]) {
      assert.ok(!rollback.includes(`('${a}', '${b}')`), 'no mixed pair is embedded');
    }
  });

  await check('STATEMENT ORDER: pre-mutation guard AFTER receipt recovery and before rpc_writer on; final guard the LAST blocking statement — after the telemetry insert, before set_config off + RETURN', async () => {
    for (const artifact of [m019, rollback]) {
      for (const [name, outcome] of WRITERS) {
        const body = gen.extract(artifact, name);
        const ret = body.indexOf(`RETURN jsonb_build_object('outcome', '${outcome}'`);
        const off = body.lastIndexOf("PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);", ret);
        const finalGuard = body.lastIndexOf('linkmia_pickup_is_future(v_pickup_at, clock_timestamp())', ret);
        const telemetry = body.lastIndexOf('INSERT INTO quote_verifications (', ret);
        assert.ok(telemetry < finalGuard && finalGuard < off && off < ret, `${name}: telemetry(${telemetry}) < guard(${finalGuard}) < off(${off}) < return(${ret})`);
        const pre = body.indexOf('linkmia_pickup_is_future(v_pickup_at, transaction_timestamp())');
        const on = body.indexOf("PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);");
        const receipt = body.lastIndexOf('FROM operation_receipts', on);
        assert.ok(pre > 0 && pre < on, `${name}: pre-mutation guard must precede rpc_writer on`);
        assert.ok(receipt > 0 && receipt < pre, `${name}: receipt recovery (${receipt}) must precede the pre-mutation guard (${pre}) — a moved guard would refuse honest retries`);
        assert.ok(body.includes("WHEN SQLSTATE 'ZQ019' THEN"));
        assert.ok(!body.includes("v_effective_verdict := 'pickup_time_elapsed'"));
      }
    }
    const create018 = gen.extract(m018, 'accept_quote_create');
    assert.strictEqual(create018.replace(gen.FINAL_GUARD, ''), create018, 'baseline has no guard yet');
  });

  await check('STATIC SCOPE: exactly one ZQ019 raise + one handler per body (forward AND rollback), ZQ017 quote-time-only and unchanged, no table constraint/trigger/policy, helper referenced by the two writers ONLY, no other status/cancel path widened', async () => {
    for (const [label, artifact, src] of [['019', m019, m018], ['rollback', rollback, mig('017_quote_enforcement_foundation.sql')]]) {
      let helperRefs = 0;
      for (const [name] of WRITERS) {
        const body = gen.extract(artifact, name);
        const count = (s) => body.split(s).length - 1;
        assert.strictEqual(count("ERRCODE = 'ZQ019'"), 1, `${label}/${name}: exactly one ZQ019 raise`);
        assert.strictEqual(count("WHEN SQLSTATE 'ZQ019'"), 1, `${label}/${name}: exactly one ZQ019 handler`);
        assert.strictEqual(count('ZQ019'), 2, `${label}/${name}: no other ZQ019 use`);
        const srcBody = gen.extract(src, name);
        assert.strictEqual(count('ZQ017'), srcBody.split('ZQ017').length - 1, `${label}/${name}: ZQ017 count unchanged (never reused for the pickup guard)`);
        assert.strictEqual(count('linkmia_pickup_is_future(v_pickup_at, transaction_timestamp())'), 1, `${label}/${name}: one pre-mutation guard`);
        assert.strictEqual(count('linkmia_pickup_is_future(v_pickup_at, clock_timestamp())'), 1, `${label}/${name}: one final guard`);
        helperRefs += count('IF NOT public.linkmia_pickup_is_future(v_pickup_at');
        // between rpc_writer on and the EXCEPTION section the outcome is only ever RAISED, never RETURNED after DML
        const on = body.indexOf("PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);");
        const excRel = /\n\s*EXCEPTION\b/.exec(body.slice(on));
        assert.ok(excRel, `${label}/${name}: inner EXCEPTION section located`);
        const mid = body.slice(on, on + excRel.index);
        assert.ok(!mid.includes("RETURN jsonb_build_object('outcome', 'pickup_time_elapsed')"), `${label}/${name}: no RETURN of the outcome after DML — the final guard must RAISE`);
        assert.ok(mid.includes(FINAL_RAISE), `${label}/${name}: the final guard raises`);
      }
      // the CALL form (the verification block only quotes the guard inside LIKE patterns, without the schema prefix)
      assert.strictEqual(artifact.split('IF NOT public.linkmia_pickup_is_future(v_pickup_at').length - 1, helperRefs, `${label}: every guard call lives inside the two writer bodies`);
      assert.strictEqual(helperRefs, 4, `${label}: two guards per writer, nothing else`);
      assert.ok(!/ALTER TABLE|ADD CONSTRAINT|CREATE TRIGGER|CREATE POLICY|CREATE INDEX/i.test(artifact), `${label}: no table constraint, trigger, policy or index — the rule is a writer guard`);
      assert.ok(!/FUNCTION\s+(public\.)?accept_optional_edit/.test(artifact), `${label}: accept_optional_edit untouched (the header may name it; nothing may define it)`);
      assert.ok(!/GRANT EXECUTE ON FUNCTION public\.linkmia_pickup_is_future[^;]*TO (service_role|anon|authenticated|PUBLIC)/.test(artifact), `${label}: the helper is never exposed as an RPC`);
    }
    // no other migration or backend path knows the helper or the outcome
    const dir = path.join(repoRoot, 'database/migrations');
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      if (f === '019_prt_pickup_time_integrity.sql' || f === '018_r1_rollback.sql' || f === '019_prt_preflight.sql') continue;
      assert.ok(!mig(f).includes('linkmia_pickup_is_future'), `${f} must not reference the helper`);
    }
    const backend = path.join(repoRoot, 'backend/functions');
    const walk = (d) => fs.readdirSync(d).flatMap((f) => { const p = path.join(d, f); return fs.statSync(p).isDirectory() ? walk(p) : [p]; });
    const knowing = walk(backend).filter((p) => p.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('pickup_time_elapsed')).map((p) => path.relative(repoRoot, p)).sort();
    assert.deepStrictEqual(knowing, ['backend/functions/lib/booking-writer.js', 'backend/functions/quote-ride.js'],
      'ONLY the writer registry and the quote endpoint know the outcome — cancel-core, update-booking-status and every other status path stay untouched');
  });

  // ================================================================ chain + comparator
  const db = await freshDb();
  await check('chain: schema + 001..017 -> exact 018 -> exact 019 apply on a fresh replica (mode off); the installed bodies fingerprint EXACTLY as the generator derives them from the migration text (018 before, 019 after)', async () => {
    let r = await tryExec(db, m018); assert.ok(r.ok, r.error);
    const g = gen.generate();
    assert.deepStrictEqual(await installedFp(db), g.fps.fp.reviewed018, 'a clean 018 install carries exactly the reviewed 018 fingerprints (prosrc == the dollar-quoted body)');
    r = await tryExec(db, m019); assert.ok(r.ok, r.error);
    assert.deepStrictEqual(await installedFp(db), g.fps.fp.target019, 'after 019 the installed bodies are exactly the target bodies');
    assert.strictEqual((await modeRow(db)).mode, 'off');
  });

  await check('MIXED PAIRS: one writer at 019 and the other at 018 (both inverses) and a rollback-body mix are NOT reviewed states — the rollback AND 019 abort before the helper or either writer changes; fingerprints, owner, ACL and config read back unchanged', async () => {
    const g = gen.generate();
    const meta = async (d) => (await d.query(`SELECT proname, proowner::int AS owner, proacl::text AS acl, proconfig::text AS cfg, encode(extensions.digest(prosrc,'sha256'),'hex') AS fp FROM pg_proc WHERE proname IN ('accept_quote_create','accept_quote_edit') ORDER BY proname`)).rows;
    const states = [
      ['create@019 + edit@018', gen.extract(m019, 'accept_quote_create'), { create: g.fps.fp.target019.create, edit: g.fps.fp.reviewed018.edit }],
      ['create@018 + edit@019', gen.extract(m019, 'accept_quote_edit'), { create: g.fps.fp.reviewed018.create, edit: g.fps.fp.target019.edit }],
      ['create@rollback + edit@018', gen.extract(rollback, 'accept_quote_create'), { create: g.fps.fp.rollback.create, edit: g.fps.fp.reviewed018.edit }],
    ];
    for (const [label, install, expectFp] of states) {
      const d = await baselineDb();
      await d.exec(install);
      assert.deepStrictEqual(await installedFp(d), expectFp, `${label}: mixed state installed`);
      const before = await meta(d);
      const helpers = (await one(d, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'linkmia_pickup_is_future'`)).n;
      for (const [name, artifact] of [['rollback', rollback], ['019', m019]]) {
        const r = await tryExec(d, artifact);
        assert.ok(!r.ok && /is not a recognized reviewed pair/.test(r.error), `${label}: ${name} must refuse the mixed pair: ` + (r.error || 'committed?!'));
        assert.deepStrictEqual(await meta(d), before, `${label}: ${name} changed nothing (fingerprints/owner/ACL/config)`);
        assert.strictEqual((await one(d, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'linkmia_pickup_is_future'`)).n, helpers, `${label}: ${name} did not create the helper`);
      }
    }
  });

  await check('SABOTAGE: a ONE-CHARACTER comment change in an installed writer keeps every marker check green but STOPS migration 019 AND the rollback at the fingerprint gate with zero changes; restoring the exact reviewed body lets 019 through', async () => {
    const d = await baselineDb();
    // sabotage = one trailing comment character inside the body: valid SQL,
    // identical behaviour, every marker still matches — only prosrc differs
    const sabotage = (fn) => { const i = fn.lastIndexOf('END $$;'); assert.ok(i > 0); return fn.slice(0, i) + 'END -- x\n$$;'; };
    const sab = sabotage(gen.extract(m018, 'accept_quote_create'));
    assert.notStrictEqual(sab, gen.extract(m018, 'accept_quote_create'), 'sabotage applied');
    await d.exec(sab);
    const marker = await one(d, `SELECT pg_get_functiondef(oid) LIKE '%NULL::INTEGER%' AS m FROM pg_proc WHERE proname = 'accept_quote_create'`);
    assert.strictEqual(marker.m, true, 'the old marker check would still say 018');
    const fpBefore = await installedFp(d);
    let r = await tryExec(d, m019);
    assert.ok(!r.ok && /is not a recognized reviewed pair \(accept_quote_create body fingerprint/.test(r.error), '019 refuses: ' + (r.error || 'committed?!'));
    assert.strictEqual((await one(d, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'linkmia_pickup_is_future'`)).n, 0, 'the refusal happened before the helper was created — nothing changed');
    assert.deepStrictEqual(await installedFp(d), fpBefore, 'bodies untouched');
    r = await tryExec(d, rollback);
    assert.ok(!r.ok && /is not a recognized reviewed pair/.test(r.error), 'the rollback refuses the same unreviewed body: ' + (r.error || 'committed?!'));
    // restore the exact reviewed body -> 019 applies
    await d.exec(gen.extract(m018, 'accept_quote_create'));
    assert.deepStrictEqual(await installedFp(d), gen.generate().fps.fp.reviewed018);
    r = await tryExec(d, m019); assert.ok(r.ok, r.error);
    // now sabotage the EDIT writer on the post-019 state: the rollback must refuse it too
    const sabEdit = sabotage(gen.extract(m019, 'accept_quote_edit'));
    await d.exec(sabEdit);
    r = await tryExec(d, rollback);
    assert.ok(!r.ok && /is not a recognized reviewed pair \(accept_quote_create body fingerprint .*accept_quote_edit body fingerprint/.test(r.error), 'rollback refuses a sabotaged edit writer: ' + (r.error || 'committed?!'));
  });

  await check('COMPARATOR (transaction-stable clock): exact now is refused, one microsecond later passes', async () => {
    const row = await one(db, `SELECT
      public.linkmia_pickup_is_future(now(), now()) AS exact_now,
      public.linkmia_pickup_is_future(now() + interval '1 microsecond', now()) AS one_us_later,
      public.linkmia_pickup_is_future(now() - interval '1 microsecond', now()) AS one_us_earlier`);
    assert.strictEqual(row.exact_now, false);
    assert.strictEqual(row.one_us_later, true);
    assert.strictEqual(row.one_us_earlier, false);
  });

  await check('COMPARATOR MUTANT: a `>` -> `>=` helper makes exact-now pass — this row catches it', async () => {
    await db.exec(`CREATE FUNCTION pg_temp.mutant_ge(p TIMESTAMPTZ, a TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT p >= a $$`);
    const row = await one(db, `SELECT pg_temp.mutant_ge(now(), now()) AS exact_now`);
    assert.strictEqual(row.exact_now, true, 'the mutant admits exact now, which the real assertion above refuses');
  });

  const helperAcl = (d) => one(d, `SELECT count(*) OVER () AS n, p.provolatile, p.proisstrict, p.prosecdef,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_x,
        p.proowner = (SELECT proowner FROM pg_proc WHERE proname = 'accept_quote_create') AS writer_owned,
        (SELECT array_agg(DISTINCT pg_get_userbyid((x.a).grantee) ORDER BY pg_get_userbyid((x.a).grantee))
           FROM (SELECT aclexplode(p.proacl) AS a) x WHERE (x.a).privilege_type = 'EXECUTE') AS grantees,
        (SELECT array_agg(DISTINCT pg_get_userbyid(w.proowner) ORDER BY pg_get_userbyid(w.proowner))
           FROM pg_proc w WHERE w.proname IN ('accept_quote_create','accept_quote_edit')) AS writer_owners
      FROM pg_proc p WHERE p.proname = 'linkmia_pickup_is_future'`);

  await check('HELPER: one signature, IMMUTABLE STRICT, security invoker, writer-owned, EXECUTE grantees EXACTLY the writer owners (no PUBLIC, no client or service role) — and the SECURITY DEFINER writers still call it', async () => {
    const h = await helperAcl(db);
    assert.strictEqual(Number(h.n), 1);
    assert.strictEqual(h.provolatile, 'i'); assert.strictEqual(h.proisstrict, true); assert.strictEqual(h.prosecdef, false);
    assert.strictEqual(h.anon_x, false); assert.strictEqual(h.auth_x, false); assert.strictEqual(h.sr_x, false);
    assert.strictEqual(h.writer_owned, true);
    assert.deepStrictEqual(h.grantees, h.writer_owners, 'exact grantee set');
    const who = await seedCustomer(db, 'PRT-HELPER');
    assert.strictEqual((await rpcCreate(db, who, uuid(), futureMs())).outcome, 'created');
  });

  // ================================================================ THE AUTHORITY MATRIX
  // {off, observe} x {verified, no_token, verify_failed} for BOTH writers.
  async function grid(d, modeLabel) {
    assert.strictEqual((await modeRow(d)).mode, modeLabel);
    for (const kind of KINDS) {
      const tag = `${modeLabel}/${kind}`;
      const who = await seedCustomer(d, `PRT-${tag}`);
      // create: elapsed -> refused, ZERO writes (booking, acceptance, receipt, telemetry)
      let before = await counts(d);
      let r = await rpcCreate(d, who, uuid(), pastMs(), { kind });
      assert.strictEqual(r.outcome, 'pickup_time_elapsed', `${tag} create elapsed: ${JSON.stringify(r)}`);
      assert.deepStrictEqual(await counts(d), before, `${tag} create elapsed wrote something`);
      r = await rpcCreate(d, who, uuid(), Date.now(), { kind });
      assert.strictEqual(r.outcome, 'pickup_time_elapsed', `${tag} an already-arrived instant is not future`);
      // create: future -> created; verified PROVABLY records an acceptance
      r = await rpcCreate(d, who, uuid(), futureMs(), { kind });
      assert.strictEqual(r.outcome, 'created', `${tag} create future: ${JSON.stringify(r)}`);
      let after = await counts(d);
      assert.strictEqual(after.b - before.b, 1, `${tag} one booking`);
      assert.strictEqual(after.a - before.a, kind === 'verified' ? 1 : 0, `${tag} acceptance recorded iff verified`);
      assert.strictEqual(after.r - before.r, 1, `${tag} one receipt`);
      const bookingId = r.booking_id;
      // edit: elapsed proposal -> refused, ZERO writes, row untouched
      before = await counts(d);
      r = await rpcEdit(d, who, uuid(), bookingId, 1, { notes: 'x' }, { kind, pickupMs: pastMs() });
      assert.strictEqual(r.outcome, 'pickup_time_elapsed', `${tag} edit elapsed: ${JSON.stringify(r)}`);
      assert.deepStrictEqual(await counts(d), before, `${tag} edit elapsed wrote something`);
      assert.strictEqual((await one(d, `SELECT details_version FROM bookings WHERE id = $1`, [bookingId])).details_version, 1);
      // edit: the stored row's time passes (simulated) -> a future proposal RESCUES it
      await d.query(`UPDATE bookings SET pickup_datetime = now() - interval '1 minute' WHERE id = $1`, [bookingId]);
      if (kind !== 'verified') {
        r = await rpcEdit(d, who, uuid(), bookingId, 1, { notes: 'note only' }, { kind });
        assert.strictEqual(r.outcome, 'pickup_time_elapsed', `${tag} no proposal: the RESOLVED (stored, elapsed) pickup is judged`);
      }
      before = await counts(d);
      r = await rpcEdit(d, who, uuid(), bookingId, 1, { notes: 'rescued' }, { kind, pickupMs: futureMs(2 * 86400000) });
      assert.strictEqual(r.outcome, 'updated', `${tag} rescue: ${JSON.stringify(r)}`);
      assert.strictEqual(r.details_version, 2, `${tag} rescue bumps the version`);
      after = await counts(d);
      assert.strictEqual(after.a - before.a, kind === 'verified' ? 1 : 0, `${tag} edit acceptance recorded iff verified`);
    }
  }

  await check('MATRIX off x {verified, no_token, verify_failed}, BOTH writers: elapsed refused with zero writes, future accepted, elapsed proposal refused, elapsed stored row rescued', async () => {
    await grid(db, 'off');
  });

  const dbObs = await baselineDb(m019);
  await check('MATRIX observe (reached ONLY via set_pricing_mode, enforcement_started_at stays NULL) x {verified, no_token, verify_failed}, BOTH writers', async () => {
    const row = await setMode(dbObs, 'observe');
    assert.strictEqual(row.enforcement_started_at, null);
    assert.strictEqual((await one(dbObs, `SELECT count(*)::int AS n FROM pricing_state_audit WHERE to_mode = 'observe' AND actor = 'test'`)).n, 1, 'audited transition');
    await grid(dbObs, 'observe');
  });

  await check('MATRIX enforce x verified, BOTH writers (observe -> enforce via set_pricing_mode on its own replica); no_token/verify_failed answer the 017 registry refusals BEFORE any clock — which is why the ratified matrix excludes them', async () => {
    const dbEnf = await baselineDb(m019);
    await setMode(dbEnf, 'observe');
    const row = await setMode(dbEnf, 'enforce');
    assert.ok(row.enforcement_started_at, 'high-water mark set');
    const who = await seedCustomer(dbEnf, 'PRT-ENFORCE');
    let before = await counts(dbEnf);
    let r = await rpcCreate(dbEnf, who, uuid(), pastMs(), { kind: 'verified' });
    assert.strictEqual(r.outcome, 'pickup_time_elapsed');
    assert.deepStrictEqual(await counts(dbEnf), before, 'enforce/verified elapsed create wrote nothing');
    r = await rpcCreate(dbEnf, who, uuid(), futureMs(), { kind: 'verified' });
    assert.strictEqual(r.outcome, 'created');
    const booked = await one(dbEnf, `SELECT price_authority, price_cents FROM bookings WHERE id = $1`, [r.booking_id]);
    assert.strictEqual(booked.price_authority, 'server_quote'); assert.strictEqual(booked.price_cents, 4000);
    before = await counts(dbEnf);
    const e = await rpcEdit(dbEnf, who, uuid(), r.booking_id, 1, {}, { kind: 'verified', pickupMs: pastMs() });
    assert.strictEqual(e.outcome, 'pickup_time_elapsed');
    assert.deepStrictEqual(await counts(dbEnf), before, 'enforce/verified elapsed edit wrote nothing');
    const ok = await rpcEdit(dbEnf, who, uuid(), r.booking_id, 1, {}, { kind: 'verified', pickupMs: futureMs(2 * 86400000) });
    assert.strictEqual(ok.outcome, 'updated');
    // the excluded lanes: 017's enforce refusals precede the guard (registry outcomes, no booking)
    before = await counts(dbEnf);
    assert.strictEqual((await rpcCreate(dbEnf, who, uuid(), pastMs(), { kind: 'no_token' })).outcome, 'quote_required');
    assert.strictEqual((await rpcCreate(dbEnf, who, uuid(), pastMs(), { kind: 'verify_failed' })).outcome, 'quote_invalid');
    const after = await counts(dbEnf);
    assert.strictEqual(after.b, before.b, 'no booking from an unverified enforce call');
  });

  // ================================================================ receipt-first replay, per kind
  await check('RECEIPT-FIRST per token kind (observe): an exact retry of a committed create AND edit lands on its receipt after the pickup elapsed — never a clock refusal', async () => {
    for (const kind of KINDS) {
      const who = await seedCustomer(dbObs, `PRT-REPLAY-${kind}`);
      const opId = uuid();
      const pickup = Date.now() + 700;
      const token = tokenArgs(kind, who, 'create', pickup);
      const first = await rpcCreate(dbObs, who, opId, pickup, { kind, token, trip: 'PRT-RP-' + opId.slice(0, 6) });
      assert.strictEqual(first.outcome, 'created', `${kind}: ${JSON.stringify(first)}`);
      // and an edit of a far-future booking whose proposed time elapses before the retry
      const who2 = await seedCustomer(dbObs, `PRT-REPLAY-EDIT-${kind}`);
      const far = await rpcCreate(dbObs, who2, uuid(), futureMs(), { kind: 'no_token' });
      assert.strictEqual(far.outcome, 'created');
      const eop = uuid();
      const epick = Date.now() + 700;
      const etoken = tokenArgs(kind, who2, 'edit', epick, { bookingId: far.booking_id });
      const efirst = await rpcEdit(dbObs, who2, eop, far.booking_id, 1, {}, { kind, token: etoken, pickupMs: epick });
      assert.strictEqual(efirst.outcome, 'updated', `${kind} edit: ${JSON.stringify(efirst)}`);
      await sleep(800);
      const retry = await rpcCreate(dbObs, who, opId, pickup, { kind, token, trip: 'PRT-RP-' + opId.slice(0, 6) });
      assert.strictEqual(retry.outcome, 'idempotent', `${kind}: receipt recovery precedes every clock: ${JSON.stringify(retry)}`);
      assert.strictEqual(retry.booking_id, first.booking_id);
      const eretry = await rpcEdit(dbObs, who2, eop, far.booking_id, 1, {}, { kind, token: etoken, pickupMs: epick });
      assert.strictEqual(eretry.outcome, 'idempotent', `${kind} edit replay: ${JSON.stringify(eretry)}`);
    }
  });

  await check('CREATE: a future pickup still books — there is NO lead-time policy (one second suffices)', async () => {
    const who = await seedCustomer(db, 'PRT-CREATE-SOON');
    assert.strictEqual((await rpcCreate(db, who, uuid(), futureMs(1000))).outcome, 'created');
  });

  await check('EDIT: lifecycle and version conflicts WIN over an elapsed time (owner/status/version gates run first)', async () => {
    const who = await seedCustomer(db, 'PRT-EDIT-GATES');
    const r = await rpcCreate(db, who, uuid(), futureMs());
    const v = await rpcEdit(db, who, uuid(), r.booking_id, 99, {}, { pickupMs: pastMs() });
    assert.strictEqual(v.outcome, 'version_conflict');
    // status alone trips the gate (assigned_driver carries an FK to drivers, so it stays NULL here)
    await db.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [r.booking_id]);
    const ne = await rpcEdit(db, who, uuid(), r.booking_id, 1, {}, { pickupMs: pastMs() });
    assert.strictEqual(ne.outcome, 'not_editable');
  });

  // ================================================================ FINAL guard (ZQ019)
  async function proveCrossing(d, modeLabel, writer, kind) {
    const who = await seedCustomer(d, `PRT-FINAL-${modeLabel}-${writer}-${kind}`);
    let extra = {};
    if (writer === 'edit') {
      const b = await rpcCreate(d, who, uuid(), futureMs(), { kind: 'no_token' });
      extra = { bookingId: b.booking_id, version: 1 };
    }
    const before = await counts(d);
    const r = await crossing(d, who, writer, kind, extra);
    assert.strictEqual(r.outcome, 'pickup_time_elapsed', `${modeLabel}/${writer}/${kind} final guard fired: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(await counts(d), before, `${modeLabel}/${writer}/${kind}: booking, acceptance, receipt AND telemetry all rolled back`);
    assert.strictEqual(r.rpc_writer_after, 'off', `${modeLabel}/${writer}/${kind}: the ZQ019 handler reset rpc_writer to 'off' — read inside the transaction`);
    if (kind === 'verified') {
      // CONTROL: the identical call with a pickup that does not elapse ENTERS
      // the acceptance path — so the crossing above rolled back a real
      // acceptance, not a lane that never inserted one.
      const c = await counts(d);
      const ok = writer === 'create'
        ? await rpcCreate(d, who, uuid(), futureMs(), { kind })
        : await rpcEdit(d, who, uuid(), extra.bookingId, 1, {}, { kind, pickupMs: futureMs() });
      assert.strictEqual(ok.outcome, writer === 'create' ? 'created' : 'updated', JSON.stringify(ok));
      const c2 = await counts(d);
      assert.strictEqual(c2.a - c.a, 1, `${modeLabel}/${writer}/${kind}: the control records an acceptance`);
      assert.strictEqual(c2.r - c.r, 1, 'and a receipt');
    }
  }
  await check('FINAL guard (live clock) — VERIFIED create and edit in off AND observe: a pickup that elapses during the write rolls back booking, ACCEPTANCE, receipt and telemetry; each paired with a control that enters the acceptance path', async () => {
    for (const [d, label] of [[db, 'off'], [dbObs, 'observe']]) {
      await proveCrossing(d, label, 'create', 'verified');
      await proveCrossing(d, label, 'edit', 'verified');
    }
  });
  await check('FINAL guard — NON-TOKEN observe paths (no_token create/edit, verify_failed create): every write rolls back', async () => {
    await proveCrossing(dbObs, 'observe', 'create', 'no_token');
    await proveCrossing(dbObs, 'observe', 'edit', 'no_token');
    await proveCrossing(dbObs, 'observe', 'create', 'verify_failed');
  });

  // ================================================================ EXECUTED MUTANTS
  await check('ALTERED PASTE: an artifact whose writer body was changed WITHOUT regenerating (embedded fingerprint stale) is refused by its own post-replacement check — the transaction aborts, nothing changes', async () => {
    const altered = withBody(m019, 'accept_quote_create', (b) => b.replace(FINAL_RAISE, FINAL_RAISE + ' -- altered'), { keepFingerprint: true });
    const d = await baselineDb();
    const fpBefore = await installedFp(d);
    const r = await tryExec(d, altered);
    assert.ok(!r.ok && /is not this artifact's generated body/.test(r.error), 'refused: ' + (r.error || 'committed?!'));
    assert.deepStrictEqual(await installedFp(d), fpBefore, 'the whole transaction rolled back');
    assert.strictEqual((await one(d, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'linkmia_pickup_is_future'`)).n, 0, 'no helper either');
  });

  // Strips the artifact's rollback-contained smoke so a mutant the smoke would
  // refuse can still be INSTALLED — to prove the executed suite rows catch it
  // on their own (two independent lines of defense).
  function withoutSmoke(artifact) {
    const a = artifact.indexOf('-- ROLLBACK-CONTAINED BEHAVIORAL SMOKE');
    const b = artifact.indexOf('$prt_smoke$;', a) + '$prt_smoke$;'.length;
    assert.ok(a > 0 && b > a, 'smoke block located');
    return artifact.slice(0, a) + artifact.slice(b);
  }

  await check('MUTANT (executed): either guard NESTED under the verified branch — the artifact\'s OWN smoke refuses to install it; with the smoke stripped it commits, and the no_token matrix rows catch it', async () => {
    let mutant = m019;
    for (const [name] of WRITERS) {
      mutant = withBody(mutant, name, (b) => b
        .replace(gen.PRE_GUARD, "  IF p_verdict = 'verified' THEN\n" + gen.PRE_GUARD + '  END IF;\n')
        .replace(gen.FINAL_GUARD, "    IF p_verdict = 'verified' THEN\n" + gen.FINAL_GUARD + '    END IF;\n'));
    }
    // first line of defense: the migration's rollback-contained smoke
    const d0 = await baselineDb();
    const refused = await tryExec(d0, mutant);
    assert.ok(!refused.ok && /elapsed create was not refused/.test(refused.error), 'the artifact smoke refuses the nested mutant: ' + (refused.error || 'committed?!'));
    // second line of defense: the executed matrix rows of THIS suite
    const d = await baselineDb(withoutSmoke(mutant));
    const who = await seedCustomer(d, 'PRT-M-NEST');
    const esc = await rpcCreate(d, who, uuid(), pastMs(), { kind: 'no_token' });
    assert.strictEqual(esc.outcome, 'created', 'the nested PRE guard lets a no_token elapsed create through — the matrix row asserting pickup_time_elapsed catches it');
    const who2 = await seedCustomer(d, 'PRT-M-NEST-2');
    const b = await rpcCreate(d, who2, uuid(), futureMs(), { kind: 'no_token' });
    assert.strictEqual(b.outcome, 'created');
    const x = await crossing(d, who2, 'edit', 'no_token', { bookingId: b.booking_id, version: 1 });
    assert.strictEqual(x.outcome, 'updated', 'the nested FINAL guard lets a no_token crossing commit — the non-token observe crossing row catches it');
  });

  await check('MUTANTS (executed): the edit guard judging the STORED old value refuses the rescue; the create guard moved BEFORE receipt recovery refuses an honest retry; a handler that inserts a verdict row trips the closed CHECK', async () => {
    let mutant = withBody(m019, 'accept_quote_edit', (b) => b.replace(PRE_GUARD_LINE,
      'IF NOT public.linkmia_pickup_is_future(v_pickup_at, transaction_timestamp()) OR NOT public.linkmia_pickup_is_future(v_row.pickup_datetime, transaction_timestamp()) THEN'));
    mutant = withBody(mutant, 'accept_quote_create', (b) => {
      const anchor = "  v_pickup_at := (p_booking->>'pickup_datetime')::TIMESTAMPTZ;\n";
      assert.strictEqual(b.split(anchor).length - 1, 1);
      return b.replace(gen.PRE_GUARD, '').replace(anchor, anchor + gen.PRE_GUARD)
        .replace("    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);\n    RETURN jsonb_build_object('outcome', 'pickup_time_elapsed');",
          "    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash) VALUES ('pickup_time_elapsed', v_mode, 'create', v_idhash);\n    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);\n    RETURN jsonb_build_object('outcome', 'pickup_time_elapsed');");
    });
    const d = await baselineDb(mutant);
    const who = await seedCustomer(d, 'PRT-M-STORED');
    const b = await rpcCreate(d, who, uuid(), futureMs(), { kind: 'no_token' });
    await d.query(`UPDATE bookings SET pickup_datetime = now() - interval '1 minute' WHERE id = $1`, [b.booking_id]);
    const rescue = await rpcEdit(d, who, uuid(), b.booking_id, 1, {}, { pickupMs: futureMs() });
    assert.strictEqual(rescue.outcome, 'pickup_time_elapsed', 'the stored-value mutant refuses the rescue — the rescue row catches it');
    // guard before receipt recovery: the exact retry after the pickup elapsed is refused instead of replayed
    const who2 = await seedCustomer(d, 'PRT-M-MOVED');
    const opId = uuid(); const pickup = Date.now() + 600;
    const first = await rpcCreate(d, who2, opId, pickup, { trip: 'PRT-M-RP' });
    assert.strictEqual(first.outcome, 'created', JSON.stringify(first));
    await sleep(700);
    const retry = await rpcCreate(d, who2, opId, pickup, { trip: 'PRT-M-RP' });
    assert.strictEqual(retry.outcome, 'pickup_time_elapsed', 'the moved guard refuses an honest retry — the receipt-first row catches it');
    // handler inserting a verdict row: the closed CHECK refuses at runtime
    const who3 = await seedCustomer(d, 'PRT-M-HANDLER');
    let threw = null;
    try { await crossing(d, who3, 'create', 'no_token'); } catch (e) { threw = e.message; }
    assert.ok(threw && /quote_verifications_verdict_check/.test(threw), 'the closed verdict CHECK rejects pickup_time_elapsed as a verdict: ' + threw);
  });

  await check('MUTANTS (executed): a final guard that RETURNS after DML leaves the elapsed booking COMMITTED (counts catch it); a neutralized final guard lets the crossing commit (outcome catches it)', async () => {
    let mutant = withBody(m019, 'accept_quote_create', (b) => b.replace(FINAL_RAISE,
      "RETURN jsonb_build_object('outcome', 'pickup_time_elapsed');\n      " + FINAL_RAISE.replace('pickup_time_elapsed', 'unreachable')));
    mutant = withBody(mutant, 'accept_quote_edit', (b) => b.replace(
      'IF NOT public.linkmia_pickup_is_future(v_pickup_at, clock_timestamp()) THEN',
      'IF FALSE AND NOT public.linkmia_pickup_is_future(v_pickup_at, clock_timestamp()) THEN'));
    const d = await baselineDb(mutant);
    const who = await seedCustomer(d, 'PRT-M-RETURN');
    const before = await counts(d);
    const r = await crossing(d, who, 'create', 'no_token');
    assert.strictEqual(r.outcome, 'pickup_time_elapsed', 'the mutant still SAYS elapsed');
    const after = await counts(d);
    assert.strictEqual(after.b, before.b + 1, 'but the booking persisted — the zero-residue assertion catches it');
    assert.strictEqual(r.rpc_writer_after, 'on', 'and the handler never ran: rpc_writer is still on inside the transaction — the real (pre-COMMIT) read catches it');
    await d.exec(`SELECT set_config('linkmia.rpc_writer', 'off', FALSE)`);
    const who2 = await seedCustomer(d, 'PRT-M-NEUTRAL');
    const b = await rpcCreate(d, who2, uuid(), futureMs());
    assert.strictEqual(b.outcome, 'created', JSON.stringify(b));
    const x = await crossing(d, who2, 'edit', 'no_token', { bookingId: b.booking_id, version: 1 });
    assert.strictEqual(x.outcome, 'updated', 'the neutralized final guard commits the crossing — the crossing row catches it');
  });

  // ================================================================ rollback: phase-safe on three baselines + exact ACL
  const HELPER = 'public.linkmia_pickup_is_future(timestamptz,timestamptz)';
  await check('ROLLBACK on a post-019 DB (helper present) with a ROGUE grantee and PUBLIC re-granted: applies, canonicalizes the helper ACL to exactly the writer owners, writers still refuse an elapsed pickup, 017 duration semantics return', async () => {
    await db.exec(`CREATE ROLE prt_rogue NOLOGIN; GRANT EXECUTE ON FUNCTION ${HELPER} TO prt_rogue; GRANT EXECUTE ON FUNCTION ${HELPER} TO PUBLIC;`);
    assert.strictEqual((await one(db, `SELECT has_function_privilege('prt_rogue', '${HELPER}', 'EXECUTE') AS x`)).x, true, 'precondition: rogue holds EXECUTE');
    const r = await tryExec(db, rollback); assert.ok(r.ok, r.error);
    const h = await helperAcl(db);
    assert.deepStrictEqual(h.grantees, h.writer_owners, 'rogue and PUBLIC revoked; exact set restored');
    assert.strictEqual((await one(db, `SELECT has_function_privilege('prt_rogue', '${HELPER}', 'EXECUTE') AS x`)).x, false);
    assert.strictEqual(h.anon_x, false);
    const who = await seedCustomer(db, 'PRT-RB-A');
    assert.strictEqual((await rpcCreate(db, who, uuid(), pastMs())).outcome, 'pickup_time_elapsed');
    assert.strictEqual((await rpcCreate(db, who, uuid(), futureMs())).outcome, 'created');
    const def = await one(db, `SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'accept_quote_create'`);
    assert.ok(def.d.includes('v_duration_minutes IS NULL'), '017 semantics returned');
  });

  await check('019 IS STRICT: on a rollback-state database (or a post-019 one) migration 019 REFUSES — only the reviewed 018 bodies are accepted; the forward path after a rollback is 018 again, then 019', async () => {
    const fpNow = await installedFp(db);
    assert.deepStrictEqual(fpNow, gen.generate().fps.fp.rollback, 'precondition: rollback bodies installed');
    const r = await tryExec(db, m019);
    assert.ok(!r.ok && /is not a recognized reviewed pair/.test(r.error), '019 refuses rollback bodies: ' + (r.error || 'committed?!'));
    assert.deepStrictEqual(await installedFp(db), fpNow, 'nothing changed');
    const r2 = await tryExec(db, m018); assert.ok(r2.ok, '018 re-applies on the rollback state: ' + (r2.error || ''));
    assert.deepStrictEqual(await installedFp(db), gen.generate().fps.fp.reviewed018);
  });

  await check('HOSTILE-ACL PROBE: a transform WITHOUT the canonicalization loop FAILS its own exact-set verification when a rogue grantee exists (the artifact refuses to commit) — then the real 019 applies (forward again) and canonicalizes', async () => {
    await db.exec(`GRANT EXECUTE ON FUNCTION ${HELPER} TO prt_rogue`);
    const start = m019.indexOf('  -- CANONICALIZE: revoke every EXECUTE grantee outside the allowed set');
    const end = m019.indexOf('END;\n$prt_helper_acl$;');
    assert.ok(start > 0 && end > start, 'canonicalization block located');
    const lastLoopEnd = m019.lastIndexOf('  END LOOP;\n', end) + '  END LOOP;\n'.length;
    const noCanon = m019.slice(0, start) + m019.slice(lastLoopEnd);
    assert.ok(!noCanon.includes('CANONICALIZE') && noCanon.includes('helper EXECUTE grantees'), 'loop removed, verification kept');
    const r = await tryExec(db, noCanon);
    assert.ok(!r.ok && /not exactly the captured writer owners/.test(r.error), 'the exact-set verification refuses: ' + (r.error || 'committed?!'));
    assert.strictEqual((await one(db, `SELECT has_function_privilege('prt_rogue', '${HELPER}', 'EXECUTE') AS x`)).x, true, 'the failed transaction changed nothing');
    const ok = await tryExec(db, m019); assert.ok(ok.ok, ok.error);
    const h = await helperAcl(db);
    assert.deepStrictEqual(h.grantees, h.writer_owners, '019 (forward again) canonicalized the rogue away');
    assert.strictEqual((await one(db, `SELECT has_function_privilege('prt_rogue', '${HELPER}', 'EXECUTE') AS x`)).x, false);
    assert.deepStrictEqual(await installedFp(db), gen.generate().fps.fp.target019);
    // and a post-019 database is not a valid 019 pre-state either (run ONCE)
    const again = await tryExec(db, m019);
    assert.ok(!again.ok && /is not a recognized reviewed pair/.test(again.error), '019 refuses to re-run on its own bodies');
  });

  const db2 = await freshDb();
  await check('ROLLBACK on the 018 baseline with the helper ABSENT: self-contained — creates the helper with the exact ACL, restores guard-carrying writers, they RUN', async () => {
    let r = await tryExec(db2, m018); assert.ok(r.ok, r.error);
    assert.strictEqual((await one(db2, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'linkmia_pickup_is_future'`)).n, 0, 'precondition: no helper before the rollback');
    r = await tryExec(db2, rollback); assert.ok(r.ok, r.error);
    const h = await helperAcl(db2);
    assert.deepStrictEqual(h.grantees, h.writer_owners);
    const who = await seedCustomer(db2, 'PRT-RB-B');
    assert.strictEqual((await rpcCreate(db2, who, uuid(), pastMs())).outcome, 'pickup_time_elapsed');
    assert.strictEqual((await rpcCreate(db2, who, uuid(), futureMs(), { trip: 'PRT-RB-B2' })).outcome, 'created');
  });

  await check('ROLLBACK re-applies in the same session (helper present) — still the exact ACL', async () => {
    const r = await tryExec(db2, rollback); assert.ok(r.ok, r.error);
    const h = await helperAcl(db2);
    assert.deepStrictEqual(h.grantees, h.writer_owners);
  });

  await check('ROLLBACK MUTANT (helper-less): CREATE succeeds, then the writers FAIL AT RUNTIME — the latent-outage class the self-contained artifact prevents', async () => {
    const db3 = await freshDb();
    let r = await tryExec(db3, m018); assert.ok(r.ok, r.error);
    const helperStart = rollback.indexOf('-- The comparator, as ONE named IMMUTABLE STRICT SQL function');
    const aclEnd = rollback.indexOf('$r1_rb_helper_acl$;') + '$r1_rb_helper_acl$;'.length;
    assert.ok(helperStart > 0 && aclEnd > helperStart);
    let mutant = rollback.slice(0, helperStart) + rollback.slice(aclEnd);
    const vStart = mutant.indexOf('  -- Helper: exactly one signature');
    const vEnd = mutant.indexOf('helper boundary is wrong');
    assert.ok(vStart > 0 && vEnd > vStart, 'helper verification block located');
    const vEndLine = mutant.indexOf('\n', mutant.indexOf('END IF;', vEnd)) + 1;
    mutant = mutant.slice(0, vStart) + mutant.slice(vEndLine);
    assert.ok(!mutant.includes('linkmia_pickup_is_future(p_pickup'), 'helper creation removed');
    assert.ok(!mutant.includes('helper boundary is wrong') && !mutant.includes('helper EXECUTE grantees'), 'helper verification removed');
    r = await tryExec(db3, mutant);
    assert.ok(r.ok, 'the mutant COMMITS — CREATE OR REPLACE does not resolve PL/pgSQL references: ' + (r.error || ''));
    const who = await seedCustomer(db3, 'PRT-MUTANT');
    let threw = null;
    try { await rpcCreate(db3, who, uuid(), futureMs()); } catch (e) { threw = e.message; }
    assert.ok(threw && /does not exist/.test(threw), 'every booking then fails at runtime: ' + threw);
    await db3.exec('RESET ROLE').catch(() => {});
  });

  await check('ROLLBACK refuses over client-role privilege drift (retained precheck)', async () => {
    await db2.exec(`GRANT EXECUTE ON FUNCTION accept_quote_create(uuid,uuid,uuid,text,text,uuid,text,jsonb,numeric,text,text,text,jsonb) TO anon`);
    const r = await tryExec(db2, rollback);
    assert.ok(!r.ok && /client role holds EXECUTE/.test(r.error), r.error);
    await db2.exec(`REVOKE EXECUTE ON FUNCTION accept_quote_create(uuid,uuid,uuid,text,text,uuid,text,jsonb,numeric,text,text,text,jsonb) FROM anon`);
  });

  // ================================================================ telemetry contract
  await check('verdict CHECK untouched: pickup_time_elapsed is NOT a verdict and no verdict row is written for it (off and observe, every kind)', async () => {
    assert.ok(!m019.includes("'pickup_time_elapsed',\n"), 'no CHECK widening in 019');
    assert.ok(!/ALTER TABLE quote_verifications/.test(m019));
    for (const d of [db, dbObs]) {
      for (const kind of KINDS) {
        const who = await seedCustomer(d, 'PRT-TELEMETRY-' + kind);
        const before = await counts(d);
        await rpcCreate(d, who, uuid(), pastMs(), { kind });
        assert.strictEqual((await counts(d)).v, before.v, `${kind}: no quote_verifications row for an elapsed refusal`);
      }
    }
  });

  // ================================================================ pinned, not moved: the operationId-less edit lane
  await check('PINNED, NOT MOVED: the edit writer\'s inherited 017 no_request_id instrument (operationId-less caller, off/observe) sits BEFORE the pre-guard, outside the subtransaction — an elapsed refusal or a final-guard crossing leaves exactly that one telemetry row; the create counterpart sits inside the block and leaves nothing', async () => {
    for (const [label, artifact] of [['019', m019], ['rollback', rollback]]) {
      const edit = gen.extract(artifact, 'accept_quote_edit');
      const ins = edit.indexOf("VALUES ('no_request_id', v_mode, 'edit', p_booking_id, v_idhash)");
      const pre = edit.indexOf(PRE_GUARD_LINE);
      const on = edit.indexOf("PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);");
      assert.ok(ins > 0 && ins < pre && pre < on, `${label}/edit: telemetry insert (${ins}) precedes the pre-guard (${pre}) and rpc_writer on (${on}) — a move is a deliberate change`);
      const create = gen.extract(artifact, 'accept_quote_create');
      const cins = create.indexOf("VALUES ('no_request_id', v_mode, 'create', v_booking_id, v_idhash)");
      const cpre = create.indexOf(PRE_GUARD_LINE);
      const con = create.indexOf("PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);");
      const cbegin = create.indexOf('\n  BEGIN\n', con);
      assert.ok(cpre > 0 && cpre < con && con < cbegin && cbegin < cins,
        `${label}/create: pre-guard (${cpre}) < rpc_writer on (${con}) < BEGIN (${cbegin}) < the counterpart insert (${cins}) — INSIDE the subtransaction, so a crossing rolls it back`);
    }
    for (const [d, label] of [[db, 'off'], [dbObs, 'observe']]) {
      const who = await seedCustomer(d, 'PRT-NOOPID-' + label);
      const b = await rpcCreate(d, who, uuid(), futureMs());
      assert.strictEqual(b.outcome, 'created');
      let before = await counts(d);
      const e = await rpcEdit(d, who, null, b.booking_id, 1, {}, { pickupMs: pastMs(), noOpId: true });
      assert.strictEqual(e.outcome, 'pickup_time_elapsed', JSON.stringify(e));
      let after = await counts(d);
      assert.deepStrictEqual([after.b - before.b, after.a - before.a, after.r - before.r, after.v - before.v], [0, 0, 0, 1], `${label}: exactly one telemetry row, no booking/acceptance/receipt`);
      const row = await one(d, `SELECT verdict, purpose, booking_id FROM quote_verifications ORDER BY id DESC LIMIT 1`);
      assert.deepStrictEqual([row.verdict, row.purpose, row.booking_id], ['no_request_id', 'edit', b.booking_id]);
      assert.strictEqual((await one(d, `SELECT details_version FROM bookings WHERE id = $1`, [b.booking_id])).details_version, 1, 'row untouched');
      before = await counts(d);
      const x = await crossing(d, who, 'edit', 'no_token', { bookingId: b.booking_id, version: 1, noOpId: true });
      assert.strictEqual(x.outcome, 'pickup_time_elapsed', JSON.stringify(x));
      after = await counts(d);
      assert.deepStrictEqual([after.b - before.b, after.a - before.a, after.r - before.r, after.v - before.v], [0, 0, 0, 1], `${label}: the crossing rolls back the block and leaves only the pre-block row`);
      const who2 = await seedCustomer(d, 'PRT-NOOPID-CREATE-' + label);
      before = await counts(d);
      const c = await rpcCreate(d, who2, null, pastMs(), { noOpId: true });
      assert.strictEqual(c.outcome, 'pickup_time_elapsed', JSON.stringify(c));
      assert.deepStrictEqual(await counts(d), before, `${label}: the create counterpart writes nothing`);
      // and through the FINAL guard: the operationId-less create reaches the
      // block, its insert runs, and the ZQ019 rollback takes it back with
      // everything else — ZERO residue (this is what the position pin protects)
      before = await counts(d);
      const cx = await crossing(d, who2, 'create', 'no_token', { noOpId: true });
      assert.strictEqual(cx.outcome, 'pickup_time_elapsed', JSON.stringify(cx));
      assert.deepStrictEqual(await counts(d), before, `${label}: an operationId-less CREATE crossing leaves zero residue`);
    }
  });

  await check('MUTANT (executed): the create writer\'s no_request_id insert moved OUTSIDE the subtransaction (after the pre-guard, before rpc_writer on) still installs — the position pin AND the operationId-less create crossing catch it', async () => {
    const block = "    IF NOT v_has_request_id THEN\n      INSERT INTO quote_verifications (\n        verdict, mode, purpose, booking_id, identity_hash\n      ) VALUES ('no_request_id', v_mode, 'create', v_booking_id, v_idhash);\n    END IF;\n";
    const on = "  PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);\n";
    const mutant = withBody(m019, 'accept_quote_create', (b) => {
      assert.strictEqual(b.split(block).length - 1, 1, 'create counterpart block located');
      return b.replace(block, '').replace(on, block.replace(/^    /gm, '  ') + on);
    });
    const create = gen.extract(mutant, 'accept_quote_create');
    const cins = create.indexOf("VALUES ('no_request_id', v_mode, 'create', v_booking_id, v_idhash)");
    const con = create.indexOf("PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);");
    assert.ok(cins > 0 && cins < con, 'static: the mutant puts the insert before rpc_writer on — the position pin refuses it');
    const d = await baselineDb(mutant);
    const who = await seedCustomer(d, 'PRT-M-MOVED-INSERT');
    const before = await counts(d);
    const x = await crossing(d, who, 'create', 'no_token', { noOpId: true });
    assert.strictEqual(x.outcome, 'pickup_time_elapsed', JSON.stringify(x));
    const after = await counts(d);
    assert.strictEqual(after.v - before.v, 1, 'executed: the moved insert survives the ZQ019 rollback — the zero-residue probe refuses it');
    assert.strictEqual(after.b - before.b, 0, 'the booking itself still rolled back');
  });

  // ================================================================ the operator preflight, executed
  await check('PREFLIGHT (executed on the 018 baseline): A1 two writers, A2 exact fingerprints is_reviewed_018=true/is_target_019=false/guarded=false, A3 helper absent, B1 off/observe with NULL high-water, B2 exactly ONE named CHECK with 16 literals and widened=false, C1/C2 shaped', async () => {
    const d = await baselineDb();
    const g = await runPreflight(d);
    assert.deepStrictEqual(Object.keys(g).sort(), ['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2'], 'seven labeled units parsed');
    assert.strictEqual(preflightUnits(mig('019_prt_preflight.sql')).total, 7, 'and the file holds exactly seven units');
    // MUTATION (parser): an extra unit without a label, or with a label outside
    // the expected alphabet, is REPORTED — not silently dropped.
    const extra = mig('019_prt_preflight.sql') + '\nBEGIN;\nSET TRANSACTION READ ONLY;\nSELECT 1 AS orphan;\nROLLBACK;\n';
    assert.deepStrictEqual(preflightUnits(extra).unlabeled.length, 1, 'an unlabeled unit is reported');
    const zed = mig('019_prt_preflight.sql') + '\nBEGIN;\nSET TRANSACTION READ ONLY;\n-- Z9. new unit\nSELECT 1 AS z;\nROLLBACK;\n';
    assert.ok(preflightUnits(zed).units.Z9, 'a unit labeled outside A-C is still parsed (the seven-key assertion above then fails loudly)');
    assert.strictEqual(g.A1.length, 2);
    for (const r of g.A1) { assert.strictEqual(r.prosecdef, true); assert.strictEqual(r.sr_exec, true); assert.strictEqual(r.anon_exec, false); assert.strictEqual(r.auth_exec, false); assert.ok(String(r.proconfig).includes('search_path')); }
    assert.deepStrictEqual(g.A2.map((r) => [r.proname, r.is_reviewed_018, r.is_target_019, r.guarded]), [['accept_quote_create', true, false, false], ['accept_quote_edit', true, false, false]], 'A2 is exact: reviewed 018 fingerprints, no guard');
    const fp = gen.generate().fps.fp;
    assert.deepStrictEqual(g.A2.map((r) => r.body_sha256), [fp.reviewed018.create, fp.reviewed018.edit], 'A2 prints the exact fingerprints the migration requires');
    assert.strictEqual(Number(g.A3[0].helper_signatures), 0);
    assert.strictEqual(g.B1[0].mode, 'off'); assert.strictEqual(g.B1[0].enforcement_started_at, null);
    assert.strictEqual(g.B2.length, 1, 'B2 yields exactly one row');
    assert.strictEqual(g.B2[0].conname, 'quote_verifications_verdict_check');
    assert.strictEqual(Number(g.B2[0].verdict_literals), 16); assert.strictEqual(g.B2[0].widened, false);
    assert.ok('nonterminal_bookings' in g.C1[0] && 'writer_calls_in_flight' in g.C1[0]);
    assert.deepStrictEqual(Object.keys(g.C2[0]).sort(), ['bookings', 'customers', 'operation_receipts', 'quote_acceptances', 'quote_verifications']);
    await setMode(d, 'observe');
    const g2 = await runPreflight(d);
    assert.strictEqual(g2.B1[0].mode, 'observe'); assert.strictEqual(g2.B1[0].enforcement_started_at, null);
    // after 019: A2 guarded=true, is_reviewed_018=false, is_target_019=true; A3 = 1; B2 unchanged
    const r = await tryExec(d, m019); assert.ok(r.ok, r.error);
    const g3 = await runPreflight(d);
    assert.deepStrictEqual(g3.A2.map((x) => [x.proname, x.is_reviewed_018, x.is_target_019, x.guarded]), [['accept_quote_create', false, true, true], ['accept_quote_edit', false, true, true]]);
    assert.deepStrictEqual(g3.A2.map((x) => x.body_sha256), [fp.target019.create, fp.target019.edit]);
    assert.strictEqual(Number(g3.A3[0].helper_signatures), 1);
    assert.strictEqual(Number(g3.B2[0].verdict_literals), 16); assert.strictEqual(g3.B2[0].widened, false);
  });

  results.forEach((x) => console.log(x));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
