// PR 3C-2A — ride-quote engine: golden parity against the REAL
// pricing.js, rate-card validation, ride-input validation, timezone
// independence, DST, integer-cent guarantees, determinism.
//
// Run: node tests/ride-quote.test.js
//
// GOLDEN METHODOLOGY: the live browser calculator (pricing.js) is
// loaded UNMODIFIED under vm (exports stripped textually, debug
// stubbed) and asked the same questions as the new engine. Because the
// live calculator prices in the BROWSER'S local timezone, this test
// process pins TZ=America/New_York — the canonical Miami browser —
// making golden outputs the reachable production fares the engine must
// match to the cent. The engine itself is timezone-independent (proven
// separately with child processes under other TZ values).

process.env.TZ = 'America/New_York'; // MUST precede any Date use

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const {
  LINKMIA_RATE_CARD,
  validateRateCard,
  isValidatedRateCard
} = require(path.join(repoRoot, 'backend/functions/lib/ride-rate-card.js'));
const { quoteRide } = require(path.join(repoRoot, 'backend/functions/lib/ride-quote.js'));

const CARD = validateRateCard(LINKMIA_RATE_CARD);

// ---------- golden reference: the REAL pricing.js under vm ----------
function loadGoldenService() {
  const src = fs.readFileSync(path.join(repoRoot, 'pricing.js'), 'utf8')
    .replace(/^export class /m, 'class ')
    .replace(/^export const /m, 'const ');
  const context = {
    console,
    debug: { warn() {}, info() {}, group() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: 'pricing.js' });
  return vm.runInContext('new PricingService()', context);
}
const golden = loadGoldenService();

function goldenPrice(vehicle, miles, minutes, dateTime, origin, destination) {
  const options = {};
  if (dateTime) options.dateTime = dateTime;
  if (origin) options.origin = origin;
  if (destination) options.destination = destination;
  return golden.calculateVehiclePrice(vehicle, miles, minutes, options);
}

function engineQuote(vehicle, miles, minutes, pickupAtMs, extra = {}) {
  return quoteRide({
    vehicle,
    routeMiles: miles,
    routeMinutes: minutes,
    pickupAtMs,
    passengers: 1,
    bags: 0,
    rateCard: CARD,
    ...extra
  });
}

function assertParity(vehicle, miles, minutes, dateTime, origin, destination) {
  const g = goldenPrice(vehicle, miles, minutes, dateTime, origin, destination);
  const q = engineQuote(vehicle, miles, minutes, dateTime.getTime(),
    origin ? { originCode: origin, destinationCode: destination } : {});
  assert.ok(q.ok, `engine refused ${vehicle} ${miles}mi ${minutes}min: ${JSON.stringify(q.error || {})}`);
  assert.ok(g && !g.error, `golden refused ${vehicle} ${miles}mi`);
  const label = `${vehicle} ${miles}mi ${minutes}min @${dateTime.toISOString()}`;
  assert.strictEqual(q.quote.finalCents, Math.round(g.finalPrice * 100), `finalCents mismatch: ${label}`);
  assert.strictEqual(q.quote.baseCents, Math.round(g.basePrice * 100), `baseCents mismatch: ${label}`);
  assert.strictEqual(q.quote.protectionApplied, g.protectionApplied, `protection mismatch: ${label}`);
  assert.strictEqual(q.quote.airportFeeCents, Math.round(g.breakdown.dynamicAirportFee * 100),
    `airportFee mismatch: ${label}`);
  assert.strictEqual(q.quote.hourlyPriceCents, Math.round(g.breakdown.hourlyPrice * 100),
    `hourly mismatch: ${label}`);
  // JSON-compare: golden arrays come from the vm realm, whose
  // Array.prototype differs — deepStrictEqual would fail on the
  // prototype even for identical contents.
  assert.strictEqual(
    JSON.stringify(q.quote.appliedSurcharges.map((s) => s.type)),
    JSON.stringify([...g.breakdown.appliedSurcharges].map((s) => s.type)),
    `surcharge set mismatch: ${label}`);
  for (let i = 0; i < q.quote.appliedSurcharges.length; i++) {
    assert.strictEqual(q.quote.appliedSurcharges[i].amountCents,
      Math.round(g.breakdown.appliedSurcharges[i].amount * 100),
      `surcharge amount mismatch: ${label}`);
  }
  assert.strictEqual(q.quote.pricingVersion, CARD.pricingVersion, 'pricingVersion must ride every quote');
  return q.quote;
}

