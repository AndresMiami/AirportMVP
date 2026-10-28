// Terminal confirmation R1 — the confirm sheet on the terminal pick, the
// per-selection lifecycle, the When reminder and the resolution display.
//
// Run: node tests/terminal-confirmation.test.js
//
// Executes the REAL code end to end in a VM-backed fake DOM: the real
// autocomplete.js (its synchronous selection-start boundary), the real
// js/curated-places.js with the committed registry, the real
// js/terminal-sheet.js, and the real AirportBookingApp methods from
// indexMVP.html wired through the page's own initializeAutocomplete. The
// Details lookup is the only stub, and it is CONTROLLABLE: each selection's
// result is released or failed by the test, in any order, so the races the
// plan names run for real (plan v1.6 §3.2, §3.3, §5; Codex 0285 #2 and
// 0286 #2). The resolution record's writer (requestServerQuote) is covered
// in tests/quote-browser-integration.test.js with the real quote funnel.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const bookingPage = read('indexMVP.html');
const inlineBlocks = [...bookingPage.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]).filter((source) => source.trim());
assert.strictEqual(inlineBlocks.length, 2, 'expected the gate block and application block');
const appBlock = inlineBlocks[1];
const autocompleteSource = read('autocomplete.js').replace(/^export class /m, 'class ');
const curatedSource = read('js/curated-places.js');
const sheetSource = read('js/terminal-sheet.js');
const REGISTRY_RAW = JSON.parse(read('data/curated-places.json'));
const TERMINAL = {};
REGISTRY_RAW.terminals.forEach((t) => { TERMINAL[t.id] = t; });
const V = TERMINAL['pom-terminal-v'];
const A = TERMINAL['pom-terminal-a'];
const B = TERMINAL['pom-terminal-b'];
const F = TERMINAL['pom-terminal-f'];
const label = (t) => `${t.name}, ${t.address}`;
const DETAILS_OK = (lat = 25.78, lng = -80.18) => ({
  result: { formatted_address: '718 N Cruise Blvd, Miami, FL 33132, USA', geometry: { location: { lat, lng } } },
  attributions: []
});
const GOOGLE_HOTEL = { place_id: 'ChIJ_fontainebleau_0000', description: 'Fontainebleau Miami Beach, Collins Avenue, Miami Beach, FL, USA' };

// ---------------------------------------------------------------- fake DOM
function makeDocument() {
  const docListeners = new Map();
  const doc = {
    readyState: 'complete',
    activeElement: null,
    elements: new Map(),
    addEventListener(type, fn) { docListeners.set(type, [...(docListeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { docListeners.set(type, (docListeners.get(type) || []).filter((f) => f !== fn)); },
    listenerCount(type) { return (docListeners.get(type) || []).length; },
    fire(type, props = {}) {
      const ev = { type, preventDefault() { ev.defaulted = true; }, ...props };
      for (const fn of docListeners.get(type) || []) fn(ev);
      return ev;
    },
    getElementById: (id) => doc.elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createTextNode: (text) => ({ text: String(text) })
  };
  function makeClassList() {
    const classes = new Set();
    return {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, force) {
        if (force === undefined) { if (classes.has(name)) classes.delete(name); else classes.add(name); return classes.has(name); }
        if (force) classes.add(name); else classes.delete(name);
        return !!force;
      },
      contains(name) { return classes.has(name); },
      list() { return [...classes]; }
    };
  }
  function makeElement(tag = 'div') {
    const listeners = new Map();
    const element = {
      tagName: String(tag).toUpperCase(),
      style: {}, dataset: {}, children: [], attrs: {},
      disabled: false, hidden: false, value: '', textContent: '', innerHTML: '', className: '', id: '',
      parentNode: null, focused: false, blurred: false, selected: false,
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      prepend(child) { this.children.unshift(child); child.parentNode = this; return child; },
      remove() {
        this.removed = true;
        if (this.parentNode) {
          const i = this.parentNode.children.indexOf(this);
          if (i >= 0) this.parentNode.children.splice(i, 1);
        }
      },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
      removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter((l) => l !== listener)); },
      listenerCount(type) { return (listeners.get(type) || []).length; },
      // CustomEvent dispatch (the autocomplete) and synthetic UI events (tests)
      dispatchEvent(event) { this.fire(event.type, event.detail, event); return true; },
      fire(type, detail, props = {}) {
        if (type === 'click' && this.disabled) return null;
        const ev = { type, detail, target: this, currentTarget: this,
          preventDefault() { ev.defaulted = true; }, stopPropagation() { ev.stopped = true; }, ...props };
        for (const listener of listeners.get(type) || []) listener(ev);
        return ev;
      },
      focus() { this.focused = true; doc.activeElement = this; },
      blur() { this.focused = false; this.blurred = true; if (doc.activeElement === this) doc.activeElement = null; },
      select() { this.selected = true; },
      querySelector() { return null; },
      // The dropdown container: the rows the autocomplete rendered into
      // innerHTML are what its keyboard handler counts and highlights.
      querySelectorAll(selector) {
        if (selector !== '.suggestion-item') return [];
        const matches = String(this.innerHTML).match(/class="suggestion-item[^"]*" data-index="(\d+)"/g) || [];
        this.items = matches.map((m) => ({ classList: makeClassList(), dataset: { index: /data-index="(\d+)"/.exec(m)[1] }, addEventListener() {} }));
        return this.items;
      },
      closest() { return null; },
      classList: makeClassList()
    };
    return element;
  }
  doc.createElement = makeElement;
  doc.body = makeElement('body');
  doc.head = makeElement('head');
  return { doc, makeElement };
}

// --------------------------------------------------------------- context
function makeContext() {
  const { doc, makeElement } = makeDocument();
  const timers = [];
  let timerId = 0;
  const location = { origin: 'https://example.test', hostname: 'example.test', search: '', href: 'https://example.test/indexMVP.html', replace() {}, reload() {} };
  const navigator = { userAgent: 'test', standalone: false, onLine: true, serviceWorker: { register: async () => ({}) } };
  const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const registryFetches = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {}, group() {}, groupEnd() {} },
    debug: new Proxy({}, { get: () => () => {} }),
    errorHandler: { handleError(e) { throw e; } },
    document: doc,
    location,
    navigator,
    window: { document: doc, location, navigator, matchMedia: () => ({ matches: false }), addEventListener() {} },
    bootAuthReady: new Promise(() => {}),
    setTimeout: (fn, ms) => { timers.push({ id: ++timerId, fn, ms }); return timerId; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 1,
    clearInterval() {},
    fetch: async (url, options) => {
      registryFetches.push({ url: String(url), options });
      if (String(url).includes('/data/curated-places.json')) return { ok: true, json: async () => REGISTRY_RAW };
      throw new Error('unexpected fetch ' + url);
    },
    alert() {},
    localStorage: storage(),
    sessionStorage: storage(),
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', getRandomValues: (array) => array },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    PassengerModal: { getInstance: () => ({ getPassengerData: () => null }) },
    PickupNoteModal: { getInstance: () => ({ getPickupNotesData: () => null }) },
    PromotionModal: { getInstance: () => ({ getPromoData: () => null }) },
    currentActiveBooking: null,
    currentSession: null,
    getStoredRefCode: () => null,
    URL, URLSearchParams, AbortController, Uint8Array,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, Set, Map,
    parseInt, parseFloat, isNaN
  };
  ctx.window.localStorage = ctx.localStorage;
  ctx.window.sessionStorage = ctx.sessionStorage;
  ctx.window.supabaseClient = { auth: { getSession: async () => ({ data: { session: null } }) } };
  ctx.supabaseClient = ctx.window.supabaseClient;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(curatedSource, ctx, { filename: 'curated-places.js' });
  vm.runInContext(sheetSource, ctx, { filename: 'terminal-sheet.js' });
  assert.ok(ctx.CuratedPlaces && ctx.TerminalSheet, 'both classic scripts installed their globals');
  ctx.window.CuratedPlaces = ctx.CuratedPlaces;
  ctx.window.TerminalSheet = ctx.TerminalSheet;
  vm.runInContext(autocompleteSource + '\n;globalThis.__CustomAutocomplete = CustomAutocomplete;', ctx, { filename: 'autocomplete.js' });
  vm.runInContext(appBlock + '\n;globalThis.__AirportBookingApp = AirportBookingApp;', ctx, { filename: 'indexMVP-app.js' });
  const runTimers = () => { const due = timers.splice(0); due.forEach((t) => t.fn()); };
  return { ctx, doc, makeElement, timers, runTimers, registryFetches };
}

