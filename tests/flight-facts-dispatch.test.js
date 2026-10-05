// Flight facts — dispatcher half (migration 021, plan step 1).
//
// BEHAVIORAL proof, driven through the real lib/dispatch.js and
// lib/notify.js with the same in-memory database style as
// tests/dispatch-module.test.js:
//   * a flight event says the observation's facts on BOTH channels, and
//     the push->Telegram fallback says the SAME sentence (enrichment is
//     threaded through the fallback — a mutation that drops it fails here)
//   * flight alerts use their own push topic; readiness pushes are
//     byte-identical to before
//   * the relevance gate the earlier audit missed: released ride,
//     inactive ride, missing observation, changed flight — each
//     suppressed with ZERO provider calls
//   * a failed enrichment read leaves the event pending for the watchdog
// plus the pure rules in lib/flight-facts.js (band derivation, strict
// validation, booking matching, the fail-closed allowlist).
//
// Run: node tests/flight-facts-dispatch.test.js

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
let pushCalls = [];
const webpushMock = {
  setVapidDetails() {},
  sendNotification: (sub, payload, opts) => {
    pushCalls.push({ payload: JSON.parse(payload), opts });
    return pushBehavior();
  }
};
const webpushPath = require.resolve('web-push', { paths: [repoRoot] });
require.cache[webpushPath] = { id: webpushPath, filename: webpushPath, loaded: true, exports: webpushMock };

let telegramCalls = [];
global.fetch = (url, opts) => {
  telegramCalls.push(JSON.parse(opts.body));
  return Promise.resolve({ ok: true, status: 200 });
};

const dispatch = require(path.join(repoRoot, 'backend/functions/lib/dispatch.js'));
const notify = require(path.join(repoRoot, 'backend/functions/lib/notify.js'));
const ff = require(path.join(repoRoot, 'backend/functions/lib/flight-facts.js'));

const BOOKING_ID = '11111111-2222-4333-8444-555555555555';
const DRIVER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_DRIVER = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const pickupIso = new Date(Date.now() + 140 * 60e3).toISOString();
const schedIso = new Date(Date.parse(pickupIso) - 15 * 60e3).toISOString();
const estIso = new Date(Date.parse(schedIso) + 105 * 60e3).toISOString();
const obsIso = new Date(Date.now() - 60e3).toISOString();

let state;
let idSeq = 0;
let dbFailCalls;

function freshState(overrides = {}) {
  state = {
    booking: {
      id: BOOKING_ID, trip_id: 'LM-FLT1', status: 'confirmed',
      pickup_datetime: pickupIso, pickup_location: 'MIA', dropoff_location: 'Brickell',
      customer_name: 'Pat', assigned_driver: DRIVER, flight_number: 'aa 100',
      driver_ready_at: null, driver_ready_by: null, driver_ready_source: null,
      at_risk_at: null, accepted_at: new Date(Date.now() - 600 * 60e3).toISOString()
    },
    observations: [{
      id: 'obs-1', booking_id: BOOKING_ID, flight_number: 'AA100', band: 'delay_60',
      delay_minutes: 105, scheduled_arrival: schedIso, estimated_arrival: estIso,
      observed_at: obsIso, source: 'test'
    }],
    obsReadError: null,
    events: {},
    deliveries: [],
    subs: [],
    drivers: [{ id: DRIVER, telegram_chat_id: 'chat-drv' }],
    ...overrides
  };
  pushCalls = [];
  telegramCalls = [];
  dbFailCalls = [];
  pushBehavior = async () => ({});
}

function mkEvent(overrides = {}) {
  const ev = {
    id: 'ev-' + (++idSeq), booking_id: BOOKING_ID,
    event_type: 'flight_delay_60', recipient_role: 'driver',
    recipient_key: DRIVER, state: 'pending',
    due_at: new Date(Date.now() - 1000).toISOString(),
    not_after: new Date(Date.now() + 6 * 3600e3).toISOString(),
    ...overrides
  };
  state.events[ev.id] = ev;
  return ev;
}

