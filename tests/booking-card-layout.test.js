// Unified booking card — source pins (2026-09-11).
//
// The card's behaviour is layout, which node cannot compute, so this suite
// pins the rules that produce it; the rendered proof (every stage fits the
// screen, the three actions share one spot, the pills sit inside the card)
// is measured in a real browser at 390x844, 375x667, 430x932, 320x568 and
// 1280x800 and recorded in the PR. What it guards against: a card that
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

check('the card IS the screen: a flex column exactly the visible height, with the pill strip reserved at its bottom', () => {
  assert.ok(block.length > 200, 'the unified-card block exists');
  const card = rule('.booking-container.active');
  assert.match(card, /display: flex;/);
  assert.match(card, /flex-direction: column;/);
  assert.match(card, /height: calc\(100vh - 2 \* var\(--page-pad\)\);\s*height: calc\(100dvh - 2 \* var\(--page-pad\)\);/, '100dvh with a 100vh fallback');
  assert.match(card, /padding-bottom: var\(--card-footer-h\);/);
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
  assert.match(row, /margin: 0 -12px;/, 'bleeds out of the 12px content padding to the stage edges');
  assert.match(rule('.booking-container.active #vehiclePanel .content-section'), /padding: 12px 12px 0;/, 'the bleed matches the content padding');
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

check('the legal and sign-out pills sit inside the card\'s bottom strip while the booking is open', () => {
  const legal = rule('body:has(.booking-container.active) .app-legal-nav');
  assert.match(legal, /left: calc\(max\(0px, \(100vw - 576px\) \/ 2\) \+ var\(--page-pad\) \+ 12px\);/);
  assert.match(legal, /bottom: calc\(var\(--page-pad\) \+ 9px\);/);
  const out = rule('body:has(.booking-container.active) #userHeader');
  assert.match(out, /right: calc\(max\(0px, \(100vw - 576px\) \/ 2\) \+ var\(--page-pad\) \+ 12px\) !important;/, 'beats the pill\'s inline style');
  assert.match(out, /bottom: calc\(var\(--page-pad\) \+ 9px\) !important;/);
});

check('a hidden create-flow button really hides (the route editor hides Continue)', () => {
  assert.match(block, /\.continue-btn\[hidden\],\s*\.book-btn\[hidden\] \{ display: none; \}/);
});

console.log(`\n  ALL ${passed} CHECKS PASS\n`);
