// Frontend account-gate harness — the booking page's client protections.
//
// Run: node tests/booking-gate-frontend.test.js
//
// Two layers, following the tests/passenger-polling.test.js precedent:
//  1. BEHAVIOR: the auth-gate inline script (indexMVP's FIRST script
//     block) runs for real under `vm` with a fake DOM — proving the gate
//     redirects, retries, or admits based on the actual session and account-
//     continuity results.
//  2. STATIC: source-shape assertions on the main app block and the
//     other gate files (initializeApp gated, fresh-session ordering,
//     fake success removed, inert guest control, entry points, SW bump).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');

const indexMvp = read('indexMVP.html');
const inlineBlocks = [...indexMvp.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]).filter((s) => s.trim());
assert.strictEqual(inlineBlocks.length, 2, 'expected the gate block + the app block');
const gateBlock = inlineBlocks[0];
const appBlock = inlineBlocks[1];

// ---------- fake DOM ----------
function makeElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    children: [],
    listeners: {},
    removed: false,
    innerHTML: '',
    textContent: '',
    id: null,
    appendChild(child) { el.children.push(child); return child; },
    insertAdjacentHTML() {},
    addEventListener(evt, fn) { (el.listeners[evt] = el.listeners[evt] || []).push(fn); },
    remove() { el.removed = true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    focus() {}
  };
  return el;
}

function makeHarness({ getSession, omitClient = false, profileResponse } = {}) {
  const created = [];
  const byId = new Map();
  const replaceCalls = [];
  let signOutCalls = 0;

  const document = {
    readyState: 'complete',
    body: makeElement('body'),
    createElement(tag) { const el = makeElement(tag); created.push(el); return el; },
    getElementById(id) {
      if (!byId.has(id)) { const el = makeElement('div'); el.id = id; byId.set(id, el); }
      return byId.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    head: makeElement('head')
  };
  const location = {
    search: '',
    hostname: 'linkmia.example',
    replace(url) { replaceCalls.push(url); },
    reload() {},
    href: ''
  };
  const storage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k)
    };
  };
  const context = {
    document,
    location,
    localStorage: storage(),
    sessionStorage: storage(),
    fetch: async () => profileResponse || ({
      ok: true,
      json: async () => ({ profile: null, ambassador: null, activeBooking: null })
    }),
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    JSON, Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval
  };
  context.window = context;
  if (!omitClient) {
    context.supabaseClient = {
      auth: {
        getSession,
        signOut: async () => { signOutCalls++; return {}; }
      }
    };
    context.window.supabaseClient = context.supabaseClient;
  }
  vm.createContext(context);
  vm.runInContext(gateBlock, context, { filename: 'indexMVP.html:gate-block' });
  const bootAuthReady = vm.runInContext('bootAuthReady', context);
  const overlay = created.find((el) => el.id === 'authGate');
  const settle = () => new Promise((res) => setImmediate(() => setImmediate(res)));
  return { context, created, byId, replaceCalls, bootAuthReady, overlay, settle,
    signOutCalls: () => signOutCalls,
    gateMsg: () => byId.get('authGateMsg') };
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('✓ ' + name); }

