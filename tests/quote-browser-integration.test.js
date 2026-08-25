// PR 3C-2B2 — browser integration of the server quote service.
//
// Run: node tests/quote-browser-integration.test.js
//
// The thing this PR exists to prevent is a split between the price a
// passenger is shown and the price that reaches the database. So the tests
// are weighted toward that: what gets displayed, what gets submitted, and
// every path that could let the browser calculator write either one.
//
// Two layers, following tests/booking-gate-frontend.test.js:
//   1. BEHAVIOR — the app block runs for real under `vm` with a fake DOM.
//      Because SERVER_QUOTE_ENABLED is a block-scoped const that ships
//      false, the enabled path is exercised by compiling the SAME source
//      with the flag flipped to true. The committed default is asserted
//      separately, and the disabled path is compiled and exercised too.
//   2. STATIC — source-shape assertions for the parts that sit inside
//      confirmBooking's modal/session chain, which is too entangled to
//      drive end to end here. Those are labelled STATIC honestly rather
//      than dressed up as behavior.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const indexMvp = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
const carouselHtml = fs.readFileSync(path.join(repoRoot, 'vehicle-carousel-standalone.html'), 'utf8');
const {
  computeCommitment, newJti, signQuoteToken, verifyQuoteToken,
} = require(path.join(repoRoot, 'backend/functions/lib/quote-token.js'));

// The carousel's SHIPPED placeholder figures. These are what a passenger sees
// before anything tells the carousel otherwise, which is exactly why the
// loading/error/expired states have to overwrite them.
const CAROUSEL_DEFAULTS = {};
for (const m of carouselHtml.matchAll(/id="(tesla|escalade|sprinter)-price"[^>]*>([^<]+)</g)) {
  CAROUSEL_DEFAULTS[m[1]] = m[2].trim();
}
assert.deepStrictEqual(Object.keys(CAROUSEL_DEFAULTS).sort(), ['escalade', 'sprinter', 'tesla'],
  'could not read the carousel default prices from the real markup');

// The REAL carousel, loaded out of vehicle-carousel-standalone.html and run in
// its own realm. Its whole script is wrapped in an IIFE, so the auto-construction
// line is swapped for an export from inside — which also stops it building itself
// against a DOM this harness has not set up. Messages are only delivered once the
// carousel has installed its listener, which is the readiness race being tested.
function loadRealCarousel() {
  const script = [...carouselHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).join('\n;\n')
    .replace(/new VehicleCarouselStandalone\(\);?/g,
             'globalThis.__Carousel = VehicleCarouselStandalone;');

  const els = {};
  Object.keys(CAROUSEL_DEFAULTS).forEach((k) => {
    els[`${k}-price`] = { textContent: CAROUSEL_DEFAULTS[k], classList: { add() {}, remove() {} } };
  });
  const mk = () => ({
    style: {}, children: [], textContent: '', attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector: () => null, querySelectorAll: () => [],
  });

  let listener = null;
  const parentMessages = [];
  const parentTargets = [];   // every iframe->parent targetOrigin, in order
  const cctx = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      readyState: 'complete', getElementById: (id) => els[id] || null,
      querySelector: () => mk(), querySelectorAll: () => [],
      addEventListener() {}, createElement: mk, body: mk(),
    },
    window: {
      addEventListener: (t, fn) => { if (t === 'message') listener = fn; },
      parent: { postMessage: (msg, target) => { parentMessages.push(msg); parentTargets.push(target); } },
      getComputedStyle: () => ({ paddingLeft: '0' }),
    },
    location: { origin: 'https://example.test' },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    Set, Map, Math, Date, JSON, Object, Array, Number, String, Boolean, Error,
  };
  cctx.window.parent.window = cctx.window.parent;   // parent !== window -> iframe mode
  cctx.globalThis = cctx;
  vm.createContext(cctx);
  vm.runInContext(script, cctx, { filename: 'vehicle-carousel.js' });
  assert.ok(cctx.__Carousel, 'could not reach the real carousel class');

  const inst = Object.create(cctx.__Carousel.prototype);
  inst.vehicles = [
    { id: 'tesla', name: 'Tesla Model Y', basePrice: 132, passengers: 4, bags: 4 },
    { id: 'escalade', name: 'Cadillac Escalade', basePrice: 165, passengers: 7, bags: 8 },
    { id: 'sprinter', name: 'Mercedes Sprinter', basePrice: 220, passengers: 12, bags: 15 },
  ];
  inst.currentIndex = 0;
  let detectedIndex = 0;
  const scrollCalls = [];
  const cards = inst.vehicles.map((vehicle, index) => {
    const card = mk();
    card.querySelector = (sel) => sel === '.vehicle-price-tag' ? els[`${vehicle.id}-price`] : null;
    card.getBoundingClientRect = () => ({ left: (index - detectedIndex) * 200, width: 100 });
    card.offsetWidth = 100;
    card.offsetLeft = index * 200;
    return card;
  });
  inst.cards = cards;
  inst.track = { children: cards };
  inst.scrollWrapper = {
    getBoundingClientRect: () => ({ left: 0, width: 100 }),
    scrollTo: (options) => {
      scrollCalls.push(options);
      detectedIndex = Math.round(options.left / 200);
    },
  };
  inst.updateActiveStates = () => {};
  inst.updateNavButtons = () => {};

  let ready = false;
  return {
    instance: inst,
    parentMessages,
    parentTargets,
    becomeReady() { inst.setupCommunication(); ready = true; },   // installs the REAL listener
    isReady: () => ready,
    deliver(msg, opts = {}) {
      if (ready && listener) listener({
        data: msg,
        origin: 'origin' in opts ? opts.origin : cctx.location.origin,
        source: 'source' in opts ? opts.source : cctx.window.parent,
      });
    },
    detectAt(index) { detectedIndex = index; inst.detectActiveCard(); },
    viewportIndex: () => detectedIndex,
    scrollCalls,
    visible() {
      const out = {};
      Object.keys(CAROUSEL_DEFAULTS).forEach((k) => { out[k] = els[`${k}-price`].textContent; });
      return out;
    },
  };
}

const inlineBlocks = [...indexMvp.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]).filter((s) => s.trim());
assert.strictEqual(inlineBlocks.length, 2, 'expected the gate block + the app block');
const appBlock = inlineBlocks[1];

let checks = 0;
const results = [];
// Many of these are async. Collect them and await in order, so an async
// assertion can never "pass" by returning an unresolved promise.
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }
async function run() {
  for (const { name, fn } of queue) {
    try {
      if (process.env.TRACE) console.log("->", name);
      await fn();
      checks++;
      results.push(`  ✓ ${name}`);
    } catch (err) {
      results.push(`  ✗ ${name}\n      ${err.message}`);
      results.forEach((r) => console.log(r));
      console.log(`\nFAILED at: ${name}`);
      process.exit(1);
    }
  }
  results.forEach((r) => console.log(r));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  process.exitCode = 0;   // the only success exit — a hung check drains to 1
}

// ---------------- fake DOM ----------------
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, children: [], listeners: {}, attrs: {},
    id: null, innerHTML: '', textContent: '', disabled: false, type: '',
    appendChild(c) { el.children.push(c); c.parent = el; return c; },
    append(...cs) { cs.forEach((c) => el.appendChild(c)); },
    prepend(c) { el.children.unshift(c); c.parent = el; return c; },
    remove() { el.removed = true; if (el.parent) el.parent.children = el.parent.children.filter((x) => x !== el); },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k]; },
    addEventListener(evt, fn) { (el.listeners[evt] = el.listeners[evt] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  };
  return el;
}

let uuidCounter = 0;
function makeContext({ enabled, fetchImpl, sessionToken = 'jwt-abc', carouselReady = true, sessionGate = null }) {
  const source = enabled
    ? appBlock.replace('const SERVER_QUOTE_ENABLED = false;', 'const SERVER_QUOTE_ENABLED = true;')
    : appBlock;
  assert.ok(
    !enabled || source.includes('const SERVER_QUOTE_ENABLED = true;'),
    'flag flip failed — the const declaration changed shape'
  );

  const byId = {};
  const contentSection = makeEl('div');
  const iframe = makeEl('iframe');
  const posted = [];
  const carousel = loadRealCarousel();
  if (carouselReady) carousel.becomeReady();
  const postedTargets = [];   // every parent->iframe targetOrigin, in order
  iframe.contentWindow = { postMessage: (msg, target) => {
    posted.push(msg); postedTargets.push(target); carousel.deliver(msg);
  } };
  byId['vehicle-carousel-frame'] = iframe;

  const document = {
    readyState: 'complete',
    body: makeEl('body'),
    head: makeEl('head'),   // the app block injects the Maps <script> at load
    createElement: makeEl,
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (sel === '#vehiclePanel .content-section' ? contentSection : null),
    querySelectorAll: () => [],
    addEventListener() {},
  };

  const alerts = [];
  const appMessageListeners = [];
  const timers = [];
  let timerId = 0;
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {}, group() {}, groupEnd() {} },
    // indexMVP calls several debug.* channels; tolerate any of them
    debug: new Proxy({}, { get: () => () => {} }),
    document,
    window: {
      addEventListener: (t, fn) => { if (t === 'message') appMessageListeners.push(fn); },
      location: { search: '' }, matchMedia: () => ({ matches: false }),
    },
    // Controllable timers: the TTL expiry must be testable without waiting,
    // and the debounce must not fire on its own.
    setTimeout: (fn, ms) => { timers.push({ id: ++timerId, fn, at: ms || 0 }); return timerId; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    alert: (m) => alerts.push(String(m)),
    // declared by the FIRST inline block (the auth gate), which this harness
    // does not run; the app block reads it as a free variable
    // NEVER settles: the app block self-instantiates when this resolves, and
    // setup() expects the full page DOM. Tests build the instance themselves
    // via Object.create, so the boot path must stay parked.
    bootAuthReady: new Promise(() => {}),
    location: { search: '', href: 'https://example.test/indexMVP.html',
      origin: 'https://example.test', replace() {},
      reload() { ctx.__reloads = (ctx.__reloads || 0) + 1; } },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k)
      };
    })(),
    sessionStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k)
      };
    })(),
    crypto: {
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-' +
        String(++uuidCounter).padStart(12, '0'),
      getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = 7; return arr; }
    },
    PassengerModal: {
      getInstance: () => ({
        hasUserData: () => true,
        openRequired: (cb) => { ctx.__modalOpens = (ctx.__modalOpens || 0) + 1; cb(); },
        getContactInfo: () => ({ name: 'Pat Passenger', phone: '+1 305 555 0100' }),
        getPassengerData: () => null
      })
    },
    navigator: { userAgent: 'test', standalone: false, serviceWorker: { register: async () => ({}) } },
    currentActiveBooking: null,
    currentSession: null,
    getStoredRefCode: () => null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, Set, Map,
    isNaN, parseFloat, parseInt, URL, AbortController,
  };
  ctx.globalThis = ctx;
  // the app block reaches for these via `window.` as well as bare
  ctx.window.navigator = ctx.navigator;
  ctx.window.localStorage = ctx.localStorage;
  ctx.window.location = ctx.location;
  ctx.window.document = ctx.document;
  ctx.window.supabaseClient = {
    auth: {
      getSession: async () => {
        if (sessionGate) await sessionGate;
        return { data: { session: sessionToken ? { access_token: sessionToken, user: { id: 'auth-user-1' } } : null } };
      },
    },
  };
  ctx.supabaseClient = ctx.window.supabaseClient;
  vm.createContext(ctx);
  vm.runInContext(source + '\n;globalThis.__App = AirportBookingApp;', ctx, { filename: 'indexMVP-app.js' });

  const App = ctx.__App;
  // Object.create avoids the constructor, which calls init() -> DOM setup and a
  // dynamic import of pricing.js. Only the quote logic is under test.
  const app = Object.create(App.prototype);
  app.state = {
    mode: 'dropoff',
    locations: { address: { address: '1 Brickell Ave' }, airport: { code: 'MIA' }, placeId: 'ChIJ_place_abc' },
    route: { distance: 10, duration: 20, price: null },
    dateTime: { date: new Date(), time: new Date('2026-09-15T18:00:00Z') },
    vehicle: { type: null, selected: null },
    passengers: 1,
    ui: { currentPanel: 'vehicle' },
    quote: { status: 'idle', key: null, data: null, error: null, seq: 0 },
  };
  app.els = { bookBtn: byId.bookBtn = makeEl('button') };
  app.updateSummary = () => {};
  app.updateBookButton = () => {};
  app.pricingService = null;
  app.pendingEdit = null;
  const runTimers = () => { const due = timers.splice(0); due.forEach((t) => t.fn()); };
  // Default = the genuine same-origin carousel channel; hostile checks
  // override origin/source to prove the listener refuses them.
  const sendToApp = (msg, opts = {}) => appMessageListeners.forEach((fn) => fn({
    data: msg,
    origin: 'origin' in opts ? opts.origin : ctx.location.origin,
    source: 'source' in opts ? opts.source : iframe.contentWindow,
  }));
  ctx.window.airportApp = app;
  return { app, ctx, posted, postedTargets, alerts, byId, contentSection, carousel, runTimers, timers, sendToApp };
}

