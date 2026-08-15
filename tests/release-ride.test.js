// PR 3C-1 — Release ride: endpoint authorization/validation, RPC-only
// release (success never client-declared), fail-closed conflict lookups,
// scoped immediate dispatch with the watchdog break discipline, plus
// static shape checks on driver.html, netlify.toml, and migration 016.
//
// Run: node tests/release-ride.test.js
//
// Pattern: mock @supabase/supabase-js via require.cache, run the real
// handler, assert payloads/filters (tests/driver-identity.test.js
// precedent). This is the repo's FIRST .rpc() call, so the mock
// implements rpc explicitly.

const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const BID = '123e4567-e89b-42d3-a456-426614174000';

const TOKENS = {
  'tok-active': { id: 'auth-a' },
  'tok-busy': { id: 'auth-b' },
  'tok-inactive': { id: 'auth-i' },
  'tok-nodrv': { id: 'auth-x' }
};
const DRIVERS_BY_USER = {
  'auth-a': { id: 'drv-a', name: 'Andres', status: 'active' },
  'auth-b': { id: 'drv-b', name: 'Busy Bee', status: 'busy' },
  'auth-i': { id: 'drv-i', name: 'Idle', status: 'inactive' }
};

// ---------- mock state ----------
const state = {};
function resetState() {
  state.rpcCalls = [];
  state.rpcResult = { released: true };
  state.rpcError = null;
  state.rereadRow = { status: 'confirmed' };
  state.rereadError = null;
  state.events = [];            // notification_events rows
  state.eventReads = [];        // captured filter sets per events read
  state.eventReadError = null;
  state.dispatchCalls = [];
  state.dispatchBehavior = null;
}
resetState();

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => TOKENS[token]
        ? { data: { user: TOKENS[token] }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } }
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
      if (table === 'bookings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => state.rereadError
                ? { data: null, error: state.rereadError }
                : { data: state.rereadRow, error: null }
            })
          })
        };
      }
      if (table === 'notification_events') {
        const q = { eqs: {}, ins: [] };
        const chain = {
          select: () => chain,
          eq: (col, val) => { q.eqs[col] = val; return chain; },
          in: (col, vals) => { q.ins.push([col, vals]); return chain; },
          then: (onOk, onErr) => {
            state.eventReads.push(q);
            if (state.eventReadError) {
              return Promise.resolve({ data: null, error: state.eventReadError }).then(onOk, onErr);
            }
            let rows = state.events.filter((e) =>
              Object.entries(q.eqs).every(([col, val]) => e[col] === val));
            for (const [col, vals] of q.ins) rows = rows.filter((e) => vals.includes(e[col]));
            return Promise.resolve({ data: rows, error: null }).then(onOk, onErr);
          }
        };
        return chain;
      }
      throw new Error('unexpected table: ' + table);
    },
    rpc: async (fn, args) => {
      state.rpcCalls.push({ fn, args });
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: state.rpcResult, error: null };
    }
  })
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const dispatchPath = require.resolve('../backend/functions/lib/dispatch.js');
require.cache[dispatchPath] = {
  id: dispatchPath, filename: dispatchPath, loaded: true,
  exports: {
    dispatchOne: async (db, ev, nowMs, opts) => {
      state.dispatchCalls.push({ ev, opts });
      if (state.dispatchBehavior) await state.dispatchBehavior(ev, opts);
    }
  }
};

const release = require(path.join(repoRoot, 'backend/functions/release-booking.js'));

const post = (body, token) => release.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body)
});

let passed = 0;
const failures = [];
async function check(name, fn) {
  resetState();
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}

