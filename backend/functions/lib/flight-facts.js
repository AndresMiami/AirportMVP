// Flight facts — the pure rules shared by the flight sensor endpoints and
// the shared dispatcher (migration 021). No I/O here: everything is a
// plain function so the contract is testable without a database.
//
// THE SEAM (decision D1): an external sensor (Muse today, AeroAPI later)
// reads /api/flight-watchlist and writes /api/flight-facts with a
// revocable token. It never holds a database key, and swapping the
// sensor changes nothing on this side.
//
// The SENSOR decides WHEN to write (only on a material change). THIS
// module decides WHAT band an observation is in, from the sensor's
// times — so a sensor can never label a 20-minute delay "delay_60".
//
// TELL ONLY (decision D3): nothing here, and nothing that calls it,
// ever moves bookings.pickup_datetime.

const crypto = require('crypto');

const MIAMI_TZ = 'America/New_York';

// Every band an observation may carry. Only NOTIFYING_BANDS produce a
// driver event (the outbox trigger in migration 021 holds the same
// list); on_time and landed are recorded so the sensor's accuracy can be
// measured later, and say nothing to anyone.
const BANDS = ['on_time', 'delay_30', 'delay_60', 'delay_120', 'cancelled', 'diverted', 'landed'];
const NOTIFYING_BANDS = ['delay_30', 'delay_60', 'delay_120', 'cancelled', 'diverted'];
const STATUSES = ['active', 'cancelled', 'diverted', 'landed'];

// Ride statuses a flight observation may attach to. Arrived matters most:
// a driver already waiting at the airport is exactly who a delay helps.
const TRACKED_RIDE_STATUSES = ['confirmed', 'on_the_way', 'arrived'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Full timestamp with an explicit zone: a bare "2026-10-06T15:00" would be
// read in the FUNCTION's zone (UTC on Netlify) and silently shift by hours.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/;
// A flight designator after normalization: a 2-character IATA airline
// code (AA, B6, 9K) or a 3-letter ICAO one (AAL), then 1-4 digits, then an
// optional operational suffix letter. "TBD", "AMERICAN100" and invoice
// references fail — they are skipped, never guessed at. Migration 021's
// CHECK holds the SAME pattern, so code and database cannot drift apart.
const FLIGHT_RE = /^([A-Z][A-Z0-9]|[0-9][A-Z]|[A-Z]{3})[0-9]{1,4}[A-Z]?$/;

const FIELDS = ['bookingId', 'flightNumber', 'pickupDate', 'airportCode', 'status',
  'scheduledArrival', 'estimatedArrival', 'actualArrival', 'observedAt', 'source'];

const MAX_FUTURE_SKEW_MS = 5 * 60e3;     // a sensor clock slightly ahead is fine
const MAX_OBSERVATION_AGE_MS = 6 * 3600e3; // older news is not "now lands"
const MAX_EARLY_MS = 12 * 3600e3;        // estimate this far BEFORE schedule is nonsense
const MAX_LATE_MS = 48 * 3600e3;         // and this far after

function isFlightIdent(normalized) {
  return FLIGHT_RE.test(normalized);
}

function normalizeFlightNumber(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';
}

function miamiDay(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: MIAMI_TZ });
}

function bandForEventType(eventType) {
  return String(eventType || '').replace(/^flight_/, '');
}

function eventTypeForBand(band) {
  return NOTIFYING_BANDS.includes(band) ? `flight_${band}` : null;
}

// Whole minutes late (negative = early). Rounded, not floored, so 29:40
// late is 30 — the band a person reading a board would say.
function delayMinutes(scheduledIso, laterIso) {
  return Math.round((Date.parse(laterIso) - Date.parse(scheduledIso)) / 60e3);
}

function bandForDelay(minutes) {
  if (minutes >= 120) return 'delay_120';
  if (minutes >= 60) return 'delay_60';
  if (minutes >= 30) return 'delay_30';
  return 'on_time';
}

function isIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

