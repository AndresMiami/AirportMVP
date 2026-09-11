// Unified booking card — source pins (2026-09-11).
//
// The card's behaviour is layout, which node cannot compute, so this suite
// pins the rules that produce it; the rendered proof (every stage fits the
// screen, the three actions share one spot at the card's bottom, the cars
// fill the carousel)
// is measured in a real browser at 390x844, 375x667, 430x932, 320x568,
// 1280x800, 932x430, 667x375 and 768x1024 and recorded in the PR. What it guards against: a card that
// stops being the screen, a stage region that goes back to the tallest
// panel's height, a Vehicle stage that stops fitting, a viewport-fixed
// action dock, or an action node leaving its own panel.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'indexMVP.html'), 'utf8');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); console.log('\n  1 CHECK(S) FAILED'); process.exit(1); }
}
const block = css.slice(css.indexOf('Unified booking card (2026-09-11)'));
const rule = (selector) => {
  const i = block.indexOf(selector + ' {');
  assert.ok(i >= 0, `rule missing: ${selector}`);
  return block.slice(i, block.indexOf('}', i));
};

console.log('\nUnified booking card — source pins\n');

check('the card IS the screen: a flex column exactly the visible height, with nothing reserved under its actions', () => {
  assert.ok(block.length > 200, 'the unified-card block exists');
  const card = rule('.booking-container.active');
  assert.match(card, /display: flex;/);
  assert.match(card, /flex-direction: column;/);
  assert.match(card, /height: calc\(100vh - 2 \* var\(--page-pad\)\);\s*height: calc\(100dvh - 2 \* var\(--page-pad\)\);/, '100dvh with a 100vh fallback');
  assert.match(card, /padding-bottom: 0;/, 'nothing under the actions: not the pill strip, not the older 60px bottom-nav room');
  assert.ok(!/--card-footer-h/.test(css), 'the pill strip is gone');
  assert.match(rule('.app-container'), /min-height: 100dvh;/, 'the page is the visible screen, not the large viewport');
});

check('one stage region: the strip takes exactly the height left and every panel stretches to it (never the tallest panel)', () => {
  const region = rule('.booking-container.active > .panels-wrapper');
  assert.match(region, /flex: 1 1 0;/);
  assert.match(region, /min-height: 0;/);
  assert.match(region, /align-items: stretch;/);
  const panel = rule('.booking-container.active .panel');
  assert.match(panel, /min-height: 0;/);
  assert.match(panel, /background: transparent;/, 'one surface: the card');
});

check('Vehicle fits the region: the map absorbs the leftover height and the rows keep their natural size', () => {
  const map = rule('.booking-container.active #vehiclePanel .map-section');
  assert.match(map, /flex: 1 1 0;/);
  assert.match(map, /min-height: 120px;/);
  assert.match(rule('.booking-container.active #vehiclePanel .content-section'), /flex: none;/);
});

check('Book shares Continue\'s box and edges, and stays pinned to the panel bottom if a short screen must scroll', () => {
  const row = rule('.booking-container.active #vehiclePanel .schedule-section');
  assert.match(row, /position: sticky;/);
  assert.match(row, /bottom: 0;/);
  assert.match(row, /width: auto;/, 'width:100% would cancel the bleed');
  assert.match(row, /margin: 0 calc\(-1 \* var\(--card-pad-x\)\);/, 'bleeds out of the content padding to the stage edges');
  assert.match(rule('.booking-container.active #vehiclePanel .content-section'), /padding: 12px var\(--card-pad-x\) 0;/, 'the bleed matches the content padding');
  const book = rule('.booking-container.active #vehiclePanel .book-btn');
  assert.match(book, /min-height: 52px;/);
  assert.match(book, /padding: 8px 12px;/);
});

