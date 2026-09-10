// Booking flow release 1 — deliberate route-completion auto-advance.
//
// Run: node tests/booking-route-auto-advance.test.js
//
// This suite executes the real AirportBookingApp methods in a VM-backed fake
// DOM. It pins the two genuine selection boundaries without turning generic
// state restoration or Manage Ride into navigation triggers.

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
    fetch: async () => { throw new Error('auto-advance must not make a network request'); },
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

const AirportBookingApp = loadAppClass();

function makeApp(mode = 'dropoff') {
  const app = Object.create(AirportBookingApp.prototype);
  const addressInput = makeElement('input');
  const continueBtn = makeElement('button');
  const backBtn = makeElement('button');
  const airportOptions = ['MIA', 'FLL', 'PBI'].map((code) => {
    const option = makeElement('button');
    option.dataset.airport = code;
    return option;
  });
  const modeBtns = ['dropoff', 'pickup'].map((entry) => {
    const button = makeElement('button');
    button.dataset.mode = entry;
    return button;
  });
  const progressSteps = ['where', 'when', 'vehicle'].map((entry) => {
    const step = makeElement();
    step.dataset.step = entry;
    return step;
  });

  app.state = {
    mode,
    locations: { address: null, airport: null, placeId: null },
    route: { distance: null, duration: null, price: null },
    dateTime: { date: new Date('2026-09-15T00:00:00Z'), time: null },
    quote: { status: 'idle', key: null, data: null, error: null, seq: 0 },
    flight: '',
    vehicle: { selected: null, pricing: null },
    passengers: 1,
    guestData: null,
    pickupNotes: null,
    paymentMethod: 'visa-1187',
    promoCode: null,
    ui: { currentPanel: 'where' }
  };
  app.els = {
    addressInput,
    autocompleteDropdown: makeElement(),
    startSearchBtn: makeElement('button'),
    bookingContainer: makeElement(),
    modeBtns,
    airportOptions,
    continueBtn,
    backBtn,
    summaryBackBtn: makeElement('button'),
    vehicleSelectionBtn: makeElement('button'),
    vehicleBackBtn: makeElement('button'),
    bookBtn: makeElement('button'),
    editRouteBtn: makeElement('button'),
    flightInput: makeElement('input'),
    addressStep: makeElement(),
    airportStep: makeElement(),
    addressTitle: makeElement(),
    airportTitle: makeElement(),
    airportBadge: makeElement(),
    flowConnector: makeElement(),
    flightSection: makeElement(),
    panelsWrapper: makeElement(),
    progressLine: makeElement(),
    progressLine2: makeElement(),
    progressSteps,
    summaryBar: makeElement()
  };
  app.pendingEdit = null;
  app._editHydrating = false;
  app._editRoute = null;
  app.routeRequestSeq = 0;
  app.clearRouteState = () => {
    app.routeRequestSeq += 1;
    app.state.route = { distance: null, duration: null, price: null };
  };
  app.invalidateQuote = () => {};
  app.calculateRoute = () => {};
  app.updateSummary = () => {};
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
  app.navigateToPanel = (panel) => {
    navigations.push(panel);
    return realNavigate(panel);
  };
  app.bindEvents();
  app.updateStepOrder(mode === 'dropoff');
  return { app, navigations, airportOptions, addressInput, continueBtn, backBtn };
}

function selectAddress(app, addressInput, detail = {}) {
  app.autocomplete = { isValidated: true, clearValidation() {}, invalidateRawCapture() {} };
  app.handleAddressSelected({ placeId: detail.placeId || 'ChIJ_verified_place' });
  app.onAddressCoordinates({
    address: detail.address || '4441 Collins Ave, Miami Beach, FL',
    lat: Object.prototype.hasOwnProperty.call(detail, 'lat') ? detail.lat : 25.817,
    lng: Object.prototype.hasOwnProperty.call(detail, 'lng') ? detail.lng : -80.123
  });
  addressInput.value = detail.address || '4441 Collins Ave, Miami Beach, FL';
}

async function installAutocompleteEventBoundary(app) {
  class FakeCustomAutocomplete {
    constructor() {
      this.isValidated = false;
      this.onSelect = null;
    }
    clearValidation() { this.isValidated = false; }
    invalidateRawCapture() {}
  }
  app.autocomplete = null;
  app.loadAutocompleteModule = async () => ({ CustomAutocomplete: FakeCustomAutocomplete });
  await app.initializeAutocomplete();
  assert.ok(app.autocomplete, 'the real initializer installed the autocomplete boundary');
}

check('Going to Airport keeps address-first order and the final airport tap advances once', () => {
  const { app, navigations, airportOptions, addressInput } = makeApp('dropoff');
  app.onAirportTap('MIA');
  assert.strictEqual(app.state.locations.airport, null, 'airport-first remains refused');
  assert.deepStrictEqual(navigations, []);

  selectAddress(app, addressInput);
  assert.deepStrictEqual(navigations, [], 'the first required selection does not advance');
  airportOptions[0].fire('click');
  assert.deepStrictEqual(navigations, ['when']);
  assert.strictEqual(app.state.ui.currentPanel, 'when');
  app.onAirportTap('MIA');
  assert.deepStrictEqual(navigations, ['when'], 'a stale selection event cannot navigate twice');
});