const SERVER_QUOTE = {
  quote: {
    intent: {
      mode: 'dropoff', airportCode: 'MIA',
      placeId: 'ChIJ_CANONICAL_xyz',        // deliberately NOT the submitted id
      formattedAddress: '1 Brickell Ave, Miami, FL',
      pickupAt: '2026-09-15T18:00:00.000Z', passengers: 1,
    },
    route: { miles: 10, milesTenths: 100, minutes: 20, quality: 'traffic_aware' },
    vehicles: {
      tesla: { ok: true, vehicleName: 'Tesla Model Y', finalCents: 3900, token: 'tok.tesla', expiresAt: null },
      escalade: { ok: true, vehicleName: 'Cadillac Escalade', finalCents: 5500, token: 'tok.escalade', expiresAt: null },
      sprinter: { ok: true, vehicleName: 'Mercedes Sprinter', finalCents: 9500, token: 'tok.sprinter', expiresAt: null },
    },
    vehiclesOk: 3, vehiclesRefused: 0, bookable: true,
    pricingVersion: 'linkmia-parity-2026-08', resolvedVersion: 'linkmia-parity-2026-08',
    cardSource: 'code', ttlMinutes: 15, issuedAt: '2026-09-15T17:00:00.000Z',
  },
};
function quoteWithTtl(minutesFromNow) {
  const q = JSON.parse(JSON.stringify(SERVER_QUOTE));
  const exp = new Date(Date.now() + minutesFromNow * 60000).toISOString();
  Object.keys(q.quote.vehicles).forEach((k) => { q.quote.vehicles[k].expiresAt = exp; });
  return q;
}
const okFetch = (body, status = 200) => {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
};

console.log('\nPR 3C-2B2 — server quote browser integration\n');

// ============ the rollout flag ============
check('STATIC: the committed default is OFF, so merging changes nothing', () => {
  assert.ok(/const SERVER_QUOTE_ENABLED = false;/.test(appBlock),
    'SERVER_QUOTE_ENABLED must ship false');
});

check('DISABLED: no quote request is made and pricing.js still drives the carousel', async () => {
  const f = okFetch(SERVER_QUOTE);
  const { app, runTimers } = makeContext({ enabled: false, fetchImpl: f });
  // AWAITED, so removing the method's dark guard cannot slip past a
  // not-yet-settled fetch: the call must complete having spent nothing
  // and touched nothing.
  await app.requestServerQuote();
  app.scheduleQuote();
  runTimers();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(f.calls.length, 0, 'the disabled build must never call /api/quote-ride');
  assert.strictEqual(app.state.quote.status, 'idle', 'the quote state stays untouched');
  assert.strictEqual(app.state.quote.data, null);
});

check('DISABLED: updateVehiclePrices keeps its legacy early-return, not the new one', () => {
  const { app } = makeContext({ enabled: false, fetchImpl: okFetch(SERVER_QUOTE) });
  app.state.route = { distance: null, duration: null, price: null };
  app.updateVehiclePrices();          // legacy guard: no route data -> returns
  assert.strictEqual(app.state.quote.status, 'idle');
});

// ============ the request contract ============
check('intent carries exactly the five allowed fields — no vehicle, no route facts', () => {
  const { app } = makeContext({ enabled: true, fetchImpl: okFetch(SERVER_QUOTE) });
  const intent = app.quoteIntent();
  assert.deepStrictEqual(Object.keys(intent).sort(),
    ['airportCode', 'mode', 'passengers', 'pickupAt', 'placeId']);
  ['vehicle', 'miles', 'minutes', 'distance', 'duration', 'price', 'bags', 'lat', 'lng']
    .forEach((f) => assert.ok(!(f in intent), `intent must not carry '${f}'`));
});

check('pickupAt always carries a UTC offset', () => {
  const { app } = makeContext({ enabled: true, fetchImpl: okFetch(SERVER_QUOTE) });
  const { pickupAt } = app.quoteIntent();
  assert.ok(/Z$|[+-]\d{2}:\d{2}$/.test(pickupAt),
    `an offset-less instant is reinterpreted in the server zone: ${pickupAt}`);
});

check('intent is null until airport, place_id and pickup time all exist', () => {
  const { app } = makeContext({ enabled: true, fetchImpl: okFetch(SERVER_QUOTE) });
  app.state.locations.placeId = null;
  assert.strictEqual(app.quoteIntent(), null, 'no place_id -> no quote');
  app.state.locations.placeId = 'ChIJ_place_abc';
  app.state.dateTime.time = null;
  assert.strictEqual(app.quoteIntent(), null, 'no pickup time -> no quote');
});

check('the request posts intent to /api/quote-ride with the session bearer token', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 1);
  const [call] = f.calls;
  assert.strictEqual(call.url, '/api/quote-ride');
  assert.strictEqual(call.opts.method, 'POST');
  assert.strictEqual(call.opts.headers.Authorization, 'Bearer jwt-abc');
  assert.deepStrictEqual(JSON.parse(call.opts.body), {
    mode: 'dropoff', airportCode: 'MIA', placeId: 'ChIJ_place_abc',
    pickupAt: '2026-09-15T18:00:00.000Z', passengers: 1,
  });
});

// ============ display ============
check('displayed carousel prices are the SERVER cents, converted to dollars', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, posted } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  assert.strictEqual(app.state.quote.status, 'ready');
  const priceMsg = posted.filter((m) => m.type === 'updatePrices').pop();
  // the payload is built inside the vm realm, so compare by value
  assert.deepStrictEqual(JSON.parse(JSON.stringify(priceMsg.data)),
    { tesla: 39, escalade: 55, sprinter: 95 });
});

check('OVERWRITE GUARD: updateVehiclePrices never posts a browser price when enabled', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, posted } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  const afterQuote = posted.length;
  // pricing.js is present and would happily produce numbers
  app.pricingService = {
    getAllVehicles: () => ['tesla', 'escalade', 'sprinter'],
    getVehicleConfig: () => ({ name: 'x', capacity: { passengers: 4, bags: 4 } }),
    calculateVehiclePrice: () => ({ finalPrice: 12345, breakdown: { appliedSurcharges: [] } }),
    checkSurgePeriod: () => ({ hasSurge: false }),
  };
  app.updateVehiclePrices();
  const newPriceMsgs = posted.slice(afterQuote).filter((m) => m.type === 'updatePrices');
  assert.strictEqual(newPriceMsgs.length, 0,
    'the browser calculator must never overwrite the displayed server price');
  assert.strictEqual(app.state.route.price, 39,
    'the server price must survive untouched — 12345 here would mean pricing.js won');
  assert.strictEqual(app.state.vehicle.price, 39);
});

// ============ vehicle selection binds the right token ============
check('selecting a vehicle takes THAT vehicle\'s own token and price', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'escalade', name: 'Cadillac Escalade', passengers: 7, bags: 8, price: 55 });
  assert.strictEqual(app.state.vehicle.quoteToken, 'tok.escalade');
  assert.strictEqual(app.state.vehicle.price, 55);
  app.selectVehicle({ id: 'sprinter', name: 'Mercedes Sprinter', passengers: 12, bags: 15, price: 95 });
  assert.strictEqual(app.state.vehicle.quoteToken, 'tok.sprinter',
    'a vehicle switch must never leave the previous vehicle\'s token attached');
  assert.strictEqual(app.state.vehicle.price, 95);
});

// ============ invalidation ============
check('changing the pickup time invalidates the quote and clears the token', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  assert.strictEqual(app.state.vehicle.quoteToken, 'tok.tesla');
  app.invalidateQuote('pickup time changed');
  assert.strictEqual(app.state.quote.status, 'idle');
  assert.strictEqual(app.state.quote.data, null);
  assert.strictEqual(app.state.vehicle.quoteToken, null);
  assert.strictEqual(app.quoteIsFresh(), false);
});

check('a quote is stale when the intent no longer matches it', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  assert.strictEqual(app.quoteIsFresh(), true);
  app.state.locations.airport = { code: 'FLL' };   // intent moved, quote did not
  assert.strictEqual(app.quoteIsFresh(), false,
    'a quote priced for MIA must not be usable for FLL');
});

check('an expired quote is not fresh even if the intent still matches', async () => {
  const f = okFetch(quoteWithTtl(-1));             // already past its TTL
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  assert.strictEqual(app.state.quote.status, 'ready');
  assert.strictEqual(app.quoteIsFresh(), false);
});

check('a response that lands after the intent moved on is dropped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const impl = async () => { await gate; return { ok: true, status: 200, json: async () => quoteWithTtl(15) }; };
  const { app } = makeContext({ enabled: true, fetchImpl: impl });
  const inflight = app.requestServerQuote();
  app.invalidateQuote('address changed');          // bumps seq while in flight
  release();
  await inflight;
  assert.strictEqual(app.state.quote.data, null, 'the stale answer must not be applied');
  assert.strictEqual(app.state.quote.status, 'idle');
});

// ============ failure blocks, never falls back ============
check('a 502 leaves an error state and no prices — no browser fallback', async () => {
  const f = okFetch({ error: 'Could not compute the route right now' }, 502);
  const { app, posted } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  assert.strictEqual(app.state.quote.status, 'error');
  assert.strictEqual(app.state.quote.error.retryable, true);
  assert.strictEqual(posted.filter((m) => m.type === 'updatePrices').length, 0);
});

check('a 400 identity refusal is surfaced as non-retryable', async () => {
  const f = okFetch({ error: 'That address could not be resolved — please reselect it' }, 400);
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  assert.strictEqual(app.state.quote.status, 'error');
  assert.strictEqual(app.state.quote.error.retryable, false);
  assert.match(app.state.quote.error.message, /reselect/);
});

check('a 200 that is not bookable is an error, not a price of zero', async () => {
  const body = JSON.parse(JSON.stringify(SERVER_QUOTE));
  body.quote.bookable = false; body.quote.vehiclesOk = 0;
  Object.keys(body.quote.vehicles).forEach((key) => {
    body.quote.vehicles[key] = { ok: false, error: 'capacity' };
  });
  const { app, posted } = makeContext({ enabled: true, fetchImpl: okFetch(body) });
  await app.requestServerQuote();
  assert.strictEqual(app.state.quote.status, 'error');
  assert.strictEqual(posted.filter((m) => m.type === 'updatePrices').length, 0);
});

check('COST: an incomplete 200 is a non-retryable LinkMia defect, never a paid re-quote loop', async () => {
  const body = quoteWithTtl(15);
  delete body.quote.vehicles.tesla.token;
  const f = okFetch(body);
  const { app, carousel, alerts } = makeContext({ enabled: true, fetchImpl: f });

  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(app.state.quote.status, 'error');
  assert.strictEqual(app.state.quote.error.retryable, false,
    'a broken successful response is our configuration defect, not a provider retry');
  assert.match(app.state.quote.error.message, /contact LinkMia/i);
  assert.deepStrictEqual(carousel.visible(),
    { tesla: 'Unavailable', escalade: 'Unavailable', sprinter: 'Unavailable' });
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, true, 'Book must remain fail-closed');

  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 1,
    're-entering Vehicle must not buy the same malformed response again');
  await app.confirmBooking();
  assert.strictEqual(f.calls.length, 1,
    'the blocked Book path must not force-buy the malformed response again');
  // PR-2 quiet UX: permanent failures speak through the PERSISTENT banner
  // (state carries the honest message, Book stays disabled) — never an alert.
  assert.strictEqual(alerts.length, 0,
    'permanent failures are banner-spoken; alerts were removed in PR-2');
  assert.match(app.state.quote.error.message, /contact LinkMia/i);
});