// A standalone REAL autocomplete (section A) with a controllable Details stub.
function makeAutocomplete(context) {
  const { ctx, makeElement } = context;
  const input = makeElement('input');
  const container = makeElement('div');
  const log = [];   // the observable order: dispatches, Details calls, onSelect
  const realDispatch = input.dispatchEvent.bind(input);
  input.dispatchEvent = (event) => { log.push(`event:${event.type}:${event.detail && event.detail.selectionId}`); return realDispatch(event); };
  const instance = new ctx.__CustomAutocomplete(input, container, null);
  instance.onSelect = (sel) => log.push(`onSelect:${sel.place.selectionId}`);
  const details = [];
  instance.fetchWithTimeout = (url) => {
    const call = { url };
    details.push(call);
    log.push(`details:${details.length}`);
    return new Promise((resolve, reject) => {
      call.resolve = (payload) => resolve({ ok: true, json: async () => payload });
      call.fail = () => reject(new Error('details down'));
    });
  };
  const typed = (value) => { input.value = value; instance.handleInput({ target: input }); };
  return { instance, input, container, log, details, typed, ready: () => instance.curatedLoad || Promise.resolve() };
}

// The booking app with the REAL autocomplete installed by the page's own
// initializer (section C).
async function makeApp(context, mode = 'dropoff') {
  const { ctx, doc, makeElement } = context;
  const App = ctx.__AirportBookingApp;
  const app = Object.create(App.prototype);
  const el = (tag = 'div') => makeElement(tag);
  const addressInput = el('input');
  const dropdown = el('div');
  const airportOptions = ['MIA', 'FLL', 'PBI'].map((code) => { const o = el('button'); o.dataset.airport = code; return o; });
  const modeBtns = ['dropoff', 'pickup'].map((m) => { const b = el('button'); b.dataset.mode = m; return b; });
  const progressSteps = ['where', 'when', 'vehicle'].map((s) => { const p = el(); p.dataset.step = s; return p; });
  const basisBtns = ['arrival', 'time'].map((b) => { const x = el('button'); x.dataset.basis = b; return x; });
  app.state = {
    mode,
    locations: { address: null, airport: null, placeId: null, curated: null, selectionId: null, resolution: null },
    terminalFlow: null,
    selectionGeneration: 0,
    route: { distance: null, duration: null, price: null },
    dateTime: { date: new Date('2026-11-15T00:00:00Z'), time: null },
    quote: { status: 'idle', key: null, data: null, error: null, seq: 0 },
    flight: '', flightBasis: 'arrival', flightOffset: 15,
    vehicle: { selected: null, pricing: null },
    passengers: 1, guestData: null, pickupNotes: null, paymentMethod: 'visa-1187', promoCode: null,
    ui: { currentPanel: 'where' }
  };
  app.els = {
    addressInput, autocompleteDropdown: dropdown,
    startSearchBtn: el('button'), bookingContainer: el(), modeBtns, airportOptions,
    continueBtn: el('button'), backBtn: el('button'), summaryBackBtn: el('button'),
    vehicleSelectionBtn: el('button'), vehicleBackBtn: el('button'), bookBtn: el('button'), editRouteBtn: el('button'),
    flightInput: el('input'), addressStep: el(), airportStep: el(), addressTitle: el(), airportTitle: el(),
    airportBadge: el(), flowConnector: el(), flightSection: el(), panelsWrapper: el(), progressLine: el(), progressLine2: el(),
    progressSteps, summaryBar: el(), routeSummaryText: el(), whenBasis: el(), basisBtns, todayBtn: el('button'),
    terminalReminder: el(), terminalReminderRole: el('span'), terminalReminderTerminal: el('span'),
    terminalReminderCompany: el('span'), terminalReminderNote: el(), changeTerminalBtn: el('button')
  };
  app.els.terminalReminder.hidden = true;
  app.pendingEdit = null;
  app._editHydrating = false;
  app._editRoute = null;
  app.routeRequestSeq = 0;
  app.clearRouteState = () => { app.routeRequestSeq += 1; app.state.route = { distance: null, duration: null, price: null }; };
  const invalidations = [];
  app.invalidateQuote = (reason) => invalidations.push(reason);
  app.calculateRoute = () => {};
  app.updateVehiclePrices = () => {};
  app.updateVehicleMap = () => {};
  app.updateMapBadges = () => {};
  app.updateBookButton = () => {};
  app.updateBookAvailability = () => {};
  app.handleBookingClick = () => {};
  app.startBooking = () => {};
  app.quoteFlowActive = () => true;
  app.renderEditRouteWhere = () => {};
  const navigations = [];
  const realNavigate = app.navigateToPanel.bind(app);
  app.navigateToPanel = (panel) => { navigations.push(panel); return realNavigate(panel); };
  app.bindEvents();
  app.updateStepOrder(mode === 'dropoff');

  // The page's own initializer installs the REAL autocomplete and its four
  // listeners (selection-started, place-selected, place-coordinates,
  // validation-cleared).
  app.loadAutocompleteModule = async () => ({ CustomAutocomplete: ctx.__CustomAutocomplete });
  await app.initializeAutocomplete();
  assert.ok(app.autocomplete, 'the real initializer installed the autocomplete');
  await app.autocomplete.curatedLoad;
  assert.ok(app.autocomplete.curatedRegistry, 'the committed registry validated and loaded');

  const events = [];
  const realDispatch = addressInput.dispatchEvent.bind(addressInput);
  addressInput.dispatchEvent = (event) => { events.push({ type: event.type, selectionId: event.detail && event.detail.selectionId }); return realDispatch(event); };
  const details = [];
  app.autocomplete.fetchWithTimeout = (url) => {
    const call = { url, settled: false };
    details.push(call);
    return new Promise((resolve, reject) => {
      call.resolve = (payload = DETAILS_OK()) => { call.settled = true; resolve({ ok: true, json: async () => payload }); };
      call.fail = () => { call.settled = true; reject(new Error('details down')); };
    });
  };
  const typed = (value) => { addressInput.value = value; app.autocomplete.handleInput({ target: addressInput }); };
  // A dropdown pick by row index for the CURRENT text (click or Enter path).
  const pick = (index) => app.autocomplete.selectSuggestion(index);
  const sheet = () => (app._terminalSheet && app._terminalSheet.isOpen() ? app._terminalSheet.elements() : null);
  const row = (terminalId) => { const s = sheet(); return s ? s.rows.get(terminalId) : null; };
  const tapAirport = (code) => airportOptions.find((o) => o.dataset.airport === code).fire('click');
  return { app, addressInput, dropdown, airportOptions, navigations, invalidations, events, details, typed, pick, sheet, row, tapAirport, doc };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

let passed = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }
async function run() {
  console.log('\nTerminal confirmation R1 — sheet, lifecycle, reminder, resolution display\n');
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log('  ✓ ' + name);
    } catch (error) {
      console.log('  ✗ ' + name + '\n      ' + (error.stack || error.message));
      console.log('\nFAILED at: ' + name);
      process.exit(1);
    }
  }
  console.log(`\nALL ${passed} CHECKS PASS`);
  process.exitCode = 0;
}
process.exitCode = 1;

// ======================================================================
// A. The autocomplete's start boundary (real autocomplete.js)
// ======================================================================

check('A1 dropdown click: selection-started is dispatched SYNCHRONOUSLY before the Details request; zero completion events until it resolves; then onSelect → place-selected → place-coordinates with the same selectionId', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  t.typed('Virgin');
  const pending = t.instance.selectSuggestion(0);
  const id = t.instance.selectionSequence;
  assert.deepStrictEqual(t.log, [`event:selection-started:${id}`, 'details:1'], 'the boundary fires before the lookup, and nothing else has happened');
  await flush();
  assert.deepStrictEqual(t.log, [`event:selection-started:${id}`, 'details:1'], 'nothing completes while Details is pending');
  t.details[0].resolve(DETAILS_OK());
  await pending;
  assert.deepStrictEqual(t.log, [
    `event:selection-started:${id}`, 'details:1',
    `onSelect:${id}`, `event:place-selected:${id}`, `event:place-coordinates:${id}`
  ]);
  assert.strictEqual(t.input.value, label(V));
});

check('A2 the boundary detail: selectionId, placeId, source and the registry metadata (companyKey from the row), no Google content', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  const seen = [];
  t.input.addEventListener('selection-started', (e) => seen.push(plain(e.detail)));
  t.typed('Virgin');
  const pending = t.instance.selectSuggestion(0);
  assert.deepStrictEqual(seen, [{ selectionId: t.instance.selectionSequence, placeId: V.placeId, source: 'curated',
    curated: { terminalId: 'pom-terminal-v', companyKey: 'virgin', placeId: V.placeId } }]);
  t.details[0].resolve(DETAILS_OK());
  await pending;
});

check('A3 Enter runs the same path as a click (one boundary, one lookup, same order)', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  t.typed('Virgin');
  t.instance.handleKeydown({ key: 'ArrowDown', preventDefault() {} });
  t.instance.handleKeydown({ key: 'Enter', preventDefault() {} });
  const id = t.instance.selectionSequence;
  assert.deepStrictEqual(t.log, [`event:selection-started:${id}`, 'details:1']);
  t.details[0].resolve(DETAILS_OK());
  await flush(); await flush();
  assert.deepStrictEqual(t.log.slice(2), [`onSelect:${id}`, `event:place-selected:${id}`, `event:place-coordinates:${id}`]);
});

