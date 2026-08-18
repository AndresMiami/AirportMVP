// LinkMia ride-quote engine (PR 3C-2A) — the CALCULATION half of the
// server pricing engine. Pure, deterministic, I/O-free: no Supabase,
// no Google/Railway, no environment variables, no browser globals, no
// clock reads (the pickup instant is an INPUT), and no dependence on
// the process timezone — every wall-clock decision names its zone
// explicitly.
//
// STATUS: canonical but DARK. No production path calls this yet;
// pricing.js remains the live browser calculator until 3C-2B/3C-2C.
//
// PARITY CONTRACT: for every valid input, the fare here must equal the
// REACHABLE production output of pricing.js at main 4512a17 for a
// Miami-local (America/New_York) browser — pinned by golden fixtures
// in tests/ride-quote.test.js that run the real pricing.js side by
// side. Deliberately preserved production quirks (recorded, never
// silently "fixed"):
//   * Tier widths are max-min+1 miles, so tier 1 (0-15) spans 16 miles
//     and a 16-mile trip bills entirely at the tier-1 rate.
//   * Hour/weekday surcharges use wall-clock time while the HOLIDAY
//     check uses the UTC calendar date of the pickup instant — the
//     holiday window is shifted 4-5 hours earlier than Miami's day.
//     (In the live browser calculator the wall clock is the
//     PASSENGER'S timezone; this engine pins America/New_York, which
//     is identical for the canonical Miami browser and is the
//     documented product convention.)
//   * Surcharges multiply cumulatively but each recorded surcharge
//     amount is computed on the PRE-surcharge base, so displayed
//     amounts understate the compound delta when surcharges stack.
//   * A popular-route "flat rate" still gains the dynamic airport fee,
//     still competes with hourly protection, and still receives
//     surcharges and psychological rounding on top.
//   * Psychological 'auto' rounding produces INTEGER dollar endings
//     (9/5/45/95 by price band), including discontinuities (e.g. a
//     $23 fare rounds DOWN to $19; $50.00 exactly becomes $45).
//
// MONEY: the rate card supplies integer cents; every money field in a
// quote result is integer cents. Internally the arithmetic mirrors the
// production float pipeline operation-for-operation (cents/100 enters
// the same IEEE doubles the browser uses) — that float path IS the
// parity contract, and results are converted to integer cents at the
// same points production rounds to 2 decimals.

const { isValidatedRateCard } = require('./ride-rate-card');

const ENGINE_VERSION = 'ride-quote-3c2a-1';

// America/New_York wall-clock parts for an instant, independent of the
// process timezone. hourCycle h23 keeps midnight as 0, never 24.
const MIAMI_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  weekday: 'short',
  hour: 'numeric'
});
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function miamiWallClock(instantMs) {
  const parts = MIAMI_PARTS_FMT.formatToParts(new Date(instantMs));
  let hour = null;
  let weekday = null;
  for (const p of parts) {
    if (p.type === 'hour') hour = Number(p.value);
    if (p.type === 'weekday') weekday = WEEKDAY_INDEX[p.value];
  }
  return { hour, weekday };
}

// Production parity: pricing.js rounds money to 2 decimals with
// Math.round(value * 100) / 100. In cents that IS Math.round(value*100).
function toCents(dollarsFloat) {
  return Math.round(dollarsFloat * 100);
}

function err(code, message, details) {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
}

// Structured capacity guidance for a future UI: which vehicles on this
// card COULD take the party. Never creates multiple vehicles.
function compatibleVehicles(card, passengers, bags) {
  const out = [];
  for (const [key, v] of Object.entries(card.vehicles)) {
    if (passengers <= v.capacity.passengers && bags <= v.capacity.bags) {
      out.push({
        vehicle: key,
        name: v.name,
        passengers: v.capacity.passengers,
        bags: v.capacity.bags
      });
    }
  }
  return out;
}

// Exact replica of pricing.js calculateTieredPrice — float pipeline,
// tier widths of max-min+1 miles, rounded to 2 decimals at the end.
function tieredTotalDollars(vehicle, distance) {
  let total = 0;
  let remaining = distance;
  const breakdown = [];
  for (const tier of vehicle.tiers) {
    if (remaining <= 0) break;
    const width = tier.maxMiles - tier.minMiles + 1;
    const milesInTier = Math.min(remaining, width);
    if (milesInTier > 0) {
      const rate = tier.ratePerMileCents / 100;
      const cost = milesInTier * rate;
      total += cost;
      breakdown.push({
        tier: breakdown.length + 1,
        miles: milesInTier,
        ratePerMileCents: tier.ratePerMileCents,
        subtotalCents: toCents(cost)
      });
      remaining -= milesInTier;
    }
  }
  return { totalDollars: Math.round(total * 100) / 100, breakdown };
}

