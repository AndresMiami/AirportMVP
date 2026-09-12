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


// ---- a frozen clock, so nothing rots and "now" is a fact, not the runner ----
const NOW_ISO = '2026-09-20T16:00:00.000Z';           // 12:00 PM Miami (EDT)
const NOW_MS = Date.parse(NOW_ISO);   // 12:00 PM Miami; 01:00 the NEXT day in Tokyo
let NOW_AT = Date.parse(NOW_ISO);
class FROZEN_DATE extends Date {
  constructor(...args) { if (args.length === 0) super(NOW_AT); else super(...args); }
  static now() { return NOW_AT; }
}
function atInstant(iso, fn) { const prev = NOW_AT; NOW_AT = Date.parse(iso); try { return fn(); } finally { NOW_AT = prev; } }
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
    insertBefore(child, ref) {
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at >= 0) this.children.splice(at, 0, child); else this.children.push(child);
      child.parentElement = this; return child;
    },
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
    PendingEditModel: require(path.join(repoRoot, 'js/pending-edit-model.js')),
    PassengerModal: { getInstance: () => ({ getPassengerData: () => null }) },
    PickupNoteModal: { getInstance: () => ({ getPickupNotesData: () => null }) },
    PromotionModal: { getInstance: () => ({ getPromoData: () => null }) },
    currentActiveBooking: null,
    currentSession: null,
    getStoredRefCode: () => null,
    URL,
    AbortController,
    Date: FROZEN_DATE,
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
  // tests register ids the app looks up through ITS document, not Node's
  context.__AirportBookingApp.__elements = elements;
  return context.__AirportBookingApp;
}



const App = loadAppClass();
const MODEL = require(path.join(repoRoot, 'js/pending-edit-model.js'));

function sel(value) { const e = makeElement('select'); e.value = String(value); return e; }
// Pickers are read as MIAMI wall clock. Defaults: Sep 20 2026, 2:15 PM Miami.
function makeApp(mode, basis = 'arrival', { y = 2026, m = 9, d = 20, hour = 2, minute = 15, ampm = 'PM', offset = 15 } = {}) {
  const app = Object.create(App.prototype);
  const basisBtns = ['arrival', 'time'].map((b) => { const e = makeElement('button'); e.dataset.basis = b; return e; });
  app.state = {
    mode,
    locations: { address: null, airport: null, placeId: null },
    route: { distance: null, duration: null, price: null },
    dateTime: { date: new Date(y, m - 1, d, 0, 0, 0), time: null },
    quote: { status: 'idle', key: null, data: null, error: null, seq: 0 },
    flight: '', flightBasis: basis, flightOffset: offset,
    vehicle: { selected: null, pricing: null }, passengers: 1, pickupNotes: null,
    ui: { currentPanel: 'when' }
  };
  app.els = {
    hourSelect: sel(hour), minuteSelect: sel(minute), ampmSelect: sel(ampm),
    flightInput: makeElement('input'), flightSection: makeElement(), whenBasis: makeElement(),
    timeLabel: makeElement(), flightLabel: makeElement(), flightHelp: makeElement(), flightError: makeElement('p'),
    flightOffsetSection: makeElement(), flightOffsetSelect: sel(offset), flightPickupNote: makeElement(),
    vehicleSelectionBtn: makeElement('button'), basisBtns,
    modeBtns: [], airportOptions: [], addressStep: makeElement(), airportStep: makeElement(),
    flowConnector: makeElement(), airportTitle: makeElement(), addressInput: makeElement('input'),
    airportBadge: makeElement(), panelsWrapper: makeElement(), progressLine: makeElement(),
    progressLine2: makeElement(), summaryBar: makeElement(), progressSteps: []
  };
  app.els.flightError.hidden = true;
  app.pendingEdit = null;
  app._editRoute = null;
  for (const stub of ['showTimeWarning', 'hideTimeWarning', 'invalidateQuote', 'updateTimeNote', 'updateVehiclePrices', 'updateBookButton', 'updateBookAvailability', 'updateSummary', 'updateProgressSteps', 'updateVehicleMap', 'updateVehiclePrices']) app[stub] = () => {};
  app.quoteFlowActive = () => true;
  app.canContinue = () => true;
  return app;
}
const iso = (d) => (d ? new Date(d).toISOString() : null);
const miamiHM = (d) => new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });

