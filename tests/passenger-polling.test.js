// Passenger polling regression harness.
//
// Run:
//   node tests/passenger-polling.test.js
//
// Executes the real inline script from trip.html inside a minimal browser
// harness. No network, browser, framework, or new dependency is required.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'trip.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
const tripScript = scripts.at(-1)[1];

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : !!force;
    if (enabled) this.add(name); else this.remove(name);
    return enabled;
  }
}

class FakeElement {
  constructor(hidden = false) {
    this.classList = new FakeClassList(hidden ? ['hidden'] : []);
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this.attributes = new Map();
    this.listeners = {};
    this.scrollHeight = 500;
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
}

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  };
}

// `storage` may be shared between harnesses to simulate a RELOAD of the
// same browser (persistent localStorage identity — poll anchor + budget).
function createHarness(responses, storage = new Map()) {
  const elements = new Map();
  const hiddenIds = new Set([
    'tripView', 'pausedCard', 'pausedNote', 'mapCard', 'liveMap', 'waBtn',
    'backBtn', 'cancelBtn', 'rebookBtn', 'actionError', 'rideDuration',
    'etaTime', 'flightLine', 'reassignCard', 'cancelQuoteCard'
  ]);
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(hiddenIds.has(id)));
    return elements.get(id);
  };

  const visibilityListeners = [];
  const timers = new Map();
  let nextTimerId = 1;
  let fetchCount = 0;
  const queue = [...responses];

  const document = {
    visibilityState: 'visible',
    body: new FakeElement(),
    head: { appendChild() {} },
    getElementById: element,
    querySelector: () => new FakeElement(),
    querySelectorAll: () => [],
    createElement: () => new FakeElement(),
    addEventListener(type, fn) {
      if (type === 'visibilitychange') visibilityListeners.push(fn);
    }
  };

  const context = {
    console,
    document,
    location: { search: '?id=test-booking', origin: 'https://linkmia.com', href: '' },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    fetch: async () => {
      fetchCount++;
      if (!queue.length) throw new Error('No queued response');
      return queue.shift();
    },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: (fn) => fn(),
    confirm: () => true,
    URLSearchParams,
    Date,
    Math,
    Number,
    JSON,
    encodeURIComponent,
    window: {
      parent: { postMessage() {} }
    }
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(tripScript, context, { filename: 'trip.html:inline-script' });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    context,
    document,
    element,
    storage,
    timers,
    get fetchCount() { return fetchCount; },
    async settle() { await settle(); await settle(); },
    async runNextTimer() {
      assert.ok(timers.size > 0, 'expected a scheduled timer');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.fn();
      await this.settle();
      return timer.delay;
    },
    async setVisible(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      visibilityListeners.forEach((fn) => fn());
      await this.settle();
    },
    evaluate(source) {
      return vm.runInContext(source, context);
    }
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('\u2713 ' + name);
}

