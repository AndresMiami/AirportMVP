// P0 — vehicle-metadata drift guard.
//
// Run: node tests/vehicle-metadata-drift.test.js
//
// The same vehicle metadata (keys, display names, passenger/bag capacity)
// lives in FIVE copies today:
//   1. backend/functions/lib/ride-rate-card.js  — LINKMIA_RATE_CARD.vehicles
//      (the server pricing authority; CANONICAL for this suite)
//   2. pricing.js                               — PricingService vehicleConfig
//      (the LIVE browser pricing authority until enforcement)
//   3. pricing.js                               — getFallbackVehicleConfig()
//      ("Must match vehicleConfig capacity values above", per its own comment)
//   4. indexMVP.html                            — the hardcoded ultimate
//      fallback (reached whenever pricing.js fails to load — and note the
//      intermediate `import('./config.js')` ALWAYS fails: config.js does not
//      exist in the repo, so this copy is the real second line of defence)
//   5. vehicle-carousel-standalone.html         — the carousel's JS vehicle
//      array, plus the card markup (data-vehicle keys + image-fallback names)
//
// A key, name, or capacity edited in one copy and not the others produces a
// quiet lie: a carousel offering seats the engine refuses, a fallback naming
// a vehicle the server no longer knows. This suite pins the canonical values
// ONCE (against the rate card) and every other copy AGAINST the canonical,
// so a deliberate change is a one-line edit here plus full visibility of
// every copy that must move with it.
//
// PLACEHOLDER PRICES ARE DELIBERATELY NOT COMPARED. The carousel cards ship
// $132/$165/$220 and both fallbacks ship $125/$169/$219 — they already
// disagree, live code overwrites them on every real quote, and pinning them
// would freeze a fiction. Money parity is the golden-parity suite's job.
//
// Extraction note: the two HTML copies are object/array literals sliced by
// bracket counting and evaluated in an empty vm context. The literals hold
// only plain strings and numbers (no braces inside strings) — if that ever
// changes, the balanced-slice helper below fails loudly, not silently.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..');
const indexMvp = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
const carouselHtml = fs.readFileSync(path.join(repoRoot, 'vehicle-carousel-standalone.html'), 'utf8');
const { LINKMIA_RATE_CARD, CANONICAL_VEHICLES } = require(path.join(repoRoot, 'backend/functions/lib/ride-rate-card.js'));

// The single place this suite states the expected metadata as literals.
// A genuine business change (new vehicle, different capacity) edits THIS
// table consciously — and the suite then reports every copy that still
// carries the old values.
const EXPECTED = {
  tesla: { name: 'Tesla Model Y', passengers: 4, bags: 4 },
  escalade: { name: 'Cadillac Escalade', passengers: 7, bags: 8 },
  sprinter: { name: 'Mercedes Sprinter', passengers: 12, bags: 15 }
};
const EXPECTED_KEYS = Object.keys(EXPECTED);