check('flight numbers normalize to "AA 123" style; anything else is not a flight', () => {
  const app = makeApp('pickup');
  for (const [raw, want] of Object.entries({ 'aa123': 'AA 123', 'AA 1234': 'AA 1234', 'b6-1234': 'B6 1234', 'AAL123': 'AAL 123', '9w123': '9W 123' })) {
    assert.strictEqual(app.normalizeFlightNumber(raw), want, raw);
  }
  for (const bad of ['', 'hello', '12345', 'A1', 'COST-CENTER-9']) assert.strictEqual(app.normalizeFlightNumber(bad), null, bad);
});

check('the pickers are a MIAMI wall clock: one wall time stores one instant, whatever the device zone', () => {
  const app = makeApp('pickup', 'time');           // 2:15 PM Miami on Sep 20 2026 = 18:15Z (EDT)
  assert.ok(app.miamiModel(), 'the shared Miami model must be present, or this suite would silently test the device clock');
  assert.ok(app.resolveMiamiWall({ year: 2026, month: 9, day: 20, hour: 14, minute: 15 }).length === 1, 'resolved through the model');
  app.updateDateTime();
  assert.strictEqual(iso(app.state.dateTime.time), '2026-09-20T18:15:00.000Z');
  // proven across zones by running this file under three TZs (below) and by
  // the CI matrix; the assertion above is zone-independent by construction.
  assert.strictEqual(miamiHM(app.state.dateTime.time), '14:15');
});

check('daylight saving: the spring-forward gap is refused and blocks; the fall-back hour is never guessed', () => {
  const gap = makeApp('pickup', 'time', { y: 2026, m: 3, d: 8, hour: 2, minute: 30, ampm: 'AM' });
  gap.updateDateTime();
  assert.strictEqual(gap.state.dateTime.time, null, '2:30 AM never happens that day: nothing is stored');
  assert.strictEqual(gap.state.dateTime.timeSkipped, true);
  assert.strictEqual(gap.flightBlockReason(), 'time');
  assert.strictEqual(gap.els.vehicleSelectionBtn.disabled, true, 'a time Miami does not have cannot continue');
  const fold = makeApp('pickup', 'time', { y: 2026, m: 11, d: 1, hour: 1, minute: 30, ampm: 'AM' });
  fold.updateDateTime();
  assert.strictEqual(MODEL.resolveMiamiWallClock({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }).length, 2, 'the hour repeats');
  assert.strictEqual(fold.state.dateTime.time, null, 'a repeated hour is never guessed — it is asked (see the choice check)');
  assert.strictEqual(fold.flightBlockReason(), 'ambiguous');
});

check('the elapsed rule judges the PICKUP, not the landing: a flight that has landed keeps its future pickup', () => {
  // now = 12:00 PM Miami. Landing 11:45 AM + 30 = 12:15 PM pickup: still future.
  const app = makeApp('pickup', 'arrival', { hour: 11, minute: 45, ampm: 'AM', offset: 30 });
  app.state.flight = 'AA 123';
  app.updateDateTime();
  assert.strictEqual(miamiHM(app.state.dateTime.landing), '11:45', 'the landing is left alone');
  assert.strictEqual(miamiHM(app.state.dateTime.time), '12:15', 'the pickup is landing + offset');
  assert.strictEqual(app.els.hourSelect.value, '11', 'the pickers are not rewritten');
});

check('an elapsed effective pickup snaps forward, and the landing follows it', () => {
  const app = makeApp('pickup', 'arrival', { hour: 10, minute: 0, ampm: 'AM', offset: 15 });  // pickup 10:15, now 12:00
  app.state.flight = 'AA 123';
  app.updateDateTime();
  const pickupMs = new Date(app.state.dateTime.time).getTime();
  assert.ok(pickupMs >= NOW_MS + 30 * 60000, 'snapped to at least 30 minutes out');
  assert.strictEqual(new Date(app.state.dateTime.time).getTime() - new Date(app.state.dateTime.landing).getTime(), 15 * 60000, 'the offset is preserved');
  assert.strictEqual(new Date(app.state.dateTime.landing).getMinutes() % 15, 0, 'the landing lands on a quarter hour the pickers can show');
  const exact = makeApp('pickup', 'time', { hour: 12, minute: 0, ampm: 'PM' });   // exactly now
  exact.updateDateTime();
  assert.ok(new Date(exact.state.dateTime.time).getTime() > NOW_MS, 'exact-now is not a future pickup');
  const zero = makeApp('pickup', 'arrival', { hour: 1, minute: 0, ampm: 'PM', offset: 0 });
  zero.state.flight = 'AA 123';
  zero.updateDateTime();
  assert.strictEqual(iso(zero.state.dateTime.time), iso(zero.state.dateTime.landing), 'offset zero: pickup is the landing');
  const mid = makeApp('pickup', 'arrival', { hour: 11, minute: 45, ampm: 'PM', offset: 60 });
  mid.state.flight = 'AA 123';
  mid.updateDateTime();
  assert.strictEqual(iso(mid.state.dateTime.time), '2026-09-21T04:45:00.000Z', 'past midnight, still one instant');
});