check('A4 selectCuratedTerminal (the sheet row): the same boundary with companyKey null; false without a registry or for an unknown id', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  const seen = [];
  t.input.addEventListener('selection-started', (e) => seen.push(plain(e.detail)));
  assert.strictEqual(t.instance.selectCuratedTerminal('pom-terminal-zzz'), false);
  assert.strictEqual(t.instance.selectCuratedTerminal(42), false);
  assert.deepStrictEqual(seen, [], 'an unknown id selects nothing');
  assert.strictEqual(t.instance.selectCuratedTerminal('pom-terminal-f'), true);
  const id = t.instance.selectionSequence;
  assert.deepStrictEqual(seen, [{ selectionId: id, placeId: F.placeId, source: 'curated',
    curated: { terminalId: 'pom-terminal-f', companyKey: null, placeId: F.placeId } }]);
  assert.deepStrictEqual(t.log, [`event:selection-started:${id}`, 'details:1']);
  t.details[0].resolve(DETAILS_OK());
  await flush(); await flush();
  assert.strictEqual(t.input.value, label(F), 'LinkMia\'s label for the terminal row');
  const registry = t.instance.curatedRegistry;
  t.instance.curatedRegistry = null;
  assert.strictEqual(t.instance.selectCuratedTerminal('pom-terminal-f'), false, 'no registry, no selection');
  t.instance.curatedRegistry = registry;
});

check('A5 the session-token/Details request is unchanged: place_id + sessiontoken, one request count, session cleared after the selection applies', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  t.typed('Virgin');
  const countBefore = t.instance.sessionRequestCount;
  const pending = t.instance.selectSuggestion(0);
  assert.strictEqual(t.details[0].url, `https://reliable-warmth-production-d382.up.railway.app/api/places/details?place_id=${V.placeId}&sessiontoken=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`);
  assert.strictEqual(t.instance.sessionRequestCount, countBefore + 1);
  t.details[0].resolve(DETAILS_OK());
  await pending;
  assert.strictEqual(t.instance.sessionToken, null, 'clearSession still runs after applySelection');
});

check('A6 A → B → C in quick succession: only C\'s completion events reach the host, whatever order the lookups settle in', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  const pA = (t.typed('Virgin'), t.instance.selectSuggestion(0));
  const idA = t.instance.selectionSequence;
  t.instance.selectCuratedTerminal('pom-terminal-a');
  const idB = t.instance.selectionSequence;
  t.instance.selectCuratedTerminal('pom-terminal-b');
  const idC = t.instance.selectionSequence;
  assert.deepStrictEqual(t.log, [`event:selection-started:${idA}`, 'details:1', `event:selection-started:${idB}`, 'details:2', `event:selection-started:${idC}`, 'details:3']);
  t.details[1].resolve(DETAILS_OK());   // B first
  t.details[2].resolve(DETAILS_OK());   // then C
  t.details[0].fail();                  // A fails last
  await pA; await flush(); await flush();
  const completions = t.log.filter((entry) => !entry.startsWith('event:selection-started') && !entry.startsWith('details:'));
  assert.deepStrictEqual(completions, [`onSelect:${idC}`, `event:place-selected:${idC}`, `event:place-coordinates:${idC}`]);
  assert.strictEqual(t.input.value, label(B));
});

check('A7 a Google row announces source google with curated null, on the boundary and on both completion paths', async () => {
  for (const outcome of ['success', 'failure']) {
    const t = makeAutocomplete(makeContext());
    await t.ready();
    const seen = [];
    t.input.addEventListener('selection-started', (e) => seen.push(plain(e.detail)));
    t.input.addEventListener('place-selected', (e) => seen.push(plain(e.detail)));
    t.typed('Fontainebleau');
    t.instance.predictions = [GOOGLE_HOTEL];
    const pending = t.instance.selectSuggestion(0);
    const id = t.instance.selectionSequence;
    if (outcome === 'success') t.details[0].resolve({ result: { formatted_address: 'Fontainebleau, Miami Beach, FL', geometry: { location: { lat: 25.81, lng: -80.12 } } }, attributions: [] });
    else t.details[0].fail();
    await pending;
    assert.deepStrictEqual(seen[0], { selectionId: id, placeId: GOOGLE_HOTEL.place_id, source: 'google', curated: null });
    assert.strictEqual(seen[1].curated, null, `${outcome}: the completion says curated null explicitly`);
    assert.strictEqual(seen[1].selectionId, id);
  }
});

check('A8 a Details failure on a terminal row completes through the fallback with the SAME selectionId and metadata', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  const seen = [];
  t.input.addEventListener('place-coordinates', (e) => seen.push(plain(e.detail)));
  t.typed('Virgin');
  const pending = t.instance.selectSuggestion(0);
  const id = t.instance.selectionSequence;
  t.details[0].fail();
  await pending;
  assert.deepStrictEqual(seen, [{ lat: null, lng: null, address: label(V), selectionId: id }]);
  assert.strictEqual(t.input.value, label(V));
});

// ======================================================================
// B. The sheet component (real js/terminal-sheet.js)
// ======================================================================

function sheetFixture(context, { side = 'pickup', selectedPlaceId = V.placeId, settlingPlaceId = null, superseded = false, now } = {}) {
  const { ctx, doc, makeElement } = context;
  const registry = ctx.CuratedPlaces.validateRegistry(REGISTRY_RAW).registry;
  const calls = [];
  const host = {
    onRowTap: (id) => calls.push(['row', id]),
    onConfirm: () => calls.push(['confirm']),
    onSkip: () => calls.push(['skip']),
    onDismiss: () => calls.push(['dismiss']),
    onMapType: (type) => calls.push(['maptype', type])
  };
  const sheet = ctx.TerminalSheet.create({ document: doc, host, now });
  const inert = makeElement('div');
  const view = { side, registry, selectedPlaceId, settlingPlaceId, superseded };
  return { sheet, calls, inert, view, registry, doc };
}

