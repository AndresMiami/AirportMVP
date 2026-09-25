// The account door (2026-09-24) — executed.
//
// Run: node tests/account-door.test.js
//
// Sign out moved into the traveler sheet on 2026-09-11 when the pills stepped
// aside, which left it reachable only from Vehicle, mid-booking. This suite
// pins the door that fixes that: one button, in the card, from any stage.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'css/style.css'), 'utf8');
const modal = fs.readFileSync(path.join(repoRoot, 'js/passenger-modal.js'), 'utf8');

let checks = 0;
const results = [];
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }

// Pull showAccountButton out and run it for real against a fake DOM, so the
// initial is proved rather than eyeballed.
function runShowAccountButton({ profile, session }) {
  const src = page.match(/function showAccountButton\(\)[\s\S]*?\n        \}/);
  assert.ok(src, 'showAccountButton must be findable');
  const els = {
    accountBtn: { hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    accountInitial: { textContent: '' }
  };
  const ctx = {
    currentProfile: profile,
    currentSession: session,
    document: { getElementById: (id) => els[id] || null }
  };
  vm.createContext(ctx);
  vm.runInContext(src[0] + '\n;showAccountButton();', ctx, { filename: 'account-door.js' });
  return els;
}

check('the door lives inside the booking card, not in the page chrome', () => {
  const card = page.match(/<div class="booking-container" id="bookingContainer">([\s\S]*?)<div class="panels-wrapper"/);
  assert.ok(card, 'the card must be findable');
  assert.match(card[1], /id="accountBtn"/, 'the button belongs to the card, so it travels with every stage');
});

check('it opens the traveler sheet — the only place Sign out lives', () => {
  assert.match(page, /id="accountBtn"[\s\S]{0,200}?PassengerModal\.getInstance\(\)\.open\(\)/,
    'the door must open the sheet');
  assert.match(modal, /id="passengerSignOutBtn"[^>]*onclick="window\.logout/,
    'and that sheet must still carry Sign out — if this moves, the door leads nowhere');
});

check('it costs the card no height', () => {
  const rule = css.match(/\.account-btn \{[\s\S]*?\}/);
  assert.ok(rule, '.account-btn must be styled');
  assert.match(rule[0], /position:\s*absolute/,
    'the card exists so every stage fits the screen; the door must stay out of the flow');
  assert.match(css, /\.booking-container \{ position: relative; \}/,
    'absolute positioning needs the card as its containing block');
});

check('the progress steps are held clear of it', () => {
  assert.match(css, /\.booking-container:has\(\.account-btn:not\(\[hidden\]\)\)\s*\.progress-bar\s*\{[\s\S]*?padding-right/,
    'step 3 would otherwise slide under the button at narrow widths');
});

check('the touch target is 44x44 without a 44px circle', () => {
  const before = css.match(/\.account-btn::before \{[\s\S]*?\}/);
  assert.ok(before, 'the overhanging hit area must exist');
  assert.match(before[0], /width:\s*44px/);
  assert.match(before[0], /height:\s*44px/);
  const btn = css.match(/\.account-btn \{[\s\S]*?\}/)[0];
  assert.match(btn, /width:\s*26px/, "26px centres in the 31px header band; 32px crossed its rule");
});

check('it starts hidden and is revealed only once a session is proved', () => {
  assert.match(page, /id="accountBtn"[^>]*\shidden/, 'no door before the auth gate answers');
  assert.match(page, /addAuthPill\(true\);[\s\S]{0,500}?showAccountButton\(\);/,
    'revealed on the same path that proves the session');
});

check('the initial comes from the name, then the email, then a neutral mark', () => {
  let els = runShowAccountButton({ profile: { name: 'Andres Corcoba', email: 'a@b.com' }, session: null });
  assert.strictEqual(els.accountInitial.textContent, 'A');
  assert.strictEqual(els.accountBtn.attrs['aria-label'], 'Account — Andres Corcoba');
  assert.strictEqual(els.accountBtn.hidden, false);

  els = runShowAccountButton({ profile: { name: '', email: 'tiffany@example.com' }, session: null });
  assert.strictEqual(els.accountInitial.textContent, 'T', 'a nameless profile still gets a usable door');
  assert.strictEqual(els.accountBtn.attrs['aria-label'], 'Account — tiffany@example.com');

  els = runShowAccountButton({ profile: null, session: { user: { email: 'z@example.com' } } });
  assert.strictEqual(els.accountInitial.textContent, 'Z', 'the session is the last resort');

  els = runShowAccountButton({ profile: null, session: null });
  assert.strictEqual(els.accountInitial.textContent, '·', 'never blank — a blank circle reads as broken');
  assert.strictEqual(els.accountBtn.attrs['aria-label'], 'Account');
  assert.strictEqual(els.accountBtn.hidden, false);
});

check('a leading emoji or accent does not produce an empty initial', () => {
  const els = runShowAccountButton({ profile: { name: '🚕 Andres', email: '' }, session: null });
  assert.strictEqual(els.accountInitial.textContent, 'A',
    'the first LETTER is taken, not the first character');
});

check('a broken door can never cost a passenger their session', () => {
  // showAccountButton runs inside the auth gate's try/catch. Without isolation
  // any exception in it is caught as an auth failure and the passenger is shown
  // "we can't verify your sign-in" instead of a booking form. This is the pin:
  // the call site must swallow its own faults.
  assert.match(page, /try \{ showAccountButton\(\); \} catch \(_\) \{\}/,
    'the call must be isolated from the gate it runs inside');
  const gate = page.match(/addAuthPill\(true\);[\s\S]{0,400}?overlay\.remove\(\);/);
  assert.ok(gate, 'the gate success path must be findable');
  assert.ok(gate[0].indexOf('try { showAccountButton(); } catch (_) {}') <
            gate[0].indexOf('overlay.remove()'),
    'and it must not sit between the catch and the overlay coming down');
});

check('the old pill still covers the landing screen', () => {
  assert.match(page, /function addAuthPill/, 'the landing-screen pill is untouched');
  assert.match(css, /body:has\(\.booking-container\.active\) #userHeader/,
    'and it still steps aside while the card is open — the door replaces it there, not everywhere');
});

async function run() {
  process.exitCode = 1;
  for (const { name, fn } of queue) {
    try { await fn(); checks += 1; results.push(`  ✓ ${name}`); }
    catch (error) {
      results.push(`  ✗ ${name}\n      ${error.message}`);
      results.forEach((l) => console.log(l));
      console.log(`\nFAILED at: ${name}`);
      process.exit(1);
    }
  }
  results.forEach((l) => console.log(l));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
  process.exitCode = 0;
}
run().catch((e) => { console.error(e); process.exit(1); });
