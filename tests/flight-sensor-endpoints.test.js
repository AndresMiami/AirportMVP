// Flight sensor endpoints (decision D1, plan step 3):
//   GET  /api/flight-watchlist   POST /api/flight-facts
//
// Pattern: mock @supabase/supabase-js AND lib/dispatch.js via require.cache,
// run the real handlers, assert payloads, filters and side effects. The
// dispatcher itself is proven in tests/flight-facts-dispatch.test.js; the
// trigger on real Postgres in tests/flight-observations-migration.test.js.
//
// What must hold:
//   * the token is the only way in; switched off / unconfigured fail closed
//   * the watchlist leaks no person: no name, phone, address, driver id
//   * the trial allowlist is enforced at WRITE time (a stored row for a
//     driver outside the trial would otherwise be delivered by the watchdog)
//   * the server derives the band; the sensor cannot supply one
//   * a notification failure never fails a stored observation
//   * nothing ever writes to bookings (tell only, D3)
//   * database error text never reaches the response
//
// Run: node tests/flight-sensor-endpoints.test.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const TOKEN = 'sensor-token-0123456789abcdef0123456789abcdef';
const BID = '123e4567-e89b-42d3-a456-426614174000';
const DRIVER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET_DB_TEXT = 'relation "secret_internal_table" violates something';

const ff = require(path.join(repoRoot, 'backend/functions/lib/flight-facts.js'));

// ---------- mock state ----------
const state = {};
function reset(env = {}) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.FLIGHT_SENSOR_TOKEN = TOKEN;
  process.env.FLIGHT_SENSOR_DRIVER_ALLOWLIST = DRIVER;
  delete process.env.FLIGHT_SENSOR_DISABLED;
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];

  const pickup = new Date(Date.now() + 3 * 3600e3).toISOString();
  state.pickup = pickup;
  state.booking = {
    id: BID, booking_mode: 'pickup', status: 'confirmed', assigned_driver: DRIVER,
    flight_number: 'aa 100', airport_code: 'MIA', pickup_datetime: pickup
  };
  state.bookingError = null;
  state.watchRows = [];
  state.watchError = null;
  state.watchQuery = null;
  state.observations = [];
  state.insertError = null;
  state.triggerCreates = true;
  state.events = [];
  state.eventsError = null;
  state.dispatchCalls = [];
  state.dispatchBehavior = (ev) => { ev.state = 'submitted'; };
  state.bookingWrites = 0;
}

// ---------- supabase mock ----------
function bookingsFrom() {
  const q = { eq: {}, in: {}, not: [], gte: null, lte: null, order: null, limit: null };
  const chain = {
    select: (cols) => { q.cols = cols; return chain; },
    eq: (c, v) => { q.eq[c] = v; return chain; },
    in: (c, v) => { q.in[c] = v; return chain; },
    not: (c, op, v) => { q.not.push([c, op, v]); return chain; },
    gte: (c, v) => { q.gte = [c, v]; return chain; },
    lte: (c, v) => { q.lte = [c, v]; return chain; },
    order: (c, o) => { q.order = [c, o]; return chain; },
    limit: async (n) => {
      q.limit = n; state.watchQuery = q;
      return state.watchError ? { data: null, error: state.watchError } : { data: state.watchRows, error: null };
    },
    maybeSingle: async () => {
      if (state.bookingError) return { data: null, error: state.bookingError };
      return { data: q.eq.id === BID ? state.booking : null, error: null };
    },
    update: () => { state.bookingWrites++; throw new Error('bookings must never be written'); },
    insert: () => { state.bookingWrites++; throw new Error('bookings must never be written'); },
    upsert: () => { state.bookingWrites++; throw new Error('bookings must never be written'); }
  };
  return chain;
}

function observationsFrom() {
  return {
    insert: (row) => ({
      select: () => ({
        maybeSingle: async () => {
          if (state.insertError) return { data: null, error: state.insertError };
          state.observations.push(row);
          // Emulate migration 021's trigger (proven on real SQL elsewhere).
          const type = ff.eventTypeForBand(row.band);
          if (type && state.triggerCreates) {
            const key = state.booking.assigned_driver;
            if (!state.events.some((e) => e.event_type === type && e.recipient_key === key)) {
              state.events.push({ id: 'ev-' + state.events.length, booking_id: row.booking_id,
                event_type: type, recipient_key: key, state: 'pending' });
            }
          }
          return { data: { id: 'obs-' + state.observations.length }, error: null };
        }
      })
    })
  };
}

