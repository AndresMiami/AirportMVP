// Signed quote tokens (PR 3C-2B1) — the tamper-evident seal on a
// server-issued quote. HMAC-SHA256 over a VERSIONED canonical payload;
// verification is stateless (recompute the seal), which also means:
//
//   REPLAY, STATED HONESTLY: within its TTL a token can be presented
//   more than once — stateless verification cannot detect reuse. The
//   blast radius is bounded by what the token binds (same authenticated
//   customer, same exact intent via intentHash, same vehicle, same
//   price), NOT by any duplicate-booking rule: create-booking's
//   one-nonterminal-booking check is a check-then-insert with a known
//   race, and ambassador accounts are exempt from it entirely. That
//   check is therefore NOT a replay defense and must never be cited as
//   one. ATOMIC TOKEN CONSUMPTION (single-use jti, or an equivalent
//   idempotency key written in the same transaction as the booking) is
//   a MANDATORY 2C GATE — 2C is where a database write exists to hang
//   it on, and enforcement must not ship without it.
//
// Payload v1 (purpose 'create' ONLY — 2B1 is honestly create-scoped;
// edit-time quotes arrive as a new version/purpose WITH the features
// that validate booking ownership and details_version):
//   { v:1, kid, purpose:'create', authUserId, customerId, vehicle,
//     pickupAtMs, intentHash, routeQuality,
//     finalCents, pricingVersion, engineVersion, resolvedVersion,
//     iat, exp }
// intentHash binds the token to the EXACT intent (mode, airport,
// CANONICAL place_id, pickup, passengers, and THIS token's vehicle)
// INSTEAD of raw route facts or coordinates.
//
// WHAT THAT DOES AND DOES NOT BUY, PRECISELY: intentHash is a one-way
// COMMITMENT, not confidentiality. It keeps coordinates and street
// text out of the token, but it is an UNKEYED SHA-256 over a small,
// guessable domain, and pickupAtMs and vehicle sit in the payload in
// PLAINTEXT. Anyone holding a token can therefore confirm a SUSPECTED
// place_id in a few dozen hashes (mode x airport x passengers is a
// tiny space). So: no location data is DISCLOSED by a token, but a
// leaked token is an address-CONFIRMATION oracle. Do not restate this
// as "no location data of any kind transits the client". 2C should
// decide deliberately whether to key this digest with the signing
// secret (HMAC) — deferred here only because the verifier must then
// select the key by `kid` BEFORE a caller can compute the expectation,
// which is an API change this correction round should not smuggle in.
//
// Route facts live in the (server-to-caller) response only; if 2C needs
// quoted facts bound for storage, that is a deliberate v2 payload
// decision then. Key rotation is explicit config:
// QUOTE_SIGNING_CURRENT_ID/SECRET sign;
// verification also accepts QUOTE_SIGNING_PREVIOUS_ID/SECRET, selected
// by the token's kid.
//
// TTL is a PRICE-HOLD POLICY, not a technical constant: 15 minutes,
// chosen deliberately (short replay window, fresh facts; 2B2 re-quotes
// silently so the UX cost is nil). Changing it is a product decision.
//
// VERIFICATION FAILS CLOSED. Everything the caller relies on is
// mandatory: a finite clock, the complete set of expectations, the
// EXACT v1 field set (an unsigned extra property is a rejection, not a
// passenger), and a canonical encoding. The verifier returns a frozen
// projection built only from validated fields, so a consumer can never
// read an attribute the signature did not cover.

const crypto = require('crypto');

const TOKEN_VERSION = 1;
const QUOTE_TTL_MS = 15 * 60 * 1000;