// Validate one sensor observation BEFORE any database read. Strict: an
// unknown field is a refusal, not ignored (quote-ride's trusted-intent
// discipline) — a sensor that sends something we did not agree on has a
// contract bug we want to hear about. Returns the derived band too.
function validateObservation(body, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const unknown = Object.keys(body).filter((k) => !FIELDS.includes(k));
  if (unknown.length) return { ok: false, error: `unknown field: ${unknown[0]}` };

  const { bookingId, flightNumber, pickupDate, airportCode, status,
    scheduledArrival, estimatedArrival, actualArrival, observedAt, source } = body;

  if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) {
    return { ok: false, error: 'bookingId must be a UUID' };
  }
  const flight = normalizeFlightNumber(flightNumber);
  if (!isFlightIdent(flight)) return { ok: false, error: 'flightNumber is not a flight ident' };
  if (typeof pickupDate !== 'string' || !DAY_RE.test(pickupDate)) {
    return { ok: false, error: 'pickupDate must be YYYY-MM-DD' };
  }
  if (typeof airportCode !== 'string' || !/^[A-Z]{3}$/.test(airportCode)) {
    return { ok: false, error: 'airportCode must be a 3-letter code' };
  }
  if (!STATUSES.includes(status)) {
    return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` };
  }
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
    return { ok: false, error: 'source must be a short lowercase slug' };
  }
  if (!isIso(scheduledArrival)) return { ok: false, error: 'scheduledArrival must be an ISO timestamp with a zone' };
  if (!isIso(observedAt)) return { ok: false, error: 'observedAt must be an ISO timestamp with a zone' };
  for (const [name, value] of [['estimatedArrival', estimatedArrival], ['actualArrival', actualArrival]]) {
    if (value !== undefined && value !== null && !isIso(value)) {
      return { ok: false, error: `${name} must be an ISO timestamp with a zone` };
    }
  }

  const observedMs = Date.parse(observedAt);
  if (observedMs > nowMs + MAX_FUTURE_SKEW_MS) return { ok: false, error: 'observedAt is in the future' };
  if (observedMs < nowMs - MAX_OBSERVATION_AGE_MS) return { ok: false, error: 'observedAt is too old' };

  const schedMs = Date.parse(scheduledArrival);
  const sane = (iso) => {
    const t = Date.parse(iso);
    return t >= schedMs - MAX_EARLY_MS && t <= schedMs + MAX_LATE_MS;
  };

  let band;
  let delay = null;
  if (status === 'active') {
    if (!isIso(estimatedArrival)) return { ok: false, error: 'estimatedArrival is required while active' };
    if (!sane(estimatedArrival)) return { ok: false, error: 'estimatedArrival is implausibly far from schedule' };
    delay = delayMinutes(scheduledArrival, estimatedArrival);
    band = bandForDelay(delay);
  } else if (status === 'landed') {
    if (!isIso(actualArrival)) return { ok: false, error: 'actualArrival is required once landed' };
    if (!sane(actualArrival)) return { ok: false, error: 'actualArrival is implausibly far from schedule' };
    delay = delayMinutes(scheduledArrival, actualArrival);
    band = 'landed';
  } else {
    band = status; // cancelled | diverted
  }

  return {
    ok: true,
    value: {
      bookingId,
      flightNumber: flight,
      pickupDate,
      airportCode,
      status,
      band,
      delayMinutes: delay,
      scheduledArrival: new Date(schedMs).toISOString(),
      estimatedArrival: isIso(estimatedArrival) ? new Date(Date.parse(estimatedArrival)).toISOString() : null,
      actualArrival: isIso(actualArrival) ? new Date(Date.parse(actualArrival)).toISOString() : null,
      observedAt: new Date(observedMs).toISOString(),
      source
    }
  };
}

// Does this observation describe THIS booking's flight, as the booking
// stands right now? Arrivals only (decision D10: booking_mode 'pickup' is
// "pick me up at the airport"). Returns a refusal reason or null.
function mismatchReason(obs, booking) {
  if (booking.booking_mode !== 'pickup') return 'not_an_arrival';
  if (!TRACKED_RIDE_STATUSES.includes(booking.status)) return 'ride_inactive';
  if (!booking.assigned_driver) return 'no_driver';
  if (normalizeFlightNumber(booking.flight_number) !== obs.flightNumber) return 'flight_mismatch';
  if (booking.airport_code !== obs.airportCode) return 'airport_mismatch';
  if (!booking.pickup_datetime || miamiDay(booking.pickup_datetime) !== obs.pickupDate) {
    return 'date_mismatch';
  }
  return null;
}

// FLIGHT_SENSOR_DRIVER_ALLOWLIST: comma-separated driver UUIDs, or "*" for
// every driver. Unset or empty means NOBODY — the trial must be opened on
// purpose, never by forgetting a variable.
function parseDriverAllowlist(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '*') return { all: true, ids: new Set() };
  const ids = new Set(text.split(',').map((s) => s.trim().toLowerCase()).filter((s) => UUID_RE.test(s)));
  return { all: false, ids };
}

function driverAllowed(allowlist, driverId) {
  return Boolean(driverId) && (allowlist.all || allowlist.ids.has(String(driverId).toLowerCase()));
}

// ---- Sensor authentication (both endpoints) ----
// FLIGHT_SENSOR_TOKEN is the ONLY credential the sensor holds. Revoking
// it (change the value or clear it, then redeploy) cuts the sensor off
// completely; nothing else it could use exists. Fail closed in every
// direction: switched off -> 503, not configured or too short -> 503
// (an outage on OUR side, never "your token is wrong"), wrong or
// missing bearer -> 401. Compared as SHA-256 digests with
// timingSafeEqual, so neither the length nor any prefix of the token
// leaks through response timing.
const MIN_TOKEN_LENGTH = 32;

function sensorSwitchedOff(env) {
  return env.FLIGHT_SENSOR_DISABLED === '1' || env.FLIGHT_SENSOR_DISABLED === 'true';
}

function checkSensorAuth(headers, env) {
  if (sensorSwitchedOff(env)) return { status: 503, error: 'Flight sensor is switched off' };
  const expected = typeof env.FLIGHT_SENSOR_TOKEN === 'string' ? env.FLIGHT_SENSOR_TOKEN : '';
  if (expected.length < MIN_TOKEN_LENGTH) return { status: 503, error: 'Flight sensor is not configured' };
  const header = (headers && (headers.authorization || headers.Authorization)) || '';
  const presented = header.replace(/^Bearer\s+/i, '');
  const digest = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
  if (!presented || !crypto.timingSafeEqual(digest(presented), digest(expected))) {
    return { status: 401, error: 'Invalid sensor token' };
  }
  return { ok: true };
}

module.exports = {
  MIN_TOKEN_LENGTH,
  checkSensorAuth,
  MIAMI_TZ,
  BANDS,
  NOTIFYING_BANDS,
  STATUSES,
  TRACKED_RIDE_STATUSES,
  FIELDS,
  normalizeFlightNumber,
  isFlightIdent,
  miamiDay,
  bandForEventType,
  eventTypeForBand,
  delayMinutes,
  bandForDelay,
  validateObservation,
  mismatchReason,
  parseDriverAllowlist,
  driverAllowed
};
