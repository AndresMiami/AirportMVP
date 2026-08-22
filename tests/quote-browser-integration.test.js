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

function makeContext({ enabled, fetchImpl, sessionToken = 'jwt-abc' }) {
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
  iframe.contentWindow = { postMessage: (msg) => posted.push(msg) };
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
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {}, group() {}, groupEnd() {} },
    // indexMVP calls several debug.* channels; tolerate any of them
    debug: new Proxy({}, { get: () => () => {} }),
    document,
    window: { addEventListener() {}, location: { search: '' }, matchMedia: () => ({ matches: false }) },
    setTimeout: (fn) => { fn(); return 0; },     // debounce runs inline
    clearTimeout() {},
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
    auth: { getSession: async () => ({ data: { session: sessionToken ? { access_token: sessionToken } : null } }) },
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
    quote: { status: 'idle', key: null, data: null, error: null, seq: 0 },
  };
  app.els = { bookBtn: byId.bookBtn = makeEl('button') };
  app.updateSummary = () => {};
  app.updateBookButton = () => {};
  app.pricingService = null;
  return { app, ctx, posted, alerts, byId, contentSection };
}

const SERVER_QUOTE = {
  quote: {
    intent: {
      mode: 'dropoff', airportCode: 'MIA',
      placeId: 'ChIJ_CANONICAL_xyz',        // deliberately NOT the submitted id
      formattedAddress: '1 Brickell Ave, Miami, FL',
      pickupAt: '2026-09-15T18:00:00.000Z', passengers: 1,
    },
    route: { miles: 10, minutes: 20, quality: 'traffic_aware' },
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
  assert.ok(/if \(SERVER_QUOTE_ENABLED\)/.test(body), 'must branch on the flag');
  assert.ok(/selectedQuoteVehicle\(\)/.test(body), 'enabled branch must read the server quote');
  assert.ok(/finalCents \/ 100/.test(body), 'enabled branch must use server cents');
  const enabledBranch = body.slice(body.indexOf('if (SERVER_QUOTE_ENABLED)'), body.indexOf('const legacy'));
  assert.ok(!/pricingService|state\.vehicle\.pricing/.test(enabledBranch),
    'the enabled branch must not consult pricing.js at all');
});

check('STATIC: the payload carries the token, the CANONICAL place id and the pricing version', () => {
  assert.ok(/apiPayload\.quoteToken = sv\.token;/.test(appBlock), 'quoteToken must be submitted');
  assert.ok(/apiPayload\.placeId = this\.state\.quote\.data\.intent\.placeId;/.test(appBlock),
    "2C recomputes the hash from the server's canonical id, not autocomplete's");
  assert.ok(/apiPayload\.pricingVersion = this\.state\.quote\.data\.pricingVersion;/.test(appBlock));
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

run().catch((e) => { console.error(e); process.exit(1); });