(async () => {
  // ---------- 1. gate behavior under vm ----------
  let h = makeHarness({ getSession: async () => ({ data: { session: null } }) });
  let authed = await h.bootAuthReady;
  await h.settle();
  check('signed-out direct entry: gate resolves false and bounces to /login.html', () => {
    assert.strictEqual(authed, false);
    assert.deepStrictEqual(h.replaceCalls, ['/login.html']);
    assert.ok(h.overlay, 'loading overlay must cover the page');
    assert.strictEqual(h.overlay.removed, false, 'overlay stays up until navigation lands');
  });

  h = makeHarness({ getSession: async () => { throw new Error('auth service down'); } });
  authed = await h.bootAuthReady;
  await h.settle();
  check('auth-check failure: honest Retry screen — no redirect, no boot, no guest fallback', () => {
    assert.strictEqual(authed, false);
    assert.deepStrictEqual(h.replaceCalls, [], 'must NOT redirect on an outage');
    const msg = h.gateMsg();
    assert.ok(/can't verify/i.test(msg.textContent), 'honest failure copy shown');
    assert.ok(msg.children.some((c) => c.textContent === 'Try again'), 'Retry button rendered');
  });

  h = makeHarness({ omitClient: true, getSession: async () => ({}) });
  authed = await h.bootAuthReady;
  await h.settle();
  check('auth client missing entirely: also the Retry screen, never guest mode', () => {
    assert.strictEqual(authed, false);
    assert.deepStrictEqual(h.replaceCalls, []);
    assert.ok(h.gateMsg().children.some((c) => c.textContent === 'Try again'));
  });

  h = makeHarness({
    getSession: async () => ({
      data: { session: { access_token: 'tok', user: { email: 'pat@example.com' } } }
    }),
    profileResponse: { ok: false, status: 500, json: async () => ({ error: 'lookup failed' }) }
  });
  authed = await h.bootAuthReady;
  await h.settle();
  check('continuity-check failure: gate stays closed on Retry, never an empty booking form', () => {
    assert.strictEqual(authed, false);
    assert.deepStrictEqual(h.replaceCalls, []);
    assert.strictEqual(h.overlay.removed, false);
    assert.ok(h.gateMsg().children.some((c) => c.textContent === 'Try again'));
  });

  h = makeHarness({
    getSession: async () => ({
      data: { session: { access_token: 'revoked', user: { email: 'pat@example.com' } } }
    }),
    profileResponse: { ok: false, status: 401, json: async () => ({ error: 'Invalid session' }) }
  });
  authed = await h.bootAuthReady;
  await h.settle();
  check('server-revoked session: clears local auth and returns to login instead of Retry loop', () => {
    assert.strictEqual(authed, false);
    assert.strictEqual(h.signOutCalls(), 1);
    assert.deepStrictEqual(h.replaceCalls, ['/login.html']);
    assert.strictEqual(h.overlay.removed, false);
    assert.ok(!h.gateMsg()?.children.some((c) => c.textContent === 'Try again'));
  });

  h = makeHarness({
    getSession: async () => ({
      data: { session: { access_token: 'tok', user: { email: 'pat@example.com' } } }
    })
  });
  authed = await h.bootAuthReady;
  await h.settle();
  check('valid session: gate resolves true, overlay removed, no redirect', () => {
    assert.strictEqual(authed, true);
    assert.deepStrictEqual(h.replaceCalls, []);
    assert.strictEqual(h.overlay.removed, true);
  });

  // ---------- 2. static shape: the app block ----------
  check('AirportBookingApp initializes ONLY behind the resolved gate', () => {
    const gateIdx = appBlock.indexOf('Promise.resolve(bootAuthReady)');
    const guardIdx = appBlock.indexOf('if (!authed) return;');
    const bootIdx = appBlock.indexOf('new AirportBookingApp');
    assert.ok(gateIdx >= 0 && guardIdx >= 0 && bootIdx >= 0);
    assert.ok(gateIdx < guardIdx && guardIdx < bootIdx,
      'the app must be constructed inside the authed branch');
    assert.strictEqual(appBlock.indexOf('new AirportBookingApp', bootIdx + 1), -1,
      'no second ungated construction path');
  });
  check('fresh-session check runs BEFORE the trip_ write and the previous-ride cancel', () => {
    const sessionIdx = appBlock.indexOf('session: submitSession');
    const tripWriteIdx = appBlock.indexOf('localStorage.setItem(`trip_');
    const cancelIdx = appBlock.indexOf("action: 'cancel'");
    assert.ok(sessionIdx >= 0 && tripWriteIdx >= 0 && cancelIdx >= 0);
    assert.ok(sessionIdx < tripWriteIdx, 'session must be verified before the local trip_ record');
    assert.ok(sessionIdx < cancelIdx,
      'an expired session must never cancel an existing ride it cannot replace');
  });
  check('failed/401 booking can never open the trip sheet; fake success removed', () => {
    assert.ok(appBlock.includes('response.status === 401'));
    const guardIdx = appBlock.indexOf('if (!response.ok || !result?.bookingId)');
    const sheetIdx = appBlock.indexOf('this.showTripSheet(supabaseBookingId)');
    assert.ok(guardIdx >= 0 && sheetIdx >= 0 && guardIdx < sheetIdx,
      'only a real database bookingId reaches showTripSheet');
    assert.ok(!appBlock.includes('showBookingConfirmation(tripId, bookingData, null)'),
      'the false local-success fallback must stay removed');
  });
  check('account truth resolves before boot and recovery reopens the trusted trip exactly once', () => {
    assert.ok(gateBlock.includes('currentActiveBooking = activeBooking'));
    assert.ok(gateBlock.includes("localStorage.setItem('lm_last_trip_id', bookingId)"));
    assert.ok(gateBlock.includes('activeBookingResumed = true'));
    const profileIdx = gateBlock.indexOf("await fetch('/api/profile'");
    const removeOverlayIdx = gateBlock.indexOf('overlay.remove()', profileIdx);
    assert.ok(profileIdx >= 0 && removeOverlayIdx > profileIdx,
      'the booking form must stay covered until account continuity is known');
    const constructIdx = appBlock.indexOf('window.airportApp = new AirportBookingApp()');
    const resumeIdx = appBlock.indexOf('resumeAccountBookingWhenReady()', constructIdx);
    assert.ok(constructIdx >= 0 && resumeIdx > constructIdx,
      'the startup race must be retried after the app instance exists');
  });
  check('server duplicate response reopens the existing sheet, never creates local success', () => {
    const conflictIdx = appBlock.indexOf('response.status === 409 && result?.existingBookingId');
    const removeIdx = appBlock.indexOf('localStorage.removeItem(\`trip_\${tripId}\`)', conflictIdx);
    const sheetIdx = appBlock.indexOf('this.showTripSheet(result.existingBookingId)', conflictIdx);
    assert.ok(conflictIdx >= 0 && removeIdx > conflictIdx && sheetIdx > removeIdx);
  });
  check('replacement cancellation is awaited before a new create request', () => {
    const cancelIdx = appBlock.indexOf("const cancelResponse = await fetch('/api/booking-status'");
    const createIdx = appBlock.indexOf("const response = await fetch('/api/create-booking'");
    assert.ok(cancelIdx >= 0 && createIdx > cancelIdx);
  });
  check('a failed attempt removes its provisional trip_ record', () => {
    assert.ok(appBlock.includes('localStorage.removeItem(`trip_${tripId}`)'));
  });

  // ---------- 2b. static shape: the other gate surfaces ----------
  const login = read('login.html');
  check('guest checkout is visible but has NO link, handler, or keyboard activation', () => {
    const m = login.match(/<div class="guest-link">([\s\S]*?)<\/div>/);
    assert.ok(m, 'guest-link block must remain visible');
    const block = m[1];
    assert.ok(block.includes('Guest checkout — coming later'), 'exact label required');
    assert.ok(!/<a[\s>]/.test(block), 'no anchor');
    assert.ok(!/onclick|href=|tabindex|<button/i.test(block), 'no activation path');
    assert.ok(!login.includes('Continue as guest'), 'the working guest link is gone');
  });
  const landing = read('index.html');
  check('homepage CTA leads to the sign-in front door', () => {
    assert.ok(landing.includes('href="/login.html"'));
    assert.ok(!landing.includes('href="/indexMVP.html?book=1"'));
  });
  const manifest = JSON.parse(read('manifest.json'));
  check('PWA "Book" shortcut leads to the sign-in front door', () => {
    const book = manifest.shortcuts.find((s) => s.short_name === 'Book');
    assert.strictEqual(book.url, '/login.html');
  });
  const sw = read('service-worker.js');
  check('service-worker cache includes the revoked-session bump (v1.3.16+)', () => {
    const m = sw.match(/CACHE_NAME = 'linkmia-v1\.3\.(\d+)'/);
    assert.ok(m, 'versioned cache name required');
    assert.ok(parseInt(m[1], 10) >= 16,
      'cache must never regress below the revoked-session continuity bump');
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
