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
    assert.strictEqual(q.quote.appliedSurcharges[i].rate,
      g.breakdown.appliedSurcharges[i].rate, `surcharge rate mismatch: ${label}`);
    assert.strictEqual(q.quote.appliedSurcharges[i].description,
      g.breakdown.appliedSurcharges[i].description, `surcharge description mismatch: ${label}`);
  }
  // Breakdown payload parity — these are the audit/display fields a
  // future endpoint persists; cent corruption here must not survive.
  assert.strictEqual(q.quote.tieredTotalCents, Math.round(g.breakdown.tieredTotal * 100),
    `tieredTotal mismatch: ${label}`);
  if (g.breakdown.popularRoute) {
    assert.ok(q.quote.popularRoute, `popularRoute missing on engine side: ${label}`);
    assert.strictEqual(q.quote.popularRoute.flatRateCents,
      Math.round(g.breakdown.popularRoute.flatRate * 100), `flat rate mismatch: ${label}`);
    assert.strictEqual(q.quote.popularRoute.description,
      g.breakdown.popularRoute.description, `route description mismatch: ${label}`);
  } else {
    assert.strictEqual(q.quote.popularRoute, null, `unexpected popularRoute: ${label}`);
  }
  if (g.breakdown.tierBreakdown) {
    assert.strictEqual((q.quote.tierBreakdown || []).length, g.breakdown.tierBreakdown.length,
      `tierBreakdown length mismatch: ${label}`);
    for (let i = 0; i < g.breakdown.tierBreakdown.length; i++) {
      assert.strictEqual(q.quote.tierBreakdown[i].miles, g.breakdown.tierBreakdown[i].miles,
        `tier miles mismatch: ${label}`);
      assert.strictEqual(q.quote.tierBreakdown[i].subtotalCents,
        Math.round(g.breakdown.tierBreakdown[i].subtotal * 100), `tier subtotal mismatch: ${label}`);
    }
  } else {
    assert.strictEqual(q.quote.tierBreakdown, null, `unexpected tierBreakdown: ${label}`);
  }
  // Canonical echoes + identity parity.
  assert.strictEqual(q.quote.vehicleName, g.vehicleName, `vehicleName mismatch: ${label}`);
  assert.strictEqual(q.quote.vehicle, vehicle);
  assert.strictEqual(q.quote.routeMiles, g.distance, `distance echo mismatch: ${label}`);
  assert.strictEqual(q.quote.routeMinutes, g.duration, `duration echo mismatch: ${label}`);
  if (g.breakdown.tierBreakdown) {
    for (let i = 0; i < g.breakdown.tierBreakdown.length; i++) {
      assert.strictEqual(q.quote.tierBreakdown[i].ratePerMileCents,
        Math.round(g.breakdown.tierBreakdown[i].rate * 100), `tier rate mismatch: ${label}`);
    }
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
      miami('2026-08-23T07:30:00'), // Sunday peak: weekend + peak
      miami('2026-08-17T14:00:00'), // MONDAY afternoon: NO weekend — pins the weekday map
      miami('2026-08-23T23:59:00'), // Sunday 23:59: weekend + night (last weekend minute)
      miami('2026-08-24T00:30:00')  // Monday 00:30: night only — weekend must have ENDED
    ];
    for (const t of times) {
      for (const vehicle of ['tesla', 'sprinter']) {
        assertParity(vehicle, 28, 40, t);
        assertParity(vehicle, 8, 20, t);
      }
    }
    // Pin the weekday map explicitly for the two days the fixture set
    // exercises at the weekend boundary (a wrong Mon mapping must fail
    // HERE, not survive as a phantom Monday surcharge).
    const monday = engineQuote('tesla', 28, 40, miami('2026-08-17T14:00:00').getTime()).quote;
    assert.deepStrictEqual(monday.appliedSurcharges, [], 'Monday afternoon carries NO surcharges');
    const mondayNight = engineQuote('tesla', 28, 40, miami('2026-08-24T00:30:00').getTime()).quote;
    assert.deepStrictEqual(mondayNight.appliedSurcharges.map((s) => s.type), ['night'],
      'Monday 00:30 is night only — never weekend');
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
    // Band coverage must be REAL, not accidental: each raw pre-rounding
    // price must land in the intended band (a future rate change that
    // collapses the fixtures into fewer bands must fail loudly).
    const bandOf = (baseCents) => {
      const d = baseCents / 100;
      return d < 50 ? '<50' : d < 150 ? '50-150' : d < 500 ? '150-500' : '500+';
    };
    const observedBands = new Set(cases.map(([vehicle, miles, minutes]) =>
      bandOf(engineQuote(vehicle, miles, minutes, NEUTRAL.getTime()).quote.baseCents)));
    assert.deepStrictEqual([...observedBands].sort(),
      ['150-500', '50-150', '500+', '<50'].sort(), 'fixtures must cover all four bands');
    // The two documented discontinuity edges that only exact values can
    // pin: a raw price of exactly $500.00 uses the 45/95 band (not the
    // 150-500 band), and exactly $10.00 is AT the threshold (rounds to
    // $9, not passed through). Both engineered via exact hourly bases.
    const edge500 = assertParity('sprinter', 0, 200, NEUTRAL); // hourly: 200/60*150 = $500.00
    assert.strictEqual(edge500.baseCents, 50000);
    assert.strictEqual(edge500.finalCents, 54500, 'raw $500.00 must round UP into the 45/95 band ($545)');
    const edge10 = assertParity('tesla', 0, 6, NEUTRAL); // hourly: 6/60*100 = $10.00
    assert.strictEqual(edge10.baseCents, 1000);
    assert.strictEqual(edge10.finalCents, 900, 'raw $10.00 is at the threshold and rounds to $9');
    // Exact before/at/after triplets around the $50 and $150 band
    // edges, engineered via exact hourly bases (sprinter $150/h and
    // tesla $100/h): the auto strategy is DISCONTINUOUS here and each
    // side must be pinned, not just sampled.
    const b4995 = assertParity('sprinter', 0, 19.998, NEUTRAL); // $49.995 -> <50 band
    assert.strictEqual(b4995.finalCents, 4900, 'raw $49.995 rounds to $50 then band-1 gives $49');
    const b50 = assertParity('sprinter', 0, 20, NEUTRAL);       // $50.00 -> 50-150 band
    assert.strictEqual(b50.finalCents, 4500, 'raw $50.00 lands in band 2 and gives $45');
    const b5001 = assertParity('sprinter', 0, 20.004, NEUTRAL); // $50.01 -> 50-150 band
    assert.strictEqual(b5001.finalCents, 4500);
    const b1499 = assertParity('tesla', 0, 89.94, NEUTRAL);     // $149.90 -> 50-150 band
    assert.strictEqual(b1499.finalCents, 14500, 'raw $149.90 rounds to $150, band-2 %10<3 gives $145');
    const b150 = assertParity('tesla', 0, 90, NEUTRAL);         // $150.00 -> 150-500 band
    assert.strictEqual(b150.finalCents, 14900, 'raw $150.00 lands in band 3 and gives $149');
    const b1501 = assertParity('tesla', 0, 90.06, NEUTRAL);     // $150.10 -> 150-500 band
    assert.strictEqual(b1501.finalCents, 14900);
  });

  await check('static config parity: names, capacities, cancellation fee match the live calculator', async () => {
    for (const key of ['tesla', 'escalade', 'sprinter']) {
      const gv = golden.getVehicleConfig(key);
      const cv = CARD.vehicles[key];
      assert.strictEqual(cv.name, gv.name, `${key} name`);
      assert.strictEqual(cv.capacity.passengers, gv.capacity.passengers, `${key} passengers`);
      assert.strictEqual(cv.capacity.bags, gv.capacity.bags, `${key} bags`);
      assert.strictEqual(cv.airportFeeCents, Math.round(gv.airportFee * 100), `${key} airport fee`);
      assert.strictEqual(cv.hourlyProtectionCentsPerHour, Math.round(gv.hourlyProtection * 100), `${key} hourly`);
      assert.strictEqual(cv.maxDistanceMiles, gv.maxDistance, `${key} max distance`);
      for (let i = 0; i < gv.priceTiers.length; i++) {
        assert.strictEqual(cv.tiers[i].minMiles, gv.priceTiers[i].minMiles, `${key} tier ${i} min`);
        assert.strictEqual(cv.tiers[i].maxMiles, gv.priceTiers[i].maxMiles, `${key} tier ${i} max`);
        assert.strictEqual(cv.tiers[i].ratePerMileCents, Math.round(gv.priceTiers[i].rate * 100), `${key} tier ${i} rate`);
      }
    }
    assert.strictEqual(CARD.cancellationFeeCents, Math.round(golden.getCancellationFee() * 100));
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
    // Prototype-inherited keys are the never-throws regression: a plain
    // chain lookup would find Object.prototype members and crash later.
    for (const bad of ['suv', 'sedan', 'TESLA', '', null, undefined, 42,
      '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const q = engineQuote(bad, 10, 20, NEUTRAL.getTime());
      assert.strictEqual(q.ok, false, `vehicle ${String(bad)} must be refused`);
      assert.strictEqual(q.error.code, 'unknown_vehicle', `vehicle ${String(bad)}`);
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
      // Finite but beyond the valid Date range: must be a structured
      // refusal, never a RangeError from the timezone formatting.
      [{ pickupAtMs: 8640000000000001 }, 'invalid_pickup_time'],
      [{ pickupAtMs: -8640000000000001 }, 'invalid_pickup_time'],
      [{ pickupAtMs: Number.MAX_VALUE }, 'invalid_pickup_time'],
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
    // The exact Date-range boundary itself stays quotable.
    const atLimit = engineQuote('tesla', 10, 20, 8640000000000000);
    assert.strictEqual(atLimit.ok, true, 'the maximum representable instant must still price');
  });

  await check('MONEY SAFETY: unbounded durations refused — Number.MAX_VALUE can never mint Infinity money', async () => {
    for (const minutes of [Number.MAX_VALUE, 1e15, 10081]) {
      const q = engineQuote('sprinter', 10, minutes, NEUTRAL.getTime());
      assert.strictEqual(q.ok, false, `minutes=${minutes} must be refused`);
      assert.strictEqual(q.error.code, 'invalid_route_facts');
    }
    const week = engineQuote('sprinter', 10, 10080, NEUTRAL.getTime());
    assert.strictEqual(week.ok, true, 'the one-week bound itself still prices');
    assert.ok(Number.isSafeInteger(week.quote.finalCents));
  });

  await check('MONEY SAFETY: unsafe or unbounded cent values never validate; extreme bounded cards stay safe', async () => {
    const reject = (fn) => {
      const c = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
      fn(c);
      assert.throws(() => validateRateCard(c), /Invalid rate card/);
    };
    reject((c) => { c.vehicles.tesla.tiers[0].ratePerMileCents = 2 ** 53; });     // unsafe integer
    reject((c) => { c.vehicles.tesla.tiers[0].ratePerMileCents = 100000001; });   // beyond the $1M bound
    reject((c) => { c.vehicles.tesla.hourlyProtectionCentsPerHour = 2 ** 53; });
    reject((c) => { c.cancellationFeeCents = Number.MAX_SAFE_INTEGER + 2; });
    reject((c) => { c.popularRoutes['MIA-MCO'].flatRateCents.tesla = 100000001; });
    reject((c) => { c.surcharges.holiday.rate = 11; });                            // multiplier bound
    reject((c) => { c.airportFeeScaling[0].factor = 101; });                       // factor bound
    reject((c) => { c.airportFeeScalingBeyondFactor = Infinity; });
    reject((c) => { c.maxDistanceMiles = 10001; });
    reject((c) => { c.vehicles.tesla.capacity.passengers = 1001; });
    // Per-field bounds are NOT a cross-field worst-case proof — the
    // guarantee is SAFE REFUSAL, not that every bounded combination
    // quotes. Two extremes pin both halves of that contract:
    // (1) max rates on the PRODUCTION 280-mile structure still quote
    //     with safe-integer money;
    const extreme = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    for (const v of Object.values(extreme.vehicles)) {
      v.tiers.forEach((t) => { t.ratePerMileCents = 100000000; });
      v.airportFeeCents = 100000000;
      v.hourlyProtectionCentsPerHour = 100000000;
    }
    extreme.surcharges.night.rate = 10; extreme.surcharges.weekend.rate = 10;
    extreme.surcharges.peak.rate = 10; extreme.surcharges.holiday.rate = 10;
    const extremeCard = validateRateCard(extreme);
    const worst = quoteRide({
      vehicle: 'sprinter', routeMiles: 280, routeMinutes: 10080,
      pickupAtMs: miami('2026-07-04T08:30:00').getTime(), // weekend+peak+holiday stack
      passengers: 1, bags: 0, rateCard: extremeCard
    });
    assert.strictEqual(worst.ok, true);
    for (const c of [worst.quote.finalCents, worst.quote.baseCents, worst.quote.hourlyPriceCents]) {
      assert.ok(Number.isSafeInteger(c) && c >= 0, `unsafe money at the extreme: ${c}`);
    }
    // (2) a validly-bounded card that maxes EVERYTHING at once (10000-mile
    //     service limit, $1M/mile, four stacked 10x surcharges via wide
    //     valid windows) overflows safe-integer cents — and the output
    //     seal REFUSES it with a structured error: never unsafe money,
    //     never a throw.
    const abyss = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    abyss.maxDistanceMiles = 10000;
    for (const v of Object.values(abyss.vehicles)) {
      v.maxDistanceMiles = 10000;
      v.tiers = [{ minMiles: 0, maxMiles: 10000, ratePerMileCents: 100000000 }];
      v.airportFeeCents = 100000000;
      v.hourlyProtectionCentsPerHour = 100000000;
    }
    abyss.surcharges.night = { startHour: 23, endHour: 22, rate: 10, description: 'night (wraps, all but 22:00)' };
    abyss.surcharges.peak = { startHour: 0, endHour: 23, rate: 10, description: 'peak (0-22)' };
    abyss.surcharges.weekend.rate = 10;
    abyss.surcharges.holiday.rate = 10;
    const abyssCard = validateRateCard(abyss); // individually bounded: validates
    const refused = quoteRide({
      vehicle: 'sprinter', routeMiles: 10000, routeMinutes: 10080,
      // Sat Jul 4 2026, 01:00 Miami (05:00Z, UTC date 2026-07-04):
      // night + peak + weekend + holiday all fire -> x10,000.
      pickupAtMs: miami('2026-07-04T01:00:00').getTime(),
      passengers: 1, bags: 0, rateCard: abyssCard
    });
    assert.strictEqual(refused.ok, false, 'the overflow combination must be refused, not quoted');
    assert.strictEqual(refused.error.code, 'unrepresentable_fare');
  });

  await check('NEVER THROWS: Symbol/array/null-proto/hostile inputs get structured refusals', async () => {
    const sym = Symbol('tesla');
    const symQ = engineQuote(sym, 10, 20, NEUTRAL.getTime());
    assert.strictEqual(symQ.ok, false);
    assert.strictEqual(symQ.error.code, 'unknown_vehicle');
    assert.ok(!symQ.error.message.includes('Symbol'), 'no coercion of the hostile value into the message');

    const hostileCodes = [
      [Symbol('MIA'), 'MCO'],
      ['MIA', Symbol('MCO')],
      [['MIA'], 'MCO'],
      [Object.create(null), 'MCO'],
      [{ toString() { throw new Error('boom'); } }, 'MCO'],
      ['MIA', undefined],            // one-sided: both or neither
      [undefined, 'MCO'],
      ['', 'MCO'],                   // below the 2-char bound
      ['MIA', 'X'.repeat(13)],       // beyond the 12-char bound
      ['MIA', 'ChIJ0X8Q1234567890abcdefgh'] // place_id-shaped: refused, never silent
    ];
    for (const [o, d] of hostileCodes) {
      const q = engineQuote('tesla', 10, 20, NEUTRAL.getTime(), { originCode: o, destinationCode: d });
      assert.strictEqual(q.ok, false, `codes ${String(typeof o)}/${String(typeof d)} must be refused`);
      assert.strictEqual(q.error.code, 'invalid_route_codes');
    }
    // Valid-but-unmatched codes (the production 'CUSTOM' placeholder
    // shape) still quote via tiered pricing.
    const custom = engineQuote('tesla', 10, 20, NEUTRAL.getTime(),
      { originCode: 'MIA', destinationCode: 'CUSTOM' });
    assert.strictEqual(custom.ok, true);
    assert.strictEqual(custom.quote.popularRoute, null);
    // Inherited-looking keys can never match a route (own-property).
    const proto = engineQuote('tesla', 10, 20, NEUTRAL.getTime(),
      { originCode: 'constructor', destinationCode: 'toString' });
    assert.strictEqual(proto.ok, true);
    assert.strictEqual(proto.quote.popularRoute, null);
  });

  await check('SEMANTIC card validation: impossible dates, incoherent windows, contradictions, serialization failures', async () => {
    const reject = (fn) => {
      const c = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
      fn(c);
      assert.throws(() => validateRateCard(c), /Invalid rate card/);
    };
    reject((c) => { c.holidaysUtc.push('2026-02-30'); });   // shape-valid, calendar-impossible
    reject((c) => { c.holidaysUtc.push('2026-13-01'); });
    reject((c) => { c.surcharges.peak.startHour = 9; c.surcharges.peak.endHour = 7; }); // never fires
    reject((c) => { c.surcharges.peak.startHour = 9; c.surcharges.peak.endHour = 9; });
    reject((c) => { c.surcharges.night.startHour = 6; c.surcharges.night.endHour = 6; }); // covers all hours
    // The subtle one (Codex round 3): night is evaluated as
    // (hour >= start || hour < end), so ANY start < end ALSO covers all
    // 24 hours — 06->22 would surcharge every ride ever. Night must WRAP.
    reject((c) => { c.surcharges.night.startHour = 6; c.surcharges.night.endHour = 22; });
    reject((c) => { c.surcharges.night.startHour = 0; c.surcharges.night.endHour = 23; });
    // The canonical wrapping window stays valid.
    const canonical = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    assert.strictEqual(canonical.surcharges.night.startHour, 22);
    assert.strictEqual(canonical.surcharges.night.endHour, 6);
    assert.ok(validateRateCard(canonical), 'the shipped 22->6 night window must validate');
    reject((c) => { c.psychologicalPricing.enabled = true; c.psychologicalPricing.strategy = 'disabled'; });
    // Serialization failures normalize into the SAME error contract.
    const circular = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    circular.self = circular;
    assert.throws(() => validateRateCard(circular), /Invalid rate card/);
    const bigint = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    bigint.vehicles.tesla.airportFeeCents = 1000n;
    assert.throws(() => validateRateCard(bigint), /Invalid rate card/);
    const primitive = { toJSON: () => 'not-a-card' };
    assert.throws(() => validateRateCard(primitive), /Invalid rate card/);
    // The serialization catch must never read the hostile thrown value:
    // a toJSON that throws an object whose .message getter ITSELF
    // throws still yields the fixed sanitized error.
    const boobyTrapped = {
      toJSON: () => {
        const evil = {};
        Object.defineProperty(evil, 'message', { get() { throw new Error('secondary'); } });
        throw evil;
      }
    };
    assert.throws(() => validateRateCard(boobyTrapped),
      /^Error: Invalid rate card: card is not JSON-serializable$/);
  });

  await check('NEVER THROWS: input properties backed by throwing getters get a structured invalid_input', async () => {
    const hostile = {};
    for (const prop of ['vehicle', 'routeMiles', 'rateCard']) {
      const h = {
        vehicle: 'tesla', routeMiles: 10, routeMinutes: 20,
        pickupAtMs: NEUTRAL.getTime(), passengers: 1, bags: 0, rateCard: CARD
      };
      Object.defineProperty(h, prop, { get() { throw new Error('gotcha'); }, enumerable: true });
      const q = quoteRide(h);
      assert.strictEqual(q.ok, false, `throwing getter on ${prop} must not throw out`);
      assert.strictEqual(q.error.code, 'invalid_input');
    }
    // The guard covers extraction ONLY — a normal input still quotes.
    assert.ok(quoteRide({
      vehicle: 'tesla', routeMiles: 10, routeMinutes: 20,
      pickupAtMs: NEUTRAL.getTime(), passengers: 1, bags: 0, rateCard: CARD
    }).ok);
    void hostile;
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
    // The registry is UNFORGEABLE: stamping the old-style symbol brand
    // onto a rigged card gains nothing, and a prototype child of a
    // validated card is NOT validated (WeakSet membership never walks
    // the prototype chain).
    const forged = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    forged.vehicles.tesla.tiers[0].ratePerMileCents = 1;
    Object.defineProperty(forged, Symbol.for('linkmia.validatedRateCard'), { value: true });
    const fq = quoteRide({
      vehicle: 'tesla', routeMiles: 10, routeMinutes: 20,
      pickupAtMs: NEUTRAL.getTime(), passengers: 1, bags: 0, rateCard: forged
    });
    assert.strictEqual(fq.ok, false);
    assert.strictEqual(fq.error.code, 'rate_card_not_validated');
    assert.ok(!isValidatedRateCard(Object.create(CARD)),
      'a prototype child of a validated card is not itself validated');
  });

  await check('TOCTOU closed: validation certifies the CLONE — toJSON cannot swap values after the checks', async () => {
    const sneaky = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    const rigged = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    rigged.vehicles.tesla.tiers[0].ratePerMileCents = 1;
    Object.defineProperty(sneaky, 'toJSON', { value: () => rigged, enumerable: false });
    // Clone-first: what gets VALIDATED is what toJSON produced — so the
    // rigged card is validated on its own (structurally valid) merits
    // and certified AS the rigged card, never as a lie about `sneaky`.
    const certified = validateRateCard(sneaky);
    assert.strictEqual(certified.vehicles.tesla.tiers[0].ratePerMileCents, 1,
      'the certified object IS the validated object — no divergence window');
    // And a toJSON that produces an INVALID card is simply rejected.
    const invalid = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    const brokenTarget = JSON.parse(JSON.stringify(LINKMIA_RATE_CARD));
    brokenTarget.pricingVersion = '';
    Object.defineProperty(invalid, 'toJSON', { value: () => brokenTarget, enumerable: false });
    assert.throws(() => validateRateCard(invalid), /Invalid rate card/);
  });

  await check('exported constants are frozen: module state cannot drift between validations', async () => {
    const { CANONICAL_VEHICLES } = require(path.join(repoRoot, 'backend/functions/lib/ride-rate-card.js'));
    assert.ok(Object.isFrozen(LINKMIA_RATE_CARD));
    assert.ok(Object.isFrozen(LINKMIA_RATE_CARD.vehicles.tesla.tiers[0]));
    assert.ok(Object.isFrozen(CANONICAL_VEHICLES));
    assert.throws(() => { 'use strict'; CANONICAL_VEHICLES.push('limo'); }, TypeError);
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