// Exact replica of pricing.js calculateDynamicAirportFee.
function airportFeeDollars(card, vehicle, distance) {
  const base = vehicle.airportFeeCents / 100;
  let factor = card.airportFeeScalingBeyondFactor;
  for (const s of card.airportFeeScaling) {
    if (distance <= s.maxMiles) { factor = s.factor; break; }
  }
  return Math.round(base * factor * 100) / 100;
}

// Exact replica of pricing.js applySurcharges, with the two time
// sources made explicit: hour/weekday from the America/New_York wall
// clock, holiday from the UTC calendar date (the preserved quirk).
function applySurcharges(card, baseDollars, instantMs) {
  const { hour, weekday } = miamiWallClock(instantMs);
  const utcDate = new Date(instantMs).toISOString().slice(0, 10);
  const s = card.surcharges;
  let finalDollars = baseDollars;
  const applied = [];

  const record = (type, cfg) => {
    applied.push({
      type,
      description: cfg.description,
      rate: cfg.rate,
      amountCents: toCents(baseDollars * (cfg.rate - 1))
    });
  };

  if (hour >= s.night.startHour || hour < s.night.endHour) {
    record('night', s.night);
    finalDollars *= s.night.rate;
  }
  if (s.weekend.days.includes(weekday)) {
    record('weekend', s.weekend);
    finalDollars *= s.weekend.rate;
  }
  if (hour >= s.peak.startHour && hour < s.peak.endHour) {
    record('peak', s.peak);
    finalDollars *= s.peak.rate;
  }
  if (card.holidaysUtc.includes(utcDate)) {
    record('holiday', s.holiday);
    finalDollars *= s.holiday.rate;
  }
  return { finalDollars, applied };
}

// Exact replica of pricing.js applyPsychologicalPricing (production
// config: enabled, strategy 'auto', $10 threshold).
function psychologicalDollars(p, price) {
  if (!p.enabled || price < p.thresholdCents / 100) {
    return Math.round(price * 100) / 100;
  }
  const rounded = Math.round(price);
  switch (p.strategy) {
    case 'always9':
      if (rounded % 10 === 0) return rounded - 1;
      if (rounded % 10 <= 4) return Math.floor(rounded / 10) * 10 - 1;
      if (rounded % 10 >= 6) return Math.ceil(rounded / 10) * 10 - 1;
      return rounded;
    case 'always5':
      if (rounded % 10 === 0) return rounded - 5;
      if (rounded % 10 < 5) return Math.floor(rounded / 10) * 10 + 5;
      if (rounded % 10 > 5) return Math.floor(rounded / 10) * 10 + 5;
      return rounded;
    case 'auto':
      if (price < 50) {
        if (rounded % 10 === 0) return rounded - 1;
        if (rounded % 10 <= 5) return Math.floor(rounded / 10) * 10 - 1;
        return Math.ceil(rounded / 10) * 10 - 1;
      } else if (price < 150) {
        if (rounded % 10 < 3) return Math.floor(rounded / 10) * 10 - 5;
        if (rounded % 10 < 8) return Math.floor(rounded / 10) * 10 + 5;
        return Math.ceil(rounded / 10) * 10 + 5;
      } else if (price < 500) {
        if (rounded % 10 === 0) return rounded - 1;
        if (rounded % 10 <= 5) return Math.floor(rounded / 10) * 10 - 1;
        return Math.ceil(rounded / 10) * 10 - 1;
      } else {
        const lastTwo = rounded % 100;
        return lastTwo < 50
          ? Math.floor(rounded / 100) * 100 + 45
          : Math.floor(rounded / 100) * 100 + 95;
      }
    default:
      return Math.round(price * 100) / 100;
  }
}

