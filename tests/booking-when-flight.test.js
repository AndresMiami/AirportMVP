// When: the flight (Blacklane-style setup, 2026-09-11) — executed.
//
// Run: node tests/booking-when-flight.test.js
//
// Executes the real AirportBookingApp methods in the same VM-backed fake DOM
// as booking-route-auto-advance: arriving passengers set the pickup by the
// flight's landing (plus an offset) or by a time; the flight number is a real,
// saved field; the invoice reference no longer poses as a flight.

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

function makeElement(tag = 'div') {
  const listeners = new Map();
  const classes = new Set();
  const element = {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attrs: {},
    disabled: false,
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    focused: false,
    blurred: false,
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    prepend(child) { this.children.unshift(child); child.parentElement = this; return child; },
    remove() { this.removed = true; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
    },
    fire(type, detail) {
      if (type === 'click' && this.disabled) return;
      for (const listener of listeners.get(type) || []) {
        listener({ type, detail, target: this, preventDefault() {} });
      }
    },
    focus() { this.focused = true; },
    blur() { this.focused = false; this.blurred = true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name); else classes.add(name);
          return classes.has(name);
        }
        if (force) classes.add(name); else classes.delete(name);
        return force;
      },
      contains(name) { return classes.has(name); }
    },
    listenerCount(type) { return (listeners.get(type) || []).length; }
  };
  return element;
}

function loadAppClass(sourceOverride = appBlock) {
  const elements = new Map();
  const document = {
    readyState: 'complete',
    body: makeElement('body'),
    head: makeElement('head'),
    createElement: makeElement,
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const windowListeners = new Map();
  const location = {
    origin: 'https://example.test',
    hostname: 'example.test',
    search: '',
    href: 'https://example.test/indexMVP.html',
    replace() {},
    reload() {}
  };
  const navigator = {
    userAgent: 'test',
    standalone: false,
    onLine: true,
    serviceWorker: { register: async () => ({}) }
  };
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {}, group() {}, groupEnd() {} },
    debug: new Proxy({}, { get: () => () => {} }),
    errorHandler: { handleError() {} },
    document,
    location,
    navigator,
    window: {
      document,
      location,
      navigator,
      matchMedia: () => ({ matches: false }),
      addEventListener(type, listener) {
        const current = windowListeners.get(type) || [];
        current.push(listener);
        windowListeners.set(type, current);
      }
    },
    bootAuthReady: new Promise(() => {}),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: async () => { throw new Error('the When flight code must not make a network request'); },
    alert() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: {
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
      getRandomValues: (array) => array
    },
    PassengerModal: { getInstance: () => ({ getPassengerData: () => null }) },
    PickupNoteModal: { getInstance: () => ({ getPickupNotesData: () => null }) },
    PromotionModal: { getInstance: () => ({ getPromoData: () => null }) },
    currentActiveBooking: null,
    currentSession: null,
    getStoredRefCode: () => null,
    URL,
    AbortController,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    Promise,
    Set,
    Map,
    parseInt,
    parseFloat,
    isNaN
  };
  context.window.localStorage = context.localStorage;
  context.window.sessionStorage = context.sessionStorage;
  context.window.supabaseClient = { auth: { getSession: async () => ({ data: { session: null } }) } };
  context.supabaseClient = context.window.supabaseClient;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    sourceOverride + '\n;globalThis.__AirportBookingApp = AirportBookingApp;',
    context,
    { filename: 'indexMVP-app.js' }
  );
  return context.__AirportBookingApp;
}


const App = loadAppClass();

