// PR 3C-2C-B PR-1 — shared helpers for the writer swap (plan v3.1).
//
// The booking endpoints stopped writing bookings directly: every create and
// every full-form edit flows through migration 017's SECURITY DEFINER RPCs
// (accept_quote_create / accept_quote_edit), which verify, consume, and
// store what ride-quote.js calculated — the RPCs are not a second
// calculator. This module holds the pieces both endpoints share so their
// behavior can never diverge:
//
//   * the immutable-envelope digest (sha256 of the raw request body — a
//     true retry resends the exact bytes, so the digest matches by
//     construction);
//   * three-way token classification with LAZY signing-key resolution —
//     the no-token path must work with every quote secret absent from the
//     environment (PR-1 ships while production has none);
//   * the keys-unavailable READ-ONLY recovery lookup: an exact completed
//     operation or acceptance can be returned idempotently during a
//     signing-configuration outage, but an unmatched request is a
//     sanitized 500 with NO RPC call and NO write in every mode — a key
//     outage can recover finished work, never authorize new money;
//   * the shared outcome→HTTP registry rows. Unknown outcomes fail closed.
//
// SECURITY: never log or echo the raw token or the raw request body — the
// body carries passenger identity and (when quote-backed) a bearer token.

const crypto = require('crypto');
const { verifyQuoteToken, resolveSigningKeys } = require('./quote-token');

// Raw-token ceiling BEFORE any hashing (plan v3.1 §3.2). A real v2 token is
// well under 2 KB; anything larger is garbage and is refused without ever
// reaching a digest or the database.
const TOKEN_MAX_BYTES = 8192;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Preserve the distinction between an old client that omitted quoteToken
// entirely and a modern request that presented a malformed value. Never
// coerce or trim a token: its exact bytes are the signed/digested identity.
function readPresentedToken(body) {
  const present = !!body && typeof body === 'object' &&
    Object.prototype.hasOwnProperty.call(body, 'quoteToken');
  if (!present) return { present: false, invalid: false, token: null };
  const token = body.quoteToken;
  if (typeof token !== 'string' || token.length === 0 ||
      Buffer.byteLength(token, 'utf8') > TOKEN_MAX_BYTES) {
    return { present: true, invalid: true, token: null };
  }
  return { present: true, invalid: false, token };
}

// A cheap, side-effect-free preflight for the one path that could otherwise
// create an ambassador customer row before token classification. Keep this
// lazy: legacy/no-token requests must not depend on quote signing config.
function signingKeysAvailable(env) {
  try {
    const signing = resolveSigningKeys(env);
    return !!signing?.ok && Array.isArray(signing.keys) && signing.keys.length > 0;
  } catch (_) {
    return false;
  }
}

// Classify a PRESENTED token (callers must not invoke this on the no-token
// path — signing configuration stays untouched there). Returns exactly one of:
//   { kind: 'oversize' }                                — refuse pre-digest
//   { kind: 'keys_unavailable', digest }                — resolver failed
//   { kind: 'verified', digest, payload, timeStatus }   — authentic (time
//         deferred: expired/not-yet-valid stay 'verified' per DQ-1 and the
//         RPC decides freshness in every mode)
//   { kind: 'verify_failed', digest }                   — bad signature /
//         schema / identity / commitment with a WORKING resolver
function classifyToken(token, { env, expected, nowMs }) {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > TOKEN_MAX_BYTES) {
    return { kind: 'oversize' };
  }
  const digest = sha256Hex(token);

  let signing;
  try {
    signing = resolveSigningKeys(env);
  } catch (_) {
    signing = null;
  }
  if (!signing || !Array.isArray(signing.keys) || signing.keys.length === 0) {
    return { kind: 'keys_unavailable', digest };
  }

  const verdict = verifyQuoteToken(token, {
    keys: signing.keys,
    nowMs,
    expected,
    deferTime: true
  });
  if (verdict.ok) {
    return { kind: 'verified', digest, payload: verdict.payload, timeStatus: verdict.timeStatus };
  }
  return { kind: 'verify_failed', digest };
}

