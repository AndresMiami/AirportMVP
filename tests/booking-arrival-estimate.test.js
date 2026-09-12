// The When arrival estimate counts from the PICKUP (2026-09-12) — executed.
//
// Run: node tests/booking-arrival-estimate.test.js
//
// The line under the time pickers used to read `now + duration`: for a ride
// booked for tomorrow night it printed an arrival a few minutes from the
// moment the passenger was looking at it. Recorded as a deferral in PR #100
// and again in PR #109 ("more visible with flight-timed pickups, the first
// follow-up"); this suite is that follow-up's guard.
//
// It executes the real AirportBookingApp methods against a fake DOM, under a
// frozen clock, in the same VM style as booking-when-flight.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const bookingPage = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
const inlineBlocks = [...bookingPage.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]).filter((source) => source.trim());
assert.strictEqual(inlineBlocks.length, 2, 'expected the gate block and application block');
const appBlock = inlineBlocks[1];

let checks = 0;
const results = [];
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }

// ---- frozen clock: "now" is a fact of the fixture, never the runner's ----
// 12:00 PM Miami (EDT). The bug printed arrivals a few minutes from HERE.
const NOW_ISO = '2026-09-20T16:00:00.000Z';
let NOW_AT = Date.parse(NOW_ISO);
class FROZEN_DATE extends Date {
  constructor(...args) { if (args.length === 0) super(NOW_AT); else super(...args); }
  static now() { return NOW_AT; }
}

function makeElement(tag = 'div') {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    style: {}, dataset: {}, children: [], attrs: {},
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    getAttribute(n) { return this.attrs[n]; },
    addEventListener() {}, removeEventListener() {},
    classList: {
      add(...n) { n.forEach((x) => classes.add(x)); },
      remove(...n) { n.forEach((x) => classes.delete(x)); },
      toggle(n, f) { if (f) classes.add(n); else classes.delete(n); return !!f; },
      contains(n) { return classes.has(n); }
    }
  };
}

function loadAppClass() {
  const document = {
    readyState: 'complete', body: makeElement('body'), head: makeElement('head'),
    createElement: makeElement, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  const location = { origin: 'https://example.test', hostname: 'example.test', search: '', href: '', replace() {}, reload() {} };
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {}, group() {}, groupEnd() {} },
    debug: new Proxy({}, { get: () => () => {} }),
    errorHandler: { handleError() {} },
    document, location,
    navigator: { userAgent: 'test', standalone: false, onLine: true, serviceWorker: { register: async () => ({}) } },
    window: {
      document, location,
      navigator: { userAgent: 'test', standalone: false, onLine: true, serviceWorker: { register: async () => ({}) } },
      matchMedia: () => ({ matches: false }),
      addEventListener() {}
    },
    bootAuthReady: new Promise(() => {}),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async () => { throw new Error('the arrival estimate must not make a network request'); },
    alert() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', getRandomValues: (a) => a },
    PendingEditModel: require(path.join(repoRoot, 'js/pending-edit-model.js')),
    PassengerModal: { getInstance: () => ({ getPassengerData: () => null }) },
    PickupNoteModal: { getInstance: () => ({ getPickupNotesData: () => null }) },
    PromotionModal: { getInstance: () => ({ getPromoData: () => null }) },
    currentActiveBooking: null, currentSession: null, getStoredRefCode: () => null,
    URL, AbortController, Date: FROZEN_DATE,
    Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, Set, Map,
    parseInt, parseFloat, isNaN
  };
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.supabaseClient = { auth: { getSession: async () => ({ data: { session: null } }) } };
  context.supabaseClient = context.window.supabaseClient;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(appBlock + '\n;globalThis.__AirportBookingApp = AirportBookingApp;', context, { filename: 'indexMVP-app.js' });
  return context.__AirportBookingApp;
}

const App = loadAppClass();
const miamiHM = (d) => new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });

// A When panel with a real route and, optionally, a chosen pickup instant.
function makeApp({ mode = 'dropoff', duration = 38, distance = 12.4, realData = true, pickupISO = null } = {}) {
  const app = Object.create(App.prototype);
  app.state = {
    mode,
    locations: { address: { address: 'Fontainebleau' }, airport: { code: 'MIA' }, placeId: 'p' },
    route: { distance, duration, price: null, realData },
    dateTime: { date: new Date(2026, 8, 20), time: pickupISO ? new Date(pickupISO) : null },
    quote: { status: 'idle', key: null, data: null, error: null, seq: 0 },
    flight: '', flightBasis: 'time', flightOffset: 15,
    vehicle: { selected: null, pricing: null }, passengers: 1, pickupNotes: null,
    ui: { currentPanel: 'when' }
  };
  app.els = {
    arrivalTitle: makeElement(), tripDuration: makeElement(), routeAttribution: makeElement(),
    timeNote: makeElement()
  };
  app.pendingEdit = null;
  app._editRoute = null;
  return app;
}

// ---------------------------------------------------------------- the fix --

check('the arrival counts from the CHOSEN PICKUP, not from now', () => {
  // now = 12:00 PM Miami. Pickup tomorrow 11:30 PM Miami (03:30Z the day after).
  const app = makeApp({ pickupISO: '2026-09-22T03:30:00.000Z', duration: 38 });
  app.updateRouteDisplay();
  const text = app.els.arrivalTitle.textContent;
  assert.match(text, /12:08 ?\s?AM/, `pickup 11:30 PM + 38 min = 12:08 AM, got: ${text}`);
  // The regression, stated as the thing that must never come back: an arrival
  // within an hour of `now` for a ride booked a day and a half away.
  assert.doesNotMatch(text, /12:3\d\s?PM/, 'that would be now + duration again');
});

