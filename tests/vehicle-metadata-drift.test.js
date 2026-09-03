// P0 — vehicle-metadata drift guard.
//
// Run: node tests/vehicle-metadata-drift.test.js
//
// The same vehicle metadata (keys, display names, categories, passenger/bag
// capacity) lives in NINE copies today. Vehicle-KEYED copies (tesla /
// escalade / sprinter):
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
//   6. database/migrations/018_...sql           — the INSTALLED production
//      writers: the vehicle-key allowlist and the key→category / key→name
//      CASE mappings in accept_quote_create AND accept_quote_edit (drift
//      here rejects valid signed quotes or stores wrong names)
// CATEGORY-keyed copies (sedan / suv / sprinter, + the legacy 'escalade'
// category alias kept for old rows):
//   7. trip.html                                — the passenger vehicle-hero
//      catalog (label + pax/bags the passenger actually sees)
//   8. backend/functions/create-booking.js      — VEHICLE_TYPE normalization
//      map + VEHICLE_KEYS + the CAPACITY table (display-only: the Telegram
//      doorbell's "N of M" capacity figures render from it — actual
//      validation is the independent hardcoded ceiling pinned below)
//   9. backend/functions/update-pending-booking.js — VEHICLE_TYPE + KEYS
//      (must never diverge from create-booking's copies)
// Plus the HIDDEN LIMITS that would quietly veto a capacity change made in
// all nine copies above (Codex P0 review, seq:110):
//   - four hardcoded validation CEILINGS (max passengers/bags of the largest
//     vehicle): create-booking, update-pending-booking, and BOTH installed
//     SQL writers — raise Sprinter to 13/16 everywhere above and these
//     would still reject the booking;
//   - two LAST-RESORT vehicle-key lists the browser falls back to when the
//     pricing service is absent (indexMVP price update, carousel clearPrices).
//
// ORDER IS LOAD-BEARING in the carousel: the runtime pairs DOM cards with
// JS vehicles by ARRAY POSITION (querySelectorAll order vs
// this.vehicles[currentIndex]), so this suite pins the exact SEQUENCE of
// the array against the exact sequence of the markup — a swapped pair of
// array entries would make a tapped Tesla card submit Escalade data while
// every per-key value check still passed (Codex P0 review, seq:108).
//
// A key, name, category, or capacity edited in one copy and not the others
// produces a quiet lie: a carousel offering seats the engine refuses, a
// doorbell announcing the wrong capacity, a verified quote refused by the
// SQL allowlist. This suite states the expected metadata ONCE (the EXPECTED
// table below), pins the canonical rate card against it, and every other
// copy against the canonical, so a deliberate change is a one-table edit
// here plus full visibility of every copy that must move with it.
//
// PLACEHOLDER PRICES ARE DELIBERATELY NOT COMPARED. The carousel cards ship
// $132/$165/$220 and both fallbacks ship $125/$169/$219 — they already
// disagree, live code overwrites them on every real quote, and pinning them
// would freeze a fiction. Money parity is the golden-parity suite's job.
//
// Extraction note: the HTML/endpoint copies are object/array literals sliced
// by bracket counting and evaluated in an empty vm context. The literals
// hold only plain strings and numbers (no braces inside strings) — if that
// ever changes, the balanced-slice helper below fails loudly, not silently.
// The SQL copy is pinned as text against the installed artifact's file (the
// checksum discipline ties file to production; the chain test EXECUTES it).

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..');
const indexMvp = fs.readFileSync(path.join(repoRoot, 'indexMVP.html'), 'utf8');
const carouselHtml = fs.readFileSync(path.join(repoRoot, 'vehicle-carousel-standalone.html'), 'utf8');
const tripHtml = fs.readFileSync(path.join(repoRoot, 'trip.html'), 'utf8');
const createBooking = fs.readFileSync(path.join(repoRoot, 'backend/functions/create-booking.js'), 'utf8');
const updatePending = fs.readFileSync(path.join(repoRoot, 'backend/functions/update-pending-booking.js'), 'utf8');
const m018 = fs.readFileSync(path.join(repoRoot, 'database/migrations/018_r1_route_content_non_retention.sql'), 'utf8');
const { LINKMIA_RATE_CARD, CANONICAL_VEHICLES } = require(path.join(repoRoot, 'backend/functions/lib/ride-rate-card.js'));

