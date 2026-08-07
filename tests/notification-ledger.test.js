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
// global.fetch is replaced to capture/steer Telegram calls. The REAL
// watchdog handler and notify library run unmodified.

const path = require('path');
const assert = require('assert');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
process.env.ADMIN_TELEGRAM_CHAT_ID = 'admin-chat';
process.env.URL = 'https://example.test';
delete process.env.WATCHDOG_DISABLED;

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
      : []
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

  // ---------- derive + dispatch + roll-up truth + idempotency ----------
  freshState();
  const b1 = mkBooking({ pickup_datetime: iso(140) }); // only ask_1 due
  state.bookings.push(b1);
  r = await wd.handler({});
  check('T-150 due: exactly one ask_1 event, one telegram delivery to the driver chat', () => {
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(events().length, 1);
    assert.strictEqual(events()[0].event_type, 'driver_ready_ask_1');
    assert.strictEqual(events()[0].recipient_key, 'drv-a');
    assert.strictEqual(deliveries().length, 1);
    assert.strictEqual(deliveries()[0].channel, 'telegram');
    assert.strictEqual(deliveries()[0].target, 'chat-a');
    assert.deepStrictEqual(telegramChats(), ['chat-a']);
  });
  check('delivery truth: provider acceptance is submitted, NEVER delivered', () => {
    assert.strictEqual(deliveries()[0].state, 'submitted');
    assert.strictEqual(events()[0].state, 'submitted');
    assert.notStrictEqual(events()[0].state, 'delivered');
  });
  r = await wd.handler({});
  check('second sweep is idempotent: same one event, no second telegram', () => {
    assert.strictEqual(events().length, 1);
    assert.strictEqual(deliveries().length, 1);
    assert.strictEqual(fetchCalls.length, 1);
  });

  // ---------- chain collapse + at-risk stamp ----------
  freshState();
  const b2 = mkBooking({ pickup_datetime: iso(100) }); // whole chain due
  state.bookings.push(b2);
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
  fetchBehavior = async () => { throw new Error('connection refused'); };
  r = await wd.handler({});
  check('Telegram down: at_risk_at STILL stamped (DB is the truth, Telegram the alert)', () => {
    assert.ok(state.bookings[0].at_risk_at);
  });
  check('failed sends recorded as failed attempts; events stay in_delivery for retry', () => {
    assert.ok(deliveries().length >= 1);
    deliveries().forEach((d) => assert.strictEqual(d.state, 'failed'));
    const urgent = events().find((e) => e.event_type === 'driver_ready_urgent');
    assert.strictEqual(urgent.state, 'in_delivery');
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
  check('racing duplicate insert loses on the unique constraint', () => {
    assert.ok(dup.error, 'duplicate insert must error');
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

  // ---------- ride-day heartbeat ----------
  freshState({ silenceHeartbeat: false });
  state.bookings.push(mkBooking({
    pickup_datetime: iso(10 * 60), // 10h out: outside sweep, inside 24h heartbeat window
    driver_ready_at: iso(-30), driver_ready_by: 'drv-a', driver_ready_source: 'web'
  }));
  r = await wd.handler({});
  check('ride day, first invocation: exactly one heartbeat to admin', () => {
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].body.chat_id, 'admin-chat');
    assert.ok(/watchdog: alive/.test(fetchCalls[0].body.text));
    assert.strictEqual(state.system_state[0].value, todayET());
  });
  r = await wd.handler({});
  check('same day, second invocation: silent', () => {
    assert.strictEqual(fetchCalls.length, 1);
  });
  freshState({ silenceHeartbeat: false }); // no bookings at all
  r = await wd.handler({});
  check('quiet day (no rides): no heartbeat — silence stays meaningful', () => {
    assert.strictEqual(fetchCalls.length, 0);
    assert.strictEqual(state.system_state.length, 0);
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