check('a far-future booking never prints a clock time near this moment', () => {
  // Every pickup below is days out; none may render a midday arrival.
  for (const pickupISO of ['2026-09-25T14:00:00.000Z', '2026-10-01T09:15:00.000Z', '2026-12-24T23:45:00.000Z']) {
    const app = makeApp({ pickupISO, duration: 45 });
    app.updateRouteDisplay();
    const expected = miamiHM(new Date(Date.parse(pickupISO) + 45 * 60000));
    const [h, m] = expected.split(':').map(Number);
    const h12 = ((h + 11) % 12) + 1;
    assert.ok(
      app.els.arrivalTitle.textContent.includes(`${h12}:${String(m).padStart(2, '0')}`),
      `${pickupISO} should arrive at Miami ${expected}, got: ${app.els.arrivalTitle.textContent}`
    );
  }
});

check('with no pickup chosen yet it states the drive and promises no clock time', () => {
  const app = makeApp({ pickupISO: null, duration: 38 });
  app.updateRouteDisplay();
  assert.match(app.els.arrivalTitle.textContent, /About 38 min to the airport/);
  assert.match(app.els.tripDuration.textContent, /Choose a pickup time/);
  // The old code filled exactly this gap from `now`; nothing may print a time.
  assert.doesNotMatch(
    `${app.els.arrivalTitle.textContent} ${app.els.tripDuration.textContent}`,
    /\d{1,2}:\d{2}\s?(AM|PM)/i,
    'no clock time may be invented before a pickup exists'
  );
});

check('the arrival is a MIAMI wall clock, not the device clock', () => {
  // Pickup 11:30 PM Miami on Sep 21. In Tokyo that instant is Sep 22 lunchtime,
  // so a device-clock render would differ in both hour and day.
  const app = makeApp({ pickupISO: '2026-09-22T03:30:00.000Z', duration: 38 });
  app.updateRouteDisplay();
  assert.strictEqual(miamiHM('2026-09-22T04:08:00.000Z'), '00:08', 'fixture sanity');
  assert.match(app.els.arrivalTitle.textContent, /12:08 ?\s?AM/,
    `rendered in the device zone (TZ=${process.env.TZ || 'unset'}) instead of Miami`);
});

check('the two When arrival lines agree — they read one instant, not two bases', () => {
  const app = makeApp({ pickupISO: '2026-09-22T03:30:00.000Z', duration: 38 });
  app.updateRouteDisplay();
  app.updateTimeNote();
  const shown = app.els.arrivalTitle.textContent.match(/(\d{1,2}:\d{2} ?\s?(?:AM|PM))/i);
  assert.ok(shown, 'the estimate line must render a time');
  const normalise = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  assert.ok(
    normalise(app.els.timeNote.innerHTML).includes(normalise(shown[1])),
    `the time note says "${app.els.timeNote.innerHTML}" while the estimate says "${shown[1]}"`
  );
});

check('an unusable route still shows the pinned refusal copy', () => {
  for (const route of [{ realData: false }, { duration: 0 }, { distance: 0 }]) {
    const app = makeApp({ pickupISO: '2026-09-22T03:30:00.000Z', ...route });
    app.updateRouteDisplay();
    assert.strictEqual(app.els.arrivalTitle.textContent, 'Route estimate unavailable');
    assert.strictEqual(app.els.tripDuration.textContent, 'Select a valid route to continue');
    assert.ok(!/null|NaN|Invalid/i.test(`${app.els.arrivalTitle.textContent} ${app.els.tripDuration.textContent}`));
  }
});

// ------------------------------------------------------------ the wiring --

check('a changed pickup re-renders the estimate — the stale basis could not self-correct', () => {
  // updateRouteDisplay used to be reachable only from calculateRoute, so
  // touching the clock left the line untouched. This pins the new call site.
  assert.match(
    appBlock,
    /this\.updateTimeNote\(\);[\s\S]{0,400}?this\.updateRouteDisplay\(\);/,
    'updateDateTime must re-render the estimate right after the time note'
  );
  const app = makeApp({ pickupISO: '2026-09-22T03:30:00.000Z', duration: 38 });
  app.updateRouteDisplay();
  const before = app.els.arrivalTitle.textContent;
  app.state.dateTime.time = new Date('2026-09-22T07:30:00.000Z');   // 3:30 AM Miami
  app.updateRouteDisplay();
  assert.notStrictEqual(app.els.arrivalTitle.textContent, before, 'a new pickup must produce a new arrival');
  assert.match(app.els.arrivalTitle.textContent, /4:08 ?\s?AM/);
});

check('`now` is gone from the estimate, and this is the source pin that keeps it gone', () => {
  const fn = appBlock.match(/updateRouteDisplay\(\)\s*\{[\s\S]*?\n            \}/);
  assert.ok(fn, 'updateRouteDisplay must be findable for this pin');
  assert.doesNotMatch(fn[0], /new Date\(\)\.getTime\(\)|now\.getTime\(\)/,
    'the arrival must never be built from the current instant again');
  assert.match(fn[0], /state\.dateTime\?\.time/, 'it reads the chosen pickup');
});

async function run() {
  process.exitCode = 1;
  for (const { name, fn } of queue) {
    try { await fn(); checks += 1; results.push(`  ✓ ${name}`); }
    catch (error) {
      results.push(`  ✗ ${name}\n      ${error.message}`);
      results.forEach((line) => console.log(line));
      console.log(`\nFAILED at: ${name}`);
      process.exit(1);
    }
  }
  results.forEach((line) => console.log(line));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  process.exitCode = 0;
}
run().catch((error) => { console.error(error); process.exit(1); });