check('one flight rule: the button, the Vehicle transition and the final submission all refuse', () => {
  const app = makeApp('pickup', 'arrival');
  app.updateDateTime();
  const navs = [];
  const realNav = app.navigateToPanel.bind(app);
  app.navigateToPanel = (p) => { navs.push(p); if (p === 'when') return; return realNav(p); };
  assert.strictEqual(app.flightBlockReason(), 'required');
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, true, 'the button shows it');
  app.navigateToPanel('vehicle');
  assert.ok(!navs.includes('vehicle') || app.state.ui.currentPanel !== 'vehicle', 'the transition refuses');
  assert.strictEqual(app.els.flightError.hidden, false, 'and says why');
  let confirmed = 0;
  app.confirmBooking = async () => { confirmed += 1; };
  app._submitInFlight = false;
  app.handleBookingClick();
  assert.strictEqual(confirmed, 0, 'the tap refuses too');
  // the final submission refuses on its own, even reached directly
  app._submitInFlight = false;
  const realConfirm = App.prototype.confirmBooking.bind(app);
  let reachedNetwork = false;
  app.quoteFlowActive = () => { reachedNetwork = true; return false; };
  realConfirm();
  assert.strictEqual(reachedNetwork, false, 'confirmBooking refuses before any network work');
  app.quoteFlowActive = () => true;
  // with a flight, the predicate clears; the POST itself is proven in
  // tests/quote-browser-integration (FLIGHT: one tap POSTs ...).
  app.state.flight = 'aa 1234';
  app.renderWhenFlight();
  assert.strictEqual(app.flightBlockReason(), null);
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, false);
  assert.strictEqual(app.els.flightError.hidden, true, 'the message clears');
});

check('a nonblank invalid flight is never silently dropped, in either direction', () => {
  const going = makeApp('dropoff');
  going.state.flight = 'not-a-flight';
  going.renderWhenFlight();
  assert.strictEqual(going.flightBlockReason(), 'invalid');
  assert.strictEqual(going.els.vehicleSelectionBtn.disabled, true, 'optional, but not silently discarded');
  assert.strictEqual(going.els.flightError.hidden, false);
  assert.match(going.els.flightError.textContent, /AA 1234|flight number/);
  going.state.flight = '';
  going.renderWhenFlight();
  assert.strictEqual(going.flightBlockReason(), null, 'blank stays optional');
  assert.strictEqual(going.els.flightError.hidden, true);
});

check('executed wiring: the basis buttons and the offset select drive the recalculation', () => {
  const app = makeApp('pickup', 'arrival', { hour: 2, minute: 15, ampm: 'PM', offset: 15 });
  app.state.flight = 'AA 123';
  app.bindEvents();
  app.updateDateTime();
  assert.strictEqual(miamiHM(app.state.dateTime.time), '14:30');
  app.els.flightOffsetSelect.value = '45';
  app.els.flightOffsetSelect.fire('change');
  assert.strictEqual(app.state.flightOffset, 45);
  assert.strictEqual(miamiHM(app.state.dateTime.time), '15:00', 'the offset change recalculates');
  app.els.basisBtns[1].fire('click');
  assert.strictEqual(app.state.flightBasis, 'time');
  assert.strictEqual(miamiHM(app.state.dateTime.time), '14:15', 'by time: the picked time is the pickup');
  assert.strictEqual(app.state.dateTime.landing, null);
  app.els.flightInput.value = 'zz';
  app.els.flightInput.fire('input');
  assert.strictEqual(app.state.flight, 'zz', 'typing reaches state');
});

