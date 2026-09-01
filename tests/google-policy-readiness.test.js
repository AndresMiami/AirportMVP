// Google Maps policy-readiness boundaries.
// Run: node tests/google-policy-readiness.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const autocompleteSource = read('autocomplete.js');
const proxySource = read('backend/api-proxy/server.js');
const indexSource = read('indexMVP.html');
const tripSource = read('trip.html');
const driverSource = read('driver.html');
const mapsCss = read('css/maps-autocomplete.css');
const terms = read('terms.html');
const privacy = read('privacy.html');
const landing = read('index.html');
const login = read('login.html');
const netlify = read('netlify.toml');
const serviceWorker = read('service-worker.js');
const attributionAsset = fs.readFileSync(path.join(repoRoot, 'images/google-maps-attribution-dark-gray.svg'));

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

const documentStub = {
  getElementById: () => null,
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
  AbortController, URL, URLSearchParams, Uint8Array, Set, Array, Math, Date, String, Number, JSON, Object,
  setTimeout, clearTimeout
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(
  autocompleteSource.replace(/^export class /m, 'class ') + '\n;globalThis.__Autocomplete = CustomAutocomplete;',
  ctx,
  { filename: 'autocomplete.js' }
);

function makeAutocomplete({ construct = false } = {}) {
  const attributionClasses = classList();
  const selectedAttribution = { classList: attributionClasses };
  const dispatched = [];
  const input = {
    value: '',
    classList: classList(),
    closest: () => ({ querySelector: () => selectedAttribution }),
    dispatchEvent: (event) => dispatched.push(event),
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
  const container = {
    innerHTML: '',
    classList: classList(),
    querySelectorAll: () => []
  };
  const instance = construct
    ? new ctx.__Autocomplete(input, container, null)
    : Object.create(ctx.__Autocomplete.prototype);
  if (!construct) {
    Object.assign(instance, {
      input, suggestionsContainer: container, selectedAttribution,
      sessionToken: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sessionLastActivityTime: Date.now(), sessionRequestCount: 0,
      sessionDuration: 180000, requestSequence: 0, selectionSequence: 0, predictions: [],
      selectedIndex: -1, selectedPlace: null, isValidated: false,
      onSelect: null
    });
  }
  return { instance, input, container, selectedAttribution, dispatched };
}

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
  console.log('\nGoogle Maps policy readiness\n');

  await check('public Terms and Privacy pages have one heading, dates, operator and contact with no placeholders', () => {
    for (const [name, page] of [['Terms', terms], ['Privacy', privacy]]) {
      assert.strictEqual((page.match(/<h1>/g) || []).length, 1, `${name} needs exactly one h1`);
      assert.match(page, /Last updated: August 25, 2026/);
      assert.match(page, /Dale Miami Ventures LLC/);
      assert.match(page, /Florida limited liability company/);
      assert.match(page, /\+1 \(786\) 509-3955/);
      assert.ok(!/L25000370670|9430 SW|8901 SW/i.test(page), `${name} exposes unnecessary filing/address data`);
      assert.ok(!/luggage information|party and luggage information/i.test(page), `${name} claims an uncollected luggage field`);
      assert.ok(!/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(page), `${name} contains a placeholder`);
      assert.ok(!/MERGE BLOCKER|LEGAL ENTITY RATIFICATION REQUIRED/i.test(page), `${name} still blocks the confirmed entity`);
      assert.ok(!/<script\b/i.test(page), `${name} must not load scripts or trackers`);
    }
  });

  await check('Terms flow down the exact Google Maps terms and privacy links', () => {
    assert.match(terms, /LinkMia includes Google Maps features and content/);
    assert.ok(terms.includes('https://maps.google.com/help/terms_maps/'));
    assert.ok(terms.includes('https://policies.google.com/privacy'));
  });

  await check('Privacy truthfully describes Maps processing and one-shot driver checkpoints', () => {
    for (const phrase of ['search text', 'selected place identifier', 'route distance', 'traffic-aware duration']) {
      assert.ok(privacy.toLowerCase().includes(phrase), `Privacy is missing ${phrase}`);
    }
    assert.match(privacy, /does not continuously track/i);
    assert.match(privacy, /last stored checkpoint location is erased when the ride is completed/i);
    assert.match(privacy, /checkpoint coordinate[^.]*Google Maps/i);
    assert.match(driverSource, /(?:device or browser|browser or device) settings/i);
  });

  await check('legal pages avoid absolute security, arrival and deletion promises', () => {
    const both = `${terms}\n${privacy}`;
    for (const forbidden of [/100% secure/i, /guaranteed arrival/i, /always available/i, /delete all information on request/i, /PCI compliant/i]) {
      assert.ok(!forbidden.test(both), `unsafe promise found: ${forbidden}`);
    }
  });

  await check('all public and authenticated surfaces expose Terms and Privacy; signup notice is mode-bound', () => {
    for (const page of [landing, login, indexSource, tripSource, driverSource]) {
      assert.ok(page.includes('href="/terms"'));
      assert.ok(page.includes('href="/privacy"'));
    }
    assert.match(login, /id="signupLegal"/);
    assert.match(login, /signupLegal'\)\.classList\.toggle\('hidden', m === 'signin'\)/);
  });

  await check('explicit legal routes precede the SPA catch-all', () => {
    const termsAt = netlify.indexOf('from = "/terms"');
    const privacyAt = netlify.indexOf('from = "/privacy"');
    const catchAllAt = netlify.indexOf('from = "/*"');
    assert.ok(termsAt > 0 && privacyAt > 0 && termsAt < catchAllAt && privacyAt < catchAllAt);
  });

  await check('legal pages use only local presentation assets and are not precached', () => {
    assert.ok(terms.includes('href="/css/legal.css"'));
    assert.ok(privacy.includes('href="/css/legal.css"'));
    assert.ok(!/https?:\/\/[^"']+\.(?:css|js)/i.test(`${terms}\n${privacy}`));
    const cacheList = serviceWorker.slice(serviceWorker.indexOf('STATIC_CACHE_URLS'), serviceWorker.indexOf('];', serviceWorker.indexOf('STATIC_CACHE_URLS')));
    assert.ok(!/terms|privacy|legal\.css/.test(cacheList));
    assert.match(serviceWorker, /linkmia-v1\.3\.24/);
  });

  await check('autocomplete constructor wires its real input, keyboard and blur boundaries', () => {
    const { input } = makeAutocomplete({ construct: true });
    assert.deepStrictEqual(Object.keys(input.listeners).sort(), ['blur', 'input', 'keydown']);
  });

  await check('real autocomplete renders the exact official Google Maps logo after live predictions', () => {
    const { instance, container } = makeAutocomplete();
    instance.renderSuggestions([{
      place_id: 'pid', description: '100 Main St',
      structured_formatting: { main_text: '100 Main St', secondary_text: 'Miami, FL' }
    }]);
    assert.strictEqual((container.innerHTML.match(/class="google-maps-attribution"/g) || []).length, 1);
    assert.match(container.innerHTML, /src="\/images\/google-maps-attribution-dark-gray\.svg"/);
    assert.match(container.innerHTML, /alt="Google Maps" width="98" height="18"/);
    assert.strictEqual((container.innerHTML.match(/class="suggestion-item"/g) || []).length, 1);
    assert.strictEqual(
      crypto.createHash('sha256').update(attributionAsset).digest('hex'),
      '62c52df68d8f450c860d5d65068fc96d63c2dfaec849b91ac64b3256a898936e',
      'the official Google asset must remain byte-identical'
    );
  });

  await check('a live selection shows attribution and manual editing clears it', () => {
    const { instance, selectedAttribution } = makeAutocomplete();
    instance.applySelection({
      id: 'pid', formattedAddress: '100 Main St, Miami, FL',
      location: { lat: 25.7, lng: -80.2 }
    });
    assert.strictEqual(selectedAttribution.classList.contains('visible'), true);
    instance.clearValidation();
    assert.strictEqual(selectedAttribution.classList.contains('visible'), false);
  });

  await check('identical autocomplete text makes a fresh provider request every time', async () => {
    const { instance, input } = makeAutocomplete();
    input.value = '100 Main';
    let calls = 0;
    instance.fetchWithTimeout = async () => {
      calls++;
      return { ok: true, json: async () => ({ predictions: [] }) };
    };
    await instance.fetchSuggestions('100 Main');
    await instance.fetchSuggestions('100 Main');
    assert.strictEqual(calls, 2);
  });

  await check('stale autocomplete responses cannot replace newer input', async () => {
    const { instance, input, container } = makeAutocomplete();
    let releaseOld;
    instance.fetchWithTimeout = async (url) => {
      if (url.includes('Old')) {
        return new Promise((resolve) => { releaseOld = () => resolve({
          ok: true, json: async () => ({ predictions: [{ description: 'OLD' }] })
        }); });
      }
      return { ok: true, json: async () => ({ predictions: [{ description: 'NEW' }] }) };
    };
    input.value = 'Old';
    instance.requestSequence = 1;
    const old = instance.fetchSuggestions('Old', 1);
    input.value = 'New';
    instance.requestSequence = 2;
    await instance.fetchSuggestions('New', 2);
    releaseOld();
    await old;
    assert.ok(container.innerHTML.includes('NEW'));
    assert.ok(!container.innerHTML.includes('OLD'));
  });

  await check('a delayed Place Details response cannot overwrite a newer selection', async () => {
    const { instance, input } = makeAutocomplete();
    let releaseOld;
    instance.fetchWithTimeout = async (url) => {
      if (url.includes('pid-old')) {
        return new Promise((resolve) => { releaseOld = () => resolve({
          ok: true,
          json: async () => ({ result: {
            formatted_address: 'Old address', geometry: { location: { lat: 25.1, lng: -80.1 } }
          } })
        }); });
      }
      return { ok: true, json: async () => ({ result: {
        formatted_address: 'New address', geometry: { location: { lat: 25.2, lng: -80.2 } }
      } }) };
    };
    instance.predictions = [{ place_id: 'pid-old', description: 'Old address' }];
    const old = instance.selectSuggestion(0);
    instance.predictions = [{ place_id: 'pid-new', description: 'New address' }];
    await instance.selectSuggestion(0);
    releaseOld();
    await old;
    assert.strictEqual(input.value, 'New address');
    assert.strictEqual(instance.selectedPlace.place_id, 'pid-new');
  });

  await check('Escape and provider errors discard hidden prediction content', () => {
    const { instance, container } = makeAutocomplete();
    instance.predictions = [{ place_id: 'pid', description: 'Private address' }];
    container.innerHTML = '<div>Private address</div>';
    instance.handleKeydown({ key: 'Escape', preventDefault() {} });
    assert.strictEqual(instance.predictions.length, 0);
    assert.strictEqual(container.innerHTML, '');
    instance.predictions = [{ place_id: 'pid-2', description: 'Another address' }];
    instance.showError();
    assert.strictEqual(instance.predictions.length, 0);
    assert.ok(!container.innerHTML.includes('Another address'));
  });

  await check('a delayed response cannot reopen a dismissed dropdown (Escape), and Escape kills the queued debounce', async () => {
    const { instance, input, container } = makeAutocomplete();
    let release;
    let fetches = 0;
    instance.fetchWithTimeout = async () => {
      fetches++;
      return new Promise((resolve) => {
        release = () => resolve({
          ok: true, json: async () => ({ predictions: [{ description: 'Private address' }] })
        });
      });
    };
    input.value = '100 Priv';
    const pending = instance.fetchSuggestions('100 Priv', ++instance.requestSequence);
    instance.handleKeydown({ key: 'Escape', preventDefault() {} });
    release();
    await pending;
    assert.strictEqual(container.innerHTML, '', 'a late response must not re-render the private list');
    assert.strictEqual(container.classList.contains('visible'), false, 'the dropdown stays dismissed');

    input.value = '100 Private Rd';
    instance.handleInput({ target: input });
    assert.ok(instance.debounceTimer, 'sanity: a debounce is queued');
    instance.handleKeydown({ key: 'Escape', preventDefault() {} });
    assert.strictEqual(instance.debounceTimer, null, 'Escape cancels the queued debounce');
    await new Promise((resolve) => setTimeout(resolve, 620));
    assert.strictEqual(fetches, 1, 'the cancelled debounce never buys a provider call');
  });

  await check('a delayed response cannot reopen after blur, and blur cancels queued work', async () => {
    const { instance, input, container } = makeAutocomplete();
    let release;
    let fetches = 0;
    instance.fetchWithTimeout = async () => {
      fetches++;
      return new Promise((resolve) => {
        release = () => resolve({
          ok: true, json: async () => ({ predictions: [{ description: 'Private address' }] })
        });
      });
    };
    input.value = '100 Priv';
    const pending = instance.fetchSuggestions('100 Priv', ++instance.requestSequence);
    instance.handleBlur();
    release();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(!container.innerHTML.includes('Private address'),
      'a response landing after blur must not render the private list');
    assert.strictEqual(container.classList.contains('visible'), false);

    input.value = '100 Private Rd';
    instance.handleInput({ target: input });
    assert.ok(instance.debounceTimer, 'sanity: a debounce is queued');
    instance.handleBlur();
    assert.strictEqual(instance.debounceTimer, null, 'blur cancels the queued debounce');
    await new Promise((resolve) => setTimeout(resolve, 620));
    assert.strictEqual(fetches, 1, 'the cancelled debounce never buys a provider call');
  });

  await check('every third-party attribution renders — all 16, structured segments, separators, no truncation', async () => {
    const { instance } = makeAutocomplete();
    const attributionHost = {
      classList: classList(),
      children: [],
      querySelector() {
        return this.children.find((c) => c.className === 'third-party-attribution') || null;
      },
      appendChild(child) { this.children.push(child); return child; }
    };
    instance.selectedAttribution = attributionHost;
    const longName = 'Very Long Partner Name '.repeat(20).trim();
    // 16 entries — the declared ceiling — must ALL render: the first is
    // Google's own published format (unlinked prefix + linked name), the
    // second a long uncut name, the rest simple linked partners.
    const entries = [
      { segments: [
        { text: 'Listings by ', href: null },
        { text: 'Example Company', href: 'https://companies.example.com/co' }
      ] },
      { segments: [{ text: longName, href: 'https://long.example/x' }] },
      ...Array.from({ length: 14 }, (_, i) => (
        { segments: [{ text: `Partner ${i}`, href: `https://p${i}.example/x` }] }))
    ];
    instance.fetchWithTimeout = async () => ({
      ok: true,
      json: async () => ({
        attributions: entries,
        result: {
          formatted_address: '100 Main St, Miami, FL',
          geometry: { location: { lat: 25.7, lng: -80.2 } }
        }
      })
    });
    instance.predictions = [{ place_id: 'ChIJattribution1', description: '100 Main St' }];
    await instance.selectSuggestion(0);

    const holder = attributionHost.querySelector();
    assert.ok(holder, 'a third-party attribution holder renders beside the selection');
    // The host text is "Google Maps": every ENTRY gets a leading separator.
    const separators = holder.childNodes.filter((n) => n.text === ' \u00b7 ');
    assert.strictEqual(separators.length, 16, 'one separator per entry — 16 of 16 render');
    assert.strictEqual(holder.childNodes[0]?.text, ' \u00b7 ',
      'a separator precedes the FIRST entry (never "Google MapsListings…")');
    const anchors = holder.childNodes.filter((n) => n.tagName === 'A');
    assert.strictEqual(anchors.length, 16, 'every linked segment renders as a link');
    // Structure preservation: the unlinked prefix is a TEXT node, and only
    // the company name is inside the anchor — link scope is not widened.
    const prefixIdx = holder.childNodes.findIndex((n) => n.text === 'Listings by ');
    assert.ok(prefixIdx >= 0, 'the unlinked prefix renders as plain text');
    assert.strictEqual(holder.childNodes[prefixIdx + 1]?.tagName, 'A');
    assert.strictEqual(holder.childNodes[prefixIdx + 1]?.textContent, 'Example Company');
    assert.strictEqual(holder.childNodes[prefixIdx + 1]?.rel, 'noopener noreferrer');
    const longNode = anchors.find((n) => n.textContent === longName);
    assert.ok(longNode, 'long valid credit is never truncated');

    instance.clearValidation();
    assert.strictEqual(holder.removed, true, 'clearing the selection clears the attribution');
  });

  await check('an unrepresentable OR MISSING attribution set fails the Details result closed — fallback shows no Details content', async () => {
    const { instance, input, dispatched } = makeAutocomplete();
    const attributionHost = {
      classList: classList(),
      children: [],
      querySelector() {
        return this.children.find((c) => c.className === 'third-party-attribution') || null;
      },
      appendChild(child) { this.children.push(child); return child; }
    };
    instance.selectedAttribution = attributionHost;
    const hostileSets = [
      undefined,                                                        // REQUIRED field missing
      null,
      'not-an-array',
      [{ segments: [{ text: 'Partner', href: 'http://insecure.example/x' }] }],  // https-only
      [{ segments: [{ text: 'Partner', href: 'javascript:alert(1)' }] }],
      [{ segments: [{ text: 'Partner' }] }],                            // href must be an OWN property
      [{ segments: [{ text: 'Partner', href: undefined }] }],           // exactly null or https string
      [{ segments: [{ text: '', href: 'https://ok.example/x' }] }],     // a link needs a label
      [{ text: 'flat-shape entry', href: null }],                       // old flat shape refused
      Array.from({ length: 17 }, (_, i) => (
        { segments: [{ text: `P${i}`, href: null }] })),                // ceiling: 17 fails
    ];
    for (const hostile of hostileSets) {
      dispatched.length = 0;
      attributionHost.children.length = 0;
      instance.fetchWithTimeout = async () => ({
        ok: true,
        json: async () => {
          const body = {
            result: {
              formatted_address: '100 Main St, Miami, FL',
              geometry: { location: { lat: 25.7, lng: -80.2 } }
            }
          };
          if (hostile !== undefined) body.attributions = hostile;
          return body;
        }
      });
      instance.predictions = [{ place_id: 'ChIJattribution2', description: '100 Main St' }];
      await instance.selectSuggestion(0);
      // The selection still completes — via the prediction-description
      // fallback, which displays NO Details content and owes no credit.
      assert.strictEqual(instance.isValidated, true, 'the passenger is not stranded');
      assert.strictEqual(input.value, '100 Main St');
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(dispatched[1].detail)),
        { lat: null, lng: null, address: '100 Main St' },
        'the fallback carries no Details coordinates');
      assert.strictEqual(attributionHost.querySelector(), null,
        'no partial attribution ever renders');
    }
  });

  await check('browser attribution ceilings match the declared limits exactly (999/1000/1001)', () => {
    const { instance } = makeAutocomplete();
    const entryWithText = (n) => [{ segments: [{ text: 'x'.repeat(n), href: null }] }];
    const entryWithHref = (n) => {
      const href = 'https://l.example/' + 'a'.repeat(n - 18);
      assert.strictEqual(href.length, n);
      return [{ segments: [{ text: 'P', href }] }];
    };
    for (const [n, expected] of [[999, true], [1000, true], [1001, false]]) {
      assert.strictEqual(instance.validAttributionEntries(entryWithText(n)) !== null, expected,
        `browser text ceiling at ${n} — a silently lowered cap drops valid credit`);
      assert.strictEqual(instance.validAttributionEntries(entryWithHref(n)) !== null, expected,
        `browser href ceiling at ${n}`);
    }
    // Segment-count ceiling: 8 accepted, 9 refused (defense-in-depth — the
    // proxy emits at most three segments per entry today).
    const entryWithSegments = (n) => [{
      segments: Array.from({ length: n }, (_, i) => ({ text: `s${i}`, href: null }))
    }];
    assert.ok(instance.validAttributionEntries(entryWithSegments(8)) !== null,
      '8 segments are within the declared ceiling');
    assert.strictEqual(instance.validAttributionEntries(entryWithSegments(9)), null,
      '9 segments exceed the ceiling and fail closed');
  });

  await check('attribution CSS wraps required credit instead of pushing it off a mobile viewport', () => {
    assert.match(mapsCss, /\.selected-place-attribution:has\(\.third-party-attribution\)\s*\{[^}]*white-space:\s*normal/,
      'the host must stop nowrap once provider entries join it');
    assert.match(mapsCss, /\.third-party-attribution\s*\{[^}]*overflow-wrap:\s*anywhere/,
      'long URLs and names must wrap, not overflow');
    assert.match(mapsCss, /\.third-party-attribution a\s*\{[^}]*text-decoration:\s*underline/,
      'links must be visibly links');
  });

  await check('every tracked internal .md is UNSERVABLE by an enumerated force-404 rule', () => {
    // Netlify does not support mid-path splats ("/*.md" silently falls to
    // the SPA catch-all with 200 — false green), so the rules are
    // enumerated and THIS inventory walk is the guard: a newly added .md
    // without a rule fails here before it can ship publicly readable.
    const catchAll = netlify.indexOf('from = "/*"\n');
    const docsRule = netlify.indexOf('from = "/docs/*"');
    assert.ok(docsRule >= 0 && docsRule < catchAll, 'the /docs/* rule must precede the catch-all');
    const walk = (dir) => {
      const found = [];
      for (const item of fs.readdirSync(path.join(repoRoot, dir))) {
        if (item === 'node_modules' || item === '.git' || item === '.claude') continue;
        const rel = dir ? `${dir}/${item}` : item;
        const stat = fs.statSync(path.join(repoRoot, rel));
        if (stat.isDirectory()) found.push(...walk(rel));
        else if (item.endsWith('.md')) found.push(rel);
      }
      return found;
    };
    const tracked = walk('');
    assert.ok(tracked.length >= 15, `sanity: expected the repo's .md inventory, saw ${tracked.length}`);
    for (const rel of tracked) {
      if (rel.startsWith('docs/')) continue;   // covered by the /docs/* rule
      const ruleAt = netlify.indexOf(`from = "/${rel}"`);
      assert.ok(ruleAt >= 0, `PUBLICLY SERVABLE: /${rel} has no netlify.toml rule — add a force-404 rule`);
      assert.ok(ruleAt < catchAll, `/${rel} rule must precede the catch-all`);
      const block = netlify.slice(ruleAt, netlify.indexOf('[[redirects]]', ruleAt + 1));
      assert.match(block, /status = 404/, `/${rel} rule must be a 404`);
      assert.match(block, /force = true/, `/${rel} needs force — Netlify otherwise serves the real file`);
    }
  });

  await check('Places sessions expire after inactivity, not while the passenger is actively typing', () => {
    const { instance } = makeAutocomplete();
    instance.sessionLastActivityTime = Date.now() - instance.sessionDuration + 1000;
    assert.strictEqual(instance.shouldGenerateNewSession(), false);
    instance.sessionLastActivityTime = Date.now() - instance.sessionDuration - 1000;
    assert.strictEqual(instance.shouldGenerateNewSession(), true);
    assert.ok(!autocompleteSource.includes('sessionStartTime'));
  });

  await check('failed Place Details preserves the live prediction without fake coordinates', async () => {
    const { instance, input, selectedAttribution, dispatched } = makeAutocomplete();
    instance.predictions = [{ place_id: 'ChIJprediction123', description: '100 Main St' }];
    instance.fetchWithTimeout = async () => ({ ok: false });
    await instance.selectSuggestion(0);
    assert.strictEqual(instance.isValidated, true);
    assert.strictEqual(input.value, '100 Main St');
    assert.strictEqual(instance.selectedPlace.place_id, 'ChIJprediction123');
    assert.strictEqual(selectedAttribution.classList.contains('visible'), true);
    assert.deepStrictEqual(dispatched.map((event) => event.type), ['place-selected', 'place-coordinates']);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(dispatched[1].detail)),
      { lat: null, lng: null, address: '100 Main St' }
    );
    assert.ok(!/lat:\s*0\s*,\s*lng:\s*0/.test(autocompleteSource));
  });

  await check('browser cannot choose the Place Details field mask or provider location bias', () => {
    assert.ok(!/fields:\s*['"]formatted_address/.test(autocompleteSource));
    assert.ok(!/location:\s*`/.test(autocompleteSource));
    assert.ok(!/radius:\s*['"]/.test(autocompleteSource));
  });

  await check('browser stores only current visible predictions, never a Google result cache or local-filter answer', () => {
    for (const forbidden of ['suggestionCache', 'cacheTTL', 'getCachedSuggestions', 'setCachedSuggestions', 'filterPredictions']) {
      assert.ok(!autocompleteSource.includes(forbidden), `${forbidden} must stay removed`);
    }
  });

  await check('autocomplete client logs contain no raw input, token, place ID or full provider body', () => {
    for (const forbidden of [/session token:/i, /API response data/i, /Making API request for:/i, /Fetching place details with session:/i]) {
      assert.ok(!forbidden.test(autocompleteSource), `sensitive client log restored: ${forbidden}`);
    }
  });

  await check('Railway has no Places/Directions content cache or airport-content shortcut', () => {
    for (const forbidden of ['routeCache', 'placeCache', 'directionsCache', 'popularPlaces', 'ROUTE_CACHE_DURATION', 'PLACE_CACHE_DURATION', 'X-Cache-Hit']) {
      assert.ok(!proxySource.includes(forbidden), `${forbidden} must stay removed`);
    }
  });

  await check('Railway access logs are path-only and Maps data responses are private no-store', () => {
    assert.match(proxySource, /morgan\(':method :safe-path :status :response-time ms',\s*\{[\s\S]*?stream:/);
    assert.ok(!/morgan\(['"]combined['"]\)|morgan\([^\n]*:url/.test(proxySource));
    assert.match(proxySource, /Cache-Control', 'private, no-store, max-age=0'/);
    for (const [method, route] of [
      ['get', 'places/autocomplete'],
      ['get', 'places/details'],
      ['post', 'directions'],
      ['get', 'geocoding']
    ]) {
      const declaration = `app.${method}('/api/${route}'`;
      const at = proxySource.indexOf(declaration);
      assert.ok(at > 0 && proxySource.slice(at, at + 180).includes('mapsDataNoStore'), `${route} missing no-store`);
    }
  });

  await check('Railway does not return unnecessary route polyline or Place name content', () => {
    assert.ok(!proxySource.includes('overview_polyline'));
    const detailsBlock = proxySource.slice(proxySource.indexOf("app.get('/api/places/details'"), proxySource.indexOf("app.post('/api/directions'"));
    assert.ok(!/response\.data\.result\.name/.test(detailsBlock));
  });

  await check('booking and trip route facts carry exact Google Maps attribution hooks', () => {
    assert.match(indexSource, /id="routeAttribution" translate="no">Google Maps/);
    assert.match(indexSource, /routeAttribution\.classList\.add\('visible'\)/);
    assert.match(indexSource, /routeAttribution\.classList\.remove\('visible'\)/);
    assert.match(tripSource, /id="routeAttribution" translate="no">Google Maps/);
    assert.match(tripSource, /routeAttribution'\)\.classList\.remove\('hidden'\)/);
    assert.match(tripSource, /routeAttribution'\)\.classList\.add\('hidden'\)/);
  });

  await check('official-logo dimensions and compact text attribution meet Google presentation rules', () => {
    assert.match(mapsCss, /\.google-maps-attribution\s*\{[\s\S]*?padding: 10px 10px 5px;/);
    assert.match(mapsCss, /\.google-maps-attribution img[\s\S]*width: 98px;[\s\S]*height: 18px;/);
    assert.match(mapsCss, /\.selected-place-attribution[\s\S]*color: #FFFFFF;[\s\S]*font-size: 12px;[\s\S]*font-weight: 400;/);
    assert.match(indexSource, /id="routeAttribution" translate="no">Google Maps<\/div>/);
    assert.ok(!/Powered by Google/i.test(`${autocompleteSource}\n${indexSource}\n${tripSource}`));
  });

  results.forEach((line) => console.log(line));
  console.log(`\n  ALL ${passed} CHECKS PASS\n`);
})();
