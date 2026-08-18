// LinkMia rate card (PR 3C-2A) — the DATA half of the server pricing
// engine, deliberately separated from the calculation machinery in
// ride-quote.js so pricing rules are supplied through a validated,
// versioned configuration instead of being buried in formulas.
//
// STATUS: canonical but DARK. Nothing in production calls this yet —
// pricing.js remains the live browser calculator until the coordinated
// 3C-2B/3C-2C enforcement work. The default card below is a faithful
// transcription of the REACHABLE production behavior in pricing.js at
// main 4512a17 (rates, tiers, fees, surcharges, holidays, psychological
// rounding, service limit) with every dollar amount expressed in
// INTEGER CENTS. Do not "improve" values here without a deliberate,
// reviewed fare-change PR.
//
// Future (explicitly supported by this shape, explicitly deferred):
// Supabase-stored pricing profiles, an ambassador pricing dashboard,
// configurable markups, and a time-dominant-with-distance-floor card.
//
// Validation contract: validateRateCard(card) either returns a deeply
// frozen clone REGISTERED in a module-private WeakSet (the only form
// ride-quote.js accepts — membership is unforgeable) or throws with a
// message naming the first violated rule. A card that passed
// validation cannot be mutated afterwards — freezing is part of the
// contract, not a courtesy.

// Module-private registry of validated cards. A WeakSet membership is
// UNFORGEABLE (unlike a global-registry Symbol brand, which any caller
// could stamp) and never walks prototype chains (Object.create of a
// validated card is NOT validated).
const VALIDATED_CARDS = new WeakSet();

// Canonical vehicle keys — the ONLY keys a rate card may price. Alias
// keys (e.g. 'suv') must be resolved by CALLERS before quoting; the
// engine never silently maps one vehicle onto another.
const CANONICAL_VEHICLES = ['tesla', 'escalade', 'sprinter'];

const KNOWN_STRATEGIES = ['tiered-hourly-psych-v1'];
const KNOWN_PSYCH_STRATEGIES = ['auto', 'always9', 'always5', 'disabled'];