// The single place this suite states the expected metadata as literals.
// A genuine business change (new vehicle, different capacity, a rename)
// edits THIS table consciously — and the suite then reports every copy
// that still carries the old values. ORDER MATTERS: this is also the
// canonical vehicle sequence the carousel array and markup must share.
const EXPECTED = {
  tesla: { name: 'Tesla Model Y', category: 'sedan', passengers: 4, bags: 4 },
  escalade: { name: 'Cadillac Escalade', category: 'suv', passengers: 7, bags: 8 },
  sprinter: { name: 'Mercedes Sprinter', category: 'sprinter', passengers: 12, bags: 15 }
};
const EXPECTED_KEYS = Object.keys(EXPECTED);
// Category-keyed capacity, including the legacy 'escalade' CATEGORY alias
// old booking rows still carry (CLAUDE.md: "Legacy status/category kept
// for old rows") — present in trip.html and create-booking's CAPACITY.
const EXPECTED_CATEGORY = {
  sedan: { label: 'Tesla Model Y', passengers: 4, bags: 4 },
  suv: { label: 'Cadillac Escalade', passengers: 7, bags: 8 },
  escalade: { label: 'Cadillac Escalade', passengers: 7, bags: 8 },
  sprinter: { label: 'Mercedes Sprinter', passengers: 12, bags: 15 }
};

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

function extractLiteral(src, anchor, open, close, label) {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `${label}: anchor "${anchor}" not found`);
  const value = vm.runInNewContext(
    `(${sliceBalanced(src, src.indexOf(open, at), open, close)})`,
    Object.create(null)
  );
  // Re-realm: vm results carry the vm realm's prototypes, and
  // assert.deepStrictEqual compares prototypes — a vm array never
  // deep-equals a host array. The literals are JSON-safe by the
  // extraction contract above, so a JSON round-trip normalizes them.
  return JSON.parse(JSON.stringify(value));
}

// Extract one function body from the migration (same contract as the R1
// suite: CREATE OR REPLACE ... through the closing $$;).
function extractSqlFunction(src, name) {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, `${name} not found in migration 018`);
  return src.slice(start, src.indexOf('$$;', start) + 3);
}