check('B1 open renders the title by side, the port, every verified terminal in registry order with its cruise lines, and marks the selected row', async () => {
  const context = makeContext();
  const f = sheetFixture(context, { side: 'pickup' });
  f.sheet.open(f.view, { inert: f.inert });
  const e = f.sheet.elements();
  assert.strictEqual(e.title.textContent, 'Confirm pickup terminal');
  assert.strictEqual(e.panel.getAttribute('role'), 'dialog');
  assert.strictEqual(e.panel.getAttribute('aria-modal'), 'true');
  assert.strictEqual(e.panel.getAttribute('aria-labelledby'), 'terminalSheetTitle');
  assert.strictEqual(e.title.id, 'terminalSheetTitle');
  assert.deepStrictEqual([...e.rows.keys()], REGISTRY_RAW.terminals.filter((t) => t.verifiedAt).map((t) => t.id));
  assert.strictEqual(e.rows.get('pom-terminal-f').button.children[1].textContent, 'Carnival Cruise Line · Disney Cruise Line');
  assert.strictEqual(e.rows.get('pom-terminal-v').button.children[0].textContent, 'Terminal V');
  assert.strictEqual(e.rows.get('pom-terminal-v').button.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(e.rows.get('pom-terminal-v').mark.textContent, 'Selected');
  assert.strictEqual(e.rows.get('pom-terminal-a').button.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(e.rows.get('pom-terminal-a').mark.textContent, '');
  assert.strictEqual(e.note.textContent, 'Check this is the terminal your ship docks at.');
  assert.strictEqual(e.confirm.disabled, false);
  assert.strictEqual(e.skip.disabled, false);
  assert.strictEqual(e.confirm.textContent, 'Confirm pickup', 'the button pairs with the title (Uber reference)');
  assert.ok(e.header.children.includes(e.skip), 'Skip is a pill in the header, top right');
  assert.deepStrictEqual(e.header.children.map((c) => c.className.split(' ')[0]), ['terminal-sheet-close', 'terminal-sheet-title', 'terminal-sheet-skip']);
  assert.strictEqual(e.mapArea.hidden, true, 'no map status in the view: the map area is off');
  assert.strictEqual(f.doc.body.children.includes(e.overlay), true);
  f.sheet.render({ ...f.view, side: 'dropoff' });
  assert.strictEqual(e.title.textContent, 'Confirm drop-off terminal');
  assert.strictEqual(e.confirm.textContent, 'Confirm drop-off');
  assert.strictEqual(e.note.textContent, 'Check this matches your latest cruise instructions.');
});

check('B1b the map area follows the view: loading shows the note, ready shows the canvas and the layer switch, unavailable says so, and the switch reports the layer', async () => {
  const f = sheetFixture(makeContext());
  f.sheet.open({ ...f.view, map: { status: 'loading', type: 'roadmap' } });
  const e = f.sheet.elements();
  assert.strictEqual(e.mapArea.hidden, false);
  assert.strictEqual(e.mapArea.getAttribute('data-map-status'), 'loading');
  assert.strictEqual(e.mapNote.hidden, false);
  assert.strictEqual(e.mapNote.textContent, 'Loading map…');
  assert.strictEqual(e.mapTypes.hidden, true, 'no layer switch before the map exists');
  f.sheet.render({ ...f.view, map: { status: 'ready', type: 'roadmap' } });
  assert.strictEqual(e.mapNote.hidden, true);
  assert.strictEqual(e.mapTypes.hidden, false);
  assert.strictEqual(e.mapTypeButtons.roadmap.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(e.mapTypeButtons.satellite.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(e.mapTypeButtons.roadmap.textContent, 'Standard');
  assert.strictEqual(e.mapTypeButtons.satellite.textContent, 'Satellite');
  e.mapTypeButtons.satellite.fire('click');
  assert.deepStrictEqual(f.calls, [['maptype', 'satellite']], 'the host decides; the sheet only reports');
  f.sheet.render({ ...f.view, map: { status: 'ready', type: 'satellite' } });
  assert.strictEqual(e.mapTypeButtons.satellite.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(e.mapTypeButtons.roadmap.getAttribute('aria-pressed'), 'false');
  f.sheet.render({ ...f.view, map: { status: 'unavailable', type: 'satellite' } });
  assert.strictEqual(e.mapNote.textContent, 'Map unavailable right now — the list still works.');
  assert.strictEqual(e.mapTypes.hidden, true);
  assert.strictEqual(e.confirm.disabled, false, 'the list and Confirm never depend on the map');
  assert.strictEqual(e.mapHost.getAttribute('aria-hidden'), 'true', 'the canvas is decorative for assistive tech');
});

check('B2 settling: the checking row says Checking…, Confirm and Skip are disabled; a settled render enables them and marks the new row', async () => {
  const f = sheetFixture(makeContext(), { selectedPlaceId: V.placeId, settlingPlaceId: A.placeId });
  f.sheet.open(f.view);
  const e = f.sheet.elements();
  assert.strictEqual(e.rows.get('pom-terminal-a').mark.textContent, 'Checking…');
  assert.strictEqual(e.rows.get('pom-terminal-v').mark.textContent, 'Selected', 'the committed terminal stays marked while another is checking');
  assert.strictEqual(e.confirm.disabled, true);
  assert.strictEqual(e.skip.disabled, true);
  e.confirm.fire('click'); e.skip.fire('click');
  assert.deepStrictEqual(f.calls, [], 'disabled buttons report nothing');
  f.sheet.render({ ...f.view, selectedPlaceId: A.placeId, settlingPlaceId: null });
  assert.strictEqual(e.rows.get('pom-terminal-a').mark.textContent, 'Selected');
  assert.strictEqual(e.rows.get('pom-terminal-v').mark.textContent, '');
  assert.strictEqual(e.confirm.disabled, false);
  assert.strictEqual(e.skip.disabled, false);
  e.confirm.fire('click'); e.skip.fire('click');
  assert.deepStrictEqual(f.calls, [['confirm'], ['skip']]);
});

check('B3 superseded: no row marked, the Google-resolved copy line, Confirm disabled, Skip still usable', async () => {
  const f = sheetFixture(makeContext(), { selectedPlaceId: V.placeId, superseded: true });
  f.sheet.open(f.view);
  const e = f.sheet.elements();
  assert.ok([...e.rows.values()].every((row) => row.button.getAttribute('aria-pressed') === 'false' && row.mark.textContent === ''));
  assert.strictEqual(e.note.textContent, 'Google resolved this address to a different place. Pick a terminal, or close to keep the address.');
  assert.strictEqual(e.confirm.disabled, true);
  assert.strictEqual(e.skip.disabled, false);
});

check('B4 dismissal paths — ✕, backdrop, Escape — each report one dismissal; a tap inside the panel and a row tap do not', async () => {
  const f = sheetFixture(makeContext());
  f.sheet.open(f.view);
  const e = f.sheet.elements();
  e.close.fire('click');
  e.overlay.fire('click');
  e.panel.fire('click');
  f.doc.fire('keydown', { key: 'Escape' });
  e.rows.get('pom-terminal-b').button.fire('click');
  assert.deepStrictEqual(f.calls, [['dismiss'], ['dismiss'], ['dismiss'], ['row', 'pom-terminal-b']]);
});

check('B5 focus: enters the marked row, Tab/Shift+Tab cycle inside the enabled controls, the page behind is inert while open and restored on close, the Escape listener is removed', async () => {
  const f = sheetFixture(makeContext(), { selectedPlaceId: B.placeId });
  f.sheet.open(f.view, { inert: f.inert });
  const e = f.sheet.elements();
  assert.strictEqual(f.doc.activeElement, e.rows.get('pom-terminal-b').button, 'focus enters the marked row');
  assert.strictEqual(f.inert.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(f.inert.inert, true);
  // the ring: ✕, Skip, (the layer switch once the map is ready), the rows, Confirm
  const ring = [e.close, e.skip, ...[...e.rows.values()].map((r) => r.button), e.confirm];
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, ring[ring.indexOf(e.rows.get('pom-terminal-b').button) + 1]);
  f.doc.activeElement = e.confirm;
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.close, 'Tab from the last control wraps to the first');
  f.doc.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.strictEqual(f.doc.activeElement, e.confirm, 'Shift+Tab from the first wraps to the last');
  f.doc.activeElement = e.close;
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.skip, 'Skip follows the close control in the header');
  f.sheet.render({ ...f.view, map: { status: 'ready', type: 'roadmap' } });
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.mapTypeButtons.roadmap, 'the layer switch joins the ring once the map is ready');
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.mapTypeButtons.satellite);
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.rows.get('pom-terminal-v').button, 'then the first row');
  f.sheet.render({ ...f.view, settlingPlaceId: A.placeId });   // Confirm/Skip disabled: they leave the ring; map off again
  f.doc.activeElement = e.rows.get('pom-terminal-aa').button;
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.close, 'disabled Confirm/Skip are skipped');
  assert.strictEqual(f.doc.listenerCount('keydown'), 1);
  f.sheet.close();
  assert.strictEqual(f.sheet.isOpen(), false);
  assert.strictEqual(f.inert.getAttribute('aria-hidden'), null);
  assert.strictEqual(f.inert.inert, false);
  assert.strictEqual(f.doc.listenerCount('keydown'), 0);
  assert.ok(e.overlay.classList.contains('closing') && !e.overlay.classList.contains('active'));
});

check('B6 drag-to-dismiss: the pure rule, then real pointer events on the title row and the grip (past 80 px or a fast flick closes; a short slow drag snaps back)', async () => {
  const context = makeContext();
  const { dragOutcome } = context.ctx.TerminalSheet;
  assert.strictEqual(dragOutcome(0, 1), 'snap');
  assert.strictEqual(dragOutcome(-20, 5), 'snap');
  assert.strictEqual(dragOutcome(79, 0.1), 'snap');
  assert.strictEqual(dragOutcome(80, 0), 'close');
  assert.strictEqual(dragOutcome(30, 0.59), 'snap');
  assert.strictEqual(dragOutcome(30, 0.6), 'close');
  assert.strictEqual(dragOutcome(10, 5), 'snap', 'a flick that barely moved is not a dismissal');
  let clock = 1000;
  const f = sheetFixture(context, { now: () => clock });
  f.sheet.open(f.view);
  const e = f.sheet.elements();
  // slow 30 px on the header: snaps back
  e.header.fire('pointerdown', undefined, { clientY: 100, pointerId: 1 });
  clock += 500;
  e.header.fire('pointermove', undefined, { clientY: 130 });
  assert.strictEqual(e.panel.style.transform, 'translateY(30px)');
  assert.ok(e.panel.classList.contains('dragging'));
  e.header.fire('pointerup', undefined, {});
  assert.deepStrictEqual(f.calls, []);
  assert.strictEqual(e.panel.style.transform, '');
  assert.ok(!e.panel.classList.contains('dragging'));
  // 100 px on the grip: closes
  e.grip.fire('pointerdown', undefined, { clientY: 100, pointerId: 2 });
  clock += 400;
  e.grip.fire('pointermove', undefined, { clientY: 200 });
  e.grip.fire('pointerup', undefined, {});
  assert.deepStrictEqual(f.calls, [['dismiss']]);
  // fast 40 px flick on the header: closes
  e.header.fire('pointerdown', undefined, { clientY: 100, pointerId: 3 });
  clock += 40;
  e.header.fire('pointermove', undefined, { clientY: 140 });
  e.header.fire('pointerup', undefined, {});
  assert.deepStrictEqual(f.calls, [['dismiss'], ['dismiss']]);
  // upward movement is not a drag down
  e.header.fire('pointerdown', undefined, { clientY: 100, pointerId: 4 });
  e.header.fire('pointermove', undefined, { clientY: 20 });
  e.header.fire('pointercancel', undefined, {});
  assert.deepStrictEqual(f.calls, [['dismiss'], ['dismiss']]);
  // a pointerdown on the ✕ or on Skip is a tap, never a drag
  for (const control of [e.close, e.skip]) {
    e.header.fire('pointerdown', undefined, { clientY: 100, pointerId: 5, target: control });
    e.header.fire('pointermove', undefined, { clientY: 300 });
    e.header.fire('pointerup', undefined, {});
  }
  assert.deepStrictEqual(f.calls, [['dismiss'], ['dismiss']]);
  // the map area is never a drag handle
  assert.strictEqual(e.mapArea.listenerCount('pointerdown'), 0);
});

