// Migration 021 — flight observations, EXECUTED on real PostgreSQL (PGlite/WASM).
//
// Proves on the actual SQL, not by reading it:
//   * the chain applies and 021's self-verification passes
//   * the band can never disagree with the times (CHECKs refuse it)
//   * append-only by privilege: service_role may INSERT/SELECT, never
//     UPDATE/DELETE; client roles get nothing
//   * the outbox trigger: one driver event per news band per booking, none
//     for on_time/landed, none without a committed driver, none for a ride
//     that is not happening — written as service_role, the production path
//   * the self-verification block BITES (negative runs after tampering)
//
// Run: node tests/flight-observations-migration.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const MIGRATION = '021_flight_observations.sql';
const sql021 = fs.readFileSync(path.join(repoRoot, 'database/migrations', MIGRATION), 'utf8');

let checks = 0;
const results = [];
async function check(name, f) {
  try { await f(); checks++; results.push(`  ✓ ${name}`); }
  catch (err) {
    results.push(`  ✗ ${name}\n      ${String(err.message).slice(0, 400)}`);
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
  await db.exec(fs.readFileSync(path.join(repoRoot, 'database/linkmia-schema.sql'), 'utf8'));
  // Same chain the R1 suite applies (018/019 are installed by their own
  // suites through their fingerprint gates; 021 touches neither).
  const files = fs.readdirSync(path.join(repoRoot, 'database/migrations'))
    .filter((f) => /^0\d\d_/.test(f) && !/preflight|^018_|^019_/.test(f)).sort();
  assert.ok(files.includes(MIGRATION), '021 is part of the applied chain');
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(repoRoot, 'database/migrations', f), 'utf8'));
  }
  return db;
}

const rows = async (db, q, p) => (await db.query(q, p)).rows;
const one = async (db, q, p) => (await rows(db, q, p))[0];
async function fails(db, q, p) {
  try { await db.query(q, p); return null; }
  catch (e) { return e.message; }
}
async function asRole(db, role, fn) {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
}

