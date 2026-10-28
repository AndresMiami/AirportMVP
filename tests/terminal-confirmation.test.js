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
        if (type === 'click' && (this.disabled || this.hidden)) return null;   // a hidden row cannot be tapped
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
  // The BACKGROUND lookups of the marker batch (plan §3.2a) go through a
  // separate, controllable stub so the selection lookups above keep their
  // indexes; the real lookupPlaceLocation is exercised in section A.
  const background = [];
  app.autocomplete.lookupPlaceLocation = (placeId) => {
    const call = { placeId, settled: false };
    background.push(call);
    return new Promise((resolve, reject) => {
      call.resolve = (location = { lat: 25.77, lng: -80.17, attributions: [] }) => { call.settled = true; resolve(location); };
      call.fail = () => { call.settled = true; reject(new Error('details down')); };
    });
  };
  const typed = (value) => { addressInput.value = value; app.autocomplete.handleInput({ target: addressInput }); };
  // A dropdown pick by row index for the CURRENT text (click or Enter path).
  const pick = (index) => app.autocomplete.selectSuggestion(index);
  const sheet = () => (app._terminalSheet && app._terminalSheet.isOpen() ? app._terminalSheet.elements() : null);
  // A row the passenger can reach: the panel opens collapsed (the selected
  // row alone), so reaching another row means expanding first — exactly
  // what a passenger does with the handle.
  const row = (terminalId) => {
    if (!sheet()) return null;
    if (app._terminalSheet.position() === 'collapsed') app._terminalSheet.setPosition('expanded');
    return app._terminalSheet.elements().rows.get(terminalId);
  };
  const tapAirport = (code) => airportOptions.find((o) => o.dataset.airport === code).fire('click');
  return { app, addressInput, dropdown, airportOptions, navigations, invalidations, events, details, background, typed, pick, sheet, row, tapAirport, doc };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

let passed = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }
async function run() {
  console.log('\nTerminal confirmation — the stage (map + panel), lifecycle, reminder, resolution display\n');
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
  assert.deepStrictEqual(seen, [{ lat: null, lng: null, address: label(V), selectionId: id, attributions: [] }], 'the fallback carries no credits');
  assert.strictEqual(t.input.value, label(V));
});

check('A9 lookupPlaceLocation (the background batch\'s request): place_id only — never a session token — no selection state, no event; resolves the location with validated credits; rejects on a failed request, a missing location, unrepresentable credits or a missing attributions field', async () => {
  const t = makeAutocomplete(makeContext());
  await t.ready();
  const pending = t.instance.lookupPlaceLocation(A.placeId);
  assert.strictEqual(t.details.length, 1);
  const url = new URL(t.details[0].url);
  assert.strictEqual(url.pathname, '/api/places/details');
  assert.strictEqual(url.searchParams.get('place_id'), A.placeId);
  assert.strictEqual(url.searchParams.has('sessiontoken'), false, 'a standalone Details: never a session token');
  const credit = { segments: [{ text: 'Example', href: 'https://example.com/' }] };
  t.details[0].resolve({ result: { formatted_address: 'x', geometry: { location: { lat: 25.79, lng: -80.17 } } }, attributions: [credit] });
  assert.deepStrictEqual(plain(await pending), { lat: 25.79, lng: -80.17, attributions: [credit] });
  assert.deepStrictEqual(t.log.filter((line) => line.startsWith('event:') || line.startsWith('onSelect:')), [], 'no selection event, no onSelect');
  assert.strictEqual(t.input.value, '', 'the address box is untouched');
  assert.strictEqual(t.instance.selectedPlace, null, 'no selection was made');
  const failing = t.instance.lookupPlaceLocation(B.placeId);
  t.details[1].fail();
  await assert.rejects(failing, /details down/);
  const incomplete = t.instance.lookupPlaceLocation(B.placeId);
  t.details[2].resolve({ result: { formatted_address: 'x' }, attributions: [] });
  await assert.rejects(incomplete, /Incomplete/);
  const unrepresentable = t.instance.lookupPlaceLocation(B.placeId);
  t.details[3].resolve({ result: { geometry: { location: { lat: 1, lng: 2 } } }, attributions: [{ segments: [{ text: 'bad', href: 'http://insecure.example/' }] }] });
  await assert.rejects(unrepresentable, /Attribution/);
  const missing = t.instance.lookupPlaceLocation(B.placeId);
  t.details[4].resolve({ result: { geometry: { location: { lat: 1, lng: 2 } } } });   // no attributions field at all: fails closed like a selection
  await assert.rejects(missing, /Attribution/);
  await assert.rejects(t.instance.lookupPlaceLocation(''), /required/);
  assert.strictEqual(t.details.length, 5);
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
    onMapType: (type) => calls.push(['maptype', type]),
    onPanelPosition: (position) => calls.push(['position', position])
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
  assert.strictEqual(e.stage.getAttribute('role'), 'dialog', 'the whole stage is the dialog');
  assert.strictEqual(e.stage.getAttribute('aria-modal'), 'true');
  assert.strictEqual(e.stage.getAttribute('aria-labelledby'), 'terminalSheetTitle');
  assert.strictEqual(e.title.id, 'terminalSheetTitle');
  assert.deepStrictEqual(e.stage.children.map((c) => c.className.split(' ')[0]), ['terminal-sheet-header', 'terminal-sheet-map', 'terminal-sheet-panel'], 'header over the map, the map, the docked panel');
  assert.deepStrictEqual(e.panel.children.map((c) => c.className.split(' ')[0]), ['terminal-sheet-handle-btn', 'terminal-sheet-caption', 'terminal-sheet-list', 'terminal-sheet-note', 'terminal-sheet-footer']);
  assert.strictEqual(e.position, 'collapsed', 'the panel opens collapsed');
  assert.strictEqual(e.rows.get('pom-terminal-v').button.hidden, false, 'collapsed: the selected row shows');
  assert.strictEqual(e.rows.get('pom-terminal-a').button.hidden, true, 'the others wait behind Show terminals');
  assert.strictEqual(e.port.textContent, 'PortMiami');
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

check('B4 dismissal is ✕ or Escape only, each reporting one dismissal; a tap on the backdrop, the map area, the stage or a row never does; a row hidden by the collapsed position cannot be tapped at all', async () => {
  const f = sheetFixture(makeContext());
  f.sheet.open(f.view);
  const e = f.sheet.elements();
  e.close.fire('click');
  e.overlay.fire('click');
  e.mapArea.fire('click');
  e.stage.fire('click');
  e.panel.fire('click');
  f.doc.fire('keydown', { key: 'Escape' });
  assert.strictEqual(e.rows.get('pom-terminal-b').button.fire('click'), null, 'hidden while collapsed: not tappable');
  e.handle.fire('click');
  e.rows.get('pom-terminal-b').button.fire('click');
  assert.deepStrictEqual(f.calls, [['dismiss'], ['dismiss'], ['position', 'expanded'], ['row', 'pom-terminal-b']]);
});

check('B5 focus: enters the marked row; Tab/Shift+Tab cycle inside the enabled VISIBLE controls — ✕, Skip, the layer switch once the map is ready, the handle button, the rows the position shows, Confirm; the page behind is inert while open and restored on close; the Escape listener is removed', async () => {
  const f = sheetFixture(makeContext(), { selectedPlaceId: B.placeId });
  f.sheet.open(f.view, { inert: f.inert });
  const e = f.sheet.elements();
  const rowB = e.rows.get('pom-terminal-b').button;
  assert.strictEqual(f.doc.activeElement, rowB, 'focus enters the marked row');
  assert.strictEqual(f.inert.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(f.inert.inert, true);
  // collapsed, map off: ✕ → Skip → handle → the one visible row → Confirm
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.confirm, 'Confirm follows the selected row');
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.close, 'Tab from the last control wraps to the first');
  f.doc.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.strictEqual(f.doc.activeElement, e.confirm, 'Shift+Tab from the first wraps to the last');
  f.doc.activeElement = e.close;
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.skip, 'Skip follows the close control in the header');
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.handle, 'the handle button follows Skip while the map is off');
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, rowB, 'then the one visible row — the hidden rows are not in the ring');
  f.sheet.render({ ...f.view, map: { status: 'ready', type: 'roadmap' } });
  f.doc.activeElement = e.skip;
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.mapTypeButtons.roadmap, 'the layer switch joins the ring once the map is ready');
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.mapTypeButtons.satellite);
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.handle);
  // expanded: every row joins the ring, in registry order
  e.handle.fire('click');
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.rows.get('pom-terminal-v').button, 'the first row follows the handle');
  f.doc.activeElement = e.rows.get('pom-terminal-aa').button;
  f.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(f.doc.activeElement, e.confirm, 'Confirm follows the last row');
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

