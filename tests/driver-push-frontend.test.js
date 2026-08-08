// Driver PWA Push — frontend/service-worker harness.
//
// Run: node tests/driver-push-frontend.test.js
//
// Layer 1 (BEHAVIOR): driver-sw.js runs for real under `vm` with a fake
// SW global — proving defensive payload parsing, per-booking tag
// rendering, rideId validation/encoding, and focus-vs-open click
// behavior.
// Layer 2 (STATIC): source-shape assertions on driver.html and the
// other push surfaces (state precedence, tap-only permission, sign-out
// ordering, deep-link race safety, manifest identity, root-SW
// separation, redirect, cache bump).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }
async function checkAsync(name, fn) { await fn(); passed++; console.log('✓ ' + name); }

// ---------- layer 1: driver-sw.js under vm ----------
function makeSwHarness({ windows = [] } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const focused = [];
  const messaged = [];
  const wins = windows.map((url) => ({
    url,
    focus: async function () { focused.push(url); },
    postMessage(msg) { messaged.push(msg); }
  }));
  const selfObj = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {},
    registration: {
      showNotification: async (title, opts) => { shown.push({ title, opts }); }
    },
    clients: {
      claim: async () => {},
      matchAll: async () => wins,
      openWindow: async (url) => { opened.push(url); }
    }
  };
  const context = {
    self: selfObj,
    URL,
    encodeURIComponent,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(read('driver-sw.js'), context, { filename: 'driver-sw.js' });
  const fire = async (type, event) => {
    let pending = null;
    event.waitUntil = (p) => { pending = p; };
    listeners[type](event);
    if (pending) await pending;
  };
  return { fire, shown, opened, focused, messaged };
}