(async () => {
  // ---------- method + authentication ----------
  await check('GET -> 405', async () => {
    const r = await release.handler({ httpMethod: 'GET', headers: {} });
    assert.strictEqual(r.statusCode, 405);
  });
  await check('no token -> 401; invalid token -> 401', async () => {
    let r = await post({ bookingId: BID, reason: 'emergency' });
    assert.strictEqual(r.statusCode, 401);
    r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-bogus');
    assert.strictEqual(r.statusCode, 401);
  });
  await check('no driver account -> 403; inactive driver -> 403', async () => {
    let r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-nodrv');
    assert.strictEqual(r.statusCode, 403);
    r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-inactive');
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(state.rpcCalls.length, 0, 'auth failures never reach the RPC');
  });

  // ---------- validation (all rejected BEFORE the RPC) ----------
  await check('invalid bookingId / unknown reason -> 400, zero RPC calls', async () => {
    let r = await post({ bookingId: 'not-a-uuid', reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 400);
    r = await post({ bookingId: BID, reason: 'felt_like_it' }, 'tok-active');
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(state.rpcCalls.length, 0);
  });
  await check('oversized note (post-trim) -> 400, zero RPC calls', async () => {
    const r = await post({ bookingId: BID, reason: 'vehicle_issue', note: 'x'.repeat(501) }, 'tok-active');
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(state.rpcCalls.length, 0);
  });
  await check('reason=other requires a non-blank note (blank AND whitespace rejected)', async () => {
    let r = await post({ bookingId: BID, reason: 'other' }, 'tok-active');
    assert.strictEqual(r.statusCode, 400);
    r = await post({ bookingId: BID, reason: 'other', note: '   ' }, 'tok-active');
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(state.rpcCalls.length, 0);
  });

  // ---------- the release itself ----------
  await check('happy path: RPC called with exact args, 200 success/pending', async () => {
    const r = await post({ bookingId: BID, reason: 'schedule_conflict' }, 'tok-active');
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.status, 'pending');
    assert.strictEqual(state.rpcCalls.length, 1);
    assert.deepStrictEqual(state.rpcCalls[0], {
      fn: 'release_booking',
      args: { p_booking_id: BID, p_driver_id: 'drv-a', p_reason: 'schedule_conflict', p_note: null }
    });
  });
  await check('note is TRIMMED before the RPC; whitespace-only becomes NULL', async () => {
    await post({ bookingId: BID, reason: 'emergency', note: '  flat tire  ' }, 'tok-active');
    assert.strictEqual(state.rpcCalls[0].args.p_note, 'flat tire');
    resetState();
    await post({ bookingId: BID, reason: 'emergency', note: '   ' }, 'tok-active');
    assert.strictEqual(state.rpcCalls[0].args.p_note, null,
      'blank-after-trim must reach the DB as NULL, never a whitespace string');
  });
  await check('BUSY driver may release (escaping a ride is the point)', async () => {
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-busy');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(state.rpcCalls[0].args.p_driver_id, 'drv-b');
  });
  await check('RPC database error -> 500, never success', async () => {
    state.rpcError = { message: 'db down' };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 500);
    assert.ok(!JSON.parse(r.body).success);
  });

  // ---------- conflict: fail-closed lookups ----------
  await check('released:false -> honest 409 with live currentStatus', async () => {
    state.rpcResult = { released: false };
    state.rereadRow = { status: 'on_the_way' };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).currentStatus, 'on_the_way');
  });
  await check('released:false + booking gone -> 404', async () => {
    state.rpcResult = { released: false };
    state.rereadRow = null;
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 404);
  });
  await check('released:false + re-read failure -> 500 (FAIL CLOSED, never a guessed 409)', async () => {
    state.rpcResult = { released: false };
    state.rereadError = { message: 'db down' };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 500);
  });

  // ---------- immediate dispatch: scoped, bounded, honest ----------
  await check('dispatch scoped to THE release event: booking + type + THIS driver + pending', async () => {
    state.events = [
      { id: 'ev-rel', booking_id: BID, event_type: 'ride_released', recipient_key: 'drv-a', state: 'pending' },
      { id: 'ev-other', booking_id: BID, event_type: 'ride_released', recipient_key: 'drv-z', state: 'pending' }
    ];
    state.dispatchBehavior = (ev) => { ev.state = 'submitted'; };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(state.dispatchCalls.length, 1, 'exactly one bounded pass');
    assert.strictEqual(state.dispatchCalls[0].ev.id, 'ev-rel', 'THIS driver\'s event, never another release');
    assert.ok(Number.isInteger(state.dispatchCalls[0].opts.maxAttempts) && state.dispatchCalls[0].opts.maxAttempts >= 1);
    const q = state.eventReads[0];
    assert.strictEqual(q.eqs.booking_id, BID);
    assert.strictEqual(q.eqs.event_type, 'ride_released');
    assert.strictEqual(q.eqs.recipient_key, 'drv-a');
    assert.deepStrictEqual(q.ins, [['state', ['pending']]]);
  });
  await check('stored truth says submitted -> immediateSubmission submitted', async () => {
    state.events = [
      { id: 'ev-rel', booking_id: BID, event_type: 'ride_released', recipient_key: 'drv-a', state: 'pending' }
    ];
    state.dispatchBehavior = (ev) => { ev.state = 'submitted'; };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(JSON.parse(r.body).immediateSubmission, 'submitted');
  });
  await check('dispatch dbFail -> release still 200, deferred (watchdog recovers)', async () => {
    state.events = [
      { id: 'ev-rel', booking_id: BID, event_type: 'ride_released', recipient_key: 'drv-a', state: 'pending' }
    ];
    state.dispatchBehavior = (ev, opts) => { opts.dbFail('dispatch refetch', new Error('db down')); };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 200, 'a committed release never reports failure');
    assert.strictEqual(JSON.parse(r.body).immediateSubmission, 'deferred');
  });
  await check('dispatch THROW -> release still 200, deferred', async () => {
    state.events = [
      { id: 'ev-rel', booking_id: BID, event_type: 'ride_released', recipient_key: 'drv-a', state: 'pending' }
    ];
    state.dispatchBehavior = () => { throw new Error('provider exploded'); };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).immediateSubmission, 'deferred');
  });
  await check('no pending event (already handled) -> zero dispatch calls, deferred', async () => {
    state.events = [
      { id: 'ev-rel', booking_id: BID, event_type: 'ride_released', recipient_key: 'drv-a', state: 'submitted' }
    ];
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(state.dispatchCalls.length, 0);
  });
  await check('events read failure -> release still 200, deferred, zero dispatch calls', async () => {
    state.eventReadError = { message: 'db down' };
    const r = await post({ bookingId: BID, reason: 'emergency' }, 'tok-active');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).immediateSubmission, 'deferred');
    assert.strictEqual(state.dispatchCalls.length, 0);
  });

  // ---------- driver.html static shape ----------
  const driverHtml = fs.readFileSync(path.join(repoRoot, 'driver.html'), 'utf8');
  await check('driver.html: Release button on CONFIRMED cards only', async () => {
    assert.ok(/b\.status === 'confirmed'\s*\n?\s*\? `<button class="btn-release" data-release-id=/.test(driverHtml),
      'release button must be gated on confirmed status');
    assert.ok(driverHtml.includes('data-release-id="${esc(b.id)}"'), 'booking id must be escaped');
  });
  await check('driver.html: release sheet has the 5 structured reasons + note rules', async () => {
    for (const reason of ['schedule_conflict', 'ride_details_changed', 'vehicle_issue', 'emergency', 'other']) {
      assert.ok(driverHtml.includes(`value="${reason}"`), `missing reason ${reason}`);
    }
    assert.ok(driverHtml.includes('id="relNote" rows="2" maxlength="500"'));
    assert.ok(driverHtml.includes("'(required for Other)'"), 'Other must require the note');
    assert.ok(driverHtml.includes("reason === 'other' && !note"), 'submit must refuse Other without a note');
  });
  await check('driver.html: release posts to /api/release-booking with the session token; 409 reconciles silently', async () => {
    assert.ok(driverHtml.includes("fetch('/api/release-booking'"));
    assert.ok(/release-booking'[\s\S]{0,300}Authorization/.test(driverHtml));
    assert.ok(/res\.ok \|\| res\.status === 409/.test(driverHtml), '409 -> close + refresh (doAction precedent)');
    assert.ok(driverHtml.includes("You won't be able to take it back"), 'warning copy present');
  });
  await check('driver.html: release sheet closes on Escape/backdrop and restores focus', async () => {
    assert.ok(/Escape' && !\$\('relSheet'\)\.classList\.contains\('hidden'\)\) closeReleaseSheet/.test(driverHtml));
    assert.ok(driverHtml.includes("$('relBackdrop').addEventListener('click', closeReleaseSheet)"));
    assert.ok(/releaseReturnFocus && releaseReturnFocus\.isConnected/.test(driverHtml));
  });

  // ---------- routing + migration static shape ----------
  await check('netlify.toml routes /api/release-booking', async () => {
    const toml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
    assert.ok(toml.includes('from = "/api/release-booking"'));
    assert.ok(toml.includes('to = "/.netlify/functions/release-booking"'));
  });
  await check('migration 016: table, snapshots, UNIQUE, CHECKs, driver_id index, RLS', async () => {
    const sql = fs.readFileSync(path.join(repoRoot, 'database/migrations/016_release_ride.sql'), 'utf8');
    assert.ok(sql.includes('CREATE TABLE booking_releases'));
    for (const col of ['pickup_at_release', 'price_at_release', 'driver_name_at_release',
                       'details_version_at_release', 'released_at']) {
      assert.ok(sql.includes(col), `missing column ${col}`);
    }
    assert.ok(sql.includes('UNIQUE (booking_id, driver_id)'));
    assert.ok(sql.includes('char_length(note) <= 500'));
    assert.ok(sql.includes("CHECK (reason <> 'other' OR (note IS NOT NULL AND btrim(note) <> ''))"));
    assert.ok(sql.includes('CREATE INDEX idx_booking_releases_driver ON booking_releases (driver_id)'));
    assert.ok(sql.includes('ALTER TABLE booking_releases ENABLE ROW LEVEL SECURITY'));
    assert.ok(sql.includes('ON DELETE CASCADE'));
  });
  await check('migration 016: RPC pinned/revoked/service_role-granted; triggers correct; 6h leash', async () => {
    const sql = fs.readFileSync(path.join(repoRoot, 'database/migrations/016_release_ride.sql'), 'utf8');
    assert.strictEqual((sql.match(/SECURITY DEFINER/g) || []).length >= 3, true,
      'all three functions must be SECURITY DEFINER');
    assert.strictEqual((sql.match(/SET search_path = public, pg_temp/g) || []).length >= 3, true);
    assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION release_booking(UUID, UUID, TEXT, TEXT) TO service_role'),
      'the service_role grant is the load-bearing clause');
    assert.ok(sql.includes('IF NOT FOUND THEN'), 'non-STRICT INTO + FOUND, never INTO STRICT');
    assert.ok(!sql.includes('INTO STRICT'));
    assert.ok(sql.includes('AFTER INSERT ON booking_releases'), 'outbox fires from the HISTORY insert');
    assert.ok(sql.includes('ON CONFLICT ON CONSTRAINT notification_events_identity DO NOTHING'));
    assert.ok(sql.includes("now() + interval '6 hours'"), 'explicit six-hour event expiry');
    assert.ok(/BEFORE UPDATE ON bookings\s*\n?\s*FOR EACH ROW/.test(sql),
      'reaccept guard must be FOR EACH ROW (WHEN with OLD/NEW is invalid without it)');
    assert.ok(sql.includes('released_by_this_driver'));
  });
  await check('migration 016: throwaway smoke drivers, negative sub-blocks, duplicate proof, rollback', async () => {
    const sql = fs.readFileSync(path.join(repoRoot, 'database/migrations/016_release_ride.sql'), 'utf8');
    assert.ok(sql.includes("'MIGRATION-016-SMOKE-A'") && sql.includes("'MIGRATION-016-SMOKE-B'"),
      'smoke must INSERT throwaway drivers, never borrow real rows');
    assert.ok((sql.match(/EXCEPTION WHEN/g) || []).length >= 4,
      'negative assertions must run in their own EXCEPTION sub-blocks');
    assert.ok(sql.includes('EXCEPTION WHEN unique_violation'), 'the UNIQUE is proven by direct tampering');
    assert.ok(sql.includes('DELETE FROM drivers WHERE id IN (drv_a, drv_b)'), 'throwaway drivers torn down');
    assert.ok(sql.includes('-- DROP TABLE IF EXISTS booking_releases;'), 'rollback section present');
  });

  if (failures.length) {
    console.error(`\n${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
