'use strict';

// Release 2 — the quieter When screen. This suite executes the real
// presentation methods while pinning the DOM/CSS seams that keep the existing
// booking mechanics intact. The existing ETA display is deliberately retained;
// correcting its calculation belongs to a separate release.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'indexMVP.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const appBlock = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).filter((source) => source.trim())[1];

let checks = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `source anchors moved: ${start} → ${end}`);
  return source.slice(from, to);
}

const presentationMethods = [
  sliceBetween(appBlock, '            formatDuration(minutes) {', '            canContinue() {'),
  sliceBetween(appBlock, '            navigateToPanel(panel) {', '            updateSummary() {'),
  sliceBetween(appBlock, '            updateTimeNote() {', '            selectVehicle(vehicleData) {')
].join('\n');

function loadPresentationClass(methods = presentationMethods, DateCtor = Date) {
  const context = { console, Date: DateCtor };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`class BookingPresentation { ${methods} }; globalThis.BookingPresentation = BookingPresentation;`, context);
  return context.BookingPresentation;
}

function makeElement(dataset = {}) {
  const classes = new Set();
  const attrs = new Map();
  return {
    dataset: { ...dataset },
    hidden: false,
    innerHTML: '',
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
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; }
  };
}

function makeApp(Class = loadPresentationClass()) {
  const app = new Class();
  const stages = [makeElement({ stage: 'plan' }), makeElement({ stage: 'ride' })];
  const slots = [
    makeElement({ panelAction: 'where' }),
    makeElement({ panelAction: 'when' }),
    makeElement({ panelAction: 'vehicle' })
  ];
  app.state = {
    locations: {
      address: { address: '4441 Collins Ave, Miami Beach, FL' },
      airport: { code: 'MIA', name: 'Miami International' }
    },
    mode: 'dropoff',
    route: { distance: 18.2, duration: 45, realData: true },
    dateTime: { time: new Date('2026-09-10T21:45:00Z') },
    ui: { currentPanel: 'where' }
  };
  app.els = {
    panelsWrapper: makeElement(),
    progressLine: makeElement(),
    progressSteps: stages,
    summaryBar: makeElement(),
    summaryBackBtn: makeElement(),
    bookingActionDock: makeElement({ panel: 'where' }),
    actionSlots: slots,
    timeNote: makeElement(),
    arrivalTitle: makeElement(),
    tripDuration: makeElement(),
    routeAttribution: makeElement()
  };
  app.canContinue = () => true;
  app.updateSummary = () => {};
  app.updateVehiclePrices = () => {};
  app.updateVehicleMap = () => {};
  app.updateMapBadges = () => {};
  app.quoteFlowActive = () => true;
  app.quoteCalls = 0;
  app.requestServerQuote = () => { app.quoteCalls += 1; };
  return { app, stages, slots };
}

function divRange(source, id) {
  const idAt = source.indexOf(`id="${id}"`);
  assert.ok(idAt >= 0, `${id} exists`);
  const start = source.lastIndexOf('<div', idAt);
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(source); match; match = tags.exec(source)) {
    if (match[0].startsWith('</')) depth -= 1;
    else depth += 1;
    if (depth === 0) return { start, end: tags.lastIndex, text: source.slice(start, tags.lastIndex) };
  }
  throw new Error(`${id} closing tag not found`);
}