function sel(value) { const e = makeElement('select'); e.value = String(value); return e; }
function makeApp(mode, basis = 'arrival') {
  const app = Object.create(App.prototype);
  const basisBtns = ['arrival', 'time'].map((b) => { const e = makeElement('button'); e.dataset.basis = b; return e; });
  app.state = {
    mode,
    locations: { address: null, airport: null, placeId: null },
    route: { distance: null, duration: null, price: null },
    dateTime: { date: new Date(2026, 8, 20, 0, 0, 0), time: null },
    quote: { status: 'idle', key: null, data: null, error: null, seq: 0 },
    flight: '', flightBasis: basis, flightOffset: 15,
    vehicle: { selected: null, pricing: null }, passengers: 1, pickupNotes: null,
    ui: { currentPanel: 'when' }
  };
  app.els = {
    hourSelect: sel(2), minuteSelect: sel(15), ampmSelect: sel('PM'),
    flightInput: makeElement('input'), flightSection: makeElement(), whenBasis: makeElement(),
    timeLabel: makeElement(), flightLabel: makeElement(), flightHelp: makeElement(),
    flightOffsetSection: makeElement(), flightOffsetSelect: sel(15), flightPickupNote: makeElement(),
    vehicleSelectionBtn: makeElement('button'), basisBtns
  };
  app.pendingEdit = null;
  for (const stub of ['showTimeWarning', 'hideTimeWarning', 'invalidateQuote', 'updateTimeNote', 'updateVehiclePrices', 'updateBookButton', 'updateBookAvailability']) app[stub] = () => {};
  app.quoteFlowActive = () => true;
  return app;
}
const hm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

check('flight numbers are normalized to "AA 123" style; anything else is not a flight', () => {
  const app = makeApp('pickup');
  const cases = { 'aa123': 'AA 123', 'AA 1234': 'AA 1234', 'b6-1234': 'B6 1234', 'AAL123': 'AAL 123', '9w123': '9W 123', 'dl1514': 'DL 1514' };
  for (const [raw, want] of Object.entries(cases)) assert.strictEqual(app.normalizeFlightNumber(raw), want, raw);
  for (const bad of ['', 'hello', '12345', 'A1', 'COST-CENTER-9']) assert.strictEqual(app.normalizeFlightNumber(bad), null, bad);
});

check('Going to Airport: pickup time, an optional flight number, no arrival switch, Continue open without a flight', () => {
  const app = makeApp('dropoff');
  app.renderWhenFlight();
  assert.strictEqual(app.els.whenBasis.hidden, true, 'no arrival switch');
  assert.strictEqual(app.els.flightSection.style.display, 'block');
  assert.ok(app.els.flightLabel.innerHTML.includes('(optional)'));
  assert.strictEqual(app.els.flightOffsetSection.hidden, true);
  assert.strictEqual(app.els.timeLabel.textContent, 'Pickup time');
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, false);
});

check('Arriving by flight: the pickers set the landing, the flight number is required before Vehicle', () => {
  const app = makeApp('pickup', 'arrival');
  app.renderWhenFlight();
  assert.strictEqual(app.els.whenBasis.hidden, false);
  assert.ok(app.els.basisBtns[0].classList.contains('active') && app.els.basisBtns[0].getAttribute('aria-pressed') === 'true');
  assert.strictEqual(app.els.timeLabel.textContent, 'Your flight lands at');
  assert.strictEqual(app.els.flightLabel.innerHTML, 'Flight number', 'required: no "(optional)"');
  assert.strictEqual(app.els.flightOffsetSection.hidden, false);
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, true, 'no flight yet');
  app.state.flight = 'hello'; app.renderWhenFlight();
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, true, 'not a flight number');
  app.state.flight = 'aa 123'; app.renderWhenFlight();
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, false, 'a flight number opens Continue');
});

check('Arriving by time: a plain pickup time, no flight field (as in Blacklane), Continue open', () => {
  const app = makeApp('pickup', 'time');
  app.renderWhenFlight();
  assert.strictEqual(app.els.flightSection.style.display, 'none');
  assert.strictEqual(app.els.flightOffsetSection.hidden, true);
  assert.strictEqual(app.els.timeLabel.textContent, 'Pickup time');
  assert.ok(app.els.basisBtns[1].classList.contains('active'));
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, false);
});

check('by flight arrival: the pickup is the landing plus the chosen offset; every other mode keeps the picked time', () => {
  const app = makeApp('pickup', 'arrival');   // pickers: 2:15 PM on Sep 20
  app.updateDateTime();
  assert.strictEqual(hm(app.state.dateTime.landing), '14:15', 'landing = the picked time');
  assert.strictEqual(hm(app.state.dateTime.time), '14:30', 'pickup = 15 minutes after landing');
  assert.strictEqual(app.els.flightPickupNote.textContent, 'Your pickup: 2:30 PM');
  app.state.flightOffset = 0; app.updateDateTime();
  assert.strictEqual(hm(app.state.dateTime.time), '14:15', 'when the flight lands');
  app.state.flightOffset = 60; app.updateDateTime();
  assert.strictEqual(hm(app.state.dateTime.time), '15:15');
  app.setFlightBasis('time');
  assert.strictEqual(hm(app.state.dateTime.time), '14:15', 'by time: the picked time is the pickup');
  assert.strictEqual(app.state.dateTime.landing, null);
  assert.strictEqual(app.els.flightPickupNote.textContent, '');
  const going = makeApp('dropoff'); going.updateDateTime();
  assert.strictEqual(hm(going.state.dateTime.time), '14:15');
  assert.strictEqual(going.state.dateTime.landing, null);
});

