// PR-B — the review card, EXECUTED (plan v8.6 §4 browser hydration, cost
// contract, submission, safe sinks).
//
// Run: node tests/pending-edit-card.test.js
//
// Codex's round-2 finding was that the previous tree's browser checks were
// string searches, so nothing proved that a hydrated guest ride survived a
// time-only save with its traveler intact, or that a booked Escalade stayed
// an Escalade. This suite runs the REAL card module with injected fetch,
// session, timers and a fake DOM, and asserts the bytes that would be POSTed.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const MODEL = require(path.join(repoRoot, 'js/pending-edit-model.js'));
const { createPendingEditCard, COPY } = require(path.join(repoRoot, 'js/pending-edit-card.js'));
const CARD_SRC = fs.readFileSync(path.join(repoRoot, 'js/pending-edit-card.js'), 'utf8');
// Loads a (mutated) copy of the card module through its own UMD wrapper, so a
// source mutant is EXECUTED by the same harness rather than pinned as text.
function loadCardSource(src) {
  const m = { exports: {} };
  new Function('module', 'exports', src)(m, m.exports);
  return m.exports;
}
const VEHICLE_TESLA = { key: 'tesla', name: 'Tesla Model Y', passengerCapacity: 4, bagCapacity: 4 };
const VEHICLE_ESCALADE = { key: 'escalade', name: 'Cadillac Escalade', passengerCapacity: 7, bagCapacity: 8 };
function sheetOf(h) { return h.doc.body.children[h.doc.body.children.length - 1]; }
function setTime(h, date = '2026-12-24', time = '19:15') {
  h.ui.dateInput.value = date; h.ui.timeInput.value = time;
  h.ui.timeInput.dispatch('change');
}

// ---- a fake DOM small enough to read, big enough to execute the card ----
let ACTIVE_EL = null;
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.className = '';
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.isConnected = true;
    this.focused = false;
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  set innerHTML(_) { throw new Error('innerHTML is not a permitted sink in the card'); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); c.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'hidden') this.hidden = true; }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'hidden') this.hidden = false; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev = {}) { let out; (this.listeners[t] || []).forEach((fn) => { out = fn({ preventDefault() {}, ...ev }); }); return out; }
  click() { return this.disabled ? undefined : this.dispatch('click'); }
  // A disabled control is not focusable in a browser — the fake refuses too.
  focus() { if (this.disabled) return; this.focused = true; ACTIVE_EL = this; }
  find(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.find(pred, out); } return out; }
}
class TextNode { constructor(t) { this.textContent = String(t); this.children = []; this.parentNode = null; } find() { return []; } }
function makeDoc() {
  const body = new FakeEl('body');
  const listeners = {};
  ACTIVE_EL = null;
  return {
    body, createElement: (t) => new FakeEl(t), createTextNode: (t) => new TextNode(t),
    get activeElement() { return ACTIVE_EL; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    dispatch(t, ev = {}) { for (const fn of [...(listeners[t] || [])]) fn({ preventDefault() {}, ...ev }); },
    listenerCount: (t) => (listeners[t] || []).length
  };
}

// ---- fixtures ----
const BID = '0b000000-0000-4000-8000-0000000000b1';
const PICKUP = '2026-12-24T23:30:00.000Z'; // 6:30 PM EST in Miami
function guestEscaladeDto(over = {}) {
  return {
    bookingId: BID, tripCode: 'LM-GUEST', detailsVersion: 3, status: 'pending',
    route: {
      kind: 'airport_transfer_v1', authority: 'canonical', bookingMode: 'pickup',
      airportCode: 'MIA', canonicalPlaceId: 'ChIJ_stored',
      pickupLabel: 'MIA', dropoffLabel: '4441 Collins Ave',
      addressCoordinates: null, addressAttributions: []
    },
    pickupAt: PICKUP, passengers: 3, bags: 8, bookedPriceCents: 16900,
    vehicle: { key: 'escalade', name: 'Cadillac Escalade' },
    vehicles: [
      { key: 'tesla', name: 'Tesla Model Y', passengerCapacity: 4, bagCapacity: 4 },
      { key: 'escalade', name: 'Cadillac Escalade', passengerCapacity: 7, bagCapacity: 8 },
      { key: 'sprinter', name: 'Mercedes Sprinter', passengerCapacity: 12, bagCapacity: 15 }
    ],
    traveler: { name: 'Gina Guest', phone: '+1 305 555 0199', email: null },
    booker: { name: 'Andres Booker', phone: '+1 786 509 3955' },
    optional: { notes: 'Meet at door 3', pickupSign: 'GINA' },
    ...over
  };
}
function quoteResponse({ placeId = 'ChIJ_stored', cents = { tesla: 9000, escalade: 16900, sprinter: 22000 }, ttlMs = 15 * 60000, keys = ['escalade', 'sprinter', 'tesla'] } = {}) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const vehicles = {};
  for (const k of keys) {
    vehicles[k] = { ok: true, vehicleName: k, finalCents: cents[k], token: `tok-${k}-${cents[k]}`, expiresAt };
  }
  // PRODUCTION-SHAPED echo (quote-ride.js:563-577) PLUS hostile extras. The
  // live intent carries more than the three routing fields; a fixture with
  // only three hid a spread of the whole echo into the save payload, and the
  // extras below are the override vector Codex proved
  // (intent.operationId = 'server-overwrite').
  return { quote: { intent: { mode: 'pickup', airportCode: 'MIA', placeId,
      formattedAddress: '4441 Collins Ave, Miami Beach, FL 33140, USA',
      airportName: 'Miami International Airport, Miami, FL 33142, USA',
      pickupAt: '2026-12-25T00:15:00.000Z', passengers: 99,
      operationId: 'server-overwrite', bookingId: 'server-booking', expectedDetailsVersion: 999,
      customerName: 'Server Person', phone: '+1 000 000 0000', price: 1, vehicleKey: 'tesla', quoteToken: 'server-token' },
    route: { milesTenths: 120, minutes: 30 },
    pricingVersion: 'v-test', vehicles, vehiclesOk: keys.length, bookable: keys.length > 0 } };
}