check('B6 the handle drag: the pure rule, then real pointer events — up past 48 px or a fast flick expands, down collapses, a short slow drag snaps back, and a drag NEVER dismisses; the click the browser fires after a real drag does not toggle again; the header and the map are not drag handles', async () => {
  const context = makeContext();
  const { dragOutcome } = context.ctx.TerminalSheet;
  assert.strictEqual(dragOutcome(-47, 0.1, 'collapsed'), 'snap');
  assert.strictEqual(dragOutcome(-48, 0, 'collapsed'), 'expand');
  assert.strictEqual(dragOutcome(-30, 0.59, 'collapsed'), 'snap');
  assert.strictEqual(dragOutcome(-30, 0.6, 'collapsed'), 'expand');
  assert.strictEqual(dragOutcome(-10, 5, 'collapsed'), 'snap', 'a flick that barely moved is nothing');
  assert.strictEqual(dragOutcome(100, 5, 'collapsed'), 'snap', 'further down from collapsed: never a dismissal');
  assert.strictEqual(dragOutcome(48, 0, 'expanded'), 'collapse');
  assert.strictEqual(dragOutcome(30, 0.6, 'expanded'), 'collapse');
  assert.strictEqual(dragOutcome(47, 0.1, 'expanded'), 'snap');
  assert.strictEqual(dragOutcome(-100, 5, 'expanded'), 'snap', 'further up from expanded: nothing');
  assert.strictEqual(dragOutcome(NaN, 1, 'collapsed'), 'snap');
  let clock = 1000;
  const f = sheetFixture(context, { now: () => clock });
  f.sheet.open(f.view);
  const e = f.sheet.elements();
  const drag = (from, to, ms) => {
    e.handle.fire('pointerdown', undefined, { clientY: from, pointerId: 1 });
    clock += ms;
    e.handle.fire('pointermove', undefined, { clientY: to });
    assert.ok(e.panel.classList.contains('dragging'));
    e.handle.fire('pointerup', undefined, {});
    assert.ok(!e.panel.classList.contains('dragging'));
  };
  drag(300, 270, 500);   // slow 30 px up: snaps back
  assert.strictEqual(f.sheet.position(), 'collapsed');
  drag(300, 240, 400);   // 60 px up: expands
  assert.strictEqual(f.sheet.position(), 'expanded');
  e.handle.fire('click');   // the browser's click after that drag: suppressed once
  assert.strictEqual(f.sheet.position(), 'expanded');
  e.handle.fire('click');   // a real tap: toggles
  assert.strictEqual(f.sheet.position(), 'collapsed');
  drag(300, 260, 40);    // fast 40 px flick up: expands
  assert.strictEqual(f.sheet.position(), 'expanded');
  e.handle.fire('click');
  drag(200, 300, 400);   // 100 px down from expanded: collapses
  assert.strictEqual(f.sheet.position(), 'collapsed');
  e.handle.fire('click');
  drag(300, 400, 400);   // 100 px down from collapsed: snaps back, no dismissal
  assert.strictEqual(f.sheet.position(), 'collapsed');
  e.handle.fire('click');
  e.handle.fire('pointerdown', undefined, { clientY: 300, pointerId: 2 });
  e.handle.fire('pointercancel', undefined, {});
  e.handle.fire('click');   // a cancelled drag with no travel is still a tap
  assert.strictEqual(f.sheet.position(), 'expanded');
  assert.ok(!f.calls.some((c) => c[0] === 'dismiss'), 'a drag never dismisses');
  assert.deepStrictEqual(f.calls.filter((c) => c[0] === 'position').map((c) => c[1]), ['expanded', 'collapsed', 'expanded', 'collapsed', 'expanded']);
  for (const node of [e.header, e.mapArea, e.stage, e.overlay]) assert.strictEqual(node.listenerCount('pointerdown'), 0, 'only the handle drags');
});