function mkSub() {
  const sub = {
    id: 'sub-' + (++idSeq), driver_id: DRIVER,
    endpoint: 'https://push.example/ep', p256dh: 'k', auth: 'a',
    activated_at: new Date().toISOString(), disabled_at: null
  };
  state.subs.push(sub);
  return sub;
}

function chain(table, kind, payload) {
  const q = { table, kind, payload, filters: {}, isFilters: {}, order: null };
  const resolveNow = () => resolveQuery(q);
  return {
    eq(col, val) { q.filters[col] = val; return this; },
    in(col, vals) { q.filters['in:' + col] = vals; return this; },
    is(col, val) { q.isFilters[col] = val; return this; },
    order(col, opts) { q.order = { col, asc: !(opts && opts.ascending === false) }; return this; },
    limit() { return resolveNow(); },
    select() { if (kind !== 'select') q.wantsRows = true; return this; },
    maybeSingle() {
      return resolveNow().then((r) => ({ data: (r.data && r.data[0]) || null, error: r.error }));
    },
    then(onOk, onErr) { return resolveNow().then(onOk, onErr); }
  };
}

async function resolveQuery(q) {
  const { table, kind, filters, payload } = q;
  if (table === 'bookings') {
    return { data: state.booking && state.booking.id === filters.id ? [state.booking] : [], error: null };
  }
  if (table === 'flight_observations') {
    if (state.obsReadError) return { data: null, error: state.obsReadError };
    const rows = state.observations
      .filter((o) => o.booking_id === filters.booking_id && o.band === filters.band)
      .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
    return { data: rows, error: null };
  }
  if (table === 'drivers') {
    return { data: state.drivers.filter((d) => d.id === filters.id), error: null };
  }
  if (table === 'push_subscriptions') {
    if (kind === 'update') {
      const rows = state.subs.filter((s) => s.id === filters.id);
      rows.forEach((s) => Object.assign(s, payload));
      return { data: rows, error: null };
    }
    return { data: state.subs.filter((s) => s.driver_id === filters.driver_id && s.disabled_at === null), error: null };
  }
  if (table === 'notification_events') {
    const ev = state.events[filters.id];
    const allowed = filters['in:state'] || [];
    if (!ev || !allowed.includes(ev.state)) return { data: [], error: null };
    Object.assign(ev, payload);
    return { data: [ev], error: null };
  }
  if (table === 'notification_deliveries') {
    if (kind === 'insert') {
      const row = { id: 'del-' + (++idSeq), ...payload };
      state.deliveries.push(row);
      return { data: [row], error: null };
    }
    if (kind === 'update') {
      const rows = state.deliveries.filter((d) => d.id === filters.id);
      rows.forEach((d) => Object.assign(d, payload));
      return { data: rows, error: null };
    }
    let rows = state.deliveries.filter((d) => d.event_id === filters.event_id);
    if (filters.channel) rows = rows.filter((d) => d.channel === filters.channel);
    return { data: rows, error: null };
  }
  throw new Error('unexpected table ' + table);
}

const db = {
  from: (table) => ({
    select: (cols) => chain(table, 'select', null).select(cols),
    update: (p) => chain(table, 'update', p),
    insert: (p) => chain(table, 'insert', p)
  })
};

const summary = () => ({ attempts: 0, submitted: 0 });
const run = (ev) => dispatch.dispatchOne(db, ev, Date.now(),
  { summary: summary(), dbFail: (site, error) => dbFailCalls.push({ site, error }), maxAttempts: 15 });

const expectedLine = () =>
  `AA100 now lands ${notify.fmtTimeET(estIso)}, 105 min late. ` +
  `Ride LM-FLT1 pickup still shows ${notify.fmtTimeET(pickupIso)}. ` +
  `Checked ${notify.fmtTimeET(obsIso)}.`;