check('Arriving at Airport keeps airport-first order and advances only after the final autocomplete event', async () => {
  const { app, navigations, airportOptions, addressInput } = makeApp('pickup');
  await installAutocompleteEventBoundary(app);
  assert.strictEqual(app.els.addressInput.disabled, true, 'address starts locked');
  airportOptions[1].fire('click');
  assert.strictEqual(app.els.addressInput.disabled, false, 'airport selection unlocks address');
  assert.deepStrictEqual(navigations, [], 'the first required selection does not advance');

  app.autocomplete.isValidated = true;   // applySelection sets this before dispatch
  addressInput.fire('place-selected', { placeId: 'ChIJ_verified_place' });
  assert.deepStrictEqual(navigations, [], 'place-selected alone is deliberately too early');
  addressInput.fire('place-coordinates', {
    address: '4441 Collins Ave', lat: 25.817, lng: -80.123
  });
  assert.deepStrictEqual(navigations, ['when']);
  assert.strictEqual(addressInput.blurred, true, 'the address keyboard is dismissed before When');
});

check('a verified Details fallback with null coordinates still completes an airport pickup', async () => {
  const { app, navigations, airportOptions, addressInput } = makeApp('pickup');
  await installAutocompleteEventBoundary(app);
  airportOptions[0].fire('click');
  app.autocomplete.isValidated = true;
  addressInput.fire('place-selected', { placeId: 'ChIJ_fallback' });
  addressInput.fire('place-coordinates', {
    address: '4441 Collins Ave', lat: null, lng: null
  });
  assert.deepStrictEqual(navigations, ['when']);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(app.state.locations.address.coordinates)),
    { lat: null, lng: null }
  );
});

check('incomplete and wrong-mode completion events never advance', () => {
  const dropoff = makeApp('dropoff');
  dropoff.app.maybeAutoAdvanceAfterRouteSelection('airport');
  dropoff.app.maybeAutoAdvanceAfterRouteSelection('address');
  assert.deepStrictEqual(dropoff.navigations, []);

  const pickup = makeApp('pickup');
  pickup.app.onAddressCoordinates({ address: '4441 Collins Ave', lat: 25.817, lng: -80.123 });
  pickup.app.onAirportTap('MIA');
  assert.deepStrictEqual(pickup.navigations, [], 'completing the route in the forbidden order stays inert');
});

check('auto-advance delegates final validation to the existing canContinue seam', () => {
  const { app, navigations, airportOptions, addressInput } = makeApp('dropoff');
  selectAddress(app, addressInput);

  // Isolate the auto-advance validation call from the button-state refresh that
  // selectAirport also performs. A duplicated/inlined route check must not pass.
  app.updateContinueButton = () => {};
  let validationCalls = 0;
  app.canContinue = () => {
    validationCalls += 1;
    return false;
  };

  airportOptions[0].fire('click');
  assert.strictEqual(validationCalls, 1, 'the deliberate final selection calls canContinue exactly once');
  assert.deepStrictEqual(navigations, [], 'the existing validator can veto auto-advance');
  assert.strictEqual(app.state.ui.currentPanel, 'where');
});

check('Back returns to the populated Where panel without a bounce; a new tap advances again', () => {
  const { app, navigations, airportOptions, addressInput, backBtn } = makeApp('dropoff');
  selectAddress(app, addressInput);
  airportOptions[0].fire('click');
  const completedRoute = JSON.parse(JSON.stringify({
    mode: app.state.mode,
    locations: app.state.locations
  }));
  backBtn.fire('click');
  assert.strictEqual(app.state.ui.currentPanel, 'where');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify({ mode: app.state.mode, locations: app.state.locations })),
    completedRoute,
    'Back preserves the complete route identity and display values'
  );
  assert.ok(app.state.locations.address, 'address survives Back');
  assert.strictEqual(app.state.locations.airport.code, 'MIA', 'airport survives Back');
  assert.strictEqual(app.state.locations.placeId, 'ChIJ_verified_place', 'canonical identity survives Back');
  assert.strictEqual(addressInput.value, '4441 Collins Ave, Miami Beach, FL', 'visible address survives Back');
  assert.strictEqual(app.autocomplete.isValidated, true, 'verified selection survives Back');
  assert.strictEqual(addressInput.disabled, false, 'address remains editable after Back');
  assert.strictEqual(app.els.airportStep.classList.contains('disabled'), false, 'airport step remains enabled');
  assert.ok(airportOptions.every((option) => option.disabled === false), 'airport choices remain enabled');
  assert.strictEqual(airportOptions[0].classList.contains('selected'), true, 'airport selection stays visible');
  assert.strictEqual(app.els.continueBtn.disabled, false, 'manual Continue remains available');

  app.updateContinueButton();
  app.updateAirportStepState();
  app.updateAddressStepState();
  assert.deepStrictEqual(navigations, ['when', 'where'], 'generic updates cannot bounce forward');

  airportOptions[1].fire('click');
  assert.deepStrictEqual(navigations, ['when', 'where', 'when']);
  assert.strictEqual(app.state.locations.airport.code, 'FLL');
});

