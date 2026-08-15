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
process.env.VAPID_PUBLIC_KEY = Buffer.alloc(65, 1).toString('base64url');
process.env.VAPID_PRIVATE_KEY = Buffer.alloc(32, 2).toString('base64url');
process.env.VAPID_SUBJECT = 'mailto:test@example.test';
delete process.env.WATCHDOG_DISABLED;
delete process.env.WATCHDOG_BUDGET_MS;
delete process.env.PUSH_DISABLED;

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
  order(col, opts) {
    this.orderCol = col;
    this.orderDesc = Boolean(opts && opts.ascending === false);
    return this;
  }
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
    // Race-simulation hook: lets a test mutate state "concurrently",
    // e.g. suppress an event between the dispatch refetch and the CAS.
    if (state.beforeOp) state.beforeOp(this.op, this.table, this);
    const failure = injectedFailure(this.op, this.table);
    if (failure) return { data: null, error: failure };
    const rows = state[this.table] || (state[this.table] = []);
    if (this.op === 'select') {
      let out = rows.filter((r) => this._match(r));
      if (this.orderCol) {
        const c = this.orderCol;
        const dir = this.orderDesc ? -1 : 1;
        out = out.slice().sort((a, b) => (a[c] < b[c] ? -dir : a[c] > b[c] ? dir : 0));
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

// ---------- web-push mock (planted like the supabase mock) ----------
let pushCalls = [];
let pushBehavior = async () => ({ statusCode: 201 }); // resolve = accepted
let vapidSetupError = null;
const webPushMock = {
  setVapidDetails() {
    if (vapidSetupError) throw vapidSetupError;
  },
  sendNotification: async (sub, payloadStr, opts) => {
    pushCalls.push({ endpoint: sub.endpoint, payload: JSON.parse(payloadStr), opts });
    return pushBehavior(sub, payloadStr, opts);
  }
};
const pushStatusError = (statusCode) => {
  const e = new Error(`push status ${statusCode}`);
  e.statusCode = statusCode;
  return e;
};

const repoRoot = path.resolve(__dirname, '..');
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };
const webPushPath = require.resolve('web-push', { paths: [repoRoot] });
require.cache[webPushPath] = { id: webPushPath, filename: webPushPath, loaded: true, exports: webPushMock };

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
    push_subscriptions: [],
    booking_releases: [],
    inject: [],
    beforeOp: null
  };
  fetchCalls = [];
  fetchBehavior = async () => ({ ok: true, status: 200 });
  pushCalls = [];
  pushBehavior = async () => ({ statusCode: 201 });
  vapidSetupError = null;
}