// Slice a balanced {...} or [...] literal starting at src[openIdx].
function sliceBalanced(src, openIdx, open, close) {
  assert.strictEqual(src[openIdx], open, `expected '${open}' at slice start`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error('unbalanced literal — the anchor moved or the shape changed');
}

function evalLiteral(text) {
  return vm.runInNewContext(`(${text})`, Object.create(null));
}

// Compare one copy against EXPECTED. `read` maps (copyObj, key) to
// { name, passengers, bags } so differently shaped copies share one check.
function pinCopy(label, keys, read) {
  assert.deepStrictEqual([...keys].sort(), [...EXPECTED_KEYS].sort(),
    `${label}: vehicle key set drifted`);
  for (const key of EXPECTED_KEYS) {
    const got = read(key);
    assert.strictEqual(got.name, EXPECTED[key].name, `${label}: ${key} name drifted`);
    assert.strictEqual(got.passengers, EXPECTED[key].passengers, `${label}: ${key} passenger capacity drifted`);
    assert.strictEqual(got.bags, EXPECTED[key].bags, `${label}: ${key} bag capacity drifted`);
  }
}

let checks = 0;
const results = [];
function check(name, f) {
  try { f(); checks++; results.push(`  ✓ ${name}`); }
  catch (err) {
    results.push(`  ✗ ${name}\n      ${err.message}`);
    results.forEach((x) => console.log(x));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

(async () => {
  console.log('\nP0 — vehicle-metadata drift guard\n');

  // pricing.js is an ES module with no browser globals at import time —
  // real execution, not text extraction, for both of its copies.
  const { PricingService } = await import(pathToFileURL(path.join(repoRoot, 'pricing.js')).href);
  const service = new PricingService();

  check('CANONICAL: the rate card carries exactly the expected keys, names and capacities', () => {
    pinCopy('rate card', Object.keys(LINKMIA_RATE_CARD.vehicles), (key) => {
      const v = LINKMIA_RATE_CARD.vehicles[key];
      return { name: v.name, passengers: v.capacity.passengers, bags: v.capacity.bags };
    });
    assert.deepStrictEqual([...CANONICAL_VEHICLES].sort(), [...EXPECTED_KEYS].sort(),
      'CANONICAL_VEHICLES drifted from the card');
  });

  check('pricing.js LIVE vehicleConfig matches (the production pricing authority)', () => {
    pinCopy('pricing.js live', Object.keys(service.vehicleConfig), (key) => {
      const v = service.vehicleConfig[key];
      return { name: v.name, passengers: v.capacity.passengers, bags: v.capacity.bags };
    });
  });

  check('pricing.js getFallbackVehicleConfig matches (its comment promises it does)', () => {
    const fallback = service.getFallbackVehicleConfig();
    pinCopy('pricing.js fallback', Object.keys(fallback), (key) => {
      const v = fallback[key];
      return { name: v.name, passengers: v.capacity.passengers, bags: v.capacity.bags };
    });
  });

  check('indexMVP hardcoded ultimate fallback matches (config.js does not exist to save it)', () => {
    assert.ok(!fs.existsSync(path.join(repoRoot, 'config.js')),
      'config.js appeared — add it as a sixth pinned copy before relying on it');
    const marker = indexMvp.indexOf('using hardcoded fallback');
    assert.ok(marker > 0, 'fallback marker comment missing from indexMVP');
    const anchor = indexMvp.indexOf('this.vehicleConfig = {', marker);
    assert.ok(anchor > 0, 'hardcoded fallback assignment not found after the marker');
    const literal = sliceBalanced(indexMvp, indexMvp.indexOf('{', anchor), '{', '}');
    const copy = evalLiteral(literal);
    pinCopy('indexMVP fallback', Object.keys(copy), (key) => {
      const v = copy[key];
      return { name: v.name, passengers: v.capacity.passengers, bags: v.capacity.bags };
    });
  });

  check('carousel JS vehicle array matches (ids, names, passengers, bags)', () => {
    const anchor = carouselHtml.indexOf('this.vehicles = [');
    assert.ok(anchor > 0, 'carousel vehicles array anchor not found');
    const literal = sliceBalanced(carouselHtml, carouselHtml.indexOf('[', anchor), '[', ']');
    const list = evalLiteral(literal);
    assert.strictEqual(list.length, EXPECTED_KEYS.length, 'carousel array length drifted');
    pinCopy('carousel array', list.map((v) => v.id), (key) => {
      const v = list.find((x) => x.id === key);
      return { name: v.name, passengers: v.passengers, bags: v.bags };
    });
  });

  check('carousel card markup matches (data-vehicle keys + image-fallback display names)', () => {
    const cardKeys = [...carouselHtml.matchAll(/class="vehicle-carousel-card[^"]*" data-vehicle="([a-z]+)"/g)]
      .map((m) => m[1]);
    assert.deepStrictEqual([...cardKeys].sort(), [...EXPECTED_KEYS].sort(),
      'card markup data-vehicle keys drifted');
    // The image-fallback <div> is the name a passenger actually SEES when a
    // vehicle image fails to load — it renders in card order.
    const fallbackNames = [...carouselHtml.matchAll(/class="fallback-icon">[^<]*<\/div>\s*<div>([^<]+)<\/div>/g)]
      .map((m) => m[1]);
    assert.strictEqual(fallbackNames.length, EXPECTED_KEYS.length, 'image-fallback name count drifted');
    cardKeys.forEach((key, i) => {
      assert.strictEqual(fallbackNames[i], EXPECTED[key].name,
        `card markup: ${key} image-fallback name drifted`);
    });
  });

  results.forEach((x) => console.log(x));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