check('B7 close then open: the closing overlay is removed when a fresh one opens; open while open re-renders instead of stacking', async () => {
  const f = sheetFixture(makeContext());
  f.sheet.open(f.view);
  const first = f.sheet.elements().overlay;
  f.sheet.open({ ...f.view, selectedPlaceId: A.placeId });
  assert.strictEqual(f.sheet.elements().overlay, first, 'no second overlay');
  assert.strictEqual(f.sheet.elements().rows.get('pom-terminal-a').mark.textContent, 'Selected');
  f.sheet.close();
  assert.ok(f.doc.body.children.includes(first), 'the closing overlay stays for its fade');
  f.sheet.open(f.view);
  assert.ok(!f.doc.body.children.includes(first), 'a new open removes the fading one');
  assert.strictEqual(f.doc.body.children.filter((c) => c.className === 'terminal-sheet-overlay').length, 1);
});

// ======================================================================
// C. The host lifecycle (real app + real autocomplete + real sheet)
// ======================================================================

check('C1 Going to Airport: the tap opens the sheet synchronously (before Details) with Confirm/Skip disabled; the result settles it; Confirm stays on Where for the airport; the airport tap advances once; When shows the reminder', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const pending = h.pick(0);
  const id = h.app.autocomplete.selectionSequence;
  // synchronous: the sheet is open before any await
  assert.ok(h.sheet(), 'the sheet opened on the tap itself');
  assert.deepStrictEqual(h.events.map((e) => e.type), ['selection-started']);
  assert.deepStrictEqual(plain(h.app.state.terminalFlow), { generation: 1, selectionId: id, placeId: V.placeId, stage: 'settling' });
  assert.strictEqual(h.sheet().confirm.disabled, true);
  assert.strictEqual(h.sheet().skip.disabled, true);
  assert.strictEqual(h.row('pom-terminal-v').mark.textContent, 'Checking…');
  assert.strictEqual(h.sheet().title.textContent, 'Confirm pickup terminal');
  assert.strictEqual(h.app.els.bookingContainer.getAttribute('aria-hidden'), 'true', 'the booking card behind is inert');
  assert.strictEqual(h.app.continueAfterSheet(), false, 'Confirm/Skip refused while settling');
  assert.deepStrictEqual(h.navigations, []);
  h.details[0].resolve();
  await pending;
  assert.deepStrictEqual(h.events.map((e) => e.type), ['selection-started', 'place-selected', 'place-coordinates']);
  assert.strictEqual(h.app.state.terminalFlow.stage, 'open');
  assert.strictEqual(h.sheet().confirm.disabled, false);
  assert.strictEqual(h.sheet().skip.disabled, false);
  assert.strictEqual(h.row('pom-terminal-v').mark.textContent, 'Selected');
  assert.strictEqual(h.addressInput.value, label(V));
  assert.strictEqual(h.app.state.locations.placeId, V.placeId);
  assert.deepStrictEqual(plain(h.app.state.locations.curated), { terminalId: 'pom-terminal-v', companyKey: 'virgin' });
  assert.strictEqual(h.app.state.locations.selectionId, id);
  assert.deepStrictEqual(h.navigations, [], 'a terminal pick never auto-advances');
  h.sheet().confirm.fire('click');
  assert.strictEqual(h.sheet(), null, 'Confirm closes the sheet');
  assert.strictEqual(h.app.state.terminalFlow.stage, 'continued');
  assert.deepStrictEqual(h.navigations, [], 'Going to Airport before the airport is chosen stays on Where');
  assert.strictEqual(h.app.els.bookingContainer.getAttribute('aria-hidden'), null);
  assert.strictEqual(h.airportOptions[0].focused, true, 'focus moves to the airport grid');
  h.tapAirport('MIA');
  assert.deepStrictEqual(h.navigations, ['when'], 'the airport tap advances exactly as today');
  assert.strictEqual(h.app.els.terminalReminder.hidden, false);
  assert.strictEqual(h.app.els.terminalReminderRole.textContent, 'Pickup');
  assert.strictEqual(h.app.els.terminalReminderTerminal.textContent, 'PortMiami Terminal V');
  assert.strictEqual(h.app.els.terminalReminderCompany.textContent, 'Virgin Voyages');
  assert.strictEqual(h.app.els.terminalReminderNote.textContent, 'Check this is the terminal your ship docks at.');
  assert.strictEqual(h.app.els.routeSummaryText.textContent, 'PortMiami Terminal V → MIA');
});

check('C2 Arriving at Airport: the terminal completes the route but the advance is DEFERRED to Confirm/Skip — Skip goes to When exactly once; a second Skip or Confirm is refused; the reminder says Drop-off', async () => {
  const h = await makeApp(makeContext(), 'pickup');
  h.tapAirport('MIA');
  assert.deepStrictEqual(h.navigations, []);
  h.typed('Virgin');
  const pending = h.pick(0);
  assert.strictEqual(h.sheet().title.textContent, 'Confirm drop-off terminal');
  h.details[0].resolve();
  await pending;
  assert.deepStrictEqual(h.navigations, [], 'the completion did NOT take today\'s auto-advance');
  assert.ok(h.app.canContinue(), 'the route is complete');
  h.sheet().skip.fire('click');
  assert.deepStrictEqual(h.navigations, ['when']);
  assert.strictEqual(h.app.state.ui.currentPanel, 'when');
  assert.strictEqual(h.app.els.basisBtns[0].focused, true, 'focus enters When\'s first control');
  assert.strictEqual(h.app.continueAfterSheet(), false, 'continue runs at most once per record');
  assert.deepStrictEqual(h.navigations, ['when']);
  assert.strictEqual(h.app.els.terminalReminderRole.textContent, 'Drop-off');
  assert.strictEqual(h.app.els.terminalReminderNote.textContent, 'Check this matches your latest cruise instructions.');
});

check('C3 a Details failure settles the SAME record through the fallback (label kept, coordinates null, buttons enabled)', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const pending = h.pick(0);
  h.details[0].fail();
  await pending;
  assert.strictEqual(h.app.state.terminalFlow.stage, 'open');
  assert.strictEqual(h.sheet().confirm.disabled, false);
  assert.strictEqual(h.addressInput.value, label(V));
  assert.deepStrictEqual(plain(h.app.state.locations.address.coordinates), { lat: null, lng: null });
  assert.strictEqual(h.app.state.locations.placeId, V.placeId);
});

check('C4 re-selection inside the sheet, A → B → C: each tap re-records synchronously with Checking…; only C settles; A\'s and B\'s late results never reach the host', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const pA = h.pick(0);
  h.details[0].resolve();
  await pA;
  assert.strictEqual(h.app.state.terminalFlow.stage, 'open');
  h.row('pom-terminal-a').button.fire('click');   // B = Terminal A
  assert.deepStrictEqual(plain(h.app.state.terminalFlow), { generation: 2, selectionId: h.app.autocomplete.selectionSequence, placeId: A.placeId, stage: 'settling' });
  assert.strictEqual(h.row('pom-terminal-a').mark.textContent, 'Checking…');
  assert.strictEqual(h.row('pom-terminal-v').mark.textContent, 'Selected', 'the committed terminal stays marked');
  assert.strictEqual(h.sheet().confirm.disabled, true);
  h.row('pom-terminal-b').button.fire('click');   // C = Terminal B
  const idC = h.app.autocomplete.selectionSequence;
  assert.strictEqual(h.app.state.terminalFlow.generation, 3);
  assert.strictEqual(h.row('pom-terminal-b').mark.textContent, 'Checking…');
  assert.strictEqual(h.row('pom-terminal-a').mark.textContent, '');
  const eventsBefore = h.events.length;
  h.details[1].resolve();   // B late
  await flush(); await flush();
  assert.strictEqual(h.events.length, eventsBefore, 'B\'s result produced no completion events');
  assert.strictEqual(h.app.state.terminalFlow.stage, 'settling');
  h.details[2].resolve();   // C
  await flush(); await flush();
  assert.deepStrictEqual(h.events.slice(eventsBefore).map((e) => `${e.type}:${e.selectionId}`), [`place-selected:${idC}`, `place-coordinates:${idC}`]);
  assert.strictEqual(h.app.state.terminalFlow.stage, 'open');
  assert.strictEqual(h.row('pom-terminal-b').mark.textContent, 'Selected');
  assert.strictEqual(h.addressInput.value, label(B));
  assert.strictEqual(h.sheet().confirm.disabled, false);
  assert.deepStrictEqual(h.navigations, []);
  h.row('pom-terminal-b').button.fire('click');
  assert.strictEqual(h.details.length, 3, 'tapping the already-marked row makes no new lookup');
});