function eventsFrom() {
  const q = { eq: {}, in: [] };
  const chain = {
    select: () => chain,
    eq: (c, v) => { q.eq[c] = v; return chain; },
    in: (c, v) => { q.in.push([c, v]); return chain; },
    then: (ok, err) => {
      if (state.eventsError) return Promise.resolve({ data: null, error: state.eventsError }).then(ok, err);
      let rows = state.events.filter((e) => Object.entries(q.eq).every(([c, v]) => e[c] === v));
      for (const [c, vals] of q.in) rows = rows.filter((e) => vals.includes(e[c]));
      return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(ok, err);
    }
  };
  return chain;
}

const supabaseMock = {
  createClient: () => ({
    from: (table) => {
      if (table === 'bookings') return bookingsFrom();
      if (table === 'flight_observations') return observationsFrom();
      if (table === 'notification_events') return eventsFrom();
      throw new Error('unexpected table: ' + table);
    }
  })
};
const mockPath = require.resolve('@supabase/supabase-js', { paths: [repoRoot] });
require.cache[mockPath] = { id: mockPath, filename: mockPath, loaded: true, exports: supabaseMock };

const dispatchPath = require.resolve(path.join(repoRoot, 'backend/functions/lib/dispatch.js'));
require.cache[dispatchPath] = {
  id: dispatchPath, filename: dispatchPath, loaded: true,
  exports: {
    dispatchOne: async (db, ev, nowMs, opts) => {
      state.dispatchCalls.push({ ev, opts });
      const live = state.events.find((e) => e.id === ev.id);
      await state.dispatchBehavior(live, opts);
    }
  }
};

const watchlist = require(path.join(repoRoot, 'backend/functions/flight-watchlist.js')).handler;
const facts = require(path.join(repoRoot, 'backend/functions/flight-facts.js')).handler;

const auth = (t = TOKEN) => (t === null ? {} : { authorization: `Bearer ${t}` });
const get = (headers = auth()) => watchlist({ httpMethod: 'GET', headers });
function observation(over = {}) {
  const sched = new Date(Date.parse(state.pickup) - 15 * 60e3);
  return {
    bookingId: BID, flightNumber: 'AA100', pickupDate: ff.miamiDay(state.pickup),
    airportCode: 'MIA', status: 'active',
    scheduledArrival: sched.toISOString(),
    estimatedArrival: new Date(sched.getTime() + 75 * 60e3).toISOString(),
    observedAt: new Date(Date.now() - 30e3).toISOString(), source: 'muse', ...over
  };
}
const post = (body, headers = auth()) => facts({
  httpMethod: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body)
});
const json = (r) => JSON.parse(r.body);

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

