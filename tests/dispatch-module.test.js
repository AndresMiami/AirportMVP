// Shared dispatcher (lib/dispatch.js) — BEHAVIORAL proof of the frozen
// semantics, driven directly through the module (not via source-text
// inspection): options validation, cap-before-claim, lost-CAS silence,
// ambiguity handling, definitive-fallback ordering, and
// finalization-failure stops. The watchdog-driven end-to-end contract
// stays pinned by tests/notification-ledger.test.js, which runs the SAME
// moved code through the full loop.
//
// Run: node tests/dispatch-module.test.js

const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');

process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
process.env.ADMIN_TELEGRAM_CHAT_ID = 'admin-chat';
process.env.VAPID_SUBJECT = 'mailto:ops@linkmia.example';
process.env.VAPID_PUBLIC_KEY = Buffer.alloc(65, 1).toString('base64url');
process.env.VAPID_PRIVATE_KEY = Buffer.alloc(32, 1).toString('base64url');
delete process.env.PUSH_DISABLED;

// ---- provider stubs (BEFORE requiring the modules) ----
let pushBehavior = async () => ({});
const webpushMock = {
  setVapidDetails() {},
  sendNotification: (...args) => {
    oplog.push('push_send');
    return pushBehavior(...args);
  }
};
const webpushPath = require.resolve('web-push', { paths: [repoRoot] });
require.cache[webpushPath] = {
  id: webpushPath, filename: webpushPath, loaded: true, exports: webpushMock
};

let fetchBehavior = async () => ({ ok: true, status: 200 });
let telegramCalls = [];
global.fetch = (url, opts) => {
  oplog.push('telegram_send');
  telegramCalls.push({ url, body: JSON.parse(opts.body) });
  return fetchBehavior();
};

const dispatch = require(path.join(repoRoot, 'backend/functions/lib/dispatch.js'));

// ---- in-memory db with a chronological operation log ----
let state;
let oplog;
let dbFailCalls;
let idSeq = 0;

function freshState(overrides = {}) {
  state = {
    booking: {
      id: 'bk1', trip_id: 'LM-DSP', status: 'confirmed',
      pickup_datetime: new Date(Date.now() + 140 * 60e3).toISOString(),
      pickup_location: 'Brickell', dropoff_location: 'MIA',
      customer_name: 'Pat', assigned_driver: 'drv-a',
      driver_ready_at: null, driver_ready_by: null, driver_ready_source: null,
      at_risk_at: null, accepted_at: new Date(Date.now() - 600 * 60e3).toISOString()
    },
    events: {},
    deliveries: [],
    subs: [],
    drivers: [{ id: 'drv-a', telegram_chat_id: 'chat-drv' }],
    failDeliveryUpdate: false,
    ...overrides
  };
  oplog = [];
  telegramCalls = [];
  dbFailCalls = [];
  fetchBehavior = async () => ({ ok: true, status: 200 });
  pushBehavior = async () => ({});
}

function mkEvent(overrides = {}) {
  const ev = {
    id: 'ev-' + (++idSeq), booking_id: 'bk1',
    event_type: 'driver_ready_ask_1', recipient_role: 'driver',
    recipient_key: 'drv-a', state: 'pending',
    due_at: new Date(Date.now() - 60e3).toISOString(), not_after: null,
    ...overrides
  };
  state.events[ev.id] = ev;
  return ev;
}

function mkSub() {
  const sub = {
    id: 'sub-' + (++idSeq), driver_id: 'drv-a',
    endpoint: 'https://push.example/ep', p256dh: 'k', auth: 'a',
    activated_at: new Date().toISOString(), disabled_at: null
  };
  state.subs.push(sub);
  return sub;
}

// Minimal thenable query chain: records filters/payload, resolves by
// (table, kind) against the state tables above.
function chain(table, kind, payload) {
  const q = { table, kind, payload, filters: {}, isFilters: {} };
  const resolveNow = () => resolveQuery(q);
  return {
    eq(col, val) { q.filters[col] = val; return this; },
    in(col, vals) { q.filters['in:' + col] = vals; return this; },
    is(col, val) { q.isFilters[col] = val; return this; },
    order() { return this; },
    limit() { return resolveNow(); },
    select(cols) {
      if (kind === 'update' || kind === 'insert') { q.wantsRows = true; return this; }
      q.cols = cols; return this;
    },
    maybeSingle() {
      return resolveNow().then((r) => ({
        data: (r.data && r.data[0]) || null, error: r.error
      }));
    },
    then(onOk, onErr) { return resolveNow().then(onOk, onErr); }
  };
}