// A token minted more than this far in the future is refused rather
// than trusted — signer and verifier run on the same infrastructure, so
// a real skew this large means something is wrong.
const MAX_CLOCK_SKEW_MS = 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Canonical (unpadded) base64url only. Buffer.from(..., 'base64url') is
// LENIENT — it silently ignores characters outside the alphabet — so a
// shape test alone is not enough; every decode is round-trip checked.
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------
// Signing key configuration — ONE canonical resolver, consumed by the
// issuing endpoint today and by 2C's verification tomorrow, so signing
// and verification can never disagree about which keys are acceptable.
// Discipline mirrors lib/notify.js vapidConfigValid(): a present but
// too-weak key is NOT configured. A one-character secret must never be
// able to mint a quote that a write endpoint will later trust.
// ---------------------------------------------------------------

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 512;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validKeyId(id) {
  return typeof id === 'string' && KEY_ID_RE.test(id);
}

// "At least 32 bytes of secret material", measured as the UTF-8 byte
// length of the configured value. Deliberately NOT an entropy estimate
// (unmeasurable) and NOT a decode-then-measure rule (it would reject a
// legitimate 32+ character passphrase). `openssl rand -base64 48` and
// `openssl rand -hex 32` both satisfy it; a truncated or placeholder
// secret does not. Whitespace is refused outright: a secret that was
// copy-pasted with padding is a configuration error, not a key.
function validSecret(secret) {
  if (typeof secret !== 'string' || /\s/.test(secret)) return false;
  const bytes = Buffer.byteLength(secret, 'utf8');
  return bytes >= MIN_SECRET_BYTES && bytes <= MAX_SECRET_BYTES;
}

// env -> { ok:true, current:{id,secret}, keys:[current, previous?] }
//      | { ok:false, reason }
// The PREVIOUS pair is ALL-OR-NOTHING (half a rotation is a
// misconfiguration, never a silent single-key fallback) and its id must
// differ from the current id so kid selection is unambiguous.
function resolveSigningKeys(env) {
  const source = env || {};
  const currentId = source.QUOTE_SIGNING_CURRENT_ID;
  const currentSecret = source.QUOTE_SIGNING_CURRENT_SECRET;
  const previousId = source.QUOTE_SIGNING_PREVIOUS_ID;
  const previousSecret = source.QUOTE_SIGNING_PREVIOUS_SECRET;

  if (!validKeyId(currentId)) return { ok: false, reason: 'current_key_id_invalid' };
  if (!validSecret(currentSecret)) return { ok: false, reason: 'current_secret_weak' };

  const current = { id: currentId, secret: currentSecret };
  const keys = [current];

  const hasPreviousId = previousId !== undefined && previousId !== null && previousId !== '';
  const hasPreviousSecret = previousSecret !== undefined && previousSecret !== null && previousSecret !== '';
  if (hasPreviousId !== hasPreviousSecret) {
    return { ok: false, reason: 'previous_pair_incomplete' };
  }
  if (hasPreviousId) {
    if (!validKeyId(previousId)) return { ok: false, reason: 'previous_key_id_invalid' };
    if (!validSecret(previousSecret)) return { ok: false, reason: 'previous_secret_weak' };
    if (previousId === currentId) return { ok: false, reason: 'previous_key_id_duplicate' };
    // A "rotation" that pastes the SAME secret under a new id rotates
    // nothing — after a suspected leak it would boot cleanly, log a
    // completed rotation, and keep signing with the leaked material.
    if (previousSecret === currentSecret) return { ok: false, reason: 'previous_secret_duplicate' };
    keys.push({ id: previousId, secret: previousSecret });
  }

  return { ok: true, current, keys };
}

// ---------------------------------------------------------------
// Canonical payload
// ---------------------------------------------------------------

// Fixed field order, no whitespace — the exact bytes both signer and
// verifier MAC.
const PAYLOAD_FIELDS = [
  'v', 'kid', 'purpose', 'authUserId', 'customerId', 'vehicle',
  'pickupAtMs', 'intentHash', 'routeQuality',
  'finalCents', 'pricingVersion', 'engineVersion', 'resolvedVersion',
  'iat', 'exp'
];

const ROUTE_QUALITIES = ['traffic_aware', 'fallback'];
const INTENT_HASH_RE = /^[0-9a-f]{64}$/;