// quoteRide — calculate and validate a ride quote from explicit inputs
// and a VALIDATED rate card. Returns {ok:true, quote} or {ok:false,
// error:{code, message, details?}}. Never throws for bad ride input;
// never mutates its arguments; same input always yields the same
// output.
function quoteRide(input) {
  if (!input || typeof input !== 'object') {
    return err('invalid_input', 'quoteRide requires an input object');
  }
  const {
    vehicle,
    routeMiles,
    routeMinutes,
    pickupAtMs,
    passengers,
    bags,
    vehiclesRequested = 1,
    bookingMode = 'dropoff',
    originCode = null,
    destinationCode = null,
    rateCard
  } = input;

  if (!isValidatedRateCard(rateCard)) {
    return err('rate_card_not_validated',
      'rateCard must come from validateRateCard() — never an unvalidated object');
  }
  const card = rateCard;

  // Own-property lookup ONLY: a prototype-inherited key ('__proto__',
  // 'constructor', 'toString', …) must be an unknown vehicle, never a
  // truthy accident that throws deeper in the pipeline.
  if (typeof vehicle !== 'string' ||
      !Object.prototype.hasOwnProperty.call(card.vehicles, vehicle)) {
    return err('unknown_vehicle', `Unknown vehicle '${vehicle}'`, {
      knownVehicles: Object.keys(card.vehicles)
    });
  }
  const v = card.vehicles[vehicle];

  if (typeof routeMiles !== 'number' || !Number.isFinite(routeMiles) || routeMiles < 0) {
    return err('invalid_route_facts', 'routeMiles must be a finite nonnegative number');
  }
  if (typeof routeMinutes !== 'number' || !Number.isFinite(routeMinutes) || routeMinutes < 0) {
    return err('invalid_route_facts', 'routeMinutes must be a finite nonnegative number');
  }
  // JS Dates are only valid within ±8.64e15 ms — a finite value beyond
  // that produces an Invalid Date and would THROW in the time-zone
  // formatting, breaking the never-throws contract.
  if (typeof pickupAtMs !== 'number' || !Number.isFinite(pickupAtMs) ||
      Math.abs(pickupAtMs) > 8640000000000000) {
    return err('invalid_pickup_time', 'pickupAtMs must be a finite epoch-milliseconds number within the valid Date range');
  }
  if (bookingMode !== 'pickup' && bookingMode !== 'dropoff') {
    return err('invalid_booking_mode', "bookingMode must be 'pickup' or 'dropoff'");
    // NOTE: production pricing has NO booking-mode differences today —
    // the mode is validated and echoed so a future card CAN differ.
  }
  if (!Number.isInteger(passengers) || passengers < 1) {
    return err('invalid_passengers', 'passengers must be a positive integer');
  }
  if (!Number.isInteger(bags) || bags < 0) {
    return err('invalid_bags', 'bags must be a nonnegative integer');
  }
  if (vehiclesRequested !== 1) {
    return err('multiple_vehicles_unsupported',
      'LinkMia quotes exactly one vehicle per ride (vehicles_needed is always 1)');
  }
  if (passengers > v.capacity.passengers) {
    return err('passenger_capacity_exceeded',
      `${v.name} seats ${v.capacity.passengers}`, {
        kind: 'passengers',
        requested: passengers,
        limit: v.capacity.passengers,
        compatibleVehicles: compatibleVehicles(card, passengers, bags)
      });
  }
  if (bags > v.capacity.bags) {
    return err('bag_capacity_exceeded',
      `${v.name} carries ${v.capacity.bags} bags`, {
        kind: 'bags',
        requested: bags,
        limit: v.capacity.bags,
        compatibleVehicles: compatibleVehicles(card, passengers, bags)
      });
  }
  if (routeMiles > card.maxDistanceMiles) {
    return err('distance_exceeds_service_area',
      `Trip exceeds service area. Maximum distance is ${card.maxDistanceMiles} miles.`, {
        maxDistanceMiles: card.maxDistanceMiles
      });
  }

  // ---- fare (production float pipeline, in exact production order) ----
  let popularRoute = null;
  let tieredDollars = 0;
  let tierBreakdown = null;
  if (originCode && destinationCode) {
    const key = `${String(originCode).toUpperCase()}-${String(destinationCode).toUpperCase()}`;
    const route = card.popularRoutes[key];
    if (route) {
      popularRoute = { key, description: route.description, flatRateCents: route.flatRateCents[vehicle] };
      tieredDollars = route.flatRateCents[vehicle] / 100;
    }
  }
  if (!popularRoute) {
    const tiered = tieredTotalDollars(v, routeMiles);
    tieredDollars = tiered.totalDollars;
    tierBreakdown = tiered.breakdown;
  }

  const feeDollars = airportFeeDollars(card, v, routeMiles);
  const tieredWithFee = tieredDollars + feeDollars;
  const hourlyDollars = (routeMinutes / 60) * (v.hourlyProtectionCentsPerHour / 100);
  const baseDollars = Math.max(tieredWithFee, hourlyDollars);
  const protectionApplied = hourlyDollars > tieredWithFee ? 'hourly' : 'tiered';

  const { finalDollars, applied } = applySurcharges(card, baseDollars, pickupAtMs);
  const psychDollars = psychologicalDollars(card.psychologicalPricing, finalDollars);

  return {
    ok: true,
    quote: {
      pricingVersion: card.pricingVersion,
      engineVersion: ENGINE_VERSION,
      vehicle,
      vehicleName: v.name,
      vehiclesNeeded: 1,
      bookingMode,
      routeMiles,
      routeMinutes,
      pickupAtMs,
      protectionApplied,
      tieredTotalCents: toCents(tieredDollars),
      airportFeeCents: toCents(feeDollars),
      hourlyPriceCents: toCents(hourlyDollars),
      baseCents: toCents(baseDollars),
      appliedSurcharges: applied,
      popularRoute,
      tierBreakdown,
      finalCents: toCents(psychDollars)
    }
  };
}

module.exports = { quoteRide, ENGINE_VERSION };