// The official LinkMia rate card — production parity with pricing.js.
const LINKMIA_RATE_CARD = {
  pricingVersion: 'linkmia-parity-2026-08',
  strategy: 'tiered-hourly-psych-v1',
  maxDistanceMiles: 280,
  cancellationFeeCents: 1500,
  vehicles: {
    tesla: {
      name: 'Tesla Model Y',
      // Tier boundaries exactly as shipped. NOTE (preserved quirk): the
      // production tier loop bills min(remaining, max-min+1) miles per
      // tier, so tier 1 (0-15) is 16 miles wide — a 16-mile trip bills
      // entirely at the tier-1 rate. Parity over tidiness.
      tiers: [
        { minMiles: 0, maxMiles: 15, ratePerMileCents: 325 },
        { minMiles: 16, maxMiles: 50, ratePerMileCents: 285 },
        { minMiles: 51, maxMiles: 100, ratePerMileCents: 245 },
        { minMiles: 101, maxMiles: 280, ratePerMileCents: 215 }
      ],
      airportFeeCents: 1000,
      hourlyProtectionCentsPerHour: 10000,
      capacity: { passengers: 4, bags: 4 },
      maxDistanceMiles: 280
    },
    escalade: {
      name: 'Cadillac Escalade',
      tiers: [
        { minMiles: 0, maxMiles: 15, ratePerMileCents: 450 },
        { minMiles: 16, maxMiles: 50, ratePerMileCents: 395 },
        { minMiles: 51, maxMiles: 100, ratePerMileCents: 345 },
        { minMiles: 101, maxMiles: 280, ratePerMileCents: 295 }
      ],
      airportFeeCents: 1500,
      hourlyProtectionCentsPerHour: 12500,
      capacity: { passengers: 7, bags: 8 },
      maxDistanceMiles: 280
    },
    sprinter: {
      name: 'Mercedes Sprinter',
      tiers: [
        { minMiles: 0, maxMiles: 15, ratePerMileCents: 625 },
        { minMiles: 16, maxMiles: 50, ratePerMileCents: 550 },
        { minMiles: 51, maxMiles: 100, ratePerMileCents: 485 },
        { minMiles: 101, maxMiles: 280, ratePerMileCents: 425 }
      ],
      airportFeeCents: 2500,
      hourlyProtectionCentsPerHour: 15000,
      capacity: { passengers: 12, bags: 15 },
      maxDistanceMiles: 280
    }
  },
  // Airport fee scales DOWN with distance (production thresholds).
  airportFeeScaling: [
    { maxMiles: 10, factor: 1 },
    { maxMiles: 30, factor: 0.75 },
    { maxMiles: 60, factor: 0.5 }
  ],
  airportFeeScalingBeyondFactor: 0.25,
  // Surcharges stack multiplicatively in this exact order (production).
  surcharges: {
    night: { startHour: 22, endHour: 6, rate: 1.15, description: 'Night service (10pm-6am)' },
    weekend: { days: [0, 6], rate: 1.1, description: 'Weekend service' },
    peak: { startHour: 7, endHour: 9, rate: 1.2, description: 'Peak hours (7am-9am)' },
    holiday: { rate: 1.25, description: 'Holiday service' }
  },
  // PRESERVED QUIRK: production matches holidays against the UTC
  // calendar date of the pickup instant (dateTime.toISOString()), while
  // hour/day surcharges use wall-clock time — so the "holiday" window
  // is shifted 4-5 hours earlier than the Miami holiday. Recorded for
  // review; parity kept.
  holidaysUtc: ['2026-01-01', '2026-07-04', '2026-11-26', '2026-12-25'],
  // PRESERVED QUIRK: popular-route flat rates exist in the live
  // calculator but are UNREACHABLE in production booking (the caller
  // passes a Google place_id as the destination, never an airport
  // code). Carried for code parity; validation requires every route to
  // cover every vehicle (the live code would silently price a missing
  // vehicle as airport-fee-vs-hourly only).
  popularRoutes: {
    'MIA-MCO': { flatRateCents: { tesla: 45000, escalade: 65000, sprinter: 85000 }, description: 'Miami to Orlando' },
    'MCO-MIA': { flatRateCents: { tesla: 45000, escalade: 65000, sprinter: 85000 }, description: 'Orlando to Miami' },
    'MIA-TPA': { flatRateCents: { tesla: 65000, escalade: 95000, sprinter: 140000 }, description: 'Miami to Tampa' },
    'TPA-MIA': { flatRateCents: { tesla: 52000, escalade: 75000, sprinter: 95000 }, description: 'Tampa to Miami' },
    'FLL-PBI': { flatRateCents: { tesla: 12000, escalade: 16500, sprinter: 22000 }, description: 'Fort Lauderdale to West Palm Beach' },
    'PBI-FLL': { flatRateCents: { tesla: 12000, escalade: 16500, sprinter: 22000 }, description: 'West Palm Beach to Fort Lauderdale' }
  },
  psychologicalPricing: { enabled: true, strategy: 'auto', thresholdCents: 1000 }
};

function fail(rule) {
  throw new Error(`Invalid rate card: ${rule}`);
}

// MONEY SAFETY: every cents value must be a SAFE integer (IEEE-exact)
// within a generous but hard bound — $1,000,000 in cents. Bounded card
// values × the bounded service limit and duration keep every
// intermediate product far inside Number.MAX_SAFE_INTEGER, so no valid
// card can ever overflow a quote.
const MAX_CENTS = 100000000;