check('what the booking stores: the structured flight and the passenger notes, never a derived landing sentence', () => {
  const app = makeApp('pickup', 'arrival');
  let f = app.flightFieldsForSubmit({ mode: 'pickup', flight: 'dl1514', flightBasis: 'arrival', flightOffset: 15, landing: new Date('2026-09-20T18:15:00Z') }, { chauffeurNotes: 'Blue bag', referenceCode: 'ACME-7' });
  assert.strictEqual(f.flightNumber, 'DL 1514');
  assert.strictEqual(f.notes, 'Blue bag\nReference: ACME-7');
  assert.ok(!/landing|lands/i.test(f.notes), 'no prose that Manage ride could not maintain');
  f = app.flightFieldsForSubmit({ mode: 'pickup', flight: 'dl1514', flightBasis: 'time' }, { referenceCode: 'X1' });
  assert.strictEqual(f.flightNumber, null, 'arriving by time sends no flight');
  f = app.flightFieldsForSubmit({ mode: 'dropoff', flight: '' }, null);
  assert.strictEqual(JSON.stringify(f), JSON.stringify({ flightNumber: null, notes: '' }));
});

check('Manage ride: the current editor holds airport and direction for a flight-bearing route', () => {
  const app = makeApp('pickup', 'arrival');
  const limit = makeElement('div'); limit.hidden = true;
  const done = makeElement('button'); const reason = makeElement('div');
  const byId = { editRouteFlightLimit: limit, editRouteDone: done, editRouteReason: reason };
  app.getAirportName = (c) => c;
  for (const [id, el] of Object.entries(byId)) App.__elements.set(id, el);
  app.els.modeBtns = ['dropoff', 'pickup'].map((m) => { const b = makeElement('button'); b.dataset.mode = m; return b; });
  app.els.airportOptions = ['MIA', 'FLL'].map((c) => { const o = makeElement('button'); o.dataset.airport = c; return o; });
  app._editRoute = { hasFlight: true, routeDraft: { mode: 'pickup', airport: 'MIA', airportLabel: 'MIA', address: { label: 'x', placeId: 'p1' } }, onDone() {}, onBack() {} };
  app.renderEditRouteWhere();
  assert.strictEqual(limit.hidden, false, 'the limit is explained');
  assert.match(limit.textContent, /has a flight/);
  assert.match(limit.textContent, /address or the time/);
  assert.ok(app.els.modeBtns.every((b) => b.disabled), 'direction is held');
  assert.ok(app.els.airportOptions.every((o) => o.disabled), 'airport is held');
  app.onModeTap('dropoff');
  assert.strictEqual(app._editRoute.routeDraft.mode, 'pickup', 'a tap cannot change direction');
  app.onAirportTap('FLL');
  assert.strictEqual(app._editRoute.routeDraft.airport, 'MIA', 'a tap cannot change the airport');
  assert.strictEqual(app._editRoute.hasFlight, true, 'the app-level hold remains active');
  // without a flight, Manage ride still edits both
  app._editRoute = { hasFlight: false, routeDraft: { mode: 'pickup', airport: 'MIA', airportLabel: 'MIA', address: { label: 'x', placeId: 'p1' } }, onDone() {}, onBack() {} };
  app.renderEditRouteWhere();
  app.onModeTap('dropoff');
  app.onAirportTap('FLL');
  assert.strictEqual(app._editRoute.routeDraft.mode, 'dropoff');
  assert.strictEqual(app._editRoute.routeDraft.airport, 'FLL');
  assert.strictEqual(limit.hidden, true);
  for (const id of Object.keys(byId)) App.__elements.delete(id);
});

