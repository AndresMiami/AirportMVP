// Curated cruise terminals — the address dropdown.
//
// Run: node tests/curated-autocomplete.test.js
//
// Runs the REAL autocomplete.js (ES module, loaded into a vm context like
// tests/google-policy-readiness.test.js) with the real js/curated-places.js
// and Google prediction shapes captured live on 2026-10-26 for the LM-EFFA
// queries. The rules under test: curated rows render immediately from the
// text alone and sit ABOVE Google's rows; a slow, empty or failed Google
// answer never erases them; clicks/Enter resolve against ONE visible list;
// selecting a terminal carries the registry place ID and LinkMia's label,
// while the selection events keep exactly today's shapes.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const TERMINAL_V_ID = 'ChIJO1Q7bLK12YgRyjFe2sYTfNc';
const TERMINAL_V_LABEL = 'PortMiami Terminal V, 718 N Cruise Blvd, Miami, FL 33132';
const REGISTRY_URL = '/data/curated-places.json?v=1';

// Google Places Autocomplete, via the Railway proxy, 2026-10-26.
const GOOGLE_VIRGIN = [   // input "Virgin": no Virgin Voyages result at all
  { place_id: 'ChIJTf9nSq-12YgR1Syw-fraj8o', description: 'Virginia Key, Florida, USA', structured_formatting: { main_text: 'Virginia Key', secondary_text: 'Florida, USA' } },
  { place_id: 'ChIJAwREDPW52YgR2qG-XNhMqnM', description: 'Virginia Gardens, FL, USA', structured_formatting: { main_text: 'Virginia Gardens', secondary_text: 'FL, USA' } },
  { place_id: 'ChIJzbK8vXDWTIgRlaZGt0lBTsA', description: 'Virginia, USA', structured_formatting: { main_text: 'Virginia', secondary_text: 'USA' } }
];
const GOOGLE_VIRGIN_VOYAGE = [   // input "Virgin voyage": brand result, Plantation office, then Terminal V
  { place_id: 'ChIJh8T1SwC12YgRCr9Mz-5L6MA', description: 'Virgin Voyages, Miami, FL, USA', structured_formatting: { main_text: 'Virgin Voyages', secondary_text: 'Miami, FL, USA' } },
  { place_id: 'ChIJZb6cGlIH2YgRhX7nd38X8lQ', description: 'Virgin Voyages, South Pine Island Road, Plantation, FL, USA', structured_formatting: { main_text: 'Virgin Voyages', secondary_text: 'South Pine Island Road, Plantation, FL, USA' } },
  { place_id: TERMINAL_V_ID, description: 'Terminal V - Virgin Voyages., North Cruise Boulevard, Miami, FL, USA', structured_formatting: { main_text: 'Terminal V - Virgin Voyages.', secondary_text: 'North Cruise Boulevard, Miami, FL, USA' } }
];

function registryRaw(overrides = {}) {
  return {
    version: 1,
    port: { name: 'PortMiami', keywords: ['portmiami', 'port miami', 'cruise port'] },
    companies: [
      { key: 'virgin', name: 'Virgin Voyages', keywords: ['virgin', 'virgin voyages', 'virgin voyage'] },
      { key: 'royal-caribbean', name: 'Royal Caribbean', keywords: ['royal'] },
      { key: 'celebrity', name: 'Celebrity Cruises', keywords: ['celebrity'] }
    ],
    terminals: [
      { id: 'pom-terminal-v', name: 'PortMiami Terminal V', address: '718 N Cruise Blvd, Miami, FL 33132',
        placeId: TERMINAL_V_ID, companies: ['virgin'], keywords: ['terminal v'], source: 'test', verifiedAt: '2026-10-26' },
      { id: 'pom-terminal-a', name: 'PortMiami Terminal A', address: '1 Terminal A Way, Miami, FL 33132',
        placeId: 'ChIJfixtureTerminalA000', companies: ['royal-caribbean', 'celebrity'], keywords: ['terminal a'], source: 'test', verifiedAt: '2026-10-26' }
    ],
    ...overrides
  };
}

function classList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach((item) => values.add(item)),
    remove: (...items) => items.forEach((item) => values.delete(item)),
    toggle: (item, force) => {
      if (force === true) values.add(item);
      else if (force === false) values.delete(item);
      else if (values.has(item)) values.delete(item);
      else values.add(item);
      return values.has(item);
    },
    contains: (item) => values.has(item)
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const addressError = { classList: classList() };
const documentStub = {
  getElementById: (id) => (id === 'addressError' ? addressError : null),
  createElement: (tag) => {
    let text = '';
    return {
      tagName: String(tag || 'div').toUpperCase(),
      className: '',
      childNodes: [],
      appendChild(child) { this.childNodes.push(child); return child; },
      remove() { this.removed = true; },
      set textContent(value) { text = String(value); },
      get textContent() { return text; },
      get innerHTML() { return escapeHtml(text); }
    };
  },
  createTextNode: (value) => ({ text: String(value) })
};