// Compare one copy against EXPECTED. `read` maps a key to
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
    assert.deepStrictEqual(CANONICAL_VEHICLES, EXPECTED_KEYS,
      'CANONICAL_VEHICLES drifted from the expected key order');
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
      'config.js appeared — add it as a pinned copy before relying on it');
    const marker = indexMvp.indexOf('using hardcoded fallback');
    assert.ok(marker > 0, 'fallback marker comment missing from indexMVP');
    const after = indexMvp.slice(marker);
    const copy = extractLiteral(after, 'this.vehicleConfig = {', '{', '}', 'indexMVP fallback');
    pinCopy('indexMVP fallback', Object.keys(copy), (key) => {
      const v = copy[key];
      return { name: v.name, passengers: v.capacity.passengers, bags: v.capacity.bags };
    });
  });

  check('carousel JS vehicle array matches (ids, names, passengers, bags)', () => {
    const list = extractLiteral(carouselHtml, 'this.vehicles = [', '[', ']', 'carousel array');
    assert.strictEqual(list.length, EXPECTED_KEYS.length, 'carousel array length drifted');
    pinCopy('carousel array', list.map((v) => v.id), (key) => {
      const v = list.find((x) => x.id === key);
      return { name: v.name, passengers: v.passengers, bags: v.bags };
    });
  });

  check('carousel ORDER: JS array sequence === markup card sequence (position is the join)', () => {
    // The runtime pairs cards with vehicles BY INDEX: querySelectorAll
    // document order on one side, this.vehicles[currentIndex] on the
    // other. Equal SETS with different SEQUENCES would render Tesla and
    // submit Escalade — so the sequences are compared exactly, unsorted.
    const list = extractLiteral(carouselHtml, 'this.vehicles = [', '[', ']', 'carousel array');
    const cardKeys = [...carouselHtml.matchAll(/class="vehicle-carousel-card[^"]*" data-vehicle="([a-z]+)"/g)]
      .map((m) => m[1]);
    assert.deepStrictEqual(list.map((v) => v.id), cardKeys,
      'carousel JS array order diverged from markup card order');
    assert.deepStrictEqual(cardKeys, EXPECTED_KEYS,
      'carousel card order diverged from the expected canonical order');
  });

  check('carousel card markup matches (image-fallback display names, in card order)', () => {
    // The image-fallback <div> is the name a passenger actually SEES when a
    // vehicle image fails to load — it renders in card order.
    const cardKeys = [...carouselHtml.matchAll(/class="vehicle-carousel-card[^"]*" data-vehicle="([a-z]+)"/g)]
      .map((m) => m[1]);
    const fallbackNames = [...carouselHtml.matchAll(/class="fallback-icon">[^<]*<\/div>\s*<div>([^<]+)<\/div>/g)]
      .map((m) => m[1]);
    assert.strictEqual(fallbackNames.length, EXPECTED_KEYS.length, 'image-fallback name count drifted');
    cardKeys.forEach((key, i) => {
      assert.strictEqual(fallbackNames[i], EXPECTED[key].name,
        `card markup: ${key} image-fallback name drifted`);
    });
  });

  check('trip.html vehicle-hero catalog matches (category-keyed labels + capacities)', () => {
    const catalog = extractLiteral(tripHtml, 'const VEHICLES = {', '{', '}', 'trip.html catalog');
    assert.deepStrictEqual(Object.keys(catalog).sort(), Object.keys(EXPECTED_CATEGORY).sort(),
      'trip.html category key set drifted');
    for (const [cat, want] of Object.entries(EXPECTED_CATEGORY)) {
      assert.strictEqual(catalog[cat].label, want.label, `trip.html ${cat} label drifted`);
      assert.strictEqual(catalog[cat].pax, want.passengers, `trip.html ${cat} pax drifted`);
      assert.strictEqual(catalog[cat].bags, want.bags, `trip.html ${cat} bags drifted`);
    }
  });

  check('create-booking VEHICLE_TYPE map, VEHICLE_KEYS and CAPACITY table match', () => {
    const map = extractLiteral(createBooking, 'const VEHICLE_TYPE = {', '{', '}', 'create-booking map');
    for (const key of EXPECTED_KEYS) {
      assert.strictEqual(map[EXPECTED[key].name], EXPECTED[key].category,
        `create-booking: display name "${EXPECTED[key].name}" must normalize to ${EXPECTED[key].category}`);
    }
    for (const cat of ['sedan', 'suv', 'sprinter']) {
      assert.strictEqual(map[cat], cat, `create-booking: category ${cat} must self-map`);
    }
    const keys = extractLiteral(createBooking, 'const VEHICLE_KEYS = [', '[', ']', 'create-booking keys');
    assert.deepStrictEqual(keys, EXPECTED_KEYS, 'create-booking VEHICLE_KEYS drifted');
    // The CAPACITY table is DISPLAY-ONLY: it controls the Telegram
    // doorbell's "N of M" figures and nothing else — the actual booking
    // validation is the independent hardcoded ceiling pinned in the
    // ceilings check below.
    const capacity = extractLiteral(createBooking, 'const CAPACITY = {', '{', '}', 'create-booking capacity');
    assert.deepStrictEqual(Object.keys(capacity).sort(), Object.keys(EXPECTED_CATEGORY).sort(),
      'create-booking CAPACITY category set drifted');
    for (const [cat, want] of Object.entries(EXPECTED_CATEGORY)) {
      assert.deepStrictEqual(capacity[cat], [want.passengers, want.bags],
        `create-booking CAPACITY.${cat} drifted`);
    }
  });

  check('update-pending-booking copies are IDENTICAL to create-booking (never diverge)', () => {
    const mapA = extractLiteral(createBooking, 'const VEHICLE_TYPE = {', '{', '}', 'create-booking map');
    const mapB = extractLiteral(updatePending, 'const VEHICLE_TYPE = {', '{', '}', 'update-pending map');
    assert.deepStrictEqual(mapB, mapA, 'the two endpoints VEHICLE_TYPE maps diverged');
    const keysB = extractLiteral(updatePending, 'const VEHICLE_KEYS = [', '[', ']', 'update-pending keys');
    assert.deepStrictEqual(keysB, EXPECTED_KEYS, 'update-pending VEHICLE_KEYS drifted');
  });

  check('validation CEILINGS equal the largest vehicle capacity (endpoints + BOTH installed RPCs)', () => {
    // These four hardcoded limits are invisible to every copy above: a
    // future operator could raise Sprinter to 13/16 in all nine pinned
    // copies, P0 would pass, and bookings would still be rejected here.
    // Deriving the ceiling FROM the EXPECTED table forces a capacity
    // change and a ceiling change to travel together.
    const maxPax = Math.max(...EXPECTED_KEYS.map((k) => EXPECTED[k].passengers));
    const maxBags = Math.max(...EXPECTED_KEYS.map((k) => EXPECTED[k].bags));
    for (const [label, src] of [['create-booking', createBooking], ['update-pending-booking', updatePending]]) {
      assert.match(src, new RegExp(`passengers < 1 \\|\\| passengers > ${maxPax}`),
        `${label}: passenger ceiling must be ${maxPax} (the largest vehicle)`);
      assert.match(src, new RegExp(`bags < 0 \\|\\| bags > ${maxBags}`),
        `${label}: bag ceiling must be ${maxBags} (the largest vehicle)`);
    }
    for (const fn of ['accept_quote_create', 'accept_quote_edit']) {
      const body = extractSqlFunction(m018, fn);
      assert.match(body, new RegExp(`v_passengers\\s*<\\s*1\\s+OR\\s+v_passengers\\s*>\\s*${maxPax}`),
        `${fn}: SQL passenger ceiling must be ${maxPax}`);
      assert.match(body, new RegExp(`v_bags\\s*<\\s*0\\s+OR\\s+v_bags\\s*>\\s*${maxBags}`),
        `${fn}: SQL bag ceiling must be ${maxBags}`);
    }
  });

  check('the two LAST-RESORT vehicle-key lists match the canonical order', () => {
    // When the pricing service is unavailable, the browser falls back to a
    // hardcoded key list in two places. Built from EXPECTED, so a vehicle
    // change makes these anchors fail loudly instead of silently serving
    // a stale fleet.
    const literal = `\\[${EXPECTED_KEYS.map((k) => `'${k}'`).join(', ')}\\]`;
    assert.match(indexMvp, new RegExp(`getAllVehicles\\(\\)\\s*:\\s*${literal}`),
      'indexMVP price-update last-resort list drifted');
    assert.match(carouselHtml, new RegExp(`this\\.vehicles\\.map\\(v => v\\.id\\)\\s*:\\s*${literal}`),
      'carousel clearPrices last-resort list drifted');
  });

  check('migration 018 (INSTALLED writers): key allowlist + key->category + key->name in BOTH RPCs', () => {
    for (const fn of ['accept_quote_create', 'accept_quote_edit']) {
      const body = extractSqlFunction(m018, fn);
      assert.ok(body.includes(`NOT IN ('tesla','escalade','sprinter')`),
        `${fn}: vehicle-key allowlist drifted or moved`);
      for (const key of EXPECTED_KEYS) {
        const cat = new RegExp(`WHEN\\s+'${key}'\\s+THEN\\s+'${EXPECTED[key].category}'`);
        assert.match(body, cat, `${fn}: ${key} -> ${EXPECTED[key].category} category CASE drifted`);
        const name = new RegExp(`WHEN\\s+'${key}'\\s+THEN\\s+'${EXPECTED[key].name}'`);
        assert.match(body, name, `${fn}: ${key} -> "${EXPECTED[key].name}" name CASE drifted`);
      }
    }
  });

  results.forEach((x) => console.log(x));
  console.log(`\n  ALL ${checks} CHECKS PASS\n`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
