// PR 1A — trip-sheet cancellation frontend: quote-first flow shape,
// honest wording, session attach, kill-switch fallback, untouched polling
// seals, indexMVP auth header, SW bump, and routing.
//
// Run: node tests/trip-cancel-frontend.test.js
//
// Static source-shape assertions (tests/booking-gate-frontend.test.js
// precedent); the behavioral vm harness for this page lives in
// tests/passenger-polling.test.js and executes the same script.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');

const trip = read('trip.html');
const tripScript = [...trip.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1];
const indexMvp = read('indexMVP.html');
const sw = read('service-worker.js');
const toml = read('netlify.toml');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}

// ---------- trip.html ----------
check('trip script compiles', () => {
  new vm.Script(tripScript); // throws on syntax error
});

check('markup: quote card with confirm + keep buttons', () => {
  for (const id of ['cancelQuoteCard', 'cancelQuoteLines', 'confirmCancelBtn', 'keepRideBtn']) {
    assert.ok(trip.includes(`id="${id}"`), `missing #${id}`);
  }
});

check('quote is requested BEFORE cancel, both against /api/cancel-booking', () => {
  const quoteAt = tripScript.indexOf("cancelApi('quote'");
  const cancelAt = tripScript.indexOf("cancelApi('cancel'");
  assert.ok(quoteAt > -1 && cancelAt > -1 && quoteAt < cancelAt);
  assert.ok(tripScript.includes("fetch('/api/cancel-booking'"));
});

check('final cancel carries the full reviewed expectation', () => {
  const block = tripScript.slice(tripScript.indexOf('expected: {'));
  for (const key of ['status:', 'feePercent:', 'policyAmount:', 'policyVersion:', 'pickupAt:']) {
    assert.ok(block.slice(0, 400).includes(key), `expected.${key.replace(':', '')} missing`);
  }
});

check('pending card is a plain free-cancellation sentence; the fee ledger waits for real amounts', () => {
  assert.ok(tripScript.includes('Your ride hasn’t been accepted yet, so cancelling is free.'));
  assert.ok(!tripScript.includes('Amount due today: $0'), 'no fee arithmetic on the free bracket');
  assert.ok(tripScript.includes('No payment will be collected during the pilot'),
    'pilot wording stays wired for the PR 2 fee brackets');
  assert.ok(!/\bcharged\b/i.test(tripScript), 'wording must not imply a card charge');
});

check('client never computes policy numbers (server values verbatim)', () => {
  assert.ok(tripScript.includes('renderQuoteLines'));
  assert.ok(!/price\s*\*\s*0\.5|feePercent\s*\*\s*price|\*\s*0\.5\b/.test(tripScript),
    'no client-side fee math');
});

check('401 gets an honest sign-in message; 409 is never success', () => {
  assert.ok(tripScript.includes('Please sign in to your LinkMia account to cancel'));
  assert.ok(tripScript.includes("if (current !== 'cancelled')"));
  assert.ok(tripScript.includes('Your driver already accepted this ride'));
});

check('kill switch: 503 falls back to the legacy flow with the same auth header', () => {
  assert.ok(tripScript.includes('res.status === 503'));
  assert.ok(tripScript.includes('legacyCancelFlow'));
  const legacy = tripScript.slice(tripScript.indexOf('async function legacyCancelFlow'));
  assert.ok(legacy.slice(0, 600).includes("fetch('/api/booking-status'"));
  assert.ok(legacy.slice(0, 600).includes('authHeaders(token)'));
});

check('session loader: lazy, deadline-bounded, degrades to guest on failure', () => {
  assert.ok(tripScript.includes("loadScript('https://unpkg.com/@supabase/supabase-js@2')"));
  assert.ok(tripScript.includes("loadScript('/supabase.js')"));
  const fn = tripScript.slice(tripScript.indexOf('async function getSessionToken'));
  const body = fn.slice(0, fn.indexOf('function authHeaders'));
  assert.ok(body.includes('withTimeout(supabaseLoadPromise'), 'CDN load must have a deadline');
  assert.ok(body.includes('catch'), 'token lookup must swallow load failures');
  assert.ok(body.includes('return null;'), 'failures resolve to the guest path');
});

check('status change closes the quote card; poll re-render cannot resurrect Cancel under it', () => {
  assert.ok(tripScript.includes('if (!isPending) hideQuoteCard()'));
  assert.ok(tripScript.includes("classList.toggle('hidden', !isPending || activeQuote !== null)"),
    'the open-card state must own the outer Cancel button across re-renders');
});

check('embedded success still hands off via lm-cancelled to the parent reset', () => {
  const fn = tripScript.slice(tripScript.indexOf('function onCancelConfirmed'));
  const body = fn.slice(0, 600);
  assert.ok(body.includes("type: 'lm-cancelled'"));
  assert.ok(body.includes('isEmbedded'));
  assert.ok(body.includes('location.origin'), 'postMessage stays origin-pinned');
});

check('network catch never claims certainty; a status check reveals the truth', () => {
  assert.ok(tripScript.includes("couldn\\'t confirm whether the cancellation went through"));
  assert.ok(!tripScript.includes('the booking was NOT cancelled'),
    'the old false-certainty wording must be gone');
});

check('stale quote while still pending re-shows fresh numbers, not a false driver message', () => {
  assert.ok(tripScript.includes("body.currentStatus === 'pending'"));
  assert.ok(tripScript.includes('The cancellation details changed — please review again.'));
});

check('polling seals untouched: cadences, budget, cutoffs, no manual refresh', () => {
  assert.ok(tripScript.includes('pending: 15000'));
  assert.ok(tripScript.includes('const REQUEST_BUDGET = 500'));
  assert.ok(tripScript.includes('const ABSOLUTE_MAX_MS = 6 * 3600000'));
  assert.ok(tripScript.includes('const MAX_POLL_FAILURES = 5'));
  assert.ok(!/manual.*refresh.*button/i.test(tripScript.replace(/there is no manual button/i, '')),
    'no manual refresh button may appear');
});

// ---------- indexMVP.html ----------
check('rebook auto-cancel sends the owner session token (ambassador dedupe fix)', () => {
  const at = indexMvp.indexOf("const cancelResponse = await fetch('/api/booking-status'");
  assert.ok(at > -1, 'rebook auto-cancel anchor missing');
  const block = indexMvp.slice(at, at + 1200);
  assert.ok(block.includes('Bearer ${submitSession.access_token}'), 'Authorization header missing');
  assert.ok(block.includes("action: 'cancel'"));
  // Fresh session is still fetched BEFORE the cancel side effect —
  // the anchor itself must exist for the ordering claim to mean anything
  const sessionAt = indexMvp.indexOf('session: submitSession');
  assert.ok(sessionAt > -1, 'fresh-session anchor missing');
  assert.ok(sessionAt < at);
});

// ---------- service worker + routing ----------
check('service worker cache bumped for the indexMVP change (v1.3.17+)', () => {
  const m = sw.match(/CACHE_NAME = 'linkmia-v(\d+)\.(\d+)\.(\d+)'/);
  assert.ok(m, 'CACHE_NAME missing');
  const [maj, min, pat] = m.slice(1).map(Number);
  assert.ok(maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 17))),
    `cache ${m[0]} must be >= 1.3.17`);
});

check('netlify.toml routes /api/cancel-booking', () => {
  assert.ok(toml.includes('from = "/api/cancel-booking"'));
  assert.ok(toml.includes('to = "/.netlify/functions/cancel-booking"'));
});

console.log('');
if (failures.length) {
  console.error(`${failures.length} FAILURE(S): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`ALL ${passed} CHECKS PASS`);
