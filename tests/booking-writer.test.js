// booking-writer lib — three-way token classification, envelope digests,
// keys-unavailable read-only recovery, and the shared outcome registry
// (PR 3C-2C-B PR-1, plan v3.1 §§1,3,5).
//
// Run: node tests/booking-writer.test.js
// Uses REAL v2 tokens minted through quote-token.js so 'verified' and
// 'verify_failed' are exercised against the actual verifier, not a stub.

const path = require('path');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const {
  TOKEN_MAX_BYTES, sha256Hex, isUuid, classifyToken, recoveryLookup,
  sharedOutcomeResponse, unknownOutcomeResponse
} = require(path.join(repoRoot, 'backend/functions/lib/booking-writer.js'));
const {
  computeCommitment, newJti, signQuoteToken
} = require(path.join(repoRoot, 'backend/functions/lib/quote-token.js'));

const SECRET = 'writer-test-secret-0123456789abcdef0123456789abcdef';
const KID = 'wt1';
const ENV_WITH_KEYS = {
  QUOTE_SIGNING_CURRENT_ID: KID,
  QUOTE_SIGNING_CURRENT_SECRET: SECRET
};
const ENV_NO_KEYS = {};

const AUTH = '11111111-2222-4333-8444-555566667777';
const CUST = '99999999-8888-4777-8666-555544443333';
const BOOKING = 'aaaa1111-2222-4333-8444-555566667777';
const OP = '9f8e7d6c-5b4a-4321-8abc-def012345678';

const nowMs = Date.now();
const intent = {
  mode: 'dropoff', airportCode: 'MIA', placeId: 'ChIJwritertest12345678',
  pickupAtMs: nowMs + 3 * 3600e3, passengers: 2,
  routeMilesTenths: 123, routeMinutes: 25
};
function mint({ shift = 0, vehicle = 'tesla', finalCents = 13200 } = {}) {
  const commitment = computeCommitment(intent, vehicle, finalCents, SECRET);
  return signQuoteToken({
    purpose: 'create', jti: newJti(), authUserId: AUTH, customerId: CUST,
    vehicle, pickupAtMs: intent.pickupAtMs, commitment,
    routeQuality: 'traffic_aware', finalCents,
    pricingVersion: 'v1', engineVersion: 'e1', resolvedVersion: 'r1'
  }, { keyId: KID, secret: SECRET, nowMs: nowMs + shift });
}
const expected = {
  purpose: 'create', authUserId: AUTH, customerId: CUST, vehicle: 'tesla', intent
};

// Minimal supabase-like read mock for recoveryLookup.
function mockDb({ receipt = null, acceptance = null, throwOn = null } = {}) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  if (throwOn === table) return { data: null, error: { code: 'XX000' } };
                  if (table === 'operation_receipts') return { data: receipt, error: null };
                  if (table === 'quote_acceptances') return { data: acceptance, error: null };
                  return { data: null, error: null };
                }
              };
            }
          };
        }
      };
    }
  };
}

let passed = 0;
function check(name, f) { f(); passed++; console.log('✓ ' + name); }