async function resolveQuery(q) {
  const { table, kind, filters, payload } = q;
  if (table === 'bookings') {
    const hit = state.booking && state.booking.id === filters.id ? [state.booking] : [];
    return { data: hit, error: null };
  }
  if (table === 'drivers') {
    return { data: state.drivers.filter((d) => d.id === filters.id), error: null };
  }
  if (table === 'push_subscriptions') {
    if (kind === 'update') {
      oplog.push('sub_update');
      const rows = state.subs.filter((s) => s.id === filters.id);
      rows.forEach((s) => Object.assign(s, payload));
      return { data: rows, error: null };
    }
    return {
      data: state.subs.filter((s) => s.driver_id === filters.driver_id && s.disabled_at === null),
      error: null
    };
  }
  if (table === 'notification_events') {
    // update ... eq id ... in state (CAS)
    oplog.push('event_update');
    const ev = state.events[filters.id];
    const allowed = filters['in:state'] || [];
    if (!ev || !allowed.includes(ev.state)) return { data: [], error: null };
    Object.assign(ev, payload);
    return { data: [ev], error: null };
  }
  if (table === 'notification_deliveries') {
    if (kind === 'insert') {
      oplog.push('delivery_insert:' + payload.channel);
      const row = { id: 'del-' + (++idSeq), ...payload };
      state.deliveries.push(row);
      return { data: [row], error: null };
    }
    if (kind === 'update') {
      oplog.push('delivery_update');
      if (state.failDeliveryUpdate) {
        return { data: null, error: { message: 'injected finalize failure' } };
      }
      const rows = state.deliveries.filter((d) => d.id === filters.id);
      rows.forEach((d) => Object.assign(d, payload));
      return { data: rows, error: null };
    }
    // select: by event_id (+ optional channel)
    let rows = state.deliveries.filter((d) => d.event_id === filters.event_id);
    if (filters.channel) rows = rows.filter((d) => d.channel === filters.channel);
    return { data: rows, error: null };
  }
  throw new Error('unexpected table ' + table);
}

const db = {
  from: (table) => ({
    select: (cols) => chain(table, 'select', null).select(cols),
    update: (payload) => chain(table, 'update', payload),
    insert: (payload) => chain(table, 'insert', payload)
  })
};

const dbFail = (site, error) => dbFailCalls.push({ site, error });
const run = (ev, summary, maxAttempts = 15) =>
  dispatch.dispatchOne(db, ev, Date.now(), { summary, dbFail, maxAttempts });