check('C5 B pending → Confirm and Skip are refused (disabled in the sheet, the host method returns false, no navigation)', async () => {
  const h = await makeApp(makeContext(), 'pickup');
  h.tapAirport('MIA');
  h.typed('Virgin');
  const pA = h.pick(0);
  h.details[0].resolve();
  await pA;
  h.row('pom-terminal-a').button.fire('click');
  assert.strictEqual(h.sheet().confirm.disabled, true);
  assert.strictEqual(h.sheet().skip.disabled, true);
  h.sheet().confirm.fire('click'); h.sheet().skip.fire('click');
  assert.strictEqual(h.app.continueAfterSheet(), false);
  assert.deepStrictEqual(h.navigations, []);
  assert.strictEqual(h.app.state.terminalFlow.stage, 'settling');
});

check('C6 B pending → close → late success OR fallback: the sheet stays closed, nothing advances, the box and state become B (the autocomplete applies its selection)', async () => {
  for (const outcome of ['success', 'failure']) {
    const h = await makeApp(makeContext(), 'pickup');
    h.tapAirport('MIA');
    h.typed('Virgin');
    const pA = h.pick(0);
    h.details[0].resolve();
    await pA;
    h.row('pom-terminal-a').button.fire('click');
    const idB = h.app.autocomplete.selectionSequence;
    h.doc.fire('keydown', { key: 'Escape' });
    assert.strictEqual(h.sheet(), null);
    assert.strictEqual(h.app.state.terminalFlow.stage, 'closed');
    assert.strictEqual(h.addressInput.focused, true, 'the address box is focused…');
    assert.strictEqual(h.addressInput.selected, true, '…with its text selected');
    if (outcome === 'success') h.details[1].resolve(); else h.details[1].fail();
    await flush(); await flush();
    assert.strictEqual(h.sheet(), null, `${outcome}: no reopen`);
    assert.deepStrictEqual(h.navigations, [], `${outcome}: no advance`);
    assert.strictEqual(h.app.state.locations.placeId, A.placeId, `${outcome}: state became B`);
    assert.strictEqual(h.app.state.locations.selectionId, idB);
    assert.strictEqual(h.addressInput.value, label(A), `${outcome}: the box shows B`);
    assert.strictEqual(h.app.state.terminalFlow.stage, 'closed', 'the record is kept, not re-allocated');
    assert.ok(h.app.canContinue(), 'Continue remains the passenger\'s manual path');
  }
});

check('C7 close → type a hotel → Google row: the old terminal result is rejected and the Google completion takes today\'s auto-advance', async () => {
  const h = await makeApp(makeContext(), 'pickup');
  h.tapAirport('MIA');
  h.typed('Virgin');
  const pA = h.pick(0);   // A pending
  h.doc.fire('keydown', { key: 'Escape' });
  assert.strictEqual(h.app.state.terminalFlow.stage, 'closed');
  h.typed('Fontainebleau');   // the autocomplete's own sequence bump drops A
  h.app.autocomplete.predictions = [GOOGLE_HOTEL];
  const pG = h.pick(0);
  assert.strictEqual(h.app.state.terminalFlow, null, 'a Google row clears the terminal intent');
  assert.strictEqual(h.sheet(), null);
  h.details[0].resolve();   // A's late result
  await pA;
  assert.strictEqual(h.app.state.locations.placeId, null, 'A\'s result was rejected by the guard');
  h.details[1].resolve({ result: { formatted_address: 'Fontainebleau, Miami Beach, FL', geometry: { location: { lat: 25.81, lng: -80.12 } } }, attributions: [] });
  await pG;
  assert.strictEqual(h.app.state.locations.placeId, GOOGLE_HOTEL.place_id);
  assert.strictEqual(h.app.state.locations.curated, null);
  assert.deepStrictEqual(h.navigations, ['when'], 'a hotel address continues without the sheet');
  assert.strictEqual(h.app.els.terminalReminder.hidden, true, 'no reminder for a Google address');
});

check('C8 continue runs once: a duplicate or late completion after Confirm changes nothing', async () => {
  const h = await makeApp(makeContext(), 'pickup');
  h.tapAirport('MIA');
  h.typed('Virgin');
  const p = h.pick(0);
  const id = h.app.autocomplete.selectionSequence;
  h.details[0].resolve();
  await p;
  h.sheet().confirm.fire('click');
  assert.deepStrictEqual(h.navigations, ['when']);
  h.app.onAddressCoordinates({ address: label(V), lat: 25.78, lng: -80.18, selectionId: id });   // duplicate
  assert.deepStrictEqual(h.navigations, ['when'], 'no second advance');
  assert.strictEqual(h.sheet(), null, 'no reopen');
  assert.strictEqual(h.app.state.terminalFlow.stage, 'continued');
});

check('C9 Codex 0286 #2 regression — A → B pending → close → airport → When → Change terminal → Confirm A → B resolves OR rejects: A stays selected, no reopen, no advance, no mutation, evidence preserved', async () => {
  for (const outcome of ['success', 'failure']) {
    const h = await makeApp(makeContext(), 'dropoff');
    h.typed('Virgin');
    const pA = h.pick(0);
    const idA = h.app.autocomplete.selectionSequence;
    h.details[0].resolve();
    await pA;
    h.row('pom-terminal-a').button.fire('click');   // B pending
    h.doc.fire('keydown', { key: 'Escape' });        // close
    h.tapAirport('MIA');                              // airport → When (today's advance)
    assert.deepStrictEqual(h.navigations, ['when']);
    assert.strictEqual(h.app.state.locations.placeId, V.placeId, 'A is the committed terminal');
    const evidence = { placeId: V.placeId, selectionId: idA, canonicalPlaceId: V.placeId };
    h.app.state.locations.resolution = { ...evidence };
    h.app.renderTerminalReminder();
    assert.strictEqual(h.app.els.terminalReminder.hidden, false);
    const eventsBefore = h.events.length;
    const sequenceBefore = h.app.autocomplete.selectionSequence;
    h.app.els.changeTerminalBtn.fire('click');       // Change terminal
    assert.ok(h.app.autocomplete.selectionSequence > sequenceBefore, 'the older in-flight selection was invalidated first');
    assert.deepStrictEqual(h.navigations, ['when', 'where']);
    assert.ok(h.sheet(), 'the sheet opened on the committed terminal');
    assert.strictEqual(h.row('pom-terminal-v').mark.textContent, 'Selected');
    assert.strictEqual(h.row('pom-terminal-a').mark.textContent, '', 'B is not checking any more');
    assert.strictEqual(h.sheet().confirm.disabled, false);
    assert.deepStrictEqual(plain(h.app.state.terminalFlow), { generation: 3, selectionId: null, placeId: V.placeId, stage: 'open' });
    assert.strictEqual(h.details.length, 2, 'no new Details call merely to reopen');
    assert.strictEqual(h.addressInput.value, label(V), 'the label is preserved');
    assert.strictEqual(h.app.autocomplete.isValidated, true, 'validation is preserved');
    assert.deepStrictEqual(plain(h.app.state.locations.resolution), evidence, 'resolution evidence is preserved');
    h.sheet().confirm.fire('click');                  // Confirm A
    assert.deepStrictEqual(h.navigations, ['when', 'where', 'when']);
    assert.strictEqual(h.sheet(), null);
    if (outcome === 'success') h.details[1].resolve(); else h.details[1].fail();
    await flush(); await flush();
    assert.strictEqual(h.events.length, eventsBefore, `${outcome}: B produced no completion events`);
    assert.strictEqual(h.app.state.locations.placeId, V.placeId, `${outcome}: A stays selected`);
    assert.strictEqual(h.app.state.locations.selectionId, idA);
    assert.strictEqual(h.addressInput.value, label(V));
    assert.strictEqual(h.app.autocomplete.selectedPlace.place_id, V.placeId);
    assert.strictEqual(h.sheet(), null, `${outcome}: no late reopen`);
    assert.deepStrictEqual(h.navigations, ['when', 'where', 'when'], `${outcome}: no further advance`);
    assert.deepStrictEqual(plain(h.app.state.locations.resolution), evidence);
    assert.strictEqual(h.app.state.ui.currentPanel, 'when');
    assert.strictEqual(h.app.els.terminalReminder.hidden, false);
  }
});

check('C10 restore and hydration are inert: the state handlers called directly never open the sheet or advance; the reminder still renders from state', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.app.handleAddressSelected({ placeId: V.placeId, description: label(V) });   // what restoration does
  h.app.handleAddressCoordinates({ address: label(V), lat: 25.78, lng: -80.18 });
  h.app.selectAirport('MIA');
  assert.strictEqual(h.sheet(), null);
  assert.strictEqual(h.app.state.terminalFlow, null);
  assert.deepStrictEqual(h.navigations, []);
  assert.strictEqual(h.app.state.locations.selectionId, null);
  assert.strictEqual(h.app.state.locations.resolution, null);
  h.app.navigateToPanel('when');
  assert.strictEqual(h.app.els.terminalReminder.hidden, false, 'a restored verified terminal still gets its reminder');
  assert.strictEqual(h.app.els.terminalReminderCompany.textContent, 'Virgin Voyages', 'no metadata: the terminal\'s own companies');
});

