// Notification ledger + watchdog test harness (PR 1).
//
// Run (after `npm install` per LOCAL_DEVELOPMENT.md):
//   node tests/notification-ledger.test.js
// Exits 0 with "ALL n CHECKS PASS" on success, nonzero otherwise.
//
// Pattern: mocks @supabase/supabase-js via require.cache (same as
// tests/driver-identity.test.js) but with a small IN-MEMORY table engine
// that enforces the ledger's unique constraints — the idempotent-insert
// and insert-as-claim guarantees are exercised for real, not stubbed.
// The engine also supports FAILURE INJECTION ({op, table, times, skip})
// so database errors can be proven to surface instead of being
// swallowed. global.fetch is replaced to capture/steer Telegram calls.
// The REAL watchdog handler and notify library run unmodified.

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
process.env.ADMIN_TELEGRAM_CHAT_ID = 'admin-chat';
process.env.URL = 'https://example.test';
delete process.env.WATCHDOG_DISABLED;
delete process.env.WATCHDOG_BUDGET_MS;

const MIAMI_TZ = 'America/New_York';

// ---------- in-memory table engine ----------
let state = null;
let idSeq = 0;

const UNIQUE_VIOLATION = {
  notification_events: (row, rows) => rows.some((r) =>
    r.booking_id === row.booking_id && r.event_type === row.event_type &&
    r.recipient_key === row.recipient_key),
  notification_deliveries: (row, rows) => rows.some((r) =>
    r.event_id === row.event_id && r.channel === row.channel &&
    r.attempt_no === row.attempt_no),
  system_state: (row, rows) => rows.some((r) => r.key === row.key)
};

// Failure injection: state.inject = [{ op, table, times, skip }]
// skip: number of matching calls to let through before failing.
function injectedFailure(op, table) {
  for (const inj of state.inject || []) {
    if (inj.op !== op || inj.table !== table) continue;
    if (inj.skip > 0) { inj.skip--; continue; }
    if (inj.times > 0) {
      inj.times--;
      return { message: `injected failure: ${op} ${table}` };
    }
  }
  return null;
}

class Query {
  constructor(table) {
    this.table = table;
    this.op = null;
    this.payload = null;
    this.filters = [];
    this.orExpr = null;
    this.orderCol = null;
    this.limitN = null;
    this.mode = null; // 'single' | 'maybeSingle'
  }
  select(cols) {
    if (this.op) { this.wantRows = true; return this; }
    this.op = 'select'; this.cols = cols; return this;
  }
  update(payload) { this.op = 'update'; this.payload = payload; return this; }
  insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
  upsert(rows, opts) { this.op = 'upsert'; this.payload = rows; this.upsertOpts = opts; return this; }
  eq(col, val)  { this.filters.push({ t: 'eq', col, val }); return this; }
  neq(col, val) { this.filters.push({ t: 'neq', col, val }); return this; }
  in(col, val)  { this.filters.push({ t: 'in', col, val }); return this; }
  is(col, val)  { this.filters.push({ t: 'is', col, val }); return this; }
  lt(col, val)  { this.filters.push({ t: 'lt', col, val }); return this; }
  lte(col, val) { this.filters.push({ t: 'lte', col, val }); return this; }
  gte(col, val) { this.filters.push({ t: 'gte', col, val }); return this; }
  or(expr) { this.orExpr = expr; return this; } // recorded, not evaluated
  order(col) { this.orderCol = col; return this; }
  limit(n) { this.limitN = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybeSingle'; return this; }

  _match(row) {
    return this.filters.every((f) => {
      const v = row[f.col];
      if (f.t === 'eq') return v === f.val;
      if (f.t === 'neq') return v !== f.val;
      if (f.t === 'in') return f.val.includes(v);
      if (f.t === 'is') return f.val === null ? v == null : v === f.val;
      if (f.t === 'lt') return v != null && v < f.val;
      if (f.t === 'lte') return v != null && v <= f.val;
      if (f.t === 'gte') return v != null && v >= f.val;
      return false;
    });
  }

  _exec() {
    const failure = injectedFailure(this.op, this.table);
    if (failure) return { data: null, error: failure };
    const rows = state[this.table] || (state[this.table] = []);
    if (this.op === 'select') {
      let out = rows.filter((r) => this._match(r));
      if (this.orderCol) {
        const c = this.orderCol;
        out = out.slice().sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0));
      }
      if (this.limitN != null) out = out.slice(0, this.limitN);
      out = out.map((r) => ({ ...r }));
      if (this.mode === 'single') {
        return out.length
          ? { data: out[0], error: null }
          : { data: null, error: { message: '0 rows' } };
      }
      if (this.mode === 'maybeSingle') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    if (this.op === 'update') {
      const matched = rows.filter((r) => this._match(r));
      matched.forEach((r) => Object.assign(r, this.payload));
      return { data: matched.map((r) => ({ ...r })), error: null };
    }
    if (this.op === 'insert' || this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const unique = UNIQUE_VIOLATION[this.table];
      const inserted = [];
      for (const raw of list) {
        const row = { id: raw.id || `row-${++idSeq}`, ...raw };
        if (unique && unique(row, rows)) {
          if (this.op === 'upsert') continue; // ignoreDuplicates semantics
          return { data: [], error: { code: '23505', message: 'duplicate key' } };
        }
        rows.push(row);
        inserted.push({ ...row });
      }
      return { data: inserted, error: null };
    }
    throw new Error('unsupported op');
  }