(async () => {
  // ---- digests / uuid ----
  check('sha256Hex is deterministic lowercase hex', () => {
    assert.match(sha256Hex('abc'), /^[0-9a-f]{64}$/);
    assert.strictEqual(sha256Hex('abc'), sha256Hex('abc'));
  });
  check('isUuid accepts canonical UUIDs and refuses garbage', () => {
    assert.ok(isUuid(OP));
    assert.ok(!isUuid('not-a-uuid'));
    assert.ok(!isUuid(null));
  });

  // ---- classification: three distinct paths ----
  const good = mint();
  check('authentic fresh token -> verified, timeStatus valid', () => {
    const c = classifyToken(good, { env: ENV_WITH_KEYS, expected, nowMs });
    assert.strictEqual(c.kind, 'verified');
    assert.strictEqual(c.timeStatus, 'valid');
    assert.strictEqual(c.digest, sha256Hex(good));
    assert.strictEqual(c.payload.purpose, 'create');
  });

  check('authentic EXPIRED token stays verified (deferTime, DQ-1) — the RPC decides', () => {
    const stale = mint({ shift: -20 * 60e3 });
    const c = classifyToken(stale, { env: ENV_WITH_KEYS, expected, nowMs });
    assert.strictEqual(c.kind, 'verified');
    assert.strictEqual(c.timeStatus, 'expired');
  });

  check('authentic not-yet-valid token stays verified with timeStatus not_yet_valid', () => {
    const future = mint({ shift: 10 * 60e3 });
    const c = classifyToken(future, { env: ENV_WITH_KEYS, expected, nowMs });
    assert.strictEqual(c.kind, 'verified');
    assert.strictEqual(c.timeStatus, 'not_yet_valid');
  });

  check('tampered token with a WORKING resolver -> verify_failed with digest', () => {
    const tampered = good.slice(0, -4) + 'AAAA';
    const c = classifyToken(tampered, { env: ENV_WITH_KEYS, expected, nowMs });
    assert.strictEqual(c.kind, 'verify_failed');
    assert.strictEqual(c.digest, sha256Hex(tampered));
  });

  check('wrong-identity expectations -> verify_failed (identity is absolute)', () => {
    const c = classifyToken(good, {
      env: ENV_WITH_KEYS,
      expected: { ...expected, customerId: BOOKING },
      nowMs
    });
    assert.strictEqual(c.kind, 'verify_failed');
  });

  check('signing configuration absent -> keys_unavailable with digest, verifier untouched', () => {
    const c = classifyToken(good, { env: ENV_NO_KEYS, expected, nowMs });
    assert.strictEqual(c.kind, 'keys_unavailable');
    assert.strictEqual(c.digest, sha256Hex(good));
  });

  check('malformed signing configuration (short secret) -> keys_unavailable, never verify_failed', () => {
    const c = classifyToken(good, {
      env: { QUOTE_SIGNING_CURRENT_ID: 'x', QUOTE_SIGNING_CURRENT_SECRET: 'short' },
      expected, nowMs
    });
    assert.strictEqual(c.kind, 'keys_unavailable');
  });

  check('oversize token refused BEFORE hashing', () => {
    const c = classifyToken('x'.repeat(TOKEN_MAX_BYTES + 1), { env: ENV_WITH_KEYS, expected, nowMs });
    assert.strictEqual(c.kind, 'oversize');
    assert.ok(!('digest' in c));
  });

  // ---- keys-unavailable read-only recovery ----
  const digest = sha256Hex('raw-body-bytes');
  const tdigest = sha256Hex(good);
  const receipt = {
    operation_request_id: OP, kind: 'create', auth_user_id: AUTH,
    customer_id: CUST, request_digest: digest, booking_id: BOOKING
  };

  {
    const hit = await recoveryLookup(mockDb({ receipt }), {
      operationId: OP, requestDigest: digest,
      authUserId: AUTH, customerId: CUST, kind: 'create'
    });
    check('receipt recovery returns the stored booking', () =>
      assert.strictEqual(hit.bookingId, BOOKING));
  }
  {
    const miss = await recoveryLookup(mockDb({ receipt: { ...receipt, request_digest: sha256Hex('other') } }), {
      operationId: OP, requestDigest: digest,
      authUserId: AUTH, customerId: CUST, kind: 'create'
    });
    check('different bytes under the same operation id -> no recovery', () =>
      assert.strictEqual(miss, null));
  }
  {
    const miss = await recoveryLookup(mockDb({ receipt: { ...receipt, customer_id: BOOKING } }), {
      operationId: OP, requestDigest: digest,
      authUserId: AUTH, customerId: CUST, kind: 'create'
    });
    check('identity mismatch -> no recovery, no disclosure', () =>
      assert.strictEqual(miss, null));
  }
  {
    const miss = await recoveryLookup(mockDb({ receipt: { ...receipt, kind: 'edit_quoted' } }), {
      operationId: OP, requestDigest: digest,
      authUserId: AUTH, customerId: CUST, kind: 'create'
    });
    check('kind mismatch -> no recovery', () => assert.strictEqual(miss, null));
  }
  {
    const hit = await recoveryLookup(mockDb({ receipt: { ...receipt, kind: 'edit_quoted' } }), {
      operationId: OP, requestDigest: digest,
      authUserId: AUTH, customerId: CUST, kind: 'edit', bookingId: BOOKING
    });
    check("caller kind 'edit' matches the RPC's receipt kind 'edit_quoted' (017 vocabulary)", () =>
      assert.strictEqual(hit.bookingId, BOOKING));
  }
  {
    const miss = await recoveryLookup(mockDb({ receipt: { ...receipt, kind: 'edit' } }), {
      operationId: OP, requestDigest: digest,
      authUserId: AUTH, customerId: CUST, kind: 'edit', bookingId: BOOKING
    });
    check("a literal 'edit' receipt kind never matches (only 017's vocabulary counts)", () =>
      assert.strictEqual(miss, null));
  }
  {
    const hit = await recoveryLookup(mockDb({
      acceptance: { token_digest: tdigest, purpose: 'create', auth_user_id: AUTH, customer_id: CUST, booking_id: BOOKING }
    }), {
      tokenDigest: tdigest, authUserId: AUTH, customerId: CUST, kind: 'create'
    });
    check('token-only acceptance recovery works (legacy retry without an operation id)', () =>
      assert.strictEqual(hit.bookingId, BOOKING));
  }
  {
    const hit = await recoveryLookup(mockDb({
      acceptance: { token_digest: tdigest, purpose: 'edit', auth_user_id: AUTH, customer_id: CUST, booking_id: BOOKING }
    }), {
      tokenDigest: tdigest, authUserId: AUTH, customerId: CUST, kind: 'edit', bookingId: BOOKING
    });
    check('edit acceptance recovery requires the SAME booking id', () =>
      assert.strictEqual(hit.bookingId, BOOKING));
  }
  {
    const miss = await recoveryLookup(mockDb({
      acceptance: { token_digest: tdigest, purpose: 'edit', auth_user_id: AUTH, customer_id: CUST, booking_id: BOOKING }
    }), {
      tokenDigest: tdigest, authUserId: AUTH, customerId: CUST, kind: 'edit', bookingId: OP
    });
    check('edit acceptance for a DIFFERENT booking -> no recovery', () =>
      assert.strictEqual(miss, null));
  }
  {
    const miss = await recoveryLookup(mockDb({ throwOn: 'operation_receipts' }), {
      operationId: OP, requestDigest: digest,
      authUserId: AUTH, customerId: CUST, kind: 'create'
    });
    check('recovery read failure -> null (caller answers sanitized 500)', () =>
      assert.strictEqual(miss, null));
  }

  // ---- shared outcome registry ----
  const rows = [
    ['outdated_client', 428, 'outdated_client', { reload: true }],
    ['quote_required', 428, 'quote_required', { reload: true }],
    ['quote_invalid', 409, 'quote_invalid', { requote: true }],
    ['quote_mismatch', 409, 'quote_invalid', { requote: true }],
    ['quote_expired', 409, 'quote_expired', { requote: true }],
    ['quote_not_yet_valid', 409, 'quote_expired', { requote: true }],
    ['epoch_conflict', 409, 'quote_stale', { requote: true }],
    ['conflict', 409, 'Could not process this request', {}],
    ['refused', 409, 'Could not process this request', {}]
  ];
  for (const [outcome, status, error, extra] of rows) {
    check(`registry: ${outcome} -> ${status}`, () => {
      const m = sharedOutcomeResponse(outcome);
      assert.strictEqual(m.statusCode, status);
      assert.strictEqual(m.body.error, error);
      for (const [k, v] of Object.entries(extra)) assert.strictEqual(m.body[k], v);
    });
  }
  check('registry: blocked -> 503 honest copy', () => {
    const m = sharedOutcomeResponse('blocked');
    assert.strictEqual(m.statusCode, 503);
    assert.match(m.body.error, /WhatsApp/);
  });
  check('registry: endpoint-owned outcomes return null (handled with re-reads)', () => {
    for (const o of ['created', 'updated', 'idempotent', 'active_exists', 'quote_consumed',
      'version_conflict', 'not_editable', 'not_found']) {
      assert.strictEqual(sharedOutcomeResponse(o), null, o);
    }
  });
  check('registry: unknown outcome fails closed as sanitized 500', () => {
    const m = unknownOutcomeResponse('surprise');
    assert.strictEqual(m.statusCode, 500);
    assert.strictEqual(m.body.error, 'Could not process this request');
  });

  console.log(`\nALL ${passed} CHECKS PASS`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