let checks = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); checks++; results.push(`  ✓ ${name}`); }
  catch (e) {
    results.push(`  ✗ ${name}\n      ${e.message}`);
    results.forEach((l) => console.log(l));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

function assertSilent(ev, reason) {
  assert.strictEqual(ev.state, 'suppressed', `expected suppressed, got ${ev.state}`);
  assert.strictEqual(ev.suppress_reason, reason);
  assert.strictEqual(pushCalls.length, 0, 'no push may be sent');
  assert.strictEqual(telegramCalls.length, 0, 'no Telegram may be sent');
  assert.strictEqual(state.deliveries.length, 0, 'no delivery may even be claimed');
}

(async () => {
  console.log('\nFlight facts — dispatcher (plan step 1)\n');

  // ------------------------------------------------------------ happy path
  await check('a delay event pushes the observation\'s facts to the assigned driver', async () => {
    freshState(); mkSub();
    const ev = mkEvent();
    await run(ev);
    assert.strictEqual(ev.state, 'submitted');
    assert.strictEqual(pushCalls.length, 1);
    assert.strictEqual(telegramCalls.length, 0, 'push succeeded: no Telegram');
    const { payload } = pushCalls[0];
    assert.strictEqual(payload.body, expectedLine());
    assert.strictEqual(payload.rideId, BOOKING_ID, 'deep-links to the live ride');
    assert.ok(payload.body.length <= 200, 'driver-sw truncates bodies at 200 chars');
  });

  await check('flight pushes use their OWN topic and tag, never the readiness one', async () => {
    freshState(); mkSub();
    await run(mkEvent());
    const { payload, opts } = pushCalls[0];
    assert.strictEqual(opts.topic, notify.flightTopic(state.booking));
    assert.strictEqual(payload.tag, notify.flightTopic(state.booking));
    assert.notStrictEqual(opts.topic, notify.readinessTopic(state.booking));
    assert.ok(opts.topic.length <= 32 && /^[A-Za-z0-9_-]+$/.test(opts.topic), 'Web Push topic limits');
  });

  await check('readiness pushes are unchanged: same text, same readiness topic', async () => {
    freshState(); mkSub();
    await run(mkEvent({ event_type: 'driver_ready_ask_1', not_after: pickupIso }));
    const { payload, opts } = pushCalls[0];
    assert.strictEqual(payload.body, 'Ride LM-FLT1 — readiness check due. Open to confirm.');
    assert.strictEqual(opts.topic, notify.readinessTopic(state.booking));
  });

  await check('with no push device the SAME sentence goes out on Telegram', async () => {
    freshState();
    const ev = mkEvent();
    await run(ev);
    assert.strictEqual(ev.state, 'submitted');
    assert.strictEqual(telegramCalls.length, 1);
    assert.ok(telegramCalls[0].text.includes(expectedLine()), telegramCalls[0].text);
    assert.strictEqual(telegramCalls[0].chat_id, 'chat-drv', 'to THE driver, not the admin chat');
  });

  await check('a definitive push failure falls back to Telegram WITH the facts (enrichment threaded)', async () => {
    freshState(); mkSub();
    pushBehavior = async () => { const e = new Error('gone'); e.statusCode = 410; throw e; };
    const ev = mkEvent();
    await run(ev);
    assert.strictEqual(pushCalls.length, 1);
    assert.strictEqual(telegramCalls.length, 1, 'fallback sent');
    assert.ok(telegramCalls[0].text.includes(expectedLine()),
      'the fallback must say what the push would have — not suppress as no_template');
    assert.strictEqual(ev.state, 'submitted');
  });

  // -------------------------------------------------------- relevance gate
  await check('a RELEASED ride: the old driver\'s flight alert is suppressed, zero sends', async () => {
    freshState(); mkSub();
    state.booking.assigned_driver = OTHER_DRIVER;
    const ev = mkEvent();
    await run(ev);
    assertSilent(ev, 'reassigned');
  });

  for (const status of ['pending', 'in_progress', 'completed', 'cancelled', 'declined']) {
    await check(`ride status ${status}: suppressed ride_inactive, zero sends`, async () => {
      freshState(); mkSub();
      state.booking.status = status;
      const ev = mkEvent();
      await run(ev);
      assertSilent(ev, 'ride_inactive');
    });
  }

  for (const status of ['on_the_way', 'arrived']) {
    await check(`ride status ${status}: still told (a waiting driver is who a delay helps)`, async () => {
      freshState(); mkSub();
      state.booking.status = status;
      const ev = mkEvent();
      await run(ev);
      assert.strictEqual(ev.state, 'submitted');
    });
  }

  await check('no observation in the event\'s band: suppressed, zero sends', async () => {
    freshState(); mkSub();
    state.observations = [];
    const ev = mkEvent();
    await run(ev);
    assertSilent(ev, 'observation_missing');
  });

  await check('the ride now carries a different flight: stale news, suppressed', async () => {
    freshState(); mkSub();
    state.booking.flight_number = 'DL 202';
    const ev = mkEvent();
    await run(ev);
    assertSilent(ev, 'flight_changed');
  });

  await check('a flight ident is a real designator: IATA or ICAO code, 1-4 digits, optional suffix', async () => {
    for (const ok of ['AA100', 'B61234', '9K123', 'AAL100', 'DL1A', 'UA9']) {
      assert.ok(ff.isFlightIdent(ok), `${ok} is a flight`);
    }
    for (const bad of ['TBD', 'AMERICAN100', 'INV20260042', 'AA', '100', 'AA12345', 'A1B2C3']) {
      assert.ok(!ff.isFlightIdent(bad), `${bad} is not a flight`);
    }
  });

  await check('code and database hold the SAME designator pattern', async () => {
    const fsx = require('fs');
    const sql = fsx.readFileSync(path.join(repoRoot, 'database/migrations/021_flight_observations.sql'), 'utf8');
    const lib = fsx.readFileSync(path.join(repoRoot, 'backend/functions/lib/flight-facts.js'), 'utf8');
    const dbPattern = sql.match(/flight_number ~ '([^']+)'/)[1];
    const libPattern = lib.match(/const FLIGHT_RE = \/(.+)\/;/)[1];
    assert.strictEqual(dbPattern, libPattern);
  });

  await check('flight numbers compare normalized ("aa 100" on the ride == "AA100")', async () => {
    assert.strictEqual(ff.normalizeFlightNumber('aa 100'), 'AA100');
    assert.strictEqual(ff.normalizeFlightNumber('AA-100'), 'AA100');
    assert.strictEqual(ff.normalizeFlightNumber(null), '');
  });

  await check('a failed observation read stays PENDING for the watchdog, zero sends', async () => {
    freshState(); mkSub();
    state.obsReadError = { message: 'injected read failure' };
    const ev = mkEvent();
    await run(ev);
    assert.strictEqual(ev.state, 'pending', 'never condemned on a transient read');
    assert.strictEqual(dbFailCalls.length, 1);
    assert.strictEqual(dbFailCalls[0].site, 'flight enrichment');
    assert.strictEqual(pushCalls.length + telegramCalls.length, 0);
  });

  await check('the newest observation in the band is the one rendered', async () => {
    freshState(); mkSub();
    const newerEst = new Date(Date.parse(schedIso) + 110 * 60e3).toISOString();
    state.observations.push({ ...state.observations[0], id: 'obs-2', delay_minutes: 110,
      estimated_arrival: newerEst, observed_at: new Date().toISOString() });
    await run(mkEvent());
    assert.ok(pushCalls[0].payload.body.includes('110 min late'), pushCalls[0].payload.body);
  });

  // ------------------------------------------------------------- the copy
  await check('cancelled and diverted say so, keep the booked pickup, and point to the passenger', async () => {
    const b = { id: BOOKING_ID, trip_id: 'LM-FLT1', pickup_datetime: pickupIso };
    const obs = { flight_number: 'AA100', observed_at: obsIso };
    const c = notify.flightLine('flight_cancelled', b, obs);
    const d = notify.flightLine('flight_diverted', b, obs);
    assert.ok(c.startsWith('AA100 was cancelled.') && c.includes('pickup still shows') && c.includes('passenger'));
    assert.ok(d.startsWith('AA100 was diverted.') && d.includes('before driving'));
  });

  await check('a landing on a different Miami day carries its date', async () => {
    const b = { id: BOOKING_ID, trip_id: 'LM-FLT1', pickup_datetime: '2026-10-20T03:30:00Z' }; // 11:30 PM Oct 19
    const obs = { flight_number: 'AA100', observed_at: obsIso, delay_minutes: 120,
      estimated_arrival: '2026-10-20T05:00:00Z' };                                         // 1:00 AM Oct 20
    const line = notify.flightLine('flight_delay_120', b, obs);
    assert.ok(line.includes('now lands Tue, Oct 20 at 1:00 AM'), line);
  });

  await check('no copy claims live tracking', async () => {
    const b = { id: BOOKING_ID, trip_id: 'LM-FLT1', pickup_datetime: pickupIso };
    for (const t of notify.FLIGHT_TYPES) {
      const line = notify.flightLine(t, b, state.observations[0]) || '';
      assert.ok(!/\blive\b|tracking/i.test(line), `${t}: ${line}`);
    }
  });

  await check('missing facts render null (-> no_template), never a blank time', async () => {
    const b = { id: BOOKING_ID, trip_id: 'LM-FLT1', pickup_datetime: pickupIso };
    assert.strictEqual(notify.flightLine('flight_delay_60', b, { flight_number: 'AA100', observed_at: obsIso }), null);
    assert.strictEqual(notify.renderEvent('flight_delay_60', b, undefined), null);
    const p = notify.pushPayloadFor('flight_delay_60', b, undefined);
    assert.ok(p && typeof p.body === 'string' && p.body.length > 0, 'push builder never returns null');
  });

  // ---------------------------------------------------- pure flight rules
  const NOW = Date.parse('2026-10-06T18:00:00Z');
  const base = () => ({
    bookingId: BOOKING_ID, flightNumber: 'AA100', pickupDate: '2026-10-06', airportCode: 'MIA',
    status: 'active', scheduledArrival: '2026-10-06T19:00:00Z',
    estimatedArrival: '2026-10-06T19:00:00Z', observedAt: '2026-10-06T17:59:00Z', source: 'muse'
  });
  const bandAt = (minutesLate) => {
    const o = base();
    o.estimatedArrival = new Date(Date.parse(o.scheduledArrival) + minutesLate * 60e3).toISOString();
    return ff.validateObservation(o, NOW).value.band;
  };

  await check('the SERVER derives the band from the sensor\'s times (thresholds 30/60/120)', async () => {
    assert.strictEqual(bandAt(0), 'on_time');
    assert.strictEqual(bandAt(-20), 'on_time');
    assert.strictEqual(bandAt(29), 'on_time');
    assert.strictEqual(bandAt(29.6), 'delay_30', '29:36 late rounds to 30');
    assert.strictEqual(bandAt(59), 'delay_30');
    assert.strictEqual(bandAt(60), 'delay_60');
    assert.strictEqual(bandAt(119), 'delay_60');
    assert.strictEqual(bandAt(120), 'delay_120');
    assert.strictEqual(bandAt(300), 'delay_120');
  });

  await check('only the five news bands map to driver events', async () => {
    assert.deepStrictEqual(ff.NOTIFYING_BANDS.map(ff.eventTypeForBand), notify.FLIGHT_TYPES);
    assert.strictEqual(ff.eventTypeForBand('on_time'), null);
    assert.strictEqual(ff.eventTypeForBand('landed'), null);
    for (const t of notify.FLIGHT_TYPES) assert.strictEqual(ff.eventTypeForBand(ff.bandForEventType(t)), t);
  });

  await check('validation is strict: unknown fields, zone-less times, missing estimates', async () => {
    const bad = (mut, msg) => {
      const o = base(); mut(o);
      const r = ff.validateObservation(o, NOW);
      assert.strictEqual(r.ok, false, `should refuse: ${msg}`);
    };
    bad((o) => { o.band = 'delay_60'; }, 'a sensor-supplied band');
    bad((o) => { o.estimatedArrival = '2026-10-06T19:00:00'; }, 'zone-less timestamp');
    bad((o) => { delete o.estimatedArrival; }, 'active without estimate');
    bad((o) => { o.status = 'landed'; }, 'landed without actual');
    bad((o) => { o.status = 'delayed'; }, 'unknown status');
    bad((o) => { o.bookingId = 'LM-W98Q'; }, 'trip code instead of UUID');
    bad((o) => { o.flightNumber = 'AMERICAN 100'; }, 'not an ident');
    bad((o) => { o.source = 'Muse Agent'; }, 'non-slug source');
    bad((o) => { o.observedAt = '2026-10-06T18:10:00Z'; }, 'observed in the future');
    bad((o) => { o.observedAt = '2026-10-06T10:00:00Z'; }, 'observed too long ago');
    bad((o) => { o.estimatedArrival = '2026-10-09T19:00:00Z'; }, 'implausible estimate');
    assert.strictEqual(ff.validateObservation(base(), NOW).ok, true, 'the baseline passes');
    assert.strictEqual(ff.validateObservation([], NOW).ok, false);
  });

  await check('cancelled/diverted need no estimate; landed records its own delay', async () => {
    for (const status of ['cancelled', 'diverted']) {
      const o = base(); o.status = status; delete o.estimatedArrival;
      const r = ff.validateObservation(o, NOW);
      assert.ok(r.ok && r.value.band === status && r.value.delayMinutes === null);
    }
    const o = base(); o.status = 'landed'; o.actualArrival = '2026-10-06T19:42:00Z';
    const r = ff.validateObservation(o, NOW);
    assert.ok(r.ok && r.value.band === 'landed' && r.value.delayMinutes === 42);
  });

  await check('timestamps are normalized to UTC ISO, offsets honoured', async () => {
    const o = base(); o.estimatedArrival = '2026-10-06T16:00:00-04:00';  // = 20:00Z, 60 late
    const r = ff.validateObservation(o, NOW);
    assert.strictEqual(r.value.estimatedArrival, '2026-10-06T20:00:00.000Z');
    assert.strictEqual(r.value.band, 'delay_60');
  });

  const goodBooking = () => ({
    booking_mode: 'pickup', status: 'confirmed', assigned_driver: DRIVER,
    flight_number: 'aa 100', airport_code: 'MIA', pickup_datetime: '2026-10-06T19:15:00Z'
  });
  await check('an observation must describe THIS booking\'s flight as it stands now', async () => {
    const obs = ff.validateObservation(base(), NOW).value;
    assert.strictEqual(ff.mismatchReason(obs, goodBooking()), null);
    const why = (mut) => { const b = goodBooking(); mut(b); return ff.mismatchReason(obs, b); };
    assert.strictEqual(why((b) => { b.booking_mode = 'dropoff'; }), 'not_an_arrival');
    assert.strictEqual(why((b) => { b.status = 'pending'; }), 'ride_inactive');
    assert.strictEqual(why((b) => { b.assigned_driver = null; }), 'no_driver');
    assert.strictEqual(why((b) => { b.flight_number = 'DL202'; }), 'flight_mismatch');
    assert.strictEqual(why((b) => { b.airport_code = 'FLL'; }), 'airport_mismatch');
    assert.strictEqual(why((b) => { b.pickup_datetime = '2026-10-07T19:15:00Z'; }), 'date_mismatch');
  });

  await check('pickup date is the MIAMI date, not the UTC one', async () => {
    const obs = ff.validateObservation({ ...base(), pickupDate: '2026-10-06' }, NOW).value;
    const b = goodBooking(); b.pickup_datetime = '2026-10-07T03:30:00Z'; // 11:30 PM Oct 6 in Miami
    assert.strictEqual(ff.mismatchReason(obs, b), null);
  });

  await check('the driver allowlist fails CLOSED: unset or empty means nobody', async () => {
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist(undefined), DRIVER), false);
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist(''), DRIVER), false);
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist('not-a-uuid'), DRIVER), false);
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist(` ${DRIVER.toUpperCase()} `), DRIVER), true);
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist(`${OTHER_DRIVER},${DRIVER}`), DRIVER), true);
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist(OTHER_DRIVER), DRIVER), false);
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist('*'), DRIVER), true);
    assert.strictEqual(ff.driverAllowed(ff.parseDriverAllowlist('*'), null), false, 'no driver, no alert');
  });

  results.forEach((l) => console.log(l));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})().catch((e) => { console.error(e); process.exit(1); });