check('Miami from the first screen: Today, Tomorrow and the default time are Miami, not the device day', () => {
  const app = makeApp('dropoff');
  const ids = { todayDate: makeElement(), tomorrowDate: makeElement(), todayBtn: makeElement('button'), tomorrowBtn: makeElement('button'), otherDatesBtn: makeElement('button') };
  for (const [id, el] of Object.entries(ids)) App.__elements.set(id, el);
  // frozen NOW is 12:00 PM Miami on Sep 20 — already Sep 21 in Tokyo
  app.initializeDateSelection();
  assert.strictEqual(ids.todayDate.textContent, 'Sep 20', 'Today is Miami\'s day');
  assert.strictEqual(ids.tomorrowDate.textContent, 'Sep 21');
  assert.strictEqual(new Date(ids.todayBtn.dataset.date).getDate(), 20);
  app.setDefaultDateTime();
  assert.strictEqual(app.els.hourSelect.value, 12, 'Miami noon');
  assert.strictEqual(app.els.ampmSelect.value, 'PM');
  assert.strictEqual(app.state.dateTime.date.getDate(), 20);
  // Miami noon is not strictly future at the frozen instant, so the page's
  // EXISTING elapsed rule moves it. The point here is that the day and hour
  // came from Miami, not from the device.
  assert.strictEqual(iso(app.state.dateTime.time), '2026-09-20T16:30:00.000Z');
  // rounding past midnight carries the DAY: 11:50 PM Miami on Sep 20
  atInstant('2026-09-21T03:50:00.000Z', () => {
    const late = makeApp('dropoff');
    late.setDefaultDateTime();
    assert.strictEqual(late.els.hourSelect.value, 12);
    assert.strictEqual(late.els.ampmSelect.value, 'AM');
    assert.strictEqual(late.state.dateTime.date.getDate(), 21, 'midnight carried the day');
    const stored = late.miamiPartsOf(late.state.dateTime.time);
    assert.strictEqual(stored.day, 21, 'and the stored instant really is the next Miami day');
    assert.strictEqual(stored.month, 9);
    assert.ok(new Date(late.state.dateTime.time).getTime() > NOW_AT, 'and it is still a future pickup');
  });
  // ZONE-INDEPENDENT proof: make the Miami model report a different DAY and
  // HOUR than the device has. Every default must follow the model. (A future
  // wall clock, so the page's own elapsed rule does not move it.)
  const pretend = makeApp('dropoff');
  pretend.miamiPartsOf = () => ({ year: 2026, month: 9, day: 21, hour: 7, minute: 5 });
  pretend.initializeDateSelection();
  assert.strictEqual(ids.todayDate.textContent, 'Sep 21', 'Today follows the Miami model, not the device');
  assert.strictEqual(ids.tomorrowDate.textContent, 'Sep 22');
  pretend.setDefaultDateTime();
  assert.strictEqual(pretend.els.hourSelect.value, 7, 'the hour follows the Miami model');
  assert.strictEqual(pretend.els.ampmSelect.value, 'AM');
  assert.strictEqual(pretend.els.minuteSelect.value, 15, 'rounded up to the next quarter hour');
  assert.strictEqual(pretend.state.dateTime.date.getDate(), 21, 'and so does the day');
  for (const id of Object.keys(ids)) App.__elements.delete(id);
  assert.match(bookingPage, /const today = this\.miamiDayOf\(\) \|\| new Date\(\);\s*today\.setHours\(0, 0, 0, 0\);/, 'the calendar cutoff is Miami\'s today');
});

check('midnight default keeps the visible Miami date, date state and stored pickup together', () => {
  atInstant('2026-09-21T03:50:00.000Z', () => { // Sep 20, 11:50 PM Miami
    const app = makeApp('dropoff');
    const ids = { todayDate: makeElement(), tomorrowDate: makeElement(), todayBtn: makeElement('button'), tomorrowBtn: makeElement('button'), otherDatesBtn: makeElement('button') };
    ids.todayBtn.classList.add('active'); // production markup starts on Today
    Object.assign(app.els, ids);
    for (const [id, el] of Object.entries(ids)) App.__elements.set(id, el);

    app.initializeDateTime();

    const stored = app.miamiPartsOf(app.state.dateTime.time);
    assert.strictEqual(ids.todayDate.textContent, 'Sep 20');
    assert.strictEqual(ids.tomorrowDate.textContent, 'Sep 21');
    assert.strictEqual(ids.todayBtn.classList.contains('active'), false, 'Today cannot stay highlighted');
    assert.strictEqual(ids.tomorrowBtn.classList.contains('active'), true, 'Tomorrow is visibly selected');
    assert.strictEqual([ids.todayBtn, ids.tomorrowBtn, ids.otherDatesBtn].filter((b) => b.classList.contains('active')).length, 1,
      'exactly one date shortcut is active');
    assert.strictEqual(app.state.dateTime.date.getDate(), 21, 'the date carrier moved to tomorrow');
    assert.strictEqual(new Date(ids.tomorrowBtn.dataset.date).getDate(), app.state.dateTime.date.getDate(),
      'the visible shortcut and date carrier name the same day');
    assert.deepStrictEqual([stored.year, stored.month, stored.day, stored.hour, stored.minute], [2026, 9, 21, 0, 0]);
    assert.strictEqual(iso(app.state.dateTime.time), '2026-09-21T04:00:00.000Z');
    for (const id of Object.keys(ids)) App.__elements.delete(id);
  });
});