function countId(source, id) {
  return (source.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length;
}

function assertDockImmediatelyFollows(source) {
  const wrapper = divRange(source, 'panelsWrapper');
  const dock = divRange(source, 'bookingActionDock');
  const between = source.slice(wrapper.end, dock.start).replace(/<!--[\s\S]*?-->/g, '').trim();
  assert.strictEqual(between, '', 'the dock must be the panel strip\'s immediate element sibling');
  return { wrapper, dock };
}

function formatLocalTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function assertRetainedTimeNote(markup, pickup, duration, destinationLabel = 'Airport arrival') {
  const arrival = new Date(pickup.getTime() + duration * 60 * 1000);
  assert.match(markup, /pickup:/i);
  assert.match(markup, new RegExp(destinationLabel));
  assert.match(markup, /→/);
  assert.ok(markup.includes(formatLocalTime(pickup)), 'pickup time remains visible');
  assert.ok(markup.includes(formatLocalTime(arrival)), 'existing calculated arrival remains visible');
}

check('DOM presents two named stages while retaining all three internal panels', () => {
  const progress = divRange(html, 'progressLine').text;
  assert.match(html, /data-stage="plan"[\s\S]*?Plan your ride/);
  assert.match(html, /data-stage="ride"[\s\S]*?Choose a ride/);
  assert.strictEqual((html.match(/class="progress-step/g) || []).length, 2);
  assert.ok(progress.includes('id="progressLine"'));
  assert.ok(!html.includes('progressLine2'));
  for (const id of ['wherePanel', 'whenPanel', 'vehiclePanel']) assert.strictEqual(countId(html, id), 1);
  assert.match(css, /\.panels-wrapper\.show-when\s*\{\s*transform:\s*translateX\(-100%\)/);
  assert.match(css, /\.panels-wrapper\.show-vehicle\s*\{\s*transform:\s*translateX\(-200%\)/);
});

check('where and when execute as the same visible stage; only vehicle advances progress', () => {
  const { app, stages } = makeApp();
  app.updateProgressSteps('where');
  assert.ok(stages[0].classList.contains('active'));
  assert.strictEqual(stages[0].getAttribute('aria-current'), 'step');
  assert.ok(!app.els.progressLine.classList.contains('active'));

  app.updateProgressSteps('when');
  assert.ok(stages[0].classList.contains('active'), 'When remains Plan your ride');
  assert.ok(!stages[1].classList.contains('active'));
  assert.ok(!app.els.progressLine.classList.contains('active'));

  app.updateProgressSteps('vehicle');
  assert.ok(stages[0].classList.contains('completed'));
  assert.ok(stages[1].classList.contains('active'));
  assert.strictEqual(stages[1].getAttribute('aria-current'), 'step');
  assert.ok(app.els.progressLine.classList.contains('active'));
});

check('the real navigation method changes presentation only and buys no quote before Vehicle', () => {
  const { app, slots, stages } = makeApp();
  app.navigateToPanel('when');
  assert.strictEqual(app.state.ui.currentPanel, 'when');
  assert.ok(app.els.panelsWrapper.classList.contains('show-when'));
  assert.ok(app.els.summaryBar.classList.contains('compact'));
  assert.strictEqual(app.els.summaryBackBtn.getAttribute('aria-label'), 'Back to route');
  assert.deepStrictEqual(slots.map((slot) => slot.hidden), [true, false, true]);
  assert.deepStrictEqual(slots.map((slot) => slot.classList.contains('active')), [false, true, false],
    'the visible slot needs both hidden=false and the author-CSS active class');
  assert.strictEqual(app.quoteCalls, 0);

  app.navigateToPanel('vehicle');
  assert.strictEqual(app.state.ui.currentPanel, 'vehicle');
  assert.ok(!app.els.summaryBar.classList.contains('compact'));
  assert.strictEqual(app.els.summaryBackBtn.getAttribute('aria-label'), 'Back to date and time');
  assert.ok(stages[1].classList.contains('active'));
  assert.deepStrictEqual(slots.map((slot) => slot.hidden), [true, true, false]);
  assert.deepStrictEqual(slots.map((slot) => slot.classList.contains('active')), [false, false, true]);
  assert.strictEqual(app.quoteCalls, 1, 'Vehicle remains the one quote boundary');

  app.navigateToPanel('when');
  app.navigateToPanel('where');
  assert.ok(!app.els.summaryBar.classList.contains('visible'));
  assert.ok(!app.els.summaryBar.classList.contains('compact'));
  assert.deepStrictEqual(slots.map((slot) => slot.hidden), [false, true, true]);
  assert.deepStrictEqual(slots.map((slot) => slot.classList.contains('active')), [true, false, false]);
  assert.strictEqual(app.quoteCalls, 1);
});

check('When keeps date/time and the existing ETA, removing only the unsaved flight input', () => {
  const when = divRange(html, 'whenPanel').text;
  for (const id of [
    'todayBtn', 'tomorrowBtn', 'otherDatesBtn', 'calendarContainer',
    'hourSelect', 'minuteSelect', 'ampmSelect', 'timeNote', 'backBtn',
    'arrivalTitle', 'tripDuration', 'routeAttribution'
  ]) assert.strictEqual(countId(when, id), 1, `${id} remains in When`);
  assert.match(when, /role="group" aria-label="Pickup time"/);
  assert.match(when, /class="arrival-info"/);
  assert.doesNotMatch(when, /Flight Information|flightInput|flightSection/);
  assert.doesNotMatch(when, /<h3[^>]*>\s*Time\s*<\/h3>/i);
  assert.strictEqual(countId(html, 'vehicleSelectionBtn'), 1, 'the existing Continue node remains unique');
});

check('the existing pickup-to-arrival note remains behaviorally unchanged', () => {
  const { app } = makeApp();
  app.updateTimeNote();
  assertRetainedTimeNote(
    app.els.timeNote.innerHTML,
    app.state.dateTime.time,
    app.state.route.duration
  );

  app.state.mode = 'pickup';
  app.updateTimeNote();
  assertRetainedTimeNote(
    app.els.timeNote.innerHTML,
    app.state.dateTime.time,
    app.state.route.duration,
    'Destination arrival'
  );
});

check('the existing route estimate card and Google attribution remain active', () => {
  const frozenNow = new Date('2026-09-10T20:00:00Z');
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [frozenNow.getTime()]));
    }
    static now() { return frozenNow.getTime(); }
  }
  const { app } = makeApp(loadPresentationClass(presentationMethods, FixedDate));
  app.updateRouteDisplay();
  const expectedArrival = new Date(frozenNow.getTime() + app.state.route.duration * 60 * 1000);
  assert.strictEqual(
    app.els.arrivalTitle.textContent,
    `Drop-off at airport approx. ${formatLocalTime(expectedArrival)}`,
    'the retained route card still calculates from now plus route duration'
  );
  assert.strictEqual(app.els.tripDuration.textContent, 'Estimated ride duration of 45 min (live data)');
  assert.ok(app.els.routeAttribution.classList.contains('visible'));
});

check('one external dock contains the three original, unique action nodes', () => {
  const { wrapper, dock } = assertDockImmediatelyFollows(html);
  const container = divRange(html, 'bookingContainer');
  assert.ok(dock.start > wrapper.end, 'the dock is outside the transformed panel strip');
  assert.ok(dock.end < container.end, 'the dock stays inside the booking container');
  for (const id of ['continueBtn', 'vehicleSelectionBtn', 'bookBtn']) {
    assert.strictEqual(countId(html, id), 1, `${id} was moved, never cloned`);
    assert.strictEqual(countId(dock.text, id), 1, `${id} lives in the shared dock`);
  }
  assert.match(dock.text, /data-panel-action="where"[\s\S]*?id="continueBtn"/);
  assert.match(dock.text, /data-panel-action="when"[\s\S]*?id="vehicleSelectionBtn"/);
  assert.match(dock.text, /data-panel-action="vehicle"[\s\S]*?id="bookBtn"/);
});

check('while the route editor owns the dock, both fixed pills are hidden by a body-scoped rule and return with the editor (Back/Done remove #editRouteControls)', () => {
  const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  assert.match(css, /body:has\(\.booking-container\.active #editRouteControls\) \.app-legal-nav,\s*body:has\(\.booking-container\.active #editRouteControls\) #userHeader \{ display: none; \}/,
    'both pills hide only while #editRouteControls exists inside the active container');
  assert.ok(!/#editRouteControls[^{]*\{[^}]*position: fixed/.test(css), 'no competing fixed positioning for the editor');
  // precondition of the selector: the editor mounts into the dock, and the dock is inside the container
  const html = fs.readFileSync(path.join(root, 'indexMVP.html'), 'utf8');
  const containerStart = html.indexOf('class="booking-container"'); const containerEnd = html.indexOf('<!-- One stable action position');
  assert.ok(containerStart >= 0 && containerEnd > containerStart, 'the dock markup sits after the strip inside the booking container');
  assert.ok(appBlock.includes("this.els.continueBtn.parentElement?.appendChild(controls);"), 'Use this route mounts into the Continue slot, i.e. the dock');
});

check('dock CSS pins safe-area reachability, edit-card hiding, and the 44px Back target', () => {
  assert.match(css, /\.booking-action-dock\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?bottom:\s*0;/);
  assert.match(css, /\.booking-action-dock\s*\{[\s\S]*?env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.booking-container\.active\s*\{[\s\S]*?padding-bottom:\s*calc\(138px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.booking-container\.active > \.panels-wrapper\.hidden-for-edit \+ \.booking-action-dock\s*\{\s*display:\s*none;/);
  assert.match(css, /\.continue-btn\[hidden\],\s*\.book-btn\[hidden\]\s*\{\s*display:\s*none;/,
    'a hidden button must beat the shared .continue-btn display:flex rule');
  assert.match(css, /\.summary-bar\.compact \.back-btn\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  assert.match(css, /body:has\(\.booking-container\.active\) \.app-legal-nav[\s\S]*?safe-area-inset-bottom/);
  assert.match(css, /body:has\(\.booking-container\.active\) #userHeader[\s\S]*?safe-area-inset-bottom/);
});

check('Manage Ride keeps its deliberate parent seam and the dock hides until route editing', () => {
  const enterRoute = sliceBetween(
    appBlock,
    '            enterEditRouteMode(editorInput, { onDone, onBack }) {',
    '            exitEditRouteMode() {'
  );
  assert.match(appBlock, /this\.els\.continueBtn\.parentElement\?\.appendChild\(controls\)/);
  assert.match(appBlock, /panelsWrapper\?\.classList\.add\('hidden-for-edit'\)/);
  assert.match(appBlock, /panelsWrapper\?\.classList\.remove\('hidden-for-edit', 'show-when', 'show-vehicle'\)/);
  assert.match(enterRoute, /this\.updateActionDock\('where'\)/,
    'the route editor itself must select the Where dock slot');
});

check('the cache pair advances together for both precached presentation assets', () => {
  assert.match(worker, /const CACHE_NAME = 'linkmia-v1\.3\.38';/);
  assert.match(worker, /const RUNTIME_CACHE = 'linkmia-runtime-v15';/);
  assert.match(worker, /v1\.3\.38 \/ runtime-v15\s+Quiet When \+ two-stage booking shell — THIS tree/);
  assert.match(worker, /'\/indexMVP\.html'/);
  assert.match(worker, /'\/css\/style\.css'/);
});

check('MUTATIONS: stage, compact-summary and retained-ETA regressions are observable', () => {
  const stageMutant = presentationMethods.replace(
    "const activeStage = activeStep === 'vehicle' ? 'ride' : 'plan';",
    "const activeStage = activeStep === 'when' || activeStep === 'vehicle' ? 'ride' : 'plan';"
  );
  assert.notStrictEqual(stageMutant, presentationMethods);
  const staged = makeApp(loadPresentationClass(stageMutant));
  staged.app.updateProgressSteps('when');
  assert.throws(() => assert.ok(staged.stages[0].classList.contains('active')),
    'a visible third step must break the Plan-stage assertion');

  const compactMutant = presentationMethods.replace(
    "this.els.summaryBar.classList.add('visible', 'compact');",
    "this.els.summaryBar.classList.add('visible');"
  );
  assert.notStrictEqual(compactMutant, presentationMethods);
  const compacted = makeApp(loadPresentationClass(compactMutant));
  compacted.app.navigateToPanel('when');
  assert.throws(() => assert.ok(compacted.app.els.summaryBar.classList.contains('compact')),
    'leaking the full route summary into When must be caught');

  const slotMutant = presentationMethods.replace(
    "slot.classList.toggle('active', active);",
    ''
  );
  assert.notStrictEqual(slotMutant, presentationMethods);
  const slotted = makeApp(loadPresentationClass(slotMutant));
  slotted.app.navigateToPanel('when');
  assert.throws(() => assert.ok(slotted.slots[1].classList.contains('active')),
    'hidden=false without the author-CSS active class must not count as visible');

  const adjacencyMutant = html.replace(
    '<div class="booking-action-dock" id="bookingActionDock"',
    '<div id="dock-interloper" hidden></div>\n            <div class="booking-action-dock" id="bookingActionDock"'
  );
  assert.notStrictEqual(adjacencyMutant, html);
  assert.throws(() => assertDockImmediatelyFollows(adjacencyMutant),
    'an element inserted across the adjacent-sibling hide seam must be caught');

  const timeMutant = presentationMethods.replace(
    'const arrivalTime = new Date(pickupTime.getTime() + this.state.route.duration * 60 * 1000);',
    'const arrivalTime = pickupTime;'
  );
  assert.notStrictEqual(timeMutant, presentationMethods);
  const timed = makeApp(loadPresentationClass(timeMutant));
  timed.app.updateTimeNote();
  assert.throws(() => assertRetainedTimeNote(
    timed.app.els.timeNote.innerHTML,
    timed.app.state.dateTime.time,
    timed.app.state.route.duration
  ), 'changing the retained arrival calculation must break the assertion');

  const cardTimeMutant = presentationMethods.replace(
    'const arrivalTime = new Date(now.getTime() + this.state.route.duration * 60 * 1000);',
    'const arrivalTime = now;'
  );
  assert.notStrictEqual(cardTimeMutant, presentationMethods);
  const frozenNow = new Date('2026-09-10T20:00:00Z');
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [frozenNow.getTime()]));
    }
    static now() { return frozenNow.getTime(); }
  }
  const cardTimed = makeApp(loadPresentationClass(cardTimeMutant, FixedDate));
  cardTimed.app.updateRouteDisplay();
  const expectedCardArrival = new Date(
    frozenNow.getTime() + cardTimed.app.state.route.duration * 60 * 1000
  );
  assert.throws(() => assert.strictEqual(
    cardTimed.app.els.arrivalTitle.textContent,
    `Drop-off at airport approx. ${formatLocalTime(expectedCardArrival)}`
  ), 'changing the retained route-card arrival calculation must break the assertion');
});

async function run() {
  process.exitCode = 1;
  for (const { name, fn } of queue) {
    try {
      await fn();
      checks += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      console.error(`  ✗ ${name}\n      ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  process.exitCode = 0;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
