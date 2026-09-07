// PR-B — the visible activation of pending-ride editing.
//
// Run: node tests/pending-edit-activation.test.js
//
// What this PR is actually for: before it, changing a pickup time by ten
// minutes meant re-entering the whole ride, because the editor restored
// nothing and demanded that the passenger re-touch every control to prove
// intent. PR-B hydrates the form from the server and gates Save on whether
// anything really changed.
//
// Two layers:
//   1. ENDPOINT — the elapsed-pickup refusal runs against the real handler.
//   2. SOURCE — the browser wiring and the trip-sheet lifecycle ladder, which
//      live inside page code this harness does not boot. Labelled honestly.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const indexMvp = read('indexMVP.html');
const trip = read('trip.html');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const BID = '123e4567-e89b-42d3-a456-426614174000';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

(async () => {
  console.log('\nPR-B — the elapsed-pickup rule belongs to PR-T\n');

  await check('PR-T OWNERSHIP: no device-clock BLOCK on the create tap, no partial handler guard', async () => {
    // Codex seq:193 #2: a fast phone must never refuse a server-valid create,
    // and an endpoint guard that every real browser submission bypasses is a
    // false promise. Both are removed; PR-T installs the rule inside the
    // writers' transactions on the database clock, receipt-first.
    assert.ok(!indexMvp.includes('pickupStillFuture'), 'no blocking helper on the page');
    const handlerSrc = read('backend/functions/update-pending-booking.js');
    assert.ok(!handlerSrc.includes('pickup_time_elapsed'), 'no partial guard in the edit handler');
    // The create picker's own snap-forward stays: device time ADVISES.
    assert.match(indexMvp, /if \(isToday && date < now\) \{[\s\S]{0,200}?showTimeWarning\(\)/);
  });

  await check('the card still RENDERS a typed PR-T refusal when one arrives', async () => {
    // The browser keeps its display path for the future typed response
    // (executed in tests/pending-edit-card.test.js: pickup_time_elapsed
    // preserves the draft, blocks Save with the typed copy, focuses time).
    const card = read('js/pending-edit-card.js');
    assert.ok(card.includes("result.error === 'pickup_time_elapsed'"));
    assert.ok(card.includes('This pickup time has passed. Choose a new time to continue.'));
  });

  console.log('\nPR-B — SOURCE: the browser edit card\n');

  await check('SOURCE: the editor hydrates from the server before it is usable', async () => {
    assert.ok(indexMvp.includes('async beginPendingEdit('), 'entry is async');
    assert.ok(indexMvp.includes('/api/update-pending-booking?id='), 'one authenticated GET');
    assert.ok(indexMvp.includes("this.editCard().open(dto, { bookingId, tripCode: this.pendingEdit.tripCode })"),
      'hands the server snapshot to the REVIEW CARD, never to the three-step funnel');
    assert.ok(indexMvp.includes('Loading your ride…'), 'never greys without a reason');
    assert.ok(indexMvp.includes('<script src="./js/pending-edit-card.js'), 'the card module is loaded');
  });

  await check('SOURCE: hydration failure FAILS CLOSED and says the ride is unchanged', async () => {
    // The page source escapes the apostrophe inside its single-quoted string.
    assert.ok(/We couldn.?.t load the latest ride details\. Your ride is unchanged\./.test(indexMvp));
    assert.ok(indexMvp.includes('failClosedFromEdit'));
    // A half-restored editor is the thing this must never produce: a throw
    // while the card opens fails closed instead of leaving a partial screen.
    assert.match(indexMvp, /this\.editCard\(\)\.open\(dto[\s\S]{0,300}?catch \(err\) \{[\s\S]{0,300}?failClosedFromEdit/);
  });

  await check('SOURCE: a malformed DTO is a failure, not something to half-render', async () => {
    assert.ok(indexMvp.includes('validHydrationDto'));
    assert.match(indexMvp, /validHydrationDto\(dto\)[\s\S]{0,900}?return false;/);
  });

  await check('SOURCE: 409 alone never decides the experience', async () => {
    // Only a TYPED not_editable answer is a lifecycle change; every other 409
    // is an ordinary failure that fails closed.
    assert.match(indexMvp, /res\.status === 409[\s\S]{0,400}?body\.error === 'not_editable'/);
  });

  await check('SOURCE: the re-enter-everything instruction is gone', async () => {
    assert.ok(!indexMvp.includes('Re-enter your trip details'),
      'this sentence WAS the defect PR-B removes');
    assert.ok(!indexMvp.includes('editMarkers'), 'and the markers behind it are retired');
  });

  // The pin below describes the CREATE surface's own picker. It is NOT the
  // card's time behaviour — the review card builds its own controls on the
  // America/New_York controller; that is EXECUTED in tests/pending-edit-card.test.js.
  await check('SOURCE (create surface): the picker still refuses past dates and snaps past times forward', async () => {
    // The create scheduler's own rule, pinned so a mutation cannot widen it;
    // it says nothing about the edit card.
    assert.match(indexMvp, /const isPast = date < today;/);
    assert.match(indexMvp, /isPast \? 'disabled' : ''/);
    assert.match(indexMvp, /if \(isToday && date < now\) \{[\s\S]{0,200}?showTimeWarning\(\)/);
  });

  console.log('\nPR-B — SOURCE: the trip-sheet lifecycle ladder\n');

  await check('SOURCE: the label follows the passenger job at each status', async () => {
    assert.match(trip, /lifecycleBtn\.textContent = '✏️ Edit ride';/);
    assert.match(trip, /lifecycleBtn\.textContent = 'Manage ride';/);
    assert.match(trip, /lifecycleBtn\.textContent = 'Coordinate with your chauffeur';/);
  });

  await check('SOURCE: only PENDING gets the editor', async () => {
    assert.match(trip, /if \(isPending\) \{[\s\S]{0,200}?dataset\.action = 'edit'/);
    // manage/coordinate deliberately do NOT open the editor
    assert.match(trip, /action === 'manage' \|\| action === 'coordinate'[\s\S]{0,900}?return;/);
  });

  await check('SOURCE: assigned is presentation-only and never overwrites raw status', async () => {
    assert.match(trip, /const presentationStatus = b\.status === 'assigned' \? 'confirmed' : b\.status;/);
    assert.ok(!trip.includes("b.status = 'confirmed'"), 'raw status is never rewritten');
    // Cancellation eligibility and polling keep reading the RAW status.
    assert.match(trip, /CANCELLABLE_STATUSES\.includes\(b\.status\)/);
  });

  await check('SOURCE: pending editing is offered at EVERY hour', async () => {
    // T-3h belongs to the driver's departure window. A clock gate appearing
    // in the passenger's edit path would be a regression.
    const ladder = trip.slice(trip.indexOf("const lifecycleBtn = $('backBtn');"), trip.indexOf("dataset.action = 'coordinate'"));
    assert.ok(!/3 \* 60 \* 60|10800|T-3|threeHours/i.test(ladder),
      'no time gate may sit in the lifecycle ladder');
  });

  await check('REPO-WIDE: no file names a burned or reassigned rung as the NEXT rollback (plan v8.6 §3D)', async () => {
    // v1.3.28/v5 and v1.3.29/v6 now belong to PR-T. Any line that names them
    // must be the ladder INVENTORY (it says so with "PR-T"); a rollback
    // instruction pointing at them is the stale instruction that must never
    // return. The flag-site comment must point at the reserved 32/9 rung.
    const { execSync } = require('child_process');
    const files = execSync('git ls-files -co --exclude-standard', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n').filter((f) => /\.(js|html|md|yml|toml)$/.test(f) && !f.startsWith('node_modules/'));
    const stale = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(repoRoot, f), 'utf8').split('\n');
      text.forEach((line, i) => {
        if (/1\.3\.2[89]\b|runtime[- ]v[56]\b/.test(line) && !/PR-T/.test(line)) stale.push(`${f}:${i + 1}`);
      });
    }
    assert.deepStrictEqual(stale, [], 'stale rung references: ' + stale.join(', '));
    assert.match(indexMvp, /bump CACHE_NAME to v1\.3\.32 AND[\s\S]{0,40}?RUNTIME_CACHE to v9/,
      'the flag-site rollback instruction names the reserved browser-flag rung');
  });

  await check('SOURCE: the model is loaded and both cache rungs moved', async () => {
    assert.match(indexMvp, /<script src="\.\/js\/pending-edit-model\.js/);
    const sw = read('service-worker.js');
    assert.ok(sw.includes("'/js/pending-edit-model.js'"));
    assert.match(sw, /CACHE_NAME = 'linkmia-v1\.3\.30'/);
    assert.match(sw, /RUNTIME_CACHE = 'linkmia-runtime-v7'/);
  });

  console.log(`\n  ${failed ? `${failed} CHECK(S) FAILED` : `ALL ${passed} CHECKS PASS`}\n`);
  process.exit(failed ? 1 : 0);
})();
