// Signed quote tokens v2 (PR 3C-2C-A) — the tamper-evident seal on a
// server-issued quote. HMAC-SHA256 over a VERSIONED canonical payload.
//
// V2 REPLACES V1 OUTRIGHT. No v1 token has ever existed outside tests:
// the browser flag has been false since 2B2 merged and the issuing
// endpoint is 503 in production, so there is no compatibility window to
// honor and none is provided. The write path (2C-B) accepts v2 only.
// A deliberate reason beyond cleanliness: v1 tokens were DETERMINISTIC
// (one shared iat per response, no nonce), so two same-millisecond
// quotes for identical intent produced byte-identical strings — a
// string- or digest-keyed consumption gate would have collapsed two
// legitimately distinct quotes (an ambassador's two same-intent guest
// rides) into one slot. v2's random jti ends that class.
//
// Payload v2, purpose 'create':
//   { v:2, kid, jti, purpose:'create', authUserId, customerId, vehicle,
//     pickupAtMs, commitment, routeQuality,
//     finalCents, pricingVersion, engineVersion, resolvedVersion,
//     iat, exp }
// Payload v2, purpose 'edit' adds EXACTLY (schema forbids them on
// 'create' — the exact-field-set rule is per purpose):
//   bookingId          — the booking this edit quote may mutate
//   assignmentEpoch    — the driver-assignment era at issue time; the
//                        edit RPC compares it against the row inside
//                        the guarded write, so a token issued before an
//                        Accept/Release transition can never apply
//                        afterwards (migration 017 maintains the epoch
//                        by trigger; release deliberately does NOT bump
//                        details_version, which is why the epoch exists)
//
// ONE JTI PER QUOTE: quote-ride generates a single random jti for the
// whole response and stamps it into every vehicle's token. Consuming
// any vehicle's token consumes the QUOTE — sibling vehicle tokens
// cannot multiply one quote into several bookings. Retries are told
// apart by the SHA-256 digest of the exact token string (canonical
// bytes make one token = one string = one digest): same jti + same
// digest + same authenticated identity is an idempotent retry; same
// jti + different digest is a consumed-quote conflict.
//
// KEYED COMMITMENT replaces v1's unkeyed intentHash. v1's hash was
// SHA-256 over a small guessable domain, which made a leaked token an
// address-CONFIRMATION oracle (a few dozen hashes confirm a suspected
// place_id). v2's commitment is HMAC-SHA256 under a key DERIVED from
// the signing secret selected by the token's kid — nothing about the
// place is confirmable without the secret. Because the key depends on
// the kid, the caller cannot precompute the expected commitment;
// instead the VERIFIER computes it from the caller's submitted intent
// (expected.intent) using the kid-selected key and compares. One key
// authority, rotation included, no second secret to manage.
//
// The commitment binds: mode, airportCode, CANONICAL placeId,
// pickupAtMs, passengers, authoritative route miles in TENTHS,
// authoritative whole route minutes, vehicle, and finalCents.
// DELIBERATELY NOT BOUND: address text. The place IDENTITY is the
// operational route identity (plan v5 C6); display text is a
// passenger-visible label whose retention sits behind the Google
// storage-policy review. Route facts remain outside the token payload
// and its persistent projection; the browser resubmits their canonical
// integer forms so the verifier can recompute this keyed commitment.
//
// TIME, AMENDED DELIBERATELY (recorded in plan v3 and carried since):
// signature, schema, and identity are checked absolutely and in that
// order. Expiry alone may be DEFERRED by the consumption path — the
// exact-digest idempotent-retry lookup must run before the time
// verdict, or a passenger whose booking succeeded would be stranded by
// a late retry of a token that has since expired. Default behavior
// still refuses expired tokens; a caller opts into deferral with
// { deferTime: true } and then MUST require returned canConsume=true
// before any new write (timeStatus remains the diagnostic verdict).
//
// TTL is a PRICE-HOLD POLICY, not a technical constant: 15 minutes.
// Changing it is a product decision.
//
// VERIFICATION FAILS CLOSED. Mandatory clock and expectations, the
// EXACT per-purpose field set (an unsigned extra property is a
// rejection), canonical bytes (one quote = one token string), unknown
// expectation keys refused. The verifier returns a frozen projection
// built only from validated fields.