function isIntCents(v) {
  return Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS;
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isFiniteNonNeg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

// Validate a rate card and return an immutable, registered clone.
// Throws on the FIRST violated rule — a malformed configuration must
// never reach a calculation. The CLONE is taken FIRST and validation
// runs on the clone, so the certified object and the validated object
// are the same object by construction — a caller's toJSON/getters
// cannot swap values between the validation read and the clone
// (verified TOCTOU class from review).
function validateRateCard(rawCard) {
  if (!rawCard || typeof rawCard !== 'object') fail('card must be an object');
  // Cloning/serialization failures (circular references, BigInt, a
  // toJSON that explodes) are CONFIGURATION errors and surface through
  // the same documented contract as every other violation.
  let card;
  try {
    card = JSON.parse(JSON.stringify(rawCard));
  } catch (e) {
    fail(`card is not JSON-serializable (${e.message})`);
  }
  // A toJSON can lawfully replace the object with a primitive — the
  // CLONE is what gets certified, so the clone must be an object too.
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    fail('card must serialize to a plain object');
  }

  if (typeof card.pricingVersion !== 'string' || card.pricingVersion.trim() === '') {
    fail('pricingVersion must be a nonempty string');
  }
  if (!KNOWN_STRATEGIES.includes(card.strategy)) fail(`unknown strategy '${card.strategy}'`);
  if (!isPositiveInt(card.maxDistanceMiles) || card.maxDistanceMiles > 10000) {
    fail('maxDistanceMiles must be a positive integer <= 10000');
  }
  if (!isIntCents(card.cancellationFeeCents)) fail('cancellationFeeCents must be bounded safe-integer cents');

  if (!card.vehicles || typeof card.vehicles !== 'object') fail('vehicles missing');
  const keys = Object.keys(card.vehicles);
  if (keys.length === 0) fail('vehicles must not be empty');
  for (const key of keys) {
    if (!CANONICAL_VEHICLES.includes(key)) {
      fail(`unknown vehicle key '${key}' — aliases are never silently mapped`);
    }
    const v = card.vehicles[key];
    if (!v || typeof v !== 'object') fail(`vehicle ${key} must be an object`);
    if (typeof v.name !== 'string' || v.name.trim() === '') fail(`vehicle ${key} needs a name`);
    if (!isIntCents(v.airportFeeCents)) fail(`vehicle ${key} airportFeeCents must be integer cents`);
    if (!isIntCents(v.hourlyProtectionCentsPerHour) || v.hourlyProtectionCentsPerHour === 0) {
      fail(`vehicle ${key} hourlyProtectionCentsPerHour must be positive integer cents`);
    }
    if (!v.capacity || !isPositiveInt(v.capacity.passengers) || v.capacity.passengers > 1000 ||
        !isPositiveInt(v.capacity.bags) || v.capacity.bags > 1000) {
      fail(`vehicle ${key} capacity must be positive integers <= 1000`);
    }
    if (!isPositiveInt(v.maxDistanceMiles)) fail(`vehicle ${key} maxDistanceMiles must be a positive integer`);
    if (v.maxDistanceMiles !== card.maxDistanceMiles) {
      fail(`vehicle ${key} maxDistanceMiles must equal the card maxDistanceMiles`);
    }

    if (!Array.isArray(v.tiers) || v.tiers.length === 0) fail(`vehicle ${key} needs tiers`);
    let expectedMin = 0;
    for (let i = 0; i < v.tiers.length; i++) {
      const t = v.tiers[i];
      if (!t || !Number.isInteger(t.minMiles) || !Number.isInteger(t.maxMiles)) {
        fail(`vehicle ${key} tier ${i + 1} boundaries must be integers`);
      }
      if (t.minMiles !== expectedMin) {
        fail(`vehicle ${key} tier ${i + 1} must start at ${expectedMin} (strictly ordered, no gaps or duplicates)`);
      }
      if (t.maxMiles < t.minMiles) fail(`vehicle ${key} tier ${i + 1} maxMiles below minMiles`);
      if (!isIntCents(t.ratePerMileCents) || t.ratePerMileCents === 0) {
        fail(`vehicle ${key} tier ${i + 1} ratePerMileCents must be positive integer cents`);
      }
      expectedMin = t.maxMiles + 1;
    }
    if (v.tiers[v.tiers.length - 1].maxMiles !== v.maxDistanceMiles) {
      fail(`vehicle ${key} tiers must cover exactly the ${v.maxDistanceMiles}-mile service limit`);
    }
  }

  if (!Array.isArray(card.airportFeeScaling) || card.airportFeeScaling.length === 0) {
    fail('airportFeeScaling missing');
  }
  let prevMax = 0;
  for (const s of card.airportFeeScaling) {
    if (!s || !Number.isFinite(s.maxMiles) || s.maxMiles <= prevMax || s.maxMiles > 100000) {
      fail('airportFeeScaling thresholds must be strictly increasing and bounded');
    }
    if (!isFiniteNonNeg(s.factor) || s.factor > 100) {
      fail('airportFeeScaling factors must be finite, nonnegative, and bounded');
    }
    prevMax = s.maxMiles;
  }
  if (!isFiniteNonNeg(card.airportFeeScalingBeyondFactor) || card.airportFeeScalingBeyondFactor > 100) {
    fail('airportFeeScalingBeyondFactor must be finite, nonnegative, and bounded');
  }

  if (!card.surcharges || typeof card.surcharges !== 'object') fail('surcharges missing');
  for (const name of ['night', 'weekend', 'peak', 'holiday']) {
    const s = card.surcharges[name];
    if (!s || !Number.isFinite(s.rate) || s.rate < 1 || s.rate > 10) {
      fail(`surcharge ${name} rate must be a finite multiplier between 1 and 10`);
    }
    if (typeof s.description !== 'string' || s.description.trim() === '') {
      fail(`surcharge ${name} needs a description`);
    }
  }
  for (const name of ['night', 'peak']) {
    const s = card.surcharges[name];
    if (!Number.isInteger(s.startHour) || !Number.isInteger(s.endHour) ||
        s.startHour < 0 || s.startHour > 23 || s.endHour < 0 || s.endHour > 23) {
      fail(`surcharge ${name} hours must be integers 0-23`);
    }
  }
  // Window coherence: peak is a non-wrapping window (hour >= start &&
  // hour < end) — start >= end can never fire. Night deliberately WRAPS
  // midnight (hour >= start || hour < end) — but start === end would
  // cover every hour of every day, which is a misconfiguration, not a
  // surcharge.
  if (card.surcharges.peak.startHour >= card.surcharges.peak.endHour) {
    fail('surcharge peak window is incoherent (startHour must be before endHour)');
  }
  if (card.surcharges.night.startHour === card.surcharges.night.endHour) {
    fail('surcharge night window is incoherent (startHour equals endHour covers all hours)');
  }
  if (!Array.isArray(card.surcharges.weekend.days) ||
      card.surcharges.weekend.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    fail('surcharge weekend days must be integers 0-6');
  }

  if (!Array.isArray(card.holidaysUtc)) fail('holidaysUtc missing');
  for (const h of card.holidaysUtc) {
    if (typeof h !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(h)) {
      fail(`holiday '${h}' must be a YYYY-MM-DD date string`);
    }
    // The date must EXIST on the calendar: '2026-02-30' or '2026-13-01'
    // pass the shape test but could never match a real pickup.
    const roundTrip = new Date(h + 'T00:00:00Z');
    if (Number.isNaN(roundTrip.getTime()) || roundTrip.toISOString().slice(0, 10) !== h) {
      fail(`holiday '${h}' is not a real calendar date`);
    }
  }
  if (new Set(card.holidaysUtc).size !== card.holidaysUtc.length) {
    fail('holidaysUtc must not contain duplicates');
  }

  if (!card.popularRoutes || typeof card.popularRoutes !== 'object') fail('popularRoutes missing');
  for (const [route, cfg] of Object.entries(card.popularRoutes)) {
    if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(route)) fail(`popular route key '${route}' malformed`);
    if (!cfg || !cfg.flatRateCents || typeof cfg.flatRateCents !== 'object') {
      fail(`popular route ${route} needs flatRateCents`);
    }
    for (const key of keys) {
      if (!isIntCents(cfg.flatRateCents[key]) || cfg.flatRateCents[key] === 0) {
        fail(`popular route ${route} must cover vehicle ${key} with positive integer cents`);
      }
    }
    for (const k of Object.keys(cfg.flatRateCents)) {
      if (!keys.includes(k)) fail(`popular route ${route} prices unknown vehicle '${k}'`);
    }
    if (typeof cfg.description !== 'string' || cfg.description.trim() === '') {
      fail(`popular route ${route} needs a description`);
    }
  }

  const p = card.psychologicalPricing;
  if (!p || typeof p.enabled !== 'boolean' || !KNOWN_PSYCH_STRATEGIES.includes(p.strategy) ||
      !isIntCents(p.thresholdCents)) {
    fail('psychologicalPricing must have boolean enabled, a known strategy, and bounded safe-integer thresholdCents');
  }
  // Contradiction guard: 'disabled' as an ENABLED strategy is a config
  // that says two opposite things; disable via the flag instead.
  if (p.enabled && p.strategy === 'disabled') {
    fail("psychologicalPricing is contradictory (enabled with strategy 'disabled')");
  }

  // The validated clone is frozen and registered — later mutation of
  // the CALLER's object can never alter what was certified.
  deepFreeze(card);
  VALIDATED_CARDS.add(card);
  return card;
}

function isValidatedRateCard(card) {
  return typeof card === 'object' && card !== null && VALIDATED_CARDS.has(card);
}

// The exported constants are themselves frozen: mutable module state
// (e.g. pushing a key into CANONICAL_VEHICLES, or editing a rate on
// the default card in a warm serverless instance) must never make two
// identical validateRateCard calls behave differently.
deepFreeze(LINKMIA_RATE_CARD);
Object.freeze(CANONICAL_VEHICLES);

module.exports = {
  LINKMIA_RATE_CARD,
  CANONICAL_VEHICLES,
  validateRateCard,
  isValidatedRateCard
};