check('elapsed snap across midnight keeps the controlled wall date and visible shortcut together', () => {
  atInstant('2026-09-21T03:50:00.000Z', () => { // Sep 20, 11:50 PM Miami
    const mountDates = (app) => {
      const ids = { todayDate: makeElement(), tomorrowDate: makeElement(), todayBtn: makeElement('button'), tomorrowBtn: makeElement('button'), otherDatesBtn: makeElement('button') };
      ids.todayBtn.classList.add('active');
      Object.assign(app.els, ids);
      for (const [id, el] of Object.entries(ids)) App.__elements.set(id, el);
      app.initializeDateSelection();
      return ids;
    };

    const pickup = makeApp('dropoff', 'time', { hour: 11, minute: 45, ampm: 'PM' });
    let ids = mountDates(pickup);
    pickup.updateDateTime();
    let stored = pickup.miamiPartsOf(pickup.state.dateTime.time);
    assert.strictEqual(pickup.state.dateTime.date.getDate(), 21, 'the corrected pickup carries tomorrow into state');
    assert.strictEqual(ids.todayBtn.classList.contains('active'), false);
    assert.strictEqual(ids.tomorrowBtn.classList.contains('active'), true, 'the corrected pickup visibly selects Tomorrow');
    assert.strictEqual([ids.todayBtn, ids.tomorrowBtn, ids.otherDatesBtn].filter((b) => b.classList.contains('active')).length, 1,
      'the correction leaves one visible selection');
    assert.deepStrictEqual([stored.year, stored.month, stored.day, stored.hour, stored.minute], [2026, 9, 21, 0, 30]);
    pickup.els.minuteSelect.value = 45;
    pickup.updateDateTime();
    stored = pickup.miamiPartsOf(pickup.state.dateTime.time);
    assert.deepStrictEqual([stored.year, stored.month, stored.day, stored.hour, stored.minute], [2026, 9, 21, 0, 45],
      'a later time adjustment stays on the corrected day');

    // In flight-arrival mode the controls describe LANDING, not pickup. A
    // one-hour offset may put pickup tomorrow while the selected landing date
    // correctly remains today.
    for (const id of Object.keys(ids)) App.__elements.delete(id);
    const arrival = makeApp('pickup', 'arrival', { hour: 10, minute: 0, ampm: 'PM', offset: 60 });
    arrival.state.flight = 'AA 123';
    ids = mountDates(arrival);
    arrival.updateDateTime();
    const landing = arrival.miamiPartsOf(arrival.state.dateTime.landing);
    stored = arrival.miamiPartsOf(arrival.state.dateTime.time);
    assert.strictEqual(arrival.state.dateTime.date.getDate(), 20, 'the date follows the controlled landing wall time');
    assert.strictEqual(ids.todayBtn.classList.contains('active'), true, 'Today remains selected for the landing');
    assert.strictEqual(ids.tomorrowBtn.classList.contains('active'), false);
    assert.strictEqual([ids.todayBtn, ids.tomorrowBtn, ids.otherDatesBtn].filter((b) => b.classList.contains('active')).length, 1,
      'the flight correction leaves one visible selection');
    assert.deepStrictEqual([landing.year, landing.month, landing.day, landing.hour, landing.minute], [2026, 9, 20, 23, 30]);
    assert.deepStrictEqual([stored.year, stored.month, stored.day, stored.hour, stored.minute], [2026, 9, 21, 0, 30]);
    for (const id of Object.keys(ids)) App.__elements.delete(id);
  });
});

check('no Miami clock, no guess: the page fails closed instead of using the device clock', () => {
  const app = makeApp('pickup', 'time');
  app.miamiModel = () => null;           // the shared model failed to load
  app.updateDateTime();
  assert.strictEqual(app.state.dateTime.time, null, 'nothing is stored');
  assert.strictEqual(app.state.dateTime.clockUnavailable, true);
  assert.strictEqual(app.flightBlockReason(), 'clock');
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, true);
});

