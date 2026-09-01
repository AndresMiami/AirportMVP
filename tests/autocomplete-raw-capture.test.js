// Milestone A — raw-query capture, fully dark (address plan v3 §Milestone A).
//
// Run: node tests/autocomplete-raw-capture.test.js
//
// The passenger's typed text ("fonta") is destroyed the moment a suggestion is
// selected: applySelection overwrites the input with Google's address. Plan v3
// requires the snapshot to be taken SYNCHRONOUSLY at selectSuggestion entry,
// bound to that selection's sequence, published only when that selection wins,
// and cleared by typing and by reset. It must stay in page memory: no payload,
// storage, UI, API or database change.
//
// These tests run the REAL class under `vm` with a stub DOM and drive the
// actual async selection flow. They are written to KILL the mutations the plan
// names: a capture moved after the Details await (or after applySelection)
// reads Google's address instead of the typed text and fails here; an
// unconditional entry-time publish survives a failed selection and fails here.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'autocomplete.js'), 'utf8');

function makeContext() {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    debug: { log() {}, warn() {}, error() {}, success() {} },
    document: { getElementById: () => null },
    window: {},
    CustomEvent: class CustomEvent {
      constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; }
    },
    URLSearchParams,
    AbortController,
    setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    fetch: async () => { throw new Error('test forgot to stub fetch'); },
    fetchedUrls: [],
    Date, Math, JSON, Object, Array, String, Number, Promise, Error, Uint8Array,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    source.replace(/^export class /m, 'class ') + '\n;globalThis.__C = CustomAutocomplete;',
    ctx,
    { filename: 'autocomplete.js' }
  );
  return ctx;
}

