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
    // The create picker's own snap-forward stays: device time ADVISES. Since
    // the flight pass it judges the EFFECTIVE PICKUP (landing + offset) on a
    // Miami wall clock, never the raw picker value.
    assert.match(indexMvp, /if \(pickupInstant\.getTime\(\) <= now\.getTime\(\)\) \{[\s\S]{0,200}?showTimeWarning\(\)/);
    assert.ok(indexMvp.indexOf('let pickupInstant = new Date(landingInstant.getTime() + offsetMs);') <
      indexMvp.indexOf('if (pickupInstant.getTime() <= now.getTime())'),
      'the pickup is computed BEFORE the elapsed rule judges it');
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
    // the snap forward now judges the effective pickup, resolved in Miami
    assert.match(indexMvp, /if \(pickupInstant\.getTime\(\) <= now\.getTime\(\)\) \{[\s\S]{0,200}?showTimeWarning\(\)/);
    assert.match(indexMvp, /resolveMiamiWallClock/, 'the wall clock is Miami, through the shared model');
  });

  console.log('\nPR-B — SOURCE: the trip-sheet lifecycle ladder\n');

  await check('SOURCE: Manage ride opens as the page\'s own bottom-sheet modal — the booking form is never revealed for an edit', async () => {
    const idx = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
    const begin = idx.slice(idx.indexOf('async beginPendingEdit('), idx.indexOf('editCard() {'));
    assert.ok(!begin.includes("navigateToPanel('where')"), 'beginPendingEdit never navigates to the Where panel');
    assert.ok(!begin.includes('this.startBooking()'), 'beginPendingEdit never activates the booking form');
    assert.ok(begin.includes('this.openEditSheet(bookingId, this.pendingEdit.tripCode);'), 'the sheet opens at once');
    assert.ok(idx.includes("loading.textContent = 'Loading your ride…';"), 'the honest loading line lives INSIDE the sheet');
    // the sibling modals' values, verbatim (passenger-modal.js is the reference)
    for (const rule of [
      '.edit-sheet-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.7);',
      'z-index: 9999; display: none; justify-content: center; align-items: flex-end; }',
      '.edit-sheet-overlay.active { display: flex; animation: editSheetFadeIn 0.3s ease-out; }',
      '.edit-sheet-panel { width: 100%; max-width: 576px; min-height: 200px; max-height: 88vh; background: #2C2C2E;',
      'animation: editSheetSlideUp 0.3s ease-out; border-radius: 20px 20px 0 0; }',
      '@keyframes editSheetSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }',
      '@keyframes editSheetFadeIn { from { opacity: 0; } to { opacity: 1; } }',
      'border-bottom: 1px solid #3A3A3C; background: #2C2C2E; position: sticky; top: 0; z-index: 10;',
      '.edit-sheet-content { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }',
      '.edit-sheet-panel { max-width: 100%; height: auto; max-height: 92vh; }',
      '.edit-sheet-content .pe-line { background: #1C1C1E;'
    ]) assert.ok(idx.includes(rule), `sheet CSS carries the modal value: ${rule.slice(0, 60)}`);
    assert.ok(idx.includes("setTimeout(() => {\n                    overlay.classList.add('active');"), 'append, then .active a tick later — the sibling modals\' open choreography');
    assert.ok(idx.includes("sheet.overlay.classList.remove('active');\n                setTimeout(() => sheet.overlay.remove(), 300);"), 'close = drop .active, remove after 300ms');
    const mount = idx.slice(idx.indexOf('mountEditCard(node) {'), idx.indexOf('editCardClosed(bookingId) {'));
    assert.ok(mount.includes('sheet.content.appendChild(node);'), 'the card mounts INTO the sheet');
    assert.ok(!mount.includes('bookingContainer?.appendChild(node)'), 'never inline into the booking container');
    const enter = idx.slice(idx.indexOf('enterEditRouteMode(editorInput, { onDone, onBack }) {'), idx.indexOf('exitEditRouteMode() {'));
    assert.ok(enter.includes('if (this._editSheet) this._editSheet.overlay.hidden = true;'), 'a route change parks the sheet');
    assert.ok(enter.includes('this._editActivatedContainer = true;\n                    this.startBooking();'), 'the booking form activates only for the Where screen');
    const exit = idx.slice(idx.indexOf('exitEditRouteMode() {'), idx.indexOf('editRouteDoneEnabled() {'));
    assert.ok(exit.includes('if (this._editSheet) this._editSheet.overlay.hidden = false;'), 'Done/Back bring the sheet back');
    assert.ok(idx.includes("if (urlParams.get('book') === '1' && !pendingEditIntent) {"), 'a returning Manage ride intent never auto-starts the empty form');
    const card = fs.readFileSync(path.join(repoRoot, 'js/pending-edit-card.js'), 'utf8');
    assert.ok(card.includes('discard: onDiscard,'), 'the sheet ✕ reuses the card\'s own Discard');
    assert.ok(idx.includes("close.setAttribute('aria-label', 'Close without saving');"), 'the ✕ is named');
    assert.ok(idx.includes("overlay.setAttribute('aria-labelledby', 'editSheetTitle');"), 'the dialog is named by its header');
  });

  await check('SOURCE: the passenger destination is STABLE — "Manage ride" from Pending through Arrived; only a ride in progress reads Coordinate', async () => {
    assert.strictEqual((trip.match(/lifecycleBtn\.textContent = 'Manage ride';/g) || []).length, 3, 'pending, confirmed, on_the_way/arrived branches');
    assert.strictEqual((trip.match(/lifecycleBtn\.textContent = 'Coordinate with your chauffeur';/g) || []).length, 1, 'in_progress only');
    assert.ok(!trip.includes("lifecycleBtn.textContent = '✏️ Edit ride'"), 'the destination is never renamed to Edit ride');
    assert.ok(trip.includes('id="backBtn">Manage ride</button>'), 'the static markup carries the stable name too');
    // the contextual CTA lives INSIDE Manage ride, keyed by phase
    for (const k of ['confirmed', 'on_the_way', 'arrived', 'in_progress']) assert.match(trip, new RegExp(`LIFECYCLE_NOTICES = Object\\.freeze\\(\\{[\\s\\S]*?${k}:`));
    assert.match(trip, /const table = hasContact \? LIFECYCLE_NOTICES : LIFECYCLE_NOTICES_NO_CONTACT;/,
      'one helper selects contact-appropriate copy');
    assert.match(trip, /el\.textContent = lifecycleNoticeCopy\(phase, hasContact\);/,
      'the tap uses the shared phase/contact helper');
    assert.match(trip, /if \(!lifecycleNotice\.classList\.contains\('hidden'\)\) \{[\s\S]{0,260}?lifecycleNoticeCopy\(presentationStatus, showWa\)[\s\S]{0,160}?lifecycleNotice\.textContent !== nextCopy/,
      'an open notice follows same-status contact drift without rewriting unchanged live copy');
    for (const key of ['confirmed', 'on_the_way', 'arrived', 'in_progress']) {
      assert.ok(new RegExp(`LIFECYCLE_NOTICES_NO_CONTACT = Object\\.freeze\\(\\{[\\s\\S]*?\\b${key}:`).test(trip), `no-contact variant defined for ${key}`);
    }
    // and the editable card names the same destination
    const card = fs.readFileSync(path.join(repoRoot, 'js/pending-edit-card.js'), 'utf8');
    assert.ok(card.includes("mount.setAttribute('aria-label', 'Manage ride');") && card.includes('`Manage ride ${ctx.tripCode || \'\'}`'), 'card ARIA label and title say Manage ride');
    assert.ok(!card.includes("'Edit ride'") && !card.includes('`Edit ride'), 'the card never says Edit ride');
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

  // The repo-wide burned-rung rule (no file may name a rung at or below the
  // shipped pair as next/reserved/rollback; inventory sites pinned) lives in
  // tests/pending-edit-hydration.test.js since PR-T; the cruder scan this
  // suite carried while parked ("every 28/29 mention must say PR-T") is
  // superseded and removed.

  await check('SOURCE: the model is loaded and both cache rungs moved', async () => {
    assert.match(indexMvp, /<script src="\.\/js\/pending-edit-model\.js/);
    const sw = read('service-worker.js');
    assert.ok(sw.includes("'/js/pending-edit-model.js?v=2'"));
    assert.match(sw, /CACHE_NAME = 'linkmia-v1\.3\.\d+'/);
    assert.match(sw, /RUNTIME_CACHE = 'linkmia-runtime-v\d+'/);   // the pair itself: pending-edit-hydration's ladder check
  });

  console.log(`\n  ${failed ? `${failed} CHECK(S) FAILED` : `ALL ${passed} CHECKS PASS`}\n`);
  process.exit(failed ? 1 : 0);
})();