(async () => {
  const h = createHarness([response(404)]);
  await h.settle();

  check('404 performs one request and schedules no timer', () => {
    assert.strictEqual(h.fetchCount, 1);
    assert.strictEqual(h.timers.size, 0);
  });
  check('404 replaces the trip with the not-found screen', () => {
    assert.ok(h.element('tripView').classList.contains('hidden'));
    assert.ok(!h.element('loadingMsg').classList.contains('hidden'));
    assert.match(h.element('loadingMsg').innerHTML, /couldn\'t find a booking/i);
  });

  await h.setVisible(false);
  await h.setVisible(true);
  await h.setVisible(false);
  await h.setVisible(true);

  check('404 never restarts on later visibility returns', () => {
    assert.strictEqual(h.fetchCount, 1);
    assert.strictEqual(h.timers.size, 0);
  });

  const pendingBooking = {
    id: 'test-booking', trip_id: 'LM-TEST', status: 'pending',
    pickup_datetime: new Date(Date.now() + 60 * 60000).toISOString(),
    pickup_location: 'Pickup', dropoff_location: 'MIA',
    vehicle_type: 'sedan', vehicle_name: 'Tesla Model Y', price: 85
  };
  const failures = createHarness([
    response(500), response(500), response(500), response(500), response(500),
    response(500), response(200, { booking: pendingBooking, driver: null })
  ]);
  await failures.settle();

  const failureDelays = [];
  for (let attempt = 1; attempt < 5; attempt++) {
    failureDelays.push(await failures.runNextTimer());
  }

  check('five consecutive failures stop all automatic requests', () => {
    assert.strictEqual(failures.fetchCount, 5);
    assert.strictEqual(failures.timers.size, 0);
    assert.deepStrictEqual(failureDelays, [15000, 30000, 60000, 120000]);
    assert.match(failures.element('loadingMsg').textContent, /updates paused because we couldn\'t reach the server/i);
  });

  await failures.settle();
  check('remaining visible after the failure ceiling stays silent', () => {
    assert.strictEqual(failures.fetchCount, 5);
    assert.strictEqual(failures.timers.size, 0);
  });

  await failures.setVisible(false);
  await failures.setVisible(true); // queued 500: exactly one recovery request
  check('failed visibility recovery remains paused after one request', () => {
    assert.strictEqual(failures.fetchCount, 6);
    assert.strictEqual(failures.timers.size, 0);
  });

  await failures.setVisible(false);
  await failures.setVisible(true); // queued success: normal scheduler resumes
  check('successful visibility recovery resumes the healthy cadence', () => {
    assert.strictEqual(failures.fetchCount, 7);
    assert.strictEqual(failures.timers.size, 1);
    assert.strictEqual([...failures.timers.values()][0].delay, 15000);
    assert.ok(!failures.element('tripView').classList.contains('hidden'));
    assert.ok(failures.element('pausedCard').classList.contains('hidden'));
  });
  await failures.setVisible(false);
  check('hiding the page clears the healthy polling timer', () => {
    assert.strictEqual(failures.fetchCount, 7);
    assert.strictEqual(failures.timers.size, 0);
  });

  const farFuture = {
    ...pendingBooking,
    status: 'confirmed',
    pickup_datetime: new Date(Date.now() + 7 * 24 * 3600000).toISOString()
  };
  const sleeping = createHarness([response(200, { booking: farFuture, driver: null })]);
  await sleeping.settle();
  const requestsBeforeWake = sleeping.fetchCount;
  const localWakeDelay = await sleeping.runNextTimer();
  check('far-future confirmed ride wakes locally without a network request', () => {
    assert.strictEqual(requestsBeforeWake, 1);
    assert.strictEqual(sleeping.fetchCount, 1);
    assert.strictEqual(localWakeDelay, 3600000);
    assert.strictEqual(sleeping.timers.size, 1);
  });

  const terminalBooking = { ...pendingBooking, status: 'completed' };
  const terminal = createHarness([response(200, { booking: terminalBooking, driver: null })]);
  await terminal.settle();
  await terminal.setVisible(false);
  await terminal.setVisible(true);
  check('terminal status never restarts on visibility return', () => {
    assert.strictEqual(terminal.fetchCount, 1);
    assert.strictEqual(terminal.timers.size, 0);
  });

  let finishSlowRequest;
  const slowResponse = new Promise((resolve) => { finishSlowRequest = resolve; });
  const overlap = createHarness([slowResponse]);
  await overlap.settle();
  overlap.evaluate('fetchStatus()');
  await overlap.settle();
  check('in-flight guard rejects an overlapping status request', () => {
    assert.strictEqual(overlap.fetchCount, 1);
  });
  finishSlowRequest(response(200, { booking: pendingBooking, driver: null }));
  await overlap.settle();

  // ---- PR 3C-1: reassignment notice + persistent polling identity ----
  const SINCE_1 = '2026-08-14T20:00:00.000Z';
  const SINCE_2 = '2026-08-14T21:30:00.000Z';

  const rea = createHarness([
    response(200, { booking: pendingBooking, driver: null }),
    response(200, { booking: pendingBooking, driver: null, reassigning: true, reassigningSince: SINCE_1 })
  ]);
  await rea.settle();
  check('ordinary pending shows NO reassignment notice', () => {
    assert.ok(rea.element('reassignCard').classList.contains('hidden'));
  });
  await rea.runNextTimer();
  check('released booking (reassigning payload) shows the explicit notice', () => {
    assert.ok(!rea.element('reassignCard').classList.contains('hidden'));
    assert.strictEqual(rea.timers.size, 1, 'pending cadence continues while a new driver is found');
  });
  check('the poll anchor carries the persistent reassigningSince identity', () => {
    const rec = JSON.parse(rea.storage.get('lm_poll_anchor:test-booking'));
    assert.strictEqual(rec.status, 'pending');
    assert.strictEqual(rec.reassigningSince, SINCE_1);
  });

  // RELOAD with the SAME reassigningSince: the stored anchor is REUSED —
  // a reload never grants a fresh pending window (seal 1).
  const agedAt = Date.now() - 9 * 60000;
  rea.storage.set('lm_poll_anchor:test-booking',
    JSON.stringify({ status: 'pending', at: agedAt, reassigningSince: SINCE_1 }));
  const reloaded = createHarness([
    response(200, { booking: pendingBooking, driver: null, reassigning: true, reassigningSince: SINCE_1 })
  ], rea.storage);
  await reloaded.settle();
  check('reload with the SAME reassigningSince reuses the aged anchor — no fresh window per reload', () => {
    const rec = JSON.parse(reloaded.storage.get('lm_poll_anchor:test-booking'));
    assert.strictEqual(rec.at, agedAt, 'the anchor must survive the reload untouched');
    assert.strictEqual(rec.reassigningSince, SINCE_1);
  });
  const secondRelease = createHarness([
    response(200, { booking: pendingBooking, driver: null, reassigning: true, reassigningSince: SINCE_2 })
  ], rea.storage);
  await secondRelease.settle();
  check('a NEW release (new reassigningSince) re-anchors exactly one fresh pending window', () => {
    const rec = JSON.parse(secondRelease.storage.get('lm_poll_anchor:test-booking'));
    assert.strictEqual(rec.reassigningSince, SINCE_2);
    assert.ok(rec.at > agedAt, 'fresh window for the new release');
  });

  // Seal 4: release can NEVER reset the persistent request budget. With
  // the budget spent, the reassigning payload changes nothing — one
  // human-bounded initial render fetch, then the paused card, no timers,
  // and the spend record survives untouched.
  const spentStorage = new Map([['lm_poll_spent:test-booking', '500']]);
  const budget = createHarness([
    response(200, { booking: pendingBooking, driver: null, reassigning: true, reassigningSince: SINCE_1 })
  ], spentStorage);
  await budget.settle();
  check('spent budget survives a release: one initial fetch, paused, budget note, zero timers', () => {
    assert.strictEqual(budget.fetchCount, 1, 'the fresh-page initial render fetch only');
    assert.strictEqual(budget.storage.get('lm_poll_spent:test-booking'), '501',
      'the reassigning payload must never clear or reset the spend record');
    assert.strictEqual(budget.timers.size, 0);
    assert.ok(!budget.element('pausedCard').classList.contains('hidden'));
    assert.match(budget.element('pausedNote').textContent, /update limit reached/i);
    assert.ok(!budget.element('reassignCard').classList.contains('hidden'),
      'the notice still renders honestly from the one bounded fetch');
  });
  await budget.setVisible(false);
  await budget.setVisible(true);
  check('visibility returns get NOTHING past a spent budget, release or not', () => {
    assert.strictEqual(budget.fetchCount, 1);
    assert.strictEqual(budget.storage.get('lm_poll_spent:test-booking'), '501');
    assert.strictEqual(budget.timers.size, 0);
  });

  // Former-driver identity: a driver-less payload resets DRIVER to the
  // page defaults — the released driver's name/phone never lingers.
  const nearConfirmed = {
    ...pendingBooking,
    status: 'confirmed',
    pickup_datetime: new Date(Date.now() + 20 * 60000).toISOString()
  };
  const swap = createHarness([
    response(200, { booking: nearConfirmed, driver: { name: 'Carlos M.', phone: '+13055551212' } }),
    response(200, { booking: nearConfirmed, driver: null }), // transient lookup blip on an ACTIVE ride
    response(200, { booking: pendingBooking, driver: null, reassigning: true, reassigningSince: SINCE_1 })
  ]);
  await swap.settle();
  check('assigned driver personalizes the page', () => {
    assert.strictEqual(swap.evaluate('DRIVER.name'), 'Carlos M.');
    assert.strictEqual(swap.evaluate('DRIVER.phone'), '13055551212');
  });
  await swap.runNextTimer();
  check('driver-less payload on an ACTIVE ride keeps the last-known driver — never a default-number fallback (decision 10)', () => {
    assert.strictEqual(swap.evaluate('DRIVER.name'), 'Carlos M.',
      'a transient server-side lookup blip must not swap the WhatsApp target mid-ride');
    assert.strictEqual(swap.evaluate('DRIVER.phone'), '13055551212');
  });
  await swap.runNextTimer();
  check('release payload wipes the former driver to a NEUTRAL identity: no name, NO phone, WhatsApp hidden, notice shown', () => {
    assert.strictEqual(swap.evaluate('DRIVER.name'), 'your driver',
      'never a real person\'s name for a ride nobody holds');
    assert.strictEqual(swap.evaluate('DRIVER.phone'), null,
      'never a real phone number — the WhatsApp button must have nothing to link');
    assert.ok(swap.element('waBtn').classList.contains('hidden'), 'pending shows no driver contact');
    assert.ok(!swap.element('reassignCard').classList.contains('hidden'));
  });
  check('the status subtitle agrees with the reassignment notice — never "we\'ve notified your driver"', () => {
    assert.match(swap.element('statusSub').textContent, /finding you a new driver/i);
    assert.ok(!/notified your driver/i.test(swap.element('statusSub').textContent));
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((error) => {
  console.error('\nFAIL:', error.stack || error.message);
  process.exit(1);
});
