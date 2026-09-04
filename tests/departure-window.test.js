// Departure window — "On my way" opens with the readiness window (T-180).
//
// Run: node tests/departure-window.test.js
//
// Product invariant (Andres, 2026-09-04): reliability is the product, so a
// passenger must never see "On the way" for a ride that is still hours or
// days away. "Unable to click" must mean BOTH presentation and server
// authority — a stale open tab or a direct request gets the same typed
// refusal from the server's own clock (/driver is deliberately uncached).
//
// Server design under test: the time gate is a predicate of the SAME
// guarded UPDATE as status + ownership (pickup_datetime <= now + window,
// against ONE captured server instant), so it is atomic with the
// transition and fails closed on NULL/invalid pickup times. A zero-row
// result is classified AFTER the verified-idempotency checks, then as a
// typed departure refusal for the owner of a still-confirmed ride only.
//
// Layer 1 (BEHAVIOR, server): mocks @supabase/supabase-js via require.cache
// and runs the REAL handler, capturing the update predicate.
// Layer 2 (BEHAVIOR, driver UI): the real departureGate / fmtMiami /
// renderNextControl / doAction are extracted from driver.html and EXECUTED
// under vm with spied geolocation, POST, alert, and refresh.
// Layer 3 (STATIC, labelled honestly): the two 180-minute copies are pinned
// to each other, the note placement, and the click dispatcher's selector.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
delete process.env.TELEGRAM_BOT_TOKEN;

// ---------- mock state ----------
const TOKENS = { 'tok-owner': { id: 'auth-o' }, 'tok-other': { id: 'auth-x' } };
const DRIVERS_BY_USER = {
  'auth-o': { id: 'drv-o', name: 'Owner', phone: '+17865093955', status: 'active' },
  'auth-x': { id: 'drv-x', name: 'Other', phone: '+13055551212', status: 'active' }
};
let updateResult = { data: [], error: null };
let updateCalls = 0;
let lastUpdate = null;
let lastFilters = null;                       // [op, col, val] on the update chain
let currentRow = { data: null, error: null }; // the zero-row classification re-read
let rereadCols = null;

const supabaseMock = {
  createClient: () => ({
    auth: {
      getUser: async (token) => TOKENS[token]
        ? { data: { user: TOKENS[token] }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } }
    },
    from: (table) => {
      if (table === 'drivers') {
        return { select: () => ({ eq: (col, val) => ({ single: () => Promise.resolve(
          DRIVERS_BY_USER[val] ? { data: DRIVERS_BY_USER[val], error: null } : { data: null, error: { message: 'none' } }
        ) }) }) };
      }
      assert.strictEqual(table, 'bookings');
      return {
        update(payload) {
          updateCalls++;
          lastUpdate = payload;
          const filters = [];
          lastFilters = filters;
          const chain = {
            eq(c, v) { filters.push(['eq', c, v]); return chain; },
            in(c, v) { filters.push(['in', c, v]); return chain; },
            is(c, v) { filters.push(['is', c, v]); return chain; },
            lte(c, v) { filters.push(['lte', c, v]); return chain; },
            select() { return Promise.resolve(updateResult); }
          };
          return chain;
        },
        select(cols) {
          rereadCols = cols;
          const chain = {
            eq() { return chain; },
            maybeSingle() { return Promise.resolve(currentRow); },
            single() { return Promise.resolve(currentRow); }
          };
          return chain;
        }
      };
    }
  })
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };
const upd = require(path.join(repoRoot, 'backend/functions/update-booking-status.js'));

const BID = '123e4567-e89b-42d3-a456-426614174000';
const post = (body, token) => upd.handler({
  httpMethod: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body)
});
const WINDOW_MS = 180 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const FROZEN = Date.parse('2026-09-10T12:00:00.000Z');
const realNow = Date.now;
function freeze(ms) { Date.now = () => ms; }
function thaw() { Date.now = realNow; }
function reset() {
  updateResult = { data: [], error: null };
  updateCalls = 0;
  lastUpdate = null;
  lastFilters = null;
  currentRow = { data: null, error: null };
  rereadCols = null;
}
const cutoffFilter = () => (lastFilters || []).find((f) => f[0] === 'lte' && f[1] === 'pickup_datetime');
const owned = (over) => ({ data: { status: 'confirmed', assigned_driver: 'drv-o', details_version: 1, ...over }, error: null });