check('Manage Ride route selection never enters the create When panel', () => {
  const airportEdit = makeApp('dropoff');
  airportEdit.app._editRoute = {
    routeDraft: {
      mode: 'dropoff', airport: null, airportLabel: '',
      address: { label: '4441 Collins Ave', placeId: 'ChIJ_edit', coordinates: null, attributions: [] }
    }
  };
  airportEdit.app.state.locations.address = {
    address: 'stale create address', coordinates: { lat: 25.8, lng: -80.1 }
  };
  airportEdit.app.state.locations.airport = { code: 'FLL', name: 'Fort Lauderdale' };
  airportEdit.app.onAirportTap('MIA');
  assert.deepStrictEqual(airportEdit.navigations, []);
  assert.strictEqual(airportEdit.app._editRoute.routeDraft.airport, 'MIA');

  const addressEdit = makeApp('pickup');
  addressEdit.app._editRoute = {
    routeDraft: {
      mode: 'pickup', airport: 'MIA', airportLabel: 'Miami International',
      address: { label: '', placeId: null, coordinates: null, attributions: [] }
    }
  };
  addressEdit.app.state.locations.address = {
    address: 'stale create address', coordinates: { lat: 25.8, lng: -80.1 }
  };
  addressEdit.app.state.locations.airport = { code: 'MIA', name: 'Miami International' };
  addressEdit.app.onAddressCoordinates({ address: '4441 Collins Ave', lat: 25.817, lng: -80.123 });
  assert.deepStrictEqual(addressEdit.navigations, []);
});

check('pending-edit hydration states suppress otherwise qualifying create selections', () => {
  for (const state of ['pendingEdit', '_editHydrating']) {
    const { app, navigations, airportOptions, addressInput } = makeApp('dropoff');
    app[state] = state === 'pendingEdit' ? { bookingId: 'booking-1' } : true;
    selectAddress(app, addressInput);
    airportOptions[0].fire('click');
    assert.deepStrictEqual(navigations, [], `${state} must suppress auto-advance`);
  }
});

check('restoration and generic recomputation stay inert with a complete route', () => {
  const { app, navigations } = makeApp('dropoff');
  app.state.locations.address = {
    address: '4441 Collins Ave', coordinates: { lat: 25.817, lng: -80.123 }
  };
  app.state.locations.placeId = 'ChIJ_restored';
  app.selectAirport('MIA');
  app.updateContinueButton();
  app.updateAirportStepState();
  assert.deepStrictEqual(navigations, [], 'direct restoration helpers never navigate');

  const pickup = makeApp('pickup');
  pickup.app.state.locations.airport = { code: 'MIA', name: 'Miami International' };
  pickup.app.state.locations.placeId = 'ChIJ_restored';
  pickup.app.handleAddressCoordinates({ address: '4441 Collins Ave', lat: 25.817, lng: -80.123 });
  assert.deepStrictEqual(pickup.navigations, [], 'direct address restoration never navigates');
});

check('the existing manual Continue node and handler remain a working fallback', () => {
  const { app, navigations, continueBtn } = makeApp('dropoff');
  const originalNode = continueBtn;
  app.state.locations.address = {
    address: '4441 Collins Ave', coordinates: { lat: 25.817, lng: -80.123 }
  };
  app.state.locations.placeId = 'ChIJ_restored';
  app.state.locations.airport = { code: 'MIA', name: 'Miami International' };
  app.updateContinueButton();
  assert.strictEqual(continueBtn.disabled, false);
  assert.strictEqual(continueBtn.listenerCount('click'), 1, 'the original click handler remains singular');
  continueBtn.fire('click');
  assert.strictEqual(app.els.continueBtn, originalNode, 'the DOM node was not replaced');
  assert.deepStrictEqual(navigations, ['when']);
});

check('auto-advance remains a Where-to-When client transition with no quote or simulated click', () => {
  const { app, navigations, airportOptions, addressInput, continueBtn } = makeApp('dropoff');
  let quoteCalls = 0;
  let simulatedClicks = 0;
  app.requestServerQuote = () => { quoteCalls += 1; };
  const originalFire = continueBtn.fire.bind(continueBtn);
  continueBtn.fire = (...args) => { simulatedClicks += 1; return originalFire(...args); };
  selectAddress(app, addressInput);
  airportOptions[0].fire('click');
  assert.deepStrictEqual(navigations, ['when']);
  assert.strictEqual(quoteCalls, 0, 'server quoting remains gated to Vehicle');
  assert.strictEqual(simulatedClicks, 0, 'auto-advance calls navigation directly');
});

async function run() {
  process.exitCode = 1;
  for (const { name, fn } of queue) {
    try {
      await fn();
      checks += 1;
      results.push(`  ✓ ${name}`);
    } catch (error) {
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

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