check('COST: a 200 with missing or extra vehicle cards is incomplete and never re-bought', async () => {
  const variants = [
    (quote) => { delete quote.quote.vehicles.escalade; quote.quote.vehiclesOk = 2; },
    (quote) => {
      quote.quote.vehicles.limousine = { ...quote.quote.vehicles.tesla };
      quote.quote.vehiclesOk = 4;
    }
  ];

  for (const mutate of variants) {
    const body = quoteWithTtl(15);
    mutate(body);
    const f = okFetch(body);
    const { app, carousel } = makeContext({ enabled: true, fetchImpl: f });

    await app.requestServerQuote();
    assert.strictEqual(app.state.quote.status, 'error');
    assert.strictEqual(app.state.quote.error.retryable, false);
    assert.deepStrictEqual(carousel.visible(),
      { tesla: 'Unavailable', escalade: 'Unavailable', sprinter: 'Unavailable' });
    await app.requestServerQuote();
    assert.strictEqual(f.calls.length, 1,
      'a malformed vehicle set must not trigger another paid request');
  }
});

check('Book is disabled without a fresh quote and enabled with one', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, true, 'no quote -> Book blocked');
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, false, 'fresh quote + vehicle -> Book allowed');
  app.invalidateQuote('address changed');
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, true, 'invalidated -> Book blocked again');
});

check('Book stays blocked when a quote exists but no vehicle is chosen', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, true);
});

// ============ submit ============
check('PR-2: a submission exists only downstream of a real tap — direct confirmBooking is inert', async () => {
  const f = okFetch(quoteWithTtl(-1));
  const { app, alerts } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.state.vehicle = { type: 'tesla', selected: 'tesla' };
  const before = f.calls.length;
  await app.confirmBooking();   // no tap snapshot exists
  assert.strictEqual(f.calls.length, before, 'no fetch of any kind without a tap');
  assert.strictEqual(alerts.length, 0, 'and no alert — the button state is the message');
});

check('the price source is the selected vehicle\'s server cents', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'escalade', name: 'Cadillac Escalade', passengers: 7, bags: 8, price: 55 });
  const sv = app.selectedQuoteVehicle();
  assert.strictEqual(sv.finalCents / 100, 55);
  assert.strictEqual(sv.token, 'tok.escalade');
});

check('STATIC: the submitted total comes from the quote, and the legacy chain is flag-gated', () => {
  const m = appBlock.match(/pricing:\s*\(\(\)\s*=>\s*\{[\s\S]*?\}\)\(\),/);
  assert.ok(m, 'the pricing block should be a flag-gated expression');
  const body = m[0];
  assert.ok(/if \(serverQuoteContract\)/.test(body), 'must branch on the frozen submission contract');
  assert.ok(/finalCents \/ 100/.test(body), 'enabled branch must use server cents');
  const enabledBranch = body.slice(body.indexOf('if (serverQuoteContract)'), body.indexOf('const legacy'));
  assert.ok(!/pricingService|state\.vehicle\.pricing/.test(enabledBranch),
    'the enabled branch must not consult pricing.js at all');
});

check('STATIC: the payload helper carries every canonical commitment input', () => {
  assert.ok(/attachServerQuoteContract\(apiPayload, serverQuoteContract\)/.test(appBlock));
  for (const field of ['quoteToken', 'placeId', 'airportCode', 'vehicleKey',
    'routeMilesTenths', 'routeMinutes', 'pricingVersion']) {
    assert.ok(new RegExp(`apiPayload\\.${field} =`).test(appBlock), `${field} must be submitted`);
  }
  assert.ok(/delete apiPayload\.durationMinutes/.test(appBlock),
    'a verified request must not carry the browser route cache as a second duration truth');
});

check('CONTRACT: the real browser payload verifies against a real v2 token', async () => {
  const secret = 'browser-contract-secret-'.padEnd(40, 'x');
  const keyId = 'browser-contract-v2';
  const now = Date.now();
  const pickupAtMs = Date.parse(SERVER_QUOTE.quote.intent.pickupAt);
  const intent = {
    mode: SERVER_QUOTE.quote.intent.mode,
    airportCode: SERVER_QUOTE.quote.intent.airportCode,
    placeId: SERVER_QUOTE.quote.intent.placeId,
    pickupAtMs,
    passengers: SERVER_QUOTE.quote.intent.passengers,
    routeMilesTenths: SERVER_QUOTE.quote.route.milesTenths,
    routeMinutes: SERVER_QUOTE.quote.route.minutes,
  };
  const finalCents = SERVER_QUOTE.quote.vehicles.escalade.finalCents;
  const token = signQuoteToken({
    purpose: 'create', jti: newJti(), authUserId: '44444444-4444-4444-8444-444444444444', customerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    vehicle: 'escalade', pickupAtMs,
    commitment: computeCommitment(intent, 'escalade', finalCents, secret),
    routeQuality: 'traffic_aware', finalCents,
    pricingVersion: 'linkmia-parity-2026-08', engineVersion: 'ride-quote-v1',
    resolvedVersion: 'linkmia-parity-2026-08',
  }, { keyId, secret, nowMs: now });

  const response = quoteWithTtl(15);
  response.quote.vehicles.escalade.token = token;
  const { app } = makeContext({ enabled: true, fetchImpl: okFetch(response) });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'escalade', name: 'Cadillac Escalade', passengers: 7, bags: 8, price: 55 });

  const contract = app.captureServerQuoteContract();
  assert.ok(contract, 'a fresh selected quote must produce one immutable submission contract');
  const payload = app.attachServerQuoteContract({
    mode: app.state.mode,
    dateTime: app.state.dateTime.time,
    passengers: app.state.passengers,
    vehicle: app.state.vehicle.name,
    durationMinutes: app.state.route.duration,
  }, contract);
  assert.strictEqual(payload.quoteToken, token);
  assert.strictEqual(payload.placeId, intent.placeId);
  assert.strictEqual(payload.airportCode, intent.airportCode);
  assert.strictEqual(payload.vehicleKey, 'escalade');
  assert.strictEqual(payload.routeMilesTenths, 100);
  assert.strictEqual(payload.routeMinutes, 20);
  assert.ok(!Object.hasOwn(payload, 'durationMinutes'),
    'legacy browser duration must not accompany a verified quote');

  const expectedIntent = {
    mode: payload.mode,
    airportCode: payload.airportCode,
    placeId: payload.placeId,
    pickupAtMs: Date.parse(payload.dateTime),
    passengers: payload.passengers,
    routeMilesTenths: payload.routeMilesTenths,
    routeMinutes: payload.routeMinutes,
  };
  const verified = verifyQuoteToken(payload.quoteToken, {
    keys: [{ id: keyId, secret }], nowMs: now + 1,
    expected: {
      purpose: 'create', authUserId: '44444444-4444-4444-8444-444444444444', customerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      vehicle: payload.vehicleKey, intent: expectedIntent,
    },
  });
  assert.strictEqual(verified.ok, true,
    'the final browser payload must contain every value needed to recompute the commitment');
});

check('SUBMIT RACE: an auth await cannot pair booking A with quote/vehicle B', async () => {
  const response = quoteWithTtl(15);
  const f = okFetch(response);
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.selectVehicle({
    id: 'escalade', name: 'Cadillac Escalade', passengers: 7, bags: 8, price: 55
  });

  let releaseSession;
  let sessionEntered;
  const sessionGate = new Promise((resolve) => { releaseSession = resolve; });
  const sessionStarted = new Promise((resolve) => { sessionEntered = resolve; });
  ctx.window.supabaseClient.auth.getSession = async () => {
    sessionEntered();
    await sessionGate;
    return { data: { session: { access_token: 'jwt-submit-race' } } };
  };
  ctx.PassengerModal = {
    getInstance: () => ({
      hasUserData: () => true,
      openRequired: (cb) => cb(),
      getContactInfo: () => ({ name: 'Passenger', phone: '3055550100', type: 'booker' }),
      getPassengerData: () => ({ type: 'self', data: null }),
    }),
  };
  let shownError = '';
  app.showPaymentError = (message) => { shownError = String(message); };

  const callsBeforeSubmit = f.calls.length;
  // PR-2: submissions exist only downstream of the tap boundary. Enter
  // through the real tap and capture the confirm promise it fires.
  let pending;
  const realConfirm = app.confirmBooking.bind(app);
  app.confirmBooking = () => { pending = realConfirm(); return pending; };
  app.handleBookingClick();
  assert.ok(pending, 'the tap must freeze a snapshot and reach confirmBooking');
  await sessionStarted;
  // This is the exact race: while session refresh yields, the passenger (or
  // another UI event) moves the mutable carousel to a different vehicle.
  app.selectVehicle({
    id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39
  });
  releaseSession();
  await pending;

  assert.strictEqual(f.calls.length, callsBeforeSubmit,
    'a changed submission snapshot must stop before the booking POST');
  assert.match(shownError, /changed while booking/i);
});

check('STATIC: place_id is retained from autocomplete instead of discarded', () => {
  assert.ok(/this\.state\.locations\.placeId =/.test(appBlock),
    'handleAddressSelected must keep the place_id it receives');
  assert.ok(/placeId !== 'unknown'/.test(appBlock),
    "autocomplete's 'unknown' sentinel must not be sent as a place id");
});

check('STATIC: pricing.js survives only as a shadow that is logged, never displayed', () => {
  assert.ok(/shadowComparePricing\(\)/.test(appBlock));
  const fn = appBlock.slice(appBlock.indexOf('shadowComparePricing() {'));
  const body = fn.slice(0, fn.indexOf('\n            renderQuoteState'));
  assert.ok(/console\.log/.test(body), 'the shadow reports to the console');
  assert.ok(!/postMessage|state\.route\.price\s*=|state\.vehicle\.price\s*=/.test(body),
    'the shadow must never write a displayed or submitted price');
});

// ==================== correction round ====================

check('RACE: a response parsed after the intent moved on is dropped', async () => {
  // The header check alone is not enough — res.json() is itself an await.
  let releaseJson;
  const jsonGate = new Promise((r) => { releaseJson = r; });
  const impl = async () => ({
    ok: true, status: 200,
    json: async () => { await jsonGate; return quoteWithTtl(15); },
  });
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: impl });
  const inflight = app.requestServerQuote();
  await Promise.resolve();
  app.invalidateQuote('address changed while the body was parsing');
  releaseJson();
  await inflight;
  assert.strictEqual(app.state.quote.data, null,
    'a body parsed after the intent changed must not be stored under the new key');
  assert.strictEqual(app.state.quote.status, 'idle');
  assert.ok(!Object.values(carousel.visible()).some((v) => v === '$39'),
    'the dropped quote must not reach the screen');
});

check('CAROUSEL: the shipped default prices are real and get replaced while loading', async () => {
  assert.deepStrictEqual(CAROUSEL_DEFAULTS, { tesla: '$132', escalade: '$165', sprinter: '$220' });
  let release;
  const gate = new Promise((r) => { release = r; });
  const impl = async () => { await gate; return { ok: true, status: 200, json: async () => quoteWithTtl(15) }; };
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: impl });
  const inflight = app.requestServerQuote();
  await Promise.resolve();
  assert.deepStrictEqual(carousel.visible(), { tesla: '…', escalade: '…', sprinter: '…' },
    'markup placeholders must not sit on screen while a price is being fetched');
  release();
  await inflight;
  assert.deepStrictEqual(carousel.visible(), { tesla: '$39', escalade: '$55', sprinter: '$95' });
});

