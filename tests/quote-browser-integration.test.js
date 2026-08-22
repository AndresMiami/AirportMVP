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
  const cctx = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      readyState: 'complete', getElementById: (id) => els[id] || null,
      querySelector: () => mk(), querySelectorAll: () => [],
      addEventListener() {}, createElement: mk, body: mk(),
    },
    window: {
      addEventListener: (t, fn) => { if (t === 'message') listener = fn; },
      parent: { postMessage: (msg) => parentMessages.push(msg) },
      getComputedStyle: () => ({ paddingLeft: '0' }),
    },
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
    becomeReady() { inst.setupCommunication(); ready = true; },   // installs the REAL listener
    isReady: () => ready,
    deliver(msg) { if (ready && listener) listener({ data: msg }); },
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
}

// ---------------- fake DOM ----------------
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, children: [], listeners: {}, attrs: {},
    id: null, innerHTML: '', textContent: '', disabled: false, type: '',
    appendChild(c) { el.children.push(c); c.parent = el; return c; },
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
  iframe.contentWindow = { postMessage: (msg) => { posted.push(msg); carousel.deliver(msg); } };
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
    location: { search: '', href: 'https://example.test/indexMVP.html', replace() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
        return { data: { session: sessionToken ? { access_token: sessionToken } : null } };
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
  const sendToApp = (msg) => appMessageListeners.forEach((fn) => fn({ data: msg }));
  ctx.window.airportApp = app;
  return { app, ctx, posted, alerts, byId, contentSection, carousel, runTimers, timers, sendToApp };
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
  const { app } = makeContext({ enabled: false, fetchImpl: f });
  app.requestServerQuote();
  app.scheduleQuote();
  assert.strictEqual(f.calls.length, 0, 'the disabled build must never call /api/quote-ride');
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
  const { app, posted } = makeContext({ enabled: true, fetchImpl: okFetch(body) });
  await app.requestServerQuote();
  assert.strictEqual(app.state.quote.status, 'error');
  assert.strictEqual(posted.filter((m) => m.type === 'updatePrices').length, 0);
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
check('confirmBooking refuses to submit on an expired quote', async () => {
  const f = okFetch(quoteWithTtl(-1));
  const { app, alerts } = makeContext({ enabled: true, fetchImpl: f });
  await app.requestServerQuote();
  app.state.vehicle = { type: 'tesla', selected: 'tesla' };
  const before = f.calls.length;
  await app.confirmBooking();
  assert.ok(alerts.some((a) => /no longer current/i.test(a)),
    'the passenger must be told, not silently repriced');
  const bookingCalls = f.calls.slice(before).filter((c) => /create-booking|update-pending-booking/.test(c.url));
  assert.strictEqual(bookingCalls.length, 0, 'no booking may be written from a stale quote');
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
      getContactInfo: () => ({ name: 'Passenger', phone: '3055550100', type: 'booker' }),
      getPassengerData: () => ({ type: 'self', data: null }),
    }),
  };
  let shownError = '';
  app.showPaymentError = (message) => { shownError = String(message); };

  const callsBeforeSubmit = f.calls.length;
  const pending = app.confirmBooking();
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

check('TTL: a timer expires the visible price and disables Book without a click', async () => {
  const { app, carousel, runTimers } = makeContext({ enabled: true, fetchImpl: okFetch(quoteWithTtl(15)) });
  await app.requestServerQuote();
  app.selectVehicle({ id: 'tesla', name: 'Tesla Model Y', passengers: 4, bags: 4, price: 39 });
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, false);
  assert.strictEqual(carousel.visible().tesla, '$39');

  // the quote reaches its TTL while the passenger is still on the screen
  const past = new Date(Date.now() - 1000).toISOString();
  Object.keys(app.state.quote.data.vehicles).forEach((k) => {
    app.state.quote.data.vehicles[k].expiresAt = past;
  });
  runTimers();

  assert.deepStrictEqual(carousel.visible(),
    { tesla: 'Expired', escalade: 'Expired', sprinter: 'Expired' },
    'an expired price must stop looking valid on screen');
  assert.strictEqual(app.els.bookBtn.disabled, true, 'Book must disable itself at expiry');
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

check('SCOPE: a pending edit does not use create-scoped quotes', async () => {
  const f = okFetch(quoteWithTtl(15));
  const { app, carousel } = makeContext({ enabled: true, fetchImpl: f });
  app.pendingEdit = { bookingId: 'b-1', tripCode: 'LM-1', detailsVersion: 3 };
  assert.strictEqual(app.quoteFlowActive(), false,
    'every token the endpoint signs is purpose:create — an edit must not carry one');
  app.updateVehiclePrices();
  assert.strictEqual(f.calls.length, 0, 'an edit must not request a create-scoped quote');
  app.updateBookAvailability();
  assert.strictEqual(app.els.bookBtn.disabled, false, 'editing must not be blocked by the quote gate');
  app.renderQuoteState();
  assert.deepStrictEqual(carousel.visible(), CAROUSEL_DEFAULTS,
    'the quote UI must stay out of the edit flow entirely');
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
  app.pendingEdit = { bookingId: 'b-1', tripCode: 'LM-1', detailsVersion: 2 };
  runTimers();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(f.calls.length, 0,
    'requestServerQuote must gate on quoteFlowActive(), not the raw flag');
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

run().catch((e) => { console.error(e); process.exit(1); });