function mkSub(overrides) {
  return {
    id: `sub-${++idSeq}`,
    driver_id: 'drv-a',
    device_id: `dev-${idSeq}`,
    endpoint: `https://push.example/ep-${idSeq}`,
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    activated_at: iso(-60),
    last_success_at: null,
    disabled_at: null,
    disabled_reason: null,
    ...overrides
  };
}
function subs() { return state.push_subscriptions; }

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

  // ---------- lost event-state CAS: stale dispatch must stop ----------
  freshState();
  const bRace = mkBooking({ pickup_datetime: iso(140) });
  state.bookings.push(bRace);
  state.notification_events.push({
    id: 'ev-cas', booking_id: bRace.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-10), not_after: bRace.pickup_datetime
  });
  // "Concurrent worker": between the dispatch refetch (bookings
  // maybeSingle) and the in_delivery CAS, the event gets suppressed.
  state.beforeOp = (op, table, q) => {
    if (op === 'select' && table === 'bookings' && q.mode === 'maybeSingle') {
      const ev = state.notification_events.find((x) => x.id === 'ev-cas');
      if (ev) ev.state = 'suppressed';
      state.beforeOp = null;
    }
  };
  r = await wd.handler({});
  check('lost in_delivery CAS: concurrent suppression stops dispatch — no send, no delivery row', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(fetchCalls.length, 0, 'a stale reminder must never be sent');
    assert.strictEqual(deliveries().length, 0, 'no delivery row may be claimed');
    assert.strictEqual(events().find((x) => x.id === 'ev-cas').state, 'suppressed',
      'the concurrent decision stands');
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

  // ---------- sweep shape: lean query, no pending, no past confirmed ----------
  freshState();
  const capturedOr = [];
  state.beforeOp = (op, table, q) => {
    if (op === 'select' && table === 'bookings' && q.orExpr) capturedOr.push(q.orExpr);
  };
  const sweepFloor = new Date(Date.now() - 1000).toISOString();
  r = await wd.handler({});
  check('sweep excludes pending and past-confirmed rows; keeps active statuses', () => {
    assert.strictEqual(capturedOr.length, 1, 'exactly one bookings query on a quiet cycle');
    const expr = capturedOr[0];
    assert.ok(/and\(status\.eq\.confirmed,pickup_datetime\.gte\./.test(expr),
      'sweep must be confirmed-only with a lower time bound');
    assert.ok(!/pending/.test(expr), 'pending rows must never be swept');
    assert.ok(/status\.in\.\(on_the_way,arrived,in_progress\)/.test(expr),
      'active rides must stay in for suppression/recovery');
    const m = expr.match(/pickup_datetime\.gte\.([^,]+),/);
    assert.ok(m && m[1] >= sweepFloor,
      'lower bound must be now — past confirmed rows cannot need readiness reminders');
  });
  state.beforeOp = null;

  // ---------- in-dispatch DB failure stops the loop ----------
  freshState();
  const bFirst = mkBooking({ pickup_datetime: iso(139) });  // due earlier -> dispatched first
  const bSecond = mkBooking({ pickup_datetime: iso(141) }); // must never send
  state.bookings.push(bFirst, bSecond);
  // skip:0 would hit stale recovery; skip past it so the injection lands
  // on the FIRST event's finalizeDelivery, after its send.
  state.inject.push({ op: 'update', table: 'notification_deliveries', times: 1, skip: 1 });
  r = await wd.handler({});
  check('DB failure INSIDE dispatch: loop stops — the second event makes zero provider calls', () => {
    assert.strictEqual(r.statusCode, 500);
    const s = JSON.parse(r.body);
    assert.ok(s.dbErrors >= 1);
    assert.strictEqual(s.dispatchSkipped, true);
    assert.strictEqual(fetchCalls.length, 1,
      'the first send already happened; nothing may follow on a broken cycle');
    const evSecond = events().find((e) => e.booking_id === bSecond.id);
    assert.strictEqual(evSecond.state, 'pending', 'second event must be untouched');
    assert.strictEqual(deliveries().length, 1, 'no delivery row for the second event');
  });

  // ---------- heartbeat is truthful about the WHOLE cycle ----------
  freshState({ silenceHeartbeat: false });
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) })); // ride day + at-risk due
  state.inject.push({ op: 'update', table: 'bookings', times: 1, skip: 0 });
  r = await wd.handler({});
  check('at-risk DB failure on a ride day: NO green heartbeat, day not finalized, 500', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(fetchCalls.length, 0, 'a broken cycle must not claim to be alive');
    assert.strictEqual(heartbeatValue(), null, 'heartbeat day must stay claimable');
    assert.strictEqual(JSON.parse(r.body).dispatchSkipped, true);
  });
  r = await wd.handler({}); // injection consumed — next cycle is healthy
  check('next healthy cycle: heartbeat sends and finalizes; reminders resume', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(heartbeatValue(), todayET());
    // heartbeat + urgent + admin escalation + at-risk mark
    assert.strictEqual(fetchCalls.length, 4);
    assert.ok(state.bookings[0].at_risk_at, 'at-risk retried from database truth');
  });

  // ---------- budget expiring MID-RUN, inside chain collapse ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) })); // whole chain due
  {
    const realNow = Date.now;
    let clockOffset = 0;
    Date.now = () => realNow() + clockOffset;
    // Burn the whole budget the moment the FIRST superseded-suppression
    // executes — the collapse loop must stop before the next DB write and
    // dispatch must never start.
    state.beforeOp = (op, table, q) => {
      if (op === 'update' && table === 'notification_events' &&
          q.payload && q.payload.suppress_reason === 'superseded') {
        clockOffset = 60000;
        state.beforeOp = null;
      }
    };
    try {
      r = await wd.handler({});
    } finally {
      Date.now = realNow;
    }
  }
  check('budget expiring DURING chain collapse: loop stops, dispatch never starts', () => {
    const s = JSON.parse(r.body);
    assert.strictEqual(s.budgetStopped, true);
    assert.strictEqual(fetchCalls.length, 0);
    const byType = Object.fromEntries(events().map((e) => [e.event_type, e]));
    assert.strictEqual(byType.driver_ready_ask_1.state, 'suppressed'); // first collapse landed
    assert.strictEqual(byType.driver_ready_ask_2.state, 'pending',
      'collapse must stop mid-loop when the budget expires');
    assert.strictEqual(byType.driver_ready_urgent.state, 'pending');
  });

  // ---------- DB failures surface: never a clean run on broken writes ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(100) }));
  state.inject.push({ op: 'update', table: 'bookings', times: 1, skip: 0 });
  r = await wd.handler({});
  check('at-risk stamp failure: 500, nothing stored, ZERO sends, no false at-risk claim', () => {
    assert.strictEqual(r.statusCode, 500);
    const s = JSON.parse(r.body);
    assert.ok(s.dbErrors >= 1);
    assert.strictEqual(s.dispatchSkipped, true, 'a broken cycle must not talk to the outside world');
    assert.strictEqual(state.bookings[0].at_risk_at, null);
    assert.strictEqual(fetchCalls.length, 0, 'no message may claim state that was not stored');
    assert.ok(!events().some((e) => e.event_type === 'at_risk_mark'),
      'at_risk_mark must never derive from an unstamped booking');
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
  check('finalizeDelivery failure after send: 500, claim left for recovery, NO rollup', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(fetchCalls.length, 1, 'the send itself happened');
    assert.strictEqual(deliveries()[0].state, 'claimed',
      'unfinalized claim ages into ambiguous via stale recovery — never a blind resend');
    assert.strictEqual(events()[0].state, 'in_delivery',
      'unknown recorded truth: processing must stop before any rollup');
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
  check('heartbeat submitted: finalized to today, one message, COUNTED in the global cap', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].body.chat_id, 'admin-chat');
    assert.ok(/watchdog: alive/.test(fetchCalls[0].body.text));
    assert.strictEqual(heartbeatValue(), todayET());
    const s = JSON.parse(r.body);
    assert.strictEqual(s.attempts, 1, 'heartbeat must count in summary.attempts');
    assert.strictEqual(s.submitted, 1);
  });
  r = await wd.handler({});
  check('same day, second invocation: silent', () => {
    assert.strictEqual(fetchCalls.length, 1);
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  fetchBehavior = async () => ({ ok: false, status: 400 }); // definitive rejection
  r = await wd.handler({});
  check('heartbeat definitive 400: ONE provider call, terminal for the day', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(heartbeatValue(), `exhausted:${todayET()}`);
  });
  fetchBehavior = async () => ({ ok: true, status: 200 });
  for (let i = 0; i < 5; i++) r = await wd.handler({});
  check('misconfigured 400 never loops: still exactly one call after 5 more cycles', () => {
    assert.strictEqual(fetchCalls.length, 1, 'not 288 calls/day — one, then terminal');
    assert.strictEqual(heartbeatValue(), `exhausted:${todayET()}`);
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  fetchBehavior = async () => ({ ok: false, status: 429 }); // retryable throttle
  r = await wd.handler({});
  check('heartbeat retryable failure: bounded retry state failed:<date>:1', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(heartbeatValue(), `failed:${todayET()}:1`);
  });
  r = await wd.handler({});
  check('second retryable failure: failed:<date>:2', () => {
    assert.strictEqual(fetchCalls.length, 2);
    assert.strictEqual(heartbeatValue(), `failed:${todayET()}:2`);
  });
  r = await wd.handler({});
  check('third retryable failure hits the cap: exhausted for the day', () => {
    assert.strictEqual(fetchCalls.length, 3);
    assert.strictEqual(heartbeatValue(), `exhausted:${todayET()}`);
  });
  fetchBehavior = async () => ({ ok: true, status: 200 });
  r = await wd.handler({});
  check('after the retry cap: silent even once Telegram recovers', () => {
    assert.strictEqual(fetchCalls.length, 3);
  });

  freshState({ silenceHeartbeat: false });
  state.bookings.push(hbBooking());
  fetchBehavior = async () => ({ ok: false, status: 429 });
  r = await wd.handler({});
  fetchBehavior = async () => ({ ok: true, status: 200 });
  r = await wd.handler({});
  check('bounded retry succeeds within the cap: finalized to today', () => {
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

  // ============================================================
  // Driver PWA Push (this PR)
  // ============================================================

  // ---------- push-first happy path + TTL/Urgency/Topic/minimal payload ----------
  freshState();
  const bp1 = mkBooking({ pickup_datetime: iso(140) }); // only ask_1 due; deadline T-135 in ~5 min
  state.bookings.push(bp1);
  state.push_subscriptions.push(mkSub({ driver_id: 'drv-a' }));
  r = await wd.handler({});
  check('healthy subscription: ask_1 goes by PUSH — no Telegram, never both', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(pushCalls.length, 1);
    assert.strictEqual(fetchCalls.length, 0, 'Telegram must not fire alongside push');
    const d = deliveries()[0];
    assert.strictEqual(d.channel, 'webpush');
    assert.strictEqual(d.state, 'submitted');
    assert.strictEqual(d.failure_class, undefined, 'success carries no failure class');
    assert.strictEqual(d.target, subs()[0].id, 'target is the subscription ROW id, never the endpoint');
    assert.strictEqual(events()[0].state, 'submitted');
    assert.ok(subs()[0].last_success_at, 'health stamp recorded');
  });
  check('push carries absolute TTL, high urgency, per-booking topic, minimal payload', () => {
    const call = pushCalls[0];
    assert.strictEqual(call.opts.urgency, 'high');
    assert.ok(call.opts.TTL > 280 && call.opts.TTL <= 301,
      `ask_1 TTL must run to the T-135 deadline (~300s), got ${call.opts.TTL}`);
    assert.strictEqual(call.opts.topic, notify.readinessTopic(bp1));
    assert.strictEqual(call.payload.tag, call.opts.topic, 'notification tag matches the topic');
    assert.strictEqual(call.payload.rideId, bp1.id);
    assert.ok(!JSON.stringify(call.payload).includes('Pat'),
      'payload must never contain passenger details');
  });

  // ---------- 410: expired endpoint -> disable + Telegram fallback (6c order) ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  pushBehavior = async () => { throw pushStatusError(410); };
  r = await wd.handler({});
  check('410: delivery failed·expired_endpoint, subscription DISABLED, Telegram fallback same cycle', () => {
    assert.strictEqual(r.statusCode, 200);
    const push = deliveries().find((d) => d.channel === 'webpush');
    const tg = deliveries().find((d) => d.channel === 'telegram');
    assert.strictEqual(push.state, 'failed');
    assert.strictEqual(push.failure_class, 'expired_endpoint');
    assert.ok(subs()[0].disabled_at, '404/410 is the only disabling signal');
    assert.strictEqual(subs()[0].disabled_reason, 'expired');
    assert.ok(tg && tg.state === 'submitted', 'the reminder still arrives this cycle');
    assert.strictEqual(events()[0].state, 'submitted');
    const s = JSON.parse(r.body);
    assert.strictEqual(s.attempts, 2, 'fallback consumes a second provider attempt');
  });

  // ---------- 403: OUR VAPID config — subscription KEPT + fallback ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  pushBehavior = async () => { throw pushStatusError(403); };
  r = await wd.handler({});
  check('403: vapid_config — subscription NOT disabled, Telegram fallback arrives', () => {
    const push = deliveries().find((d) => d.channel === 'webpush');
    assert.strictEqual(push.failure_class, 'vapid_config');
    assert.strictEqual(subs()[0].disabled_at, null, '401/403 must never disable a subscription');
    const tg = deliveries().find((d) => d.channel === 'telegram');
    assert.ok(tg && tg.state === 'submitted');
  });

  // ---------- other 4xx: provider_rejected -> fallback ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  pushBehavior = async () => { throw pushStatusError(418); };
  r = await wd.handler({});
  check('other 4xx: provider_rejected — definitive, subscription kept, fallback sent', () => {
    const push = deliveries().find((d) => d.channel === 'webpush');
    assert.strictEqual(push.failure_class, 'provider_rejected');
    assert.strictEqual(subs()[0].disabled_at, null);
    assert.ok(deliveries().some((d) => d.channel === 'telegram' && d.state === 'submitted'));
  });

  // ---------- 5xx: ambiguous — terminal, NO fallback ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  pushBehavior = async () => { throw pushStatusError(503); };
  r = await wd.handler({});
  check('5xx push: ambiguous — event exhausted, NO Telegram (duplicate risk), sub kept', () => {
    const push = deliveries().find((d) => d.channel === 'webpush');
    assert.strictEqual(push.state, 'ambiguous');
    assert.strictEqual(push.failure_class, 'ambiguous');
    assert.strictEqual(fetchCalls.length, 0, 'no fallback after a maybe-delivered push');
    assert.strictEqual(events()[0].state, 'exhausted');
    assert.strictEqual(subs()[0].disabled_at, null);
  });

  // ---------- 429: throttled — same-channel retry next cycle ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  pushBehavior = async () => { throw pushStatusError(429); };
  r = await wd.handler({});
  check('429: throttled — retryable on the SAME channel, no fallback', () => {
    const push = deliveries().find((d) => d.channel === 'webpush');
    assert.strictEqual(push.state, 'failed');
    assert.strictEqual(push.failure_class, 'throttled');
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(events()[0].state, 'in_delivery');
  });
  pushBehavior = async () => ({ statusCode: 201 });
  r = await wd.handler({});
  check('next cycle retries Push (attempt 2) and succeeds — never switched channels', () => {
    assert.strictEqual(pushCalls.length, 2);
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(events()[0].state, 'submitted');
    assert.strictEqual(deliveries().filter((d) => d.channel === 'webpush').length, 2);
  });

  // ---------- restart-safe fallback continuation (precedence rule 4) ----------
  freshState();
  const bCont = mkBooking({ pickup_datetime: iso(140) });
  state.bookings.push(bCont);
  state.push_subscriptions.push(mkSub()); // healthy sub present — rule 4 must still win
  state.notification_events.push({
    id: 'ev-cont', booking_id: bCont.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'in_delivery',
    due_at: iso(-10), not_after: bCont.pickup_datetime
  });
  state.notification_deliveries.push({
    id: 'del-cont', event_id: 'ev-cont', channel: 'webpush', attempt_no: 1,
    state: 'failed', failure_class: 'expired_endpoint', claimed_at: iso(-6),
    finalized_at: iso(-6), target: 'sub-old'
  });
  r = await wd.handler({});
  check('crash healed from stored truth: definitive push history -> Telegram fallback, no new push', () => {
    assert.strictEqual(pushCalls.length, 0, 'rule 4 outranks the healthy subscription');
    assert.strictEqual(fetchCalls.length, 1);
    const tg = deliveries().find((d) => d.channel === 'telegram');
    assert.ok(tg && tg.state === 'submitted');
    assert.strictEqual(events().find((e) => e.id === 'ev-cont').state, 'submitted');
  });

  // ---------- telegram history precedence (rule 3): never back to Push ----------
  freshState();
  const bTg = mkBooking({ pickup_datetime: iso(140) });
  state.bookings.push(bTg);
  state.push_subscriptions.push(mkSub()); // healthy sub must NOT recapture the event
  state.notification_events.push({
    id: 'ev-tg', booking_id: bTg.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'in_delivery',
    due_at: iso(-10), not_after: bTg.pickup_datetime
  });
  state.notification_deliveries.push({
    id: 'del-tg', event_id: 'ev-tg', channel: 'telegram', attempt_no: 1,
    state: 'failed', claimed_at: iso(-6), finalized_at: iso(-6), target: 'chat-a'
  });
  r = await wd.handler({});
  check('once fallback began, the event NEVER returns to Push (telegram retry only)', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(deliveries().filter((d) => d.channel === 'telegram').length, 2);
    assert.strictEqual(events().find((e) => e.id === 'ev-tg').state, 'submitted');
  });

  // ---------- activated_at device selection ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(
    mkSub({ endpoint: 'https://push.example/OLD', activated_at: iso(-600), last_success_at: iso(-5) }),
    mkSub({ endpoint: 'https://push.example/NEW', activated_at: iso(-1), last_success_at: null })
  );
  r = await wd.handler({});
  check('device selection: newest activated_at wins — an old phone with successes cannot pin', () => {
    assert.strictEqual(pushCalls.length, 1);
    assert.strictEqual(pushCalls[0].endpoint, 'https://push.example/NEW');
  });

  // ---------- absolute deadline passed: suppressed, zero provider calls ----------
  freshState();
  const bLate = mkBooking({ pickup_datetime: iso(130) }); // ask_1 deadline (T-135) already passed
  state.bookings.push(bLate);
  state.push_subscriptions.push(mkSub());
  state.notification_events.push({
    id: 'ev-late-ask2', booking_id: bLate.id, event_type: 'driver_ready_ask_2',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'submitted',
    due_at: iso(-5), not_after: bLate.pickup_datetime
  }); // ask_2 already ran -> collapse can't supersede ask_1; the deadline guard must
  r = await wd.handler({});
  check('passed escalation deadline: stale ask suppressed with ZERO provider calls', () => {
    const ask1 = events().find((e) => e.event_type === 'driver_ready_ask_1');
    assert.strictEqual(ask1.state, 'suppressed');
    assert.strictEqual(ask1.suppress_reason, 'stale_deadline');
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 0);
  });

  // ---------- PUSH_DISABLED kill switch ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  process.env.PUSH_DISABLED = '1';
  r = await wd.handler({});
  check('PUSH_DISABLED: healthy subscription ignored, Telegram carries the reminder', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(deliveries()[0].channel, 'telegram');
  });
  delete process.env.PUSH_DISABLED;

  // ---------- 6c database-safe ordering: DB failure stops before fallback ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  pushBehavior = async () => { throw pushStatusError(410); };
  state.inject.push({ op: 'update', table: 'push_subscriptions', times: 1, skip: 0 });
  r = await wd.handler({});
  check('6c: disable-step DB failure -> 500, NO fallback provider call after it', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(fetchCalls.length, 0, 'no Telegram after a broken sequence');
    const push = deliveries().find((d) => d.channel === 'webpush');
    assert.strictEqual(push.failure_class, 'expired_endpoint', 'step 1 persisted before the stop');
    assert.strictEqual(subs()[0].disabled_at, null, 'disable failed — recovered next cycle');
  });
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  pushBehavior = async () => { throw pushStatusError(410); };
  // skip:0 would hit stale recovery; land the failure on the finalize step
  state.inject.push({ op: 'update', table: 'notification_deliveries', times: 1, skip: 1 });
  r = await wd.handler({});
  check('6c: finalize-step DB failure -> 500, no disable, no fallback', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(subs()[0].disabled_at, null);
    assert.strictEqual(fetchCalls.length, 0);
  });
  pushBehavior = async () => ({ statusCode: 201 });

  // ---------- provider cap can never strand a claimed fallback ----------
  freshState();
  for (let i = 0; i < 14; i++) {
    state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  }
  const bCap = mkBooking({ pickup_datetime: iso(141) }); // due LAST -> dispatched 15th
  state.bookings.push(bCap);
  state.push_subscriptions.push(mkSub());
  let pushCount = 0;
  pushBehavior = async () => {
    pushCount++;
    if (pushCount === 15) throw pushStatusError(410); // the 15th call fails definitively
    return { statusCode: 201 };
  };
  r = await wd.handler({});
  check('cap boundary: push fails as call 15 -> NO telegram claim is created', () => {
    const s = JSON.parse(r.body);
    assert.strictEqual(s.attempts, 15);
    assert.strictEqual(fetchCalls.length, 0, 'no telegram call past the cap');
    const capEv = events().find((e) => e.booking_id === bCap.id);
    const rows = deliveries().filter((d) => d.event_id === capEv.id);
    assert.strictEqual(rows.length, 1, 'a claimed-but-never-sent fallback row must not exist');
    assert.strictEqual(rows[0].channel, 'webpush');
    assert.strictEqual(rows[0].failure_class, 'expired_endpoint');
    assert.strictEqual(capEv.state, 'in_delivery');
  });
  pushBehavior = async () => ({ statusCode: 201 });
  r = await wd.handler({});
  check('next cycle: routing rule 4 sends the Telegram fallback cleanly', () => {
    const capEv = events().find((e) => e.booking_id === bCap.id);
    assert.strictEqual(capEv.state, 'submitted');
    const tg = deliveries().find((d) => d.event_id === capEv.id && d.channel === 'telegram');
    assert.ok(tg && tg.state === 'submitted');
    assert.strictEqual(fetchCalls.length, 1);
  });

  // ---------- finalization failures stop EVERY outcome branch ----------
  // (inject: skip stale-recovery's deliveries-update, fail the finalize)
  const finalizeStopScenario = async ({ push, behavior }) => {
    freshState();
    state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
    if (push) state.push_subscriptions.push(mkSub());
    if (push) pushBehavior = behavior; else fetchBehavior = behavior;
    state.inject.push({ op: 'update', table: 'notification_deliveries', times: 1, skip: 1 });
    const res = await wd.handler({});
    pushBehavior = async () => ({ statusCode: 201 });
    fetchBehavior = async () => ({ ok: true, status: 200 });
    return res;
  };
  r = await finalizeStopScenario({ push: true, behavior: async () => ({ statusCode: 201 }) });
  check('push SUBMITTED finalize failure: 500, no health stamp, no rollup', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(deliveries()[0].state, 'claimed');
    assert.strictEqual(subs()[0].last_success_at, null, 'health stamp must not run');
    assert.strictEqual(events()[0].state, 'in_delivery');
  });
  r = await finalizeStopScenario({ push: true, behavior: async () => { throw pushStatusError(503); } });
  check('push AMBIGUOUS finalize failure: 500, event NOT exhausted yet', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(deliveries()[0].state, 'claimed');
    assert.strictEqual(events()[0].state, 'in_delivery');
  });
  r = await finalizeStopScenario({ push: true, behavior: async () => { throw pushStatusError(429); } });
  check('push RETRYABLE finalize failure: 500, stop before any further write', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(deliveries()[0].state, 'claimed');
    assert.strictEqual(events()[0].state, 'in_delivery');
  });
  r = await finalizeStopScenario({ push: false, behavior: async () => ({ ok: false, status: 502 }) });
  check('telegram AMBIGUOUS finalize failure: 500, event NOT exhausted yet', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(deliveries()[0].state, 'claimed');
    assert.strictEqual(events()[0].state, 'in_delivery');
  });
  r = await finalizeStopScenario({ push: false, behavior: async () => ({ ok: false, status: 400 }) });
  check('telegram DEFINITIVE finalize failure: 500, event NOT exhausted yet', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(events()[0].state, 'in_delivery');
  });
  r = await finalizeStopScenario({ push: false, behavior: async () => ({ ok: false, status: 429 }) });
  check('telegram RETRYABLE finalize failure: 500, stop before any further write', () => {
    assert.strictEqual(r.statusCode, 500);
    assert.strictEqual(events()[0].state, 'in_delivery');
  });

  // ---------- VAPID_SUBJECT is REQUIRED — no fake fallback subject ----------
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  const savedSubject = process.env.VAPID_SUBJECT;
  delete process.env.VAPID_SUBJECT;
  r = await wd.handler({});
  check('missing VAPID_SUBJECT: push not configured -> Telegram fallback, zero push calls', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(deliveries()[0].channel, 'telegram');
  });
  process.env.VAPID_SUBJECT = 'not-a-mailto';
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  r = await wd.handler({});
  check('malformed VAPID_SUBJECT: also Telegram fallback', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 1);
  });
  process.env.VAPID_SUBJECT = savedSubject;

  // ---------- canonical VAPID validation: corrupt non-empty config
  // never consumes the Push path or suppresses the Telegram safety net ----------
  const validPublic = process.env.VAPID_PUBLIC_KEY;
  const validPrivate = process.env.VAPID_PRIVATE_KEY;
  const validSubject = process.env.VAPID_SUBJECT;

  process.env.VAPID_PUBLIC_KEY = 'truncated-but-nonempty';
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  r = await wd.handler({});
  check('truncated VAPID public key: Telegram fallback, zero push calls', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(deliveries()[0].channel, 'telegram');
  });

  process.env.VAPID_PUBLIC_KEY = validPublic;
  process.env.VAPID_PRIVATE_KEY = 'also-truncated';
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  r = await wd.handler({});
  check('truncated VAPID private key: Telegram fallback, zero push calls', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 1);
  });

  process.env.VAPID_PRIVATE_KEY = validPrivate;
  process.env.VAPID_SUBJECT = 'https://';
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  r = await wd.handler({});
  check('prefix-valid but invalid VAPID subject: Telegram fallback', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 1);
  });

  process.env.VAPID_SUBJECT = validSubject;
  freshState();
  state.bookings.push(mkBooking({ pickup_datetime: iso(140) }));
  state.push_subscriptions.push(mkSub());
  vapidSetupError = new Error('library rejected VAPID locally');
  r = await wd.handler({});
  check('local setVapidDetails rejection: definitive vapid_config + Telegram fallback', () => {
    assert.strictEqual(pushCalls.length, 0, 'provider send was never attempted');
    assert.strictEqual(fetchCalls.length, 1, 'Telegram safety net carries the event');
    const push = deliveries().find((d) => d.channel === 'webpush');
    assert.strictEqual(push.failure_class, 'vapid_config');
    assert.ok(deliveries().some((d) => d.channel === 'telegram' && d.state === 'submitted'));
  });
  vapidSetupError = null;
  process.env.VAPID_PUBLIC_KEY = validPublic;
  process.env.VAPID_PRIVATE_KEY = validPrivate;
  process.env.VAPID_SUBJECT = validSubject;

  // ---------- DST: due times are instant arithmetic, immune to fall-back ----------
  check('DST instant math: Nov 1 2026 6 PM EST pickup -> T-150 at 3:30 PM EST', () => {
    // 2026-11-01T23:00:00Z is 6:00 PM EST (after the 2026 fall-back).
    assert.strictEqual(
      notify.dueAtFor('2026-11-01T23:00:00.000Z', 150),
      '2026-11-01T20:30:00.000Z'
    );
  });

  // ---------- PR 1A: ride_cancelled_admin outbox events (behavioral) ----------
  // The migration-013 trigger is the producer; here its row is injected
  // directly and the REAL dispatch loop must (a) deliver it for a
  // cancelled booking with the stamped audit text, (b) suppress it with
  // zero provider calls when the live row is not actually cancelled.
  freshState();
  const cxlBooking = mkBooking({
    status: 'cancelled',
    trip_id: 'LM-HXA5',
    assigned_driver: null,
    cancelled_from_status: 'pending',
    cancelled_at: iso(-1),
    cancel_fee_percent: 0,
    cancel_fee_policy_amount: 0,
    cancel_fee_collected: 0
  });
  state.bookings.push(cxlBooking);
  state.notification_events.push({
    id: 'ev-cxl-1', booking_id: cxlBooking.id, event_type: 'ride_cancelled_admin',
    recipient_role: 'admin', recipient_key: 'admin', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('cancelled booking: admin outbox event dispatches via Telegram with withdrawal copy', () => {
    assert.strictEqual(fetchCalls.length, 1, 'exactly one Telegram send');
    assert.strictEqual(telegramChats()[0], 'admin-chat', 'admin events are Telegram-only to the admin chat');
    assert.ok(fetchCalls[0].body.text.includes('withdrawn'), 'pending variant renders the withdrawal copy');
    assert.ok(fetchCalls[0].body.text.includes('LM-HXA5'));
    const ev = events().find((e) => e.id === 'ev-cxl-1');
    assert.strictEqual(ev.state, 'submitted');
  });

  freshState();
  const liveBooking = mkBooking({ status: 'pending', assigned_driver: null, pickup_datetime: iso(500) });
  state.bookings.push(liveBooking);
  state.notification_events.push({
    id: 'ev-cxl-2', booking_id: liveBooking.id, event_type: 'ride_cancelled_admin',
    recipient_role: 'admin', recipient_key: 'admin', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('NOT-cancelled booking: cancellation event suppressed not_cancelled, zero sends', () => {
    assert.strictEqual(fetchCalls.length, 0, 'no provider call may claim a cancellation that is not DB truth');
    const ev = events().find((e) => e.id === 'ev-cxl-2');
    assert.strictEqual(ev.state, 'suppressed');
    assert.strictEqual(ev.suppress_reason, 'not_cancelled');
  });

  // ---- PR 3B: driver ride_cancelled through the REAL dispatch loop ----
  freshState();
  const cxlDriverBooking = mkBooking({
    status: 'cancelled', trip_id: 'LM-STOP', assigned_driver: 'drv-a',
    cancelled_from_status: 'on_the_way', cancelled_at: iso(-1)
  });
  state.bookings.push(cxlDriverBooking);
  state.push_subscriptions.push(mkSub());
  state.notification_events.push({
    id: 'ev-stop-1', booking_id: cxlDriverBooking.id, event_type: 'ride_cancelled',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('driver stop-notice routes PUSH-first: honest copy, no rideId deep link, readiness tag reuse', () => {
    assert.strictEqual(pushCalls.length, 1, 'push-first like every driver event');
    assert.ok(pushCalls[0].payload.body.includes('Do not proceed'));
    assert.ok(!('rideId' in pushCalls[0].payload), 'click must open the general driver page');
    assert.strictEqual(pushCalls[0].payload.tag, notify.readinessTopic(cxlDriverBooking),
      'replaces a queued stale readiness banner');
    assert.strictEqual(fetchCalls.length, 0, 'never both channels');
    const ev = events().find((e) => e.id === 'ev-stop-1');
    assert.strictEqual(ev.state, 'submitted');
  });

  freshState();
  state.drivers.push({ id: 'drv-nochat', name: 'NoChat', telegram_chat_id: null });
  const cxlDedupBooking = mkBooking({
    status: 'cancelled', trip_id: 'LM-DEDUP', assigned_driver: 'drv-nochat',
    cancelled_from_status: 'confirmed', cancelled_at: iso(-1)
  });
  state.bookings.push(cxlDedupBooking);
  state.notification_events.push({
    id: 'ev-stop-2', booking_id: cxlDedupBooking.id, event_type: 'ride_cancelled',
    recipient_role: 'driver', recipient_key: 'drv-nochat', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('duplicate_target: no push device + no distinct driver chat -> suppressed, zero sends (admin event owns that chat)', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 0, 'the admin chat must not receive the same news twice');
    const ev = events().find((e) => e.id === 'ev-stop-2');
    assert.strictEqual(ev.state, 'suppressed');
    assert.strictEqual(ev.suppress_reason, 'duplicate_target');
  });

  freshState();
  const cxlChatBooking = mkBooking({
    status: 'cancelled', trip_id: 'LM-CHAT', assigned_driver: 'drv-a',
    cancelled_from_status: 'confirmed', cancelled_at: iso(-1)
  });
  state.bookings.push(cxlChatBooking);
  state.notification_events.push({
    id: 'ev-stop-3', booking_id: cxlChatBooking.id, event_type: 'ride_cancelled',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('distinct driver chat proceeds on the Telegram fallback with the stop copy', () => {
    assert.strictEqual(pushCalls.length, 0, 'no subscription on file');
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(telegramChats()[0], 'chat-a', 'the DRIVER\'s own chat, not the admin\'s');
    assert.ok(fetchCalls[0].body.text.includes('Do not proceed'));
    const ev = events().find((e) => e.id === 'ev-stop-3');
    assert.strictEqual(ev.state, 'submitted');
  });

  // ---- PR 3B review corrections: the stop notice answers to the STORED
  // recipient_key (driver-at-cancellation), never the live row's
  // assigned_driver — a manual clear or reassignment of the cancelled
  // row must neither silence nor redirect it.
  freshState();
  const cxlClearedBooking = mkBooking({
    status: 'cancelled', trip_id: 'LM-CLEAR', assigned_driver: null,
    cancelled_from_status: 'confirmed', cancelled_at: iso(-1)
  });
  state.bookings.push(cxlClearedBooking);
  state.push_subscriptions.push(mkSub()); // drv-a's installed device
  state.notification_events.push({
    id: 'ev-stop-4', booking_id: cxlClearedBooking.id, event_type: 'ride_cancelled',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('stop notice keyed to driver A survives a cleared assigned_driver: push to A, never duplicate_target', () => {
    assert.strictEqual(pushCalls.length, 1, 'recipient_key selects the push device');
    assert.strictEqual(pushCalls[0].endpoint, subs()[0].endpoint, 'driver A\'s own device');
    assert.strictEqual(fetchCalls.length, 0, 'no Telegram, no admin-chat misroute');
    const ev = events().find((e) => e.id === 'ev-stop-4');
    assert.strictEqual(ev.state, 'submitted');
  });

  freshState();
  const cxlSwappedBooking = mkBooking({
    status: 'cancelled', trip_id: 'LM-SWAP', assigned_driver: 'drv-b',
    cancelled_from_status: 'on_the_way', cancelled_at: iso(-1)
  });
  state.bookings.push(cxlSwappedBooking);
  state.notification_events.push({
    id: 'ev-stop-5', booking_id: cxlSwappedBooking.id, event_type: 'ride_cancelled',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('stop notice keyed to driver A with the row swapped to driver B: A\'s chat, never B\'s', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(telegramChats()[0], 'chat-a', 'the driver who committed, not the current column value');
    assert.ok(fetchCalls[0].body.text.includes('Do not proceed'));
    const ev = events().find((e) => e.id === 'ev-stop-5');
    assert.strictEqual(ev.state, 'submitted');
  });

  // A drivers-table failure during the dedup lookup must NEVER become a
  // terminal duplicate_target — the driver may have a distinct chat the
  // failed read couldn't see. Fail closed, stay recoverable, deliver on
  // the next healed cycle.
  freshState();
  const cxlLookupBooking = mkBooking({
    status: 'cancelled', trip_id: 'LM-LOOKUP', assigned_driver: 'drv-a',
    cancelled_from_status: 'confirmed', cancelled_at: iso(-1)
  });
  state.bookings.push(cxlLookupBooking);
  state.notification_events.push({
    id: 'ev-stop-6', booking_id: cxlLookupBooking.id, event_type: 'ride_cancelled',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  state.inject.push({ op: 'select', table: 'drivers', times: 1, skip: 0 });
  r = await wd.handler({});
  check('drivers lookup failure during dedup: surfaced dbError, zero sends, event stays recoverable — never duplicate_target', () => {
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(pushCalls.length, 0);
    assert.ok(JSON.parse(r.body).dbErrors >= 1, 'the failure is surfaced, not swallowed');
    const ev = events().find((e) => e.id === 'ev-stop-6');
    assert.strictEqual(ev.state, 'pending', 'unknown truth must not decide the event');
    assert.strictEqual(ev.suppress_reason, null);
  });

  r = await wd.handler({});
  check('healed lookup: the SAME event now delivers to the driver\'s own chat', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(telegramChats()[0], 'chat-a');
    assert.ok(fetchCalls[0].body.text.includes('Do not proceed'));
    const ev = events().find((e) => e.id === 'ev-stop-6');
    assert.strictEqual(ev.state, 'submitted');
  });

  // ---- PR 3C-1: ride_released through the REAL dispatch loop ----
  // The booking_releases row is the notification source: renderEvent
  // reads its SNAPSHOTS (pickup/name/reason at release), never the live
  // booking's mutable pickup — a released booking is pending again and
  // EDITABLE, so the live row must never re-classify the release.
  function mkRelease(overrides) {
    return {
      id: `rel-${++idSeq}`,
      booking_id: 'set-me',
      driver_id: 'drv-a',
      details_version_at_release: 1,
      pickup_at_release: iso(300),
      price_at_release: 55,
      driver_name_at_release: 'Andres',
      reason: 'schedule_conflict',
      note: null,
      released_at: iso(-1),
      ...overrides
    };
  }
  function mkReleasedEvent(bookingId, driverId, id) {
    return {
      id, booking_id: bookingId, event_type: 'ride_released',
      recipient_role: 'admin', recipient_key: driverId, state: 'pending',
      due_at: iso(-1), not_after: iso(300), suppress_reason: null
    };
  }

  freshState();
  const relBooking = mkBooking({
    status: 'pending', trip_id: 'LM-REL', assigned_driver: null,
    pickup_datetime: iso(300)
  });
  state.bookings.push(relBooking);
  state.booking_releases.push(mkRelease({ booking_id: relBooking.id, pickup_at_release: iso(300) }));
  state.notification_events.push(mkReleasedEvent(relBooking.id, 'drv-a', 'ev-rel-1'));
  r = await wd.handler({});
  check('ride_released: admin chat gets driver name, reason, SNAPSHOT pickup; event submitted end-to-end', () => {
    assert.strictEqual(fetchCalls.length, 1, 'exactly one Telegram send');
    assert.strictEqual(telegramChats()[0], 'admin-chat', 'admin events are Telegram-only');
    const text = fetchCalls[0].body.text;
    assert.ok(text.includes('LM-REL'));
    assert.ok(text.includes('RELEASED by Andres'));
    assert.ok(text.includes('schedule conflict'));
    assert.ok(!text.includes('🚨'), 'a 5-hour-out snapshot is not urgent');
    const ev = events().find((e) => e.id === 'ev-rel-1');
    assert.strictEqual(ev.state, 'submitted', 'submitted pins the extra-threading end-to-end');
  });

  freshState();
  const relUrgentBooking = mkBooking({
    status: 'pending', trip_id: 'LM-URG', assigned_driver: null,
    pickup_datetime: iso(7 * 24 * 60) // live pickup EDITED a week out post-release
  });
  state.bookings.push(relUrgentBooking);
  state.booking_releases.push(mkRelease({
    booking_id: relUrgentBooking.id, pickup_at_release: iso(45) // snapshot: 45 min away
  }));
  state.notification_events.push(mkReleasedEvent(relUrgentBooking.id, 'drv-a', 'ev-rel-2'));
  r = await wd.handler({});
  check('URGENT comes from the IMMUTABLE snapshot — a post-release pickup edit never de-classifies it', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].body.text.includes('🚨 URGENT'), 'snapshot <2h -> urgent');
    const ev = events().find((e) => e.id === 'ev-rel-2');
    assert.strictEqual(ev.state, 'submitted');
  });

  freshState();
  const relFailBooking = mkBooking({ status: 'pending', assigned_driver: null, pickup_datetime: iso(300) });
  state.bookings.push(relFailBooking);
  state.booking_releases.push(mkRelease({ booking_id: relFailBooking.id }));
  state.notification_events.push(mkReleasedEvent(relFailBooking.id, 'drv-a', 'ev-rel-3'));
  state.inject.push({ op: 'select', table: 'booking_releases', times: 1, skip: 0 });
  r = await wd.handler({});
  check('enrichment read failure: surfaced dbError, zero sends, event stays recoverable', () => {
    assert.strictEqual(fetchCalls.length, 0);
    assert.ok(JSON.parse(r.body).dbErrors >= 1);
    const ev = events().find((e) => e.id === 'ev-rel-3');
    assert.strictEqual(ev.state, 'pending', 'fail-closed: unknown truth never decides the event');
  });
  r = await wd.handler({});
  check('healed enrichment: the SAME release event delivers', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(telegramChats()[0], 'admin-chat');
    const ev = events().find((e) => e.id === 'ev-rel-3');
    assert.strictEqual(ev.state, 'submitted');
  });

  freshState();
  const relMissingBooking = mkBooking({ status: 'pending', assigned_driver: null, pickup_datetime: iso(300) });
  state.bookings.push(relMissingBooking);
  // No booking_releases row: only manual tampering can produce this.
  state.notification_events.push(mkReleasedEvent(relMissingBooking.id, 'drv-a', 'ev-rel-4'));
  r = await wd.handler({});
  check('missing release row: suppressed release_missing, zero provider calls', () => {
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(pushCalls.length, 0);
    const ev = events().find((e) => e.id === 'ev-rel-4');
    assert.strictEqual(ev.state, 'suppressed');
    assert.strictEqual(ev.suppress_reason, 'release_missing');
  });

  // ---- stale readiness suppression around a release ----
  freshState();
  const relStaleBooking = mkBooking({
    status: 'pending', assigned_driver: null, pickup_datetime: iso(140)
  });
  state.bookings.push(relStaleBooking);
  state.booking_releases.push(mkRelease({ booking_id: relStaleBooking.id }));
  // Exactly ONE stale ask (several would chain-collapse to 'superseded').
  state.notification_events.push({
    id: 'ev-stale-ask', booking_id: relStaleBooking.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(140), suppress_reason: null
  });
  r = await wd.handler({});
  check('released booking\'s stale readiness ask: suppressed driver_active (the shipped non-confirmed reason), zero sends to A', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 0, 'no release event queued here — the ask alone must die silently');
    const ev = events().find((e) => e.id === 'ev-stale-ask');
    assert.strictEqual(ev.state, 'suppressed');
    assert.strictEqual(ev.suppress_reason, 'driver_active');
  });

  freshState();
  const relReacceptBooking = mkBooking({
    status: 'confirmed', assigned_driver: 'drv-b', pickup_datetime: iso(140),
    driver_ready_at: iso(-1), driver_ready_by: 'drv-b', driver_ready_source: 'recent_accept'
  });
  state.bookings.push(relReacceptBooking);
  state.booking_releases.push(mkRelease({ booking_id: relReacceptBooking.id }));
  state.notification_events.push({
    id: 'ev-stale-ask-2', booking_id: relReacceptBooking.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(140), suppress_reason: null
  });
  r = await wd.handler({});
  check('release -> B re-accepts inside T-180: A\'s stale ask dies via the READINESS gate (driver_ready)', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 0);
    const ev = events().find((e) => e.id === 'ev-stale-ask-2');
    assert.strictEqual(ev.state, 'suppressed');
    assert.strictEqual(ev.suppress_reason, 'driver_ready');
  });

  freshState();
  const relEarlyBooking = mkBooking({
    status: 'confirmed', assigned_driver: 'drv-b', pickup_datetime: iso(300),
    driver_ready_at: null, driver_ready_by: null, driver_ready_source: null
  });
  state.bookings.push(relEarlyBooking);
  state.booking_releases.push(mkRelease({ booking_id: relEarlyBooking.id }));
  state.notification_events.push({
    id: 'ev-stale-ask-3', booking_id: relEarlyBooking.id, event_type: 'driver_ready_ask_1',
    recipient_role: 'driver', recipient_key: 'drv-a', state: 'pending',
    due_at: iso(-1), not_after: iso(300), suppress_reason: null
  });
  r = await wd.handler({});
  check('release -> B re-accepted early (no readiness): A\'s ask retired as reassigned (the backstop)', () => {
    assert.strictEqual(pushCalls.length, 0);
    assert.strictEqual(fetchCalls.length, 0);
    const ev = events().find((e) => e.id === 'ev-stale-ask-3');
    assert.strictEqual(ev.state, 'suppressed');
    assert.strictEqual(ev.suppress_reason, 'reassigned');
  });

  freshState();
  const relMultiBooking = mkBooking({
    status: 'pending', trip_id: 'LM-MULTI', assigned_driver: null, pickup_datetime: iso(300)
  });
  state.bookings.push(relMultiBooking);
  state.booking_releases.push(
    mkRelease({ booking_id: relMultiBooking.id, driver_id: 'drv-a', driver_name_at_release: 'Andres' }),
    mkRelease({ booking_id: relMultiBooking.id, driver_id: 'drv-b', driver_name_at_release: 'Backup', reason: 'vehicle_issue' })
  );
  state.notification_events.push(
    mkReleasedEvent(relMultiBooking.id, 'drv-a', 'ev-rel-a'),
    mkReleasedEvent(relMultiBooking.id, 'drv-b', 'ev-rel-b')
  );
  r = await wd.handler({});
  check('multi-driver lifetime: both release events deliver, each from its OWN history row', () => {
    assert.strictEqual(fetchCalls.length, 2);
    const texts = fetchCalls.map((c) => c.body.text);
    assert.ok(texts.some((t) => t.includes('RELEASED by Andres') && t.includes('schedule conflict')));
    assert.ok(texts.some((t) => t.includes('RELEASED by Backup') && t.includes('vehicle issue')));
    assert.strictEqual(events().find((e) => e.id === 'ev-rel-a').state, 'submitted');
    assert.strictEqual(events().find((e) => e.id === 'ev-rel-b').state, 'submitted');
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