function canonicalPayload(payload) {
  const ordered = {};
  for (const f of PAYLOAD_FIELDS) ordered[f] = payload[f];
  return JSON.stringify(ordered);
}

const nonEmptyString = (x) => typeof x === 'string' && x.length > 0;
const safeInt = (x) => typeof x === 'number' && Number.isSafeInteger(x);

// The EXACT v1 schema. Returns a validated projection or null. An extra
// property is a rejection: canonicalPayload only MACs the known fields,
// so anything beyond them is unsigned and must never reach a consumer.
function projectV1Payload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_FIELDS.length) return null;
  for (const k of keys) if (!PAYLOAD_FIELDS.includes(k)) return null;

  if (payload.v !== TOKEN_VERSION) return null;
  if (!validKeyId(payload.kid)) return null;
  if (payload.purpose !== 'create') return null;
  if (!nonEmptyString(payload.authUserId)) return null;
  if (!nonEmptyString(payload.customerId)) return null;
  if (!nonEmptyString(payload.vehicle)) return null;
  if (!safeInt(payload.pickupAtMs)) return null;
  if (typeof payload.intentHash !== 'string' || !INTENT_HASH_RE.test(payload.intentHash)) return null;
  if (!ROUTE_QUALITIES.includes(payload.routeQuality)) return null;
  if (!safeInt(payload.finalCents) || payload.finalCents < 0) return null;
  if (!nonEmptyString(payload.pricingVersion)) return null;
  if (!nonEmptyString(payload.engineVersion)) return null;
  if (!nonEmptyString(payload.resolvedVersion)) return null;
  if (!safeInt(payload.iat) || !safeInt(payload.exp)) return null;
  // Exact TTL: the price hold is policy, and a token claiming a longer
  // hold than the policy grants is a forgery signal, not a long quote.
  if (payload.exp - payload.iat !== QUOTE_TTL_MS) return null;

  const projected = {};
  for (const f of PAYLOAD_FIELDS) projected[f] = payload[f];
  return Object.freeze(projected);
}