check('B8 the panel positions: collapsed on open shows only the selected (or checking) row; the handle button expands/collapses by click (Enter/Space on a button) with aria-expanded, aria-controls and its label by state; the host hears each change; the caption and credits render beside the map and hide when empty or when the map is off', async () => {
  const f = sheetFixture(makeContext(), { selectedPlaceId: V.placeId });
  const ready = { status: 'ready', type: 'roadmap' };
  f.sheet.open({ ...f.view, map: ready, credits: [] });
  const e = f.sheet.elements();
  assert.strictEqual(e.position, 'collapsed');
  assert.strictEqual(e.panel.getAttribute('data-position'), 'collapsed');
  assert.strictEqual(e.handle.tagName, 'BUTTON');
  assert.strictEqual(e.handle.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(e.handle.getAttribute('aria-controls'), 'terminalSheetList');
  assert.strictEqual(e.list.id, 'terminalSheetList');
  assert.strictEqual(e.handleLabel.textContent, 'Show terminals');
  assert.deepStrictEqual([...e.rows.values()].filter((r) => !r.button.hidden).map((r) => r.terminalId), ['pom-terminal-v']);
  e.handle.fire('click');
  assert.strictEqual(f.sheet.position(), 'expanded');
  assert.strictEqual(e.panel.getAttribute('data-position'), 'expanded');
  assert.strictEqual(e.handle.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(e.handleLabel.textContent, 'Collapse list');
  assert.strictEqual([...e.rows.values()].filter((r) => !r.button.hidden).length, 8);
  assert.deepStrictEqual(f.calls, [['position', 'expanded']]);
  // a settling row shows while collapsed, beside the selected one
  e.handle.fire('click');
  f.sheet.render({ ...f.view, settlingPlaceId: A.placeId, map: ready, credits: [] });
  assert.deepStrictEqual([...e.rows.values()].filter((r) => !r.button.hidden).map((r) => r.terminalId), ['pom-terminal-v', 'pom-terminal-a']);
  assert.deepStrictEqual(f.calls, [['position', 'expanded'], ['position', 'collapsed']]);
  assert.strictEqual(f.sheet.setPosition('collapsed'), false, 'no change, no report');
  assert.strictEqual(f.sheet.setPosition('sideways'), false);
  // superseded + collapsed: no row at all — the handle is the way to the list
  f.sheet.render({ ...f.view, superseded: true, map: ready, credits: [] });
  assert.strictEqual([...e.rows.values()].filter((r) => !r.button.hidden).length, 0);
  // the caption and the credits of the markers shown
  const credit = { segments: [{ text: 'Listings by ', href: null }, { text: 'Example', href: 'https://example.com/' }] };
  f.sheet.render({ ...f.view, map: ready, credits: [credit] });
  assert.strictEqual(e.caption.textContent, 'Terminal locations');
  assert.strictEqual(e.caption.hidden, false);
  assert.strictEqual(e.credits.hidden, false);
  assert.deepStrictEqual(e.credits.children.map((c) => c.text || c.textContent), [' · ', 'Listings by ', 'Example']);
  assert.strictEqual(e.credits.children[2].href, 'https://example.com/');
  assert.strictEqual(e.credits.children[2].target, '_blank');
  assert.strictEqual(e.credits.children[2].rel, 'noopener noreferrer');
  f.sheet.render({ ...f.view, map: ready, credits: [{ segments: [{ text: 'x', href: 'javascript:alert(1)' }] }] });
  assert.deepStrictEqual(e.credits.children.map((c) => c.text || c.textContent), [' · ', 'x'], 'a non-https href renders as plain text');
  f.sheet.render({ ...f.view, map: { status: 'off' }, credits: [credit] });
  assert.strictEqual(e.credits.hidden, true, 'no map: no credits strip');
  assert.strictEqual(e.caption.hidden, true);
  f.sheet.render({ ...f.view, map: ready });
  assert.strictEqual(e.credits.hidden, true, 'no credits in the view: hidden');
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
  assert.deepStrictEqual(plain([...h.app._terminalPins.entries()]), [[V.placeId, { lat: 25.78, lng: -80.18, attributions: [] }]]);
  assert.strictEqual(h.background.length, 7, 'the batch asked for every OTHER verified terminal (still pending here)');
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

// A fake Maps JavaScript surface: every camera and marker call is recorded,
// so the tests can say exactly when the map moved and what each marker
// looked like. `map.bounds` and `map.center` are set by the tests to model
// a passenger's pan and the visible area after a panel re-layout.
const fakeBounds = (north, south, east, west) => ({
  getNorthEast: () => ({ lat: () => north, lng: () => east }),
  getSouthWest: () => ({ lat: () => south, lng: () => west })
});
function installFakeMaps(context) {
  const calls = [];
  const maps = [];
  const markers = new Map();
  class FakeMap {
    constructor(host, options) {
      calls.push(['map', options.mapTypeId, options.disableDefaultUI, options.center, options.zoom]);
      this.host = host; this.center = options.center; this.zoom = options.zoom; this.type = options.mapTypeId; this.bounds = null;
      maps.push(this);
    }
    setCenter(p) { this.center = p; calls.push(['center', p]); }
    getCenter() { return this.center; }
    getZoom() { return this.zoom; }
    setZoom(z) { this.zoom = z; calls.push(['zoom', z]); }
    getBounds() { return this.bounds; }
    setMapTypeId(t) { this.type = t; calls.push(['type', t]); }
  }
  class FakeMarker {
    constructor(o) {
      Object.assign(this, o);
      this.listeners = {};
      calls.push(['marker', o.position, o.icon.fillColor]);
      markers.set(o.title, this);
    }
    addListener(type, fn) { this.listeners[type] = fn; }
    setPosition(p) { this.position = p; }
    setIcon(i) { this.icon = i; calls.push(['icon', i.fillColor, this.title]); }
    setLabel(l) { this.label = l; calls.push(['label', l && l.text]); }
    setZIndex() {}
  }
  context.ctx.google = { maps: { importLibrary: async () => ({}), Map: FakeMap, Marker: FakeMarker, Point: class { constructor(x, y) { this.x = x; this.y = y; } }, SymbolPath: { CIRCLE: 'CIRCLE' } } };
  let loads = 0;
  context.ctx.window.LinkMiaMapsLoader = { load: async () => { loads++; } };
  return { calls, maps, markers, loads: () => loads };
}
const untilMap = async (h, status) => { for (let i = 0; i < 10 && h.app._terminalMapStatus !== status; i++) await flush(); };

check('C20 the map attaches through the page\'s Maps loader ON the selected pin when it is known (the map\'s initial state — no camera move), the orange labelled marker; a marker tap IS a row tap (checking state on the marker, the camera moves to the settled choice); the layer switch; a loader failure shows the note and leaves the list usable', async () => {
  const context = makeContext();
  const fake = installFakeMaps(context);
  const h = await makeApp(context, 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  assert.strictEqual(h.sheet().mapArea.hidden, false);
  assert.strictEqual(h.sheet().mapNote.textContent, 'Loading map…', 'the area shows loading synchronously on the tap');
  h.details[0].resolve(DETAILS_OK(25.78, -80.18));
  await p;
  await untilMap(h, 'ready');
  assert.strictEqual(h.app._terminalMapStatus, 'ready');
  assert.strictEqual(fake.loads(), 1, 'one loader call per stage open');
  assert.strictEqual(h.sheet().mapNote.hidden, true);
  assert.strictEqual(h.sheet().mapTypes.hidden, false);
  const created = fake.calls.find((c) => c[0] === 'map');
  assert.deepStrictEqual(plain(created.slice(1)), ['roadmap', true, { lat: 25.78, lng: -80.18 }, 15], 'a dark road map, default UI off, attached ON the selected pin at the stage zoom');
  assert.ok(!fake.calls.some((c) => c[0] === 'center'), 'an attach that already shows the pin is not a camera move');
  assert.strictEqual(h.app._terminalCameraIntent, null, 'the settle intent was satisfied by the attach');
  assert.ok(fake.calls.some((c) => c[0] === 'marker' && c[1].lat === 25.78 && c[2] === '#FF9933'), 'the chosen terminal is the orange pin');
  assert.ok(fake.calls.some((c) => c[0] === 'label' && c[1] === 'Terminal V'), 'labelled with the terminal name');
  h.sheet().mapTypeButtons.satellite.fire('click');
  assert.ok(fake.calls.some((c) => c[0] === 'type' && c[1] === 'satellite'), 'the switch changes the Google layer');
  assert.strictEqual(h.sheet().mapTypeButtons.satellite.getAttribute('aria-pressed'), 'true');
  assert.ok(!fake.calls.some((c) => c[0] === 'center'), 'a layer change never moves the camera');
  // a background pin arrives: a white dot, no camera move
  h.background.find((c) => c.placeId === A.placeId).resolve({ lat: 25.79, lng: -80.17, attributions: [] });
  await flush(); await flush();
  assert.ok(fake.calls.some((c) => c[0] === 'marker' && c[1].lat === 25.79 && c[2] === '#FFFFFF'), 'the other terminal is a white dot');
  assert.ok(!fake.calls.some((c) => c[0] === 'center'), 'a background pin never moves the camera');
  // a MARKER tap runs the row path: the boundary, Checking… on the row AND the marker, Confirm/Skip disabled
  fake.markers.get(A.name).listeners.click();
  assert.deepStrictEqual(plain(h.app.state.terminalFlow), { generation: 2, selectionId: h.app.autocomplete.selectionSequence, placeId: A.placeId, stage: 'settling' });
  assert.strictEqual(h.sheet().rows.get('pom-terminal-a').mark.textContent, 'Checking…');
  assert.ok(fake.calls.some((c) => c[0] === 'label' && c[1] === 'Checking…'), 'the marker being looked up shows the checking state');
  assert.ok(fake.calls.some((c) => c[0] === 'icon' && c[1] === '#C7C7CC' && c[2] === A.name));
  assert.strictEqual(h.sheet().confirm.disabled, true);
  assert.strictEqual(h.sheet().skip.disabled, true);
  h.details[1].resolve(DETAILS_OK(25.79, -80.17));
  await flush(); await flush();
  assert.deepStrictEqual(plain(fake.calls.filter((c) => c[0] === 'center').map((c) => c[1])), [{ lat: 25.79, lng: -80.17 }], 'centred once, on the settled deliberate choice');
  assert.ok(fake.calls.some((c) => c[0] === 'icon' && c[1] === '#FF9933' && c[2] === A.name), 'A is now the orange pin');
  assert.ok(fake.calls.some((c) => c[0] === 'icon' && c[1] === '#FFFFFF' && c[2] === V.name), 'V is a white dot again');
  assert.strictEqual(fake.calls.filter((c) => c[0] === 'marker').length, 2, 'markers are reused, never duplicated');
  assert.strictEqual(h.app.state.locations.placeId, A.placeId);
  // a loader failure on the next open: the note, and Confirm still works
  h.sheet().confirm.fire('click');
  assert.strictEqual(h.sheet(), null);
  context.ctx.window.LinkMiaMapsLoader = { load: async () => { throw new Error('key refused'); } };
  h.tapAirport('MIA');
  h.app.els.changeTerminalBtn.fire('click');
  await untilMap(h, 'unavailable');
  assert.strictEqual(h.app._terminalMapStatus, 'unavailable');
  assert.strictEqual(h.sheet().mapNote.textContent, 'Map unavailable right now — the list still works.');
  assert.strictEqual(h.sheet().confirm.disabled, false);
  assert.strictEqual(h.app.continueAfterSheet(), true);
});

check('C21 P2 regression (0288 #3): a superseded selection highlights NO marker and never centres the old terminal — through a pickup-time change, a loading and a failed requote, a passenger change and Change terminal; the submitted id and the quote key are untouched; a deliberate new pick clears it and the camera follows the NEW choice', async () => {
  const context = makeContext();
  const fake = installFakeMaps(context);
  const h = await makeApp(context, 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  const id = h.app.autocomplete.selectionSequence;
  h.details[0].resolve(DETAILS_OK(25.78, -80.18));
  await p;
  await untilMap(h, 'ready');
  h.sheet().confirm.fire('click');
  h.tapAirport('MIA');
  // the quote's canonical echo resolved the address elsewhere (the record's ONE writer is covered in quote-browser-integration)
  h.app.state.locations.resolution = { placeId: V.placeId, selectionId: id, canonicalPlaceId: 'ChIJ_somewhere_else' };
  h.app.state.quote = { status: 'ready', key: 'k1', data: {}, error: null, seq: 1 };
  h.app.renderTerminalReminder();
  assert.strictEqual(h.app.els.terminalReminder.hidden, true);
  // a pickup-time change, a loading requote, a failed requote, a passenger change: the record is not theirs to touch
  h.app.state.dateTime.time = '09:30'; h.app.invalidateQuote('time changed'); h.app.renderTerminalReminder();
  h.app.state.quote.status = 'loading'; h.app.renderTerminalReminder();
  h.app.state.quote.status = 'error'; h.app.renderTerminalReminder();
  h.app.state.passengers = 3; h.app.invalidateQuote('passengers changed'); h.app.renderTerminalReminder();
  assert.deepStrictEqual(plain(h.app.selectedTerminalDisplay()), { superseded: true, terminal: null, company: '' });
  fake.calls.length = 0;
  assert.strictEqual(h.app.changeTerminal(), true);
  await untilMap(h, 'ready');
  const created = fake.calls.find((c) => c[0] === 'map');
  assert.deepStrictEqual(plain(created.slice(3)), [{ lat: 25.7780, lng: -80.1760 }, 13], 'the map attaches on the port overview, not on the old terminal');
  assert.ok(!fake.calls.some((c) => c[0] === 'center' || c[0] === 'zoom'), 'no centring on the old terminal');
  const vMarker = fake.calls.find((c) => c[0] === 'marker' && c[1].lat === 25.78);
  assert.strictEqual(vMarker[2], '#FFFFFF', 'the old terminal is a plain white dot');
  assert.ok(!fake.calls.some((c) => c[0] === 'label' && c[1] === 'Terminal V'), 'no label on the old terminal');
  const e = h.sheet();
  assert.ok([...e.rows.values()].every((row) => row.mark.textContent === ''), 'no row marked');
  assert.strictEqual(e.note.textContent, 'Google resolved this address to a different place. Pick a terminal, or close to keep the address.');
  assert.strictEqual(e.confirm.disabled, true);
  assert.strictEqual(h.doc.activeElement, e.handle, 'first-open focus lands on the handle when no row is marked');
  assert.strictEqual(h.app.state.locations.placeId, V.placeId, 'the submitted id is never overwritten');
  assert.strictEqual(h.app.state.quote.key, 'k1', 'the quote key is untouched');
  h.row('pom-terminal-a').button.fire('click');
  h.details[1].resolve(DETAILS_OK(25.79, -80.17));
  await flush(); await flush();
  assert.strictEqual(h.app.state.locations.resolution, null, 'a deliberate new selection clears the record with the identity');
  assert.deepStrictEqual(plain(fake.calls.filter((c) => c[0] === 'center').map((c) => c[1])), [{ lat: 25.79, lng: -80.17 }], 'the camera follows the NEW choice');
  assert.ok(fake.calls.some((c) => c[0] === 'marker' && c[1].lat === 25.79 && c[2] === '#FF9933'), 'A gets its orange marker from its own lookup');
  assert.ok(!fake.calls.some((c) => c[0] === 'label' && c[1] === 'Terminal V'), 'V never got a label through all of it');
  assert.strictEqual(h.sheet().confirm.disabled, false);
});

check('C22 the background batch (plan §3.2a, D1): starts on the first open with the in-flight selection reserved and one request per other verified terminal; outcomes in a per-page ledger; a result writes only the pin cache (Confirm stays disabled while the selection is pending, no identity, no camera); a failure leaves the row without a marker and is never retried; a dismissal, a reopen and a newer selection never restart it; a late result after close paints on the next open; credits render with the pins', async () => {
  const context = makeContext();
  const fake = installFakeMaps(context);
  const h = await makeApp(context, 'dropoff');
  const verified = REGISTRY_RAW.terminals.filter((t) => t.verifiedAt).map((t) => t.placeId);
  h.typed('Virgin');
  const p = h.pick(0);
  // synchronously on the tap: the batch started with V reserved (its own lookup is in flight)
  assert.deepStrictEqual(h.background.map((c) => c.placeId), verified.filter((id) => id !== V.placeId), 'every other verified terminal, once — never the in-flight selection');
  assert.strictEqual(h.app._terminalPinLedger.get(V.placeId), 'reserved');
  assert.ok(verified.filter((id) => id !== V.placeId).every((id) => h.app._terminalPinLedger.get(id) === 'pending'));
  assert.strictEqual(h.details.length, 1, 'the selection\'s own lookup is the only foreground request');
  await untilMap(h, 'ready');
  // a background result while V is still pending
  h.background.find((c) => c.placeId === A.placeId).resolve({ lat: 25.79, lng: -80.17, attributions: [] });
  await flush(); await flush();
  assert.strictEqual(h.app._terminalPinLedger.get(A.placeId), 'done');
  assert.deepStrictEqual(plain(h.app._terminalPins.get(A.placeId)), { lat: 25.79, lng: -80.17, attributions: [] });
  assert.ok(fake.calls.some((c) => c[0] === 'marker' && c[1].lat === 25.79 && c[2] === '#FFFFFF'));
  assert.strictEqual(h.sheet().confirm.disabled, true, 'a background result never enables Confirm for a pending selection');
  assert.strictEqual(h.app.state.terminalFlow.stage, 'settling');
  assert.strictEqual(h.app.state.locations.placeId, null, 'no identity from a background result');
  assert.deepStrictEqual(h.events.map((e) => e.type), ['selection-started'], 'no completion event from a background result');
  assert.ok(!fake.calls.some((c) => c[0] === 'center'), 'no camera move from a background result');
  // partial failure: B fails — no pin, the row stays listed, never retried
  h.background.find((c) => c.placeId === B.placeId).fail();
  await flush(); await flush();
  assert.strictEqual(h.app._terminalPinLedger.get(B.placeId), 'failed');
  assert.strictEqual(h.app._terminalPins.has(B.placeId), false);
  assert.strictEqual(h.row('pom-terminal-b').button.hidden, false, 'the row stays listed (expanded)');
  // the selection settles through its OWN lookup: V's pin, the camera moves to V, no background request for it
  h.details[0].resolve(DETAILS_OK(25.78, -80.18));
  await p;
  await flush();
  assert.strictEqual(h.sheet().confirm.disabled, false);
  assert.deepStrictEqual(plain(fake.calls.filter((c) => c[0] === 'center').map((c) => c[1])), [{ lat: 25.78, lng: -80.18 }]);
  assert.strictEqual(h.background.length, 7, 'no new background requests');
  // credits: G's lookup returned a third-party credit — rendered beside the map with the pin
  const credit = { segments: [{ text: 'Listings by ', href: null }, { text: 'Example', href: 'https://example.com/' }] };
  h.background.find((c) => c.placeId === TERMINAL['pom-terminal-g'].placeId).resolve({ lat: 25.775, lng: -80.165, attributions: [credit] });
  await flush(); await flush();
  assert.deepStrictEqual(plain(h.app.terminalPinCredits()), [credit]);
  const credits = h.sheet().credits;
  assert.strictEqual(credits.hidden, false);
  assert.deepStrictEqual(credits.children.map((c) => c.text || c.textContent), [' · ', 'Listings by ', 'Example']);
  assert.strictEqual(credits.children[2].href, 'https://example.com/');
  // dismiss; a late background result arrives while closed: cached only, nothing reopens
  h.sheet().close.fire('click');
  assert.strictEqual(h.sheet(), null);
  h.background.find((c) => c.placeId === F.placeId).resolve({ lat: 25.772, lng: -80.168, attributions: [] });
  await flush(); await flush();
  assert.strictEqual(h.sheet(), null, 'a late background result never reopens the stage');
  assert.strictEqual(h.app._terminalPinLedger.get(F.placeId), 'done');
  // reopen: nothing is requested again; the cached pins paint (V, A, G, F); B is still absent
  fake.calls.length = 0;
  h.tapAirport('MIA');
  h.app.els.changeTerminalBtn.fire('click');
  await untilMap(h, 'ready');
  assert.strictEqual(h.background.length, 7, 'a reopen requests nothing');
  assert.deepStrictEqual(plain(fake.calls.filter((c) => c[0] === 'marker').map((c) => c[1].lat).sort((x, y) => x - y)), [25.772, 25.775, 25.78, 25.79]);
  assert.strictEqual(h.app._terminalPinLedger.get(B.placeId), 'failed', 'failed is never retried');
  assert.ok(!fake.calls.some((c) => c[0] === 'center'), 'a reopen on the same terminal is the map\'s initial state, not a move');
  // a newer selection during the batch (AA still pending): the deliberate pick runs the normal path; the pending background result still only caches
  h.row('pom-terminal-a').button.fire('click');
  h.details[1].resolve(DETAILS_OK(25.79, -80.17));
  await flush(); await flush();
  assert.strictEqual(h.app.state.locations.placeId, A.placeId);
  h.background.find((c) => c.placeId === TERMINAL['pom-terminal-aa'].placeId).resolve({ lat: 25.80, lng: -80.19, attributions: [] });
  await flush(); await flush();
  assert.strictEqual(h.app.state.locations.placeId, A.placeId, 'the background result changed no identity');
  assert.strictEqual(h.app.state.terminalFlow.stage, 'open');
  assert.strictEqual(h.background.length, 7);
  assert.strictEqual(h.app._terminalPins.size, 5, 'V, A, G, F and AA pinned by now (B failed, D and E still pending) — nothing twice');
});

check('C23 camera (plan §2.2): a cold open shows the port overview until the selection\'s location arrives, then centres ONCE; a passenger pan survives a delayed background pin, a re-render and a layer change; a deliberate selection moves to it; expand/collapse pans only as far as keeps the selected marker visible and not at all when it already is', async () => {
  const context = makeContext();
  const fake = installFakeMaps(context);
  const h = await makeApp(context, 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  // the loader and libraries land BEFORE the selection's lookup: the overview, no selected marker
  await untilMap(h, 'ready');
  const created = fake.calls.find((c) => c[0] === 'map');
  assert.deepStrictEqual(plain(created.slice(3)), [{ lat: 25.7780, lng: -80.1760 }, 13], 'the honest loading state: LinkMia\'s own overview of the port');
  assert.ok(!fake.calls.some((c) => c[0] === 'marker'), 'no invented position for the selected terminal');
  assert.strictEqual(h.app._terminalCameraIntent, undefined, 'no intent before the location is known');
  h.details[0].resolve(DETAILS_OK(25.78, -80.18));
  await p;
  await flush();
  assert.deepStrictEqual(plain(fake.calls.filter((c) => c[0] === 'center').map((c) => c[1])), [{ lat: 25.78, lng: -80.18 }], 'ONE centring, when the location arrived');
  assert.ok(fake.calls.some((c) => c[0] === 'zoom' && c[1] === 15), 'at the stage zoom');
  assert.strictEqual(h.app._terminalCameraIntent, null);
  // the passenger pans away; then a delayed background pin, a re-render and a layer change
  const map = fake.maps[0];
  map.center = { lat: 25.70, lng: -80.30 };
  fake.calls.length = 0;
  h.background.find((c) => c.placeId === A.placeId).resolve({ lat: 25.79, lng: -80.17, attributions: [] });
  await flush(); await flush();
  h.app.renderTerminalSheet();
  h.sheet().mapTypeButtons.satellite.fire('click');
  assert.ok(!fake.calls.some((c) => c[0] === 'center' || c[0] === 'zoom'), 'the viewport never jumps');
  assert.deepStrictEqual(plain(map.center), { lat: 25.70, lng: -80.30 });
  // a deliberate new selection still moves to it
  h.row('pom-terminal-a').button.fire('click');
  h.details[1].resolve(DETAILS_OK(25.79, -80.17));
  await flush(); await flush();
  assert.deepStrictEqual(plain(fake.calls.filter((c) => c[0] === 'center').map((c) => c[1])), [{ lat: 25.79, lng: -80.17 }]);
  // expand/collapse: the selected marker inside the map area → nothing; covered → the minimal pan that brings it back in
  fake.calls.length = 0;
  map.bounds = fakeBounds(25.80, 25.78, -80.16, -80.18);   // A (25.79, -80.17) comfortably inside
  h.app._terminalSheet.setPosition('collapsed');
  context.runTimers();
  assert.ok(!fake.calls.some((c) => c[0] === 'center'), 'already visible: no move');
  map.bounds = fakeBounds(25.80, 25.795, -80.16, -80.18);   // the panel now covers A: it sits below the visible area
  h.app._terminalSheet.setPosition('expanded');
  context.runTimers();
  const moves = fake.calls.filter((c) => c[0] === 'center');
  assert.strictEqual(moves.length, 1, 'exactly one minimal pan');
  assert.strictEqual(moves[0][1].lat.toFixed(4), '25.7844', 'south by exactly the overshoot plus the edge margin (12% of the span)');
  assert.strictEqual(moves[0][1].lng, -80.17, 'lng untouched');
  assert.ok(!fake.calls.some((c) => c[0] === 'zoom'), 'a re-layout never changes the zoom');
});

check('C24 keyboard only (0289 #2): starting collapsed — Show terminals, choose a different terminal, Collapse list, Confirm; a hidden row never holds focus; first-open focus lands on the handle while the lookup is pending', async () => {
  const h = await makeApp(makeContext(), 'dropoff');
  h.typed('Virgin');
  const p = h.pick(0);
  let e = h.sheet();
  assert.strictEqual(h.doc.activeElement, e.handle, 'pending lookup: no row is marked, the handle takes first focus');
  assert.strictEqual(e.handle.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(e.handle.getAttribute('aria-controls'), e.list.id);
  assert.strictEqual(e.handleLabel.textContent, 'Show terminals');
  h.details[0].resolve();
  await p;
  e = h.sheet();
  assert.strictEqual(e.position, 'collapsed');
  assert.strictEqual(e.rows.get('pom-terminal-v').button.hidden, false);
  assert.ok(['pom-terminal-a', 'pom-terminal-b', 'pom-terminal-f'].every((id) => e.rows.get(id).button.hidden), 'the other rows are hidden while collapsed');
  // Tab order while collapsed: ✕ → Skip → handle → the selected row → Confirm → (wraps)
  h.doc.activeElement = e.close;
  const order = [];
  for (let i = 0; i < 5; i++) { h.doc.fire('keydown', { key: 'Tab' }); order.push(h.doc.activeElement); }
  assert.deepStrictEqual(order, [e.skip, e.handle, e.rows.get('pom-terminal-v').button, e.confirm, e.close]);
  // Enter on the handle (a click, for a button) expands; the rows join the ring
  h.doc.activeElement = e.handle;
  e.handle.fire('click');
  assert.strictEqual(e.handle.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(e.handleLabel.textContent, 'Collapse list');
  assert.strictEqual(e.rows.get('pom-terminal-a').button.hidden, false);
  h.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(h.doc.activeElement, e.rows.get('pom-terminal-v').button, 'the first row follows the handle');
  h.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(h.doc.activeElement, e.rows.get('pom-terminal-a').button);
  e.rows.get('pom-terminal-a').button.fire('click');   // Enter on the row
  assert.strictEqual(h.app.state.terminalFlow.placeId, A.placeId);
  h.details[1].resolve();
  await flush(); await flush();
  assert.strictEqual(e.rows.get('pom-terminal-a').mark.textContent, 'Selected');
  // collapse while the OLD row holds focus: focus moves to the handle BEFORE that row hides
  h.doc.activeElement = e.rows.get('pom-terminal-v').button;
  e.handle.fire('click');
  assert.strictEqual(e.handle.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(h.doc.activeElement, e.handle, 'focus moved to the handle before its row was hidden');
  assert.strictEqual(e.rows.get('pom-terminal-v').button.hidden, true);
  assert.strictEqual(e.rows.get('pom-terminal-a').button.hidden, false, 'the selected row stays visible');
  h.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(h.doc.activeElement, e.rows.get('pom-terminal-a').button);
  h.doc.fire('keydown', { key: 'Tab' });
  assert.strictEqual(h.doc.activeElement, e.confirm);
  e.confirm.fire('click');
  assert.strictEqual(h.sheet(), null, 'confirmed from the keyboard');
  assert.strictEqual(h.app.state.locations.placeId, A.placeId);
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

check('D5 STATIC — the markers read the ONE display decision, never the submitted id; the camera moves only in the two camera methods (setCenter/setZoom — never panTo, panBy or fitBounds); the batch starts once per page; the background lookup carries no session token, touches no selection state and dispatches nothing', () => {
  const pins = appBlock.slice(appBlock.indexOf('updateTerminalMapPins() {'), appBlock.indexOf('centreTerminalCamera(pin) {'));
  assert.ok(pins.length > 0);
  assert.ok(pins.includes('this.selectedTerminalDisplay()'), 'the marker highlight comes from selectedTerminalDisplay()');
  assert.ok(!pins.includes('state.locations.placeId'), 'the P2 read of the submitted id is gone');
  assert.ok(!/\.panTo\(|\.panBy\(|fitBounds\(/.test(appBlock), 'no animated or fitting camera calls anywhere on the booking page');
  const terminalBlock = appBlock.slice(appBlock.indexOf('// ================= Terminal confirmation'), appBlock.indexOf('// =============== end terminal confirmation'));
  assert.strictEqual([...terminalBlock.matchAll(/\.setCenter\(/g)].length, 2, 'centreTerminalCamera and keepSelectedMarkerVisible are the only camera moves');
  assert.strictEqual([...appBlock.matchAll(/this\.startTerminalPinBatch\(/g)].length, 1, 'one call site for the batch');
  assert.ok(appBlock.includes('if (!this._terminalBatchStarted) {'), 'guarded by the once-per-page flag');
  const lookup = autocompleteSource.slice(autocompleteSource.indexOf('async lookupPlaceLocation(placeId) {'), autocompleteSource.indexOf('applySelection(place) {'));
  assert.ok(lookup.length > 0, 'the background lookup exists');
  assert.ok(!lookup.includes('sessiontoken') && !lookup.includes('this.sessionToken'), 'no session token');
  assert.ok(!lookup.includes('dispatchEvent') && !lookup.includes('applySelection') && !lookup.includes('this.input.value') && !lookup.includes('selectionSequence'), 'no selection state, no event');
  assert.ok(lookup.includes('this.validAttributionEntries(data.attributions)'), 'the same attribution boundary as a selection');
  assert.ok(lookup.includes(', {}, 10000)'), 'the same 10 s bound');
});

run().catch((error) => { console.error(error); process.exit(1); });