check('C11 focus, blur, Back, re-render and the summary bar never open, close or advance', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  h.details[0].resolve();
  await p;
  h.sheet().confirm.fire('click');
  h.tapAirport('MIA');
  assert.deepStrictEqual(h.navigations, ['when']);
  h.addressInput.fire('focus'); h.addressInput.fire('blur');
  h.app.navigateToPanel('where');
  h.app.navigateToPanel('when');
  h.app.updateSummary();
  h.app.renderTerminalReminder();
  assert.strictEqual(h.sheet(), null);
  assert.deepStrictEqual(h.navigations, ['when', 'where', 'when']);
  assert.strictEqual(h.app.state.terminalFlow.stage, 'continued');
});

check('C12 metadata that fails validation (placeId mismatch, or not a verified terminal) opens nothing and is not kept', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.addressInput.fire('selection-started', { selectionId: 9, placeId: V.placeId, source: 'curated', curated: { terminalId: 'pom-terminal-v', companyKey: 'virgin', placeId: A.placeId } });
  assert.strictEqual(h.app.state.terminalFlow, null);
  assert.strictEqual(h.sheet(), null);
  h.addressInput.fire('selection-started', { selectionId: 10, placeId: 'ChIJ_not_a_terminal', source: 'curated', curated: { terminalId: 'x', companyKey: null, placeId: 'ChIJ_not_a_terminal' } });
  assert.strictEqual(h.app.state.terminalFlow, null);
  assert.strictEqual(h.sheet(), null);
  h.addressInput.fire('place-selected', { placeId: V.placeId, description: label(V), curated: { terminalId: 'pom-terminal-v', companyKey: 'virgin', placeId: A.placeId }, selectionId: 9 });
  assert.strictEqual(h.app.state.locations.placeId, V.placeId);
  assert.strictEqual(h.app.state.locations.curated, null, 'mismatched metadata is rejected');
});

check('C13 the PR-B lanes are untouched: inside Change route or a pending edit the boundary opens nothing and the wrapper keeps today\'s path', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.app._editRoute = { routeDraft: { address: null } };
  h.typed('Virgin');
  const p = h.pick(0);
  assert.strictEqual(h.app.state.terminalFlow, null);
  assert.strictEqual(h.sheet(), null);
  h.details[0].resolve();
  await p;
  assert.deepStrictEqual(h.navigations, []);
  h.app._editRoute = null;
  h.app.pendingEdit = { bookingId: 'b1', detailsVersion: 1 };
  h.typed('Carnival');
  const p2 = h.pick(0);
  assert.strictEqual(h.app.state.terminalFlow, null);
  assert.strictEqual(h.sheet(), null);
  h.details[1].resolve();
  await p2;
  assert.strictEqual(h.app.changeTerminal(), false, 'Change terminal is refused inside a pending edit');
});

check('C14 Change terminal needs a selection; the When button is bound to it; Change terminal with no selection does nothing', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  assert.strictEqual(h.app.changeTerminal(), false);
  h.app.els.changeTerminalBtn.fire('click');
  assert.strictEqual(h.sheet(), null);
  assert.deepStrictEqual(h.navigations, []);
  assert.strictEqual(h.app.els.changeTerminalBtn.listenerCount('click'), 1);
});

check('C15 a superseded resolution hides the reminder and opens the sheet with no row marked and the Google-resolved line; a deliberate new pick clears the record and marks the new terminal', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  const id = h.app.autocomplete.selectionSequence;
  h.details[0].resolve();
  await p;
  h.sheet().confirm.fire('click');
  h.tapAirport('MIA');
  h.app.state.locations.resolution = { placeId: V.placeId, selectionId: id, canonicalPlaceId: 'ChIJ_somewhere_else' };
  h.app.renderTerminalReminder();
  assert.strictEqual(h.app.els.terminalReminder.hidden, true, 'the reminder is hidden while superseded');
  assert.deepStrictEqual(plain(h.app.selectedTerminalDisplay()), { superseded: true, terminal: null, company: '' });
  assert.strictEqual(h.app.changeTerminal(), true);   // programmatic: the hidden reminder cannot offer it
  const e = h.sheet();
  assert.ok([...e.rows.values()].every((row) => row.mark.textContent === ''), 'no row marked');
  assert.strictEqual(e.note.textContent, 'Google resolved this address to a different place. Pick a terminal, or close to keep the address.');
  assert.strictEqual(e.confirm.disabled, true);
  assert.strictEqual(h.app.state.locations.placeId, V.placeId, 'the submitted id is never overwritten');
  h.row('pom-terminal-a').button.fire('click');
  h.details[1].resolve();
  await flush(); await flush();
  assert.strictEqual(h.app.state.locations.resolution, null, 'a deliberate new selection clears the record with the identity');
  assert.strictEqual(h.app.selectedTerminalDisplay().superseded, false);
  assert.strictEqual(h.row('pom-terminal-a').mark.textContent, 'Selected');
  assert.strictEqual(e.confirm.disabled, false);
});

check('C16 typing after a close clears identity, metadata, selection number, resolution and the record together; the reminder hides', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  h.details[0].resolve();
  await p;
  h.doc.fire('keydown', { key: 'Escape' });
  h.app.state.locations.resolution = { placeId: V.placeId, selectionId: h.app.state.locations.selectionId, canonicalPlaceId: V.placeId };
  const generation = h.app.state.selectionGeneration;
  h.typed('Fon');   // the real validation-cleared path
  assert.deepStrictEqual(plain(h.app.state.locations), { address: null, airport: null, placeId: null, curated: null, selectionId: null, resolution: null });
  assert.strictEqual(h.app.state.terminalFlow, null);
  assert.strictEqual(h.app.state.selectionGeneration, generation + 1);
  assert.strictEqual(h.app.els.terminalReminder.hidden, true);
  assert.strictEqual(h.sheet(), null);
});

check('C17 the company shown: the line the passenger picked when it sails from that terminal, else every line at the terminal (a sheet row names a terminal, not a company)', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Carnival');
  const rowsNow = h.app.autocomplete.curatedRows;
  const fIndex = rowsNow.findIndex((r) => r.terminalId === 'pom-terminal-f');
  const p = h.pick(fIndex);
  h.details[0].resolve();
  await p;
  assert.deepStrictEqual(plain(h.app.state.locations.curated), { terminalId: 'pom-terminal-f', companyKey: 'carnival' });
  assert.strictEqual(h.app.selectedTerminalDisplay().company, 'Carnival Cruise Line');
  h.row('pom-terminal-v').button.fire('click');
  h.details[1].resolve();
  await flush(); await flush();
  h.row('pom-terminal-f').button.fire('click');   // back to F, through the sheet: no company context
  h.details[2].resolve();
  await flush(); await flush();
  assert.deepStrictEqual(plain(h.app.state.locations.curated), { terminalId: 'pom-terminal-f', companyKey: null });
  assert.strictEqual(h.app.selectedTerminalDisplay().company, 'Carnival Cruise Line · Disney Cruise Line');
  h.sheet().confirm.fire('click');
  h.tapAirport('MIA');
  assert.strictEqual(h.app.els.terminalReminderCompany.textContent, 'Carnival Cruise Line · Disney Cruise Line');
});

check('C19 pins: every settled terminal lookup remembers its coordinates for the sheet map; the fallback and non-terminal addresses add nothing; the host view carries the map status and layer', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  assert.deepStrictEqual(plain(h.app.terminalSheetView().map), { status: 'off', type: 'roadmap' }, 'no Maps loader on this page: the area is off');
  h.details[0].resolve(DETAILS_OK(25.78, -80.18));
  await p;
  assert.deepStrictEqual(plain([...h.app._terminalPins.entries()]), [[V.placeId, { lat: 25.78, lng: -80.18 }]]);
  h.row('pom-terminal-a').button.fire('click');
  h.details[1].fail();   // the fallback carries no coordinates
  await flush(); await flush();
  assert.strictEqual(h.app._terminalPins.has(A.placeId), false, 'null coordinates never become a pin');
  h.row('pom-terminal-b').button.fire('click');
  h.details[2].resolve(DETAILS_OK(25.79, -80.17));
  await flush(); await flush();
  assert.deepStrictEqual(plain([...h.app._terminalPins.keys()]), [V.placeId, B.placeId]);
  h.app.setTerminalMapType('satellite');
  assert.strictEqual(h.app.terminalSheetView().map.type, 'satellite');
  h.app.setTerminalMapType('nonsense');
  assert.strictEqual(h.app.terminalSheetView().map.type, 'roadmap', 'only the two Google layers');
  h.app.rememberTerminalPin('ChIJ_hotel', { lat: 25.8, lng: -80.1 });
  assert.strictEqual(h.app._terminalPins.has('ChIJ_hotel'), false, 'only verified terminals get pins');
});