check('CAROUSEL: a failed quote replaces the visible prices, it does not leave them', async () => {
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: okFetch(quoteWithTtl(15)) });
  await app.requestServerQuote();
  assert.strictEqual(carousel.visible().tesla, '$39');
  app.state.quote.status = 'error';
  app.state.quote.error = { message: 'Could not compute the route right now', retryable: true };
  app.renderQuoteState();
  assert.deepStrictEqual(carousel.visible(),
    { tesla: 'Unavailable', escalade: 'Unavailable', sprinter: 'Unavailable' },
    'a stale good price must never survive a failure');
});

check('CAROUSEL: invalidation clears the visible prices', async () => {
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: okFetch(quoteWithTtl(15)) });
  await app.requestServerQuote();
  assert.strictEqual(carousel.visible().escalade, '$55');
  app.invalidateQuote('pickup time changed');
  assert.deepStrictEqual(carousel.visible(), { tesla: '—', escalade: '—', sprinter: '—' });
});

check('TTL: a timer expires the visible price; Book stays CLICKABLE as "Refresh and Book"', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, carousel, runTimers } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, false);
  assert.strictEqual(carousel.visible().tesla, '$39');

  // the quote reaches its TTL while the passenger is still on the screen
  const past = new Date(Date.now() - 1000).toISOString();
  const callsAtExpiry = f.calls.length;
  Object.keys(app.state.quote.data.vehicles).forEach((k) => {
    app.state.quote.data.vehicles[k].expiresAt = past;
  });
  runTimers();

  assert.deepStrictEqual(carousel.visible(),
    { tesla: 'Expired', escalade: 'Expired', sprinter: 'Expired' },
    'an expired price must stop looking valid on screen');
  // PR-2 passive expiry (ratified DQ-1): the primary action stays
  // PHYSICALLY clickable and honestly labeled — the tap performs the
  // quiet refresh. Idle expiry itself buys zero provider calls.
  assert.strictEqual(app.els.bookBtn.disabled, false,
    'the stale primary action must remain clickable');
  assert.match(app.els.bookBtn.innerHTML, /Refresh and Book/,
    'the label must say the tap refreshes first');
  assert.strictEqual(f.calls.length, callsAtExpiry,
    'expiring while idle must not trigger any provider call');
});

check('COST: a permanent refusal is not re-bought when Vehicle is reopened', async () => {
  const f = okFetch({ error: 'That address could not be resolved — please reselect it' }, 400);
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 1);
  await app.requestServerQuote();          // same intent, e.g. re-entering the panel
  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 1, 'a non-retryable refusal must not buy another Google call');
  await app.requestServerQuote({ force: true });
  assert.strictEqual(f.calls.length, 2, 'an explicit retry still tries');
});

check('COST: a retryable failure IS retried when asked again', async () => {
  const f = okFetch({ error: 'Could not reach the pricing service' }, 502);
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 2, 'a transient failure is allowed to try again');
});

check('COST: no quote is bought before the passenger reaches the Vehicle step', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, runTimers } = makeContext({ enabled: true, fetchImpl: f });
  ['where', 'when'].forEach((panel) => {
    app.state.ui.currentPanel = panel;
    app.updateVehiclePrices();   // what a route or time change triggers
    runTimers();
  });
  assert.strictEqual(f.calls.length, 0,
    'route and time edits on earlier screens must not spend on Google');
  app.state.ui.currentPanel = 'vehicle';
  app.updateVehiclePrices();
  runTimers();
  await new Promise((r) => setTimeout(r, 0));   // let the queued request reach fetch
  assert.strictEqual(f.calls.length, 1, 'the Vehicle step is where a price is actually needed');
});

check('SCOPE: an edit quote is edit-scoped — key, request body, and Save gating', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  // A create-scoped quote exists first…
  await app.requestServerQuote();
  const createKey = app.state.quote.key;
  assert.strictEqual(f.calls.length, 1);

  // …then a pending edit begins. PR-2: edits DO quote, in their own scope,
  // so a create-scoped quote can never impersonate an edit quote.
  app.pendingEdit = { bookingId: 'b-1', tripCode: 'LM-1', detailsVersion: 3 };
  app.editMarkers = {
    routeDirection: false, routeAddress: false,
    pickupAt: false, vehicle: false, traveler: false
  };
  assert.strictEqual(app.quoteFlowActive(), true,
    'PR-2: pending edits use the quote flow too');
  const editKey = app.quoteKey(app.quoteIntent());
  assert.notStrictEqual(editKey, createKey,
    'the same trip facts must key differently under an edit');
  assert.match(editKey, /\|edit\|b-1\|3$/,
    'the edit scope names the booking and its captured version');

  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 2,
    'the cached create-scoped quote must not answer an edit');
  const sentBody = JSON.parse(f.calls[1].opts.body);
  assert.strictEqual(sentBody.bookingId, 'b-1',
    'edit quotes carry the booking identity');
  assert.strictEqual(sentBody.expectedDetailsVersion, 3,
    'edit quotes carry the captured CAS version');

  // Interaction markers: a fresh edit quote + selected vehicle is still not
  // enough — Save stays blocked until route, pickup time, and vehicle were
  // each EXPLICITLY chosen in this edit session (prefilled never counts).
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  app.updateBookAvailability();
  assert.strictEqual(app.editMarkers.vehicle, true,
    'an explicit vehicle choice sets its marker');
  assert.strictEqual(app.els.bookBtn.disabled, true,
    'Save stays blocked while route/pickup markers are unset');
  app.editMarkers.routeDirection = true;
  app.editMarkers.routeAddress = true;
  app.editMarkers.pickupAt = true;
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, false,
    'all explicit markers + a fresh quote unlock Save');
  assert.match(app.els.bookBtn.innerHTML, /Save changes/,
    'the edit flow labels the primary action Save, not Book');
});

check('STATIC: the endpoint names its access mode instead of inferring it', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'backend/functions/quote-ride.js'), 'utf8');
  assert.ok(/QUOTE_ACCESS_MODE/.test(src), 'access must be an explicit named mode');
  assert.ok(/\|\| 'allowlist'/.test(src), 'the default must be the restrictive mode');
  assert.ok(/accessMode === 'allowlist' && !allowlistRaw/.test(src),
    'the allowlist is required only in allowlist mode, so removing it cannot 500');
  assert.ok(!/!placesKey \|\| !allowlistRaw/.test(src),
    'the allowlist must no longer be an unconditional configuration requirement');
});

check('STATIC: quote-ride recovers an ambassador identity exactly like create-booking', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'backend/functions/quote-ride.js'), 'utf8');
  assert.ok(/from\('hosts'\)/.test(src) && /eq\('status', 'active'\)/.test(src),
    'an active ambassador host row is the approved recovery source');
  assert.ok(/from\('customers'\)[\s\S]{0,400}\.insert/.test(src), 'the row is minted, not refused');
  assert.ok(/ambassadorHost\.name/.test(src) && !/booking\.customerName/.test(src),
    'identity comes from the HOST record, never from passenger details');
});

// ============ narrow-review round ============

check('READINESS: a placeholder posted before the iframe listens is replayed, not lost', async () => {
  // The carousel installs its message listener when it boots. Anything posted
  // before that is dropped on the floor — and its markup ships real-looking
  // prices, so a dropped placeholder leaves $132/$165/$220 on screen.
  let release;
  const gate = new Promise((r) => { release = r; });
  const impl = async () => { await gate; return { ok: true, status: 200, json: async () => quoteWithTtl(15) }; };
  const { app, carousel, sendToApp } = makeContext({ enabled: true, fetchImpl: impl, carouselReady: false });

  const inflight = app.requestServerQuote();
  await Promise.resolve();
  assert.deepStrictEqual(carousel.visible(), CAROUSEL_DEFAULTS,
    'sanity: the placeholder was posted before the carousel could hear it');

  carousel.becomeReady();
  sendToApp({ type: 'carouselReady' });
  assert.deepStrictEqual(carousel.visible(), { tesla: '…', escalade: '…', sprinter: '…' },
    'carouselReady must replay the PLACEHOLDER, not only prices');

  release();
  await inflight;
  assert.deepStrictEqual(carousel.visible(), { tesla: '$39', escalade: '$55', sprinter: '$95' });
});

check('READINESS: prices posted before the iframe listens are replayed too', async () => {
  const { app, carousel, sendToApp } = makeContext({
    enabled: true, fetchImpl: okFetch(quoteWithTtl(15)), carouselReady: false,
  });
  await app.requestServerQuote();
  assert.deepStrictEqual(carousel.visible(), CAROUSEL_DEFAULTS, 'sanity: all messages dropped');
  carousel.becomeReady();
  sendToApp({ type: 'carouselReady' });
  assert.deepStrictEqual(carousel.visible(), { tesla: '$39', escalade: '$55', sprinter: '$95' });
});

check('REFUSED: a vehicle the engine refused reads Unavailable, not a stale placeholder', async () => {
  const body = JSON.parse(JSON.stringify(SERVER_QUOTE));
  body.quote.vehicles.sprinter = { ok: false, error: { code: 'passenger_capacity_exceeded' } };
  body.quote.vehiclesOk = 2; body.quote.vehiclesRefused = 1;
  const exp = new Date(Date.now() + 15 * 60000).toISOString();
  ['tesla', 'escalade'].forEach((k) => { body.quote.vehicles[k].expiresAt = exp; });

  const { app, carousel } = makeContext({ enabled: true, fetchImpl: okFetch(body) });
  await app.requestServerQuote();
  assert.deepStrictEqual(carousel.visible(),
    { tesla: '$39', escalade: '$55', sprinter: 'Unavailable' },
    'a refused vehicle must say so rather than sit on the loading placeholder');
});

check('REFUSED: a refused vehicle cannot be selected in the real carousel', async () => {
  const body = JSON.parse(JSON.stringify(SERVER_QUOTE));
  body.quote.vehicles.sprinter = { ok: false, error: { code: 'distance_exceeds_service_area' } };
  body.quote.vehiclesOk = 2; body.quote.vehiclesRefused = 1;
  const exp = new Date(Date.now() + 15 * 60000).toISOString();
  ['tesla', 'escalade'].forEach((k) => { body.quote.vehicles[k].expiresAt = exp; });

  const { app, carousel } = makeContext({ enabled: true, fetchImpl: okFetch(body) });
  await app.requestServerQuote();
  const before = carousel.instance.currentIndex;
  carousel.instance.selectCard(2);                      // sprinter
  assert.strictEqual(carousel.instance.currentIndex, before,
    'selecting an unbookable vehicle must be refused');
  carousel.instance.selectCard(1);                      // escalade
  assert.strictEqual(carousel.instance.currentIndex, 1, 'available vehicles still select');
});

check('REFUSED RECOVERY: a later all-valid quote re-enables the real card', async () => {
  const refused = quoteWithTtl(15);
  refused.quote.vehicles.sprinter = { ok: false, error: { code: 'passenger_capacity_exceeded' } };
  refused.quote.vehiclesOk = 2; refused.quote.vehiclesRefused = 1;
  const allValid = quoteWithTtl(15);
  const bodies = [refused, allValid];
  let call = 0;
  const impl = async () => ({
    ok: true, status: 200,
    json: async () => bodies[Math.min(call++, bodies.length - 1)],
  });
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: impl });

  await app.requestServerQuote();
  assert.strictEqual(carousel.instance.unavailableIds.has('sprinter'), true);
  assert.strictEqual(carousel.visible().sprinter, 'Unavailable');
  assert.strictEqual(carousel.instance.track.children[2].style.pointerEvents, 'none');

  await app.requestServerQuote({ force: true });
  assert.strictEqual(carousel.instance.unavailableIds.size, 0,
    'the new quote must replace the old disabled set with []');
  assert.strictEqual(carousel.visible().sprinter, '$95');
  assert.strictEqual(carousel.instance.track.children[2].style.pointerEvents, '');
  assert.strictEqual(carousel.instance.track.children[2].getAttribute('aria-disabled'), 'false');
  carousel.instance.selectCard(2);
  assert.strictEqual(carousel.instance.currentIndex, 2,
    'a vehicle made bookable again must be selectable in the same page session');
});

