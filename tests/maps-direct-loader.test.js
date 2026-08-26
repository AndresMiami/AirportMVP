// Maps JavaScript direct-loader contract.
// Run: node tests/maps-direct-loader.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const repoRoot = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const loaderSource = read('maps-loader.js');
const committedConfig = read('maps-browser-config.js');
const bookingPage = read('indexMVP.html');
const tripPage = read('trip.html');
const landingPage = read('index.html');
const apiConfig = read('api-config.js');
const serviceWorker = read('service-worker.js');
const netlify = read('netlify.toml');
const generator = require('../scripts/generate-maps-browser-config');

const VALID_KEY = `AIza${'A'.repeat(35)}`;
let checks = 0;

async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  ✓ ${name}`);
}

function makeRealm({ key = VALID_KEY } = {}) {
  const appended = [];
  const events = [];
  const timers = new Map();
  let nextTimer = 1;

  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const window = {
    LINKMIA_MAPS_CONFIG: Object.freeze({ apiKey: key }),
    dispatchEvent(event) { events.push(event); }
  };
  const document = {
    head: { appendChild(node) { appended.push(node); } },
    createElement(tag) {
      assert.strictEqual(tag, 'script');
      return { tagName: 'SCRIPT' };
    }
  };
  const context = vm.createContext({
    window,
    document,
    CustomEvent: FakeCustomEvent,
    URL,
    setTimeout(fn) {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(loaderSource, context, { filename: 'maps-loader.js' });
  return { window, appended, events, timers };
}

(async () => {
  console.log('\nMaps JavaScript direct loader\n');

  await check('loader requests Google directly with the pinned safe parameters', async () => {
    const realm = makeRealm();
    const pending = realm.window.LinkMiaMapsLoader.load();
    assert.strictEqual(realm.appended.length, 1);
    const script = realm.appended[0];
    const url = new URL(script.src);
    assert.strictEqual(url.origin, 'https://maps.googleapis.com');
    assert.strictEqual(url.pathname, '/maps/api/js');
    assert.strictEqual(url.searchParams.get('key'), VALID_KEY);
    assert.strictEqual(url.searchParams.get('v'), 'weekly');
    assert.strictEqual(url.searchParams.get('loading'), 'async');
    assert.strictEqual(url.searchParams.get('callback'), '__linkmiaGoogleMapsReady');
    assert.strictEqual(url.searchParams.get('auth_referrer_policy'), 'origin');
    assert.strictEqual(url.searchParams.has('libraries'), false,
      'unused Places browser library must not be requested');
    assert.strictEqual(script.referrerPolicy, 'strict-origin-when-cross-origin');
    realm.window.google = { maps: { ready: true } };
    realm.window.__linkmiaGoogleMapsReady();
    assert.strictEqual(await pending, realm.window.google.maps);
  });

  await check('loader is single-flight and appends exactly one script', async () => {
    const realm = makeRealm();
    const first = realm.window.LinkMiaMapsLoader.load();
    const second = realm.window.LinkMiaMapsLoader.load();
    assert.strictEqual(first, second);
    assert.strictEqual(realm.appended.length, 1);
    realm.window.google = { maps: {} };
    realm.window.__linkmiaGoogleMapsReady();
    await Promise.all([first, second]);
  });

  await check('missing or malformed browser keys fail before any network request', async () => {
    for (const key of [null, '', 'not-a-key', 'AIza_short', `${VALID_KEY} whitespace`]) {
      const realm = makeRealm({ key });
      await assert.rejects(realm.window.LinkMiaMapsLoader.load(), /not configured/);
      assert.strictEqual(realm.appended.length, 0, `script appended for ${JSON.stringify(key)}`);
      assert.deepStrictEqual(realm.events.map((event) => event.detail.reason), ['configuration']);
    }
  });

  await check('network and authorization failures reject and emit sanitized reasons', async () => {
    const network = makeRealm();
    const networkPending = network.window.LinkMiaMapsLoader.load();
    network.appended[0].onerror();
    await assert.rejects(networkPending, /network/);
    assert.deepStrictEqual(network.events.map((event) => event.detail.reason), ['network']);

    const auth = makeRealm();
    const authPending = auth.window.LinkMiaMapsLoader.load();
    auth.window.gm_authFailure();
    await assert.rejects(authPending, /authorization/);
    assert.deepStrictEqual(auth.events.map((event) => event.detail.reason), ['authorization']);
  });

  await check('timeout and incomplete callbacks fail closed with no false readiness', async () => {
    const timeout = makeRealm();
    const timeoutPending = timeout.window.LinkMiaMapsLoader.load();
    assert.strictEqual(timeout.timers.size, 1);
    [...timeout.timers.values()][0]();
    await assert.rejects(timeoutPending, /timeout/);
    assert.deepStrictEqual(timeout.events.map((event) => event.detail.reason), ['timeout']);

    const incomplete = makeRealm();
    const incompletePending = incomplete.window.LinkMiaMapsLoader.load();
    incomplete.window.__linkmiaGoogleMapsReady();
    await assert.rejects(incompletePending, /callback completed without the API/);
    assert.deepStrictEqual(incomplete.events.map((event) => event.detail.reason), ['incomplete']);
  });

  await check('generated config is context-specific, public, and absent from Git', () => {
    assert.match(committedConfig, /apiKey:\s*null/);
    assert.ok(!committedConfig.includes('AIza'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkmia-maps-config-'));
    try {
      const prodFile = path.join(dir, 'prod.js');
      const result = generator.generateMapsBrowserConfig({
        env: { CONTEXT: 'production', GOOGLE_MAPS_BROWSER_API_KEY: VALID_KEY },
        outputPath: prodFile
      });
      assert.deepStrictEqual(
        { context: result.context, configured: result.configured },
        { context: 'production', configured: true }
      );
      assert.ok(fs.readFileSync(prodFile, 'utf8').includes(JSON.stringify(VALID_KEY)));
      assert.ok(!JSON.stringify(result).includes(VALID_KEY), 'result/log surface must not contain the key');

      const devFile = path.join(dir, 'dev.js');
      generator.generateMapsBrowserConfig({ env: { CONTEXT: 'dev' }, outputPath: devFile });
      assert.match(fs.readFileSync(devFile, 'utf8'), /apiKey:\s*null/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('production and preview builds refuse missing or malformed keys', () => {
    for (const context of ['production', 'deploy-preview', 'branch-deploy']) {
      assert.throws(() => generator.generateMapsBrowserConfig({
        env: { CONTEXT: context, GOOGLE_MAPS_BROWSER_API_KEY: 'bad' },
        outputPath: path.join(os.tmpdir(), `must-not-write-${context}.js`)
      }), new RegExp(`invalid for Netlify context ${context}`));
    }
  });

  await check('both map pages use the shared loader; clients never call the Railway loader', () => {
    for (const [name, source] of [
      ['booking', bookingPage], ['trip', tripPage], ['landing', landingPage], ['api config', apiConfig]
    ]) {
      assert.ok(!source.includes('/api/maps-script'), `${name} still references the Railway loader`);
    }
    for (const source of [bookingPage, tripPage]) {
      const configAt = source.indexOf('src="/maps-browser-config.js"');
      const loaderAt = source.indexOf('src="/maps-loader.js"');
      assert.ok(configAt > 0 && loaderAt > configAt, 'config must load before the shared loader');
    }
    assert.match(bookingPage, /LinkMiaMapsLoader\.load\(\)/);
    assert.match(tripPage, /LinkMiaMapsLoader\.load\(\)/);
  });

  await check('custom autocomplete is independent from the optional Maps loader', () => {
    const start = bookingPage.indexOf('async initializeAutocomplete()');
    const end = bookingPage.indexOf('async fetchSuggestions', start);
    const method = bookingPage.slice(start, end > start ? end : start + 7000);
    assert.ok(start > 0);
    assert.match(method, /import\('\.\/autocomplete\.js'\)/);
    assert.ok(!/google\.maps|importLibrary\(["']places/.test(method),
      'address search must not wait for Google Maps JavaScript');
  });

  await check('optional map consumers import their exact runtime libraries', () => {
    for (const [name, source] of [['booking', bookingPage], ['trip', tripPage]]) {
      assert.match(source, /importLibrary\(["']maps["']\)/, `${name} omits maps library`);
      assert.match(source, /importLibrary\(["']routes["']\)/, `${name} omits routes library`);
      assert.ok(!/importLibrary\(["']places["']\)/.test(source), `${name} still imports Places`);
    }
    assert.match(tripPage, /importLibrary\(["']marker["']\)/,
      'trip status constructs Marker and must import its library');
    assert.ok(!/importLibrary\(["']marker["']\)/.test(bookingPage),
      'booking map does not construct markers directly');
  });

  await check('only the newest delayed vehicle-map render creates and routes', async () => {
    const start = bookingPage.indexOf('async updateVehicleMap()');
    const end = bookingPage.indexOf('// Handle booking button click', start);
    assert.ok(start > 0 && end > start, 'updateVehicleMap source markers moved');
    const method = bookingPage.slice(start, end).trim();

    let releaseLibraries;
    const libraryGate = new Promise((resolve) => { releaseLibraries = resolve; });
    let mapCreations = 0;
    let routeCalls = 0;
    class FakeMap { constructor() { mapCreations++; } }
    class FakeRenderer { setDirections() {} }
    class FakeDirectionsService {
      route(_request, callback) {
        routeCalls++;
        callback({}, 'OK');
      }
    }
    const context = vm.createContext({
      window: { LinkMiaMapsLoader: { load: async () => ({}) } },
      google: { maps: {
        importLibrary: () => libraryGate,
        Map: FakeMap,
        DirectionsRenderer: FakeRenderer,
        DirectionsService: FakeDirectionsService,
        LatLng: class FakeLatLng {},
        TravelMode: { DRIVING: 'DRIVING' },
        DirectionsStatus: { OK: 'OK' }
      } },
      console
    });
    const holder = vm.runInContext(`({ ${method} })`, context);
    const app = {
      ...holder,
      els: { vehicleMap: {} },
      vehicleMap: null,
      state: {
        mode: 'dropoff',
        ui: { currentPanel: 'vehicle' },
        locations: {
          address: { address: 'Passenger-selected address' },
          airport: { code: 'MIA' }
        }
      },
      getAirportCoordinates: () => ({ lat: 25.8, lng: -80.3 })
    };

    const first = app.updateVehicleMap();
    await Promise.resolve();
    const second = app.updateVehicleMap();
    await Promise.resolve();
    releaseLibraries();
    await Promise.all([first, second]);
    assert.strictEqual(mapCreations, 1, 'a stale render created a second map');
    assert.strictEqual(routeCalls, 1, 'a stale render bought a second Directions request');
  });

  await check('leaving Vehicle while libraries load spends no map route', async () => {
    const start = bookingPage.indexOf('async updateVehicleMap()');
    const end = bookingPage.indexOf('// Handle booking button click', start);
    const method = bookingPage.slice(start, end).trim();
    let releaseLibraries;
    const libraryGate = new Promise((resolve) => { releaseLibraries = resolve; });
    let mapCreations = 0;
    let routeCalls = 0;
    const context = vm.createContext({
      window: { LinkMiaMapsLoader: { load: async () => ({}) } },
      google: { maps: {
        importLibrary: () => libraryGate,
        Map: class FakeMap { constructor() { mapCreations++; } },
        DirectionsRenderer: class FakeRenderer {},
        DirectionsService: class FakeDirectionsService {
          route() { routeCalls++; }
        },
        LatLng: class FakeLatLng {},
        TravelMode: { DRIVING: 'DRIVING' },
        DirectionsStatus: { OK: 'OK' }
      } },
      console
    });
    const holder = vm.runInContext(`({ ${method} })`, context);
    const app = {
      ...holder,
      els: { vehicleMap: {} },
      vehicleMap: null,
      state: {
        mode: 'dropoff',
        ui: { currentPanel: 'vehicle' },
        locations: {
          address: { address: 'Passenger-selected address' },
          airport: { code: 'MIA' }
        }
      },
      getAirportCoordinates: () => ({ lat: 25.8, lng: -80.3 })
    };

    const pending = app.updateVehicleMap();
    await Promise.resolve();
    app.state.ui.currentPanel = 'when';
    releaseLibraries();
    await pending;
    assert.strictEqual(mapCreations, 0);
    assert.strictEqual(routeCalls, 0);
  });

  await check('an older Directions callback cannot overwrite a newer map', async () => {
    const start = bookingPage.indexOf('async updateVehicleMap()');
    const end = bookingPage.indexOf('// Handle booking button click', start);
    const method = bookingPage.slice(start, end).trim();
    const callbacks = [];
    const rendered = [];
    const context = vm.createContext({
      window: { LinkMiaMapsLoader: { load: async () => ({}) } },
      google: { maps: {
        DirectionsStatus: { OK: 'OK' },
        TravelMode: { DRIVING: 'DRIVING' },
        LatLng: class FakeLatLng {}
      } },
      console
    });
    const holder = vm.runInContext(`({ ${method} })`, context);
    const app = {
      ...holder,
      els: { vehicleMap: {} },
      vehicleMap: {},
      directionsRenderer: { setDirections(result) { rendered.push(result.id); } },
      directionsService: { route(_request, callback) { callbacks.push(callback); } },
      state: {
        mode: 'dropoff',
        ui: { currentPanel: 'vehicle' },
        locations: {
          address: { address: 'First address' },
          airport: { code: 'MIA' }
        }
      },
      getAirportCoordinates: () => ({ lat: 25.8, lng: -80.3 })
    };

    await app.updateVehicleMap();
    app.state.locations.address = { address: 'Second address' };
    await app.updateVehicleMap();
    assert.strictEqual(callbacks.length, 2);
    callbacks[1]({ id: 'new' }, 'OK');
    callbacks[0]({ id: 'old' }, 'OK');
    assert.deepStrictEqual(rendered, ['new']);
  });

  await check('service worker refreshes loader code but never caches generated key config', () => {
    assert.match(serviceWorker, /CACHE_NAME = 'linkmia-v1\.3\.23'/);
    assert.match(serviceWorker, /'\/maps-loader\.js'/);
    assert.match(serviceWorker, /url\.pathname === '\/maps-browser-config\.js'/);
    const staticList = serviceWorker.slice(
      serviceWorker.indexOf('STATIC_CACHE_URLS'),
      serviceWorker.indexOf('];', serviceWorker.indexOf('STATIC_CACHE_URLS'))
    );
    assert.ok(!staticList.includes('maps-browser-config.js'));
    assert.match(serviceWorker, /runtimeCache\.delete\('\/maps-browser-config\.js'\)/,
      'activation must purge a config cached by the prior worker');
  });

  await check('service worker behavior bypasses generated config but handles loader code', () => {
    const listeners = {};
    const swContext = vm.createContext({
      self: {
        location: { origin: 'https://linkmia.com' },
        clients: { claim: async () => {} },
        skipWaiting: async () => {},
        addEventListener(type, fn) { listeners[type] = fn; }
      },
      caches: {
        open: async () => ({ add: async () => {}, put: async () => {}, delete: async () => {} }),
        keys: async () => [],
        match: async () => null,
        delete: async () => true
      },
      fetch: async () => ({ ok: false }),
      URL,
      Response: class FakeResponse {},
      console
    });
    vm.runInContext(serviceWorker, swContext, { filename: 'service-worker.js' });
    assert.strictEqual(typeof listeners.fetch, 'function');

    const invokesRespondWith = (pathname) => {
      let called = false;
      listeners.fetch({
        request: {
          method: 'GET',
          url: `https://linkmia.com${pathname}`,
          mode: 'same-origin'
        },
        respondWith() { called = true; }
      });
      return called;
    };
    assert.strictEqual(invokesRespondWith('/maps-browser-config.js'), false);
    assert.strictEqual(invokesRespondWith('/maps-loader.js'), true);
  });

  await check('Netlify generates the config and serves it no-store', () => {
    assert.match(netlify, /command = "node scripts\/generate-maps-browser-config\.js"/);
    const headerAt = netlify.indexOf('for = "/maps-browser-config.js"');
    const nextHeader = netlify.indexOf('[[headers]]', headerAt + 1);
    const block = netlify.slice(headerAt, nextHeader);
    assert.match(block, /Cache-Control = "private, no-store, max-age=0"/);
  });

  await check('the existing private Railway key and loader remain separate during transition', () => {
    const proxy = read('backend/api-proxy/server.js');
    assert.match(proxy, /process\.env\.GOOGLE_MAPS_API_KEY/,
      'Railway REST calls still need their private key');
    assert.match(proxy, /app\.get\('\/api\/maps-script'/,
      'one-release stale-client compatibility route is intentionally retained');
    assert.ok(!loaderSource.includes('GOOGLE_MAPS_API_KEY'));
    assert.ok(!loaderSource.includes('reliable-warmth-production'));
  });

  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})().catch((error) => {
  console.error(`\nFAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