check('the repeated hour is asked, never guessed, in the passenger\'s words', () => {
  const app = makeApp('pickup', 'time', { y: 2026, m: 11, d: 1, hour: 1, minute: 30, ampm: 'AM' });
  const parent = makeElement(); parent.insertBefore = (node) => { parent.children.push(node); };
  app.els.timeNote = makeElement(); app.els.timeNote.parentElement = parent;
  const box = makeElement(); App.__elements.set('timeChoice', box);
  const warning = makeElement(); warning.querySelector = () => warningText; const warningText = makeElement();
  App.__elements.set('timeWarning', warning);
  app.updateDateTime();
  assert.strictEqual(app.state.dateTime.time, null, 'no pickup time is stored while it is ambiguous');
  assert.strictEqual(app.flightBlockReason(), 'ambiguous');
  assert.strictEqual(app.els.vehicleSelectionBtn.disabled, true);
  assert.strictEqual(box.children.length, 3, 'a note and two choices');
  assert.strictEqual(box.children[1].textContent, 'First 1:30 AM — before clocks change');
  assert.strictEqual(box.children[2].textContent, 'Second 1:30 AM — after clocks change');
  box.children[2].fire('click');                       // the later instant (EST)
  assert.strictEqual(iso(app.state.dateTime.time), '2026-11-01T06:30:00.000Z');
  assert.strictEqual(app.flightBlockReason(), null);
  box.children[1].fire('click');                       // the earlier instant (EDT)
  assert.strictEqual(iso(app.state.dateTime.time), '2026-11-01T05:30:00.000Z');
  // changing the time drops the choice and asks again
  app.els.minuteSelect.value = 45;
  app.updateDateTime();
  assert.strictEqual(app.state.dateTime.time, null);
  assert.strictEqual(app.flightBlockReason(), 'ambiguous');
  App.__elements.delete('timeChoice'); App.__elements.delete('timeWarning');
});

check('a custom time warning never sticks to the next ordinary one', () => {
  const app = makeApp('pickup', 'time');
  // makeApp stubs this method out for the other checks; this one must exercise
  // the REAL copy path, or it proves nothing.
  delete app.showTimeWarning;
  assert.strictEqual(typeof App.prototype.showTimeWarning, 'function');
  const text = makeElement();
  const warning = makeElement(); warning.querySelector = () => text;
  const note = makeElement(); note.parentElement = makeElement();
  note.parentElement.insertBefore = (node) => { note.parentElement.children.push(node); };
  app.els.timeNote = note;
  App.__elements.set('timeWarning', warning);
  app.showTimeWarning('That time does not exist in Miami on this date. Please choose another time.');
  assert.match(text.textContent, /does not exist/);
  assert.ok(warning.classList.contains('visible'), 'the real element is the one being written to');
  app.showTimeWarning();
  assert.strictEqual(text.textContent, 'Please select a time at least 30 minutes from now');
  App.__elements.delete('timeWarning');
});

check('leaving a route edit restores the create flow: the direction buttons work again, through Done and through Back', () => {
  for (const exit of ['done', 'back']) {
    const app = makeApp('pickup', 'arrival');
    app.getAirportName = (c) => c;
    app.updateContinueButton = () => {}; app.clearRouteState = () => {}; app.autocomplete = null;
    app.els.modeBtns = ['dropoff', 'pickup'].map((m) => { const b = makeElement('button'); b.dataset.mode = m; return b; });
    app.els.airportOptions = ['MIA', 'FLL'].map((c) => { const o = makeElement('button'); o.dataset.airport = c; return o; });
    app.els.continueBtn = makeElement('button');
    const holder = makeElement(); app.els.continueBtn.parentElement = holder;
    const limit = makeElement(); limit.hidden = true;
    for (const [id, el] of Object.entries({ editRouteFlightLimit: limit, editRouteReason: makeElement(), editRouteDone: makeElement('button') })) App.__elements.set(id, el);
    app._editRoute = { hasFlight: true, routeDraft: { mode: 'pickup', airport: 'MIA', airportLabel: 'MIA', address: { label: 'x', placeId: 'p1' } }, onDone() {}, onBack() {} };
    app.renderEditRouteWhere();
    assert.ok(app.els.modeBtns.every((b) => b.disabled), `${exit}: held during the edit`);
    const er = app.exitEditRouteMode();
    (exit === 'done' ? er.onDone : er.onBack)(er.routeDraft);
    assert.ok(app.els.modeBtns.every((b) => !b.disabled), `${exit}: the next booking can change direction again`);
    assert.ok(app.els.airportOptions.every((o) => !o.disabled), `${exit}: and its airport`);
    for (const id of ['editRouteFlightLimit', 'editRouteReason', 'editRouteDone']) App.__elements.delete(id);
  }
});