  then(res, rej) { return Promise.resolve().then(() => this._exec()).then(res, rej); }
}

const supabaseMock = {
  createClient: () => ({ from: (table) => new Query(table) })
};

// ---------- fetch mock (Telegram) ----------
let fetchCalls = [];
let fetchBehavior = async () => ({ ok: true, status: 200 });
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
  return fetchBehavior(url, opts);
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const wd = require(path.join(repoRoot, 'backend/functions/notification-watchdog.js'));
const notify = require(path.join(repoRoot, 'backend/functions/lib/notify.js'));

// ---------- fixtures ----------
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: MIAMI_TZ });
const iso = (minsFromNow) => new Date(Date.now() + minsFromNow * 60e3).toISOString();
const errWithCode = (code) => { const e = new Error(code); e.code = code; return e; };

function freshState({ silenceHeartbeat = true } = {}) {
  state = {
    bookings: [],
    drivers: [
      { id: 'drv-a', name: 'Andres', telegram_chat_id: 'chat-a' },
      { id: 'drv-b', name: 'Backup', telegram_chat_id: 'chat-b' }
    ],
    notification_events: [],
    notification_deliveries: [],
    system_state: silenceHeartbeat
      ? [{ key: 'last_heartbeat_date', value: todayET() }]
      : [],
    inject: []
  };
  fetchCalls = [];
  fetchBehavior = async () => ({ ok: true, status: 200 });
}

function mkBooking(overrides) {
  return {
    id: `bk-${++idSeq}`,
    trip_id: 'LM-TEST',
    status: 'confirmed',
    pickup_datetime: iso(140),
    pickup_location: 'Brickell',
    dropoff_location: 'MIA',
    customer_name: 'Pat',
    assigned_driver: 'drv-a',
    driver_ready_at: null,
    driver_ready_by: null,
    driver_ready_source: null,
    at_risk_at: null,
    accepted_at: iso(-600),
    ...overrides
  };
}