check('REFUSED SCROLL: centering a refused card neither selects nor notifies it', async () => {
  const body = quoteWithTtl(15);
  body.quote.vehicles.sprinter = { ok: false, error: { code: 'distance_exceeds_service_area' } };
  body.quote.vehiclesOk = 2; body.quote.vehiclesRefused = 1;
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: okFetch(body) });
  await app.requestServerQuote();

  carousel.parentMessages.length = 0;
  carousel.detectAt(2);                                // scroll centers Sprinter
  assert.strictEqual(carousel.instance.currentIndex, 0,
    'scroll detection must not activate a vehicle the server refused');
  const selections = carousel.parentMessages.filter((m) => m && m.type === 'vehicleSelected');
  assert.strictEqual(selections.length, 0,
    'scroll detection must not emit vehicleSelected for a refused card');
});

check('REFUSED SCROLL: the viewport snaps back so a recovered card cannot differ from the booked vehicle', async () => {
  const refused = quoteWithTtl(15);
  refused.quote.vehicles.tesla = { ok: false, error: { code: 'passenger_capacity_exceeded' } };
  refused.quote.vehiclesOk = 2; refused.quote.vehiclesRefused = 1;
  const allValid = quoteWithTtl(15);
  const bodies = [refused, allValid];
  let call = 0;
  const impl = async () => ({
    ok: true, status: 200,
    json: async () => bodies[Math.min(call++, bodies.length - 1)],
  });
  const { app, carousel, sendToApp } = makeContext({ enabled: true, fetchImpl: impl });

  await app.requestServerQuote();
  const moved = carousel.parentMessages.filter((m) => m && m.type === 'vehicleSelected').pop();
  assert.strictEqual(moved?.vehicle?.id, 'escalade',
    'refusing the selected Tesla must move selection to the first bookable vehicle');
  sendToApp(moved);                                  // real parent listener binds its token
  assert.strictEqual(app.state.vehicle.type, 'escalade');

  carousel.parentMessages.length = 0;
  carousel.detectAt(0);                              // passenger swipes to refused Tesla
  assert.strictEqual(carousel.instance.currentIndex, 1);
  assert.strictEqual(carousel.viewportIndex(), 1,
    'the real centerCard path must return the viewport to Escalade');
  assert.strictEqual(carousel.parentMessages.filter((m) => m?.type === 'vehicleSelected').length, 0,
    'snapping back must not pretend the passenger made another selection');

  await app.requestServerQuote({ force: true });     // a later quote restores Tesla
  assert.strictEqual(carousel.instance.unavailableIds.size, 0);
  assert.strictEqual(carousel.viewportIndex(), 1,
    're-enabling Tesla must not resurrect the rejected viewport position');
  assert.strictEqual(carousel.instance.currentIndex, 1);
  assert.strictEqual(app.state.vehicle.type, 'escalade');
  assert.strictEqual(app.state.vehicle.quoteToken, 'tok.escalade',
    'the centered card and the token Book would submit must still agree');
  assert.strictEqual(app.els.bookBtn.disabled, false);
});

check('PLACEHOLDER AVAILABILITY: refusals survive every non-authoritative price state', async () => {
  const refused = quoteWithTtl(15);
  refused.quote.vehicles.tesla = { ok: false, error: { code: 'passenger_capacity_exceeded' } };
  refused.quote.vehiclesOk = 2; refused.quote.vehiclesRefused = 1;
  const allValid = quoteWithTtl(15);
  let call = 0;
  let releaseFailure;
  let markFailureStarted;
  const failureStarted = new Promise((resolve) => { markFailureStarted = resolve; });
  const impl = async () => {
    const n = call++;
    if (n === 0) return { ok: true, status: 200, json: async () => refused };
    if (n === 1) {
      markFailureStarted();
      await new Promise((resolve) => { releaseFailure = resolve; });
      return {
        ok: false, status: 502,
        json: async () => ({ error: 'Could not compute the route right now' }),
      };
    }
    return { ok: true, status: 200, json: async () => allValid };
  };
  const { app, carousel, posted, sendToApp } = makeContext({ enabled: true, fetchImpl: impl });

  await app.requestServerQuote();
  assert.strictEqual(carousel.instance.unavailableIds.has('tesla'), true);

  const assertStillRefused = (label) => {
    assert.strictEqual(carousel.visible().tesla, label);
    assert.strictEqual(carousel.instance.unavailableIds.has('tesla'), true,
      `${label} must not invent newer availability truth`);
    assert.strictEqual(carousel.instance.track.children[0].style.pointerEvents, 'none');
    assert.strictEqual(carousel.instance.track.children[0].getAttribute('aria-disabled'), 'true');
    const before = carousel.instance.currentIndex;
    carousel.parentMessages.length = 0;
    carousel.instance.selectCard(0);
    assert.strictEqual(carousel.instance.currentIndex, before,
      `${label} must not make the refused card selectable`);
    assert.strictEqual(carousel.parentMessages.filter((m) => m?.type === 'vehicleSelected').length, 0);
  };

  app.invalidateQuote('pickup changed');
  assertStillRefused('—');

  const failing = app.requestServerQuote({ force: true });
  await failureStarted;
  assertStillRefused('…');
  releaseFailure();
  await failing;
  assertStillRefused('Unavailable');

  // Expiry uses the same replayable placeholder state. Pin it explicitly so
  // a future renderer change cannot clear availability on this fourth path.
  app.setCarouselPlaceholder('Expired');
  assertStillRefused('Expired');

  const replayStart = posted.length;
  sendToApp({ type: 'carouselReady' });
  const replay = posted.slice(replayStart).filter((m) => m?.type === 'setUnavailable').pop();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(replay?.data?.ids)), ['tesla'],
    'a late carouselReady must replay the remembered refusal, not []');

  await app.requestServerQuote({ force: true });
  assert.strictEqual(carousel.instance.unavailableIds.size, 0,
    'only the later authoritative quote may clear the refusal set');
  assert.strictEqual(carousel.instance.track.children[0].style.pointerEvents, '');
});

check('EDIT RACE: a quote timer queued before an edit begins does not fire inside it', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, runTimers } = makeContext({ enabled: true, fetchImpl: f });
  app.scheduleQuote();                                   // queued while booking normally
  // PR-2: edits quote too, so the guard moved. beginPendingEdit cancels the
  // queued create-scoped timer through invalidateQuote (which clears the
  // debounce BEFORE its idle early-return). Assert the real code wires that,
  // then replay the same sequence against the queued timer.
  assert.match(appBlock,
    /this\.invalidateQuote\('pending edit started — create-scoped quotes do not apply'\)/,
    'beginPendingEdit must CALL invalidateQuote at edit start (a comment cannot satisfy this)');
  app.pendingEdit = { bookingId: 'b-1', tripCode: 'LM-1', detailsVersion: 2 };
  app.invalidateQuote('pending edit started — create-scoped quotes do not apply');
  runTimers();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(f.calls.length, 0,
    'the queued create-scoped request must never fire inside the edit');
});

check('EDIT RACE: invalidating cancels a queued quote timer', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, runTimers, timers } = makeContext({ enabled: true, fetchImpl: f });
  const before = timers.length;                 // the app queues its own timers at boot
  app.scheduleQuote();
  assert.strictEqual(timers.length, before + 1, 'sanity: a debounce timer is queued');
  app.invalidateQuote('address changed');
  runTimers();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(f.calls.length, 0, 'a queued request for a dead intent must not fire');
});

check('SPEND GUARD: the intent is rechecked after the session round trip, before paying', async () => {
  // getSession() is an await. If the intent changes during it, the very next
  // call is the one that spends money at Google.
  let releaseSession;
  const sessionGate = new Promise((r) => { releaseSession = r; });
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f, sessionGate });

  const inflight = app.requestServerQuote();
  await Promise.resolve();
  app.invalidateQuote('address changed while acquiring the session');
  releaseSession();
  await inflight;
  assert.strictEqual(f.calls.length, 0,
    'a stale intent must not buy a Places + Compute Routes Pro pair');
});

check('STAGE GUARD: leaving Vehicle cancels queued and pre-provider quote spending', async () => {
  const queuedFetch = okFetch(quoteWithTtl(15));
  const queued = makeContext({ enabled: true, fetchImpl: queuedFetch });
  queued.app.scheduleQuote();
  queued.app.state.ui.currentPanel = 'when';
  queued.runTimers();
  await Promise.resolve();
  assert.strictEqual(queuedFetch.calls.length, 0,
    'a debounce queued on Vehicle must not spend after the passenger leaves');

  // The panel can also change while getSession() is awaiting. Recheck at the
  // last boundary before fetch, reset the loading state, and prove re-entry
  // can request normally rather than deduplicating forever.
  let releaseSession;
  const sessionGate = new Promise((r) => { releaseSession = r; });
  const gatedFetch = okFetch(quoteWithTtl(15));
  const gated = makeContext({ enabled: true, fetchImpl: gatedFetch, sessionGate });
  const inflight = gated.app.requestServerQuote();
  await Promise.resolve();
  gated.app.state.ui.currentPanel = 'when';
  releaseSession();
  await inflight;
  assert.strictEqual(gatedFetch.calls.length, 0,
    'leaving during session acquisition must stop before the paid fetch');
  assert.strictEqual(gated.app.state.quote.status, 'idle',
    'an aborted request must not leave the quote stuck loading');

  gated.app.state.ui.currentPanel = 'vehicle';
  await gated.app.requestServerQuote();
  assert.strictEqual(gatedFetch.calls.length, 1,
    'returning to Vehicle must be able to request a fresh quote');
});

// ============ PR-2: tap boundary, envelope, and edit quoting ============

// Fetch router: PR-2 flows talk to /api/quote-ride AND a writer endpoint in
// one scenario. Routes map url -> {status, body} or a function of the call.
function routedFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const call = { url, opts };
    calls.push(call);
    const route = routes[url];
    if (!route) throw new Error(`unrouted fetch: ${url}`);
    const r = await (typeof route === 'function' ? route(call, calls) : route);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  };
  impl.calls = calls;
  impl.to = (url) => calls.filter((c) => c.url === url);
  return impl;
}

// Enter through the REAL tap boundary and hand back the confirm promise the
// tap fires, so a check can await the full submission chain.
function tap(app) {
  let pending = null;
  const real = app.confirmBooking.bind(app);
  app.confirmBooking = () => { pending = real(); return pending; };
  app.handleBookingClick();
  app.confirmBooking = real;
  return pending;
}

// Real endpoint success shape (booking-writer contract): success:true +
// bookingId (+ detailsVersion, which edits REQUIRE to be definitive).
const CREATED = { status: 200, body: { success: true, bookingId: 'db-1', tripId: 'LM-OK', detailsVersion: 1 } };

check('ENVELOPE: one tap serializes once — operationId inside the exact stored bytes', async () => {
  const f = routedFetch({
    '/api/quote-ride': { body: quoteWithTtl(15) },
    '/api/create-booking': CREATED,
  });
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);
  const storedEnvelopes = [];
  const origSet = ctx.sessionStorage.setItem;
  ctx.sessionStorage.setItem = (k, v) => { if (k === 'lm_pending_envelope') storedEnvelopes.push(v); return origSet(k, v); };

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  await tap(app);

  const posts = f.to('/api/create-booking');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].opts.headers.Authorization, 'Bearer jwt-abc');
  assert.strictEqual(storedEnvelopes.length, 1, 'the envelope is stored before the POST');
  const env = JSON.parse(storedEnvelopes[0]);
  assert.strictEqual(posts[0].opts.body, env.bodyString,
    'the POST sends the exact stored envelope bytes');
  assert.strictEqual(env.kind, 'create');
  assert.strictEqual(env.authSubject, 'auth-user-1');

  const sent = JSON.parse(posts[0].opts.body);
  assert.match(sent.operationId, /^[0-9a-f-]{36}$/i, 'operationId travels INSIDE the body');
  assert.strictEqual(sent.operationId, env.operationId);
  assert.strictEqual(sent.quoteToken, 'tok.tesla');
  assert.strictEqual(sent.placeId, 'ChIJ_CANONICAL_xyz', 'the CANONICAL id is resubmitted');
  assert.strictEqual(sent.vehicleKey, 'tesla');
  assert.strictEqual(sent.routeMilesTenths, 100);
  assert.strictEqual(sent.routeMinutes, 20);
  assert.ok(!('durationMinutes' in sent), 'the legacy browser duration must not ride along');
  assert.strictEqual(sent.price, 39, 'the submitted total is the server cents');

  assert.deepStrictEqual(sheets, ['db-1'], 'a definitive success opens the trip sheet');
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null,
    'a definitive mapped response settles the envelope');
});