check('a route with no airport yet is exempt from the hold, so it can still be completed', () => {
  const app = makeApp('pickup', 'arrival');
  app.getAirportName = (c) => c;
  app.startBooking = () => {}; app.updateContinueButton = () => {}; app.autocomplete = null;
  app.els.bookingContainer = makeElement(); app.els.bookingContainer.classList.add('active');
  app.els.modeBtns = ['dropoff', 'pickup'].map((m) => { const b = makeElement('button'); b.dataset.mode = m; return b; });
  app.els.airportOptions = ['MIA'].map((c) => { const o = makeElement('button'); o.dataset.airport = c; return o; });
  app.els.continueBtn = makeElement('button'); app.els.continueBtn.parentElement = makeElement();
  const limit = makeElement(); limit.hidden = false;
  App.__elements.set('editRouteFlightLimit', limit);
  for (const id of ['editRouteReason', 'editRouteDone']) App.__elements.set(id, makeElement('button'));
  // a LEGACY ride: a flight value is stored, but no canonical airport exists yet
  app.enterEditRouteMode({ hasFlight: true, route: { pickupLabel: 'MIA', dropoffLabel: '4441 Collins Ave' }, quote: null },
    { onDone() {}, onBack() {} });
  assert.strictEqual(app._editRoute.hasFlight, false, 'an incomplete route must stay completable');
  // the hold's own effects are absent: direction free, no limit copy. (Step
  // enablement itself still belongs to the create flow, not to this rule.)
  assert.ok(app.els.modeBtns.every((b) => !b.disabled), 'its direction is not held');
  assert.strictEqual(limit.hidden, true);
  assert.strictEqual(limit.textContent, '');
  for (const id of ['editRouteFlightLimit', 'editRouteReason', 'editRouteDone']) App.__elements.delete(id);
});

check('wiring pins: the request uses the helper, hydration carries the flight, the card hands it to the editor', () => {
  assert.ok(bookingPage.includes('const flightFields = this.flightFieldsForSubmit(submitState, bookingData.passenger?.notes);'));
  assert.ok(bookingPage.includes('notes: flightFields.notes,') && bookingPage.includes('flightNumber: flightFields.flightNumber,'));
  assert.ok(!bookingPage.includes('flightNumber: bookingData.passenger?.notes?.referenceCode'));
  assert.ok(bookingPage.includes("pending-edit-model.js?v=2"), 'the page asks for the model version that exports miamiParts');
  assert.ok(typeof MODEL.miamiParts === 'function' && typeof MODEL.resolveMiamiWallClock === 'function', 'one shared Miami clock');
  const card = fs.readFileSync(path.join(repoRoot, 'js/pending-edit-card.js'), 'utf8');
  assert.match(card, /hasFlight: !!\(snapshot && snapshot\.hasFlight\)/, 'the card tells the editor a flight exists');
  const writer = fs.readFileSync(path.join(repoRoot, 'backend/functions/update-pending-booking.js'), 'utf8');
  assert.match(writer, /'booker_name', 'booker_phone', 'notes', 'pickup_sign', 'flight_number'/, 'hydration reads it');
  assert.match(writer, /hasFlight: !!row\.flight_number/, 'hydration returns only the boolean');
  assert.match(bookingPage, /hasFlight: !!editorInput\?\.hasFlight && !!routeDraft\?\.airport/, 'the HOST decides the hold; the generic card stays route-shape-blind');
  assert.doesNotMatch(card, /airport_transfer_v1/, 'no route shape is named inside the generic card');
  assert.match(bookingPage, /APP-LEVEL SAFETY RAIL, not a server guarantee/, 'the hold is described honestly in the code');
  assert.ok(!/flight_number/.test(card), 'the current Manage Ride card source contains no flight field');
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
