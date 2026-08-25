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
  AbortController, URLSearchParams, Uint8Array, Set, Array, Math, Date, String, Number, JSON, Object,
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
    assert.match(serviceWorker, /linkmia-v1\.3\.22/);
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

  await check('third-party attributions render as text and safe links only — hostile entries cannot inject', async () => {
    const { instance, input } = makeAutocomplete();
    const attributionHost = {
      classList: classList(),
      children: [],
      querySelector() {
        return this.children.find((c) => c.className === 'third-party-attribution') || null;
      },
      appendChild(child) { this.children.push(child); return child; }
    };
    instance.selectedAttribution = attributionHost;
    instance.fetchWithTimeout = async () => ({
      ok: true,
      json: async () => ({
        attributions: [
          { text: 'Listings by Example', href: 'https://listings.example.com/p/1' },
          { text: '<img src=x onerror=alert(1)>', href: 'javascript:alert(2)' }
        ],
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
    const nodes = holder.childNodes.filter((n) => n.tagName);
    assert.strictEqual(nodes.length, 2);
    assert.strictEqual(nodes[0].tagName, 'A');
    assert.strictEqual(nodes[0].href, 'https://listings.example.com/p/1');
    assert.strictEqual(nodes[0].rel, 'noopener noreferrer');
    assert.strictEqual(nodes[0].textContent, 'Listings by Example');
    assert.strictEqual(nodes[1].tagName, 'SPAN', 'a javascript: href renders as plain text, never a link');
    assert.strictEqual(nodes[1].textContent, '<img src=x onerror=alert(1)>',
      'hostile text stays textContent — it is data, never markup');
    assert.strictEqual(nodes[1].href, undefined);

    input.value = 'edited';
    instance.clearValidation();
    assert.strictEqual(holder.removed, true, 'clearing the selection clears the attribution');
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