check('the booking stores the When flight number; the invoice reference and the landing instruction go to the notes', () => {
  const app = makeApp('dropoff');
  let f = app.flightFieldsForSubmit({ mode: 'dropoff', flight: 'aa123', flightBasis: 'arrival' }, { chauffeurNotes: 'Gate B', referenceCode: 'COST-9' });
  assert.strictEqual(f.flightNumber, 'AA 123');
  assert.strictEqual(f.notes, 'Gate B\nReference: COST-9');
  f = app.flightFieldsForSubmit({ mode: 'pickup', flight: 'dl1514', flightBasis: 'arrival', flightOffset: 15, landing: new Date(2026, 8, 20, 14, 15) }, {});
  assert.strictEqual(f.flightNumber, 'DL 1514');
  assert.strictEqual(f.notes, 'Pickup 15 min after the flight lands (scheduled landing 2:15 PM).');
  f = app.flightFieldsForSubmit({ mode: 'pickup', flight: 'dl1514', flightBasis: 'arrival', flightOffset: 0, landing: new Date(2026, 8, 20, 14, 15) }, { referenceCode: 'X1' });
  assert.strictEqual(f.notes, 'Pickup when the flight lands (scheduled landing 2:15 PM).\nReference: X1');
  f = app.flightFieldsForSubmit({ mode: 'pickup', flight: 'dl1514', flightBasis: 'time' }, { referenceCode: 'X1' });
  assert.strictEqual(f.flightNumber, null, 'arriving by time sends no flight');
  assert.strictEqual(f.notes, 'Reference: X1');
  f = app.flightFieldsForSubmit({ mode: 'dropoff', flight: '' }, null);
  assert.strictEqual(JSON.stringify(f), JSON.stringify({ flightNumber: null, notes: '' }), 'nothing to store');   // compared as text: the object comes from the VM realm
});

check('wiring: the request uses flightFieldsForSubmit, never the reference as the flight; the snapshot carries the flight facts', () => {
  assert.ok(bookingPage.includes('const flightFields = this.flightFieldsForSubmit(submitState, bookingData.passenger?.notes);'));
  assert.ok(bookingPage.includes('notes: flightFields.notes,') && bookingPage.includes('flightNumber: flightFields.flightNumber,'));
  assert.ok(!bookingPage.includes('flightNumber: bookingData.passenger?.notes?.referenceCode'), 'the invoice reference no longer poses as the flight');
  for (const f of ['flight: this.state.flight,', 'flightBasis: this.state.flightBasis,', 'flightOffset: this.state.flightOffset,', "landing: this.state.dateTime?.landing || null"]) assert.ok(bookingPage.includes(f), f);
  assert.ok(bookingPage.includes("this.state.flight = e.target.value;\n                    this.renderWhenFlight();"), 'typing re-renders the Continue gate');
  assert.ok(!bookingPage.includes("flightSection.style.display = this.state.mode === 'pickup'"), 'step order delegates to renderWhenFlight');
  assert.ok(bookingPage.includes("this.els.modeBtns = document.querySelectorAll('.mode-btn');") && bookingPage.includes("this.els.basisBtns = document.querySelectorAll('.basis-btn');"), 'the arrival switch has its own class; the Where switch is untouched');
  assert.ok(!/class="mode-btn[^"]*" data-basis/.test(bookingPage));
  assert.ok(bookingPage.includes("this.state.flight = '';\n                this.state.flightBasis = 'arrival';"), 'a new direction starts a new flight');
  const pm = fs.readFileSync(path.join(repoRoot, 'js/passenger-modal.js'), 'utf8');
  assert.ok(pm.includes("parts.push('Ref: ' + n.referenceCode)") && !pm.includes("'Flight: ' + n.referenceCode"), 'the traveler sheet calls the reference a reference');
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