const crypto = require('crypto');
const { isValidVersionLabel } = require('./version-label');

const TOKEN_VERSION = 2;
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
// issuing endpoint and by 2C's verification alike, so signing and
// verification can never disagree about which keys are acceptable.
// A present but too-weak key is NOT configured.
// ---------------------------------------------------------------

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 512;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validKeyId(id) {
  return typeof id === 'string' && KEY_ID_RE.test(id);
}

// "At least 32 bytes of secret material", measured as the UTF-8 byte
// length of the configured value. Deliberately NOT an entropy estimate
// and NOT a decode-then-measure rule. Whitespace is refused outright: a
// secret copy-pasted with padding is a configuration error, not a key.
function validSecret(secret) {
  if (typeof secret !== 'string' || /\s/.test(secret)) return false;
  const bytes = Buffer.byteLength(secret, 'utf8');
  return bytes >= MIN_SECRET_BYTES && bytes <= MAX_SECRET_BYTES;
}

// env -> { ok:true, current:{id,secret}, keys:[current, previous?] }
//      | { ok:false, reason }
// The PREVIOUS pair is ALL-OR-NOTHING and its id must differ from the
// current id so kid selection is unambiguous.
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
// Keyed intent commitment
// ---------------------------------------------------------------

// Domain-separated derivation: the commitment key is HMAC(secret,
// constant), never the signing secret itself, so commitment material
// and signature material are cryptographically distinct even though
// exactly one configured secret backs both. Rotation rotates both.
const COMMITMENT_DERIVATION_LABEL = 'linkmia-quote-commitment-v2';

function deriveCommitmentKey(secret) {
  return crypto.createHmac('sha256', secret).update(COMMITMENT_DERIVATION_LABEL).digest();
}

// intent: { mode, airportCode, placeId, pickupAtMs, passengers,
//           routeMilesTenths, routeMinutes }
// placeId MUST be the CANONICAL id from the quote response (the id
// Google resolved), never a client's original autocomplete id.
// vehicle and finalCents come from the token being minted/verified, so
// each vehicle's token carries its own commitment.
function computeCommitment(intent, vehicle, finalCents, secret) {
  if (!validCommitmentIntent(intent) || !nonEmptyString(vehicle) ||
      !safeInt(finalCents) || finalCents < 0 || !validSecret(secret)) {
    throw new Error('computeCommitment: invalid input');
  }
  const canonical = JSON.stringify({
    mode: intent.mode,
    airportCode: intent.airportCode,
    placeId: intent.placeId,
    pickupAtMs: intent.pickupAtMs,
    passengers: intent.passengers,
    routeMilesTenths: intent.routeMilesTenths,
    routeMinutes: intent.routeMinutes,
    vehicle,
    finalCents
  });
  return crypto.createHmac('sha256', deriveCommitmentKey(secret)).update(canonical).digest('hex');
}

// ---------------------------------------------------------------
// Canonical payload — per-purpose exact field sets
// ---------------------------------------------------------------

const CREATE_FIELDS = [
  'v', 'kid', 'jti', 'purpose', 'authUserId', 'customerId', 'vehicle',
  'pickupAtMs', 'commitment', 'routeQuality',
  'finalCents', 'pricingVersion', 'engineVersion', 'resolvedVersion',
  'iat', 'exp'
];
// Edit adds bookingId + assignmentEpoch; field ORDER is fixed and
// distinct per purpose — the canonical bytes are the purpose's list.
const EDIT_FIELDS = [
  'v', 'kid', 'jti', 'purpose', 'authUserId', 'customerId',
  'bookingId', 'assignmentEpoch', 'vehicle',
  'pickupAtMs', 'commitment', 'routeQuality',
  'finalCents', 'pricingVersion', 'engineVersion', 'resolvedVersion',
  'iat', 'exp'
];

const PURPOSES = ['create', 'edit'];
const ROUTE_QUALITIES = ['traffic_aware', 'fallback'];
const COMMITMENT_RE = /^[0-9a-f]{64}$/;
const JTI_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const VEHICLE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SQL_INTEGER_MAX = 2147483647;
const MAX_DATE_MS = 8640000000000000;