// READ-ONLY recovery during a signing-configuration outage (plan v3.1
// §3.2(c)). Consults ONLY tables service_role can already SELECT; never
// calls an RPC, never writes. Match rules are exact and identity-gated:
//   * operation receipt: operationId + request digest + auth user +
//     customer + kind (+ bookingId for an edit);
//   * else acceptance: token digest + auth user + customer + purpose
//     (+ bookingId for an edit).
// Returns { bookingId } on a complete exact match, null otherwise. A miss
// or ANY mismatch discloses nothing — the caller answers a sanitized 500.
async function recoveryLookup(db, {
  operationId, requestDigest, tokenDigest,
  authUserId, customerId, kind, bookingId
}) {
  // Receipt kinds use migration 017's vocabulary: a full-form quoted edit
  // is stored as 'edit_quoted' (the RPC's literal), never 'edit'.
  const receiptKind = kind === 'edit' ? 'edit_quoted' : 'create';
  if (operationId && requestDigest) {
    const { data: receipt, error } = await db
      .from('operation_receipts')
      .select('operation_request_id, kind, auth_user_id, customer_id, request_digest, booking_id')
      .eq('operation_request_id', operationId)
      .maybeSingle();
    if (error) return null;
    if (receipt &&
        receipt.auth_user_id === authUserId &&
        receipt.customer_id === customerId &&
        receipt.kind === receiptKind &&
        receipt.request_digest === requestDigest &&
        (kind !== 'edit' || receipt.booking_id === bookingId)) {
      return { bookingId: receipt.booking_id };
    }
    return null;
  }
  if (tokenDigest) {
    const { data: accept, error } = await db
      .from('quote_acceptances')
      .select('token_digest, purpose, auth_user_id, customer_id, booking_id')
      .eq('token_digest', tokenDigest)
      .maybeSingle();
    if (error) return null;
    if (accept &&
        accept.auth_user_id === authUserId &&
        accept.customer_id === customerId &&
        accept.purpose === (kind === 'edit' ? 'edit' : 'create') &&
        (kind !== 'edit' || accept.booking_id === bookingId)) {
      return { bookingId: accept.booking_id };
    }
    return null;
  }
  return null;
}

// Shared registry rows (plan v3.1 §5). Endpoint-specific outcomes
// (created/updated/idempotent/active_exists/quote_consumed/version_conflict/
// not_editable/not_found) need re-reads or endpoint context and stay in the
// handlers; everything here is context-free. Returns null when the outcome
// is not a shared row.
function sharedOutcomeResponse(outcome) {
  switch (outcome) {
    case 'outdated_client':
      return { statusCode: 428, body: { error: 'outdated_client', reload: true } };
    case 'quote_required':
      return { statusCode: 428, body: { error: 'quote_required', reload: true } };
    case 'quote_invalid':
    case 'quote_mismatch':
      return { statusCode: 409, body: { error: 'quote_invalid', requote: true } };
    case 'quote_expired':
    case 'quote_not_yet_valid':
      return { statusCode: 409, body: { error: 'quote_expired', requote: true } };
    case 'epoch_conflict':
      return { statusCode: 409, body: { error: 'quote_stale', requote: true } };
    case 'conflict':
    case 'refused':
      return { statusCode: 409, body: { error: 'Could not process this request' } };
    case 'blocked':
      return {
        statusCode: 503,
        body: {
          error: 'Bookings are temporarily unavailable. Message us on WhatsApp and a human will arrange your ride.'
        }
      };
    default:
      return null;
  }
}

// Fail-closed default for any outcome no registry row recognizes.
function unknownOutcomeResponse(outcome) {
  console.error('booking-writer: unmapped RPC outcome', typeof outcome === 'string' ? outcome : 'non_string');
  return { statusCode: 500, body: { error: 'Could not process this request' } };
}

module.exports = {
  TOKEN_MAX_BYTES,
  sha256Hex,
  isUuid,
  readPresentedToken,
  signingKeysAvailable,
  classifyToken,
  recoveryLookup,
  sharedOutcomeResponse,
  unknownOutcomeResponse
};