function events() { return state.notification_events; }
function deliveries() { return state.notification_deliveries; }
function telegramChats() { return fetchCalls.map((c) => c.body && c.body.chat_id); }
function heartbeatValue() {
  const row = state.system_state.find((r) => r.key === 'last_heartbeat_date');
  return row ? row.value : null;
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

(async () => {
  // ---------- kill switch ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) }));
  process.env.WATCHDOG_DISABLED = '1';
  let r = await wd.handler({});
  check('kill switch: WATCHDOG_DISABLED skips everything', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(JSON.parse(r.body).skipped, true);
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(events().length, 0);
  });
  delete process.env.WATCHDOG_DISABLED;

  // ---------- Telegram outcome classification (duplicate-safety) ----------
  freshState();
  const classify = async (behavior) => {
    fetchBehavior = behavior;
    const res = await notify.sendTelegram('chat-x', 'hello');
    return res.outcome;
  };
  let outcome;
  outcome = await classify(async () => ({ ok: true, status: 200 }));
  check('2xx -> submitted (terminal success; never claims the person saw it)', () =>
    assert.strictEqual(outcome, 'submitted'));
  outcome = await classify(async () => ({ ok: false, status: 429 }));
  check('429 -> retryable (Telegram explicitly did not process the request)', () =>
    assert.strictEqual(outcome, 'retryable'));
  outcome = await classify(async () => ({ ok: false, status: 502 }));
  check('5xx -> ambiguous (request reached Telegram; acceptance unprovable)', () =>
    assert.strictEqual(outcome, 'ambiguous'));
  outcome = await classify(async () => ({ ok: false, status: 400 }));
  check('other 4xx -> definitive (rejected; retry cannot succeed)', () =>
    assert.strictEqual(outcome, 'definitive'));
  outcome = await classify(async () => {
    const e = new Error('aborted'); e.name = 'AbortError'; throw e;
  });
  check('timeout/abort -> ambiguous', () => assert.strictEqual(outcome, 'ambiguous'));
  outcome = await classify(async () => { throw errWithCode('ENOTFOUND'); });
  check('DNS failure (ENOTFOUND) -> retryable (provably pre-transmission)', () =>
    assert.strictEqual(outcome, 'retryable'));
  outcome = await classify(async () => {
    const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e;
  });
  check('connection refused via error.cause -> retryable', () =>
    assert.strictEqual(outcome, 'retryable'));
  outcome = await classify(async () => { throw errWithCode('ECONNRESET'); });
  check('connection reset (ECONNRESET) -> ambiguous (may have transmitted)', () =>
    assert.strictEqual(outcome, 'ambiguous'));
  outcome = await classify(async () => { throw new Error('mystery'); });
  check('unknown fetch rejection -> ambiguous, never retryable by default', () =>
    assert.strictEqual(outcome, 'ambiguous'));

  // ---------- derive + dispatch + roll-up truth + idempotency ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) })); // only ask_1 due
  r = await wd.handler({});
  check('T-150 due: one ask_1 event, one telegram delivery to the driver chat', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(events().length, 1);
    assert.strictEqual(events()[0].event_type, 'driver_ready_ask_1');
    assert.strictEqual(events()[0].recipient_key, 'drv-a');
    assert.strictEqual(deliveries().length, 1);
    assert.strictEqual(deliveries()[0].channel, 'telegram');
    assert.strictEqual(deliveries()[0].target, 'chat-a');
    assert.deepStrictEqual(telegramChats(), ['chat-a']);
    const s = JSON.parse(r.body);
    assert.strictEqual(s.attempts, 1);
    assert.strictEqual(s.submitted, 1);
    assert.strictEqual(s.dbErrors, 0);
  });
  check('delivery truth: provider acceptance is submitted — no delivered state exists', () => {
    assert.strictEqual(deliveries()[0].state, 'submitted');
    assert.strictEqual(events()[0].state, 'submitted');
  });
  r = await wd.handler({});
  check('second sweep is idempotent: same one event, no second telegram', () => {
    assert.strictEqual(events().length, 1);
    assert.strictEqual(deliveries().length, 1);
    assert.strictEqual(fetchCalls.length, 1);
  });

  // ---------- chain collapse + at-risk stamp ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) })); // whole chain due
  r = await wd.handler({});
  check('T-105 with whole chain due: at_risk_at stamped on the booking', () => {
    assert.ok(state.bookings[0].at_risk_at, 'at_risk_at not stamped');
  });
  check('chain collapse: ask_1/ask_2 superseded, only urgent + admin events sent', () => {
    const byType = Object.fromEntries(events().map((e) => [e.event_type, e]));
    assert.strictEqual(byType.driver_ready_ask_1.state, 'suppressed');
    assert.strictEqual(byType.driver_ready_ask_1.suppress_reason, 'superseded');
    assert.strictEqual(byType.driver_ready_ask_2.state, 'suppressed');
    assert.strictEqual(byType.driver_ready_urgent.state, 'submitted');
    assert.strictEqual(byType.admin_ready_escalation.state, 'submitted');
    assert.strictEqual(byType.at_risk_mark.state, 'submitted');
    assert.strictEqual(fetchCalls.length, 3, 'never 3 driver pings in one invocation');
    assert.deepStrictEqual(telegramChats().sort(), ['admin-chat', 'admin-chat', 'chat-a']);
  });

  // ---------- at-risk stamped INDEPENDENTLY of Telegram ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) }));
  fetchBehavior = async () => { throw errWithCode('ECONNREFUSED'); }; // provably pre-transmission
  r = await wd.handler({});
  check('Telegram down: at_risk_at STILL stamped (DB is the truth, Telegram the alert)', () => {
    assert.ok(state.bookings[0].at_risk_at);
  });
  check('pre-transmission failures recorded as failed attempts; events stay in_delivery', () => {
    assert.ok(deliveries().length >= 1);
    deliveries().forEach((d) => assert.strictEqual(d.state, 'failed'));
    const urgent = events().find((e) => e.event_type === 'driver_ready_urgent');
    assert.strictEqual(urgent.state, 'in_delivery');
    const s = JSON.parse(r.body);
    assert.strictEqual(s.attempts, 3);
    assert.strictEqual(s.submitted, 0);
  });

  // ---------- ambiguous send is terminal: never automatically resent ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  fetchBehavior = async () => ({ ok: false, status: 500 }); // ambiguous
  r = await wd.handler({});
  check('5xx send: delivery ambiguous, event exhausted', () => {
    assert.strictEqual(deliveries().length, 1);
    assert.strictEqual(deliveries()[0].state, 'ambiguous');
    assert.strictEqual(events()[0].state, 'exhausted');
    assert.strictEqual(fetchCalls.length, 1);
  });
  fetchBehavior = async () => ({ ok: true, status: 200 }); // Telegram healthy again
  r = await wd.handler({});
  check('ambiguous delivery is NEVER automatically resent, even once healthy', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(deliveries().length, 1);
    assert.strictEqual(events()[0].state, 'exhausted');
  });

  // ---------- readiness suppression ----------
  freshState();
  const b3 = mkBooking({
    pickup_datetime: iso(100),
    driver_ready_at: iso(-30), driver_ready_by: 'drv-a', driver_ready_source: 'web'
  });
  state.bookings.push(b3);
  state.notification_events.push({
    id: 'ev-pre', booking_id: b3.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-10), not_after: b3.pickup_datetime
  });
  r = await wd.handler({});
  check('valid readiness kills the chain: pending ask suppressed, nothing sent, no at-risk', () => {
    assert.strictEqual(events().length, 1);
    assert.strictEqual(events()[0].state, 'suppressed');
    assert.strictEqual(events()[0].suppress_reason, 'driver_ready');
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(state.bookings[0].at_risk_at, null);
  });

  // ---------- readiness invalid on reassignment; recipient-keyed events ----------
  freshState();
  const b4 = mkBooking({
    pickup_datetime: iso(140),
    assigned_driver: 'drv-b',
    // readiness recorded by the OLD driver — invalid for drv-b
    driver_ready_at: iso(-60), driver_ready_by: 'drv-a', driver_ready_source: 'web'
  });
  state.bookings.push(b4);
  state.notification_events.push({
    id: 'ev-old', booking_id: b4.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-10), not_after: b4.pickup_datetime
  });
  r = await wd.handler({});
  check('reassignment: old driver events suppressed, NEW driver gets their own ask', () => {
    const old = events().find((e) => e.recipient_key === 'drv-a');
    const fresh = events().find((e) => e.recipient_key === 'drv-b');
    assert.strictEqual(old.state, 'suppressed');
    assert.strictEqual(old.suppress_reason, 'reassigned');
    assert.ok(fresh, 'replacement driver event missing');
    assert.strictEqual(fresh.event_type, 'driver_ready_ask_1');
    assert.strictEqual(fresh.state, 'submitted');
    assert.deepStrictEqual(telegramChats(), ['chat-b']);
  });

  // ---------- insert-as-claim: the unique constraint is the arbiter ----------
  freshState();
  const db = supabaseMock.createClient();
  state.notification_events.push({
    id: 'ev-race', booking_id: 'bk-x', event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'in_delivery',
    due_at: iso(-5), not_after: iso(60)
  });
  const cd1 = await notify.createDelivery(db, { id: 'ev-race' }, 'telegram', 'chat-a');
  check('first worker claims by creating the attempt row', () => {
    assert.ok(cd1.delivery);
    assert.strictEqual(cd1.delivery.attempt_no, 1);
    assert.strictEqual(cd1.delivery.state, 'claimed');
  });
  const dup = await db.from('notification_deliveries')
    .insert({ event_id: 'ev-race', channel: 'telegram', attempt_no: 1, state: 'claimed' })
    .select();
  check('racing duplicate insert loses on the unique constraint (23505)', () => {
    assert.ok(dup.error, 'duplicate insert must error');
    assert.strictEqual(dup.error.code, '23505');
    assert.strictEqual((dup.data || []).length, 0);
  });
  const cd2 = await notify.createDelivery(db, { id: 'ev-race' }, 'telegram', 'chat-a');
  check('second sequential worker sees the live claim and stands down', () => {
    assert.strictEqual(cd2.inFlight, true);
  });

  // ---------- expired claim -> ambiguous -> exhausted, never resent ----------
  freshState();
  const b5 = mkBooking({ pickup_datetime: iso(140) });
  state.bookings.push(b5);
  state.notification_events.push({
    id: 'ev-stale', booking_id: b5.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'in_delivery',
    due_at: iso(-10), not_after: b5.pickup_datetime
  });
  state.notification_deliveries.push({
    id: 'del-stale', event_id: 'ev-stale', channel: 'telegram', attempt_no: 1,
    state: 'claimed', claimed_at: iso(-5), target: 'chat-a'
  });
  r = await wd.handler({});
  check('crashed worker: expired claim -> ambiguous; event exhausted; NO resend', () => {
    const d = deliveries().find((x) => x.id === 'del-stale');
    assert.strictEqual(d.state, 'ambiguous');
    const ev = events().find((x) => x.id === 'ev-stale');
    assert.strictEqual(ev.state, 'exhausted');
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(deliveries().length, 1, 'ambiguous delivery must never spawn a resend');
  });

  // ---------- not_after: stale events suppressed, not sent ----------
  freshState();
  const b6 = mkBooking({ pickup_datetime: iso(-10) }); // pickup already passed
  state.bookings.push(b6);
  state.notification_events.push({
    id: 'ev-late', booking_id: b6.id, event_type: 'driver_ready_ask_2',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-145), not_after: b6.pickup_datetime
  });
  r = await wd.handler({});
  check('past not_after: event suppressed as expired, nothing sent', () => {
    const ev = events().find((x) => x.id === 'ev-late');
    assert.strictEqual(ev.state, 'suppressed');
    assert.strictEqual(ev.suppress_reason, 'expired');
    assert.strictEqual(fetchCalls.length, 0);
  });

  // ---------- attempt limit: failures still consume the cap ----------
  freshState();
  for (let i = 0; i < 20; i++) {
    state.bookings.push(mkBooking({ pickup_datetime: iso(140), assigned_driver: 'drv-a' }));
  }
  fetchBehavior = async () => ({ ok: false, status: 429 }); // every attempt fails retryable
  r = await wd.handler({});
  check('rapid failures stop at the attempt limit (attempts counted, not successes)', () => {
    const s = JSON.parse(r.body);
    assert.strictEqual(s.attempts, 15, 'MAX_ATTEMPTS must gate provider calls');
    assert.strictEqual(s.submitted, 0);
    assert.strictEqual(fetchCalls.length, 15);
    assert.strictEqual(r.statusCode, 200, 'provider failures are not DB failures');
  });

  // ---------- soft budget applies to the WHOLE run, not just dispatch ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) }));
  process.env.WATCHDOG_BUDGET_MS = '0';
  r = await wd.handler({});
  check('exhausted budget halts all phases after the sweep', () => {
    const s = JSON.parse(r.body);
    assert.strictEqual(s.budgetStopped, true);
    assert.strictEqual(s.swept, 1);
    assert.strictEqual(events().length, 0, 'derivation must respect the budget');
    assert.strictEqual(state.bookings[0].at_risk_at, null, 'at-risk loop must respect the budget');
    assert.strictEqual(fetchCalls.length, 0);
  });
  delete process.env.WATCHDOG_BUDGET_MS;

  // ---------- DB failures surface: never a clean run on broken writes ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) }));
  state.inject.push({ op: 'update', table: 'bookings', times: 1, skip: 0 });
  r = await wd.handler({});
  check('at-risk stamp failure: logged, counted, run reported as FAILED (500)', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.ok(JSON.parse(r.body).dbErrors >= 1);
    assert.strictEqual(state.bookings[0].at_risk_at, null);
  });

  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.inject.push({ op: 'select', table: 'notification_events', times: 99, skip: 0 });
  r = await wd.handler({});
  check('due-event load failure: 500, no dispatch guessing, nothing sent', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.ok(JSON.parse(r.body).dbErrors >= 1);
    assert.strictEqual(fetchCalls.length, 0);
  });

  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(600) })); // nothing due
  state.inject.push({ op: 'update', table: 'notification_deliveries', times: 1, skip: 0 });
  r = await wd.handler({});
  check('stale-claim recovery failure: surfaced as 500', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.ok(JSON.parse(r.body).dbErrors >= 1);
  });

  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.inject.push({ op: 'insert', table: 'notification_deliveries', times: 1, skip: 0 });
  r = await wd.handler({});
  check('createDelivery insert failure (non-23505): 500, event left intact, no send', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(deliveries().length, 0);
    assert.strictEqual(events()[0].state, 'in_delivery', 'event must not be condemned');
  });

  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  // skip:0 would hit stale recovery; skip past it so the injection lands
  // on finalizeDelivery after a successful send.
  state.inject.push({ op: 'update', table: 'notification_deliveries', times: 1, skip: 1 });
  r = await wd.handler({});
  check('finalizeDelivery failure after send: surfaced as 500, claim left for recovery', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(fetchCalls.length, 1, 'the send itself happened');
    assert.strictEqual(deliveries()[0].state, 'claimed',
      'unfinalized claim ages into ambiguous via stale recovery — never a blind resend');
  });

  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.inject.push({ op: 'update', table: 'notification_events', times: 99, skip: 0 });
  r = await wd.handler({});
  check('event-state update failure: 500 and NO send (unrecordable state = no send)', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(events()[0].state, 'pending');
  });

  // ---------- heartbeat truthfulness ----------
  const hbBooking = () => mkBooking({
    pickup_datetime: iso(10 * 60), // outside sweep (+3h), inside 24h heartbeat window
    driver_ready_at: iso(-30), driver_ready_by: 'drv-a', driver_ready_source: 'web'
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  r = await wd.handler({});
  check('heartbeat submitted: finalized to today, exactly one admin message', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].body.chat_id, 'admin-chat');
    assert.ok(/watchdog: alive/.test(fetchCalls[0].body.text));
    assert.strictEqual(heartbeatValue(), todayET());
  });
  r = await wd.handler({});
  check('same day, second invocation: silent', () => {
    assert.strictEqual(fetchCalls.length, 1);
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  fetchBehavior = async () => ({ ok: false, status: 400 }); // definitive failure
  r = await wd.handler({});
  check('heartbeat definite failure: day NOT consumed — eligible to retry', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(heartbeatValue(), `failed:${todayET()}`);
  });
  fetchBehavior = async () => ({ ok: true, status: 200 });
  r = await wd.handler({});
  check('heartbeat retry after failure: sends and finalizes today', () => {
    assert.strictEqual(fetchCalls.length, 2);
    assert.strictEqual(heartbeatValue(), todayET());
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  fetchBehavior = async () => { throw new Error('mystery'); }; // ambiguous
  r = await wd.handler({});
  check('heartbeat ambiguous: recorded as ambiguous, one attempt only', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(heartbeatValue(), `ambiguous:${todayET()}`);
  });
  fetchBehavior = async () => ({ ok: true, status: 200 });
  r = await wd.handler({});
  check('heartbeat ambiguous is never blindly resent', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(heartbeatValue(), `ambiguous:${todayET()}`);
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  state.system_state.push({
    key: 'last_heartbeat_date',
    value: `claimed:${todayET()}:${new Date().toISOString()}`
  });
  r = await wd.handler({});
  check('concurrent run: a fresh claim by another worker blocks a duplicate send', () => {
    assert.strictEqual(fetchCalls.length, 0);
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  state.system_state.push({
    key: 'last_heartbeat_date',
    value: `claimed:${todayET()}:${iso(-5)}`
  });
  r = await wd.handler({});
  check('crashed heartbeat worker: stale claim turns ambiguous, no resend', () => {
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(heartbeatValue(), `ambiguous:${todayET()}`);
  });

  freshState({ silenceHeartbeat: false }); // no bookings at all
  r = await wd.handler({});
  check('quiet day (no rides): no heartbeat — silence stays meaningful', () => {
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(heartbeatValue(), null);
  });

  // ---------- DST: due times are instant arithmetic, immune to fall-back ----------
  check('DST instant math: Nov 1 2026 6 PM EST pickup -> T-150 at 3:30 PM EST', () => {
    // 2026-11-01T23:00:00Z is 6:00 PM EST (after the 2026 fall-back).
    assert.strictEqual(
      notify.dueAtFor('2026-11-01T23:00:00.000Z', 150),
      '2026-11-01T20:30:00.000Z'
    );
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