check('the three action nodes stay in their own panels — no viewport-fixed dock', () => {
  const panelOf = (id) => {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${id} exists`);
    const panels = ['wherePanel', 'whenPanel', 'vehiclePanel'].map((p) => [p, html.lastIndexOf(`id="${p}"`, at)]);
    return panels.sort((a, b) => b[1] - a[1])[0][0];
  };
  assert.strictEqual(panelOf('continueBtn'), 'wherePanel');
  assert.strictEqual(panelOf('vehicleSelectionBtn'), 'whenPanel');
  assert.strictEqual(panelOf('bookBtn'), 'vehiclePanel');
  assert.ok(!/booking-action-dock|bookingActionDock/.test(html + css), 'no separate dock');
  assert.ok(!/\.schedule-section[^{]*\{[^}]*position:\s*fixed/.test(css), 'no action row fixed to the viewport');
});

check('the legal and sign-out pills step aside while the booking is open; Terms, Privacy and Sign out live in the traveler sheet', () => {
  assert.match(block, /body:has\(\.booking-container\.active\) \.app-legal-nav,\s*body:has\(\.booking-container\.active\) #userHeader,\s*body:has\(\.booking-container\.active\) #installPWA \{ display: none !important; \}/, 'hidden only while the card is open, the install button included');
  assert.ok(html.includes('<a href="/terms">Terms</a>') && html.includes('onclick="logout()"'), 'the landing screen keeps its pills');
  const pm = fs.readFileSync(path.join(root, 'js/passenger-modal.js'), 'utf8');
  const foot = pm.slice(pm.indexOf('<div class="passenger-account-footer">'), pm.indexOf('<!-- Add Guest Modal -->'));
  assert.ok(pm.includes('<div class="passenger-account-footer">') && foot.includes('href="/terms"') && foot.includes('href="/privacy"'), 'Terms and Privacy in the traveler sheet');
  assert.ok(foot.includes('onclick="window.logout && window.logout()"'), 'Sign out runs the page\'s own logout, which clears the pending envelope first');
});

check('the cars fill the carousel: the frame spans the stage and takes the height its 3:2 cards need; each card is sized from the frame, the photo edge to edge', () => {
  assert.match(rule('.booking-container.active #vehicle-carousel-mount'), /margin: 0 calc\(-1 \* var\(--card-pad-x\)\);/, 'edge to edge across the stage');
  const frame = rule('.booking-container.active #vehicle-carousel-frame');
  assert.match(frame, /height: clamp\(120px, min\(calc\(\(min\(100vw, 576px\) - 2 \* var\(--page-pad\) - 84px\) \/ 1\.5 \+ 20px\), 38dvh\), 300px\);/, 'the stage width sets the height (528px at desktop, measured), never more than 38% of the screen height');
  assert.match(frame, /max-height: none;/);
  const car = fs.readFileSync(path.join(root, 'vehicle-carousel-standalone.html'), 'utf8');
  assert.match(car, /flex: 0 0 min\(calc\(100vw - 84px\), calc\(\(100vh - 20px\) \* 1\.5\)\);/, 'the same 84px of gutters and 20px of room as the frame formula');
  assert.match(car, /height: calc\(100vh - 20px\);/, 'the track fills the frame');
  assert.match(car, /padding: 0 42px;/, 'half the gutters: the first and last cards can center');
  assert.match(car, /\.vehicle-image-wrapper \{[^}]*padding: 0;/, 'no dark border around the photo');
  assert.ok(!/calc\(100vw - 100px\)|calc\(100vw - 120px\)|height: 200px;/.test(car), 'the old fixed widths and height are gone');
});

check('the map carries no badges: the route and its markers only (the header already names the airport)', () => {
  assert.ok(!/mapPickupTime|mapArrivalTime|mapPickupPeriod|mapLocationText|updateMapBadges|dropoff-label|map-time-badge/.test(html), 'no badge markup or code');
  assert.ok(!/\.arrival-time|\.pickup-time|\.time-period|dropoff-label|map-time-badge/.test(css), 'no badge styles');
});

check('a hidden create-flow button really hides (the route editor hides Continue)', () => {
  assert.match(block, /\.continue-btn\[hidden\],\s*\.book-btn\[hidden\],\s*#vehiclePanel \.book-btn\[hidden\] \{ display: none; \}/, "Book's own #vehiclePanel display rule cannot beat [hidden]");
});

check('Vehicle keeps ONE control row — Traveler | Payment — above the carousel; notes and promo left the Vehicle page', () => {
  const v = html.slice(html.indexOf('id="vehiclePanel"'), html.indexOf('id="bookBtn"'));
  assert.strictEqual((v.match(/class="controls-row[^"]*"/g) || []).length, 1, 'exactly one control row');
  const t = v.indexOf('passenger-select'), pay = v.indexOf('payment-method'), car = v.indexOf('vehicle-carousel-mount');
  assert.ok(t > 0 && t < pay && pay < car, 'Traveler, then Payment, then the carousel');
  assert.ok(!/add-notes|promo-button|payment-controls/.test(v), 'no notes or promo buttons on the Vehicle page');
});

check('pickup notes open from the traveler sheet and the promo from the payment sheet, each on top of its parent, feeding the same booking state', () => {
  const pm = fs.readFileSync(path.join(root, 'js/passenger-modal.js'), 'utf8');
  const pay = fs.readFileSync(path.join(root, 'js/payment-modal.js'), 'utf8');
  assert.ok(pm.includes('onclick="PassengerModal.getInstance().openPickupNotes()"') && pm.includes('PickupNoteModal.getInstance().open();'));
  assert.ok(pay.includes('onclick="PaymentModal.getInstance().openPromotion()"') && pay.includes('PromotionModal.getInstance().open();'));
  assert.match(pm, /#pickupNotesModal \{ z-index: 10000; \}/, 'notes sheet above the traveler sheet');
  assert.match(pay, /#promotionModal \{ z-index: 10000; \}/, 'promo sheet above the payment sheet (it sits earlier in the page)');
  assert.ok(pm.includes("window.addEventListener('pickupNotesChanged', () => PassengerModal.getInstance().updateNotesRow());"));
  assert.ok(pay.includes("window.addEventListener('promotionChanged', () => PaymentModal.getInstance().updatePromoRow());"));
  assert.ok(html.includes('window.airportApp.state.pickupNotes = notesData;') && html.includes('window.airportApp.state.promoCode = promoData?.code || null;'), 'the booking reads the same state as before');
  assert.ok(html.includes('js/passenger-modal.js?v=5') && html.includes('js/payment-modal.js?v=2'), 'phones fetch the changed modals');
  // the promo row must show whether or not a card is saved: it sits after both the empty state and the card list
  const content = pay.slice(pay.indexOf('<div class="payment-modal-content">'), pay.indexOf('<!-- Add Payment Method Modal -->'));
  const promoAt = content.indexOf('id="paymentPromoRow"');
  assert.ok(promoAt > content.indexOf('id="emptyState"') && promoAt > content.indexOf('id="continueBtnList"'), 'promo row sits after both the empty state and the card list');
  assert.strictEqual((pay.match(/id="paymentPromoRow"/g) || []).length, 1, 'exactly one promo row');
});

check('the promo sheet never shows, promises or computes a discount — any well-formed code is saved with the booking for LinkMia to review', () => {
  const promo = fs.readFileSync(path.join(root, 'js/promotion-modal.js'), 'utf8');
  assert.ok(!/FIRST10|AIRPORT20|WEEKEND15|SAVE25|VIP30/.test(promo), 'no hard-coded discount codes');
  assert.ok(!/type: 'percentage'|type: 'fixed'/.test(promo), 'no client-side discount table');
  assert.ok(!/apply a discount/.test(promo), 'no discount promise');
  assert.ok(promo.includes("It doesn't change the price shown"), 'says the price is unchanged');
  assert.match(promo, /getDiscountForCode\(\) \{\s*return null;/);
  assert.match(promo, /calculateDiscountedPrice\(originalPrice\) \{\s*return originalPrice;/);
  assert.ok(html.includes('js/promotion-modal.js?v=2'), 'phones fetch the honest sheet');
});

check('one source for the card geometry: the older layers that fought the unified block are gone', () => {
  const legacy = [
    [/\.bottom-nav/, 'the bottom-nav block'],
    [/padding-bottom: 60px/, 'the 60px bottom-nav room'],
    [/@supports \(height: 100dvh\)/, 'the self-cancelling dvh pair'],
    [/IPHONE PORTRAIT MODE FIX/, 'the portrait !important block'],
    [/min-height: calc\(100vh - 320px\)/, 'the generic content-section height'],
    [/Ensure no layout constraints on containers/, 'the height:auto reset'],
    [/\.panel-actions/, 'the retired panel-actions rules'],
    [/@media \(min-height: 800px\)/, 'the tall-screen map and content rules'],
  ];
  for (const [re, what] of legacy) assert.ok(!re.test(css), `${what} is gone`);
  const frameHeights = css.split('}').filter((r) => /#vehicle-carousel-frame\s*\{/.test(r) && /(^|[^-])height:/.test(r.slice(r.indexOf('{'))));
  assert.strictEqual(frameHeights.length, 1, 'exactly one rule sizes the carousel frame');
  assert.ok(frameHeights[0].includes('.booking-container.active #vehicle-carousel-frame'), 'and it is the unified one');
  assert.ok(!/!important/.test(rule('.booking-container.active #vehicle-carousel-frame')), 'without !important');
  const loader = html.slice(html.indexOf("iframe.id = 'vehicle-carousel-frame';"), html.indexOf("iframe.setAttribute('scrolling', 'no');"));
  assert.ok(loader.length > 0 && !/height:/.test(loader), 'the carousel loader sets no inline height');
  assert.ok(!html.includes('<div class="panel-content" style='), 'no inline panel padding');
  assert.match(rule('.booking-container.active #whenPanel .panel-content'), /padding-top: 20px;/, "When's top padding lives in the block");
});

check('address suggestions stay inside the card: capped at 40% of the screen, and on phones in Arriving mode they open upward above the field', () => {
  assert.match(rule('.booking-container.active #autocompleteDropdown'), /max-height: min\(300px, 40dvh\);/);
  assert.match(block, /@media \(max-width: 480px\), \(max-height: 500px\) \{\s*\.booking-container\.active #wherePanel:has\(\.mode-btn\[data-mode="pickup"\]\.active\) #autocompleteDropdown \{/, 'phones only (portrait or landscape): tablets and desktops keep the downward list, which has the room there');
  const up = rule('.booking-container.active #wherePanel:has(.mode-btn[data-mode="pickup"].active) #autocompleteDropdown');
  assert.match(up, /top: auto;/);
  assert.match(up, /bottom: 100%;/);
  const at = html.indexOf('updateStepOrder(isDropoff) {');
  assert.match(html.slice(at, at + 300), /addressStep\.style\.order = isDropoff \? '1' : '3';/, 'Arriving mode puts the address step last, which is what the upward rule assumes');
  assert.ok(html.includes("btn.classList.toggle('active', btn.dataset.mode === d.mode)") && html.includes('this.updateStepOrder(isDropoff);'), 'the Manage ride route editor sets the same mode button and order');
  assert.match(css.slice(css.indexOf('.flow-connector {')), /^\.flow-connector \{\s*position: relative;/, 'the arrow scrolls with the Where content');
});

check('When: one estimate line (the time note repeated it and stays hidden) and a dismissed time warning takes no space', () => {
  assert.match(block, /\.booking-container\.active \.time-note,\s*\.booking-container\.active \.time-warning:not\(\.visible\) \{ display: none; \}/);
});

check('one card, one style: every control shares the tokens, one selected look, one label style, one header', () => {
  const cssRule = (sel) => { const i = css.indexOf('\n' + sel + ' {'); assert.ok(i >= 0, `rule missing: ${sel}`); return css.slice(i, css.indexOf('}', i)); };
  for (const t of ['--card-pad-x: 20px;', '--surface-control:', '--line:', '--r-control: 12px;', '--selected-bg:']) assert.ok(block.includes(t), `token ${t}`);
  for (const sel of ['.mode-btn', '.address-input', '.airport-option', '.date-btn', '.time-select', '.flight-input', '.control-button', '#vehiclePanel .calendar-button-mobile']) {
    const r = cssRule(sel);
    assert.ok(r.includes('var(--surface-control)') && r.includes('1px solid var(--line)') && r.includes('var(--r-control)'), `${sel} uses the control tokens`);
  }
  for (const sel of ['.mode-btn.active', '.airport-option.selected', '.date-btn.active']) {
    const r = cssRule(sel);
    assert.ok(r.includes('var(--selected-bg)') && r.includes('border-color: var(--primary)'), `${sel} is the one selected look`);
  }
  assert.ok(!/background|border/.test(cssRule('.mode-selector')), 'the mode switch has no outer frame');
  assert.ok(!/\.time-section h3/.test(css) && css.includes('.section-label,\n#airportTitle {'), 'one label style on Where and When');
  assert.ok(!/background|border:/.test(cssRule('.arrival-info')), 'the arrival estimate is a line, not a box');
  assert.ok(cssRule('.progress-bar').includes('background: transparent;') && cssRule('.summary-bar').includes('background: transparent;'), 'the header rows share the card surface');
  assert.match(block, /\.booking-container\.active > \.progress-bar:has\(\+ \.summary-bar\.visible\) \{\s*border-bottom-color: transparent;/, 'one divider under the header');
  assert.ok(!/\nbutton\.back-btn \{/.test(css) && css.includes('\n.panel > button.back-btn,\n.map-section > button.back-btn {'), 'the round back-button rule is scoped to in-panel buttons, so header Back and Edit match');
  assert.ok(html.includes("let bg = 'transparent', border = 'transparent'"), '"Getting current prices" is a plain line');
  const car = fs.readFileSync(path.join(root, 'vehicle-carousel-standalone.html'), 'utf8');
  assert.match(car, /\.vehicle-popular-badge \{[^}]*font-size: 10px;/, 'the popular tag is a small corner tag');
});

console.log(`\n  ALL ${passed} CHECKS PASS\n`);