check('C20 the map attaches through the page\'s Maps loader with the chosen terminal pinned and centred; a loader failure shows the note and leaves the list usable', async () => {
  const context = makeContext();
  const calls = [];
  class FakeMap {
    constructor(host, options) { calls.push(['map', options.mapTypeId, options.disableDefaultUI]); this.host = host; this.center = options.center; this.zoom = options.zoom; this.type = options.mapTypeId; }
    setCenter(p) { this.center = p; calls.push(['center', p]); }
    getZoom() { return this.zoom; }
    setZoom(z) { this.zoom = z; }
    fitBounds() { calls.push(['fit']); }
    setMapTypeId(t) { this.type = t; calls.push(['type', t]); }
  }
  class FakeMarker {
    constructor(o) { Object.assign(this, o); calls.push(['marker', o.position, o.icon.fillColor]); }
    setPosition(p) { this.position = p; }
    setIcon(i) { this.icon = i; }
    setLabel(l) { this.label = l; calls.push(['label', l && l.text]); }
    setZIndex() {}
  }
  class FakeBounds { constructor() { this.points = []; } extend(p) { this.points.push(p); } getCenter() { return this.points[0]; } }
  context.ctx.google = { maps: { importLibrary: async () => ({}), Map: FakeMap, Marker: FakeMarker, LatLngBounds: FakeBounds, Point: class { constructor(x, y) { this.x = x; this.y = y; } }, SymbolPath: { CIRCLE: 'CIRCLE' } } };
  let loads = 0;
  context.ctx.window.LinkMiaMapsLoader = { load: async () => { loads++; } };
  const h = await makeApp(context, 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  assert.strictEqual(h.sheet().mapArea.hidden, false);
  assert.strictEqual(h.sheet().mapNote.textContent, 'Loading map…', 'the area shows loading synchronously on the tap');
  h.details[0].resolve(DETAILS_OK(25.78, -80.18));
  await p;
  for (let i = 0; i < 10 && h.app._terminalMapStatus !== 'ready'; i++) await flush();
  assert.strictEqual(h.app._terminalMapStatus, 'ready');
  assert.strictEqual(loads, 1, 'one loader call per sheet open');
  assert.strictEqual(h.sheet().mapNote.hidden, true);
  assert.strictEqual(h.sheet().mapTypes.hidden, false);
  assert.ok(calls.some((c) => c[0] === 'map' && c[1] === 'roadmap' && c[2] === true), 'a dark road map with the default UI off');
  assert.ok(calls.some((c) => c[0] === 'marker' && c[1].lat === 25.78 && c[2] === '#FF9933'), 'the chosen terminal is the orange pin');
  assert.ok(calls.some((c) => c[0] === 'label' && c[1] === 'Terminal V'), 'labelled with the terminal name');
  assert.ok(calls.some((c) => c[0] === 'center' && c[1].lat === 25.78), 'centred on the chosen pin');
  h.sheet().mapTypeButtons.satellite.fire('click');
  assert.ok(calls.some((c) => c[0] === 'type' && c[1] === 'satellite'), 'the switch changes the Google layer');
  assert.strictEqual(h.sheet().mapTypeButtons.satellite.getAttribute('aria-pressed'), 'true');
  h.row('pom-terminal-a').button.fire('click');
  h.details[1].resolve(DETAILS_OK(25.79, -80.17));
  await flush(); await flush();
  const markers = calls.filter((c) => c[0] === 'marker');
  assert.strictEqual(markers.length, 2, 'the second terminal gets its own pin');
  assert.ok(calls.some((c) => c[0] === 'center' && c[1].lat === 25.79), 're-centred on the new choice');
  // a loader failure on the next open: the note, and Confirm still works
  h.sheet().confirm.fire('click');
  assert.strictEqual(h.sheet(), null);
  context.ctx.window.LinkMiaMapsLoader = { load: async () => { throw new Error('key refused'); } };
  h.tapAirport('MIA');
  h.app.els.changeTerminalBtn.fire('click');
  for (let i = 0; i < 10 && h.app._terminalMapStatus !== 'unavailable'; i++) await flush();
  assert.strictEqual(h.app._terminalMapStatus, 'unavailable');
  assert.strictEqual(h.sheet().mapNote.textContent, 'Map unavailable right now — the list still works.');
  assert.strictEqual(h.sheet().confirm.disabled, false);
  assert.strictEqual(h.app.continueAfterSheet(), true);
});

check('C18 the mode reset ends the terminal intent and clears everything with it', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  h.details[0].resolve();
  await p;
  assert.ok(h.sheet());
  h.app.setMode('pickup');
  assert.strictEqual(h.sheet(), null, 'a reset closes the sheet');
  assert.strictEqual(h.app.state.terminalFlow, null);
  assert.deepStrictEqual(plain(h.app.state.locations), { address: null, airport: null, placeId: null, curated: null, selectionId: null, resolution: null });
  assert.strictEqual(h.app.els.terminalReminder.hidden, true);
});

// ======================================================================
// D. Static pins
// ======================================================================

check('D1 the only caller of maybeAutoAdvanceAfterRouteSelection(\'address\') is still the live wrapper, and the wrapper reads the lifecycle record', () => {
  const calls = [...appBlock.matchAll(/maybeAutoAdvanceAfterRouteSelection\('address'\)/g)].length;
  assert.strictEqual(calls, 1, 'one call, inside onAddressCoordinates, nowhere else');
  const wrapper = appBlock.slice(appBlock.indexOf('onAddressCoordinates(detail) {'), appBlock.indexOf('// ================= Terminal confirmation'));
  assert.strictEqual([...wrapper.matchAll(/maybeAutoAdvanceAfterRouteSelection\('address'\)/g)].length, 1);
  assert.ok(wrapper.includes('this.state.terminalFlow'));
  assert.ok(appBlock.includes("addEventListener('selection-started'"), 'the boundary listener is bound by the initializer');
});

check('D2 the resolution record has ONE writer (the quote-ready branch, before reconcileQuoteLabel) and invalidateQuote never touches it', () => {
  const writes = [...appBlock.matchAll(/this\.state\.locations\.resolution\s*=\s*\{/g)].length;
  assert.strictEqual(writes, 1, 'exactly one non-null assignment');
  const ready = appBlock.indexOf("q.status = 'ready';");
  const record = appBlock.indexOf('this.recordResolution(quote.intent);');
  const reconcile = appBlock.indexOf('this.reconcileQuoteLabel(quote.intent);');
  assert.ok(ready > 0 && record > ready && reconcile > record, 'written in the ready branch, before the label reconciliation');
  const invalidate = appBlock.slice(appBlock.indexOf('invalidateQuote(reason) {'), appBlock.indexOf('quoteIsFresh() {'));
  assert.ok(!invalidate.includes('resolution'), 'invalidateQuote does not mention the record');
  assert.ok(!invalidate.includes('selectionId'));
});

check('D3 the page loads the sheet module at the versioned URL the service worker precaches, and both caches moved together to the next unused pair', () => {
  const sw = read('service-worker.js');
  const m = bookingPage.match(/<script src="\.\/js\/terminal-sheet\.js(\?v=\d+)?"/);
  assert.ok(m, 'indexMVP loads ./js/terminal-sheet.js');
  const literal = `'/js/terminal-sheet.js${m[1] || ''}'`;
  const list = sw.slice(sw.indexOf('const STATIC_CACHE_URLS = ['), sw.indexOf('];', sw.indexOf('const STATIC_CACHE_URLS = [')));
  assert.ok(list.includes(literal), `${literal} is precached at the EXACT requested URL`);
  assert.deepStrictEqual(sw.match(/'\/js\/terminal-sheet\.js(\?[^']*)?'/g), [literal]);
  assert.strictEqual(m[1], '?v=2', 'the module changed with the map: the page asks for v=2');
  assert.match(sw, /const CACHE_NAME = 'linkmia-v1\.3\.52';/);
  assert.match(sw, /const RUNTIME_CACHE = 'linkmia-runtime-v29';/);
  assert.ok(sw.includes('//   v1.3.52 / runtime-v29 '), 'the pair has its history line');
  for (const page of ['trip.html', 'driver.html', 'index.html', 'login.html']) {
    assert.ok(!/<script[^>]*terminal-sheet/.test(read(page)), `${page} does not load the sheet`);
  }
});

check('D4 the trip page repeats the sheet\'s own reminder words (no module, no registry on that page)', () => {
  const trip = read('trip.html');
  const { COPY } = require(path.join(repoRoot, 'js/terminal-sheet.js'));
  const reminder = /const TERMINAL_REMINDER = Object\.freeze\(\{\s*pickup: '([^']+)',\s*dropoff: '([^']+)'\s*\}\);/.exec(trip);
  assert.ok(reminder, 'trip.html declares TERMINAL_REMINDER');
  assert.strictEqual(reminder[1], COPY.reminder.pickup);
  assert.strictEqual(reminder[2], COPY.reminder.dropoff);
  const role = /const TERMINAL_ROLE = Object\.freeze\(\{ pickup: '([^']+)', dropoff: '([^']+)' \}\);/.exec(trip);
  assert.ok(role);
  assert.strictEqual(role[1], COPY.role.pickup);
  assert.strictEqual(role[2], COPY.role.dropoff);
  assert.ok(!/<script[^>]*terminal-sheet/.test(trip) && !/curated-places\.json/.test(trip), 'the trip page loads no module and fetches no registry');
});

run().catch((error) => { console.error(error); process.exit(1); });