let passed = 0;
const failures = [];
async function check(name, fn) {
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
  await check('missing or malformed options THROW before any read, write, or send', async () => {
    freshState();
    const ev = mkEvent();
    const bad = [
      undefined,
      {},
      { summary: { attempts: 0, submitted: 0 }, dbFail },                       // no maxAttempts
      { summary: { attempts: 0, submitted: 0 }, dbFail, maxAttempts: 0 },      // not positive
      { summary: { attempts: 0, submitted: 0 }, dbFail, maxAttempts: '15' },   // not an integer
      { summary: { attempts: 0, submitted: 0 }, dbFail, maxAttempts: NaN },
      { summary: { attempts: 0, submitted: 0 }, maxAttempts: 15 },             // no dbFail
      { dbFail, maxAttempts: 15 }                                              // no summary
    ];
    for (const opts of bad) {
      await assert.rejects(() => dispatch.dispatchOne(db, ev, Date.now(), opts),
        /dispatchOne:/, JSON.stringify(opts));
    }
    assert.strictEqual(oplog.length, 0, 'nothing may run under invalid options');
    assert.strictEqual(state.deliveries.length, 0);
  });

  await check('only dispatchOne is exported — executors cannot be bypassed', () => {
    assert.deepStrictEqual(Object.keys(dispatch), ['dispatchOne']);
  });

  await check('cap-before-claim: an exhausted ceiling creates NO delivery row and NO send (both channels)', async () => {
    freshState();
    mkSub(); // healthy sub -> webpush route
    let ev = mkEvent();
    await run(ev, { attempts: 15, submitted: 0 }, 15);
    assert.strictEqual(state.deliveries.length, 0, 'no claim under an exhausted cap');
    assert.ok(!oplog.includes('push_send') && !oplog.includes('telegram_send'));

    freshState(); // no sub -> telegram route
    ev = mkEvent();
    await run(ev, { attempts: 15, submitted: 0 }, 15);
    assert.strictEqual(state.deliveries.length, 0);
    assert.ok(!oplog.includes('telegram_send'));
  });

  await check('lost CAS is SILENT: no delivery, no provider call, no dbFail', async () => {
    freshState();
    const ev = mkEvent({ state: 'suppressed', suppress_reason: 'superseded' });
    await run(ev, { attempts: 0, submitted: 0 });
    assert.strictEqual(state.deliveries.length, 0);
    assert.ok(!oplog.includes('telegram_send') && !oplog.includes('push_send'));
    assert.strictEqual(dbFailCalls.length, 0, 'a lost race is not a failure');
    assert.strictEqual(ev.state, 'suppressed', 'the other worker\'s decision stands');
  });

  await check('push ambiguity is terminal: exhausted, NEVER a Telegram fallback', async () => {
    freshState();
    mkSub();
    const ev = mkEvent();
    pushBehavior = async () => { const e = new Error('503'); e.statusCode = 503; throw e; };
    const summary = { attempts: 0, submitted: 0 };
    await run(ev, summary);
    const del = state.deliveries.find((d) => d.channel === 'webpush');
    assert.strictEqual(del.state, 'ambiguous');
    assert.strictEqual(del.failure_class, 'ambiguous');
    assert.strictEqual(ev.state, 'exhausted');
    assert.strictEqual(telegramCalls.length, 0, 'ambiguity must never trigger a second channel');
    assert.strictEqual(summary.attempts, 1);
    assert.strictEqual(summary.submitted, 0);
  });

  await check('definitive push (404) follows the STRICT order: finalize -> disable -> fallback claim -> send', async () => {
    freshState();
    const sub = mkSub();
    const ev = mkEvent();
    pushBehavior = async () => { const e = new Error('410'); e.statusCode = 404; throw e; };
    const summary = { attempts: 0, submitted: 0 };
    await run(ev, summary);
    const seq = oplog.filter((op) => ['push_send', 'delivery_update', 'sub_update',
      'delivery_insert:telegram', 'telegram_send'].includes(op));
    const idx = (op) => seq.indexOf(op);
    assert.ok(idx('push_send') < idx('delivery_update'), 'send precedes finalize');
    assert.ok(idx('delivery_update') < idx('sub_update'), 'failed delivery persisted BEFORE disabling');
    assert.ok(idx('sub_update') < idx('delivery_insert:telegram'), 'subscription disabled BEFORE fallback claim');
    assert.ok(idx('delivery_insert:telegram') < idx('telegram_send'), 'fallback claims before sending');
    assert.ok(sub.disabled_at, 'expired endpoint disabled');
    assert.strictEqual(sub.disabled_reason, 'expired');
    assert.strictEqual(telegramCalls.length, 1, 'exactly one fallback send');
    assert.strictEqual(telegramCalls[0].body.chat_id, 'chat-drv');
    assert.strictEqual(ev.state, 'submitted');
    assert.strictEqual(summary.attempts, 2, 'both provider calls counted');
    assert.strictEqual(summary.submitted, 1);
  });

  await check('finalization failure STOPS everything: dbFail surfaced, no rollup, no further writes', async () => {
    freshState();
    const ev = mkEvent({ recipient_role: 'admin', recipient_key: 'admin', event_type: 'admin_ready_escalation' });
    state.failDeliveryUpdate = true; // the post-send finalize will fail
    const summary = { attempts: 0, submitted: 0 };
    await run(ev, summary);
    assert.strictEqual(telegramCalls.length, 1, 'the send itself happened');
    assert.ok(dbFailCalls.some((c) => c.site === 'finalize submitted'), 'failure surfaced via dbFail');
    assert.strictEqual(ev.state, 'in_delivery', 'NO event rollup after a failed finalize');
    assert.strictEqual(summary.submitted, 0, 'unrecorded truth is never counted as success');
    const afterFinalize = oplog.slice(oplog.lastIndexOf('delivery_update') + 1);
    assert.strictEqual(afterFinalize.length, 0, 'nothing runs after the failed finalize');
  });

  await check('happy Telegram path: claim -> send -> finalize -> rollup, counters honest', async () => {
    freshState();
    const ev = mkEvent({ recipient_role: 'admin', recipient_key: 'admin', event_type: 'at_risk_mark' });
    state.booking.at_risk_at = new Date().toISOString();
    const summary = { attempts: 0, submitted: 0 };
    await run(ev, summary);
    const del = state.deliveries.find((d) => d.channel === 'telegram');
    assert.strictEqual(del.state, 'submitted');
    assert.strictEqual(del.target, 'admin-chat');
    assert.strictEqual(ev.state, 'submitted');
    assert.strictEqual(summary.attempts, 1);
    assert.strictEqual(summary.submitted, 1);
    assert.strictEqual(telegramCalls.length, 1);
  });

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} FAILURE(S): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`ALL ${passed} CHECKS PASS`);
})();