// ---- harness ----
function harness({ dto = guestEscaladeDto(), account = { name: 'Andres Booker', phone: '+1 786 509 3955', email: 'andres@example.com', ambassador: false }, script = [], factory = createPendingEditCard } = {}) {
  const doc = makeDoc();
  const calls = { quotes: [], posts: [], hydrations: 0, editSaved: null, handoff: null, closed: null, mounted: null,
    stored: [], storedEnvelopes: [], cleared: [], offered: [], seq: [] };
  const timers = [];
  let timerId = 0;
  const responses = script.slice();
  const fetchImpl = async (url, opts) => {
    calls.quotes.push({ url, body: JSON.parse(opts.body) });
    const next = responses.length ? responses.shift() : { status: 200, body: quoteResponse() };
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  const app = {
    quoteFlowActive: () => true,
    mountEditCard: (node) => { calls.mounted = node; doc.body.appendChild(node); },
    // Mirrors the HOST's airport editor: it receives the opaque route plus
    // the adapter's projections and builds its own temporary draft.
    enterEditRouteMode: (input, cbs) => {
      const p = input.projection, q = input.quoteIntent, r = input.route;
      const mode = (q && q.mode) || 'dropoff';
      app._er = { input, cbs, routeDraft: {
        mode, airport: q ? q.airportCode : null,
        // mirrors indexMVP enterEditRouteMode: the STORED airport-side label
        // seeds the draft; an airport tap replaces it with the host's name
        airportLabel: p ? (mode === 'dropoff' ? p.destination.label : p.origin.label) : '',
        address: { label: p ? (mode === 'dropoff' ? p.origin.label : p.destination.label) : '',
          placeId: q ? q.placeId : null, coordinates: r.addressCoordinates || null,
          attributions: r.addressAttributions || [] } } };
    },
    editCardClosed: (id) => { calls.closed = id; },
    editSaved: (r) => { calls.editSaved = r; },
    handleLifecycleHandoff: (st) => { calls.handoff = st; },
    failClosedFromEdit: (m) => { calls.failClosed = m; },
    fetchRideSnapshot: async () => { calls.hydrations++; return app._nextSnapshot || null; },
    unresolvedEnvelopeBlocks: async () => false,
    // Recorded, not no-ops: the exact operation stored and cleared is asserted
    // (Codex seq:234 #5 — a silent clear hid the clear-before-classify order).
    storePendingEnvelope: (env) => { calls.stored.push(env.operationId); calls.storedEnvelopes.push(env); calls.seq.push(`store:${env.operationId}`); return true; },
    clearPendingEnvelope: (id) => { calls.cleared.push(id); calls.seq.push(`clear:${id}`); },
    offerPendingEnvelope: (subject) => { calls.offered.push(subject); calls.seq.push(`offer:${subject}`); },
    newOperationId: () => '11111111-2222-4333-8444-555555555555',
    reloadOutdated: () => { calls.reload = true; },
    submitEnvelope: async (url, bodyString) => {
      calls.posts.push({ url, body: JSON.parse(bodyString) });
      calls.seq.push('post');
      const next = app._postScript && app._postScript.length ? app._postScript.shift()
        : { status: 200, body: { success: true, bookingId: BID, tripId: 'LM-GUEST', detailsVersion: 4 } };
      if (next.definitive === false) return { definitive: false };
      return { definitive: true, response: { ok: next.status < 400, status: next.status }, result: next.body };
    }
  };
  const card = factory({
    model: MODEL, document: doc, fetch: fetchImpl,
    getSession: async () => ({ access_token: 'tok', user: { id: 'auth-a', email: 'andres@example.com' } }),
    app, accountIdentity: () => account,
    setTimeout: (fn, ms) => { timers.push({ id: ++timerId, fn, ms }); return timerId; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    randomUUID: () => '11111111-2222-4333-8444-555555555555'
  });
  const flush = async () => { while (timers.length) { const t = timers.shift(); await t.fn(); } await new Promise((r) => setImmediate(r)); };
  card.open(dto, { bookingId: BID, tripCode: dto.tripCode });
  return { card, app, doc, calls, timers, flush, ui: card._ui() };
}

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

(async () => {
  console.log('\nPR-B — review card, executed\n');

  await check('opening the card makes ZERO quote calls and Save says "No changes yet"', async () => {
    const h = harness();
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0);
    assert.strictEqual(h.ui.save.disabled, true);
    assert.strictEqual(h.ui.reason.textContent, COPY.noChanges);
    assert.strictEqual(h.ui.notesLine.textContent, 'Notes for your driver: Meet at door 3');
    assert.strictEqual(h.ui.signLine.textContent, 'Pickup sign: GINA');
    assert.ok(h.ui.travelerText.textContent.includes('Gina Guest'));
    assert.ok(h.ui.travelerText.textContent.includes('Booked by Andres Booker'));
  });

  await check('the time controls are preselected by the MIAMI wall clock, not the device clock', async () => {
    const saved = process.env.TZ; process.env.TZ = 'Asia/Tokyo';
    try {
      const h = harness();
      assert.strictEqual(h.ui.dateInput.value, '2026-12-24');
      assert.strictEqual(h.ui.timeInput.value, '18:30');
      assert.match(h.ui.timeText.textContent, /Dec 24, 6:30 PM EST/);
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  });

  await check('a GUEST ride, time-only edit: ONE quote, and the payload keeps traveler, booker, vehicle and bags EXACTLY', async () => {
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change');
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'exactly one quote for one real change');
    const sent = h.calls.quotes[0].body;
    assert.strictEqual(sent.bookingId, BID);
    assert.strictEqual(sent.expectedDetailsVersion, 3);
    assert.strictEqual(sent.placeId, 'ChIJ_stored');
    assert.strictEqual(sent.pickupAt, '2026-12-25T00:15:00.000Z');
    assert.strictEqual(h.ui.save.disabled, false, 'a time-only change with a fresh quote is saveable');

    const attempt = h.card._freezeAttempt();
    const payload = h.card._buildPayload(attempt, 'op-1');
    assert.strictEqual(payload.customerName, 'Gina Guest');
    assert.strictEqual(payload.phone, '+1 305 555 0199');
    assert.strictEqual(payload.bookerName, 'Andres Booker', 'stored booker resubmitted exactly');
    assert.strictEqual(payload.bookerPhone, '+1 786 509 3955');
    assert.strictEqual(payload.vehicle, 'Cadillac Escalade', 'the booked vehicle, by canonical NAME');
    assert.strictEqual(payload.vehicleKey, 'escalade');
    assert.strictEqual(payload.bags, 8, 'snapshot bags when the vehicle is unchanged');
    assert.strictEqual(payload.pickup, 'MIA');
    assert.strictEqual(payload.dropoff, '4441 Collins Ave');
    assert.strictEqual(payload.mode, 'pickup');
    assert.strictEqual(payload.passengers, 3);
    assert.strictEqual(payload.dateTime, '2026-12-25T00:15:00.000Z');
    assert.strictEqual(payload.price, 169);
    assert.strictEqual(payload.quoteToken, 'tok-escalade-16900');
    for (const k of ['notes', 'pickupSign', 'promoCode', 'flightNumber', 'paymentMethod', 'email']) {
      assert.ok(!(k in payload), `${k} must not be on the wire`);
    }
  });

  await check('PAYLOAD BOUNDARY: exact outbound key set — the echo never leaks, and the client always wins', async () => {
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    const body = h.calls.posts[0].body;
    assert.deepStrictEqual(Object.keys(body).sort(), [
      'airportCode', 'bags', 'bookerName', 'bookerPhone', 'bookingId', 'customerName', 'dateTime', 'dropoff',
      'expectedDetailsVersion', 'mode', 'operationId', 'passengers', 'phone', 'pickup', 'placeId', 'price',
      'pricingVersion', 'quoteToken', 'routeMilesTenths', 'routeMinutes', 'tripId', 'vehicle', 'vehicleKey'
    ], 'no formattedAddress / airportName / pickupAt / extras; email only when nonblank');
    // the canonical route projection survives…
    assert.strictEqual(body.placeId, 'ChIJ_stored');
    assert.strictEqual(body.airportCode, 'MIA');
    assert.strictEqual(body.mode, 'pickup');
    // …and every client-owned/core field wins over anything the echo carried
    assert.strictEqual(body.operationId, '11111111-2222-4333-8444-555555555555', 'the FROZEN client operation id');
    assert.strictEqual(body.bookingId, BID);
    assert.strictEqual(body.expectedDetailsVersion, 3);
    assert.strictEqual(body.customerName, 'Gina Guest');
    assert.strictEqual(body.phone, '+1 305 555 0199');
    assert.strictEqual(body.passengers, 3, 'the DRAFT count, never the echo');
    assert.strictEqual(body.price, 169);
    assert.strictEqual(body.vehicleKey, 'escalade');
    assert.strictEqual(body.quoteToken, 'tok-escalade-16900');
    // Mutation notes (both executed by hand before landing): restoring the
    // whole-intent merge leaks formattedAddress/airportName/pickupAt and the
    // extras; moving the spread after operationId lets 'server-overwrite' win.
  });

  await check('PAYLOAD BOUNDARY (spread order): a hostile route projection can never override client-owned fields', async () => {
    // With the echo gone, the adapter projection carries only its own three
    // fields, so the SPREAD ORDER in buildPayload cannot be exercised through
    // the adapter. Feed buildPayload a frozen attempt whose route projection
    // has drifted hostile — the way a future adapter could — and require that
    // every client-owned/core field still wins. Moving the spread after
    // operationId fails this check.
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    const clean = h.card._freezeAttempt();
    const hostile = { ...clean, routeWrite: { ...clean.routeWrite,
      operationId: 'server-overwrite', bookingId: 'server-booking', expectedDetailsVersion: 999,
      customerName: 'Server Person', phone: '+1 000 000 0000', price: 1, vehicle: 'Sedan', vehicleKey: 'tesla',
      quoteToken: 'server-token', passengers: 99, dateTime: '1999-01-01T00:00:00.000Z', bags: 0 } };
    const body = h.card._buildPayload(hostile, '11111111-2222-4333-8444-555555555555');
    assert.strictEqual(body.operationId, '11111111-2222-4333-8444-555555555555');
    assert.strictEqual(body.bookingId, BID);
    assert.strictEqual(body.expectedDetailsVersion, 3);
    assert.strictEqual(body.customerName, 'Gina Guest');
    assert.strictEqual(body.phone, '+1 305 555 0199');
    assert.strictEqual(body.price, 169);
    assert.strictEqual(body.vehicle, 'Cadillac Escalade');
    assert.strictEqual(body.vehicleKey, 'escalade');
    assert.strictEqual(body.quoteToken, 'tok-escalade-16900');
    assert.strictEqual(body.passengers, 3);
    assert.strictEqual(body.dateTime, '2026-12-25T00:15:00.000Z');
    assert.strictEqual(body.bags, 8);
  });

  await check('Save POSTs the frozen attempt through the shipped envelope and closes on success', async () => {
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change');
    await h.flush();
    h.ui.save.click();
    await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    const body = h.calls.posts[0].body;
    assert.strictEqual(body.operationId, '11111111-2222-4333-8444-555555555555');
    assert.strictEqual(body.customerName, 'Gina Guest');
    assert.strictEqual(body.vehicle, 'Cadillac Escalade');
    assert.deepStrictEqual(h.calls.editSaved, { bookingId: BID, tripCode: 'LM-GUEST', detailsVersion: 4 });
    assert.strictEqual(h.card.isOpen(), false);
  });

  await check('a vehicle change carries name AND bag capacity from the SAME resolved card', async () => {
    const h = harness();
    h.ui.vehicleToggle.click();               // sole deliberate no-change quote
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1);
    const rows = h.ui.vehicleOptions.children;
    const sprinter = rows.find((r) => r.textContent.includes('Mercedes Sprinter'));
    sprinter.click();
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'same intent — the held quote is reused, zero more calls');
    const payload = h.card._buildPayload(h.card._freezeAttempt(), 'op');
    assert.strictEqual(payload.vehicle, 'Mercedes Sprinter');
    assert.strictEqual(payload.bags, 15, 'derived from the selected card, never from demand');
    assert.strictEqual(payload.quoteToken, 'tok-sprinter-22000');
    assert.ok(h.ui.vehicleText.textContent.includes('Updated total $220'));
  });

  await check('COST: re-selecting the booked time, a stepper burst back to the original, and reopening options while fresh all cost ZERO', async () => {
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '18:30';
    h.ui.timeInput.dispatch('change');
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0, 're-selecting the booked instant');
    h.ui.paxEdit.click(); h.ui.paxPlus.click(); h.ui.paxPlus.click(); h.ui.paxMinus.click(); h.ui.paxMinus.click();
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0, 'a burst ending at the original value');
    h.ui.vehicleToggle.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'first expansion');
    h.ui.vehicleToggle.click(); h.ui.vehicleToggle.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'collapse/reopen reuses the held quote');
  });

  await check('the passenger stepper is bounded by the FLEET maximum, never the selected car', async () => {
    const h = harness();
    h.ui.paxEdit.click();
    for (let i = 0; i < 20; i++) h.ui.paxPlus.click();
    assert.strictEqual(h.card._draft().passengers, 12);
    assert.strictEqual(h.ui.paxPlus.disabled, true);
  });

  await check('a same-raw-id re-pick collapses to the COMPLETE snapshot tuple with zero quotes', async () => {
    const h = harness();
    h.ui.routeChange.click();
    assert.ok(h.app._er, 'the Where screen was opened with a routeDraft');
    assert.strictEqual(h.app._er.routeDraft.address.placeId, 'ChIJ_stored');
    h.app._er.cbs.onDone({ mode: 'pickup', airport: 'MIA',
      address: { label: '4441 Collins Avenue, Miami Beach', placeId: 'ChIJ_stored', coordinates: null, attributions: [] } });
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0);
    assert.strictEqual(h.card._draft().route.dropoffLabel, '4441 Collins Ave', 'stored label restored, not the transient one');
    assert.strictEqual(h.ui.reason.textContent, COPY.noChanges);
  });

  await check('a replacement id reads as a change, costs ONE quote, then canonical adoption collapses it back', async () => {
    const h = harness({ script: [{ status: 200, body: quoteResponse({ placeId: 'ChIJ_stored' }) }] });
    h.ui.routeChange.click();
    h.app._er.cbs.onDone({ mode: 'pickup', airport: 'MIA',
      address: { label: '4441 Collins Ave', placeId: 'ChIJ_replacement', coordinates: null, attributions: [] } });
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1);
    assert.strictEqual(h.calls.quotes[0].body.placeId, 'ChIJ_replacement');
    assert.strictEqual(h.card._draft().route.canonicalPlaceId, 'ChIJ_stored', 'adopted the canonical id');
    assert.strictEqual(h.ui.reason.textContent, COPY.noChanges, 'route dropped out of the change set');
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'no second call after adoption');
  });

  await check('the Where screen is NOT a quote surface: nothing is bought while it is open', async () => {
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change');       // schedules a debounce
    h.ui.routeChange.click();                // opens Where before it fires
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0);
    h.app._er.cbs.onBack();
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'the change is priced once the card is back');
  });

  await check('choose self on a guest ride: traveler = account, and the wire CLEARS the booker by name equality', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    const sheet = h.doc.body.children[h.doc.body.children.length - 1];
    const selfBtn = sheet.find((n) => n.textContent === 'Travel myself')[0];
    selfBtn.click();
    await h.flush();
    const d = h.card._draft();
    assert.strictEqual(d.traveler.name, 'Andres Booker');
    assert.strictEqual(d.traveler.email, 'andres@example.com');
    assert.strictEqual(d.booker, null);
    const payload = h.card._buildPayload(h.card._freezeAttempt(), 'op');
    assert.strictEqual(payload.customerName, 'Andres Booker');
    assert.strictEqual(payload.bookerName, 'Andres Booker', 'writer clearing path: booker name == customer name');
    assert.strictEqual(payload.email, 'andres@example.com');
  });

  await check('choose self is UNAVAILABLE with a reason for ambassadors and for profiles missing phone/email', async () => {
    for (const [account, reason] of [
      [{ name: 'A', phone: '+1', email: 'a@x', ambassador: true }, 'Ambassador accounts book rides for guests'],
      [{ name: 'A', phone: '', email: 'a@x', ambassador: false }, COPY.profileNoPhone],
      [{ name: 'A', phone: '+1', email: '', ambassador: false }, COPY.profileNoEmail]
    ]) {
      const h = harness({ account });
      h.ui.travelerEdit.click();
      const sheet = h.doc.body.children[h.doc.body.children.length - 1];
      const selfBtn = sheet.find((n) => n.textContent === 'Travel myself')[0];
      assert.strictEqual(selfBtn.disabled, true);
      assert.ok(sheet.textContent.includes(reason), reason);
    }
  });

  await check('no-stale-email: a blank guest email is refused while the snapshot email is non-null', async () => {
    const h = harness({ dto: guestEscaladeDto({ traveler: { name: 'Gina Guest', phone: '+1 305 555 0199', email: 'gina@example.com' } }) });
    h.ui.travelerEdit.click();
    const sheet = h.doc.body.children[h.doc.body.children.length - 1];
    const inputs = sheet.find((n) => n.tagName === 'INPUT');
    inputs[0].value = 'Someone Else'; inputs[1].value = '+1 305 555 0000'; inputs[2].value = '';
    const form = sheet.find((n) => n.tagName === 'FORM')[0];
    form.dispatch('submit');
    assert.ok(sheet.textContent.includes(COPY.staleEmail));
    assert.strictEqual(h.card._draft().traveler.name, 'Gina Guest', 'the draft did not change');
  });

  await check('a changed traveler needs ONE value-bound confirmation at Save; an unchanged traveler saves in one tap', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    let sheet = h.doc.body.children[h.doc.body.children.length - 1];
    const inputs = sheet.find((n) => n.tagName === 'INPUT');
    inputs[0].value = 'New Guest'; inputs[1].value = '+1 305 555 0001';
    sheet.find((n) => n.tagName === 'FORM')[0].dispatch('submit');
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'a traveler change from rest = one quote');
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    sheet = h.doc.body.children[h.doc.body.children.length - 1];
    assert.strictEqual(sheet.className, 'pe-sheet-overlay', 'the confirm sheet opened');
    assert.ok(sheet.textContent.includes('Confirm the traveler'));
    sheet.find((n) => n.tagName === 'FORM')[0].dispatch('submit');   // confirm unchanged
    await tap; await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    assert.strictEqual(h.calls.posts[0].body.customerName, 'New Guest');
    assert.strictEqual(h.calls.posts[0].body.bookerName, 'Andres Booker', 'self→guest: booker = account');
  });

  await check('pickup_time_elapsed from the writer preserves the draft, blocks Save with the typed copy and focuses time', async () => {
    const h = harness();
    h.app._postScript = [{ status: 400, body: { error: 'pickup_time_elapsed' } }];
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.card.isOpen(), true, 'draft preserved');
    assert.strictEqual(h.card._draft().pickupAt, '2026-12-25T00:15:00.000Z');
    assert.strictEqual(h.ui.save.disabled, true);
    assert.strictEqual(h.ui.reason.textContent, COPY.elapsed);
    assert.strictEqual(h.ui.timeInput.focused, true);
    assert.strictEqual(h.calls.quotes.length, 1, 'never silently re-quotes the same elapsed intent');
  });

  await check('a CAS conflict makes zero paid retries, ONE fresh hydration, and shows the changed-elsewhere copy', async () => {
    const h = harness();
    h.app._postScript = [{ status: 409, body: { error: 'Ride changed', currentDetailsVersion: 5, currentStatus: 'pending' } }];
    h.app._nextSnapshot = guestEscaladeDto({ detailsVersion: 5, passengers: 4 });
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    const quotesBefore = h.calls.quotes.length;
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.hydrations, 1);
    assert.strictEqual(h.calls.quotes.length, quotesBefore, 'no paid retry');
    const ui = h.card._ui();
    assert.strictEqual(h.card._snapshot().detailsVersion, 5, 'the NEW snapshot, never the old draft with a new version');
    assert.strictEqual(h.card._draft().passengers, 4);
    assert.strictEqual(ui.reason.textContent, COPY.changedElsewhere);
  });

  await check('a lifecycle 409 (accepted meanwhile) hands off and writes nothing more', async () => {
    const h = harness();
    h.app._postScript = [{ status: 409, body: { error: 'Ride is no longer editable', currentStatus: 'confirmed' } }];
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.handoff, 'confirmed');
    assert.strictEqual(h.card.isOpen(), false);
    assert.strictEqual(h.calls.posts.length, 1);
  });

  await check('requote from the writer: ONE quiet refresh and ONE auto-resubmit as a new envelope, then stop', async () => {
    const h = harness();
    h.app._postScript = [{ status: 409, body: { error: 'quote_expired', requote: true } }];
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 2, 'the initial quote + one quiet refresh');
    assert.strictEqual(h.calls.posts.length, 2, 'one auto-resubmit');
    assert.ok(h.calls.editSaved, 'the resubmit succeeded');
  });

  await check('requote from the writer, quiet re-quote answers 502: ONE POST, no auto-resubmit, the card stays open with its CAS and the draft; the card never touches browser storage', async () => {
    const h = harness({ script: [
      { status: 200, body: quoteResponse() },
      { status: 502, body: { error: 'upstream' } }
    ] });
    h.app._postScript = [{ status: 409, body: { error: 'quote_expired', requote: true } }];
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 2, 'the initial quote + ONE quiet refresh');
    assert.strictEqual(h.calls.posts.length, 1, 'a failed re-quote buys no resubmit');
    assert.strictEqual(h.calls.posts[0].url, '/api/update-pending-booking');
    assert.strictEqual(h.calls.posts[0].body.expectedDetailsVersion, guestEscaladeDto().detailsVersion, 'the captured CAS is what was sent');
    assert.strictEqual(h.calls.editSaved, null, 'nothing was saved');
    assert.strictEqual(h.card.isOpen(), true, 'the edit session stays open');
    assert.strictEqual(h.card._draft().pickupAt, '2026-12-25T00:15:00.000Z', 'the draft is preserved');
    assert.strictEqual(h.ui.status.hidden, false, 'the failed refresh is reported on the status line');
    assert.ok(h.ui.status.textContent.startsWith(COPY.quoteFailed), 'typed copy, never raw server text');
    assert.ok(h.ui.status.children.some((c) => c.tagName === 'BUTTON' && c.textContent === 'Try again'), 'an upstream failure stays retryable');
    assert.strictEqual(h.ui.reason.textContent, '', 'no sticky reason is invented for a transient failure');
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'pending-edit-card.js'), 'utf8');
    assert.ok(!src.includes('localStorage') && !src.includes('sessionStorage'), 'the existing ride\'s trip_ record survives by construction');
  });

  await check('expired-but-complete: Save reads "Refresh and Save"; a changed total STOPS for review', async () => {
    const h = harness({ script: [
      { status: 200, body: quoteResponse() },
      { status: 200, body: quoteResponse({ cents: { tesla: 9000, escalade: 18900, sprinter: 22000 } }) }
    ] });
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.card._held().expiresAt = 0;   // TTL lapsed
    h.card._executeComparator();
    assert.strictEqual(h.ui.save.textContent, COPY.saveRefresh);
    assert.strictEqual(h.ui.save.disabled, false, 'stays CLICKABLE');
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 2, 'one quiet refresh');
    assert.strictEqual(h.calls.posts.length, 0, 'a changed total is never auto-sent');
    assert.strictEqual(h.ui.reason.textContent, COPY.priceChanged);
  });

  await check('an incompatible selected vehicle shows typed copy and Save is unavailable; nothing is switched', async () => {
    const q = quoteResponse();
    q.quote.vehicles.tesla = { ok: false, error: { code: 'passenger_capacity_exceeded', message: 'raw server text' } };
    q.quote.vehiclesOk = 2;
    const h = harness({ dto: guestEscaladeDto({ vehicle: { key: 'tesla', name: 'Tesla Model Y' }, passengers: 5 }), script: [{ status: 200, body: q }] });
    h.ui.paxEdit.click(); h.ui.paxPlus.click(); await h.flush();
    assert.strictEqual(h.card._draft().vehicle.key, 'tesla', 'not switched or clamped');
    assert.strictEqual(h.ui.save.disabled, true);
    assert.strictEqual(h.ui.reason.textContent, 'Choose a vehicle that fits 6 passengers');
    assert.ok(!h.calls.mounted.textContent.includes('raw server text'), 'raw refusal text never rendered');
  });

  await check('SAFE SINKS: sentinel strings in every DTO field render as literal text (innerHTML would throw)', async () => {
    const S = '<img src=x onerror=alert(1)>';
    const dto = guestEscaladeDto({
      tripCode: S,
      route: { ...guestEscaladeDto().route, pickupLabel: S, dropoffLabel: S,
        addressAttributions: [{ segments: [{ text: S, href: 'javascript:alert(1)' }] }] },
      vehicles: [{ key: 'escalade', name: S, passengerCapacity: 7, bagCapacity: 8 }],
      vehicle: { key: 'escalade', name: S },
      traveler: { name: S, phone: S, email: null }, booker: { name: S, phone: S },
      optional: { notes: S, pickupSign: S }
    });
    const h = harness({ dto });
    h.ui.vehicleToggle.click();
    const text = h.calls.mounted.textContent;
    assert.ok(text.split(S).length > 6, 'the sentinel appears literally, many times');
    const anchors = h.calls.mounted.find((n) => n.tagName === 'A');
    assert.strictEqual(anchors.length, 0, 'a non-https attribution href never becomes a link');
  });

  await check('flag-false: the card surface is inert when the quote flow is off', async () => {
    const h = harness();
    h.app.quoteFlowActive = () => false;
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0);
  });

  await check('Discard writes nothing, buys nothing, and returns to the trip sheet', async () => {
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change');
    h.ui.discard.click();
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0, 'the queued quote died with the session');
    assert.strictEqual(h.calls.posts.length, 0);
    assert.strictEqual(h.calls.closed, BID);
    assert.strictEqual(h.card.isOpen(), false);
  });

  console.log('\nPR-B — Codex seq:191 P0 regressions, executed\n');

  await check('P0-1: the save chain is CLAIMED at the first tap — a change attempted during auth cannot move the draft, and the POST carries the tapped instant', async () => {
    // Slow session acquisition so the chain is mid-flight when the passenger
    // tries to edit. Before the fix the draft moved to 8:00 while 7:15 was
    // posted; now every edit control is inert and every handler refuses.
    let releaseSession = null;
    const gate = new Promise((r) => { releaseSession = r; });
    const slow = harness();
    slow.ui.dateInput.value = '2026-12-24'; slow.ui.timeInput.value = '19:15';
    slow.ui.timeInput.dispatch('change'); await slow.flush();
    // Gate the chain at its FIRST await (the shipped envelope predicate).
    slow.app.unresolvedEnvelopeBlocks = async () => { await gate; return false; };
    const tap = slow.ui.save.click();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(slow.card._chainBusy(), true, 'claimed before the first await resolved');
    assert.strictEqual(slow.ui.timeInput.disabled, true);
    assert.strictEqual(slow.ui.dateInput.disabled, true);
    assert.strictEqual(slow.ui.paxPlus.disabled, true);
    assert.strictEqual(slow.ui.routeChange.disabled, true);
    // attempt the mutation anyway (a real DOM fires 'change' on a disabled
    // input only via script; the handler itself must refuse)
    // DIRECT-dispatch (the fake DOM's click() suppresses disabled buttons; the
    // production guard must refuse on its own)
    slow.ui.timeInput.value = '20:00'; slow.ui.timeInput.dispatch('change');
    slow.ui.paxPlus.dispatch('click'); slow.ui.routeChange.dispatch('click');
    assert.strictEqual(slow.card._draft().pickupAt, '2026-12-25T00:15:00.000Z', 'the draft did not move');
    assert.strictEqual(slow.card._draft().passengers, 3);
    assert.strictEqual(slow.app._er, undefined, 'Where did not open');
    releaseSession(); await tap; await slow.flush();
    assert.strictEqual(slow.calls.posts.length, 1);
    assert.strictEqual(slow.calls.posts[0].body.dateTime, '2026-12-25T00:15:00.000Z', 'the tapped instant was posted');
    assert.strictEqual(slow.calls.editSaved.detailsVersion, 4);
  });

  await check('P0-1: a second tap before the first await resolves is refused — exactly one POST', async () => {
    let release = null;
    const gate = new Promise((r) => { release = r; });
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.app.unresolvedEnvelopeBlocks = async () => { await gate; return false; };
    const t1 = h.ui.save.click();
    const t2 = h.ui.save.click();   // synchronous double tap, before any await resolved
    await new Promise((r) => setImmediate(r));
    release(); await t1; await t2; await h.flush();
    assert.strictEqual(h.calls.posts.length, 1, 'one chain, one POST');
  });

  await check('P0-3: a BLANK time control makes the intent incomplete — Save blocked, zero quotes, no hidden instant', async () => {
    const h = harness();
    h.ui.timeInput.value = ''; h.ui.timeInput.dispatch('change');
    h.ui.paxEdit.click(); h.ui.paxPlus.click();   // a real change that would otherwise price
    await h.flush();
    assert.strictEqual(h.card._timeResolution(), 'blank');
    assert.strictEqual(h.card._draft().pickupAt, null, 'the old instant is not kept behind the controls');
    assert.strictEqual(h.calls.quotes.length, 0, 'nothing priced the hidden instant');
    assert.strictEqual(h.ui.save.disabled, true);
    assert.strictEqual(h.ui.reason.textContent, COPY.chooseTime);
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 0);
  });

  await check('P0-3: a spring-forward GAP blocks Save with the typed reason and posts nothing', async () => {
    const h = harness();
    h.ui.dateInput.value = '2027-03-14'; h.ui.timeInput.value = '02:30';
    h.ui.timeInput.dispatch('change'); await h.flush();
    assert.strictEqual(h.card._timeResolution(), 'gap');
    assert.strictEqual(h.ui.save.disabled, true);
    assert.strictEqual(h.ui.reason.textContent, COPY.nonexistentTime);
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 0);
    assert.strictEqual(h.calls.quotes.length, 0);
  });

  await check('P0-3: an UNRESOLVED fall-back fold blocks until one instant is chosen; choosing it prices once and clears the reason', async () => {
    const h = harness();
    h.ui.dateInput.value = '2026-11-01'; h.ui.timeInput.value = '01:30';
    h.ui.timeInput.dispatch('change'); await h.flush();
    assert.strictEqual(h.card._timeResolution(), 'fold');
    assert.strictEqual(h.ui.timeChoice.children.length, 3, 'note + two instants');
    assert.strictEqual(h.ui.save.disabled, true);
    assert.strictEqual(h.ui.reason.textContent, COPY.ambiguousTime);
    assert.strictEqual(h.calls.quotes.length, 0);
    h.ui.timeChoice.children[2].click();   // EST instant
    await h.flush();
    assert.strictEqual(h.card._timeResolution(), 'resolved');
    assert.strictEqual(h.card._draft().pickupAt, '2026-11-01T06:30:00.000Z');
    assert.strictEqual(h.calls.quotes.length, 1);
    assert.notStrictEqual(h.ui.reason.textContent, COPY.ambiguousTime, 'the sticky reason cleared on a valid pick');
  });

  await check('P0-3: a valid pick after a GAP clears the sticky invalid-time reason', async () => {
    const h = harness();
    h.ui.dateInput.value = '2027-03-14'; h.ui.timeInput.value = '02:30';
    h.ui.timeInput.dispatch('change');
    assert.strictEqual(h.ui.reason.textContent, COPY.nonexistentTime);
    h.ui.timeInput.value = '03:30'; h.ui.timeInput.dispatch('change'); await h.flush();
    assert.strictEqual(h.card._timeResolution(), 'resolved');
    assert.notStrictEqual(h.ui.reason.textContent, COPY.nonexistentTime);
  });

  await check('LEGACY: a legacy_unclassified_v1 row shows "Current (as booked)", offers no quote, and converts on a complete Where selection', async () => {
    const dto = guestEscaladeDto({ route: {
      kind: 'legacy_unclassified_v1', authority: 'legacy_text', bookingMode: 'pickup',
      airportCode: null, canonicalPlaceId: null,
      pickupLabel: 'Miami International Airport', dropoffLabel: 'Some hotel, Miami Beach',
      addressCoordinates: null, addressAttributions: []
    } });
    const h = harness({ dto });
    assert.ok(h.ui.routeText.textContent.startsWith('Current (as booked): '));
    assert.strictEqual(h.ui.reason.textContent, COPY.reselect);
    h.ui.vehicleToggle.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 0, 'expansion on an incomplete intent buys nothing');
    assert.ok(h.ui.vehicleOptions.textContent.includes(COPY.reselect));
    h.ui.routeChange.click();
    assert.strictEqual(h.app._er.routeDraft.address.placeId, null);
    h.app._er.cbs.onDone({ mode: 'pickup', airport: 'MIA',
      address: { label: 'Some hotel', placeId: 'ChIJ_new', coordinates: null, attributions: [] } });
    await h.flush();
    assert.strictEqual(h.card._draft().route.kind, 'airport_transfer_v1', 'converted through fromRouteDraft');
    assert.strictEqual(h.calls.quotes.length, 1, 'the first quote is the first changed route Done');
  });

  await check('the passenger line never claims a changed count is the BOOKED count', async () => {
    const h = harness();
    assert.strictEqual(h.ui.paxText.textContent, 'Booked passenger count: 3');
    h.ui.paxEdit.click(); h.ui.paxPlus.click();
    assert.strictEqual(h.ui.paxText.textContent, 'Passengers: 4 (booked: 3)');
    h.ui.paxMinus.click();
    assert.strictEqual(h.ui.paxText.textContent, 'Booked passenger count: 3');
  });

  console.log('\nPR-B — Codex seq:193 corrections, executed\n');

  await check('#1: an UNTYPED 409 never becomes "a chauffeur accepted" — card and draft preserved, not-saved copy', async () => {
    const h = harness();
    h.app._postScript = [{ status: 409, body: { error: 'Could not process this request' } }];
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15';
    h.ui.timeInput.dispatch('change'); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.handoff, null, 'no lifecycle handoff');
    assert.strictEqual(h.calls.hydrations, 0, 'not a CAS conflict either');
    assert.strictEqual(h.card.isOpen(), true, 'the card stays');
    assert.strictEqual(h.card._draft().pickupAt, '2026-12-25T00:15:00.000Z', 'the draft stays');
    assert.strictEqual(h.ui.reason.textContent, COPY.notSaved);
    assert.strictEqual(h.calls.posts.length, 1);
  });

  await check('#1: only the EXACT typed shapes route — not_editable → handoff, version → CAS', async () => {
    const a = harness();
    a.app._postScript = [{ status: 409, body: { error: 'Ride is no longer editable', currentStatus: 'confirmed' } }];
    a.ui.dateInput.value = '2026-12-24'; a.ui.timeInput.value = '19:15'; a.ui.timeInput.dispatch('change'); await a.flush();
    a.ui.save.click(); await a.flush();
    assert.strictEqual(a.calls.handoff, 'confirmed');
    const b = harness();
    b.app._postScript = [{ status: 409, body: { error: 'Ride changed', currentDetailsVersion: 9, currentStatus: 'pending' } }];
    b.app._nextSnapshot = guestEscaladeDto({ detailsVersion: 9 });
    b.ui.dateInput.value = '2026-12-24'; b.ui.timeInput.value = '19:15'; b.ui.timeInput.dispatch('change'); await b.flush();
    b.ui.save.click(); await b.flush();
    assert.strictEqual(b.calls.hydrations, 1);
    assert.strictEqual(b.calls.handoff, null);
  });

  await check('#3: the commit attempt is DEEPLY immutable and the payload is a pure function of it', async () => {
    let account = { name: 'Andres Booker', phone: '+1 786 509 3955', email: 'andres@example.com', ambassador: false };
    const h = harness({ account });
    // choose self so the guest→self branch (which used to read live account) is exercised
    h.ui.travelerEdit.click();
    const sheet = h.doc.body.children[h.doc.body.children.length - 1];
    sheet.find((n) => n.textContent === 'Travel myself')[0].click(); await h.flush();
    const attempt = h.card._freezeAttempt();
    const before = JSON.stringify(h.card._buildPayload(attempt, 'op'));
    // nested mutation attempts are refused (frozen), not silently absorbed
    assert.throws(() => { 'use strict'; attempt.traveler.name = 'Mallory'; });
    assert.throws(() => { 'use strict'; attempt.snapshotBooker.phone = '+0'; });
    assert.ok(Object.isFrozen(attempt.traveler));
    assert.ok(attempt.booker === null || Object.isFrozen(attempt.booker));
    assert.ok(attempt.snapshotBooker === null || Object.isFrozen(attempt.snapshotBooker));
    // live account / snapshot / context drift after the freeze changes NOTHING
    account.phone = '+1 000 000 0000'; account.name = 'Someone Else';
    h.card._snapshot() && Object.isFrozen(h.card._snapshot());   // snapshot is frozen by the model already
    const after = JSON.stringify(h.card._buildPayload(attempt, 'op'));
    assert.strictEqual(after, before, 'serialized bytes must not move');
    assert.strictEqual(JSON.parse(after).bookerPhone, '+1 786 509 3955', 'captured at freeze time');
  });

  await check('#5: the generic card never names a shape-specific route field (static allowlist)', async () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(repoRoot, 'js/pending-edit-card.js'), 'utf8');
    // v8.6 §3B/§4: the generic card carries Route OPAQUELY. None of these
    // identifiers may appear ANYWHERE in it — not as a route read, not as a
    // quote-intent field name, not in a comment. The adapter's projections
    // are spread through, never enumerated.
    for (const forbidden of ['bookingMode', 'airportCode', 'canonicalPlaceId', 'airport_transfer_v1', 'legacy_unclassified_v1', 'pickupLabel', 'dropoffLabel']) {
      const hits = src.split(forbidden).length - 1;
      assert.strictEqual(hits, 0, `${forbidden} appears ${hits}x in the generic card`);
    }
    // EVERY direct route field read other than `.kind` (the dispatch key) fails —
    // an inert `draft.route.addressCoordinates` read would be caught here.
    const reads = [...src.matchAll(/(draft|snapshot)\.route\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[2]);
    assert.deepStrictEqual([...new Set(reads)].filter((f) => f !== 'kind'), [],
      'no direct read of a route field outside the adapter');
  });

  await check('#5: the host editor receives the OPAQUE route + adapter projections and submitted mode comes from the quote projection', async () => {
    const h = harness();
    h.ui.routeChange.click();
    assert.ok(h.app._er.input.route && h.app._er.input.projection && h.app._er.input.quoteIntent);
    assert.strictEqual(h.app._er.input.quoteIntent.mode, 'pickup');
    h.app._er.cbs.onBack(); await h.flush();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15'; h.ui.timeInput.dispatch('change'); await h.flush();
    // the submitted mode travels inside the spread route-write projection
    assert.strictEqual(h.card._freezeAttempt().routeWrite.mode, 'pickup');
    assert.strictEqual(h.card._buildPayload(h.card._freezeAttempt(), 'op').mode, 'pickup');
  });

  await check('#6: an external close during the EDIT sheet removes the dialog and posts nothing', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    assert.strictEqual(h.card._sheetOpen(), true);
    h.card.close();
    assert.strictEqual(h.card._sheetOpen(), false);
    assert.strictEqual(h.doc.body.children.some((n) => n.className === 'pe-sheet-overlay'), false, 'no overlay left on body');
    assert.strictEqual(h.calls.posts.length, 0);
  });

  await check('#6: an external close during the CONFIRM sheet settles the Save await as cancelled — no POST, no hang', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    let sheet = h.doc.body.children[h.doc.body.children.length - 1];
    const inputs = sheet.find((n) => n.tagName === 'INPUT');
    inputs[0].value = 'New Guest'; inputs[1].value = '+1 305 555 0001';
    sheet.find((n) => n.tagName === 'FORM')[0].dispatch('submit'); await h.flush();
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.card._sheetOpen(), true, 'confirm sheet is up');
    h.card.close();                       // e.g. a lifecycle handoff arrives
    const settled = await Promise.race([tap.then(() => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 50))]);
    assert.strictEqual(settled, 'settled', 'the Save continuation resolved exactly once');
    assert.strictEqual(h.doc.body.children.some((n) => n.className === 'pe-sheet-overlay'), false);
    assert.strictEqual(h.calls.posts.length, 0);
  });

  await check('#7: a GAP followed by an unresolved FOLD shows the fold reason, not the stale gap reason', async () => {
    const h = harness();
    h.ui.dateInput.value = '2027-03-14'; h.ui.timeInput.value = '02:30'; h.ui.timeInput.dispatch('change');
    assert.strictEqual(h.ui.reason.textContent, COPY.nonexistentTime);
    h.ui.dateInput.value = '2026-11-01'; h.ui.timeInput.value = '01:30'; h.ui.timeInput.dispatch('change');
    assert.strictEqual(h.card._timeResolution(), 'fold');
    assert.strictEqual(h.ui.reason.textContent, COPY.ambiguousTime);
  });

  await check('#7: Save reads "Saving…" and is disabled from the FIRST await, matching the handler lock', async () => {
    let release = null;
    const gate = new Promise((r) => { release = r; });
    const h = harness();
    h.ui.dateInput.value = '2026-12-24'; h.ui.timeInput.value = '19:15'; h.ui.timeInput.dispatch('change'); await h.flush();
    h.app.unresolvedEnvelopeBlocks = async () => { await gate; return false; };
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.ui.save.disabled, true);
    assert.strictEqual(h.ui.save.textContent, COPY.saveBusy);
    assert.strictEqual(h.ui.paxEdit.disabled, true);
    h.ui.paxEdit.dispatch('click');   // reaches the handler despite disabled
    assert.strictEqual(h.ui.paxStepper.hidden, true, 'the disclosure handler refuses too');
    release(); await tap; await h.flush();
  });


  // ===== Codex seq:234 corrections — executed =====

  await check('#1 guest → self: tapping "Travel myself" AGAIN in the confirm sheet records the value-bound key and the save COMPLETES (one POST, account traveler)', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    sheetOf(h).find((n) => n.textContent === 'Travel myself')[0].click();
    await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1, 'the traveler change is priced');
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.card._sheetOpen(), true, 'the value-bound confirmation opened');
    assert.ok(sheetOf(h).textContent.includes('Confirm the traveler'));
    sheetOf(h).find((n) => n.textContent === 'Travel myself')[0].click();   // the obvious tap
    await tap; await h.flush();
    assert.strictEqual(h.card._sheetOpen(), false, 'the sheet closed');
    assert.strictEqual(h.calls.posts.length, 1, 'exactly one writer POST');
    assert.strictEqual(h.calls.posts[0].body.customerName, 'Andres Booker');
    assert.strictEqual(h.calls.posts[0].body.email, 'andres@example.com');
    assert.ok(h.calls.editSaved, 'the save completed');
  });

  await check('#1 guest → self: submitting the prefilled confirm FORM completes the same save (both confirm paths land)', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    sheetOf(h).find((n) => n.textContent === 'Travel myself')[0].click();
    await h.flush();
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    sheetOf(h).find((n) => n.tagName === 'FORM')[0].dispatch('submit');
    await tap; await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    assert.strictEqual(h.calls.posts[0].body.customerName, 'Andres Booker');
    assert.ok(h.calls.editSaved);
  });

  await check('#1 confirm sheet: choosing a DIFFERENT traveler inside confirmation is a change — the chain ends without a POST and the next tap re-confirms', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    sheetOf(h).find((n) => n.textContent === 'Travel myself')[0].click();
    await h.flush();
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    const inputs = sheetOf(h).find((n) => n.tagName === 'INPUT');
    inputs[0].value = 'Someone Else'; inputs[1].value = '+1 305 555 0002'; inputs[2].value = 'x@example.com';
    sheetOf(h).find((n) => n.tagName === 'FORM')[0].dispatch('submit');
    await tap; await h.flush();
    assert.strictEqual(h.calls.posts.length, 0, 'a change inside confirmation never posts');
    assert.strictEqual(h.card._draft().traveler.name, 'Someone Else');
    assert.strictEqual(h.card.isOpen(), true);
  });

  await check('#2 a TIME-only edit round-trips the stored airport label byte for byte (pickup mode: pickup = stored "Miami International")', async () => {
    const dto = guestEscaladeDto({ route: { ...guestEscaladeDto().route, pickupLabel: 'Miami International' } });
    const h = harness({ dto });
    assert.strictEqual(h.ui.routeText.textContent, 'Miami International → 4441 Collins Ave', 'the stored label is what the passenger reads');
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    assert.strictEqual(h.calls.posts[0].body.pickup, 'Miami International', 'never rewritten to the bare code');
    assert.strictEqual(h.calls.posts[0].body.dropoff, '4441 Collins Ave');
    assert.strictEqual(h.calls.posts[0].body.dateTime, '2026-12-25T00:15:00.000Z');
  });

  await check('#2 PASSENGER-only and TRAVELER-only edits keep the stored airport label too (dropoff mode: dropoff = stored " Palm Beach ", untrimmed)', async () => {
    const route = { ...guestEscaladeDto().route, bookingMode: 'dropoff', airportCode: 'PBI',
      pickupLabel: '4441 Collins Ave', dropoffLabel: 'Palm Beach' };
    const a = harness({ dto: guestEscaladeDto({ route }) });
    a.ui.paxEdit.click(); a.ui.paxPlus.click(); await a.flush();
    a.ui.save.click(); await a.flush();
    assert.strictEqual(a.calls.posts.length, 1);
    assert.strictEqual(a.calls.posts[0].body.pickup, '4441 Collins Ave');
    assert.strictEqual(a.calls.posts[0].body.dropoff, 'Palm Beach', 'verbatim stored text');
    assert.strictEqual(a.calls.posts[0].body.passengers, 4);
    const b = harness({ dto: guestEscaladeDto({ route }) });
    b.ui.travelerEdit.click();
    sheetOf(b).find((n) => n.textContent === 'Travel myself')[0].click();
    await b.flush();
    const tap = b.ui.save.click();
    await new Promise((r) => setImmediate(r));
    sheetOf(b).find((n) => n.textContent === 'Travel myself')[0].click();
    await tap; await b.flush();
    assert.strictEqual(b.calls.posts.length, 1);
    assert.strictEqual(b.calls.posts[0].body.dropoff, 'Palm Beach');
    assert.strictEqual(b.calls.posts[0].body.pickup, '4441 Collins Ave');
  });

  await check('#2 Where: an ADDRESS-only Done keeps the seeded stored airport label; a changed AIRPORT carries the host\'s display name', async () => {
    const dto = guestEscaladeDto({ route: { ...guestEscaladeDto().route, pickupLabel: 'Miami International' } });
    // the quote echoes the NEW canonical id (a 'ChIJ_stored' echo would collapse
    // the draft back to the snapshot tuple — the identity-equal restore rule)
    const a = harness({ dto, script: [{ status: 200, body: quoteResponse({ placeId: 'ChIJ_new' }) }] });
    a.ui.routeChange.click();
    assert.strictEqual(a.app._er.routeDraft.airportLabel, 'Miami International', 'the editor draft is seeded with the stored label');
    a.app._er.cbs.onDone({ ...a.app._er.routeDraft,
      address: { label: 'New hotel, Miami Beach', placeId: 'ChIJ_new', coordinates: null, attributions: [] } });
    await a.flush();
    assert.strictEqual(a.calls.quotes.length, 1);
    a.ui.save.click(); await a.flush();
    assert.strictEqual(a.calls.posts.length, 1);
    assert.strictEqual(a.calls.posts[0].body.pickup, 'Miami International', 'address-only change: the airport label is untouched');
    assert.strictEqual(a.calls.posts[0].body.dropoff, 'New hotel, Miami Beach');
    const b = harness({ dto });
    b.ui.routeChange.click();
    b.app._er.cbs.onDone({ ...b.app._er.routeDraft, airport: 'FLL', airportLabel: 'Fort Lauderdale' });
    await b.flush();
    b.ui.save.click(); await b.flush();
    assert.strictEqual(b.calls.posts.length, 1);
    assert.strictEqual(b.calls.posts[0].body.pickup, 'Fort Lauderdale', 'the new airport is stored under the same display name create uses');
    assert.strictEqual(b.calls.posts[0].body.dropoff, '4441 Collins Ave');
  });

  await check('#3 a ONE-vehicle hydrated card quotes and saves: the expected key set is the DTO\'s own, not create\'s three', async () => {
    const dto = guestEscaladeDto({ vehicles: [VEHICLE_ESCALADE] });
    const h = harness({ dto, script: [{ status: 200, body: quoteResponse({ keys: ['escalade'] }) }] });
    setTime(h); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 1);
    assert.strictEqual(h.ui.status.hidden, true, 'no incomplete refusal');
    assert.strictEqual(h.ui.save.disabled, false);
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    assert.strictEqual(h.calls.posts[0].body.vehicle, 'Cadillac Escalade');
    assert.strictEqual(h.calls.posts[0].body.price, 169);
    assert.ok(h.calls.editSaved);
  });

  await check('#3 a PARTIAL two-vehicle card saves; a quote whose keys differ from the hydrated card (either direction) is refused as incomplete — typed copy, Save unavailable, zero POSTs', async () => {
    const two = harness({ dto: guestEscaladeDto({ vehicles: [VEHICLE_TESLA, VEHICLE_ESCALADE] }),
      script: [{ status: 200, body: quoteResponse({ keys: ['escalade', 'tesla'] }) }] });
    setTime(two); await two.flush();
    two.ui.save.click(); await two.flush();
    assert.strictEqual(two.calls.posts.length, 1, 'partial card: saved');
    for (const [label, dto, keys] of [
      ['three-vehicle card, one-key quote', guestEscaladeDto(), ['escalade']],
      ['one-vehicle card, three-key quote', guestEscaladeDto({ vehicles: [VEHICLE_ESCALADE] }), ['escalade', 'sprinter', 'tesla']],
      ['two-vehicle card, a different pair', guestEscaladeDto({ vehicles: [VEHICLE_TESLA, VEHICLE_ESCALADE] }), ['escalade', 'sprinter']]
    ]) {
      const h = harness({ dto, script: [{ status: 200, body: quoteResponse({ keys }) }] });
      setTime(h); await h.flush();
      assert.strictEqual(h.calls.quotes.length, 1, `${label}: one call`);
      assert.strictEqual(h.ui.status.hidden, false, `${label}: refused`);
      assert.strictEqual(h.ui.status.textContent, COPY.quoteUnavailable, `${label}: typed incomplete copy`);
      assert.strictEqual(h.ui.save.disabled, true, `${label}: Save unavailable`);
      h.ui.save.click(); await h.flush();
      assert.strictEqual(h.calls.posts.length, 0, `${label}: nothing posted`);
    }
  });

  await check('#4 a writer requote whose refresh FAILS expires the held quote at once: Save reads "Refresh and Save"; a second tap refreshes FIRST and posts nothing while the refresh still fails; a later good refresh posts exactly once', async () => {
    const h = harness({ script: [
      { status: 200, body: quoteResponse() },
      { status: 502, body: { error: 'upstream' } },   // the sanctioned quiet refresh
      { status: 502, body: { error: 'upstream' } },   // the second tap's refresh
      { status: 200, body: quoteResponse() }          // the third tap's refresh
    ] });
    h.app._postScript = [{ status: 409, body: { error: 'quote_expired', requote: true } }];
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    assert.strictEqual(h.calls.quotes.length, 2);
    assert.strictEqual(h.card._held().expiresAt, 0, 'the refused token is expired the instant requote arrives');
    assert.strictEqual(h.ui.save.textContent, COPY.saveRefresh, 'never "Save changes" over a token the server rejected');
    assert.strictEqual(h.ui.save.disabled, false, 'the passenger can still act');
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 3, 'the second tap refreshed first');
    assert.strictEqual(h.calls.posts.length, 1, 'and posted NOTHING while the refresh still fails');
    assert.strictEqual(h.calls.editSaved, null);
    assert.strictEqual(h.ui.save.textContent, COPY.saveRefresh);
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.quotes.length, 4, 'third tap: refresh first');
    assert.strictEqual(h.calls.posts.length, 2, 'then exactly one POST on the fresh token');
    assert.ok(h.calls.editSaved, 'saved');
  });

  await check('#4 MUTATION: not expiring the held quote on requote leaves Save reading "Save changes" over the rejected token — the executed pin refuses it', async () => {
    const anchor = "        if (held) held.expiresAt = 0;\n        if (!resubmitUsedThisTap && !refreshUsedThisTap) {";
    assert.strictEqual(CARD_SRC.split(anchor).length - 1, 1, 'expire-on-requote anchor is unique');
    const mutant = loadCardSource(CARD_SRC.replace(anchor, "        if (!resubmitUsedThisTap && !refreshUsedThisTap) {"));
    const h = harness({ factory: mutant.createPendingEditCard, script: [
      { status: 200, body: quoteResponse() }, { status: 502, body: { error: 'upstream' } }, { status: 502, body: { error: 'upstream' } }
    ] });
    h.app._postScript = [{ status: 409, body: { error: 'quote_expired', requote: true } }];
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.ui.save.textContent, COPY.saveIdle, 'the mutant shows "Save changes" over the rejected token');
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 2, 'and re-posts the rejected token without refreshing — exactly the wasted writer call the fix removes');
  });

  await check('#5 pickup_time_elapsed: the envelope is STORED then CLEARED for exactly this operation before the refusal is classified; nothing is offered for recovery; the whole draft is preserved (quote state excepted)', async () => {
    const h = harness();
    h.app._postScript = [{ status: 400, body: { error: 'pickup_time_elapsed' } }];
    setTime(h); await h.flush();
    const before = JSON.stringify(h.card._draft());
    h.ui.save.click(); await h.flush();
    assert.deepStrictEqual(h.calls.stored, ['11111111-2222-4333-8444-555555555555'], 'exactly one envelope stored');
    assert.deepStrictEqual(h.calls.cleared, ['11111111-2222-4333-8444-555555555555'], 'the SAME operation cleared, exactly once, before the elapsed branch');
    assert.deepStrictEqual(h.calls.offered, [], 'a definitive refusal offers no recovery card');
    assert.strictEqual(JSON.stringify(h.card._draft()), before, 'the complete draft is untouched');
    assert.strictEqual(h.card._held(), null, 'the quote state is the one thing that changes');
    assert.strictEqual(h.ui.reason.textContent, COPY.elapsed);
    assert.strictEqual(h.ui.save.disabled, true);
  });

  await check('#5 MUTATION: an early elapsed return BEFORE the clear leaves the envelope stored — the exact-clear pin refuses it', async () => {
    const anchor = "      app.clearPendingEnvelope(operationId);\n      const { response, result } = out;\n";
    assert.strictEqual(CARD_SRC.split(anchor).length - 1, 1, 'clear-before-classify anchor is unique');
    const mutant = loadCardSource(CARD_SRC.replace(anchor,
      "      const { response, result } = out;\n      if (response.status === 400 && result && result.error === 'pickup_time_elapsed') { markElapsed(); return; }\n      app.clearPendingEnvelope(operationId);\n"));
    const h = harness({ factory: mutant.createPendingEditCard });
    h.app._postScript = [{ status: 400, body: { error: 'pickup_time_elapsed' } }];
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.deepStrictEqual(h.calls.stored, ['11111111-2222-4333-8444-555555555555']);
    assert.deepStrictEqual(h.calls.cleared, [], 'the mutant never clears — a stale envelope would then gate every later Book/Save');
  });

  await check('A11Y: the traveler dialog has an accessible name, focus enters its first usable control, Escape leaves like Back (nothing changes, zero quotes) and focus returns to the opener', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    const panel = sheetOf(h).find((n) => n.getAttribute('role') === 'dialog')[0];
    assert.ok(panel, 'role=dialog');
    assert.strictEqual(panel.getAttribute('aria-modal'), 'true');
    assert.strictEqual(panel.getAttribute('aria-labelledby'), 'peSheetTitle');
    assert.strictEqual(panel.find((n) => n.tagName === 'H3')[0].id, 'peSheetTitle', 'the name resolves to the visible title');
    const selfBtn = panel.find((n) => n.textContent === 'Travel myself')[0];
    assert.strictEqual(selfBtn.focused, true, 'focus entered the first usable control');
    h.doc.dispatch('keydown', { key: 'Escape' });   // document-level, wherever focus sits
    await h.flush();
    assert.strictEqual(h.card._sheetOpen(), false, 'Escape closed the sheet');
    assert.strictEqual(h.card._draft().traveler.name, 'Gina Guest', 'nothing changed');
    assert.strictEqual(h.calls.quotes.length, 0, 'Escape buys nothing');
    assert.strictEqual(h.ui.travelerEdit.focused, true, 'focus returned to the opener');
    // an account that cannot travel itself: focus enters the name field instead
    const amb = harness({ account: { name: 'Amb', phone: '+1 786 000 0000', email: 'a@example.com', ambassador: true } });
    amb.ui.travelerEdit.click();
    const p2 = sheetOf(amb).find((n) => n.getAttribute('role') === 'dialog')[0];
    assert.strictEqual(p2.find((n) => n.textContent === 'Travel myself')[0].disabled, true);
    assert.strictEqual(p2.find((n) => n.tagName === 'INPUT')[0].focused, true, 'focus enters the traveler name field');
  });

  await check('A11Y: Escape inside the value-bound CONFIRM sheet ends the save chain without a POST, returns focus to Save, and Save stays available for a new tap', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    sheetOf(h).find((n) => n.textContent === 'Travel myself')[0].click();
    await h.flush();
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    const panel = sheetOf(h).find((n) => n.getAttribute('role') === 'dialog')[0];
    h.doc.dispatch('keydown', { key: 'Escape' });   // document-level, wherever focus sits
    await tap; await h.flush();
    assert.strictEqual(h.calls.posts.length, 0, 'not confirmed → nothing posted');
    assert.strictEqual(h.card._sheetOpen(), false);
    assert.strictEqual(h.ui.save.disabled, false, 'a new tap re-confirms');
    assert.strictEqual(h.doc.activeElement, h.ui.save, 'focus lands on Save once the chain has released it (a disabled control cannot take focus)');
    assert.strictEqual(h.card._draft().traveler.name, 'Andres Booker', 'the pending self selection is kept in the draft');
  });

  await check('A11Y: repeated Change/Edit controls and the vehicle radiogroup carry contextual accessible names', async () => {
    const h = harness();
    assert.strictEqual(h.ui.routeChange.getAttribute('aria-label'), 'Change route');
    assert.strictEqual(h.ui.paxEdit.getAttribute('aria-label'), 'Edit passenger count');
    assert.strictEqual(h.ui.travelerEdit.getAttribute('aria-label'), 'Edit traveler');
    assert.strictEqual(h.ui.vehicleOptions.getAttribute('role'), 'radiogroup');
    assert.strictEqual(h.ui.vehicleOptions.getAttribute('aria-label'), 'Vehicle');
    assert.strictEqual(h.ui.vehicleToggle.textContent, 'Change vehicle', 'already contextual; toggles to Hide options');
  });


  // ===== second verification pass (adversarial refuters on 8cb3382) =====

  await check('#2 a TIME-only edit in DROPOFF mode round-trips the production-shaped stored airport label ("Palm Beach")', async () => {
    const route = { ...guestEscaladeDto().route, bookingMode: 'dropoff', airportCode: 'PBI',
      pickupLabel: '4441 Collins Ave', dropoffLabel: 'Palm Beach' };
    const h = harness({ dto: guestEscaladeDto({ route }) });
    assert.strictEqual(h.ui.routeText.textContent, '4441 Collins Ave → Palm Beach');
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.calls.posts.length, 1);
    assert.strictEqual(h.calls.posts[0].body.pickup, '4441 Collins Ave');
    assert.strictEqual(h.calls.posts[0].body.dropoff, 'Palm Beach');
    assert.strictEqual(h.calls.posts[0].body.dateTime, '2026-12-25T00:15:00.000Z');
  });

  await check('#3 every structural / per-vehicle rule of the edit validator is EXECUTED: each hostile quote shape is refused as incomplete with zero POSTs', async () => {
    const hostile = [
      ['vehicle ok is not boolean', (q) => { q.quote.vehicles.escalade.ok = 'yes'; }],
      ['ok vehicle without a token', (q) => { delete q.quote.vehicles.escalade.token; }],
      ['ok vehicle with a non-integer price', (q) => { q.quote.vehicles.escalade.finalCents = 169.5; }],
      ['ok vehicle with a negative price', (q) => { q.quote.vehicles.escalade.finalCents = -1; }],
      ['ok vehicle with an unparseable expiry', (q) => { q.quote.vehicles.escalade.expiresAt = 'soon'; }],
      ['vehiclesOk disagrees with the entries', (q) => { q.quote.vehiclesOk = 2; }],
      ['bookable disagrees with the entries', (q) => { q.quote.bookable = false; }],
      ['route minutes not an integer', (q) => { q.quote.route.minutes = 30.5; }],
      ['route milesTenths negative', (q) => { q.quote.route.milesTenths = -1; }],
      ['missing pricingVersion', (q) => { delete q.quote.pricingVersion; }],
      ['intent is an array', (q) => { q.quote.intent = []; }],
      ['vehicles is an array', (q) => { q.quote.vehicles = []; }],
      ['a vehicle entry that is null', (q) => { q.quote.vehicles.tesla = null; }]
    ];
    for (const [label, mutate] of hostile) {
      const q = quoteResponse(); mutate(q);
      const h = harness({ script: [{ status: 200, body: q }] });
      setTime(h); await h.flush();
      assert.strictEqual(h.calls.quotes.length, 1, `${label}: one call`);
      assert.strictEqual(h.ui.status.textContent, COPY.quoteUnavailable, `${label}: refused as incomplete`);
      assert.strictEqual(h.ui.save.disabled, true, `${label}: Save unavailable`);
      h.ui.save.click(); await h.flush();
      assert.strictEqual(h.calls.posts.length, 0, `${label}: nothing posted`);
    }
    // and an EMPTY hydrated card can never be satisfied (the expected set is empty)
    const empty = harness({ dto: guestEscaladeDto({ vehicles: [] }), script: [{ status: 200, body: quoteResponse({ keys: [] }) }] });
    setTime(empty); await empty.flush();
    assert.strictEqual(empty.ui.save.disabled, true, 'empty card: Save unavailable');
    assert.strictEqual(empty.calls.posts.length, 0);
  });

  await check('#3 MUTATIONS: dropping any one structural rule of the edit validator lets a hostile quote through — the executed matrix catches each', async () => {
    const rules = [
      ["typeof v.ok !== 'boolean'", 'vehicle ok is not boolean', (q) => { q.quote.vehicles.escalade.ok = 'yes'; }],
      ["typeof v.token !== 'string' || !v.token ||", 'ok vehicle without a token', (q) => { delete q.quote.vehicles.escalade.token; }],
      ['quote.vehiclesOk === vehiclesOk &&', 'vehiclesOk disagrees', (q) => { q.quote.vehiclesOk = 2; }],
      ["!Number.isFinite(Date.parse(v.expiresAt || ''))", 'unparseable expiry', (q) => { q.quote.vehicles.escalade.expiresAt = 'soon'; }]
    ];
    for (const [fragment, label, mutate] of rules) {
      const fnStart = CARD_SRC.indexOf('function editQuoteIsComplete(quote) {');
      const fnEnd = CARD_SRC.indexOf('\n    }\n', fnStart);
      const fn = CARD_SRC.slice(fnStart, fnEnd);
      assert.ok(fn.includes(fragment), `${label}: rule fragment present in editQuoteIsComplete`);
      let mutantFn;
      if (fragment === "typeof v.ok !== 'boolean'") mutantFn = fn.replace("if (!v || typeof v !== 'object' || typeof v.ok !== 'boolean') return false;", "if (!v || typeof v !== 'object') return false;");
      else if (fragment.startsWith('typeof v.token')) mutantFn = fn.replace("typeof v.token !== 'string' || !v.token ||\n", '');
      else if (fragment.startsWith('quote.vehiclesOk')) mutantFn = fn.replace('return quote.vehiclesOk === vehiclesOk && quote.bookable === (vehiclesOk > 0);', 'return quote.bookable === (vehiclesOk > 0);');
      else mutantFn = fn.replace(" ||\n          !Number.isFinite(Date.parse(v.expiresAt || ''))) return false;", ') return false;');
      assert.notStrictEqual(mutantFn, fn, `${label}: the mutant differs`);
      const mutant = loadCardSource(CARD_SRC.slice(0, fnStart) + mutantFn + CARD_SRC.slice(fnEnd));
      const q = quoteResponse(); mutate(q);
      const h = harness({ factory: mutant.createPendingEditCard, script: [{ status: 200, body: q }] });
      setTime(h); await h.flush();
      assert.notStrictEqual(h.ui.status.textContent, COPY.quoteUnavailable, `${label}: the mutant ACCEPTS the hostile quote — which the executed matrix above refuses`);
    }
  });

  await check('#5 ORDER: the envelope is stored, THEN the writer is called, THEN exactly that operation is cleared — and the stored envelope carries the full host contract', async () => {
    const h = harness();
    h.app._postScript = [{ status: 400, body: { error: 'pickup_time_elapsed' } }];
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    const id = '11111111-2222-4333-8444-555555555555';
    assert.deepStrictEqual(h.calls.seq, [`store:${id}`, 'post', `clear:${id}`], 'store → post → clear, in that order');
    const env = h.calls.storedEnvelopes[0];
    assert.strictEqual(env.kind, 'edit');
    assert.strictEqual(env.bookingId, BID);
    assert.strictEqual(env.authSubject, 'auth-a');
    assert.ok(Number.isFinite(env.createdAt), 'createdAt is a finite instant');
    assert.strictEqual(JSON.parse(env.bodyString).operationId, id, 'the operation id travels INSIDE the serialized body');
    assert.strictEqual(env.operationId, id);
  });

  await check('#5 MUTATION: relocating the clear to BEFORE the writer call is caught by the ordered sequence, not just by a source anchor', async () => {
    const store = "      if (!app.storePendingEnvelope(envelope)) { setReason(COPY.notSaved, true); return; }\n";
    const clear = "      app.clearPendingEnvelope(operationId);\n";
    assert.strictEqual(CARD_SRC.split(store).length - 1, 1); assert.strictEqual(CARD_SRC.split(clear).length - 1, 1);
    const mutant = loadCardSource(CARD_SRC.replace(clear, '').replace(store, store + clear));
    const h = harness({ factory: mutant.createPendingEditCard });
    h.app._postScript = [{ status: 400, body: { error: 'pickup_time_elapsed' } }];
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    const id = '11111111-2222-4333-8444-555555555555';
    assert.deepStrictEqual(h.calls.seq, [`store:${id}`, `clear:${id}`, 'post'], 'the mutant clears before posting — the ordered pin above refuses it');
  });

  await check('#5 NON-DEFINITIVE: an unknown writer result keeps the envelope (never cleared), offers it for recovery under the auth subject, and tells the passenger to use Check again', async () => {
    const h = harness();
    h.app._postScript = [{ definitive: false }];
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    const id = '11111111-2222-4333-8444-555555555555';
    assert.deepStrictEqual(h.calls.seq, [`store:${id}`, 'post', 'offer:auth-a'], 'store → post → offer; no clear');
    assert.deepStrictEqual(h.calls.cleared, []);
    assert.strictEqual(h.card.isOpen(), true, 'the draft stays');
    assert.ok(h.ui.reason.textContent.includes('Check again'), 'honest copy: use Check again');
    assert.strictEqual(h.calls.editSaved, null);
  });

  await check('A11Y: the traveler dialog CONTAINS keyboard focus — the card behind it is inert/aria-hidden, Tab and Shift+Tab cycle inside the panel, Escape works at document level, and everything is restored on close', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    assert.strictEqual(h.calls.mounted.getAttribute('aria-hidden'), 'true', 'the card is hidden from assistive tech while the sheet is open');
    assert.strictEqual(h.calls.mounted.inert, true, 'and inert');
    assert.strictEqual(h.doc.listenerCount('keydown'), 1, 'one document-level key handler');
    const panel = sheetOf(h).find((n) => n.getAttribute('role') === 'dialog')[0];
    const selfBtn = panel.find((n) => n.textContent === 'Travel myself')[0];
    const inputs = panel.find((n) => n.tagName === 'INPUT');
    const back = panel.find((n) => n.textContent === 'Back')[0];
    assert.strictEqual(h.doc.activeElement, selfBtn, 'focus entered the first usable control');
    h.doc.dispatch('keydown', { key: 'Tab' });
    assert.strictEqual(h.doc.activeElement, inputs[0], 'Tab → traveler name');
    h.doc.dispatch('keydown', { key: 'Tab', shiftKey: true });
    assert.strictEqual(h.doc.activeElement, selfBtn, 'Shift+Tab → back to Travel myself');
    h.doc.dispatch('keydown', { key: 'Tab', shiftKey: true });
    assert.strictEqual(h.doc.activeElement, back, 'Shift+Tab from the first control wraps to Back');
    h.doc.dispatch('keydown', { key: 'Tab' });
    assert.strictEqual(h.doc.activeElement, selfBtn, 'Tab from Back wraps to the first control');
    // focus that escaped the panel (e.g. a pointer) is pulled back in on the next Tab
    ACTIVE_EL = h.ui.routeChange;
    h.doc.dispatch('keydown', { key: 'Tab' });
    assert.strictEqual(h.doc.activeElement, selfBtn, 'Tab from outside the panel lands on its first control');
    h.doc.dispatch('keydown', { key: 'Escape' });
    await h.flush();
    assert.strictEqual(h.card._sheetOpen(), false, 'document-level Escape closes the sheet');
    assert.strictEqual(h.calls.mounted.getAttribute('aria-hidden'), undefined, 'aria-hidden removed');
    assert.strictEqual(h.calls.mounted.inert, false, 'inert cleared');
    assert.strictEqual(h.doc.listenerCount('keydown'), 0, 'the key handler is removed');
    assert.strictEqual(h.doc.activeElement, h.ui.travelerEdit, 'focus returned to the opener (enabled in edit mode)');
    assert.strictEqual(h.calls.quotes.length, 0);
  });

  await check('A11Y: confirm-sheet closes return focus to Save only once the chain has re-enabled it (self tap → Save proceeds → success closes the card; Escape → Save focused)', async () => {
    const h = harness();
    h.ui.travelerEdit.click();
    sheetOf(h).find((n) => n.textContent === 'Travel myself')[0].click();
    await h.flush();
    const tap = h.ui.save.click();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.ui.save.disabled, true, 'Save is disabled for the life of the claimed chain');
    sheetOf(h).find((n) => n.textContent === 'Travel myself')[0].click();
    assert.notStrictEqual(h.doc.activeElement, h.ui.save, 'a disabled Save cannot take focus at close time');
    await tap; await h.flush();
    assert.strictEqual(h.calls.posts.length, 1, 'the save went through');
    assert.strictEqual(h.card.isOpen(), false, 'success closed the card — no focus juggling on a torn-down card');
  });

  await check('A11Y: an elapsed refusal inside the chain focuses the time input only after the chain re-enables it', async () => {
    const h = harness();
    h.app._postScript = [{ status: 400, body: { error: 'pickup_time_elapsed' } }];
    setTime(h); await h.flush();
    h.ui.save.click(); await h.flush();
    assert.strictEqual(h.ui.timeInput.disabled, false, 'the chain has ended');
    assert.strictEqual(h.doc.activeElement, h.ui.timeInput, 'focus landed on the time input once it was enabled');
    assert.strictEqual(h.ui.reason.textContent, COPY.elapsed);
  });

  console.log(`\n  ${failed ? `${failed} CHECK(S) FAILED` : `ALL ${passed} CHECKS PASS`}\n`);
  process.exit(failed ? 1 : 0);
})();