check('TAP on a stale quote: one quiet refresh, then automatic submit at the SAME cents', async () => {
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),   // refresh answers the same price
    '/api/create-booking': CREATED,
  });
  const { app, alerts } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  // …the passenger sits on the screen past the TTL, then taps anyway
  const past = new Date(Date.now() - 1000).toISOString();
  Object.keys(app.state.quote.data.vehicles).forEach((k) => {
    app.state.quote.data.vehicles[k].expiresAt = past;
  });

  await tap(app);

  assert.strictEqual(f.to('/api/quote-ride').length, 2, 'exactly ONE quiet refresh for the tap');
  assert.strictEqual(f.to('/api/create-booking').length, 1, 'then the submit happens automatically');
  assert.strictEqual(app._tapSnapshot.refreshUsed, true);
  assert.deepStrictEqual(sheets, ['db-1']);
  assert.strictEqual(alerts.length, 0, 'the whole quiet path never alerts');
});

check('TAP on a stale quote: a CHANGED price never auto-submits — it asks for a new tap', async () => {
  let firstQuote = true;
  const f = routedFetch({
    '/api/quote-ride': () => {
      if (firstQuote) { firstQuote = false; return { body: quoteWithTtl(15) }; }
      const dearer = quoteWithTtl(15);
      dearer.quote.vehicles.tesla.finalCents = 4900;   // the refresh got dearer
      return { body: dearer };
    },
    '/api/create-booking': CREATED,
  });
  const { app, alerts } = makeContext({ enabled: true, fetchImpl: f });
  app.showTripSheet = () => { throw new Error('must not reach the trip sheet'); };

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  const past = new Date(Date.now() - 1000).toISOString();
  Object.keys(app.state.quote.data.vehicles).forEach((k) => {
    app.state.quote.data.vehicles[k].expiresAt = past;
  });

  await tap(app);

  assert.strictEqual(f.to('/api/create-booking').length, 0,
    'a different number is shown, never auto-sent');
  assert.strictEqual(alerts.length, 0, 'the note is quiet — no alert, no "refused"');
  assert.strictEqual(app.selectedQuoteVehicle().finalCents, 4900,
    'the refreshed price is on screen for the passenger to review');
  const note = app.els.bookBtn.children.find((c) => c.className === 'btn-sub-text');
  assert.ok(note && /review the new price/i.test(note.textContent),
    'the quiet one-liner actually RENDERS (the note target is created if missing)');
});

check('REQUOTE: a server requote spends the tap budget — refresh, ONE resubmit, then stop', async () => {
  let created = 0;
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
    '/api/create-booking': () => (++created === 1
      ? { status: 409, body: { error: 'quote_expired', requote: true } }
      : CREATED),
  });
  const { app, alerts } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  await tap(app);

  const posts = f.to('/api/create-booking');
  assert.strictEqual(posts.length, 2, 'refresh then ONE automatic resubmit');
  const id1 = JSON.parse(posts[0].opts.body).operationId;
  const id2 = JSON.parse(posts[1].opts.body).operationId;
  assert.notStrictEqual(id1, id2, 'a refreshed quote is a NEW payload and a NEW operation');
  assert.strictEqual(f.to('/api/quote-ride').length, 2, 'the resubmit bought exactly one refresh');
  assert.deepStrictEqual(sheets, ['db-1']);
  assert.strictEqual(alerts.length, 0);
});

check('REQUOTE: an exhausted tap budget returns to a visible tap — no third submit, NO background quote', async () => {
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
    '/api/create-booking': { status: 409, body: { error: 'quote_expired', requote: true } },
  });
  const { app, carousel, alerts } = makeContext({ enabled: true, fetchImpl: f });
  app.showTripSheet = () => { throw new Error('must not reach the trip sheet'); };

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  await tap(app);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(f.to('/api/create-booking').length, 2,
    'the per-tap ceiling is one refresh + one resubmit, full stop');
  assert.strictEqual(f.to('/api/quote-ride').length, 2,
    'provider ceiling: the initial quote + ONE quiet refresh — exhaustion buys nothing');
  assert.strictEqual(alerts.length, 0, 'the return to a visible tap is quiet');
  // The refused quote is marked expired locally: Expired cards, and the
  // primary action stays clickable — the NEXT tap owns the refresh.
  assert.deepStrictEqual(carousel.visible(),
    { tesla: 'Expired', escalade: 'Expired', sprinter: 'Expired' });
  assert.strictEqual(app.els.bookBtn.disabled, false,
    'the passenger can tap again once they have reviewed');
  assert.match(app.els.bookBtn.innerHTML, /Refresh and Book/);
  const note = app.els.bookBtn.children.find((c) => c.className === 'btn-sub-text');
  assert.ok(note && /needs a refresh/i.test(note.textContent));
});

check('UNKNOWN result: exact-byte retry once, then the recovery card — and Check again recovers', async () => {
  let outage = true;
  const f = routedFetch({
    '/api/quote-ride': { body: quoteWithTtl(15) },
    '/api/create-booking': () => (outage
      ? { status: 502, body: { error: 'gateway hiccup' } }   // 502 is NOT a mapped outcome
      : CREATED),
  });
  const { app, ctx, alerts } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  await tap(app);

  const posts = f.to('/api/create-booking');
  assert.strictEqual(posts.length, 2, 'an unknown result retries exactly once');
  assert.strictEqual(posts[0].opts.body, posts[1].opts.body,
    'the retry resends the identical bytes — same operationId, same everything');
  assert.strictEqual(alerts.length, 1);
  assert.match(alerts[0], /Check again/);
  assert.ok(ctx.sessionStorage.getItem('lm_pending_envelope'),
    'the envelope survives an unknown result');
  const card = ctx.document.body.children.find((c) => c.id === 'pendingEnvelopeCard');
  assert.ok(card, 'the recovery card is offered');
  const [span, checkBtn] = card.children;
  assert.match(span.textContent, /couldn't confirm your last booking/);

  // The outage ends; "Check again" re-sends the exact stored bytes.
  outage = false;
  await checkBtn.listeners.click[0]();
  const after = f.to('/api/create-booking');
  assert.strictEqual(after.length, 3);
  assert.strictEqual(after[2].opts.body, posts[0].opts.body,
    'recovery submits the very same envelope bytes');
  assert.deepStrictEqual(sheets, ['db-1']);
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null,
    'a definitive recovery settles the envelope');
  assert.strictEqual(card.removed, true, 'the card leaves with the envelope');
});

check('RECOVERY OFFER: bound to the account — another subject\'s envelope is dropped, never shown', async () => {
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: okFetch(quoteWithTtl(15)) });
  ctx.sessionStorage.setItem('lm_pending_envelope', JSON.stringify({
    operationId: 'op-1', bodyString: '{}', kind: 'create',
    bookingId: null, authSubject: 'someone-else', createdAt: 1,
  }));
  app.offerPendingEnvelope('auth-user-1');
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null,
    'an envelope from a different account is discarded');
  assert.ok(!ctx.document.body.children.some((c) => c.id === 'pendingEnvelopeCard'),
    'and never offered');

  ctx.sessionStorage.setItem('lm_pending_envelope', JSON.stringify({
    operationId: 'op-2', bodyString: '{}', kind: 'edit',
    bookingId: 'b-1', authSubject: 'auth-user-1', createdAt: 1,
  }));
  app.offerPendingEnvelope('auth-user-1');
  const card = ctx.document.body.children.find((c) => c.id === 'pendingEnvelopeCard');
  assert.ok(card, 'the same account gets the offer');
  assert.match(card.children[0].textContent, /couldn't confirm your last ride change/,
    'an edit envelope says change, not booking');

  // "Check again" on the edit envelope: a recovered edit is a COMMITTED
  // edit — the edit session closes and the server's version is adopted,
  // exactly like the direct save path.
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);
  app.pendingEdit = { bookingId: 'b-1', tripCode: 'LM-1', detailsVersion: 3 };
  ctx.fetch = routedFetch({
    '/api/update-pending-booking': { status: 200, body: { success: true, bookingId: 'b-1', tripId: 'LM-1', detailsVersion: 9 } },
  });
  await card.children[1].listeners.click[0]();
  assert.deepStrictEqual(sheets, ['b-1']);
  assert.strictEqual(app.pendingEdit, null, 'the recovered edit closes the edit session');
  assert.strictEqual(ctx.currentActiveBooking?.details_version, 9,
    'the committed version is adopted for the next edit');
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null);
  assert.strictEqual(card.removed, true);
});

check('IN-FLIGHT: nothing re-enables the button mid-POST, and a second tap is inert', async () => {
  let releaseCreate;
  const createGate = new Promise((r) => { releaseCreate = r; });
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
    '/api/create-booking': async () => { await createGate; return CREATED; },
  });
  const { app, ctx, alerts } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);
  const storedEnvelopes = [];
  const origSet = ctx.sessionStorage.setItem;
  ctx.sessionStorage.setItem = (k, v) => { if (k === 'lm_pending_envelope') storedEnvelopes.push(v); return origSet(k, v); };

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  const pending = tap(app);
  assert.ok(pending);
  await new Promise((r) => setTimeout(r, 0));   // let the chain reach the gated POST
  assert.strictEqual(f.to('/api/create-booking').length, 1, 'sanity: the POST is in flight');

  // Mid-flight, the quote expires and the expiry path recomputes the button…
  const past = new Date(Date.now() - 1000).toISOString();
  Object.keys(app.state.quote.data.vehicles).forEach((k) => {
    app.state.quote.data.vehicles[k].expiresAt = past;
  });
  app.renderQuoteState();
  assert.strictEqual(app.els.bookBtn.disabled, true,
    'expiry recompute must NOT resurrect the button while a submission is in flight');

  // …and the passenger taps again anyway (keyboard, ghost click):
  app.handleBookingClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(f.to('/api/create-booking').length, 1, 'no second concurrent POST');
  assert.strictEqual(storedEnvelopes.length, 1, 'no second envelope — the slot is never clobbered');

  releaseCreate();
  await pending;
  assert.deepStrictEqual(sheets, ['db-1']);
  assert.strictEqual(alerts.length, 0);
  assert.strictEqual(app._submitInFlight, false, 'the flag is released when the chain settles');
});

check('MARKERS: carousel auto-select (userInitiated:false) never grants the vehicle marker', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app } = makeContext({ enabled: true, fetchImpl: f });
  app.pendingEdit = { bookingId: 'b-1', tripCode: 'LM-1', detailsVersion: 3 };
  app.editMarkers = {
    routeDirection: true, routeAddress: true, pickupAt: true,
    vehicle: false, traveler: false
  };
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39, userInitiated: false });
  assert.strictEqual(app.editMarkers.vehicle, false,
    'the boot-time auto-select is not a passenger choice');
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, true, 'Save stays blocked');
  // the passenger's own tap counts
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39, userInitiated: true });
  assert.strictEqual(app.editMarkers.vehicle, true);
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, false);
});

check('STATIC: the carousel stamps userInitiated=false on every non-user selection', () => {
  const carousel = fs.readFileSync(path.join(repoRoot, 'vehicle-carousel-standalone.html'), 'utf8');
  assert.match(carousel, /selectCard\(index, userInitiated = true\)/);
  assert.match(carousel, /this\.selectCard\(0, false\), 100\)/, 'boot auto-select');
  assert.match(carousel, /case 'reset':\s*\n\s*this\.selectCard\(0, false\)/, 'host reset');
  assert.match(carousel, /case 'selectVehicle':[\s\S]{0,400}?this\.selectCard\(index, false\)/, 'host restore');
  assert.match(carousel, /this\.selectCard\(next, false\)/, 'unavailable auto-advance');
  assert.match(carousel, /userInitiated: userInitiated === true/, 'the flag rides in vehicleData');
});