const ctx = {
  console: { log() {}, warn() {}, error() {} },
  debug: new Proxy({}, { get: () => () => {} }),
  document: documentStub,
  window: {},
  crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  AbortController, URL, URLSearchParams, Uint8Array, Set, Array, Math, Date, String, Number, JSON, Object, Promise,
  setTimeout, clearTimeout,
  fetch: undefined
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('js/curated-places.js'), ctx, { filename: 'curated-places.js' });
vm.runInContext(
  read('autocomplete.js').replace(/^export class /m, 'class ') + '\n;globalThis.__Autocomplete = CustomAutocomplete;',
  ctx,
  { filename: 'autocomplete.js' }
);

// A container whose querySelectorAll('.suggestion-item') reflects what was
// rendered, so keyboard navigation and highlighting run for real.
function makeContainer() {
  const container = {
    innerHTML: '',
    classList: classList(),
    querySelectorAll(selector) {
      if (selector !== '.suggestion-item') return [];
      const matches = container.innerHTML.match(/class="suggestion-item[^"]*" data-index="(\d+)"/g) || [];
      container.items = matches.map((m) => ({
        classList: classList(),
        dataset: { index: /data-index="(\d+)"/.exec(m)[1] },
        addEventListener() {}
      }));
      return container.items;
    }
  };
  return container;
}

// { registry: 'ready' | 'pending' | 'invalid' | 'fail' } controls the
// registry fetch; `release()` resolves a pending one.
function makeAutocomplete({ registry = 'ready' } = {}) {
  const registryFetches = [];
  let release = null;
  ctx.fetch = async (url, options) => {
    registryFetches.push({ url, options });
    if (registry === 'fail') throw new Error('offline');
    if (registry === 'invalid') return { ok: true, json: async () => ({ version: 'nope' }) };
    const payload = { ok: true, json: async () => registryRaw() };
    if (registry === 'pending') return new Promise((resolve) => { release = () => resolve(payload); });
    return payload;
  };
  const attributionClasses = classList();
  const selectedAttribution = { classList: attributionClasses, querySelector: () => null, appendChild() {} };
  const dispatched = [];
  const input = {
    value: '',
    classList: classList(),
    closest: () => ({ querySelector: () => selectedAttribution }),
    dispatchEvent: (event) => dispatched.push(event),
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
  const container = makeContainer();
  addressError.classList.remove('visible');
  const instance = new ctx.__Autocomplete(input, container, null);
  const detailsCalls = [];
  instance.fetchWithTimeout = async (url) => {
    detailsCalls.push(url);
    throw new Error('no provider in this test');   // each check overrides as needed
  };
  return {
    instance, input, container, selectedAttribution, dispatched, detailsCalls, registryFetches,
    release: () => release && release(),
    ready: () => instance.curatedLoad || Promise.resolve()
  };
}

function rows(container) {
  const out = [];
  const re = /<div class="suggestion-item([^"]*)" data-index="(\d+)"(?: data-terminal="([^"]*)")?>[\s\S]*?<div class="suggestion-main">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(container.innerHTML)) !== null) {
    out.push({ curated: m[1].includes('--curated'), index: Number(m[2]), terminal: m[3] || null, main: m[4] });
  }
  return out;
}
const logos = (container) => (container.innerHTML.match(/class="google-maps-attribution"/g) || []).length;
// Objects built inside the vm context carry that realm's prototypes, which
// deepStrictEqual rejects; compare plain copies (key order included).
const plain = (value) => JSON.parse(JSON.stringify(value));
const typed = (instance, input, value) => { input.value = value; instance.handleInput({ target: input }); };