function fieldsFor(purpose) {
  return purpose === 'edit' ? EDIT_FIELDS : CREATE_FIELDS;
}

function canonicalPayload(payload) {
  const ordered = {};
  for (const f of fieldsFor(payload.purpose)) ordered[f] = payload[f];
  return JSON.stringify(ordered);
}

const nonEmptyString = (x) => typeof x === 'string' && x.length > 0;
const safeInt = (x) => typeof x === 'number' && Number.isSafeInteger(x);
const validUuid = (x) => typeof x === 'string' && UUID_RE.test(x) && x.toLowerCase() !== NIL_UUID;
const validInstant = (x) => safeInt(x) && x >= 0 && x <= MAX_DATE_MS;

function validCommitmentIntent(intent) {
  return !!intent && typeof intent === 'object' && !Array.isArray(intent) &&
    nonEmptyString(intent.mode) &&
    nonEmptyString(intent.airportCode) &&
    nonEmptyString(intent.placeId) &&
    safeInt(intent.pickupAtMs) &&
    safeInt(intent.passengers) && intent.passengers > 0 &&
    safeInt(intent.routeMilesTenths) && intent.routeMilesTenths >= 0 &&
    safeInt(intent.routeMinutes) && intent.routeMinutes >= 0;
}

// The EXACT v2 schema for the payload's declared purpose. Returns a
// validated frozen projection or null. An extra property is a
// rejection: canonicalPayload only MACs the purpose's known fields, so
// anything beyond them is unsigned and must never reach a consumer.
function projectV2Payload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!PURPOSES.includes(payload.purpose)) return null;
  const fields = fieldsFor(payload.purpose);

  const keys = Object.keys(payload);
  if (keys.length !== fields.length) return null;
  for (const k of keys) if (!fields.includes(k)) return null;

  if (payload.v !== TOKEN_VERSION) return null;
  if (!validKeyId(payload.kid)) return null;
  if (typeof payload.jti !== 'string' || !JTI_RE.test(payload.jti)) return null;
  // Both identities are cast to UUID by the atomic SQL writer. Refuse an
  // issuer bug here rather than minting a token that can only fail at booking.
  if (!validUuid(payload.authUserId)) return null;
  if (!validUuid(payload.customerId)) return null;
  if (payload.purpose === 'edit') {
    if (!validUuid(payload.bookingId)) return null;
    if (!safeInt(payload.assignmentEpoch) || payload.assignmentEpoch < 0 ||
        payload.assignmentEpoch > SQL_INTEGER_MAX) return null;
  }
  if (typeof payload.vehicle !== 'string' || !VEHICLE_KEY_RE.test(payload.vehicle)) return null;
  if (!validInstant(payload.pickupAtMs)) return null;
  if (typeof payload.commitment !== 'string' || !COMMITMENT_RE.test(payload.commitment)) return null;
  if (!ROUTE_QUALITIES.includes(payload.routeQuality)) return null;
  if (!safeInt(payload.finalCents) || payload.finalCents < 0 ||
      payload.finalCents > SQL_INTEGER_MAX) return null;
  if (!isValidVersionLabel(payload.pricingVersion)) return null;
  if (!isValidVersionLabel(payload.engineVersion)) return null;
  if (!isValidVersionLabel(payload.resolvedVersion)) return null;
  if (!validInstant(payload.iat) || !validInstant(payload.exp)) return null;
  // Exact TTL: a token claiming a longer hold than the policy grants is
  // a forgery signal, not a long quote.
  if (payload.exp - payload.iat !== QUOTE_TTL_MS) return null;

  const projected = {};
  for (const f of fields) projected[f] = payload[f];
  return Object.freeze(projected);
}

// The SHA-256 digest of the exact token string — the retry identity.
// Canonical bytes guarantee one quote-vehicle = one string = one
// digest, so an acceptance row keyed on this digest distinguishes a
// true retry (same digest) from a sibling vehicle token (same jti,
// different digest). The raw token is NEVER stored — it remains a live
// bearer credential until exp; the digest carries the audit identity
// with zero credential value.
function tokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function hmac(canonical, secret) {
  return crypto.createHmac('sha256', secret).update(canonical).digest();
}

