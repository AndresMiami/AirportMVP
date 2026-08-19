// Signed quote tokens (PR 3C-2B1) — the tamper-evident seal on a
// server-issued quote. HMAC-SHA256 over a VERSIONED canonical payload;
// verification is stateless (recompute the seal), which also means:
//
//   REPLAY, STATED HONESTLY: within its TTL a token can be presented
//   more than once — stateless verification cannot detect reuse. The
//   blast radius is inherently small (same authenticated customer,
//   same exact intent via intentHash, same price; the one-nonterminal-
//   booking rule already blocks duplicate live bookings). Single-use
//   jti tracking is a DELIBERATE deferral to 2C, where a database
//   write exists to hang it on, added only if the threat model
//   justifies it then.
//
// Payload v1 (purpose 'create' ONLY — 2B1 is honestly create-scoped;
// edit-time quotes arrive as a new version/purpose WITH the features
// that validate booking ownership and details_version):
//   { v:1, kid, purpose:'create', authUserId, customerId, vehicle,
//     pickupAtMs, intentHash, routeQuality,
//     finalCents, pricingVersion, engineVersion, resolvedVersion,
//     iat, exp }
// intentHash binds the token to the EXACT intent (mode, airport,
// place_id, pickup, passengers) INSTEAD of raw route facts or
// coordinates — no location data of any kind transits the client
// inside a token. Route facts live in the (server-to-caller) response
// only; if 2C needs quoted facts bound for storage, that is a
// deliberate v2 payload decision then. Key rotation is explicit config: QUOTE_SIGNING_CURRENT_ID/
// SECRET sign; verification also accepts QUOTE_SIGNING_PREVIOUS_ID/
// SECRET, selected by the token's kid.
//
// TTL is a PRICE-HOLD POLICY, not a technical constant: 15 minutes,
// chosen deliberately (short replay window, fresh facts; 2B2 re-quotes
// silently so the UX cost is nil). Changing it is a product decision.

const crypto = require('crypto');

const TOKEN_VERSION = 1;
const QUOTE_TTL_MS = 15 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url').toString('utf8');

// Canonical serialization: fixed field order, no whitespace — the
// exact bytes both signer and verifier MAC.
const PAYLOAD_FIELDS = [
  'v', 'kid', 'purpose', 'authUserId', 'customerId', 'vehicle',
  'pickupAtMs', 'intentHash', 'routeQuality',
  'finalCents', 'pricingVersion', 'engineVersion', 'resolvedVersion',
  'iat', 'exp'
];

function canonicalPayload(payload) {
  const ordered = {};
  for (const f of PAYLOAD_FIELDS) ordered[f] = payload[f];
  return JSON.stringify(ordered);
}

// The intent hash: canonical serialization of the FULL intent. The
// token carries this digest instead of raw route identity — 2C
// verification recomputes it from the submitted intent and compares.
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

// Verify a token against the configured keys and expectations.
// keys: [{ id, secret }, ...] (current first, previous second).
// expected: { purpose, authUserId, customerId } — all enforced.
// Returns { ok:true, payload } | { ok:false, reason }.
function verifyQuoteToken(token, { keys, nowMs, expected }) {
  if (typeof token !== 'string' || token.length > 8192) {
    return { ok: false, reason: 'malformed' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  let payload;
  try {
    payload = JSON.parse(fromB64url(token.slice(0, dot)));
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || payload.v !== TOKEN_VERSION) return { ok: false, reason: 'unknown_version' };

  const key = (keys || []).find((k) => k && k.id === payload.kid && k.secret);
  if (!key) return { ok: false, reason: 'unknown_key' };

  const expectedSig = hmac(canonicalPayload(payload), key.secret);
  let givenSig;
  try {
    givenSig = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch (e) {
    return { ok: false, reason: 'malformed' };
  }
  if (givenSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (typeof payload.exp !== 'number' || nowMs > payload.exp) {
    return { ok: false, reason: 'expired' };
  }
  if (expected) {
    if (expected.purpose !== undefined && payload.purpose !== expected.purpose) {
      return { ok: false, reason: 'wrong_purpose' };
    }
    if (expected.authUserId !== undefined && payload.authUserId !== expected.authUserId) {
      return { ok: false, reason: 'wrong_identity' };
    }
    if (expected.customerId !== undefined && payload.customerId !== expected.customerId) {
      return { ok: false, reason: 'wrong_identity' };
    }
  }
  return { ok: true, payload };
}

module.exports = {
  TOKEN_VERSION,
  QUOTE_TTL_MS,
  computeIntentHash,
  signQuoteToken,
  verifyQuoteToken
};