// The intent hash: canonical serialization of the FULL intent, INCLUDING
// the vehicle this particular token prices. 2C recomputes it from the
// submitted intent plus the chosen vehicle and compares.
//
// placeId MUST be the CANONICAL id returned by the quote response (the
// id Google resolved), never a client's original autocomplete id —
// otherwise a resolved-id substitution would make an honest booking
// fail verification. See lib/place-identity.js.
function computeIntentHash(intent) {
  const canonical = JSON.stringify({
    mode: intent.mode,
    airportCode: intent.airportCode,
    placeId: intent.placeId,
    pickupAtMs: intent.pickupAtMs,
    passengers: intent.passengers,
    vehicle: intent.vehicle ?? null
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function hmac(canonical, secret) {
  return crypto.createHmac('sha256', secret).update(canonical).digest();
}

// Sign a quote payload. Fields beyond the canonical list are ignored;
// v/kid/iat/exp are stamped here.
function signQuoteToken(fields, { keyId, secret, nowMs }) {
  const payload = {
    ...fields,
    v: TOKEN_VERSION,
    kid: keyId,
    iat: nowMs,
    exp: nowMs + QUOTE_TTL_MS
  };
  const canonical = canonicalPayload(payload);
  const sig = hmac(canonical, secret);
  return `${b64url(canonical)}.${b64url(sig)}`;
}

// Strict canonical base64url decode: shape-checked AND round-tripped,
// so a lenient decode of non-canonical input can never be accepted.
function strictDecode(segment) {
  if (!B64URL_RE.test(segment)) return null;
  let buf;
  try {
    buf = Buffer.from(segment, 'base64url');
  } catch (e) {
    return null;
  }
  if (buf.length === 0 || buf.toString('base64url') !== segment) return null;
  return buf;
}

// Every expectation is MANDATORY — a caller that forgets one must be
// refused, never silently granted an unchecked token.
// Exactly these — no more, no less. Accepting an UNKNOWN expectation
// key would repeat the very bug this verifier was corrected for: a 2C
// author writing expected.finalCents or expected.pickupAtMs would
// believe the price and the instant were pinned while nothing checked
// them. Unknown keys are refused so the mistake surfaces immediately;
// anything else a consumer wants to pin, it compares itself against
// the returned frozen projection.
const REQUIRED_EXPECTATIONS = ['purpose', 'authUserId', 'customerId', 'vehicle', 'intentHash'];

// Verify a token against the configured keys and expectations.
// keys: [{ id, secret }, ...] (current first, previous second) — supply
//       resolveSigningKeys(process.env).keys, never a hand-built list.
// expected: { purpose, authUserId, customerId, vehicle, intentHash } —
//       ALL required, ALL enforced.
// Returns { ok:true, payload } (frozen, validated projection)
//       | { ok:false, reason }.
function verifyQuoteToken(token, { keys, nowMs, expected } = {}) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'invalid_clock' };
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return { ok: false, reason: 'missing_expectations' };
  }
  for (const f of REQUIRED_EXPECTATIONS) {
    if (expected[f] === undefined || expected[f] === null) {
      return { ok: false, reason: 'missing_expectations' };
    }
  }
  for (const f of Object.keys(expected)) {
    if (!REQUIRED_EXPECTATIONS.includes(f)) {
      return { ok: false, reason: 'unknown_expectation' };
    }
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    return { ok: false, reason: 'no_keys' };
  }

  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
    return { ok: false, reason: 'malformed' };
  }
  // EXACTLY two segments: a second dot must not be absorbed into the
  // signature segment.
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  const payloadBuf = strictDecode(parts[0]);
  const givenSig = strictDecode(parts[1]);
  if (!payloadBuf || !givenSig) return { ok: false, reason: 'malformed' };

  let parsed;
  try {
    parsed = JSON.parse(payloadBuf.toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.v !== TOKEN_VERSION) return { ok: false, reason: 'unknown_version' };

  // EXACT schema BEFORE any key work: an unsigned extra property is a
  // rejection, not a passenger.
  const payload = projectV1Payload(parsed);
  if (!payload) return { ok: false, reason: 'schema_invalid' };

  // CANONICAL BYTES: the payload segment must BE the canonical
  // serialization, not merely re-serialize to something that MACs the
  // same. Without this, a token holder can mint unlimited DISTINCT
  // token strings for one quote (reordered keys, added whitespace,
  // 4.5e3 for 4500, a duplicated key) that all verify identically —
  // which would give 2C's mandated single-use/jti gate no stable key
  // to dedupe on. One quote, one token string.
  if (payloadBuf.toString('utf8') !== canonicalPayload(payload)) {
    return { ok: false, reason: 'not_canonical' };
  }

  const key = keys.find((k) => k && k.id === payload.kid && typeof k.secret === 'string' && k.secret);
  if (!key) return { ok: false, reason: 'unknown_key' };

  const expectedSig = hmac(canonicalPayload(payload), key.secret);
  if (givenSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Time: expiry is inclusive (at exp the price hold is over), and a
  // token minted meaningfully in the future is refused.
  if (payload.iat > nowMs + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (nowMs >= payload.exp) {
    return { ok: false, reason: 'expired' };
  }

  if (payload.purpose !== expected.purpose) return { ok: false, reason: 'wrong_purpose' };
  if (payload.authUserId !== expected.authUserId) return { ok: false, reason: 'wrong_identity' };
  if (payload.customerId !== expected.customerId) return { ok: false, reason: 'wrong_identity' };
  if (payload.vehicle !== expected.vehicle) return { ok: false, reason: 'wrong_vehicle' };
  if (payload.intentHash !== expected.intentHash) return { ok: false, reason: 'wrong_intent' };

  return { ok: true, payload };
}

module.exports = {
  TOKEN_VERSION,
  QUOTE_TTL_MS,
  MIN_SECRET_BYTES,
  computeIntentHash,
  signQuoteToken,
  verifyQuoteToken,
  resolveSigningKeys
};