let passed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name}`);
  } catch (error) {
    results.push(`  ✗ ${name}\n      ${error.message}`);
    results.forEach((line) => console.log(line));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

(async () => {
  console.log('\nCurated cruise terminals — the address dropdown\n');

  await check('the registry is fetched once at construction, at the exact precached URL, and the dropdown stays closed', async () => {
    const t = makeAutocomplete();
    await t.ready();
    assert.deepStrictEqual(t.registryFetches.map((f) => f.url), [REGISTRY_URL]);
    assert.ok(t.instance.curatedRegistry, 'registry validated and kept');
    assert.strictEqual(t.container.innerHTML, '');
    assert.strictEqual(t.container.classList.contains('visible'), false);
  });

  await check('typing "Virgin" renders Terminal V IMMEDIATELY — before any Google request, with no Google logo', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    const list = rows(t.container);
    assert.deepStrictEqual(list, [{ curated: true, index: 0, terminal: 'pom-terminal-v', main: 'Virgin Voyages' }]);
    assert.ok(t.container.innerHTML.includes('<div class="curated-initials" aria-hidden="true">VV</div>'));
    assert.ok(t.container.innerHTML.includes('<div class="suggestion-secondary">PortMiami</div>'));
    assert.ok(t.container.innerHTML.includes('<span class="suggestion-terminal">Terminal V</span>'));
    assert.ok(!t.container.innerHTML.includes('718 N Cruise Blvd'), 'the full address is not crowded into the suggestion');
    assert.strictEqual(t.instance.curatedRows[0].label, TERMINAL_V_LABEL, 'the full address still travels with the selection');
    assert.strictEqual(logos(t.container), 0);
    assert.ok(!t.container.innerHTML.includes('Loading'), 'no Google request has started yet');
    assert.strictEqual(t.container.classList.contains('visible'), true);
    assert.strictEqual(t.detailsCalls.length, 0);
    assert.strictEqual(t.instance.debounceTimer !== null, true, 'Google is still requested, after the debounce');
    clearTimeout(t.instance.debounceTimer);
  });

  await check('Google loading, then Google results, slot in BELOW Terminal V with re-numbered rows and one logo after them', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.showLoading();
    assert.strictEqual(rows(t.container)[0].terminal, 'pom-terminal-v', 'curated row survives the loading state');
    assert.ok(t.container.innerHTML.includes('Loading...'));
    assert.ok(t.container.innerHTML.indexOf('pom-terminal-v') < t.container.innerHTML.indexOf('Loading...'));
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    const list = rows(t.container);
    assert.deepStrictEqual(list.map((r) => [r.index, r.curated, r.main]), [
      [0, true, 'Virgin Voyages'],
      [1, false, 'Virginia Key'],
      [2, false, 'Virginia Gardens'],
      [3, false, 'Virginia']
    ]);
    assert.strictEqual(logos(t.container), 1);
    assert.ok(t.container.innerHTML.lastIndexOf('Virginia') < t.container.innerHTML.indexOf('google-maps-attribution'));
    assert.strictEqual(t.instance.predictions.length, 3);
    assert.ok(!t.container.innerHTML.includes('Loading...'));
  });

  await check('"Virgin voyage": the brand result and the Plantation office sit below Terminal V; Google\'s list stays intact, so Google\'s own Terminal V row remains further down', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin voyage');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions(GOOGLE_VIRGIN_VOYAGE);
    const list = rows(t.container);
    assert.strictEqual(list[0].terminal, 'pom-terminal-v');
    assert.deepStrictEqual(list.slice(1).map((r) => r.main), ['Virgin Voyages', 'Virgin Voyages', 'Terminal V - Virgin Voyages.']);
    assert.strictEqual(t.instance.predictions.length, 3, 'nothing of Google\'s is omitted');
    assert.strictEqual(t.instance.visibleItems()[3].prediction.place_id, TERMINAL_V_ID, 'the same place, in Google\'s own words, stays selectable below');
    const html = t.container.innerHTML;
    assert.ok(html.includes('suggestion-group-label'), 'LinkMia rows are captioned');
    assert.ok(html.indexOf('suggestion-group-label') < html.indexOf('suggestion-item--curated'), 'the caption sits above the LinkMia rows');
    assert.ok(html.includes('LinkMia terminals'));
    assert.ok(html.indexOf('Google suggestions') > html.indexOf('suggestion-terminal'));
    assert.ok(html.indexOf('Google suggestions') < html.indexOf('data-index="1"'));
  });

  await check('all seven company designs render their own initials and terminal choices; selecting each preserves its full identity', async () => {
    // This suite checks presentation/selection. Terminal assignments belong
    // to the registry and its coverage suite, so read the current mapping.
    const registry = JSON.parse(read('data/curated-places.json'));
    const cases = [
      ['Virgin', 'virgin', 'Virgin Voyages', 'VV'],
      ['Carnival', 'carnival', 'Carnival', 'C'],
      ['Royal', 'royal-caribbean', 'Royal Caribbean', 'RC'],
      ['NCL', 'norwegian', 'Norwegian', 'NCL'],
      ['Celebrity', 'celebrity', 'Celebrity', 'CC'],
      ['MSC', 'msc', 'MSC Cruises', 'MSC'],
      ['Disney', 'disney', 'Disney Cruise Line', 'D']
    ];
    for (const [query, theme, name, initials] of cases) {
      const terminals = registry.terminals.filter((terminal) => terminal.verifiedAt && terminal.companies.includes(theme));
      assert.ok(terminals.length > 0, `${query} has a verified registry choice`);
      const t = makeAutocomplete();
      await t.ready();
      t.instance.curatedRegistry = ctx.CuratedPlaces.validateRegistry(registry).registry;
      typed(t.instance, t.input, query);
      clearTimeout(t.instance.debounceTimer);
      assert.deepStrictEqual(rows(t.container).map((r) => r.main), terminals.map(() => name), query);
      assert.ok(t.container.innerHTML.includes(`curated-brand--${theme}`));
      assert.ok(t.container.innerHTML.includes(`aria-hidden="true">${initials}</div>`));
      assert.deepStrictEqual([...t.container.innerHTML.matchAll(/class="suggestion-terminal">([^<]+)/g)].map((m) => m[1]), terminals.map((terminal) => terminal.name.replace(registry.port.name + ' ', '')));
      assert.deepStrictEqual(plain(t.instance.curatedRows.map((row) => row.placeId)), terminals.map((terminal) => terminal.placeId));
      const choices = [...t.instance.curatedRows];
      for (let i = 0; i < choices.length; i++) {
        typed(t.instance, t.input, query);
        clearTimeout(t.instance.debounceTimer);
        await t.instance.selectSuggestion(i);
        assert.strictEqual(t.instance.selectedPlace.place_id, choices[i].placeId);
        assert.strictEqual(t.input.value, choices[i].label);
      }
    }
  });

  await check('without Object.hasOwn, typing still renders curated rows and arms the Google search', async () => {
    // A fresh realm avoids deleting the host Node process's built-in.
    const originalObject = ctx.Object;
    ctx.Object = vm.runInNewContext('Object');
    delete ctx.Object.hasOwn;
    let t;
    try {
      assert.strictEqual(typeof ctx.Object.hasOwn, 'undefined');
      t = makeAutocomplete();
      await t.ready();
      typed(t.instance, t.input, 'Virgin');
      assert.strictEqual(rows(t.container)[0].main, 'Virgin Voyages');
      assert.ok(t.instance.debounceTimer, 'the missing built-in cannot prevent the Google debounce');
      clearTimeout(t.instance.debounceTimer);
      t.instance.renderSuggestions(GOOGLE_VIRGIN);
      assert.strictEqual(rows(t.container).length, 4, 'both sections still render');
    } finally {
      if (t) clearTimeout(t.instance.debounceTimer);
      ctx.Object = originalObject;
    }
  });

  await check('a company without a presentation entry gets registry initials, at most three, with a neutral tile', async () => {
    for (const [name, initials] of [['Ocean', 'O'], ['Ocean Blue', 'OB'], ['Ocean Blue Cruise Company', 'OBC'], ['ß Coast Cruises', 'SSC']]) {
      const t = makeAutocomplete();
      await t.ready();
      const raw = registryRaw();
      raw.companies[0] = { key: 'ocean-blue', name, keywords: ['ocean'] };
      raw.terminals[0].companies = ['ocean-blue'];
      t.instance.curatedRegistry = ctx.CuratedPlaces.validateRegistry(raw).registry;
      typed(t.instance, t.input, 'ocean');
      clearTimeout(t.instance.debounceTimer);
      assert.strictEqual(rows(t.container)[0].main, name);
      assert.ok(t.container.innerHTML.includes('curated-brand--shared'));
      assert.ok(t.container.innerHTML.includes(`aria-hidden="true">${initials}</div>`));
      assert.ok(!t.container.innerHTML.includes('>?</div>'));
      await t.instance.selectSuggestion(0);
      assert.strictEqual(t.instance.selectedPlace.place_id, TERMINAL_V_ID);
      assert.strictEqual(t.input.value, TERMINAL_V_LABEL);
    }
  });

  await check('Carnival keyboard selection skips both captions and keeps Terminal E identity', async () => {
    const t = makeAutocomplete();
    await t.ready();
    t.instance.curatedRegistry = ctx.CuratedPlaces.validateRegistry(JSON.parse(read('data/curated-places.json'))).registry;
    typed(t.instance, t.input, 'Carnival');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    const expected = t.instance.curatedRows[1];
    const key = (key) => t.instance.handleKeydown({ key, preventDefault() {} });
    key('ArrowDown'); key('ArrowDown'); key('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(t.instance.selectedPlace.place_id, expected.placeId);
    assert.strictEqual(t.input.value, expected.label);
    assert.ok(t.input.value.startsWith('PortMiami Terminal E,'));
  });

  await check('Terminal F has one shared, neutrally colored row naming both companies', async () => {
    const t = makeAutocomplete();
    await t.ready();
    t.instance.curatedRegistry = ctx.CuratedPlaces.validateRegistry(JSON.parse(read('data/curated-places.json'))).registry;
    typed(t.instance, t.input, 'Terminal F');
    clearTimeout(t.instance.debounceTimer);
    assert.deepStrictEqual(rows(t.container).map((r) => r.main), ['Carnival · Disney']);
    assert.ok(t.container.innerHTML.includes('curated-brand--shared'));
    assert.ok(t.container.innerHTML.includes('aria-hidden="true">C/D</div>'));
    assert.ok(t.container.innerHTML.includes('class="suggestion-terminal">Terminal F</span>'));
  });

  await check('Google heading exists only with a mixed result list, never for loading, failure or Google-only search', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    for (const state of ['idle', 'loading', 'error', 'results']) {
      t.instance.renderDropdown([], state);
      assert.ok(!t.container.innerHTML.includes('Google suggestions'));
      assert.strictEqual(logos(t.container), 0);
    }
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    assert.strictEqual((t.container.innerHTML.match(/>Google suggestions</g) || []).length, 1);
    assert.deepStrictEqual(plain(t.instance.predictions), GOOGLE_VIRGIN);
    typed(t.instance, t.input, 'Virginia');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    assert.ok(!t.container.innerHTML.includes('suggestion-group-label'));
    assert.strictEqual(logos(t.container), 1);
    assert.deepStrictEqual(rows(t.container).map((r) => r.index), [0, 1, 2]);
  });

  await check('a failed Google request keeps the curated rows, shows a quiet line, and does NOT flag the address as an error', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.showError();
    assert.strictEqual(rows(t.container)[0].terminal, 'pom-terminal-v');
    assert.ok(t.container.innerHTML.includes('More results unavailable right now'));
    assert.ok(!t.container.innerHTML.includes('Error loading suggestions'));
    assert.strictEqual(t.input.classList.contains('error'), false);
    assert.strictEqual(addressError.classList.contains('visible'), false);
    assert.strictEqual(logos(t.container), 0);
    // Without curated rows the failure reads exactly as today.
    typed(t.instance, t.input, 'Plantation');
    clearTimeout(t.instance.debounceTimer);
    t.instance.showError();
    assert.ok(t.container.innerHTML.includes('Error loading suggestions'));
    assert.strictEqual(rows(t.container).length, 0);
    assert.strictEqual(t.input.classList.contains('error'), true);
    assert.strictEqual(addressError.classList.contains('visible'), true);
  });

  await check('an empty Google answer leaves the curated rows without "No results found"; with nothing curated it reads as today', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions([]);
    assert.strictEqual(rows(t.container).length, 1);
    assert.ok(!t.container.innerHTML.includes('No results found'));
    typed(t.instance, t.input, 'Plantation');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions([]);
    assert.strictEqual(t.container.innerHTML, '<div class="no-results">No results found</div>');
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    assert.ok(!t.container.innerHTML.includes('suggestion-group-label'), 'no caption when no LinkMia row is shown');
  });

  await check('a stale Google response cannot replace the curated-first list for newer text', async () => {
    const t = makeAutocomplete();
    await t.ready();
    let releaseOld;
    t.instance.fetchWithTimeout = async (url) => {
      if (url.includes('input=Old')) {
        return new Promise((resolve) => { releaseOld = () => resolve({ ok: true, json: async () => ({ predictions: [{ place_id: 'old', description: 'OLD' }] }) }); });
      }
      return { ok: true, json: async () => ({ predictions: GOOGLE_VIRGIN }) };
    };
    t.input.value = 'Old';
    t.instance.requestSequence = 1;
    const old = t.instance.fetchSuggestions('Old', 1);
    t.input.value = 'Virgin';
    t.instance.requestSequence = 2;
    await t.instance.fetchSuggestions('Virgin', 2);
    releaseOld();
    await old;
    const list = rows(t.container);
    assert.strictEqual(list[0].terminal, 'pom-terminal-v');
    assert.ok(t.container.innerHTML.includes('Virginia Key'));
    assert.ok(!t.container.innerHTML.includes('OLD'));
  });

  await check('keyboard: ArrowDown walks the curated row then Google\'s; Enter selects by that same index', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    const key = (k) => t.instance.handleKeydown({ key: k, preventDefault() {} });
    key('ArrowDown');
    assert.strictEqual(t.instance.selectedIndex, 0);
    assert.strictEqual(t.container.items[0].classList.contains('highlighted'), true);
    key('ArrowDown');
    assert.strictEqual(t.instance.selectedIndex, 1);
    assert.strictEqual(t.container.items[0].classList.contains('highlighted'), false);
    assert.strictEqual(t.container.items[1].classList.contains('highlighted'), true);
    key('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(t.detailsCalls.length, 1);
    assert.ok(t.detailsCalls[0].includes(`place_id=${GOOGLE_VIRGIN[0].place_id}`), 'row 1 is Google\'s first prediction, not the terminal');
    key('ArrowUp'); key('ArrowUp'); key('ArrowUp');
    assert.strictEqual(t.instance.selectedIndex, -1);
  });

  await check('selecting the curated row: Details runs for the registry place ID, the input shows LinkMia\'s label, attribution shows, events keep today\'s shapes', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    t.instance.fetchWithTimeout = async (url) => {
      t.detailsCalls.push(url);
      return { ok: true, json: async () => ({
        result: { formatted_address: '718 N Cruise Blvd, Miami, FL 33132, USA', geometry: { location: { lat: 25.7800848, lng: -80.179946 } } },
        attributions: []
      }) };
    };
    await t.instance.selectSuggestion(0);
    assert.strictEqual(t.detailsCalls.length, 1);
    assert.ok(t.detailsCalls[0].includes(`place_id=${TERMINAL_V_ID}`));
    assert.strictEqual(t.input.value, TERMINAL_V_LABEL, 'LinkMia\'s unambiguous label, not Google\'s formatted address');
    assert.deepStrictEqual(plain(t.instance.selectedPlace), { place_id: TERMINAL_V_ID, description: TERMINAL_V_LABEL });
    assert.strictEqual(t.instance.isValidated, true);
    assert.strictEqual(t.selectedAttribution.classList.contains('visible'), true);
    // Terminal confirmation R1: the synchronous start boundary precedes the
    // two completion events, and all three carry the selection identity —
    // the registry metadata and the autocomplete's selection number.
    const meta = { terminalId: 'pom-terminal-v', companyKey: 'virgin', placeId: TERMINAL_V_ID };
    const selectionId = t.instance.selectionSequence;
    assert.deepStrictEqual(t.dispatched.map((e) => e.type), ['selection-started', 'place-selected', 'place-coordinates']);
    assert.deepStrictEqual(plain(t.dispatched[0].detail), { selectionId, placeId: TERMINAL_V_ID, source: 'curated', curated: meta });
    assert.deepStrictEqual(plain(t.dispatched[1].detail), { placeId: TERMINAL_V_ID, description: TERMINAL_V_LABEL, curated: meta, selectionId });
    assert.deepStrictEqual(plain(t.dispatched[2].detail), { lat: 25.7800848, lng: -80.179946, address: TERMINAL_V_LABEL, selectionId, attributions: [] });
    assert.strictEqual(t.instance.rawQuery, 'Virgin');
    assert.strictEqual(t.container.innerHTML, '', 'the list closes after a selection');
  });

  await check('a Details failure on a curated row falls back to LinkMia\'s label with null coordinates — never a bare city label', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions([]);
    await t.instance.selectSuggestion(0);   // fetchWithTimeout throws
    assert.strictEqual(t.input.value, TERMINAL_V_LABEL);
    assert.deepStrictEqual(plain(t.instance.selectedPlace), { place_id: TERMINAL_V_ID, description: TERMINAL_V_LABEL });
    const selectionId = t.instance.selectionSequence;
    assert.deepStrictEqual(t.dispatched.map((e) => e.type), ['selection-started', 'place-selected', 'place-coordinates']);
    assert.deepStrictEqual(plain(t.dispatched[2].detail), { lat: null, lng: null, address: TERMINAL_V_LABEL, selectionId, attributions: [] });
    // The registry identity travels through the fallback path too (plan §3.1).
    assert.deepStrictEqual(plain(t.dispatched[1].detail.curated), { terminalId: 'pom-terminal-v', companyKey: 'virgin', placeId: TERMINAL_V_ID });
  });

  await check('selecting a Google row below the curated rows resolves the right prediction', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin voyage');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions(GOOGLE_VIRGIN_VOYAGE);
    t.instance.fetchWithTimeout = async (url) => {
      t.detailsCalls.push(url);
      return { ok: true, json: async () => ({
        result: { formatted_address: 'South Pine Island Rd, Plantation, FL 33324, USA', geometry: { location: { lat: 26.1, lng: -80.2 } } },
        attributions: []
      }) };
    };
    await t.instance.selectSuggestion(2);
    assert.ok(t.detailsCalls[0].includes('place_id=ChIJZb6cGlIH2YgRhX7nd38X8lQ'));
    assert.strictEqual(t.input.value, 'South Pine Island Rd, Plantation, FL 33324, USA');
    assert.strictEqual(t.instance.selectedPlace.place_id, 'ChIJZb6cGlIH2YgRhX7nd38X8lQ');
  });

  await check('a registry that arrives late re-renders the current text; one dismissed by Escape stays closed', async () => {
    const t = makeAutocomplete({ registry: 'pending' });
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.showLoading();
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    assert.strictEqual(rows(t.container).filter((r) => r.curated).length, 0, 'nothing curated before the registry');
    t.release();
    await t.ready();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const list = rows(t.container);
    assert.strictEqual(list[0].terminal, 'pom-terminal-v', 'Terminal V inserted on arrival');
    assert.deepStrictEqual(list.slice(1).map((r) => r.index), [1, 2, 3], 'Google rows re-numbered');
    assert.strictEqual(logos(t.container), 1);

    const u = makeAutocomplete({ registry: 'pending' });
    typed(u.instance, u.input, 'Virgin');
    u.instance.handleKeydown({ key: 'Escape', preventDefault() {} });
    assert.strictEqual(u.container.innerHTML, '');
    u.release();
    await u.ready();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(u.container.innerHTML, '', 'a dismissed dropdown is not reopened by the registry');
    assert.strictEqual(u.container.classList.contains('visible'), false);
    typed(u.instance, u.input, 'Virgin v');
    clearTimeout(u.instance.debounceTimer);
    assert.strictEqual(rows(u.container)[0].terminal, 'pom-terminal-v', 'the next keystroke shows it again');
  });

  await check('registry text is never interpreted as HTML', async () => {
    const t = makeAutocomplete();
    await t.ready();
    const raw = registryRaw();
    raw.terminals[0].name = 'PortMiami <Terminal> V';
    t.instance.curatedRegistry = ctx.CuratedPlaces.validateRegistry(raw).registry;
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    assert.ok(t.container.innerHTML.includes('&lt;Terminal&gt;'));
    assert.ok(!t.container.innerHTML.includes('<Terminal>'));
  });

  await check('an invalid registry, or a failed fetch, leaves the dropdown exactly as today (and the fetch is retried at most once)', async () => {
    for (const mode of ['invalid', 'fail']) {
      const t = makeAutocomplete({ registry: mode });
      await t.ready();
      assert.strictEqual(t.instance.curatedRegistry, null);
      typed(t.instance, t.input, 'Virgin');
      clearTimeout(t.instance.debounceTimer);
      assert.strictEqual(t.container.innerHTML, '', 'nothing rendered before Google answers, as today');
      await t.ready();
      typed(t.instance, t.input, 'Virgin v');
      clearTimeout(t.instance.debounceTimer);
      await t.ready();
      typed(t.instance, t.input, 'Virgin vo');
      clearTimeout(t.instance.debounceTimer);
      await t.ready();
      assert.strictEqual(t.registryFetches.length, mode === 'invalid' ? 1 : 2, `${mode}: one load at boot plus at most one retry`);
      t.instance.renderSuggestions(GOOGLE_VIRGIN);
      assert.strictEqual(rows(t.container).filter((r) => r.curated).length, 0);
      assert.strictEqual(logos(t.container), 1);
    }
  });

  // ---- Codex seq:0264 #1 / #2: selection vs the live debounce, and the keyboard highlight ----

  // Swap the vm's timers for a queue so the REAL 500 ms Google debounce can be
  // left queued, fired, or proven cancelled.
  function fakeTimers() {
    const queue = [];
    let nextId = 0;
    const previous = { setTimeout: ctx.setTimeout, clearTimeout: ctx.clearTimeout };
    ctx.setTimeout = (fn, ms) => { queue.push({ id: ++nextId, fn, ms }); return nextId; };
    ctx.clearTimeout = (id) => { const i = queue.findIndex((t) => t.id === id); if (i >= 0) queue.splice(i, 1); };
    return {
      pending: (ms) => queue.filter((t) => t.ms === ms).length,
      fire(ms) {
        const due = queue.filter((t) => t.ms === ms);
        due.forEach((t) => { queue.splice(queue.indexOf(t), 1); t.fn(); });
        return due.length;
      },
      restore() { ctx.setTimeout = previous.setTimeout; ctx.clearTimeout = previous.clearTimeout; }
    };
  }
  const detailsOk = () => ({ ok: true, json: async () => ({
    result: { formatted_address: '718 N Cruise Blvd, Miami, FL 33132, USA', geometry: { location: { lat: 25.7800848, lng: -80.179946 } } },
    attributions: []
  }) });
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  await check('#1 selecting a curated row before the debounce fires cancels the queued Google request: no late "Loading…", no late error', async () => {
    const timers = fakeTimers();
    try {
      const t = makeAutocomplete();
      await t.ready();
      typed(t.instance, t.input, 'Virgin');
      assert.strictEqual(timers.pending(500), 1, 'the Google debounce is queued');
      t.instance.fetchWithTimeout = async (url) => { t.detailsCalls.push(url); return detailsOk(); };
      t.instance.handleKeydown({ key: 'ArrowDown', preventDefault() {} });
      await t.instance.selectSuggestion(t.instance.selectedIndex);
      assert.strictEqual(t.input.value, TERMINAL_V_LABEL);
      assert.strictEqual(timers.pending(500), 0, 'selection cleared the debounce');
      assert.strictEqual(timers.fire(500), 0, 'nothing left to fire');
      assert.strictEqual(t.detailsCalls.length, 1, 'only the Details call ran — no prediction request');
      assert.ok(t.detailsCalls[0].includes('/details'));
      assert.strictEqual(t.container.innerHTML, '');
      assert.strictEqual(t.container.classList.contains('visible'), false);
      assert.strictEqual(t.input.classList.contains('error'), false);
      assert.strictEqual(t.instance.isValidated, true);
    } finally { timers.restore(); }
  });

  await check('#1 selecting while a Google request is in flight: a late success cannot reopen the list, a late failure cannot flag the chosen address', async () => {
    for (const outcome of ['success', 'failure']) {
      const timers = fakeTimers();
      try {
        const t = makeAutocomplete();
        await t.ready();
        let release;
        const inFlight = new Promise((resolve, reject) => {
          release = () => (outcome === 'success'
            ? resolve({ ok: true, json: async () => ({ predictions: GOOGLE_VIRGIN }) })
            : reject(new Error('provider down')));
        });
        t.instance.fetchWithTimeout = async (url) => {
          t.detailsCalls.push(url);
          return url.includes('/autocomplete') ? inFlight : detailsOk();
        };
        typed(t.instance, t.input, 'Virgin');
        assert.strictEqual(timers.fire(500), 1, 'the debounce fired: the Google request is in flight');
        assert.ok(t.container.innerHTML.includes('Loading...'));
        await t.instance.selectSuggestion(0);
        assert.strictEqual(t.input.value, TERMINAL_V_LABEL);
        release();
        await tick();
        assert.strictEqual(t.container.innerHTML, '', `${outcome}: the list stays closed`);
        assert.strictEqual(t.container.classList.contains('visible'), false);
        assert.strictEqual(t.input.classList.contains('error'), false, `${outcome}: no error on the chosen address`);
        assert.strictEqual(addressError.classList.contains('visible'), false);
        assert.strictEqual(t.instance.isValidated, true);
        assert.strictEqual(t.input.value, TERMINAL_V_LABEL);
      } finally { timers.restore(); }
    }
  });

  await check('#2 a highlighted curated row keeps its highlight while Google loads, answers or fails; Enter still selects it', async () => {
    const timers = fakeTimers();
    try {
      const t = makeAutocomplete();
      await t.ready();
      let release;
      t.instance.fetchWithTimeout = async (url) => {
        t.detailsCalls.push(url);
        if (url.includes('/autocomplete')) {
          return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ predictions: GOOGLE_VIRGIN }) }); });
        }
        return detailsOk();
      };
      typed(t.instance, t.input, 'Virgin');
      const key = (k) => t.instance.handleKeydown({ key: k, preventDefault() {} });
      key('ArrowDown');
      assert.strictEqual(t.instance.selectedIndex, 0);
      timers.fire(500);
      assert.ok(t.container.innerHTML.includes('Loading...'));
      assert.strictEqual(t.instance.selectedIndex, 0, 'highlight survives the loading transition');
      assert.strictEqual(t.container.items[0].classList.contains('highlighted'), true);
      release();
      await tick();
      assert.ok(t.container.innerHTML.includes('Virginia Key'), 'Google rows arrived');
      assert.strictEqual(t.instance.selectedIndex, 0, 'highlight survives the results');
      assert.strictEqual(t.container.items[0].classList.contains('highlighted'), true);
      assert.strictEqual(t.container.items[1].classList.contains('highlighted'), false);
      t.instance.showError();
      assert.strictEqual(t.instance.selectedIndex, 0, 'highlight survives a Google failure');
      assert.strictEqual(t.container.items[0].classList.contains('highlighted'), true);
      key('Enter');
      await tick();
      assert.ok(t.detailsCalls.some((u) => u.includes(`place_id=${TERMINAL_V_ID}`)), 'Enter selected the terminal');
      assert.strictEqual(t.input.value, TERMINAL_V_LABEL);
    } finally { timers.restore(); }
  });

  await check('#2 a highlighted Google row that the next answer drops loses the highlight; a new keystroke always starts unhighlighted', async () => {
    const t = makeAutocomplete();
    await t.ready();
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    const key = (k) => t.instance.handleKeydown({ key: k, preventDefault() {} });
    key('ArrowDown'); key('ArrowDown');
    assert.strictEqual(t.instance.selectedIndex, 1, 'Virginia Key highlighted');
    t.instance.renderSuggestions(GOOGLE_VIRGIN.slice(1));   // Virginia Key gone
    assert.strictEqual(t.instance.selectedIndex, -1);
    assert.ok(!t.container.innerHTML.includes('highlighted'));
    t.instance.renderSuggestions(GOOGLE_VIRGIN);
    key('ArrowDown');
    assert.strictEqual(t.instance.selectedIndex, 0);
    typed(t.instance, t.input, 'Virgin v');
    clearTimeout(t.instance.debounceTimer);
    assert.strictEqual(t.instance.selectedIndex, -1, 'new text, no highlight');
    assert.strictEqual(rows(t.container)[0].terminal, 'pom-terminal-v');
    assert.strictEqual(t.container.items[0].classList.contains('highlighted'), false);
  });

  await check('#0266-1 a Google failure before the registry arrived flagged the field; the late registry\'s valid choices clear that flag (validation and selection untouched)', async () => {
    const t = makeAutocomplete({ registry: 'pending' });
    typed(t.instance, t.input, 'Virgin');
    clearTimeout(t.instance.debounceTimer);
    t.instance.showLoading();
    t.instance.showError();
    assert.strictEqual(t.input.classList.contains('error'), true, 'no choices yet: today\'s error state');
    assert.strictEqual(addressError.classList.contains('visible'), true);
    t.release();
    await t.ready();
    await tick();
    assert.strictEqual(rows(t.container)[0].terminal, 'pom-terminal-v', 'Terminal V arrived');
    assert.ok(t.container.innerHTML.includes('More results unavailable right now'));
    assert.strictEqual(t.input.classList.contains('error'), false, 'an available destination is not marked invalid');
    assert.strictEqual(addressError.classList.contains('visible'), false);
    assert.strictEqual(t.instance.isValidated, false, 'nothing was selected');
    assert.strictEqual(t.instance.selectedPlace, null);
  });

  await check('repo pins: indexMVP loads js/curated-places.js?v=1 before the pending-edit model; the SW precaches both exact URLs', () => {
    const idx = read('indexMVP.html');
    const sw = read('service-worker.js');
    const script = idx.indexOf('<script src="./js/curated-places.js?v=1"></script>');
    assert.ok(script >= 0, 'classic script tag present');
    assert.ok(script < idx.indexOf('<script src="./js/pending-edit-model.js'), 'loaded before the other js/ modules');
    const listStart = sw.indexOf('const STATIC_CACHE_URLS = [');
    const list = sw.slice(listStart, sw.indexOf('];', listStart));
    assert.ok(list.includes(`'/js/curated-places.js?v=1'`));
    assert.ok(list.includes(`'${REGISTRY_URL}'`));
    assert.ok(read('autocomplete.js').includes(`const CURATED_REGISTRY_URL = '${REGISTRY_URL}';`), 'autocomplete requests the precached literal');
  });

  results.forEach((line) => console.log(line));
  // CI (.github/workflows/tests.yml) accepts a suite only on this exact
  // sentinel; it is printed only after every check above passed.
  console.log(`\n  ALL ${passed} CHECKS PASS\n`);
})();