// Local-time constructors (process TZ is Miami, so these ARE Miami
// wall-clock times); UTC-constructed instants used where the exact
// instant matters (DST, holiday-quirk boundaries).
const miami = (s) => new Date(s);              // e.g. '2026-08-18T14:00:00'
const utc = (s) => new Date(s + 'Z');

const NEUTRAL = miami('2026-08-18T14:00:00'); // Tue 2pm — no surcharges

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}

(async () => {
  // ---------- golden parity: distances × vehicles ----------
  await check('GOLDEN: every vehicle, every tier boundary (before/at/after), fee thresholds, service limit', async () => {
    const distances = [0.5, 5, 8, 9.9, 10, 10.1, 14.9, 15, 15.5, 16, 16.1, 28, 29.9, 30, 30.1,
      45, 49.9, 50, 50.5, 51, 51.1, 59.9, 60, 60.1, 75, 99.9, 100, 100.5, 101, 101.1,
      150, 240, 279.5, 280];
    let comparisons = 0;
    for (const vehicle of ['tesla', 'escalade', 'sprinter']) {
      for (const miles of distances) {
        for (const minutes of [20, Math.max(30, miles * 1.2)]) {
          assertParity(vehicle, miles, minutes, NEUTRAL);
          comparisons++;
        }
      }
    }
    assert.ok(comparisons >= 200, `expected a real matrix, got ${comparisons}`);
  });

  await check('GOLDEN: mileage fare vs hourly protection crossover (both directions)', async () => {
    // Short trip, long duration -> hourly wins; long trip, short duration -> tiered wins.
    const slow = assertParity('tesla', 5, 90, NEUTRAL);
    assert.strictEqual(slow.protectionApplied, 'hourly');
    const fast = assertParity('tesla', 100, 90, NEUTRAL);
    assert.strictEqual(fast.protectionApplied, 'tiered');
    assertParity('escalade', 12, 75, NEUTRAL);
    assertParity('sprinter', 8, 45, NEUTRAL);
  });

  await check('GOLDEN: night/weekend/peak boundaries — exact hour edges in Miami wall clock', async () => {
    const times = [
      miami('2026-08-18T21:59:00'), // not night
      miami('2026-08-18T22:00:00'), // night starts
      miami('2026-08-18T23:30:00'), // night
      miami('2026-08-19T05:59:00'), // still night
      miami('2026-08-19T06:00:00'), // night ends
      miami('2026-08-18T06:59:00'), // before peak
      miami('2026-08-18T07:00:00'), // peak starts
      miami('2026-08-18T08:59:00'), // peak
      miami('2026-08-18T09:00:00'), // peak ends
      miami('2026-08-22T14:00:00'), // Saturday: weekend
      miami('2026-08-23T14:00:00'), // Sunday: weekend
      miami('2026-08-22T23:00:00'), // Saturday night: weekend + night
      miami('2026-08-23T07:30:00')  // Sunday peak: weekend + peak
    ];
    for (const t of times) {
      for (const vehicle of ['tesla', 'sprinter']) {
        assertParity(vehicle, 28, 40, t);
        assertParity(vehicle, 8, 20, t);
      }
    }
  });

  await check('GOLDEN + PRESERVED QUIRK: holiday matches the UTC date, not the Miami date', async () => {
    // 2026-07-04 10:00 Miami = 14:00Z Jul 4 -> holiday applies (and Jul 4 2026 is a Saturday -> weekend too).
    const onHoliday = assertParity('escalade', 28, 40, miami('2026-07-04T10:00:00'));
    assert.ok(onHoliday.appliedSurcharges.some((s) => s.type === 'holiday'));
    assert.ok(onHoliday.appliedSurcharges.some((s) => s.type === 'weekend'));
    // 2026-07-04 21:00 Miami = 01:00Z Jul 5 -> the UTC-date check MISSES the holiday evening.
    const missed = assertParity('escalade', 28, 40, miami('2026-07-04T21:00:00'));
    assert.ok(!missed.appliedSurcharges.some((s) => s.type === 'holiday'),
      'production quirk: July 4th evening in Miami is NOT a holiday by the UTC-date check');
    // 2026-07-03 21:00 Miami = 01:00Z Jul 4 -> holiday fires a night EARLY.
    const early = assertParity('escalade', 28, 40, miami('2026-07-03T21:00:00'));
    assert.ok(early.appliedSurcharges.some((s) => s.type === 'holiday'),
      'production quirk: the evening BEFORE July 4th picks up the holiday surcharge');
    // Thanksgiving morning peak: holiday + peak combined.
    const combo = assertParity('tesla', 12, 25, miami('2026-11-26T08:00:00'));
    assert.deepStrictEqual(combo.appliedSurcharges.map((s) => s.type).sort(), ['holiday', 'peak']);
  });

  await check('GOLDEN + PRESERVED QUIRK: stacked surcharge amounts understate the compound delta', async () => {
    const q = assertParity('sprinter', 28, 40, miami('2026-08-22T23:00:00')); // night + weekend
    const amountSum = q.appliedSurcharges.reduce((sum, s) => sum + s.amountCents, 0);
    const actualDelta = q.finalCents - q.baseCents;
    // amounts are computed on base individually; the compounded final
    // includes base*(1.15*1.10-1) which exceeds base*(0.15+0.10) —
    // before psychological rounding blurs it further. Just pin that the
    // recorded amounts equal base*(rate-1) exactly (parity already
    // checked) and that they do NOT sum to the applied delta here.
    assert.notStrictEqual(amountSum, actualDelta);
  });

  await check('GOLDEN: popular routes (code path parity; UNREACHABLE in production booking — recorded)', async () => {
    const routes = [
      ['MIA', 'MCO', 240, 210], ['MCO', 'MIA', 240, 210],
      ['MIA', 'TPA', 280, 250], ['TPA', 'MIA', 280, 250],
      ['FLL', 'PBI', 45, 55], ['PBI', 'FLL', 45, 55]
    ];
    for (const [o, d, miles, minutes] of routes) {
      for (const vehicle of ['tesla', 'escalade', 'sprinter']) {
        const q = assertParity(vehicle, miles, minutes, NEUTRAL, o, d);
        assert.ok(q.popularRoute, 'flat-rate route must be recorded on the quote');
        assert.strictEqual(q.tierBreakdown, null);
      }
    }
    // Case-insensitive matching parity.
    assertParity('tesla', 240, 210, NEUTRAL, 'mia', 'mco');
    // Non-matching pair falls back to tiered pricing (parity).
    const normal = assertParity('tesla', 240, 210, NEUTRAL, 'MIA', 'XYZ');
    assert.strictEqual(normal.popularRoute, null);
  });

  await check('GOLDEN: psychological rounding bands (9/5/45/95 endings) across price magnitudes', async () => {
    // Distances/durations chosen to land raw prices in each band:
    // <$50, $50-150, $150-500, >$500 — parity IS the assertion; also
    // pin the integer-dollar endings the auto strategy produces.
    const cases = [
      ['tesla', 3, 10], ['tesla', 12, 20], ['tesla', 30, 45],
      ['escalade', 45, 60], ['sprinter', 100, 120], ['sprinter', 240, 230]
    ];
    for (const [vehicle, miles, minutes] of cases) {
      const q = assertParity(vehicle, miles, minutes, NEUTRAL);
      if (q.finalCents >= 1000) {
        assert.strictEqual(q.finalCents % 100, 0,
          'auto psychological pricing produces whole-dollar fares at/above the threshold');
        const dollars = q.finalCents / 100;
        assert.ok([9, 5].includes(dollars % 10) || [45, 95].includes(dollars % 100),
          `unexpected ending for $${dollars}`);
      }
    }
  });

  await check('GOLDEN: DST transitions price identically to the live calculator', async () => {
    const instants = [
      utc('2026-03-08T06:30:00'), // 01:30 EST, minutes before spring forward
      utc('2026-03-08T07:30:00'), // 03:30 EDT, minutes after (02:xx never exists)
      utc('2026-11-01T05:30:00'), // 01:30 EDT (first pass)
      utc('2026-11-01T06:30:00'), // 01:30 EST (second pass)
      utc('2026-11-01T10:59:00')  // 05:59 EST — last minute of night
    ];
    for (const t of instants) {
      assertParity('tesla', 28, 40, t);
      assertParity('sprinter', 8, 20, t);
    }
  });

  await check('service limit: 280 prices, beyond 280 refuses on BOTH sides', async () => {
    assertParity('tesla', 280, 260, NEUTRAL);
    const g = goldenPrice('tesla', 280.1, 260, NEUTRAL);
    assert.strictEqual(g.error, true);
    const q = engineQuote('tesla', 280.1, 260, NEUTRAL.getTime());
    assert.strictEqual(q.ok, false);
    assert.strictEqual(q.error.code, 'distance_exceeds_service_area');
    assert.strictEqual(q.error.details.maxDistanceMiles, 280);
  });

  // ---------- ride-input validation ----------
  await check('unknown vehicle refused with the known-vehicle list (no silent alias mapping)', async () => {
    for (const bad of ['suv', 'sedan', 'TESLA', '', null, undefined, 42]) {
      const q = engineQuote(bad, 10, 20, NEUTRAL.getTime());
      assert.strictEqual(q.ok, false, `vehicle ${String(bad)} must be refused`);
      assert.strictEqual(q.error.code, 'unknown_vehicle');
      assert.deepStrictEqual(q.error.details.knownVehicles, ['tesla', 'escalade', 'sprinter']);
    }
  });

  await check('malformed route facts and pickup time refused deterministically', async () => {
    const bads = [
      [{ routeMiles: NaN }, 'invalid_route_facts'],
      [{ routeMiles: Infinity }, 'invalid_route_facts'],
      [{ routeMiles: -1 }, 'invalid_route_facts'],
      [{ routeMiles: '12' }, 'invalid_route_facts'],
      [{ routeMinutes: NaN }, 'invalid_route_facts'],
      [{ routeMinutes: -5 }, 'invalid_route_facts'],
      [{ pickupAtMs: NaN }, 'invalid_pickup_time'],
      [{ pickupAtMs: '2026-08-18' }, 'invalid_pickup_time'],
      [{ pickupAtMs: undefined }, 'invalid_pickup_time'],
      [{ bookingMode: 'hourly' }, 'invalid_booking_mode']
    ];
    for (const [patch, code] of bads) {
      const q = quoteRide({
        vehicle: 'tesla', routeMiles: 10, routeMinutes: 20,
        pickupAtMs: NEUTRAL.getTime(), passengers: 1, bags: 0, rateCard: CARD,
        ...patch
      });
      assert.strictEqual(q.ok, false, JSON.stringify(patch));
      assert.strictEqual(q.error.code, code, JSON.stringify(patch));
    }
  });

  await check('passenger/bag counts: integers only, at least one passenger, never fractional', async () => {
    for (const [patch, code] of [
      [{ passengers: 0 }, 'invalid_passengers'],
      [{ passengers: -1 }, 'invalid_passengers'],
      [{ passengers: 2.5 }, 'invalid_passengers'],
      [{ passengers: '2' }, 'invalid_passengers'],
      [{ bags: -1 }, 'invalid_bags'],
      [{ bags: 1.5 }, 'invalid_bags']
    ]) {
      const q = quoteRide({
        vehicle: 'tesla', routeMiles: 10, routeMinutes: 20,
        pickupAtMs: NEUTRAL.getTime(), passengers: 1, bags: 0, rateCard: CARD,
        ...patch
      });
      assert.strictEqual(q.ok, false);
      assert.strictEqual(q.error.code, code);
    }
  });

  await check('capacity: at/below limit prices, above refuses with structured upgrade guidance', async () => {
    for (const [vehicle, cap] of [['tesla', 4], ['escalade', 7], ['sprinter', 12]]) {
      assert.ok(engineQuote(vehicle, 10, 20, NEUTRAL.getTime(), { passengers: cap }).ok, `${vehicle} at limit`);
      assert.ok(engineQuote(vehicle, 10, 20, NEUTRAL.getTime(), { passengers: cap - 1 }).ok);
      const over = engineQuote(vehicle, 10, 20, NEUTRAL.getTime(), { passengers: cap + 1 });
      assert.strictEqual(over.ok, false);
      assert.strictEqual(over.error.code, 'passenger_capacity_exceeded');
      assert.strictEqual(over.error.details.limit, cap);
      assert.strictEqual(over.error.details.requested, cap + 1);
    }
    // Structured guidance: 5 passengers in a Tesla -> Escalade + Sprinter fit.
    const five = engineQuote('tesla', 10, 20, NEUTRAL.getTime(), { passengers: 5 });
    assert.deepStrictEqual(five.error.details.compatibleVehicles.map((v) => v.vehicle),
      ['escalade', 'sprinter']);
    // 13 passengers fit NOTHING — guidance is honest, never auto-splits.
    const thirteen = engineQuote('sprinter', 10, 20, NEUTRAL.getTime(), { passengers: 13 });
    assert.deepStrictEqual(thirteen.error.details.compatibleVehicles, []);
    // Bags: at/above each limit; 9 bags + 5 passengers -> Sprinter only.
    for (const [vehicle, cap] of [['tesla', 4], ['escalade', 8], ['sprinter', 15]]) {
      assert.ok(engineQuote(vehicle, 10, 20, NEUTRAL.getTime(), { bags: cap }).ok, `${vehicle} bags at limit`);
      const over = engineQuote(vehicle, 10, 20, NEUTRAL.getTime(), { bags: cap + 1 });
      assert.strictEqual(over.ok, false);
      assert.strictEqual(over.error.code, 'bag_capacity_exceeded');
    }
    const bulky = engineQuote('escalade', 10, 20, NEUTRAL.getTime(), { passengers: 5, bags: 9 });
    assert.deepStrictEqual(bulky.error.details.compatibleVehicles.map((v) => v.vehicle), ['sprinter']);
  });

  await check('exactly one vehicle per quote: vehiclesRequested !== 1 refused, vehiclesNeeded always 1', async () => {
    for (const n of [0, 2, 3]) {
      const q = engineQuote('sprinter', 10, 20, NEUTRAL.getTime(), { vehiclesRequested: n });
      assert.strictEqual(q.ok, false);
      assert.strictEqual(q.error.code, 'multiple_vehicles_unsupported');
    }
    const ok = engineQuote('sprinter', 10, 20, NEUTRAL.getTime());
    assert.strictEqual(ok.quote.vehiclesNeeded, 1);
  });

  // ---------- rate-card validation ----------
  await check('unvalidated or foreign rate cards are refused outright', async () => {
    for (const card of [LINKMIA_RATE_CARD, {}, null, undefined, { pricingVersion: 'x' }]) {
      const q = quoteRide({
        vehicle: 'tesla', routeMiles: 10, routeMinutes: 20,
        pickupAtMs: NEUTRAL.getTime(), passengers: 1, bags: 0, rateCard: card
      });
      assert.strictEqual(q.ok, false);
      assert.strictEqual(q.error.code, 'rate_card_not_validated');
    }
    assert.ok(isValidatedRateCard(CARD));
    assert.ok(!isValidatedRateCard(LINKMIA_RATE_CARD));
  });

  await check('validateRateCard rejects every malformed configuration class', async () => {
    const mutate = (fn) => {
      const c = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
      fn(c);
      assert.throws(() => validateRateCard(c), /Invalid rate card/,
        `expected rejection for ${fn.toString().slice(0, 80)}`);
    };
    mutate((c) => { c.pricingVersion = ''; });
    mutate((c) => { c.pricingVersion = 42; });
    mutate((c) => { c.strategy = 'surge-v9'; });
    mutate((c) => { c.vehicles.limo = c.vehicles.tesla; });            // unknown vehicle key / alias
    mutate((c) => { delete c.vehicles.tesla.name; });
    mutate((c) => { c.vehicles.tesla.capacity.passengers = 0; });
    mutate((c) => { c.vehicles.tesla.capacity.bags = 2.5; });
    mutate((c) => { c.vehicles.tesla.airportFeeCents = 10.5; });       // fractional cents
    mutate((c) => { c.vehicles.tesla.airportFeeCents = -1; });
    mutate((c) => { c.vehicles.tesla.hourlyProtectionCentsPerHour = 0; });
    mutate((c) => { c.vehicles.tesla.tiers[1].minMiles = 20; });       // gap
    mutate((c) => { c.vehicles.tesla.tiers[1].minMiles = 10; });       // overlap/duplicate
    mutate((c) => { c.vehicles.tesla.tiers[0].ratePerMileCents = NaN; });
    mutate((c) => { c.vehicles.tesla.tiers[0].ratePerMileCents = Infinity; });
    mutate((c) => { c.vehicles.tesla.tiers[3].maxMiles = 300; });      // exceeds card max: inconsistent
    mutate((c) => { c.vehicles.tesla.maxDistanceMiles = 200; });       // max-distance inconsistency
    mutate((c) => { c.airportFeeScaling = [{ maxMiles: 30, factor: 0.75 }, { maxMiles: 10, factor: 1 }]; });
    mutate((c) => { c.airportFeeScalingBeyondFactor = -0.5; });
    mutate((c) => { c.surcharges.night.rate = 0.9; });
    mutate((c) => { c.surcharges.peak.startHour = 25; });
    mutate((c) => { c.surcharges.weekend.days = [7]; });
    mutate((c) => { c.holidaysUtc.push('July 4'); });
    mutate((c) => { c.holidaysUtc.push('2026-01-01'); });              // duplicate
    mutate((c) => { delete c.popularRoutes['MIA-MCO'].flatRateCents.sprinter; }); // coverage hole
    mutate((c) => { c.popularRoutes['MIA-MCO'].flatRateCents.limo = 100; });
    mutate((c) => { c.psychologicalPricing.strategy = 'always7'; });
    mutate((c) => { c.psychologicalPricing.thresholdCents = 9.99; });
  });

  await check('validated card is deeply frozen and immune to later mutation of the source object', async () => {
    assert.ok(Object.isFrozen(CARD));
    assert.ok(Object.isFrozen(CARD.vehicles.tesla));
    assert.ok(Object.isFrozen(CARD.vehicles.tesla.tiers[0]));
    // Mutating a validated card silently fails (non-strict) and changes nothing.
    const before = engineQuote('tesla', 28, 40, NEUTRAL.getTime()).quote.finalCents;
    try { CARD.vehicles.tesla.tiers[0].ratePerMileCents = 99999; } catch (e) { /* strict throw ok */ }
    assert.strictEqual(CARD.vehicles.tesla.tiers[0].ratePerMileCents, 325);
    // Mutating the ORIGINAL object after validation cannot reach the clone.
    const source = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    const validated = validateRateCard(source);
    source.vehicles.tesla.tiers[0].ratePerMileCents = 99999;
    const after = quoteRide({
      vehicle: 'tesla', routeMiles: 28, routeMinutes: 40,
      pickupAtMs: NEUTRAL.getTime(), passengers: 1, bags: 0, rateCard: validated
    }).quote.finalCents;
    assert.strictEqual(after, before);
  });

  // ---------- engine guarantees ----------
  await check('every money field is integer cents, everywhere in the quote', async () => {
    const q = engineQuote('sprinter', 28.7, 44, miami('2026-08-22T23:00:00').getTime()).quote;
    const moneyFields = [q.tieredTotalCents, q.airportFeeCents, q.hourlyPriceCents,
      q.baseCents, q.finalCents,
      ...q.appliedSurcharges.map((s) => s.amountCents),
      ...(q.tierBreakdown || []).map((t) => t.subtotalCents)];
    for (const cents of moneyFields) {
      assert.ok(Number.isInteger(cents), `non-integer cents: ${cents}`);
    }
  });

  await check('determinism: identical input -> identical output; caller inputs never mutated', async () => {
    const input = Object.freeze({
      vehicle: 'escalade', routeMiles: 33.3, routeMinutes: 47,
      pickupAtMs: miami('2026-07-03T21:00:00').getTime(),
      passengers: 3, bags: 2, rateCard: CARD,
      originCode: 'MIA', destinationCode: 'MCO'
    });
    const snapshot = JSON.stringify(input);
    const a = quoteRide(input);
    const b = quoteRide(input);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(JSON.stringify(input), snapshot, 'input must not be mutated');
    assert.ok(a.ok && a.quote.pricingVersion === CARD.pricingVersion);
  });

  await check('TIMEZONE INDEPENDENCE: identical quotes under TZ=UTC and TZ=America/Los_Angeles child processes', async () => {
    const script = `
      const { LINKMIA_RATE_CARD, validateRateCard } = require(${JSON.stringify(path.join(repoRoot, 'backend/functions/lib/ride-rate-card.js'))});
      const { quoteRide } = require(${JSON.stringify(path.join(repoRoot, 'backend/functions/lib/ride-quote.js'))});
      const card = validateRateCard(LINKMIA_RATE_CARD);
      // Derived TZ-independently inside the child: neutral Tuesday,
      // holiday-by-UTC-date morning, the missed holiday evening (quirk),
      // Miami night, and a fall-back DST instant.
      const instants = [
        Date.UTC(2026, 7, 18, 18, 0),  // Tue Aug 18, 14:00 Miami — no surcharges
        Date.UTC(2026, 6, 4, 14, 0),   // Jul 4 10:00 Miami — holiday + weekend
        Date.UTC(2026, 6, 5, 1, 0),    // Jul 4 21:00 Miami — UTC-date quirk: NOT holiday
        Date.UTC(2026, 7, 19, 3, 0),   // Aug 18 23:00 Miami — night
        Date.UTC(2026, 10, 1, 6, 30)   // Nov 1 01:30 EST (second pass) — night
      ];
      const out = instants.map((ms) => quoteRide({
        vehicle: 'sprinter', routeMiles: 28, routeMinutes: 40, pickupAtMs: ms,
        passengers: 2, bags: 1, rateCard: card
      }).quote).map((q) => [q.finalCents, q.appliedSurcharges.map((s) => s.type).join('+')]);
      process.stdout.write(JSON.stringify(out));
    `;
    const runIn = (tz) => execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: tz }, encoding: 'utf8'
    });
    const utcOut = runIn('UTC');
    const laOut = runIn('America/Los_Angeles');
    const miamiOut = runIn('America/New_York');
    assert.strictEqual(utcOut, laOut, 'UTC vs Los_Angeles must be identical');
    assert.strictEqual(utcOut, miamiOut, 'UTC vs New_York must be identical');
    assert.ok(JSON.parse(utcOut).some(([, s]) => s.length > 0), 'the fixture set must include surcharge-active instants');
  });

  if (failures.length) {
    console.error(`\n${failures.length} FAILED`);
    process.exit(1);
  }
  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => {
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