const RIDE = '123e4567-e89b-42d3-a456-426614174000';
const pushEvent = (data) => ({
  data: data === undefined ? null : {
    json: () => {
      if (data === 'MALFORMED') throw new Error('bad json');
      return data;
    }
  }
});
const clickEvent = (rideId) => ({
  notification: { close() {}, data: { rideId } }
});
(async () => {
  let h = makeSwHarness();
  await h.fire('push', pushEvent({
    type: 'ride', rideId: RIDE, title: 'LinkMia Driver',
    body: 'Ride LM-TEST — readiness check due. Open to confirm.', tag: 'rdy-abc'
  }));
  check('SW push: minimal payload rendered with the per-booking tag', () => {
    assert.strictEqual(h.shown.length, 1);
    assert.strictEqual(h.shown[0].opts.tag, 'rdy-abc');
    assert.strictEqual(h.shown[0].opts.data.rideId, RIDE);
  });

  h = makeSwHarness();
  await h.fire('push', pushEvent('MALFORMED'));
  check('SW push: malformed payload -> generic notification, no throw', () => {
    assert.strictEqual(h.shown.length, 1);
    assert.strictEqual(h.shown[0].title, 'LinkMia Driver');
    assert.strictEqual(h.shown[0].opts.body, 'Open LinkMia Driver');
    assert.strictEqual(h.shown[0].opts.data.rideId, null);
  });

  h = makeSwHarness();
  await h.fire('push', pushEvent({ rideId: 'javascript:alert(1)', body: 'x' }));
  check('SW push: non-UUID rideId rejected at the door', () => {
    assert.strictEqual(h.shown[0].opts.data.rideId, null);
  });

  h = makeSwHarness();
  await h.fire('notificationclick', clickEvent(RIDE));
  check('SW click, no window: opens /driver?ride=<validated id>', () => {
    assert.deepStrictEqual(h.opened, [`/driver?ride=${RIDE}`]);
  });

  h = makeSwHarness();
  await h.fire('notificationclick', clickEvent('"><img src=x>'));
  check('SW click, invalid rideId: opens bare /driver — never reaches a URL', () => {
    assert.deepStrictEqual(h.opened, ['/driver']);
  });

  h = makeSwHarness({ windows: ['https://linkmia.example/driver?x=1'] });
  await h.fire('notificationclick', clickEvent(RIDE));
  check('SW click, existing /driver window: focus + postMessage, NO new window', () => {
    assert.strictEqual(h.opened.length, 0);
    assert.strictEqual(h.focused.length, 1);
    // field-wise compare: vm-created objects have a different realm prototype
    assert.strictEqual(h.messaged.length, 1);
    assert.strictEqual(h.messaged[0].type, 'open-ride');
    assert.strictEqual(h.messaged[0].rideId, RIDE);
  });

  // ---------- driver.html fresh-subscription helper under vm ----------
  const driver = read('driver.html');
  const helperStart = driver.indexOf('async function subscribeFresh(');
  const helperEnd = driver.indexOf('// The ONLY place permission is ever requested', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'subscribeFresh helper extractable');
  const subscribeFresh = vm.runInNewContext(
    driver.slice(helperStart, helperEnd) + '\nsubscribeFresh;',
    { Error }
  );

  await checkAsync('fresh re-enable fails closed when the stale subscription remains', async () => {
    let subscribeCalls = 0;
    const stale = {
      endpoint: 'https://web.push.apple.com/OLD',
      unsubscribe: async () => { throw new Error('unsubscribe failed'); }
    };
    const reg = { pushManager: {
      getSubscription: async () => stale,
      subscribe: async () => { subscribeCalls++; return { endpoint: 'NEW' }; }
    } };
    await assert.rejects(() => subscribeFresh(reg, {}, stale), /stale_subscription_remains/);
    assert.strictEqual(subscribeCalls, 0, 'must not subscribe or POST while stale endpoint remains');
  });

  await checkAsync('fresh re-enable removes old endpoint and accepts a different replacement', async () => {
    const stale = {
      endpoint: 'https://web.push.apple.com/OLD',
      unsubscribe: async () => true
    };
    const fresh = { endpoint: 'https://web.push.apple.com/NEW', unsubscribe: async () => true };
    const reg = { pushManager: {
      getSubscription: async () => null,
      subscribe: async () => fresh
    } };
    assert.strictEqual(await subscribeFresh(reg, {}, stale), fresh);
  });

  await checkAsync('push service reusing the known-dead endpoint is rejected and never registered', async () => {
    let cleaned = false;
    const stale = {
      endpoint: 'https://web.push.apple.com/OLD',
      unsubscribe: async () => true
    };
    const reused = {
      endpoint: stale.endpoint,
      unsubscribe: async () => { cleaned = true; return true; }
    };
    const reg = { pushManager: {
      getSubscription: async () => null,
      subscribe: async () => reused
    } };
    await assert.rejects(() => subscribeFresh(reg, {}, stale), /push_service_reused_stale_endpoint/);
    assert.strictEqual(cleaned, true);
  });

  // ---------- layer 2: static shape ----------
  check('state precedence: install_required decided before unsupported, then denied', () => {
    const i1 = driver.indexOf("{ state: 'install_required' }");
    const i2 = driver.indexOf("{ state: 'unsupported' }");
    const i3 = driver.indexOf("{ state: 'denied' }");
    assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0);
    assert.ok(i1 < i2 && i2 < i3, 'iOS Safari must hear "install first", not "unsupported"');
  });
  check('re-enable routes expired/mismatched subscriptions through the verified-fresh helper', () => {
    const fnIdx = driver.indexOf('async function enablePush()');
    const postIdx = driver.indexOf('await postSubscription(sub)', fnIdx);
    const expiredIdx = driver.indexOf("info.state === 'expired'", fnIdx);
    const fpIdx = driver.indexOf('sha256Hex(sub.endpoint)', fnIdx);
    const refreshIdx = driver.indexOf('subscribeFresh(reg, appKey, sub)', fnIdx);
    assert.ok(fnIdx >= 0 && postIdx > fnIdx);
    assert.ok(expiredIdx > fnIdx && expiredIdx < postIdx);
    assert.ok(fpIdx > fnIdx && fpIdx < postIdx);
    assert.ok(refreshIdx > fnIdx && refreshIdx < postIdx);
  });
  check('UI never claims Push is enabled while server VAPID configuration is unavailable', () => {
    const configGate = driver.indexOf("info.pushConfigured === false");
    const enabledReturn = driver.indexOf("return { state: 'enabled'");
    assert.ok(configGate >= 0 && configGate < enabledReturn);
    assert.ok(driver.includes("state: 'unavailable'"));
  });
  check('permission is requested ONLY inside the explicit Enable tap', () => {
    const occurrences = driver.split('Notification.requestPermission').length - 1;
    assert.strictEqual(occurrences, 1, 'exactly one requestPermission call site');
    const fnIdx = driver.indexOf('async function enablePush()');
    const reqIdx = driver.indexOf('Notification.requestPermission');
    assert.ok(fnIdx >= 0 && reqIdx > fnIdx, 'the call lives inside enablePush');
    assert.ok(!/tryUnlock[\s\S]{0,600}requestPermission/.test(driver),
      'login flow must never request permission');
  });
  check('sign-out ordering: bounded push cleanup first, auth.signOut() in finally', () => {
    const handlerIdx = driver.indexOf("$('signOutLink').addEventListener");
    const cleanupIdx = driver.indexOf('cleanupPushOnSignOut()', handlerIdx);
    const raceIdx = driver.indexOf('Promise.race', handlerIdx);
    const finallyIdx = driver.indexOf('finally', handlerIdx);
    const signOutIdx = driver.indexOf('auth.signOut()', handlerIdx);
    assert.ok(cleanupIdx > handlerIdx && raceIdx > handlerIdx);
    assert.ok(finallyIdx > cleanupIdx && signOutIdx > finallyIdx,
      'signOut must run in finally, after the bounded cleanup');
  });
  check('server DELETE runs while the JWT is still valid (before any unsubscribe)', () => {
    const fnIdx = driver.indexOf('async function cleanupPushOnSignOut()');
    const delIdx = driver.indexOf("method: 'DELETE'", fnIdx);
    const unsubIdx = driver.indexOf('unsubscribe()', fnIdx);
    assert.ok(fnIdx >= 0 && delIdx > fnIdx && unsubIdx > delIdx);
  });
  check('deep-link race safety: pendingRideId preserved until the card renders', () => {
    assert.ok(driver.includes('applyPendingRide()'), 'render must apply the pending ride');
    const fnIdx = driver.indexOf('function applyPendingRide()');
    const guardIdx = driver.indexOf('if (!card) return;', fnIdx);
    assert.ok(fnIdx >= 0 && guardIdx > fnIdx, 'missing card must keep the request pending');
    assert.ok(/UUID_RE\.test\(rid\)/.test(driver), 'ride param is UUID-validated');
  });

  const manifest = JSON.parse(read('driver-manifest.json'));
  check('driver manifest: stable id, /driver scope, separate icon purposes', () => {
    assert.strictEqual(manifest.id, '/driver');
    assert.strictEqual(manifest.scope, '/driver');
    const purposes = manifest.icons.map((i) => i.purpose);
    assert.ok(purposes.includes('any') && purposes.includes('maskable'));
    assert.ok(!purposes.includes('any maskable'), 'purposes must be separate entries');
  });
  check('driver.html carries the dedicated 180×180 apple-touch-icon', () => {
    assert.ok(driver.includes('apple-touch-icon" href="/images/driver-icon-180.png'));
    assert.ok(fs.existsSync(path.join(repoRoot, 'images/driver-icon-180.png')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'images/driver-icon-192.png')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'images/driver-icon-512.png')));
  });

  const rootSw = read('service-worker.js');
  check('root SW: /driver excluded, push listeners gone, cache bumped', () => {
    assert.ok(rootSw.includes("url.pathname.startsWith('/driver')"));
    assert.ok(!rootSw.includes('showNotification'), 'no second push listener may exist');
    assert.ok(/CACHE_NAME = 'linkmia-v1\.3\.13'/.test(rootSw));
  });
  const driverSw = read('driver-sw.js');
  check('driver SW: no fetch handler — the driver app is never cached', () => {
    assert.ok(!driverSw.includes("addEventListener('fetch'"));
    assert.ok(driverSw.includes('skipWaiting'));
    assert.ok(driverSw.includes('clients.claim'));
  });
  const toml = read('netlify.toml');
  check('netlify.toml routes the subscription endpoint', () => {
    assert.ok(toml.includes('/api/driver-push-subscription'));
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