(async () => {
  console.log('\nMigration 021 — flight observations (PGlite)\n');
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = await freshDb(PGlite, pgcrypto);

  const driver = (await one(db,
    `INSERT INTO drivers (name, phone) VALUES ('Smoke Driver', '+10000000000') RETURNING id`)).id;
  const pickup = new Date(Date.now() + 4 * 3600e3);
  async function booking(over = {}) {
    const b = { status: 'confirmed', assigned_driver: driver, ...over };
    return (await one(db, `
      INSERT INTO bookings (customer_name, pickup_location, dropoff_location, pickup_datetime,
                            status, assigned_driver, flight_number, airport_code, booking_mode)
      VALUES ('Smoke', 'MIA', 'Brickell', $1, $2, $3, 'AA100', 'MIA', 'pickup') RETURNING id`,
      [pickup.toISOString(), b.status, b.assigned_driver])).id;
  }

  let seq = 0;
  // One observation, written as service_role exactly as the endpoint does.
  async function observe(bookingId, over = {}) {
    const sched = new Date(pickup.getTime() - 15 * 60e3);
    const o = {
      band: 'delay_60', delay_minutes: 75,
      estimated_arrival: new Date(sched.getTime() + 75 * 60e3).toISOString(),
      actual_arrival: null,
      observed_at: new Date(Date.now() - 60e3 + (++seq) * 1000).toISOString(),
      ...over
    };
    return asRole(db, 'service_role', () => db.query(`
      INSERT INTO flight_observations (booking_id, flight_number, pickup_date, airport_code, band,
        delay_minutes, scheduled_arrival, estimated_arrival, actual_arrival, observed_at, source)
      VALUES ($1, 'AA100', $2, 'MIA', $3, $4, $5, $6, $7, $8, 'test')`,
      [bookingId, pickup.toISOString().slice(0, 10), o.band, o.delay_minutes,
        sched.toISOString(), o.estimated_arrival, o.actual_arrival, o.observed_at]));
  }
  const eventsFor = (bookingId) => rows(db,
    `SELECT event_type, recipient_role, recipient_key, state, due_at, not_after
       FROM notification_events WHERE booking_id = $1 ORDER BY event_type`, [bookingId]);

  // ------------------------------------------------------------- shape
  await check('the chain applies and 021 self-verifies (table, RLS, trigger)', async () => {
    const t = await one(db, `SELECT relrowsecurity FROM pg_class WHERE relname = 'flight_observations'`);
    assert.strictEqual(t.relrowsecurity, true);
    const trig = await one(db, `SELECT count(*)::int AS n FROM pg_trigger
                                 WHERE tgname = 'trg_flight_observations_outbox'`);
    assert.strictEqual(trig.n, 1);
  });

  await check('bookings is NOT altered: no flight status column was added to it', async () => {
    const cols = (await rows(db, `SELECT column_name FROM information_schema.columns
                                  WHERE table_name = 'bookings'`)).map((r) => r.column_name);
    for (const c of ['band', 'estimated_arrival', 'delay_minutes', 'flight_status']) {
      assert.ok(!cols.includes(c), `bookings must not gain ${c}`);
    }
  });

  // ------------------------------------------- band can't disagree with time
  await check('a band that disagrees with its delay is refused by the database', async () => {
    const b = await booking();
    for (const [over, why] of [
      [{ band: 'delay_60', delay_minutes: 20 }, '20 min labelled delay_60'],
      [{ band: 'delay_30', delay_minutes: 75 }, '75 min labelled delay_30'],
      [{ band: 'on_time', delay_minutes: 45 }, '45 min labelled on_time'],
      [{ band: 'delay_120', delay_minutes: 119 }, '119 min labelled delay_120'],
      [{ band: 'cancelled', delay_minutes: 10, estimated_arrival: null }, 'cancelled with a delay'],
      [{ band: 'delay_60', estimated_arrival: null }, 'a delay band without an estimate'],
      [{ band: 'landed', delay_minutes: 5, actual_arrival: null }, 'landed without an actual time'],
      [{ band: 'late', delay_minutes: 75 }, 'an unknown band']
    ]) {
      let err = null;
      try { await observe(b, over); } catch (e) { err = e.message; }
      assert.ok(err, `must refuse: ${why}`);
    }
    assert.deepStrictEqual(await eventsFor(b), [], 'refused rows produce no events');
  });

  await check('the same reading twice is one row (sensor retries are idempotent)', async () => {
    const b = await booking();
    const at = new Date().toISOString();
    await observe(b, { observed_at: at });
    let err = null;
    try { await observe(b, { observed_at: at }); } catch (e) { err = e.message; }
    assert.ok(err && /flight_observations_reading|duplicate key/.test(err), err);
  });

  // ---------------------------------------------------------- privileges
  await check('append-only by privilege: service_role cannot UPDATE or DELETE history', async () => {
    const b = await booking();
    await observe(b);
    const upd = await asRole(db, 'service_role',
      () => fails(db, `UPDATE flight_observations SET source = 'x' WHERE booking_id = $1`, [b]));
    const del = await asRole(db, 'service_role',
      () => fails(db, `DELETE FROM flight_observations WHERE booking_id = $1`, [b]));
    assert.ok(upd && /permission denied/.test(upd), `update must be denied: ${upd}`);
    assert.ok(del && /permission denied/.test(del), `delete must be denied: ${del}`);
  });

  await check('client roles see nothing (lockdown intact)', async () => {
    for (const role of ['anon', 'authenticated']) {
      const err = await asRole(db, role, () => fails(db, `SELECT * FROM flight_observations`));
      assert.ok(err && /permission denied/.test(err), `${role}: ${err}`);
    }
  });

  // ------------------------------------------------------------- outbox
  await check('a news band on a live ride writes ONE driver event, due now, in the same statement', async () => {
    const b = await booking();
    await observe(b, { band: 'delay_60', delay_minutes: 75 });
    const ev = await eventsFor(b);
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].event_type, 'flight_delay_60');
    assert.strictEqual(ev[0].recipient_role, 'driver');
    assert.strictEqual(ev[0].recipient_key, driver);
    assert.strictEqual(ev[0].state, 'pending');
    assert.ok(Math.abs(new Date(ev[0].due_at).getTime() - Date.now()) < 60e3, 'due now');
  });

  await check('not_after = three hours past the later of booked pickup and expected landing', async () => {
    const b = await booking();
    const sched = new Date(pickup.getTime() - 15 * 60e3);
    const lateEst = new Date(sched.getTime() + 150 * 60e3);   // lands well after the booked pickup
    await observe(b, { band: 'delay_120', delay_minutes: 150, estimated_arrival: lateEst.toISOString() });
    const ev = (await eventsFor(b))[0];
    assert.strictEqual(new Date(ev.not_after).getTime(), lateEst.getTime() + 3 * 3600e3);
  });

  await check('each band notifies once per booking; a worse band is new news', async () => {
    const b = await booking();
    await observe(b, { band: 'delay_60', delay_minutes: 70 });
    await observe(b, { band: 'delay_60', delay_minutes: 80 });   // same band again: silence
    await observe(b, { band: 'delay_120', delay_minutes: 130 });
    await observe(b, { band: 'cancelled', delay_minutes: null, estimated_arrival: null });
    const types = (await eventsFor(b)).map((e) => e.event_type);
    assert.deepStrictEqual(types, ['flight_cancelled', 'flight_delay_120', 'flight_delay_60']);
    const n = await one(db, `SELECT count(*)::int AS n FROM flight_observations WHERE booking_id = $1`, [b]);
    assert.strictEqual(n.n, 4, 'every reading is still recorded');
  });

  await check('on_time and landed are recorded but announce nothing', async () => {
    const b = await booking();
    await observe(b, { band: 'on_time', delay_minutes: 5 });
    await observe(b, { band: 'landed', delay_minutes: 8,
      actual_arrival: new Date(pickup.getTime() - 7 * 60e3).toISOString() });
    assert.deepStrictEqual(await eventsFor(b), []);
  });

  await check('no committed driver, or a ride not happening: recorded, no event', async () => {
    for (const over of [
      { status: 'pending', assigned_driver: null },
      { status: 'completed' },
      { status: 'cancelled' },
      { status: 'in_progress' }
    ]) {
      const b = await booking(over);
      await observe(b, { band: 'delay_120', delay_minutes: 140 });
      assert.deepStrictEqual(await eventsFor(b), [], JSON.stringify(over));
    }
  });

  await check('on_the_way and arrived rides still get the alert', async () => {
    for (const status of ['on_the_way', 'arrived']) {
      const b = await booking({ status });
      await observe(b, { band: 'diverted', delay_minutes: null, estimated_arrival: null });
      assert.deepStrictEqual((await eventsFor(b)).map((e) => e.event_type), ['flight_diverted']);
    }
  });

  await check('the booked pickup is never touched (tell only, D3)', async () => {
    const b = await booking();
    const before = await one(db, `SELECT pickup_datetime, details_version FROM bookings WHERE id = $1`, [b]);
    await observe(b, { band: 'delay_120', delay_minutes: 200,
      estimated_arrival: new Date(pickup.getTime() + 185 * 60e3).toISOString() });
    const after = await one(db, `SELECT pickup_datetime, details_version FROM bookings WHERE id = $1`, [b]);
    assert.deepStrictEqual(after, before);
  });

  // ------------------------------------------- the self-check actually bites
  const verifyBlock = sql021.slice(sql021.indexOf('DO $$'), sql021.indexOf('NOTIFY pgrst'));
  await check('the self-verification passes on the honest install', async () => {
    assert.ok(verifyBlock.includes('MIGRATION 021 VERIFIED'));
    await db.exec(verifyBlock);
  });

  for (const [tamper, undo, why] of [
    ['GRANT UPDATE ON flight_observations TO service_role',
     'REVOKE UPDATE ON flight_observations FROM service_role', 'append-only broken'],
    ['GRANT SELECT ON flight_observations TO anon',
     'REVOKE SELECT ON flight_observations FROM anon', 'client grant leaked'],
    ['GRANT SELECT ON flight_observations TO PUBLIC',
     'REVOKE SELECT ON flight_observations FROM PUBLIC', 'PUBLIC grant leaked'],
    ['REVOKE INSERT ON flight_observations FROM service_role',
     'GRANT INSERT ON flight_observations TO service_role', 'backend cannot write'],
    ['ALTER TABLE flight_observations DISABLE TRIGGER trg_flight_observations_outbox',
     'ALTER TABLE flight_observations ENABLE TRIGGER trg_flight_observations_outbox', 'trigger disabled'],
    [`CREATE POLICY leak ON flight_observations FOR SELECT USING (true)`,
     'DROP POLICY leak ON flight_observations', 'a policy appeared']
  ]) {
    await check(`self-verification refuses: ${why}`, async () => {
      await db.exec(tamper);
      let err = null;
      try { await db.exec(verifyBlock); } catch (e) { err = e.message; }
      await db.exec(undo);
      assert.ok(err && /ASSERTION FAILED/.test(err), `should have raised: ${err}`);
    });
  }

  await check('static: one transaction, schema reload, no UPDATE/DELETE grant, rollback documented', async () => {
    assert.ok(/^BEGIN;$/m.test(sql021) && /^COMMIT;$/m.test(sql021));
    assert.ok(sql021.indexOf("NOTIFY pgrst, 'reload schema';") < sql021.indexOf('\nCOMMIT;'));
    const grants = sql021.split('\n').filter((l) => /^GRANT /.test(l));
    assert.deepStrictEqual(grants, ['GRANT SELECT, INSERT ON TABLE flight_observations TO service_role;']);
    assert.ok(/-- UPDATE notification_events[\s\S]*feature_withdrawn/.test(sql021),
      'the rollback retires pending flight events before dropping the table');
    assert.ok(!/pickup_datetime\s*=/.test(sql021), 'never assigns pickup_datetime');
    assert.ok(!/[^\x00-\x7F]/.test(sql021), 'the whole file is ASCII (safe to paste into the SQL editor)');
  });

  results.forEach((l) => console.log(l));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})().catch((e) => { console.error(e); process.exit(1); });