let checks = 0;
const results = [];
async function check(name, f) {
  try { await f(); checks++; results.push(`  ✓ ${name}`); }
  catch (err) {
    results.push(`  ✗ ${name}\n      ${err.message}`);
    results.forEach((x) => console.log(x));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  } finally { thaw(); }
}

(async () => {
  console.log('\nDeparture window — On my way opens at T-180\n');

  // ============ Layer 1: server authority ============
  await check('SERVER: the time gate is a predicate of the guarded UPDATE itself (atomic with status + ownership)', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [{ id: BID, status: 'on_the_way', trip_id: 'LM-TEST' }], error: null };
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(cutoffFilter(), ['lte', 'pickup_datetime', iso(FROZEN + WINDOW_MS)],
      'pickup must be <= now + 3h, evaluated by the database against the captured server instant');
    assert.ok(lastFilters.some((f) => f[0] === 'in' && f[1] === 'status'), 'status guard still present');
    assert.ok(lastFilters.some((f) => f[0] === 'eq' && f[1] === 'assigned_driver' && f[2] === 'drv-o'), 'ownership guard still present');
  });

  await check('SERVER: ONE captured instant drives cutoff, verdict, and on_the_way_at', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [{ id: BID, status: 'on_the_way', trip_id: 'LM-TEST' }], error: null };
    await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(lastUpdate.on_the_way_at, iso(FROZEN), 'stamp must be the same instant as the cutoff basis');
    assert.strictEqual(cutoffFilter()[2], iso(FROZEN + WINDOW_MS));
    assert.strictEqual(lastUpdate.at_risk_at, null);
  });

  await check('SERVER: just before the boundary (predicate matched 0 rows, re-read pickup = now + 3h + 1ms) -> typed 409 with exact opensAt', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [], error: null };
    currentRow = owned({ pickup_datetime: iso(FROZEN + WINDOW_MS + 1) });
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.code, 'departure_window_closed');
    assert.match(body.error, /Too early — On my way opens 3 hours before pickup/);
    assert.strictEqual(body.opensAt, iso(FROZEN + 1), 'opensAt = pickup - 3h, exact instant');
    assert.strictEqual(body.currentStatus, 'confirmed');
    assert.strictEqual(updateCalls, 1, 'exactly one guarded UPDATE attempt');
    assert.match(rereadCols, /pickup_datetime/, 'the classification re-read must fetch the pickup time');
  });

  await check('SERVER: EXACTLY at the boundary the predicate value equals the pickup (lte matches) -> allowed', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [{ id: BID, status: 'on_the_way', trip_id: 'LM-TEST' }], error: null };
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(cutoffFilter()[2], iso(FROZEN + WINDOW_MS), 'a pickup at exactly now + 3h satisfies pickup <= cutoff');
  });

  await check('SERVER: window OPEN but zero rows (some other conflict) -> ordinary 409, NO departure code (classification is strict <)', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [], error: null };
    currentRow = owned({ pickup_datetime: iso(FROZEN + WINDOW_MS) });   // opensAt === now: open
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.code, undefined, 'an open window must not be reported as closed');
    assert.strictEqual(body.opensAt, undefined);
    assert.strictEqual(body.error, 'Invalid transition');
  });

  await check('SERVER: the predicate is pickup-independent and has NO late bound — the same "pickup <= now + 3h" cutoff is sent whether the ride is at T-60 or T+10; the database decides', async () => {
    // This mock does not evaluate predicates, so the pickup value cannot be
    // exercised here; what IS pinned is that the handler sends one and only
    // one time condition (an upper bound on pickup) and no lower bound that
    // could refuse a late driver. Late/early row matching is the database's
    // job and is covered by the predicate-shape checks above.
    freeze(FROZEN); reset();
    updateResult = { data: [{ id: BID, status: 'on_the_way', trip_id: 'LM-TEST' }], error: null };
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 200);
    const timeFilters = lastFilters.filter((f) => f[1] === 'pickup_datetime');
    assert.deepStrictEqual(timeFilters, [['lte', 'pickup_datetime', iso(FROZEN + WINDOW_MS)]],
      'exactly one time condition, an upper bound — no lower bound exists to refuse a late departure');
  });

  await check('SERVER: ATOMIC RACE — pickup rescheduled far-future between eligibility and write -> predicate matches nothing, no status/GPS/timestamp lands, typed refusal from the fresh re-read', async () => {
    freeze(FROZEN); reset();
    // The database evaluates the predicate at write time: a ride that was
    // in-window a moment ago but is now 2 days out matches ZERO rows. The
    // mock returns 0 rows exactly as Postgres would; the fresh re-read
    // then shows the moved pickup.
    updateResult = { data: [], error: null };
    currentRow = owned({ pickup_datetime: iso(FROZEN + 2 * 24 * 3600000) });
    const r = await post({ bookingId: BID, action: 'on_my_way', lat: 25.79, lng: -80.29 }, 'tok-owner');
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).code, 'departure_window_closed');
    assert.strictEqual(JSON.parse(r.body).opensAt, iso(FROZEN + 2 * 24 * 3600000 - WINDOW_MS));
    assert.ok(cutoffFilter(), 'the write carried the cutoff predicate — it could not have matched the moved row');
    assert.strictEqual(updateCalls, 1, 'no retry write');
  });

  await check('SERVER: FAR-FUTURE but ALREADY on_the_way by this owner -> verified idempotent 200 (target state wins over timing)', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [], error: null };
    currentRow = { data: { status: 'on_the_way', assigned_driver: 'drv-o', details_version: 1, pickup_datetime: iso(FROZEN + 5 * 24 * 3600000) }, error: null };
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).idempotent, true);
  });

  await check('SERVER: an owned ride that is NEITHER confirmed NOR already departed (e.g. completed) with a far-future pickup -> ordinary 409, no window code (classification is confirmed-scoped)', async () => {
    for (const status of ['completed', 'arrived', 'in_progress']) {
      freeze(FROZEN); reset();
      updateResult = { data: [], error: null };
      currentRow = { data: { status, assigned_driver: 'drv-o', details_version: 1, pickup_datetime: iso(FROZEN + 2 * 24 * 3600000) }, error: null };
      const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
      assert.strictEqual(r.statusCode, 409, status);
      const body = JSON.parse(r.body);
      assert.strictEqual(body.code, undefined, `${status}: an invalid transition must not be dressed up as a departure-window refusal`);
      assert.strictEqual(body.error, 'Invalid transition');
      assert.strictEqual(body.currentStatus, status);
      thaw();
    }
  });

  await check('SERVER: unparseable or NULL pickup time -> typed 409 departure_window_unverifiable (fail closed)', async () => {
    for (const bad of ['not-a-date', null, undefined]) {
      freeze(FROZEN); reset();
      updateResult = { data: [], error: null };   // NULL/invalid never satisfies pickup <= cutoff
      currentRow = owned({ pickup_datetime: bad });
      const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
      assert.strictEqual(r.statusCode, 409, `pickup ${bad}`);
      assert.strictEqual(JSON.parse(r.body).code, 'departure_window_unverifiable');
      thaw();
    }
  });

  await check('SERVER: non-owner early attempt -> ordinary 409 with NO window code and NO opensAt', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [], error: null };
    currentRow = owned({ pickup_datetime: iso(FROZEN + 2 * 24 * 3600000) });   // owned by drv-o
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-other');
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.code, undefined);
    assert.strictEqual(body.opensAt, undefined);
    assert.strictEqual(body.currentStatus, 'confirmed');
  });

  await check('SERVER: zero-row re-read FAILURE -> sanitized 500 (never a guessed conflict the driver would silently reconcile)', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [], error: null };
    currentRow = { data: null, error: { message: 'connection timeout (secret internals)' } };
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 500);
    assert.deepStrictEqual(JSON.parse(r.body), { error: 'Lookup failed' }, 'sanitized: no DB internals in the body');
    assert.match(rereadCols, /pickup_datetime/);
  });

  await check('SERVER: zero-row re-read finds NO row (no error) -> ordinary 409 conflict, no window code', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [], error: null };
    currentRow = { data: null, error: null };
    const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 409);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.code, undefined);
    assert.strictEqual(body.currentStatus, 'unknown');
  });

  await check('SERVER: direct early POST with coordinates (stale open tab / direct request, the LM-W634 shape) -> refused, predicate carried', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [], error: null };
    currentRow = owned({ pickup_datetime: iso(FROZEN + 2 * 24 * 3600000) });
    const r = await post({ bookingId: BID, action: 'on_my_way', lat: 25.79, lng: -80.29 }, 'tok-owner');
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(JSON.parse(r.body).code, 'departure_window_closed');
    assert.ok(cutoffFilter());
  });

  await check('SERVER: DST/UTC — the same instant as -04:00 / -05:00 / Z yields the same opensAt; the cutoff is a Z instant', async () => {
    const instantMs = Date.parse('2026-11-01T15:00:00Z');   // US fall-back date
    const forms = ['2026-11-01T11:00:00-04:00', '2026-11-01T10:00:00-05:00', '2026-11-01T15:00:00Z'];
    for (const form of forms) {
      freeze(instantMs - WINDOW_MS - 5000); reset();
      updateResult = { data: [], error: null };
      currentRow = owned({ pickup_datetime: form });
      const r = await post({ bookingId: BID, action: 'on_my_way' }, 'tok-owner');
      assert.strictEqual(r.statusCode, 409, form);
      assert.strictEqual(JSON.parse(r.body).opensAt, iso(instantMs - WINDOW_MS), `same instant for ${form}`);
      assert.match(cutoffFilter()[2], /Z$/, 'cutoff is an unambiguous UTC instant');
      thaw();
    }
  });

  await check('SERVER: other transitions carry NO departure predicate', async () => {
    freeze(FROZEN); reset();
    updateResult = { data: [{ id: BID, status: 'arrived', trip_id: 'LM-TEST' }], error: null };
    const r = await post({ bookingId: BID, action: 'arrived' }, 'tok-owner');
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(cutoffFilter(), undefined);
  });

  // ============ Layer 2: driver UI, EXECUTED under vm ============
  const driverHtml = fs.readFileSync(path.join(repoRoot, 'driver.html'), 'utf8');
  const gateSlice = driverHtml.slice(
    driverHtml.indexOf('function departureGate('),
    driverHtml.indexOf('// ---- WhatsApp quick messages ----')
  );
  const doActionSlice = driverHtml.slice(
    driverHtml.indexOf('async function doAction('),
    driverHtml.indexOf("document.addEventListener('click', (e) => {")
  );
  assert.ok(gateSlice.includes('function renderNextControl(') && doActionSlice.includes('await postAction(body)'), 'slices extractable');

  function makeUi({ postResult } = {}) {
    const calls = { gps: 0, post: [], alerts: [], refresh: 0, nav: null };
    const ctx = {
      DEPARTURE_WINDOW_MS: WINDOW_MS, Date, console,
      esc: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
      lastBookings: [],
      CHECKPOINT_ACTIONS: ['on_my_way', 'arrived', 'start_trip'],
      getCheckpointFix: async () => { calls.gps++; return { lat: 25.7, lng: -80.2 }; },
      postAction: async (body) => { calls.post.push(body); return postResult || { ok: true, status: 200, data: { success: true } }; },
      alert: (m) => calls.alerts.push(m),
      confirm: () => false,
      refresh: async () => { calls.refresh++; },
      navigationUrl: () => null,
      switchView: () => {},
      window: { location: { get href() { return calls.nav; }, set href(v) { calls.nav = v; } } }
    };
    vm.createContext(ctx);
    vm.runInContext(gateSlice + '\n' + doActionSlice +
      '\nthis.departureGate = departureGate; this.fmtMiami = fmtMiami; this.renderNextControl = renderNextControl; this.doAction = doAction;', ctx);
    return { ctx, calls };
  }
  const NEXT = { action: 'on_my_way', label: '🚗 On my way' };
  const ride = (over) => ({ id: BID, status: 'confirmed', pickup_datetime: iso(Date.now() + 2 * 24 * 3600000), ...over });

  await check('UI: departureGate — closed before T-180, open at/after the exact boundary, no late lock, fails CLOSED on a bad pickup time', async () => {
    const { ctx } = makeUi();
    const now = FROZEN;
    const g = (pickupMs) => ({ ...ctx.departureGate({ status: 'confirmed', pickup_datetime: iso(pickupMs) }, now) });
    assert.deepStrictEqual(g(now + WINDOW_MS + 1), { locked: true, reason: 'closed', opensAt: iso(now + 1) });
    assert.strictEqual(g(now + WINDOW_MS).locked, false, 'exact boundary is open');
    assert.strictEqual(g(now - 60000).locked, false, 'no late lock');
    assert.deepStrictEqual({ ...ctx.departureGate({ status: 'confirmed', pickup_datetime: 'garbage' }) }, { locked: true, reason: 'unverifiable', opensAt: null });
    assert.deepStrictEqual({ ...ctx.departureGate({ status: 'confirmed' }) }, { locked: true, reason: 'unverifiable', opensAt: null });
    assert.deepStrictEqual({ ...ctx.departureGate({ status: 'on_the_way', pickup_datetime: 'garbage' }) }, { locked: false, reason: null, opensAt: null });
    assert.deepStrictEqual({ ...ctx.departureGate(null) }, { locked: false, reason: null, opensAt: null }, 'unknown ride is left to the server');
  });

  await check('UI: a LOCKED card renders a disabled button with NO data-action at all; the note is separate and Miami-dated', async () => {
    const { ctx } = makeUi();
    const locked = ctx.renderNextControl(ride(), NEXT);
    assert.match(locked.button, /<button class="btn-next" disabled /);
    assert.ok(!/data-action=/.test(locked.button), 'a locked button must never carry data-action (the dispatcher selector)');
    assert.match(locked.button, /data-locked-action="on_my_way"/);
    assert.match(locked.note, /On my way opens at (Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM) E[DS]T/);
    // ACCESSIBILITY: the disabled button is programmatically linked to its
    // explanation, and the note id is stable and escaped.
    const noteId = `departure-note-${BID}`;
    assert.match(locked.button, new RegExp(`aria-describedby="${noteId}"`));
    assert.match(locked.note, new RegExp(`<div class="ready-note" id="${noteId}">`));
    // The note id and the aria link are ESCAPED (a hostile id cannot break
    // out of the attribute or inject markup into the note). data-id itself
    // is the page's pre-existing raw interpolation of a database UUID and is
    // outside this change.
    const hostile = ctx.renderNextControl(ride({ id: 'x"><script>' }), NEXT);
    assert.ok(!/<script>/.test(hostile.note), 'the note id is escaped');
    assert.match(hostile.note, /id="departure-note-x&quot;&gt;&lt;script&gt;"/);
    assert.match(hostile.button, /aria-describedby="departure-note-x&quot;&gt;&lt;script&gt;"/);
    const bad = ctx.renderNextControl(ride({ pickup_datetime: null }), NEXT);
    assert.match(bad.button, /disabled /);
    assert.ok(!/data-action=/.test(bad.button));
    assert.match(bad.note, /no valid pickup time.*contact LinkMia/);
    const open = ctx.renderNextControl(ride({ pickup_datetime: iso(Date.now() + 60 * 60000) }), NEXT);
    assert.match(open.button, /data-action="on_my_way"/);
    assert.ok(!/disabled/.test(open.button));
    assert.strictEqual(open.note, '');
  });

  await check('UI: doAction on a LOCKED ride explains and refreshes — NO geolocation, NO POST', async () => {
    const { ctx, calls } = makeUi();
    ctx.lastBookings.push(ride());
    await ctx.doAction('on_my_way', BID);
    assert.strictEqual(calls.gps, 0, 'no location capture for a request the server would refuse');
    assert.strictEqual(calls.post.length, 0, 'no POST');
    assert.strictEqual(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /On my way opens at .* E[DS]T \(3 hours before pickup\)\./);
    assert.strictEqual(calls.refresh, 1);
  });

  await check('UI: doAction on an UNVERIFIABLE pickup time explains support contact — NO geolocation, NO POST', async () => {
    const { ctx, calls } = makeUi();
    ctx.lastBookings.push(ride({ pickup_datetime: 'garbage' }));
    await ctx.doAction('on_my_way', BID);
    assert.strictEqual(calls.gps, 0);
    assert.strictEqual(calls.post.length, 0);
    assert.match(calls.alerts[0], /no valid pickup time.*contact LinkMia/);
    assert.strictEqual(calls.refresh, 1);
  });

  await check('UI: doAction on an OPEN ride captures one fix and POSTs it', async () => {
    const { ctx, calls } = makeUi();
    ctx.lastBookings.push(ride({ pickup_datetime: iso(Date.now() + 60 * 60000) }));
    await ctx.doAction('on_my_way', BID);
    assert.strictEqual(calls.gps, 1);
    assert.strictEqual(calls.post.length, 1);
    assert.deepStrictEqual({ ...calls.post[0] }, { bookingId: BID, action: 'on_my_way', paymentMethod: undefined, lat: 25.7, lng: -80.2 });
    assert.strictEqual(calls.alerts.length, 0);
  });

  await check('UI: a STALE tab (phone clock says open, server says closed) surfaces the typed 409 in Miami time and refreshes — no navigation', async () => {
    const opensAt = iso(Date.now() + 26 * 3600000);
    const { ctx, calls } = makeUi({ postResult: { ok: false, status: 409, data: { code: 'departure_window_closed', opensAt } } });
    ctx.lastBookings.push(ride({ pickup_datetime: iso(Date.now() + 60 * 60000) }));   // the page believes it is open
    await ctx.doAction('on_my_way', BID);
    // Honest residual (v1): because the page believed the window was open,
    // ONE ephemeral GPS fix was captured before the server's refusal. It is
    // never stored — the predicate matched nothing — but it did happen.
    assert.strictEqual(calls.gps, 1, 'a fast phone clock costs exactly one ephemeral fix');
    assert.strictEqual(calls.post.length, 1);
    assert.strictEqual(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /^On my way opens at (Sun|Mon|Tue|Wed|Thu|Fri|Sat), .* E[DS]T \(3 hours before pickup\)\.$/);
    assert.strictEqual(calls.refresh, 1);
    assert.strictEqual(calls.nav, null, 'a refusal must never open navigation');
  });

  await check('UI: the typed UNVERIFIABLE 409 is surfaced too; an ordinary 409 still reconciles silently', async () => {
    let u = makeUi({ postResult: { ok: false, status: 409, data: { code: 'departure_window_unverifiable' } } });
    u.ctx.lastBookings.push(ride({ pickup_datetime: iso(Date.now() + 60 * 60000) }));
    await u.ctx.doAction('on_my_way', BID);
    assert.match(u.calls.alerts[0], /no valid pickup time.*contact LinkMia/);
    assert.strictEqual(u.calls.refresh, 1);
    u = makeUi({ postResult: { ok: false, status: 409, data: { error: 'Invalid transition', currentStatus: 'on_the_way' } } });
    u.ctx.lastBookings.push(ride({ pickup_datetime: iso(Date.now() + 60 * 60000) }));
    await u.ctx.doAction('on_my_way', BID);
    assert.strictEqual(u.calls.alerts.length, 0, 'ordinary 409 stays silent');
    assert.strictEqual(u.calls.refresh, 1);
  });

  await check('UI: fmtMiami renders weekday, date, time and the zone abbreviation for both DST and standard time', async () => {
    const { ctx } = makeUi();
    assert.match(ctx.fmtMiami('2026-07-04T18:30:00Z'), /^Sat, Jul 4, 2:30 PM EDT$/);
    assert.match(ctx.fmtMiami('2026-12-25T04:30:00Z'), /^Thu, Dec 24, 11:30 PM EST$/, 'a prior-evening opening is dated, never mistaken for today');
  });

  await check('UI: ONE time language — pickup header, readiness note and opening all render through fmtMiami, proven under a NON-ET device timezone', async () => {
    // fmtWhen (pickup header) lives outside the gate slice; extract and run
    // it with the SAME fmtMiami. Under TZ=Asia/Tokyo (13h ahead of EDT), a
    // device-local render would show a different day AND hour.
    const whenSlice = driverHtml.slice(driverHtml.indexOf('function fmtWhen('), driverHtml.indexOf('function isUrgent('));
    const { ctx } = makeUi();
    vm.runInContext(whenSlice + '\nthis.fmtWhen = fmtWhen;', ctx);
    const savedTz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      const pickup = '2026-09-05T22:30:00Z';           // Sep 5 6:30 PM EDT = Sep 6 7:30 AM Tokyo
      assert.strictEqual(ctx.fmtWhen(pickup), 'Sat, Sep 5, 6:30 PM EDT', 'pickup header is Miami-dated/zoned, not device-local');
      assert.strictEqual(ctx.fmtWhen(null), 'ASAP');
      const opening = ctx.renderNextControl({ id: BID, status: 'confirmed', pickup_datetime: pickup }, NEXT).note;
      assert.match(opening, /On my way opens at Sat, Sep 5, 3:30 PM EDT/, 'the opening is the same clock as the header: 3h before 6:30 PM EDT');
      assert.notStrictEqual(new Date(pickup).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }), '6:30 PM',
        'sanity: under Tokyo a device-local render really would differ');
    } finally {
      if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    }
    assert.match(driverHtml, /Readiness check begins at \$\{fmtMiami\(checkAt\)\}/, 'readiness note uses the shared formatter');
    assert.match(driverHtml, /<div class="ride-when">\$\{fmtWhen\(b\.pickup_datetime\)\}<\/div>/);
    assert.ok(!/fmtTimeET|fmtOpensAt|toLocaleTimeString\('en-US', \{ hour: 'numeric', minute: '2-digit', hour12: true \}\)/.test(driverHtml),
      'no device-local or second formatter remains on the card');
  });

  // ============ Layer 3: static pins ============
  await check('STATIC: the two 180-minute copies (server RECENT_ACCEPT_MS, browser READY_BUTTON_MS) are pinned to each other', async () => {
    const server = fs.readFileSync(path.join(repoRoot, 'backend/functions/update-booking-status.js'), 'utf8');
    assert.match(server, /const RECENT_ACCEPT_MS = 180 \* 60 \* 1000;/);
    assert.match(server, /const DEPARTURE_WINDOW_MS = RECENT_ACCEPT_MS;/);
    assert.match(driverHtml, /const READY_BUTTON_MS = 180 \* 60 \* 1000;/);
    assert.match(driverHtml, /const DEPARTURE_WINDOW_MS = READY_BUTTON_MS;/);
  });

  await check('STATIC: accessible lock — AA contrast for .ready-note and an honest disabled cursor', async () => {
    assert.match(driverHtml, /\.ready-note \{[^}]*color: #9a5000;/, '#9a5000 = 5.96:1 on white, 5.52:1 on the page (AA >= 4.5)');
    assert.ok(!/\.ready-note \{[^}]*color: #cc7000/.test(driverHtml), 'the sub-AA #cc7000 must not return as the note COLOR (the CSS comment may mention it)');
    assert.match(driverHtml, /button:disabled \{ opacity: 0\.5; cursor: not-allowed; \}/);
  });

  await check('STATIC: the note renders AFTER the closing btn-row, and the click dispatcher only selects button[data-action]', async () => {
    assert.match(driverHtml, /<\/div>\$\{departureNote\}\$\{readinessBlock\(b\)\}/, 'note must follow the flex row, never sit inside it');
    assert.match(driverHtml, /<div class="btn-row">\s*\$\{payBtn\}\s*\$\{nextBtn\}\s*<\/div>/);
    assert.match(driverHtml, /e\.target\.closest\('button\[data-action\]'\)/);
  });

  results.forEach((x) => console.log(x));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