(async () => {
  console.log('\nFlight sensor endpoints (plan step 3)\n');

  // ------------------------------------------------------------- the token
  await check('unconfigured or too-short token: 503 on both endpoints, never 401', async () => {
    for (const tok of [undefined, '', 'short-token']) {
      reset({ FLIGHT_SENSOR_TOKEN: tok });
      for (const r of [await get(auth('anything')), await post(observation(), auth('anything'))]) {
        assert.strictEqual(r.statusCode, 503);
        assert.strictEqual(json(r).error, 'Flight sensor is not configured');
      }
    }
  });

  await check('the off switch wins even with the right token', async () => {
    for (const v of ['1', 'true']) {
      reset({ FLIGHT_SENSOR_DISABLED: v });
      assert.strictEqual((await get()).statusCode, 503);
      assert.strictEqual((await post(observation())).statusCode, 503);
      assert.strictEqual(state.observations.length, 0);
    }
  });

  await check('wrong, missing, or near-miss tokens: 401', async () => {
    reset();
    for (const h of [auth('nope'), auth(null), auth(TOKEN + 'x'), auth(TOKEN.slice(0, -1)),
      { authorization: TOKEN }]) {
      const r = await get(h);
      assert.strictEqual(r.statusCode, h.authorization === TOKEN ? 200 : 401, JSON.stringify(h));
    }
    assert.strictEqual((await post(observation(), auth('nope'))).statusCode, 401);
    assert.strictEqual(state.observations.length, 0);
  });

  await check('the token comparison is constant-time over digests', async () => {
    const src = fs.readFileSync(path.join(repoRoot, 'backend/functions/lib/flight-facts.js'), 'utf8');
    assert.ok(/timingSafeEqual\(digest\(presented\), digest\(expected\)\)/.test(src));
    assert.ok(/createHash\('sha256'\)/.test(src));
  });

  await check('each endpoint answers one method only', async () => {
    reset();
    assert.strictEqual((await watchlist({ httpMethod: 'POST', headers: auth() })).statusCode, 405);
    assert.strictEqual((await facts({ httpMethod: 'GET', headers: auth() })).statusCode, 405);
    assert.strictEqual((await facts({ httpMethod: 'OPTIONS', headers: auth() })).statusCode, 405);
  });

  // ------------------------------------------------------------ watchlist
  const wrow = (over = {}) => ({
    id: BID, flight_number: 'aa 100', airport_code: 'MIA', booking_mode: 'pickup',
    status: 'confirmed', pickup_datetime: '2026-10-07T03:30:00Z', assigned_driver: DRIVER,
    customer_name: 'Pat Doe', customer_phone: '+13055550100', ...over
  });

  await check('the watchlist query: arrivals, live rides with a driver, a 6h/72h window', async () => {
    reset();
    const before = Date.now();
    await get();
    const q = state.watchQuery;
    assert.strictEqual(q.eq.booking_mode, 'pickup');
    assert.deepStrictEqual(q.in.status, ['confirmed', 'on_the_way', 'arrived']);
    assert.deepStrictEqual(q.not.map(([c, op, v]) => `${c} ${op} ${String(v)}`).sort(),
      ['assigned_driver is null', 'flight_number is null']);
    assert.ok(!/name|phone|notes|price|address/.test(q.cols), `selects no personal fields: ${q.cols}`);
    const lo = Date.parse(q.gte[1]); const hi = Date.parse(q.lte[1]);
    assert.ok(Math.abs(lo - (before - 6 * 3600e3)) < 5000 && Math.abs(hi - (before + 72 * 3600e3)) < 5000);
    assert.strictEqual(q.limit, 200);
  });

  await check('the watchlist leaks no person: exactly six flight fields per ride', async () => {
    reset();
    state.watchRows = [wrow()];
    const r = await get();
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['Cache-Control'], 'private, no-store');
    const f = json(r).flights;
    assert.strictEqual(f.length, 1);
    assert.deepStrictEqual(Object.keys(f[0]).sort(),
      ['airportCode', 'bookingId', 'flightNumber', 'pickupAt', 'pickupDate', 'rideStatus']);
    assert.strictEqual(f[0].flightNumber, 'AA100');
    assert.strictEqual(f[0].pickupDate, '2026-10-06', 'MIAMI date of an 11:30 PM pickup');
    assert.ok(!/Pat|0100|aaaaaaaa/.test(r.body), 'no name, phone, or driver id in the body');
  });

  await check('legacy references and missing airports are skipped, never guessed', async () => {
    reset();
    state.watchRows = [wrow({ flight_number: 'INV-2026-0042-LONG' }), wrow({ flight_number: 'tbd' }),
      wrow({ airport_code: null }), wrow({ flight_number: 'B6 1234' })];
    const f = json(await get()).flights;
    assert.deepStrictEqual(f.map((x) => x.flightNumber), ['B61234']);
  });

  await check('the allowlist: unset lists nobody, a list lists its drivers, "*" lists all', async () => {
    const rowsBoth = () => [wrow(), wrow({ id: '223e4567-e89b-42d3-a456-426614174000', assigned_driver: OTHER })];
    reset({ FLIGHT_SENSOR_DRIVER_ALLOWLIST: undefined }); state.watchRows = rowsBoth();
    assert.strictEqual(json(await get()).flights.length, 0);
    reset(); state.watchRows = rowsBoth();
    assert.strictEqual(json(await get()).flights.length, 1);
    reset({ FLIGHT_SENSOR_DRIVER_ALLOWLIST: '*' }); state.watchRows = rowsBoth();
    assert.strictEqual(json(await get()).flights.length, 2);
  });

  await check('a watchlist read failure is a fixed 500 with no database text', async () => {
    reset();
    state.watchError = { message: SECRET_DB_TEXT };
    const r = await get();
    assert.strictEqual(r.statusCode, 500);
    assert.ok(!r.body.includes('secret_internal_table'));
  });

  // -------------------------------------------------------- facts: the path
  await check('a delay observation: stored with the SERVER\'s band, dispatched at once', async () => {
    reset();
    const r = await post(observation());
    assert.strictEqual(r.statusCode, 201, r.body);
    const body = json(r);
    assert.strictEqual(body.band, 'delay_60');
    assert.strictEqual(body.delayMinutes, 75);
    assert.strictEqual(body.notification, 'submitted');
    const row = state.observations[0];
    assert.strictEqual(row.band, 'delay_60');
    assert.strictEqual(row.flight_number, 'AA100');
    assert.strictEqual(row.source, 'muse');
    assert.strictEqual(state.dispatchCalls.length, 1);
    assert.strictEqual(state.dispatchCalls[0].ev.event_type, 'flight_delay_60');
    assert.strictEqual(state.dispatchCalls[0].opts.maxAttempts, 4, 'bounded like release-booking');
    assert.strictEqual(state.bookingWrites, 0, 'tell only: bookings untouched');
  });

  await check('the sensor cannot supply a band', async () => {
    reset();
    const r = await post(observation({ band: 'delay_120' }));
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(state.observations.length, 0);
  });

  await check('on_time and landed are stored, tell no one, dispatch nothing', async () => {
    reset();
    const sched = Date.parse(state.pickup) - 15 * 60e3;
    let r = await post(observation({ estimatedArrival: new Date(sched + 10 * 60e3).toISOString() }));
    assert.strictEqual(json(r).band, 'on_time');
    assert.strictEqual(json(r).notification, null);
    r = await post(observation({ status: 'landed', estimatedArrival: undefined,
      actualArrival: new Date(sched + 5 * 60e3).toISOString(), observedAt: new Date().toISOString() }));
    assert.strictEqual(json(r).band, 'landed');
    assert.strictEqual(state.observations.length, 2);
    assert.strictEqual(state.dispatchCalls.length, 0);
  });

  await check('a sensor retry of the same reading is an idempotent 200, nothing re-sent', async () => {
    reset();
    state.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
    const r = await post(observation());
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(json(r).duplicate, true);
    assert.strictEqual(state.dispatchCalls.length, 0);
  });

  await check('a band already announced earlier: stored, reported already_notified, not re-sent', async () => {
    reset();
    await post(observation());
    state.dispatchCalls = [];
    const r = await post(observation({ observedAt: new Date().toISOString(),
      estimatedArrival: new Date(Date.parse(state.pickup) + 70 * 60e3).toISOString() }));
    assert.strictEqual(r.statusCode, 201);
    assert.strictEqual(json(r).band, 'delay_60');
    assert.strictEqual(json(r).notification, 'already_notified');
    assert.strictEqual(state.dispatchCalls.length, 0);
  });

  await check('the ride changed before the insert: not_created, honestly', async () => {
    reset();
    state.triggerCreates = false;
    const r = await post(observation());
    assert.strictEqual(json(r).notification, 'not_created');
  });

  // ------------------------------------------------ facts: refusals
  await check('an observation that no longer describes the ride: 409, nothing stored', async () => {
    for (const [mut, reason] of [
      [(b) => { b.flight_number = 'DL202'; }, 'flight_mismatch'],
      [(b) => { b.airport_code = 'FLL'; }, 'airport_mismatch'],
      [(b) => { b.pickup_datetime = new Date(Date.parse(b.pickup_datetime) + 48 * 3600e3).toISOString(); }, 'date_mismatch'],
      [(b) => { b.status = 'completed'; }, 'ride_inactive'],
      [(b) => { b.status = 'pending'; b.assigned_driver = null; }, 'ride_inactive'],
      [(b) => { b.booking_mode = 'dropoff'; }, 'not_an_arrival']
    ]) {
      reset();
      mut(state.booking);
      const r = await post(observation());
      assert.strictEqual(r.statusCode, 409, reason);
      assert.strictEqual(json(r).error, reason);
      assert.strictEqual(json(r).refreshWatchlist, true);
      assert.strictEqual(state.observations.length, 0, `${reason}: nothing stored`);
    }
  });

  await check('a driver outside the trial: 409 not_tracked and NO row (or the watchdog would send it)', async () => {
    reset();
    state.booking.assigned_driver = OTHER;
    const r = await post(observation());
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(json(r).error, 'not_tracked');
    assert.strictEqual(state.observations.length, 0);
    reset({ FLIGHT_SENSOR_DRIVER_ALLOWLIST: undefined });
    assert.strictEqual(json(await post(observation())).error, 'not_tracked', 'unset allowlist = nobody');
    assert.strictEqual(state.observations.length, 0);
  });

  await check('unknown booking 404; unreadable booking a fixed 500', async () => {
    reset();
    const r = await post(observation({ bookingId: '323e4567-e89b-42d3-a456-426614174000' }));
    assert.strictEqual(r.statusCode, 404);
    reset();
    state.bookingError = { message: SECRET_DB_TEXT };
    const r2 = await post(observation());
    assert.strictEqual(r2.statusCode, 500);
    assert.ok(!r2.body.includes('secret_internal_table'));
  });

  await check('a failed insert is a fixed 500 with no database text, and nothing dispatched', async () => {
    reset();
    state.insertError = { code: '42501', message: SECRET_DB_TEXT };
    const r = await post(observation());
    assert.strictEqual(r.statusCode, 500);
    assert.ok(!r.body.includes('secret_internal_table'));
    assert.strictEqual(state.dispatchCalls.length, 0);
  });

  await check('malformed requests: bad JSON 400, oversized 413, base64 body accepted', async () => {
    reset();
    assert.strictEqual((await post('{not json')).statusCode, 400);
    assert.strictEqual((await post('x'.repeat(5000))).statusCode, 413);
    const r = await facts({ httpMethod: 'POST', headers: auth(), isBase64Encoded: true,
      body: Buffer.from(JSON.stringify(observation())).toString('base64') });
    assert.strictEqual(r.statusCode, 201, r.body);
  });

  // --------------------------------- notification never fails the write
  await check('a throwing dispatcher: still 201, observation kept, notification deferred', async () => {
    reset();
    state.dispatchBehavior = () => { throw new Error('provider exploded'); };
    const r = await post(observation());
    assert.strictEqual(r.statusCode, 201);
    assert.strictEqual(json(r).notification, 'deferred');
    assert.strictEqual(state.observations.length, 1);
    assert.strictEqual(state.events[0].state, 'pending', 'left for the watchdog');
  });

  await check('an unreadable ledger: still 201, deferred, no dispatch attempted', async () => {
    reset();
    state.eventsError = { message: SECRET_DB_TEXT };
    const r = await post(observation());
    assert.strictEqual(r.statusCode, 201);
    assert.strictEqual(json(r).notification, 'deferred');
    assert.strictEqual(state.dispatchCalls.length, 0);
    assert.ok(!r.body.includes('secret_internal_table'));
  });

  await check('a dispatcher suppression is reported as suppressed, not submitted', async () => {
    reset();
    state.dispatchBehavior = (ev) => { ev.state = 'suppressed'; };
    assert.strictEqual(json(await post(observation())).notification, 'suppressed');
  });

  await check('routes exist and point at the right functions', async () => {
    const toml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
    for (const fn of ['flight-watchlist', 'flight-facts']) {
      assert.ok(toml.includes(`from = "/api/${fn}"\n  to = "/.netlify/functions/${fn}"\n  status = 200`), fn);
      assert.ok(toml.indexOf(`/api/${fn}"`) < toml.indexOf('from = "/*"\n'), `${fn} precedes the catch-all`);
    }
  });

  results.forEach((l) => console.log(l));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})().catch((e) => { console.error(e); process.exit(1); });