// ============ PR-2 round 1 (Codex findings 1–5) ============

check('GATE: an unresolved operation blocks new Book/Save chains until resolved or discarded', async () => {
  let outage = true;
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
    '/api/create-booking': () => (outage
      ? { status: 502, body: { error: 'gateway hiccup' } }
      : CREATED),
  });
  const { app, ctx, alerts } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);
  ctx.currentSession = { user: { id: 'auth-user-1' } };

  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  await tap(app);
  assert.strictEqual(f.to('/api/create-booking').length, 2, 'sanity: unknown after one retry');
  const storedBytes = ctx.sessionStorage.getItem('lm_pending_envelope');
  assert.ok(storedBytes, 'sanity: the envelope is unresolved');
  assert.strictEqual(alerts.length, 1);

  // A later tap must not mint a new operation while this one is unresolved —
  // ambassadors are multi-ride, so a committed-but-unacknowledged create
  // plus a fresh chain would be a second REAL guest ride and a lost handle.
  const callsBefore = f.calls.length;
  assert.strictEqual(tap(app), null, 'the tap is refused before any chain starts');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(f.calls.length, callsBefore, 'zero new POSTs of any kind');
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), storedBytes,
    'the unresolved envelope is retained byte-identically');
  assert.ok(ctx.document.body.children.some((c) => c.id === 'pendingEnvelopeCard' && !c.removed),
    'the recovery card is re-offered instead');
  assert.strictEqual(alerts.length, 1, 'the refusal is quiet — the card speaks');

  // Positive control: explicit Discard releases the gate and a new tap books.
  const cards = ctx.document.body.children.filter((c) => c.id === 'pendingEnvelopeCard' && !c.removed);
  await cards[cards.length - 1].children[2].listeners.click[0]();
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null);
  outage = false;
  const createsBefore = f.to('/api/create-booking').length;
  const pending2 = tap(app);
  assert.ok(pending2, 'after Discard the tap proceeds');
  await pending2;
  assert.strictEqual(f.to('/api/create-booking').length, createsBefore + 1);
  assert.deepStrictEqual(sheets, ['db-1']);
});

check('DEFINITIVE means REGISTRY-SHAPED: 200 {} and a generic JSON 503 stay unknown', async () => {
  for (const bad of [
    { status: 200, body: {} },                                  // parsed 2xx, no success shape
    { status: 200, body: { success: true } },                   // still no bookingId
    { status: 503, body: { error: 'Service Unavailable' } },    // a gateway, not the writer
    { status: 428, body: { error: 'outdated_client' } },        // no reload:true
  ]) {
    const f = routedFetch({
      '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
      '/api/create-booking': bad,
    });
    const { app, ctx, alerts } = makeContext({ enabled: true, fetchImpl: f });
    app.showTripSheet = () => { throw new Error('must not open a sheet'); };
    await app.requestServerQuote();
    app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
    await tap(app);
    const posts = f.to('/api/create-booking');
    assert.strictEqual(posts.length, 2, `${bad.status}: one exact-byte retry, then unknown`);
    assert.strictEqual(posts[0].opts.body, posts[1].opts.body);
    assert.ok(ctx.sessionStorage.getItem('lm_pending_envelope'),
      `${bad.status}: a contract-invalid response must NOT settle the envelope`);
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /Check again/);
  }
});

check('DEFINITIVE: an edit success without its version is unknown; with it, definitive', async () => {
  for (const [body, wantPosts, wantEnvelope] of [
    [{ success: true, bookingId: 'b-9', tripId: 'LM-9' }, 2, true],                    // missing detailsVersion
    [{ success: true, bookingId: 'b-9', tripId: 'LM-9', detailsVersion: 8 }, 1, false],
  ]) {
    const f = routedFetch({
      '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
      '/api/update-pending-booking': { status: 200, body },
    });
    const { app, ctx } = makeContext({ enabled: true, fetchImpl: f });
    app.showTripSheet = () => {};
    app.pendingEdit = { bookingId: 'b-9', tripCode: 'LM-9', detailsVersion: 7 };
    app.editMarkers = {
      routeDirection: true, routeAddress: true, pickupAt: true,
      vehicle: false, traveler: false
    };
    await app.requestServerQuote();
    app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
    await tap(app);
    assert.strictEqual(f.to('/api/update-pending-booking').length, wantPosts);
    assert.strictEqual(!!ctx.sessionStorage.getItem('lm_pending_envelope'), wantEnvelope,
      'the edit success shape REQUIRES its committed version');
  }
});

check('DEFINITIVE: the writer\'s exact blocked copy IS definitive — one attempt, envelope settled', async () => {
  const BLOCKED = 'Bookings are temporarily unavailable. Message us on WhatsApp and a human will arrange your ride.';
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
    '/api/create-booking': { status: 503, body: { error: BLOCKED } },
  });
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: f });
  let shownError = '';
  app.showPaymentError = (m) => { shownError = String(m); };
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  await tap(app);
  assert.strictEqual(f.to('/api/create-booking').length, 1, 'a recognized outcome is not retried');
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null, 'settled');
  assert.match(shownError, /nothing was booked/i, 'the failure is spoken honestly');
});

check('STATIC: the blocked registry copy is pinned identically in writer and browser', () => {
  const copy = 'Bookings are temporarily unavailable. Message us on WhatsApp and a human will arrange your ride.';
  const writer = fs.readFileSync(path.join(repoRoot, 'backend/functions/lib/booking-writer.js'), 'utf8');
  assert.ok(writer.includes(copy), 'the writer serves this exact copy for blocked');
  assert.ok(appBlock.includes(copy), 'the browser recognizes this exact copy as definitive');
});

check('RECOVERY OVERLAP: an older completion cannot clear or act on a newer operation', async () => {
  let releaseCheck;
  const checkGate = new Promise((r) => { releaseCheck = r; });
  const f = routedFetch({
    '/api/create-booking': async () => { await checkGate; return CREATED; },
  });
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);
  ctx.sessionStorage.setItem('lm_pending_envelope', JSON.stringify({
    operationId: 'op-OLD', bodyString: '{}', kind: 'create',
    bookingId: null, authSubject: 'auth-user-1', createdAt: 1,
  }));
  app.offerPendingEnvelope('auth-user-1');
  const card = ctx.document.body.children.find((c) => c.id === 'pendingEnvelopeCard');
  const [, checkBtn, discardBtn] = card.children;
  const oldCheck = checkBtn.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(discardBtn.disabled, true, 'BOTH controls freeze during a check');

  // While the old check awaits, the slot is repointed to a newer operation.
  const newer = JSON.stringify({
    operationId: 'op-NEW', bodyString: '{}', kind: 'create',
    bookingId: null, authSubject: 'auth-user-1', createdAt: 2,
  });
  ctx.sessionStorage.setItem('lm_pending_envelope', newer);
  releaseCheck();
  await oldCheck;
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), newer,
    'the newer operation survives the older completion');
  assert.deepStrictEqual(sheets, [], 'the older result is not displayed as current');
  // Round 2: the stale card must NOT be re-enabled — it yields: removes
  // itself and the CURRENT operation gets a fresh offer.
  assert.strictEqual(card.removed, true, 'the stale card yields the stage');
  const fresh = ctx.document.body.children.find(
    (c) => c.id === 'pendingEnvelopeCard' && !c.removed && c !== card);
  assert.ok(fresh, 'the current operation is offered immediately');
  // …and even a ghost click on the detached stale Discard cannot delete
  // the newer operation (Discard is scoped to its own card's operation).
  await card.children[2].listeners.click[0]();
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), newer,
    'a stale Discard can never delete the newer envelope');
});

check('DISCARD SCOPE: a stale card\'s Discard removes only itself — the newer operation survives', async () => {
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: okFetch(quoteWithTtl(15)) });
  ctx.sessionStorage.setItem('lm_pending_envelope', JSON.stringify({
    operationId: 'op-OLD', bodyString: '{}', kind: 'create',
    bookingId: null, authSubject: 'auth-user-1', createdAt: 1,
  }));
  app.offerPendingEnvelope('auth-user-1');
  const oldCard = ctx.document.body.children.find((c) => c.id === 'pendingEnvelopeCard' && !c.removed);
  // The slot moves on to a newer operation while the old card is on screen.
  const newer = JSON.stringify({
    operationId: 'op-NEW', bodyString: '{}', kind: 'create',
    bookingId: null, authSubject: 'auth-user-1', createdAt: 2,
  });
  ctx.sessionStorage.setItem('lm_pending_envelope', newer);
  await oldCard.children[2].listeners.click[0]();   // stale Discard
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), newer,
    'op-NEW survives byte-exact');
  assert.strictEqual(oldCard.removed, true, 'the stale card removes only itself');
  const cards = ctx.document.body.children.filter(
    (c) => c.id === 'pendingEnvelopeCard' && !c.removed);
  assert.ok(cards.length >= 1, 'the current operation is offered in its place');
  // The OWNING card's Discard still discards.
  await cards[cards.length - 1].children[2].listeners.click[0]();
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null,
    'the operation that owns the slot can still be discarded');
});

check('SINGLE-FLIGHT: the lock survives the recursive auto-resubmit end to end', async () => {
  let created = 0;
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
    '/api/create-booking': () => (++created === 1
      ? { status: 409, body: { error: 'quote_expired', requote: true } }
      : CREATED),
  });
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);
  // The initial quote happens BEFORE the counter is installed — it makes
  // its own getSession call, and counting it would shift the gate onto
  // the quiet refresh instead of the boundary under test (the exact
  // miscount Codex's final review caught: the no-await mutant passed).
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  // Session acquisitions from the tap onward: (1) the outer submit,
  // (2) the quiet refresh inside the requote branch, (3) the RECURSIVE
  // resubmit. Park call 3 — the exact instant round 2 proved the lock
  // used to drop.
  let sessionCalls = 0;
  let releaseThird; const thirdGate = new Promise((r) => { releaseThird = r; });
  let thirdEntered; const thirdIn = new Promise((r) => { thirdEntered = r; });
  ctx.window.supabaseClient.auth.getSession = async () => {
    sessionCalls++;
    if (sessionCalls === 3) { thirdEntered(); await thirdGate; }
    return { data: { session: { access_token: 'jwt-abc', user: { id: 'auth-user-1' } } } };
  };
  const pending = tap(app);
  await thirdIn;   // the recursive chain is pending at session acquisition
  assert.strictEqual(app._submitInFlight, true,
    'the lock holds through the recursive handoff — the outer finally has not run');
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, true, 'the primary button stays blocked');
  const callsBefore = f.calls.length;
  assert.strictEqual(tap(app), null, 'a second tap cannot start another chain');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(f.calls.length, callsBefore, 'the refused tap makes zero calls');
  releaseThird();
  await pending;
  assert.strictEqual(f.to('/api/create-booking').length, 2, 'original + exactly one resubmit');
  assert.deepStrictEqual(sheets, ['db-1']);
  assert.strictEqual(app._submitInFlight, false, 'the lock releases once everything settles');
});

check('CHANNEL: outbound messages pin the same-origin target — never *', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, carousel, postedTargets } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();           // posts placeholders/prices to the iframe
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  assert.ok(postedTargets.length > 0, 'sanity: the parent posted to the iframe');
  postedTargets.forEach((t) => assert.strictEqual(t, 'https://example.test',
    'every parent->iframe message names the same-origin target'));
  carousel.deliver({ type: 'selectVehicle', data: { vehicleId: 'escalade' } });   // makes the iframe answer
  assert.ok(carousel.parentTargets.length > 0, 'sanity: the iframe posted to the parent');
  carousel.parentTargets.forEach((t) => assert.strictEqual(t, 'https://example.test',
    'every iframe->parent message names the same-origin target'));
});

