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

function createHarness(responses) {
  const elements = new Map();
  const hiddenIds = new Set([
    'tripView', 'pausedCard', 'pausedNote', 'mapCard', 'liveMap', 'waBtn',
    'backBtn', 'cancelBtn', 'rebookBtn', 'actionError', 'rideDuration',
    'etaTime', 'flightLine'
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

  const storage = new Map();
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
    timers,
    get fetchCount() { return fetchCount; },
    async settle() { await settle(); await settle(); },
    async setVisible(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      visibilityListeners.forEach((fn) => fn());
      await this.settle();
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

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((error) => {
  console.error('\nFAIL:', error.stack || error.message);
  process.exit(1);
});