function newJti() {
  return crypto.randomUUID();
}

// Sign a quote payload. `fields` must carry purpose, jti, identity,
// vehicle, pickupAtMs, commitment, routeQuality, money and versions —
// plus bookingId/assignmentEpoch for purpose 'edit'. v/kid/iat/exp are
// stamped here. Fields beyond the purpose's canonical list are rejected
// at issuance because canonical serialization would leave them unsigned.
function signQuoteToken(fields, { keyId, secret, nowMs }) {
  if (!validKeyId(keyId)) throw new Error('signQuoteToken: invalid key id');
  if (!validSecret(secret)) throw new Error('signQuoteToken: invalid signing secret');
  if (!safeInt(nowMs)) throw new Error('signQuoteToken: invalid clock');
  const payload = {
    ...fields,
    v: TOKEN_VERSION,
    kid: keyId,
    iat: nowMs,
    exp: nowMs + QUOTE_TTL_MS
  };
  // Issue-time completeness: JSON.stringify silently DROPS undefined
  // values, so a signer missing a purpose field would mint a token
  // every verifier refuses as schema_invalid — a misleading failure at
  // the worst possible distance from the bug. Fail here instead.
  if (!PURPOSES.includes(payload.purpose)) {
    throw new Error(`signQuoteToken: unknown purpose ${String(payload.purpose)}`);
  }
  for (const f of fieldsFor(payload.purpose)) {
    if (payload[f] === undefined || payload[f] === null) {
      throw new Error(`signQuoteToken: missing field ${f} for purpose ${payload.purpose}`);
    }
  }
  // Completeness alone is not enough: a malformed jti, unsafe money,
  // invalid version, or overflowing expiry would otherwise be
  // signed successfully and fail only when the passenger later books.
  const projected = projectV2Payload(payload);
  if (!projected) throw new Error(`signQuoteToken: invalid ${payload.purpose} payload`);
  const canonical = canonicalPayload(projected);
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
// refused, never silently granted an unchecked token. Exactly these —
// no more, no less; unknown keys are refused so a consumer's mistaken
// extra pin surfaces immediately. `intent` replaces a caller-supplied
// precomputed commitment: the key is selected by the token's kid, which
// the caller cannot know in advance, so the VERIFIER computes the
// expected commitment from the caller's submitted intent and compares.
// Anything else a consumer wants to pin (finalCents, pickupAtMs,
// bookingId, assignmentEpoch), it compares against the returned frozen
// projection — for edit tokens the RPC MUST compare bookingId and
// assignmentEpoch against the booking row inside the guarded write.
const REQUIRED_EXPECTATIONS = ['purpose', 'authUserId', 'customerId', 'vehicle', 'intent'];
const INTENT_FIELDS = [
  'mode', 'airportCode', 'placeId', 'pickupAtMs', 'passengers',
  'routeMilesTenths', 'routeMinutes'
];

// Verify a token against the configured keys and expectations.
// keys: [{ id, secret }, ...] — supply resolveSigningKeys(env).keys,
//       never a hand-built list.
// expected: { purpose, authUserId, customerId, vehicle,
//             intent: { mode, airportCode, placeId, pickupAtMs, passengers,
//                       routeMilesTenths, routeMinutes } }
// options.deferTime: when true, an authentic token past its expiry (or
//       before its validity) is RETURNED with ok:true and a non-'valid'
//       timeStatus instead of being refused — for the consumption path
//       ONLY, which orders the exact-digest idempotent lookup before
//       the time verdict and must require canConsume before a new write.
//       The default
//       refuses, exactly as before.
// Returns { ok:true, payload, timeStatus:'valid'|'expired'|'not_yet_valid',
//           canConsume:boolean }
//       | { ok:false, reason }.
function verifyQuoteToken(token, { keys, nowMs, expected, deferTime = false } = {}) {
  if (!safeInt(nowMs)) {
    return { ok: false, reason: 'invalid_clock' };
  }
  if (typeof deferTime !== 'boolean') {
    return { ok: false, reason: 'invalid_options' };
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
  const intent = expected.intent;
  if (typeof intent !== 'object' || Array.isArray(intent)) {
    return { ok: false, reason: 'missing_expectations' };
  }
  // Unknown intent keys are the SAME mistake as unknown expectation
  // keys (a caller believing something is pinned that is not) and get
  // the same loud reason; missing required fields are the caller
  // forgetting a binding.
  for (const f of Object.keys(intent)) {
    if (!INTENT_FIELDS.includes(f)) {
      return { ok: false, reason: 'unknown_expectation' };
    }
  }
  for (const f of INTENT_FIELDS) {
    if (intent[f] === undefined || intent[f] === null) {
      return { ok: false, reason: 'missing_expectations' };
    }
  }
  if (!validCommitmentIntent(intent)) {
    return { ok: false, reason: 'invalid_expectation' };
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
  const payload = projectV2Payload(parsed);
  if (!payload) return { ok: false, reason: 'schema_invalid' };

  // CANONICAL BYTES: the payload segment must BE the canonical
  // serialization, not merely re-serialize to something that MACs the
  // same. Without this, a token holder could mint unlimited DISTINCT
  // token strings for one quote (reordered keys, whitespace, 4.5e3 for
  // 4500) that all verify identically — which would give the digest-
  // keyed retry identity and the jti consumption gate no stable key.
  // One quote-vehicle, one token string.
  if (payloadBuf.toString('utf8') !== canonicalPayload(payload)) {
    return { ok: false, reason: 'not_canonical' };
  }

  // Callers are expected to pass resolveSigningKeys(env).keys, but keep the
  // verifier total and fail-closed even if a hand-built key array slips
  // through a future integration.
  const key = keys.find((k) => k && k.id === payload.kid && validSecret(k.secret));
  if (!key) return { ok: false, reason: 'unknown_key' };

  const expectedSig = hmac(canonicalPayload(payload), key.secret);
  if (givenSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Identity and intent BEFORE time (the recorded amendment): an
  // authentic token's identity verdict must not depend on the clock.
  if (payload.purpose !== expected.purpose) return { ok: false, reason: 'wrong_purpose' };
  if (payload.authUserId !== expected.authUserId) return { ok: false, reason: 'wrong_identity' };
  if (payload.customerId !== expected.customerId) return { ok: false, reason: 'wrong_identity' };
  if (payload.vehicle !== expected.vehicle) return { ok: false, reason: 'wrong_vehicle' };

  // The verifier computes the expected commitment itself, under the
  // key the token's kid selected — the caller supplies raw intent.
  const expectedCommitment = computeCommitment(
    intent, payload.vehicle, payload.finalCents, key.secret
  );
  const givenCommitment = Buffer.from(payload.commitment, 'hex');
  const wantCommitment = Buffer.from(expectedCommitment, 'hex');
  if (givenCommitment.length !== wantCommitment.length ||
      !crypto.timingSafeEqual(givenCommitment, wantCommitment)) {
    return { ok: false, reason: 'wrong_intent' };
  }

  // Time LAST. Expiry is inclusive (at exp the price hold is over); a
  // token minted meaningfully in the future is refused or flagged.
  let timeStatus = 'valid';
  if (payload.iat > nowMs + MAX_CLOCK_SKEW_MS) timeStatus = 'not_yet_valid';
  else if (nowMs >= payload.exp) timeStatus = 'expired';

  if (timeStatus !== 'valid' && !deferTime) {
    return { ok: false, reason: timeStatus === 'expired' ? 'expired' : 'not_yet_valid' };
  }

  // `ok` means the token is authentic and bound to this caller/intent.
  // A NEW consumption must additionally require canConsume=true. The false
  // value exists only so the atomic acceptance path can look up an already-
  // committed exact-digest retry before reporting expiry honestly.
  return { ok: true, payload, timeStatus, canConsume: timeStatus === 'valid' };
}

module.exports = {
  TOKEN_VERSION,
  QUOTE_TTL_MS,
  MAX_CLOCK_SKEW_MS,
  MIN_SECRET_BYTES,
  computeCommitment,
  tokenDigest,
  newJti,
  signQuoteToken,
  verifyQuoteToken,
  resolveSigningKeys
};