check('SCOPED CLEAR: clearPendingEnvelope touches only its own operation — and callers are pinned', () => {
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: okFetch(quoteWithTtl(15)) });
  const env = JSON.stringify({
    operationId: 'op-A', bodyString: '{}', kind: 'create',
    bookingId: null, authSubject: 'auth-user-1', createdAt: 1,
  });
  ctx.sessionStorage.setItem('lm_pending_envelope', env);
  app.clearPendingEnvelope('op-B');
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), env,
    'another operation cannot clear the slot');
  app.clearPendingEnvelope('op-A');
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null,
    'the owning operation clears it');
  ctx.sessionStorage.setItem('lm_pending_envelope', env);
  app.clearPendingEnvelope();
  assert.strictEqual(ctx.sessionStorage.getItem('lm_pending_envelope'), null,
    'the unscoped form (logout semantics) clears whatever holds the slot');
  // The settle and recovery call sites use the SCOPED form — a bare clear
  // there passed every check until this pin.
  assert.ok(appBlock.includes('this.clearPendingEnvelope(envelope.operationId)'),
    'the submission settle clears by its own operationId');
  assert.ok(appBlock.includes('this.clearPendingEnvelope(env.operationId)'),
    'recovery completion and Discard clear by their own operationId');
});

check('CHANNEL: vehicle selection is accepted only from the same-origin carousel frame', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, sendToApp } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  const vehicle = { id: 'escalade', name: 'Cadillac Escalade', passengers: 7, bags: 8, price: 55 };
  sendToApp({ type: 'vehicleSelected', vehicle }, { origin: 'https://evil.example' });
  assert.strictEqual(app.state.vehicle?.type ?? null, null,
    'a cross-origin sender must not drive the priced vehicle/token');
  sendToApp({ type: 'vehicleSelected', vehicle }, { source: {} });
  assert.strictEqual(app.state.vehicle?.type ?? null, null,
    'right origin but wrong window must not either');
  sendToApp({ type: 'vehicleSelected', vehicle });
  assert.strictEqual(app.state.vehicle?.type, 'escalade',
    'the genuine carousel frame still drives selection');
});

check('CHANNEL: the carousel obeys only its same-origin parent', () => {
  const { carousel } = makeContext({ enabled: true, fetchImpl: okFetch(quoteWithTtl(15)) });
  const before = carousel.parentMessages.length;
  carousel.deliver({ type: 'selectVehicle', data: { vehicleId: 'escalade' } },
    { origin: 'https://evil.example' });
  assert.strictEqual(carousel.parentMessages.length, before, 'hostile origin: ignored');
  carousel.deliver({ type: 'selectVehicle', data: { vehicleId: 'escalade' } },
    { source: {} });
  assert.strictEqual(carousel.parentMessages.length, before, 'hostile source: ignored');
  carousel.deliver({ type: 'selectVehicle', data: { vehicleId: 'escalade' } });
  const last = carousel.parentMessages[carousel.parentMessages.length - 1];
  assert.strictEqual(last?.type, 'vehicleSelected', 'the genuine parent still commands');
  assert.strictEqual(last?.vehicle?.id, 'escalade');
  assert.strictEqual(last?.vehicle?.userInitiated, false, 'host restore stays non-user');
});

check('REFRESH BINDING: an answer the tap did not launch is refused, even at the same price', async () => {
  const f = routedFetch({
    '/api/quote-ride': () => ({ body: quoteWithTtl(15) }),
    '/api/create-booking': CREATED,
  });
  const { app, ctx, alerts } = makeContext({ enabled: true, fetchImpl: f });
  app.showTripSheet = () => { throw new Error('must not submit'); };
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  const past = new Date(Date.now() - 1000).toISOString();
  Object.keys(app.state.quote.data.vehicles).forEach((k) => {
    app.state.quote.data.vehicles[k].expiresAt = past;
  });

  // Park ONLY the tap's own quiet refresh at the auth step.
  let gateFirst = true;
  let releaseFirst; const firstGate = new Promise((r) => { releaseFirst = r; });
  let firstEntered; const firstIn = new Promise((r) => { firstEntered = r; });
  ctx.window.supabaseClient.auth.getSession = async () => {
    if (gateFirst) { gateFirst = false; firstEntered(); await firstGate; }
    return { data: { session: { access_token: 'jwt-abc', user: { id: 'auth-user-1' } } } };
  };
  const pending = tap(app);
  await firstIn;
  // An interleaved re-quote completes fully while the tap's refresh is parked.
  await app.requestServerQuote({ force: true });
  assert.strictEqual(app.quoteIsFresh(), true,
    'sanity: the interloper produced a fresh quote at the identical price');
  releaseFirst();
  await pending;
  assert.strictEqual(f.to('/api/create-booking').length, 0,
    'same intent, same cents — but not the request THIS tap launched: refused');
  assert.strictEqual(alerts.length, 0);
  assert.strictEqual(app.els.bookBtn.disabled, false,
    'the fresh price is reviewable and a new tap can accept it');
});

check('STATIC: envelope lifecycle wiring — boot offer on every path, sign-outs clear it', () => {
  const full = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
  const resumeIdx = full.indexOf('function resumeAccountBookingWhenReady()');
  const offerIdx = full.indexOf('offerPendingEnvelope(subject)', resumeIdx);
  const bookingBranchIdx = full.indexOf('const bookingId = currentActiveBooking?.id', resumeIdx);
  assert.ok(resumeIdx >= 0 && offerIdx > resumeIdx && offerIdx < bookingBranchIdx,
    'the recovery offer must run BEFORE the active-booking early returns — a normal passenger\'s edit recovery always coexists with a live booking');
  const logoutIdx = full.indexOf('async function logout()');
  const logoutBlock = full.slice(logoutIdx, full.indexOf('}', full.indexOf('window.location.href', logoutIdx)));
  assert.ok(logoutBlock.includes("removeItem('lm_pending_envelope')"),
    'explicit sign-out clears the pending envelope');
  const revokedIdx = full.indexOf('revoked server-side');
  assert.ok(full.slice(revokedIdx, revokedIdx + 600).includes("removeItem('lm_pending_envelope')"),
    'the revoked-session bounce clears it too');
});

check('428 reload:true — the outdated bundle reloads instead of arguing', async () => {
  const f = routedFetch({
    '/api/quote-ride': { body: quoteWithTtl(15) },
    '/api/create-booking': { status: 428, body: { error: 'outdated_client', reload: true } },
  });
  const { app, ctx, alerts } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  await tap(app);
  assert.strictEqual(ctx.__reloads, 1, 'the fix for an outdated client is the fresh bundle');
  assert.strictEqual(alerts.length, 1);
  assert.match(alerts[0], /updated/i);
});

check('EDIT: a full edit submission — edit envelope, forced traveler review, CAS carried', async () => {
  const f = routedFetch({
    '/api/quote-ride': { body: quoteWithTtl(15) },
    '/api/update-pending-booking': { status: 200, body: { success: true, bookingId: 'b-9', tripId: 'LM-9', detailsVersion: 8 } },
  });
  const { app, ctx } = makeContext({ enabled: true, fetchImpl: f });
  const sheets = [];
  app.showTripSheet = (id) => sheets.push(id);
  app.pendingEdit = { bookingId: 'b-9', tripCode: 'LM-9', detailsVersion: 7 };
  app.editMarkers = {
    routeDirection: true, routeAddress: true, pickupAt: true,
    vehicle: false, traveler: false
  };

  await app.requestServerQuote();
  const quoteBody = JSON.parse(f.to('/api/quote-ride')[0].opts.body);
  assert.strictEqual(quoteBody.bookingId, 'b-9');
  assert.strictEqual(quoteBody.expectedDetailsVersion, 7);

  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  const before = ctx.__modalOpens || 0;
  await tap(app);
  assert.strictEqual((ctx.__modalOpens || 0) - before, 1,
    'prefilled traveler data never counts — the modal is REOPENED for review');

  const posts = f.to('/api/update-pending-booking');
  assert.strictEqual(posts.length, 1, 'edits write through the edit lane');
  const sent = JSON.parse(posts[0].opts.body);
  assert.strictEqual(sent.bookingId, 'b-9');
  assert.strictEqual(sent.expectedDetailsVersion, 7,
    'the CAPTURED version is the CAS — a server echo never replaces it');
  assert.match(sent.operationId, /^[0-9a-f-]{36}$/i);
  assert.strictEqual(sent.quoteToken, 'tok.tesla');
  assert.ok(!('paymentMethod' in sent),
    'plan v3.1: the edit contract carries NO payment method — stored values survive');
  assert.deepStrictEqual(sheets, ['b-9']);
  assert.strictEqual(app.pendingEdit, null, 'a saved edit closes the edit session');
});

check('EDIT_STALE: a stale edit quote fails closed with honest reopen copy', async () => {
  const f = routedFetch({
    '/api/quote-ride': { status: 409, body: { error: 'edit_stale', reason: 'version', currentDetailsVersion: 5 } },
  });
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: f });
  app.pendingEdit = { bookingId: 'b-9', tripCode: 'LM-9', detailsVersion: 3 };
  app.editMarkers = {
    routeDirection: true, routeAddress: true, pickupAt: true,
    vehicle: true, traveler: false
  };

  await app.requestServerQuote();
  assert.strictEqual(app.state.quote.status, 'error');
  assert.strictEqual(app.state.quote.error.retryable, false,
    'the captured CAS is sacred — never silently refreshed into a retry');
  assert.strictEqual(app.state.quote.error.editStale, true);
  assert.match(app.state.quote.error.message, /reopen/i);
  assert.strictEqual(app.pendingEdit.detailsVersion, 3,
    'the server-echoed currentDetailsVersion must NEVER be adopted silently');
  await app.requestServerQuote();
  assert.strictEqual(f.calls.length, 1,
    'a stale edit is a dead intent — re-entry must not buy another provider call');
  assert.deepStrictEqual(carousel.visible(),
    { tesla: 'Unavailable', escalade: 'Unavailable', sprinter: 'Unavailable' });
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, true);
});

check('STATIC: every interaction marker is wired to its real explicit action', () => {
  // beginPendingEdit resets all five markers at edit start
  assert.match(appBlock,
    /beginPendingEdit[\s\S]{0,2000}?routeDirection:\s*false,\s*routeAddress:\s*false,[\s\S]{0,40}?pickupAt:\s*false,\s*vehicle:\s*false,\s*traveler:\s*false/,
    'beginPendingEdit must reset every marker');
  // each setter is guarded so create flows AND flag-off legacy flows never
  // touch markers or call updateBookAvailability (dark invariance)
  assert.match(appBlock, /this\.pendingEdit && this\.editMarkers && this\.quoteFlowActive\(\) &&\s*\n\s*this\.state\.locations\.placeId[\s\S]{0,120}?routeAddress = true/,
    'routeAddress: only a LIVE autocomplete selection, quote flow only');
  assert.match(appBlock, /invalidateQuote\('airport changed'\);\s*\n\s*if \(this\.pendingEdit && this\.editMarkers && this\.quoteFlowActive\(\)\) \{\s*\n\s*this\.editMarkers\.routeDirection = true/,
    'routeDirection: an explicit airport choice, quote flow only');
  assert.match(appBlock, /invalidateQuote\('pickup time changed'\);\s*\n\s*if \(this\.pendingEdit && this\.editMarkers && this\.quoteFlowActive\(\)\) \{\s*\n\s*this\.editMarkers\.pickupAt = true/,
    'pickupAt: an explicit time set, quote flow only');
  assert.match(appBlock, /this\.quoteFlowActive\(\) &&\s*\n\s*!\(isObject && vehicleData\.userInitiated === false\)[\s\S]{0,80}?this\.editMarkers\.vehicle = true/,
    'vehicle: an explicit USER selection — carousel auto-select never counts');
  // traveler is set ONLY inside the modal completion callback
  assert.match(appBlock, /openRequired\(\(\) => \{[\s\S]{0,200}?editMarkers\.traveler = true/,
    'traveler: only the modal review sets it');
  // an edit session under the quote flow starts with Save honestly DISABLED
  assert.ok(appBlock.includes('if (this.quoteFlowActive()) this.updateBookAvailability();'),
    'beginPendingEdit recomputes availability so zero-marker Save is not a silent no-op');
});

// A check that awaits a promise that never settles drains node's event loop
// and would otherwise exit 0 with zero output — pre-arm failure so silence
// is loud. run() flips this to 0 only after the summary prints.
process.exitCode = 1;
run().catch((e) => { console.error(e); process.exit(1); });