function el() {
  const listeners = {};
  return {
    value: '',
    innerHTML: '',
    dataset: {},
    dispatched: [],
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      toggle(c, v) { v ? this.set.add(c) : this.set.delete(c); },
      contains(c) { return this.set.has(c); },
    },
    addEventListener(t, f) { (listeners[t] || (listeners[t] = [])).push(f); },
    dispatchEvent(ev) {
      this.dispatched.push(ev);
      (listeners[ev.type] || []).forEach((f) => f(ev));
      return true;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}

// A Details response the success path accepts end to end.
const GOOGLE_ADDRESS = '4441 Collins Ave, Miami Beach, FL 33140, USA';
function okDetails() {
  return {
    ok: true,
    json: async () => ({
      attributions: [],
      result: {
        formatted_address: GOOGLE_ADDRESS,
        geometry: { location: { lat: 25.8178, lng: -80.1227 } },
      },
    }),
  };
}

// Install a fetch stub that RECORDS every requested URL before answering.
// The network regression asserts against these recorded URLs — the real
// requests the code made — not against source text.
function stubFetch(ctx, impl) {
  ctx.fetch = async (url, opts) => {
    ctx.fetchedUrls.push(String(url));
    return impl(url, opts);
  };
}

function build(ctx) {
  const input = el();
  const sugg = el();
  const inst = new ctx.__C(input, sugg, null);
  return { inst, input, sugg };
}

const PREDICTION = { place_id: 'ChIJtestFONTAINEBLEAU00', description: 'Fontainebleau Miami Beach, Collins Avenue' };

let checks = 0;
const results = [];
async function check(name, fn) {
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

(async () => {
  console.log('\nMilestone A — raw-query capture\n');

  await check('constructor starts with no published raw query', () => {
    const ctx = makeContext();
    const { inst } = build(ctx);
    assert.strictEqual(inst.rawQuery, null);
  });

  await check('the snapshot is taken at ENTRY: a value mutated during the Details await never reaches rawQuery', async () => {
    // Kills the "capture after Details" and "capture after applySelection"
    // mutations: both would read MUTATED or Google's address, never "fonta".
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    stubFetch(ctx, () => {
      input.value = 'MUTATED-DURING-FETCH';
      return okDetails();
    });
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'fonta', 'rawQuery must be the pre-await typed text');
    assert.strictEqual(input.value, GOOGLE_ADDRESS, 'applySelection still overwrites the input');
    assert.notStrictEqual(inst.rawQuery, GOOGLE_ADDRESS);
  });

  await check('the snapshot is trimmed', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = '   fonta  ';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'fonta');
  });

  await check('a selection that LOSES to typing publishes nothing', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    let release;
    const gate = new Promise((r) => { release = r; });
    stubFetch(ctx, async () => { await gate; return okDetails(); });
    const inFlight = inst.selectSuggestion(0);
    // Passenger keeps typing while Details is in flight: the selection dies.
    input.value = 'fo';
    await inst.handleInput({ target: input });
    release();
    await inFlight;
    assert.strictEqual(inst.rawQuery, null, 'a dead selection must not publish its snapshot');
    assert.strictEqual(inst.selectedPlace, null);
  });

  await check('a newer selection wins: the stale one cannot overwrite its snapshot', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION, { place_id: 'ChIJtestSETAI0000000000', description: 'The Setai, Collins Avenue' }];
    let releaseFirst;
    const firstGate = new Promise((r) => { releaseFirst = r; });
    let call = 0;
    stubFetch(ctx, async () => {
      call++;
      if (call === 1) { await firstGate; return okDetails(); }
      return okDetails();
    });
    input.value = 'first typed';
    const first = inst.selectSuggestion(0);
    input.value = 'second typed';
    await inst.selectSuggestion(1);
    assert.strictEqual(inst.rawQuery, 'second typed');
    releaseFirst();
    await first;
    assert.strictEqual(inst.rawQuery, 'second typed', 'the stale selection must not clobber the winner');
  });

  await check('the prediction-fallback path (Details fails) still publishes the snapshot', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    stubFetch(ctx, () => ({ ok: false, json: async () => ({}) }));
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'fonta');
    assert.strictEqual(inst.selectedPlace.place_id, PREDICTION.place_id);
    assert.strictEqual(input.value, PREDICTION.description, 'fallback shows the prediction description');
  });

  await check('a selection that fails COMPLETELY publishes nothing', async () => {
    // Kills the "publish unconditionally at entry" mutation: nothing was
    // selected, so no snapshot may stand.
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [{ place_id: PREDICTION.place_id, description: '' }];
    input.value = 'fonta';
    stubFetch(ctx, () => ({ ok: false, json: async () => ({}) }));
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, null, 'no selection happened, so no snapshot may be published');
    assert.strictEqual(inst.selectedPlace, null);
  });

  await check('typing after a successful selection clears the snapshot', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'fonta');
    input.value = 'fo';
    await inst.handleInput({ target: input });
    assert.strictEqual(inst.rawQuery, null);
  });

  await check('typing clears the snapshot even when validation state is out of sync (defense in depth)', async () => {
    // Today every publish also sets isValidated, so typing routes through
    // clearValidation and this line is redundant. It stays because the
    // invariant ("typed text never survives as a published snapshot") must
    // not depend on a future refactor of clearValidation remembering it.
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.rawQuery = 'stale-from-a-future-code-path';
    inst.isValidated = false;
    input.value = 'fo';
    await inst.handleInput({ target: input });
    assert.strictEqual(inst.rawQuery, null);
  });

  await check('reset (clearValidation) clears the snapshot', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'fonta');
    inst.clearValidation();
    assert.strictEqual(inst.rawQuery, null);
  });

  await check('DARK: the events and selectedPlace carry exactly the pre-Milestone-A shapes', async () => {
    // The capture must not leak into anything observable: same event names,
    // same detail keys, same selectedPlace keys as before this change.
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    const types = input.dispatched.map((e) => e.type);
    assert.deepStrictEqual(types, ['place-selected', 'place-coordinates']);
    assert.deepStrictEqual(Object.keys(input.dispatched[0].detail).sort(), ['description', 'placeId']);
    assert.deepStrictEqual(Object.keys(input.dispatched[1].detail).sort(), ['address', 'lat', 'lng']);
    assert.deepStrictEqual(Object.keys(inst.selectedPlace).sort(), ['description', 'place_id']);
    const serialized = JSON.stringify(input.dispatched.map((e) => e.detail)) + JSON.stringify(inst.selectedPlace);
    assert.ok(!serialized.includes('fonta'), 'the raw query must not appear in any event or selection object');
  });

  await check('RESET RACE: reset while Details is IN FLIGHT — the late response can neither republish nor restore', async () => {
    // Codex round-1 blocker, reproduced before fixing: clearValidation used
    // to leave the sequence untouched, so a Details response landing after a
    // reset passed the winner guard and restored rawQuery, selectedPlace and
    // the cancelled address into a form the passenger had just cleared.
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    let release;
    const gate = new Promise((r) => { release = r; });
    stubFetch(ctx, async () => { await gate; return okDetails(); });
    const inFlight = inst.selectSuggestion(0);
    input.value = '';
    inst.clearValidation();            // the real reset path (indexMVP:1133)
    release();
    await inFlight;
    assert.strictEqual(inst.rawQuery, null, 'late success must not republish the snapshot');
    assert.strictEqual(inst.selectedPlace, null, 'late success must not restore the selection');
    assert.notStrictEqual(input.value, GOOGLE_ADDRESS, 'late success must not restore the cancelled address');
  });

  await check('RESET RACE, fallback path: a failing Details resolving after reset also publishes nothing', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    let release;
    const gate = new Promise((r) => { release = r; });
    stubFetch(ctx, async () => { await gate; return { ok: false, json: async () => ({}) }; });
    const inFlight = inst.selectSuggestion(0);
    input.value = '';
    inst.clearValidation();
    release();
    await inFlight;
    assert.strictEqual(inst.rawQuery, null);
    assert.strictEqual(inst.selectedPlace, null);
    assert.notStrictEqual(input.value, PREDICTION.description, 'the fallback must not restore the prediction text either');
  });

  await check('NEW SELECTION clears the prior snapshot IMMEDIATELY, before its outcome is known', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION, { place_id: 'ChIJtestSETAI0000000000', description: 'The Setai, Collins Avenue' }];
    input.value = 'first typed';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'first typed');
    // Begin selection B but hold its Details open: the OLD snapshot must be
    // gone the moment B starts, not when B settles.
    let release;
    const gate = new Promise((r) => { release = r; });
    stubFetch(ctx, async () => { await gate; return okDetails(); });
    // applySelection cleared the suggestion list (real behaviour); the second
    // selection needs a live prediction, as it would after fresh typing.
    inst.predictions = [PREDICTION, { place_id: 'ChIJtestSETAI0000000000', description: 'The Setai, Collins Avenue' }];
    input.value = 'second typed';
    const inFlight = inst.selectSuggestion(1);
    assert.strictEqual(inst.rawQuery, null, 'the prior snapshot must not outlive the start of a new selection');
    release();
    await inFlight;
    assert.strictEqual(inst.rawQuery, 'second typed');
  });

  await check('a PRIOR snapshot does not survive a new selection that fails COMPLETELY', async () => {
    // Codex round-1 boundary 2, exact case: old published value, new
    // selection with no usable prediction — the old text must not stand
    // attached to a context it never described.
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION, { place_id: PREDICTION.place_id, description: '' }];
    input.value = 'first typed';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'first typed');
    stubFetch(ctx, () => ({ ok: false, json: async () => ({}) }));
    inst.predictions = [PREDICTION, { place_id: PREDICTION.place_id, description: '' }];
    input.value = 'second typed';
    await inst.selectSuggestion(1);
    assert.strictEqual(inst.rawQuery, null, 'neither the old nor the new text may stand after a total failure');
  });

  await check('EDIT ENTRY: invalidateRawCapture drops the snapshot and kills an in-flight selection, form state untouched', async () => {
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    assert.strictEqual(inst.rawQuery, 'fonta');
    const visibleBefore = input.value;
    inst.invalidateRawCapture();
    assert.strictEqual(inst.rawQuery, null);
    assert.strictEqual(input.value, visibleBefore, 'raw-state only: the visible form must be preserved');
    assert.ok(inst.selectedPlace, 'raw-state only: the validated selection must be preserved');
    // And it must kill a race too: an in-flight selection started before the
    // edit entry cannot publish afterwards.
    let release;
    const gate = new Promise((r) => { release = r; });
    stubFetch(ctx, async () => { await gate; return okDetails(); });
    input.value = 'stale before edit';
    const inFlight = inst.selectSuggestion(0);
    inst.invalidateRawCapture();
    release();
    await inFlight;
    assert.strictEqual(inst.rawQuery, null, 'an in-flight selection must not publish across an edit boundary');
  });

  await check('EDIT ENTRY is wired: beginPendingEdit invalidates raw capture before any edit work', () => {
    const indexSource = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
    const start = indexSource.indexOf('beginPendingEdit({ bookingId');
    assert.ok(start > 0, 'beginPendingEdit must exist');
    const body = indexSource.slice(start, start + 2400);
    // The call must be optional-chained on BOTH the object and the METHOD:
    // network-first + cache fallback means new HTML can briefly pair with an
    // older cached autocomplete.js, and edit mode must not throw then.
    assert.ok(/this\.autocomplete\?\.invalidateRawCapture\?\.\(\)/.test(body),
      'beginPendingEdit must invalidate raw-capture via the mixed-version-safe guarded call');
  });

  await check('NETWORK: the real Details request carries EXACTLY place_id and sessiontoken — never the raw query', async () => {
    // Codex round-1 boundary 4: the old check inspected constructor source
    // text, and a params.set('raw_query', ...) added AFTER construction
    // passed all checks. This asserts on the URL the code actually fetched.
    const ctx = makeContext();
    const { inst, input } = build(ctx);
    inst.predictions = [PREDICTION];
    input.value = 'fonta';
    stubFetch(ctx, () => okDetails());
    await inst.selectSuggestion(0);
    assert.strictEqual(ctx.fetchedUrls.length, 1, 'exactly one Details request');
    const url = new URL(ctx.fetchedUrls[0]);
    assert.deepStrictEqual([...url.searchParams.keys()].sort(), ['place_id', 'sessiontoken'],
      'the Details request may carry exactly these two parameters');
    assert.strictEqual(url.searchParams.get('place_id'), PREDICTION.place_id);
    for (const [k, v] of url.searchParams) {
      assert.ok(!v.includes('fonta'), `parameter ${k} must not carry the raw query`);
    }
  });

  await check('DARK: the module still never touches browser storage', () => {
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source),
      'Milestone A must not introduce browser storage');
  });

  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})();
