-- ============================================================
-- Migration 018 — R1: new-write route-content non-retention
-- (address plan v3, "Ordered prerequisite R1"; Google case 74801827:
--  distance and duration receive no retention exception)
--
-- WHAT THIS DOES
--   * accept_quote_create: a verified consumption no longer REQUIRES
--     duration_minutes, and duration is never persisted (NULL) in ANY mode.
--   * accept_quote_edit: same, and an edit actively clears any legacy stored
--     duration on the row it touches.
--   * both: quote_acceptances.payload_projection becomes a fail-closed
--     ALLOWLIST of the token's non-provider fields — routeQuality is
--     excluded, and future token fields stay out until named.
--
-- WHAT THIS DOES NOT DO
--   * no table, column, index, constraint, trigger, grant or RLS change;
--   * signatures are IDENTICAL, so CREATE OR REPLACE is a true in-place
--     replacement (no PostgreSQL overload is created) and existing ACLs,
--     ownership, SECURITY DEFINER and search_path are preserved;
--   * accept_optional_edit is deliberately untouched: its p_patch allowlist
--     carries no duration or route field (017:1966-1975);
--   * historical rows are untouched (that is R2, separately authorized);
--   * the 1..1440 band check on a SUBMITTED duration is retained for input
--     strictness — the value is validated, then discarded.
--
-- RUN VIA docs/R1-MIGRATION-RUNBOOK.md ONLY. Emergency rollback:
-- database/migrations/018_r1_rollback.sql (byte-exact 017 bodies).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- PRE-CAPTURE (round-2 hardening): the exact namespace-qualified identities,
-- owners and ACLs of both writers BEFORE replacement. regprocedure resolution
-- is itself fail-closed — a missing or re-signatured function aborts here.
-- ------------------------------------------------------------
CREATE TEMP TABLE r1_pre_state ON COMMIT DROP AS
SELECT p.oid, p.proname, p.proowner, p.proacl, p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.oid IN ('public.accept_quote_create(uuid,uuid,uuid,text,text,uuid,text,jsonb,numeric,text,text,text,jsonb)'::regprocedure,
                'public.accept_quote_edit(uuid,uuid,uuid,text,uuid,integer,text,uuid,text,jsonb,numeric,text,text,text,jsonb)'::regprocedure);

DO $r1_precheck$
BEGIN
  IF (SELECT count(*) FROM r1_pre_state) <> 2 THEN
    RAISE EXCEPTION 'R1: expected exactly the two public writers before replacement';
  END IF;
END;
$r1_precheck$;

CREATE OR REPLACE FUNCTION accept_quote_create(
  p_auth_user_id UUID,
  p_customer_id UUID,
  p_operation_request_id UUID,
  p_request_digest TEXT,
  p_verdict TEXT,               -- 'verified' | 'no_token' | 'verify_failed';
                                -- authentic stale/future tokens stay verified
  p_jti UUID,                   -- NULL unless verified (an UNVERIFIED jti
                                --   must never reach a keyed lookup)
  p_token_digest TEXT,          -- SHA-256 of the RAW PRESENTED token,
                                --   computed WITHOUT verification; NULL
                                --   only when no token was presented.
                                --   This is what makes Path A work after
                                --   expiry or key retirement.
  p_payload JSONB,              -- verified projection, NULL unless verified
  p_client_price NUMERIC,       -- the client-submitted price (off/observe)
  p_canonical_place_id TEXT,    -- the commitment-verified canonical id (NULL unless verified)
  p_airport_code TEXT,          -- trusted endpoint output after commitment verification
  p_vehicle_key TEXT,           -- canonical key; must equal payload.vehicle
  p_booking JSONB               -- booking column values from the endpoint
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_mode TEXT;
  v_high_water TIMESTAMPTZ;
  v_receipt operation_receipts%ROWTYPE;
  v_accept quote_acceptances%ROWTYPE;
  v_booking_id UUID;
  v_price NUMERIC;
  v_cents INTEGER;
  v_authority TEXT;
  v_idhash TEXT := encode(extensions.digest(p_auth_user_id::text, 'sha256'), 'hex');
  v_constraint TEXT;
  v_effective_verdict TEXT := p_verdict;
  v_has_request_id BOOLEAN;
  v_now_ms BIGINT;
  v_pickup_at TIMESTAMPTZ;
  v_passengers INTEGER;
  v_bags INTEGER;
  v_booking_mode TEXT;
  v_duration_minutes INTEGER;
  v_referred_by_host UUID;
  v_commission_rate NUMERIC := 0;
  v_host_commission NUMERIC := 0;
BEGIN
  IF p_auth_user_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'authenticated identities are required';
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('verified','no_token','verify_failed') THEN
    RAISE EXCEPTION 'unknown verdict %', COALESCE(p_verdict, 'NULL');
  END IF;
  IF (p_operation_request_id IS NULL) <> (p_request_digest IS NULL) THEN
    RAISE EXCEPTION 'operation_request_id and request_digest must be supplied together';
  END IF;
  v_has_request_id := p_operation_request_id IS NOT NULL;
  IF p_request_digest IS NOT NULL AND p_request_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'request_digest must be lowercase SHA-256 hex';
  END IF;
  IF p_token_digest IS NOT NULL AND p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'token_digest must be lowercase SHA-256 hex';
  END IF;
  -- Validate once in every mode. Enforce does not use the browser price for
  -- money, but telemetry must never be able to turn NaN/Infinity/overflow
  -- into an unhandled INTEGER cast.
  IF p_client_price IS NOT NULL AND (
       p_client_price::text IN ('NaN','Infinity','-Infinity')
    OR p_client_price < 0 OR p_client_price > 21474836.47
  ) THEN
    RAISE EXCEPTION 'client price must be finite, non-negative, and representable as INTEGER cents';
  END IF;
  IF p_booking IS NULL OR jsonb_typeof(p_booking) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'booking must be an object';
  END IF;
  v_pickup_at := (p_booking->>'pickup_datetime')::TIMESTAMPTZ;
  v_passengers := (p_booking->>'passengers')::INTEGER;
  v_bags := COALESCE((p_booking->>'bags')::INTEGER, 0);
  v_booking_mode := p_booking->>'booking_mode';
  v_duration_minutes := NULLIF(p_booking->>'duration_minutes','')::INTEGER;
  IF v_pickup_at IS NULL
     OR v_passengers IS NULL OR v_passengers < 1 OR v_passengers > 12
     OR v_bags < 0 OR v_bags > 15
     OR v_booking_mode IS NULL OR v_booking_mode NOT IN ('pickup','dropoff')
     OR (v_duration_minutes IS NOT NULL
       AND (v_duration_minutes < 1 OR v_duration_minutes > 1440))
     THEN
    RAISE EXCEPTION 'booking ride details are invalid';
  END IF;
  IF p_verdict = 'verified' AND (p_jti IS NULL OR p_token_digest IS NULL
      OR p_payload IS NULL OR p_canonical_place_id IS NULL
      OR p_airport_code IS NULL OR p_vehicle_key IS NULL) THEN
    RAISE EXCEPTION 'a verified consumption requires jti, digest, payload, canonical place, airport, and vehicle';
  ELSIF p_verdict = 'no_token' AND
     (p_token_digest IS NOT NULL OR p_jti IS NOT NULL OR p_payload IS NOT NULL
      OR p_canonical_place_id IS NOT NULL OR p_airport_code IS NOT NULL
      OR p_vehicle_key IS NOT NULL) THEN
    RAISE EXCEPTION 'no_token input may not carry token or canonical data';
  ELSIF p_verdict = 'verify_failed' AND
     (p_token_digest IS NULL OR p_jti IS NOT NULL OR p_payload IS NOT NULL
      OR p_canonical_place_id IS NOT NULL OR p_airport_code IS NOT NULL
      OR p_vehicle_key IS NOT NULL) THEN
    RAISE EXCEPTION 'verify_failed requires only the presented token digest';
  END IF;
  IF p_verdict = 'verified'
     AND jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'verified create payload projection is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 16
    OR NOT (p_payload ?& ARRAY[
      'v','kid','jti','purpose','authUserId','customerId','vehicle',
      'pickupAtMs','commitment','routeQuality','finalCents','pricingVersion',
      'engineVersion','resolvedVersion','iat','exp'
    ])
    OR jsonb_typeof(p_payload->'v') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'kid') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'jti') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'purpose') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'authUserId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'customerId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'vehicle') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'pickupAtMs') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'commitment') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'routeQuality') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'finalCents') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'pricingVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'engineVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'resolvedVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'iat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'exp') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'verified create payload projection is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       (p_payload->>'v')::NUMERIC IS DISTINCT FROM 2::NUMERIC
    OR (p_payload->>'pickupAtMs')::NUMERIC <> trunc((p_payload->>'pickupAtMs')::NUMERIC)
    OR (p_payload->>'pickupAtMs')::NUMERIC < 0
    OR (p_payload->>'pickupAtMs')::NUMERIC > 8640000000000000
    OR p_payload->>'kid' !~ '^[A-Za-z0-9._-]{1,64}$'
    OR p_payload->>'jti' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_payload->>'authUserId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_payload->>'customerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_payload->>'authUserId' = '00000000-0000-0000-0000-000000000000'
    OR p_payload->>'customerId' = '00000000-0000-0000-0000-000000000000'
    OR p_payload->>'vehicle' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR p_payload->>'commitment' !~ '^[0-9a-f]{64}$'
    OR p_payload->>'routeQuality' NOT IN ('traffic_aware','fallback')
    OR p_payload->>'pricingVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR p_payload->>'engineVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR p_payload->>'resolvedVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ) THEN
    RAISE EXCEPTION 'verified create payload projection is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       p_payload->>'purpose' IS DISTINCT FROM 'create'
    OR (p_payload->>'jti')::UUID IS DISTINCT FROM p_jti
    OR (p_payload->>'authUserId')::UUID IS DISTINCT FROM p_auth_user_id
    OR (p_payload->>'customerId')::UUID IS DISTINCT FROM p_customer_id
  ) THEN
    RAISE EXCEPTION 'verified payload context does not match create caller';
  END IF;
  IF p_verdict = 'verified' AND (
       p_airport_code NOT IN ('MIA','FLL','PBI')
    OR p_vehicle_key NOT IN ('tesla','escalade','sprinter')
    OR p_payload->>'vehicle' IS DISTINCT FROM p_vehicle_key
  ) THEN
    RAISE EXCEPTION 'verified canonical airport/vehicle context is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       jsonb_typeof(p_payload->'iat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'exp') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'finalCents') IS DISTINCT FROM 'number'
    OR (p_payload->>'iat')::NUMERIC <> trunc((p_payload->>'iat')::NUMERIC)
    OR (p_payload->>'exp')::NUMERIC <> trunc((p_payload->>'exp')::NUMERIC)
    OR (p_payload->>'iat')::NUMERIC < 0
    OR (p_payload->>'iat')::NUMERIC > 8640000000000000
    OR (p_payload->>'exp')::NUMERIC < 0
    OR (p_payload->>'exp')::NUMERIC > 8640000000000000
    OR (p_payload->>'exp')::NUMERIC - (p_payload->>'iat')::NUMERIC <> 900000
    OR (p_payload->>'finalCents')::NUMERIC <> trunc((p_payload->>'finalCents')::NUMERIC)
    OR (p_payload->>'finalCents')::NUMERIC < 0
    OR (p_payload->>'finalCents')::NUMERIC > 2147483647
  ) THEN
    RAISE EXCEPTION 'verified payload has invalid time or money semantics';
  END IF;
  -- pickupAtMs is part of the signed projection. Mode/passengers and the
  -- quantized route facts are commitment-verified by the Node endpoint and
  -- arrive here as validated typed booking fields; their provenance is
  -- recorded in quote_acceptances rather than inferred from client text.
  IF p_verdict = 'verified' AND
     v_pickup_at IS DISTINCT FROM
       to_timestamp(((p_payload->>'pickupAtMs')::BIGINT) / 1000.0) THEN
    RAISE EXCEPTION 'verified pickup time does not match booking';
  END IF;
  -- Mode, share-locked for the whole transaction (plan v5 C7/C8).
  SELECT ps.mode, ps.enforcement_started_at INTO v_mode, v_high_water
    FROM pricing_state ps WHERE ps.singleton FOR SHARE;
  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'pricing_state singleton missing';
  END IF;
  -- Impossible-state fence (plan v5 C10): the valve makes these modes
  -- unreachable after the high-water mark; if we ever see one anyway,
  -- something bypassed the valve — refuse rather than write.
  IF v_high_water IS NOT NULL AND v_mode IN ('off','observe') THEN
    RAISE EXCEPTION 'impossible pricing state: mode % after enforcement began', v_mode;
  END IF;

  -- Universal idempotency FIRST — even before the blocked gate (plan
  -- v5 C11: "the operation-request receipt is checked first"). A retry
  -- of an ALREADY-COMPLETED booking arriving during a blocked emergency
  -- must report the passenger's real, existing ride — an idempotent
  -- readback creates nothing and consumes no jti, so C10 is preserved.
  IF v_has_request_id THEN
    -- Serialize retries of the same user action. The UNIQUE receipt remains
    -- the durable invariant; this transaction lock closes the miss-then-write
    -- window so the second transaction observes the first receipt.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_request_id::text, 17017));
    SELECT * INTO v_receipt FROM operation_receipts
      WHERE operation_request_id = p_operation_request_id;
    IF FOUND THEN
      IF v_receipt.auth_user_id = p_auth_user_id
         AND v_receipt.customer_id = p_customer_id
         AND v_receipt.kind = 'create'
         AND v_receipt.request_digest = p_request_digest THEN
        RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_receipt.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN v_receipt.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_receipt.customer_id IS DISTINCT FROM p_customer_id
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
  END IF;

  IF v_mode = 'blocked' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('blocked', v_mode, 'create', v_idhash);
    RETURN jsonb_build_object('outcome', 'blocked');
  END IF;

  -- Legacy callers may omit an operation id only while pricing authority is
  -- still off/observe. Enforce refuses them before a quote can be consumed.
  IF NOT v_has_request_id AND v_mode IN ('enforce','blocked') THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('no_request_id', v_mode, 'create', v_idhash);
    RETURN jsonb_build_object('outcome', 'outdated_client');
  END IF;
  -- In off/observe the missing-operation-id evidence is written only after
  -- the booking exists, so its booking_id is truthful. Enforce still refuses
  -- above before any business write.

  -- Exact-digest token retry (plan v5 C11 Path A): even expired, even
  -- after key retirement — identity-gated.
  IF p_token_digest IS NOT NULL THEN
    SELECT * INTO v_accept FROM quote_acceptances WHERE token_digest = p_token_digest;
    IF FOUND THEN
      IF v_accept.auth_user_id = p_auth_user_id
         AND v_accept.customer_id = p_customer_id
         AND v_accept.purpose = 'create' THEN
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, token_digest, booking_id, identity_hash)
          VALUES ('replay_idempotent', v_mode, 'create', v_accept.jti, p_token_digest, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN v_accept.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_accept.customer_id IS DISTINCT FROM p_customer_id
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;

  -- Sibling-token check (same quote, different vehicle token).
  IF p_jti IS NOT NULL THEN
    SELECT * INTO v_accept FROM quote_acceptances WHERE jti = p_jti;
    IF FOUND THEN
      IF v_accept.auth_user_id = p_auth_user_id
         AND v_accept.customer_id = p_customer_id
         AND v_accept.purpose = 'create' THEN
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
          VALUES (CASE WHEN v_mode = 'enforce' THEN 'quote_consumed' ELSE 'would_quote_consumed' END,
                  v_mode, 'create', p_jti, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'quote_consumed', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN v_accept.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_accept.customer_id IS DISTINCT FROM p_customer_id
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;

  -- Recheck time in the database immediately before any NEW consumption.
  -- Exact-digest and already-consumed-jti paths above remain recoverable after
  -- expiry/key retirement; a fresh acceptance never does.
  IF p_verdict = 'verified' THEN
    v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
    IF (p_payload->>'iat')::BIGINT > v_now_ms + 60000 THEN
      v_effective_verdict := 'not_yet_valid';
    ELSIF v_now_ms >= (p_payload->>'exp')::BIGINT THEN
      v_effective_verdict := 'expired';
    END IF;
  END IF;

  -- Enforcement requires authenticity. An authentic but stale/future token
  -- is refused in EVERY mode: observe/off may compare a currently valid quote,
  -- but may never turn an unconsumable quote into a new business write.
  IF v_mode = 'enforce' AND p_verdict <> 'verified' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES (CASE WHEN p_verdict = 'no_token'
                THEN 'rejected_no_token' ELSE 'rejected_invalid' END,
              v_mode, 'create', v_idhash);
    RETURN jsonb_build_object('outcome',
      CASE WHEN p_verdict = 'no_token' THEN 'quote_required' ELSE 'quote_invalid' END);
  END IF;
  IF p_verdict = 'verified' AND v_effective_verdict <> 'verified' THEN
    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, identity_hash
    ) VALUES (v_effective_verdict, v_mode, 'create', p_jti, p_token_digest, v_idhash);
    RETURN jsonb_build_object('outcome', CASE
      WHEN v_effective_verdict = 'expired' THEN 'quote_expired'
      ELSE 'quote_not_yet_valid' END);
  END IF;

  -- Authority (plan v5 C7 matrix).
  IF v_mode = 'enforce' THEN
    v_cents := (p_payload->>'finalCents')::INTEGER;
    v_price := v_cents / 100.0;
    v_authority := 'server_quote';
  ELSIF v_mode = 'observe' THEN
    IF p_client_price IS NULL THEN
      RAISE EXCEPTION 'off/observe modes require a safe client price';
    END IF;
    v_price := round(p_client_price * 100) / 100.0;
    v_cents := round(p_client_price * 100)::INTEGER;
    v_authority := 'client_observe';
  ELSE
    IF p_client_price IS NULL THEN
      RAISE EXCEPTION 'off/observe modes require a safe client price';
    END IF;
    v_price := round(p_client_price * 100) / 100.0;
    v_cents := round(p_client_price * 100)::INTEGER;
    v_authority := 'client_legacy';
  END IF;

  v_referred_by_host := NULLIF(p_booking->>'referred_by_host','')::UUID;
  IF v_referred_by_host IS NOT NULL THEN
    SELECT h.commission_rate INTO v_commission_rate
      FROM hosts h
      WHERE h.id = v_referred_by_host AND h.status = 'active'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'referred host is not active';
    END IF;
    IF v_commission_rate IS NULL OR v_commission_rate < 0 OR v_commission_rate > 1 THEN
      RAISE EXCEPTION 'referred host commission rate is invalid';
    END IF;
  END IF;
  v_host_commission := round(v_price * COALESCE(v_commission_rate, 0), 2);

  PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);
  BEGIN
    INSERT INTO bookings (
      trip_id, customer_id, customer_name, customer_phone, customer_email,
      booker_name, booker_phone,
      pickup_location, dropoff_location, pickup_datetime,
      passengers, bags, vehicle_type, vehicle_name,
      price, price_cents, price_authority,
      canonical_place_id, airport_code, route_authority,
      booking_mode, payment_status, payment_method,
      flight_number, notes, pickup_sign, promo_code,
      referred_by_host, host_commission, duration_minutes,
      status, source
    ) VALUES (
      p_booking->>'trip_id', p_customer_id,
      p_booking->>'customer_name', p_booking->>'customer_phone', p_booking->>'customer_email',
      p_booking->>'booker_name', p_booking->>'booker_phone',
      p_booking->>'pickup_location', p_booking->>'dropoff_location',
      v_pickup_at,
      v_passengers,
      v_bags,
      CASE WHEN p_verdict = 'verified' THEN CASE p_vehicle_key
        WHEN 'tesla' THEN 'sedan' WHEN 'escalade' THEN 'suv'
        WHEN 'sprinter' THEN 'sprinter' END
        ELSE p_booking->>'vehicle_type' END,
      CASE WHEN p_verdict = 'verified' THEN CASE p_vehicle_key
        WHEN 'tesla' THEN 'Tesla Model Y'
        WHEN 'escalade' THEN 'Cadillac Escalade'
        WHEN 'sprinter' THEN 'Mercedes Sprinter' END
        ELSE p_booking->>'vehicle_name' END,
      v_price, v_cents, v_authority,
      CASE WHEN v_effective_verdict = 'verified' AND v_mode <> 'off'
        THEN p_canonical_place_id ELSE NULL END,
      CASE WHEN v_effective_verdict = 'verified' AND v_mode <> 'off'
        THEN p_airport_code ELSE NULL END,
      CASE WHEN v_effective_verdict = 'verified' AND v_mode <> 'off'
        THEN 'canonical' ELSE 'legacy_text' END,
      v_booking_mode, COALESCE(p_booking->>'payment_status','unpaid'),
      COALESCE(p_booking->>'payment_method','cash'),
      p_booking->>'flight_number', p_booking->>'notes',
      p_booking->>'pickup_sign', p_booking->>'promo_code',
      v_referred_by_host,
      v_host_commission,
      -- R1 (address plan v3, ordered prerequisite): provider route duration
      -- is Google Maps Content with no retention exception (case 74801827),
      -- so it is never persisted in any pricing mode. The submitted value is
      -- still bounds-checked above for input strictness, then discarded.
      -- Displays already degrade on NULL (trip ETA block, doorbell eta line).
      NULL::INTEGER,
      'pending', COALESCE(p_booking->>'source','website')
    ) RETURNING id INTO v_booking_id;

    IF v_effective_verdict = 'verified' THEN
      INSERT INTO quote_acceptances (
        jti, token_digest, booking_id, purpose, auth_user_id, customer_id,
        kid, vehicle_key, final_cents, client_cents, authority,
        pricing_version, engine_version, resolved_version,
        canonical_place_id, airport_code, booking_mode, pickup_at, passengers,
        payload_projection
      ) VALUES (
        p_jti, p_token_digest, v_booking_id, 'create', p_auth_user_id, p_customer_id,
        p_payload->>'kid', p_vehicle_key, (p_payload->>'finalCents')::INTEGER,
        CASE WHEN v_mode <> 'enforce' THEN v_cents ELSE NULL END,
        v_authority,
        p_payload->>'pricingVersion', p_payload->>'engineVersion', p_payload->>'resolvedVersion',
        p_canonical_place_id, p_airport_code,
        v_booking_mode,
        to_timestamp(((p_payload->>'pickupAtMs')::BIGINT) / 1000.0),
        v_passengers,
        -- R1 fail-closed acceptance projection: an explicit ALLOWLIST of the
        -- token's non-provider fields. routeQuality (Google Routes
        -- fallbackInfo) is excluded, and any future token field stays out
        -- until it is named here. Distance/duration exist only inside the
        -- keyed commitment hash and were never plaintext.
        jsonb_build_object(
          'v', p_payload->'v',
          'kid', p_payload->'kid',
          'jti', p_payload->'jti',
          'purpose', p_payload->'purpose',
          'authUserId', p_payload->'authUserId',
          'customerId', p_payload->'customerId',
          'vehicle', p_payload->'vehicle',
          'pickupAtMs', p_payload->'pickupAtMs',
          'commitment', p_payload->'commitment',
          'finalCents', p_payload->'finalCents',
          'pricingVersion', p_payload->'pricingVersion',
          'engineVersion', p_payload->'engineVersion',
          'resolvedVersion', p_payload->'resolvedVersion',
          'iat', p_payload->'iat',
          'exp', p_payload->'exp'
        )
      );
    END IF;

    IF v_has_request_id THEN
      INSERT INTO operation_receipts (
        operation_request_id, kind, auth_user_id, customer_id,
        request_digest, booking_id
      ) VALUES (
        p_operation_request_id, 'create', p_auth_user_id, p_customer_id,
        p_request_digest, v_booking_id
      );
    END IF;

    IF NOT v_has_request_id THEN
      INSERT INTO quote_verifications (
        verdict, mode, purpose, booking_id, identity_hash
      ) VALUES ('no_request_id', v_mode, 'create', v_booking_id, v_idhash);
    END IF;

    -- The booking/acceptance/receipt inserts above can wait on unique-index
    -- conflicts. If the competing transaction rolls back after this token's
    -- expiry, our inserts can then succeed. Recheck at the final write
    -- boundary and raise inside this subtransaction: the dedicated handler
    -- below records the refusal only after every business write rolls back.
    IF p_verdict = 'verified' THEN
      v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
      IF (p_payload->>'iat')::BIGINT > v_now_ms + 60000 THEN
        v_effective_verdict := 'not_yet_valid';
      ELSIF v_now_ms >= (p_payload->>'exp')::BIGINT THEN
        v_effective_verdict := 'expired';
      END IF;
      IF v_effective_verdict <> 'verified' THEN
        RAISE EXCEPTION USING ERRCODE = 'ZQ017', MESSAGE = v_effective_verdict;
      END IF;
    END IF;

    -- Stored jti/digest are VERIFIED-ONLY (the table's contract): an
    -- unverifiable token's digest is used for the Path-A lookup above
    -- but never persisted as evidence.
    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, booking_id, identity_hash,
      client_cents, server_cents
    ) VALUES (
      v_effective_verdict,
      v_mode, 'create',
      CASE WHEN v_effective_verdict = 'verified' THEN p_jti ELSE NULL END,
      CASE WHEN v_effective_verdict = 'verified' THEN p_token_digest ELSE NULL END,
      v_booking_id, v_idhash,
      CASE WHEN p_client_price IS NOT NULL THEN round(p_client_price * 100)::INTEGER ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN (p_payload->>'finalCents')::INTEGER ELSE NULL END
    );

    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    RETURN jsonb_build_object('outcome', 'created', 'booking_id', v_booking_id,
                              'authority', v_authority);

  EXCEPTION WHEN SQLSTATE 'ZQ017' THEN
    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, identity_hash
    ) VALUES (v_effective_verdict, v_mode, 'create', p_jti, p_token_digest, v_idhash);
    RETURN jsonb_build_object('outcome', CASE
      WHEN v_effective_verdict = 'expired' THEN 'quote_expired'
      ELSE 'quote_not_yet_valid' END);

  WHEN unique_violation THEN
    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    -- Constraint-name branching is mandatory (plan v2 §3): with several
    -- unique constraints live, a bare handler would misread one race
    -- as another. NOTE: everything inside the block above — including
    -- its telemetry rows — rolled back with the subtransaction, so the
    -- LOSING attempt's evidence is written HERE, where it commits.
    IF v_constraint = 'bookings_one_active_per_customer' THEN
      -- A same-operation retry can lose on the active-slot index before its
      -- receipt insert is observed. Re-read and classify it before reporting
      -- a different active booking.
      IF v_has_request_id THEN
        SELECT * INTO v_receipt FROM operation_receipts
          WHERE operation_request_id = p_operation_request_id;
        IF FOUND THEN
          IF v_receipt.auth_user_id = p_auth_user_id
             AND v_receipt.customer_id = p_customer_id
             AND v_receipt.kind = 'create'
             AND v_receipt.request_digest = p_request_digest THEN
            RETURN jsonb_build_object('outcome', 'idempotent',
              'booking_id', v_receipt.booking_id);
          END IF;
          INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
            VALUES (CASE
                      WHEN v_receipt.auth_user_id IS DISTINCT FROM p_auth_user_id
                        OR v_receipt.customer_id IS DISTINCT FROM p_customer_id
                      THEN 'replay_identity_mismatch'
                      ELSE 'replay_context_mismatch'
                    END, v_mode, 'create', v_idhash);
          RETURN jsonb_build_object('outcome', 'conflict');
        END IF;
      END IF;
      SELECT id INTO v_booking_id FROM bookings
        WHERE active_slot = p_customer_id;
      INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
        VALUES ('active_conflict', v_mode, 'create', p_jti, v_booking_id, v_idhash);
      RETURN jsonb_build_object('outcome', 'active_exists', 'booking_id', v_booking_id);
    ELSIF v_constraint IN ('quote_acceptances_jti_key', 'quote_acceptances_token_digest_key') THEN
      -- Lost the consumption race: re-classify under the identity gate.
      SELECT * INTO v_accept FROM quote_acceptances
        WHERE jti = p_jti OR token_digest = p_token_digest
        ORDER BY (token_digest = p_token_digest) DESC LIMIT 1;
      IF FOUND AND v_accept.auth_user_id = p_auth_user_id
               AND v_accept.customer_id = p_customer_id
               AND v_accept.purpose = 'create' THEN
        IF v_accept.token_digest = p_token_digest THEN
          INSERT INTO quote_verifications (verdict, mode, purpose, jti, token_digest, booking_id, identity_hash)
            VALUES ('replay_idempotent', v_mode, 'create', p_jti, p_token_digest, v_accept.booking_id, v_idhash);
          RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_accept.booking_id);
        END IF;
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
          VALUES ('quote_consumed', v_mode, 'create', p_jti, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'quote_consumed', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN FOUND AND v_accept.auth_user_id = p_auth_user_id
                    AND v_accept.customer_id = p_customer_id
                  THEN 'replay_context_mismatch'
                  ELSE 'replay_identity_mismatch'
                END, v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    ELSIF v_constraint = 'operation_receipts_operation_request_id_key' THEN
      SELECT * INTO v_receipt FROM operation_receipts
        WHERE operation_request_id = p_operation_request_id;
      IF FOUND AND v_receipt.auth_user_id = p_auth_user_id
               AND v_receipt.customer_id = p_customer_id
               AND v_receipt.kind = 'create'
               AND v_receipt.request_digest = p_request_digest THEN
        RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_receipt.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN FOUND AND (v_receipt.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_receipt.customer_id IS DISTINCT FROM p_customer_id)
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
    RAISE;
  END;
END $$;

CREATE OR REPLACE FUNCTION accept_quote_edit(
  p_auth_user_id UUID,
  p_customer_id UUID,
  p_operation_request_id UUID,
  p_request_digest TEXT,
  p_booking_id UUID,
  p_expected_details_version INTEGER,
  p_verdict TEXT,               -- authentic stale/future tokens stay verified
  p_jti UUID,
  p_token_digest TEXT,
  p_payload JSONB,
  p_client_price NUMERIC,
  p_canonical_place_id TEXT,    -- the commitment-verified canonical id (NULL unless verified)
  p_airport_code TEXT,          -- trusted endpoint output after commitment verification
  p_vehicle_key TEXT,           -- canonical key; must equal payload.vehicle
  p_edit JSONB                  -- the ride-detail column values
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_mode TEXT;
  v_high_water TIMESTAMPTZ;
  v_row bookings%ROWTYPE;
  v_receipt operation_receipts%ROWTYPE;
  v_accept quote_acceptances%ROWTYPE;
  v_price NUMERIC;
  v_cents INTEGER;
  v_authority TEXT;
  v_idhash TEXT := encode(extensions.digest(p_auth_user_id::text, 'sha256'), 'hex');
  v_constraint TEXT;
  v_effective_verdict TEXT := p_verdict;
  v_has_request_id BOOLEAN;
  v_now_ms BIGINT;
  v_row_found BOOLEAN;
  v_current_details_version INTEGER;
  v_pickup_at TIMESTAMPTZ;
  v_passengers INTEGER;
  v_bags INTEGER;
  v_booking_mode TEXT;
  v_duration_minutes INTEGER;
  v_customer_name TEXT;
  v_customer_phone TEXT;
  v_customer_email TEXT;
  v_booker_name TEXT;
  v_booker_phone TEXT;
  v_payment_method TEXT;
  v_commission_rate NUMERIC := 0;
  v_host_commission NUMERIC := 0;
BEGIN
  IF p_auth_user_id IS NULL OR p_customer_id IS NULL OR p_booking_id IS NULL THEN
    RAISE EXCEPTION 'authenticated identities and booking_id are required';
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('verified','no_token','verify_failed') THEN
    RAISE EXCEPTION 'unknown verdict %', COALESCE(p_verdict, 'NULL');
  END IF;
  IF (p_operation_request_id IS NULL) <> (p_request_digest IS NULL) THEN
    RAISE EXCEPTION 'operation_request_id and request_digest must be supplied together';
  END IF;
  v_has_request_id := p_operation_request_id IS NOT NULL;
  IF p_request_digest IS NOT NULL AND p_request_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'request_digest must be lowercase SHA-256 hex';
  END IF;
  IF p_token_digest IS NOT NULL AND p_token_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'token_digest must be lowercase SHA-256 hex';
  END IF;
  IF p_client_price IS NOT NULL AND (
       p_client_price::text IN ('NaN','Infinity','-Infinity')
    OR p_client_price < 0 OR p_client_price > 21474836.47
  ) THEN
    RAISE EXCEPTION 'client price must be finite, non-negative, and representable as INTEGER cents';
  END IF;
  IF p_edit IS NOT NULL AND jsonb_typeof(p_edit) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'edit must be an object';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(COALESCE(p_edit, '{}'::JSONB)) AS supplied(key)
    WHERE supplied.key <> ALL (ARRAY[
      'pickup_location','dropoff_location','pickup_datetime',
      'passengers','bags','vehicle_type','vehicle_name','booking_mode',
      'duration_minutes','customer_name','customer_phone','customer_email',
      'booker_name','booker_phone','payment_method','flight_number','notes',
      'pickup_sign','promo_code'
    ]::TEXT[])
  ) THEN
    RAISE EXCEPTION 'edit contains a protected or unknown field';
  END IF;
  IF p_verdict = 'verified' AND (p_jti IS NULL OR p_token_digest IS NULL
      OR p_payload IS NULL OR p_canonical_place_id IS NULL
      OR p_airport_code IS NULL OR p_vehicle_key IS NULL) THEN
    RAISE EXCEPTION 'a verified consumption requires jti, digest, payload, canonical place, airport, and vehicle';
  ELSIF p_verdict = 'no_token' AND
     (p_token_digest IS NOT NULL OR p_jti IS NOT NULL OR p_payload IS NOT NULL
      OR p_canonical_place_id IS NOT NULL OR p_airport_code IS NOT NULL
      OR p_vehicle_key IS NOT NULL) THEN
    RAISE EXCEPTION 'no_token input may not carry token or canonical data';
  ELSIF p_verdict = 'verify_failed' AND
     (p_token_digest IS NULL OR p_jti IS NOT NULL OR p_payload IS NOT NULL
      OR p_canonical_place_id IS NOT NULL OR p_airport_code IS NOT NULL
      OR p_vehicle_key IS NOT NULL) THEN
    RAISE EXCEPTION 'verify_failed requires only the presented token digest';
  END IF;
  IF p_verdict = 'verified'
     AND jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'verified edit payload projection is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 18
    OR NOT (p_payload ?& ARRAY[
      'v','kid','jti','purpose','authUserId','customerId','bookingId',
      'assignmentEpoch','vehicle','pickupAtMs','commitment','routeQuality',
      'finalCents','pricingVersion','engineVersion','resolvedVersion','iat','exp'
    ])
    OR jsonb_typeof(p_payload->'v') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'kid') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'jti') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'purpose') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'authUserId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'customerId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'bookingId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'assignmentEpoch') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'vehicle') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'pickupAtMs') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'commitment') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'routeQuality') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'finalCents') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'pricingVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'engineVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'resolvedVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'iat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'exp') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'verified edit payload projection is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       (p_payload->>'v')::NUMERIC IS DISTINCT FROM 2::NUMERIC
    OR (p_payload->>'assignmentEpoch')::NUMERIC < 0
    OR (p_payload->>'assignmentEpoch')::NUMERIC > 2147483647
    OR (p_payload->>'assignmentEpoch')::NUMERIC <>
       trunc((p_payload->>'assignmentEpoch')::NUMERIC)
    OR (p_payload->>'pickupAtMs')::NUMERIC <> trunc((p_payload->>'pickupAtMs')::NUMERIC)
    OR (p_payload->>'pickupAtMs')::NUMERIC < 0
    OR (p_payload->>'pickupAtMs')::NUMERIC > 8640000000000000
    OR p_payload->>'kid' !~ '^[A-Za-z0-9._-]{1,64}$'
    OR p_payload->>'jti' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_payload->>'authUserId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_payload->>'customerId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_payload->>'bookingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p_payload->>'authUserId' = '00000000-0000-0000-0000-000000000000'
    OR p_payload->>'customerId' = '00000000-0000-0000-0000-000000000000'
    OR p_payload->>'bookingId' = '00000000-0000-0000-0000-000000000000'
    OR p_payload->>'vehicle' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR p_payload->>'commitment' !~ '^[0-9a-f]{64}$'
    OR p_payload->>'routeQuality' NOT IN ('traffic_aware','fallback')
    OR p_payload->>'pricingVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR p_payload->>'engineVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    OR p_payload->>'resolvedVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ) THEN
    RAISE EXCEPTION 'verified edit payload projection is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       p_payload->>'purpose' IS DISTINCT FROM 'edit'
    OR (p_payload->>'jti')::UUID IS DISTINCT FROM p_jti
    OR (p_payload->>'authUserId')::UUID IS DISTINCT FROM p_auth_user_id
    OR (p_payload->>'customerId')::UUID IS DISTINCT FROM p_customer_id
  ) THEN
    RAISE EXCEPTION 'verified payload context does not match edit caller';
  END IF;
  IF p_verdict = 'verified' AND (
       p_airport_code NOT IN ('MIA','FLL','PBI')
    OR p_vehicle_key NOT IN ('tesla','escalade','sprinter')
    OR p_payload->>'vehicle' IS DISTINCT FROM p_vehicle_key
  ) THEN
    RAISE EXCEPTION 'verified canonical airport/vehicle context is invalid';
  END IF;
  IF p_verdict = 'verified' AND (
       jsonb_typeof(p_payload->'iat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'exp') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'finalCents') IS DISTINCT FROM 'number'
    OR (p_payload->>'iat')::NUMERIC <> trunc((p_payload->>'iat')::NUMERIC)
    OR (p_payload->>'exp')::NUMERIC <> trunc((p_payload->>'exp')::NUMERIC)
    OR (p_payload->>'iat')::NUMERIC < 0
    OR (p_payload->>'iat')::NUMERIC > 8640000000000000
    OR (p_payload->>'exp')::NUMERIC < 0
    OR (p_payload->>'exp')::NUMERIC > 8640000000000000
    OR (p_payload->>'exp')::NUMERIC - (p_payload->>'iat')::NUMERIC <> 900000
    OR (p_payload->>'finalCents')::NUMERIC <> trunc((p_payload->>'finalCents')::NUMERIC)
    OR (p_payload->>'finalCents')::NUMERIC < 0
    OR (p_payload->>'finalCents')::NUMERIC > 2147483647
  ) THEN
    RAISE EXCEPTION 'verified payload has invalid time or money semantics';
  END IF;

  SELECT ps.mode, ps.enforcement_started_at INTO v_mode, v_high_water
    FROM pricing_state ps WHERE ps.singleton FOR SHARE;
  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'pricing_state singleton missing';
  END IF;
  -- Impossible-state fence (plan v5 C10): the valve makes these modes
  -- unreachable after the high-water mark; if we ever see one anyway,
  -- something bypassed the valve — refuse rather than write.
  IF v_high_water IS NOT NULL AND v_mode IN ('off','observe') THEN
    RAISE EXCEPTION 'impossible pricing state: mode % after enforcement began', v_mode;
  END IF;
  -- Universal idempotency FIRST — even before the blocked gate (see
  -- the create RPC's note; same rule, same reason).
  IF v_has_request_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_request_id::text, 17017));
    SELECT * INTO v_receipt FROM operation_receipts
      WHERE operation_request_id = p_operation_request_id;
    IF FOUND THEN
      IF v_receipt.auth_user_id = p_auth_user_id
         AND v_receipt.customer_id = p_customer_id
         AND v_receipt.kind = 'edit_quoted'
         AND v_receipt.booking_id = p_booking_id
         AND v_receipt.request_digest = p_request_digest THEN
        SELECT details_version INTO v_current_details_version
          FROM bookings WHERE id = v_receipt.booking_id;
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_receipt.booking_id, 'details_version', v_current_details_version);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN v_receipt.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_receipt.customer_id IS DISTINCT FROM p_customer_id
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
  END IF;

  IF v_mode = 'blocked' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('blocked', v_mode, 'edit', v_idhash);
    RETURN jsonb_build_object('outcome', 'blocked');
  END IF;

  IF NOT v_has_request_id AND v_mode IN ('enforce','blocked') THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('no_request_id', v_mode, 'edit', v_idhash);
    RETURN jsonb_build_object('outcome', 'outdated_client');
  END IF;
  IF NOT v_has_request_id THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, booking_id, identity_hash)
      VALUES ('no_request_id', v_mode, 'edit', p_booking_id, v_idhash);
  END IF;

  -- Exact-digest retry (identity-gated), then sibling check.
  IF p_token_digest IS NOT NULL THEN
    SELECT * INTO v_accept FROM quote_acceptances WHERE token_digest = p_token_digest;
    IF FOUND THEN
      -- An exact-digest hit is an idempotent EDIT retry only when it
      -- was an edit acceptance FOR THIS BOOKING by THIS identity. A
      -- same-identity CREATE-token digest replayed here must not
      -- report a phantom edit success.
      IF v_accept.auth_user_id = p_auth_user_id AND v_accept.customer_id = p_customer_id
         AND v_accept.purpose = 'edit' AND v_accept.booking_id = p_booking_id THEN
        SELECT details_version INTO v_current_details_version
          FROM bookings WHERE id = v_accept.booking_id;
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, token_digest, booking_id, identity_hash)
          VALUES ('replay_idempotent', v_mode, 'edit', v_accept.jti, p_token_digest, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_accept.booking_id,
          'details_version', v_current_details_version);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN v_accept.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_accept.customer_id IS DISTINCT FROM p_customer_id
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;
  IF p_jti IS NOT NULL THEN
    SELECT * INTO v_accept FROM quote_acceptances WHERE jti = p_jti;
    IF FOUND THEN
      IF v_accept.auth_user_id = p_auth_user_id
         AND v_accept.customer_id = p_customer_id
         AND v_accept.purpose = 'edit'
         AND v_accept.booking_id = p_booking_id THEN
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
          VALUES (CASE WHEN v_mode = 'enforce' THEN 'quote_consumed' ELSE 'would_quote_consumed' END,
                  v_mode, 'edit', p_jti, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'quote_consumed', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN v_accept.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_accept.customer_id IS DISTINCT FROM p_customer_id
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;

  -- Recheck time immediately before any new acceptance. Retry/consumed paths
  -- above intentionally precede this verdict.
  IF p_verdict = 'verified' THEN
    v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
    IF (p_payload->>'iat')::BIGINT > v_now_ms + 60000 THEN
      v_effective_verdict := 'not_yet_valid';
    ELSIF v_now_ms >= (p_payload->>'exp')::BIGINT THEN
      v_effective_verdict := 'expired';
    END IF;
  END IF;

  IF v_mode = 'enforce' AND p_verdict <> 'verified' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES (CASE WHEN p_verdict = 'no_token'
                THEN 'rejected_no_token' ELSE 'rejected_invalid' END,
              v_mode, 'edit', v_idhash);
    RETURN jsonb_build_object('outcome',
      CASE WHEN p_verdict = 'no_token' THEN 'quote_required' ELSE 'quote_invalid' END);
  END IF;
  IF p_verdict = 'verified' AND v_effective_verdict <> 'verified' THEN
    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, booking_id, identity_hash
    ) VALUES (v_effective_verdict, v_mode, 'edit', p_jti, p_token_digest,
              p_booking_id, v_idhash);
    RETURN jsonb_build_object('outcome', CASE
      WHEN v_effective_verdict = 'expired' THEN 'quote_expired'
      ELSE 'quote_not_yet_valid' END);
  END IF;

  -- The guarded row read: ownership, status, CAS, and ERA all checked
  -- against live truth under lock.
  SELECT * INTO v_row FROM bookings WHERE id = p_booking_id FOR UPDATE;
  v_row_found := FOUND;

  -- The row lock can outlive the token. Repeat the database-clock verdict
  -- after the wait and before any CAS or business write.
  IF p_verdict = 'verified' THEN
    v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
    IF (p_payload->>'iat')::BIGINT > v_now_ms + 60000 THEN
      INSERT INTO quote_verifications (
        verdict, mode, purpose, jti, token_digest, booking_id, identity_hash
      ) VALUES ('not_yet_valid', v_mode, 'edit', p_jti, p_token_digest,
                p_booking_id, v_idhash);
      RETURN jsonb_build_object('outcome', 'quote_not_yet_valid');
    ELSIF v_now_ms >= (p_payload->>'exp')::BIGINT THEN
      INSERT INTO quote_verifications (
        verdict, mode, purpose, jti, token_digest, booking_id, identity_hash
      ) VALUES ('expired', v_mode, 'edit', p_jti, p_token_digest,
                p_booking_id, v_idhash);
      RETURN jsonb_build_object('outcome', 'quote_expired');
    END IF;
  END IF;

  -- A concurrent retry may have waited on this row while the first request
  -- committed its receipt and version bump. Re-read before status/CAS exits.
  IF v_has_request_id THEN
    SELECT * INTO v_receipt FROM operation_receipts
      WHERE operation_request_id = p_operation_request_id;
    IF FOUND THEN
      IF v_receipt.auth_user_id = p_auth_user_id
         AND v_receipt.customer_id = p_customer_id
         AND v_receipt.kind = 'edit_quoted'
         AND v_receipt.booking_id = p_booking_id
         AND v_receipt.request_digest = p_request_digest THEN
        SELECT details_version INTO v_current_details_version
          FROM bookings WHERE id = v_receipt.booking_id;
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_receipt.booking_id, 'details_version', v_current_details_version);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, booking_id, identity_hash)
        VALUES (CASE
                  WHEN v_receipt.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_receipt.customer_id IS DISTINCT FROM p_customer_id
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'edit', p_booking_id, v_idhash);
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
  END IF;
  IF NOT v_row_found OR v_row.customer_id IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_row.status <> 'pending' OR v_row.assigned_driver IS NOT NULL THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, booking_id, identity_hash)
      VALUES ('edit_conflict', v_mode, 'edit', p_booking_id, v_idhash);
    RETURN jsonb_build_object('outcome', 'not_editable', 'status', v_row.status);
  END IF;
  IF v_row.details_version IS DISTINCT FROM p_expected_details_version THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, booking_id, identity_hash)
      VALUES ('edit_conflict', v_mode, 'edit', p_booking_id, v_idhash);
    RETURN jsonb_build_object('outcome', 'version_conflict',
      'details_version', v_row.details_version);
  END IF;
  IF v_effective_verdict = 'verified' THEN
    -- Edit tokens bind bookingId + assignmentEpoch (plan v5 C12/C13):
    -- a token issued before an Accept/Release era cannot apply after.
    IF (p_payload->>'bookingId')::UUID IS DISTINCT FROM p_booking_id THEN
      INSERT INTO quote_verifications (
        verdict, mode, purpose, jti, token_digest, booking_id, identity_hash
      ) VALUES ('edit_conflict', v_mode, 'edit', p_jti, p_token_digest,
                p_booking_id, v_idhash);
      RETURN jsonb_build_object('outcome', 'quote_mismatch');
    END IF;
    IF (p_payload->>'assignmentEpoch')::INTEGER IS DISTINCT FROM v_row.assignment_epoch THEN
      INSERT INTO quote_verifications (
        verdict, mode, purpose, jti, token_digest, booking_id, identity_hash
      ) VALUES ('edit_conflict', v_mode, 'edit', p_jti, p_token_digest,
                p_booking_id, v_idhash);
      RETURN jsonb_build_object('outcome', 'epoch_conflict');
    END IF;
  END IF;

  -- Resolve the complete form against the locked row before the money/write
  -- phase. Missing/blank optional values preserve stored truth; customer
  -- name/phone cannot be cleared; a coherent booker pair is updated atomically.
  v_pickup_at := COALESCE(
    NULLIF(p_edit->>'pickup_datetime','')::TIMESTAMPTZ, v_row.pickup_datetime);
  v_passengers := COALESCE(NULLIF(p_edit->>'passengers','')::INTEGER, v_row.passengers);
  v_bags := COALESCE(NULLIF(p_edit->>'bags','')::INTEGER, v_row.bags);
  v_booking_mode := COALESCE(NULLIF(btrim(p_edit->>'booking_mode'),''), v_row.booking_mode);
  -- R1: no row fallback — the band check below must validate the SUBMITTED
  -- input only. Falling back to the stored value would turn it into
  -- stored-data validation and let a legacy out-of-band row fail an
  -- otherwise valid edit (verification finding, 2026-09-01).
  v_duration_minutes := NULLIF(p_edit->>'duration_minutes','')::INTEGER;
  v_customer_name := COALESCE(
    NULLIF(btrim(p_edit->>'customer_name'),''), v_row.customer_name);
  v_customer_phone := COALESCE(
    NULLIF(btrim(p_edit->>'customer_phone'),''), v_row.customer_phone);
  v_customer_email := COALESCE(
    NULLIF(btrim(p_edit->>'customer_email'),''), v_row.customer_email);
  v_payment_method := COALESCE(
    NULLIF(btrim(p_edit->>'payment_method'),''), v_row.payment_method, 'cash');

  IF p_edit ? 'booker_name' AND NULLIF(btrim(p_edit->>'booker_name'),'') IS NOT NULL THEN
    IF btrim(p_edit->>'booker_name') = v_customer_name THEN
      v_booker_name := NULL;
      v_booker_phone := NULL;
    ELSE
      v_booker_name := btrim(p_edit->>'booker_name');
      v_booker_phone := NULLIF(btrim(p_edit->>'booker_phone'),'');
    END IF;
  ELSE
    v_booker_name := v_row.booker_name;
    v_booker_phone := v_row.booker_phone;
  END IF;

  IF v_pickup_at IS NULL
     OR v_passengers IS NULL OR v_passengers < 1 OR v_passengers > 12
     OR v_bags IS NULL OR v_bags < 0 OR v_bags > 15
     OR v_booking_mode IS NULL OR v_booking_mode NOT IN ('pickup','dropoff')
     OR (v_duration_minutes IS NOT NULL
       AND (v_duration_minutes < 1 OR v_duration_minutes > 1440))

     OR NULLIF(btrim(v_customer_name),'') IS NULL
     OR NULLIF(btrim(v_customer_phone),'') IS NULL
     OR char_length(v_customer_name) > 120
     OR char_length(v_customer_phone) > 40
     OR (v_customer_email IS NOT NULL AND char_length(v_customer_email) > 254)
     OR (v_booker_name IS NOT NULL AND char_length(v_booker_name) > 120)
     OR (v_booker_phone IS NOT NULL AND char_length(v_booker_phone) > 40)
     OR char_length(v_payment_method) > 30 THEN
    RAISE EXCEPTION 'edit ride details are invalid';
  END IF;

  IF v_effective_verdict = 'verified' AND
     v_pickup_at IS DISTINCT FROM
       to_timestamp(((p_payload->>'pickupAtMs')::BIGINT) / 1000.0) THEN
    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, booking_id, identity_hash
    ) VALUES ('edit_conflict', v_mode, 'edit', p_jti, p_token_digest,
              p_booking_id, v_idhash);
    RETURN jsonb_build_object('outcome', 'quote_mismatch');
  END IF;

  IF v_mode = 'enforce' THEN
    v_cents := (p_payload->>'finalCents')::INTEGER;
    v_price := v_cents / 100.0;
    v_authority := 'server_quote';
  ELSIF v_mode = 'observe' THEN
    IF p_client_price IS NULL THEN
      RAISE EXCEPTION 'off/observe modes require a safe client price';
    END IF;
    v_price := round(p_client_price * 100) / 100.0;
    v_cents := round(p_client_price * 100)::INTEGER;
    v_authority := 'client_observe';
  ELSE
    IF p_client_price IS NULL THEN
      RAISE EXCEPTION 'off/observe modes require a safe client price';
    END IF;
    v_price := round(p_client_price * 100) / 100.0;
    v_cents := round(p_client_price * 100)::INTEGER;
    v_authority := 'client_legacy';
  END IF;

  IF v_row.referred_by_host IS NOT NULL THEN
    IF v_row.price > 0 THEN
      v_commission_rate := COALESCE(v_row.host_commission, 0) / v_row.price;
    ELSIF COALESCE(v_row.host_commission, 0) = 0 THEN
      v_commission_rate := 0;
    ELSE
      RAISE EXCEPTION 'stored ambassador commission ratio is invalid';
    END IF;
    IF v_commission_rate < 0 OR v_commission_rate > 1 THEN
      RAISE EXCEPTION 'stored ambassador commission ratio is invalid';
    END IF;
  END IF;
  v_host_commission := round(v_price * v_commission_rate, 2);

  PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);
  BEGIN
    UPDATE bookings SET
      pickup_location = COALESCE(p_edit->>'pickup_location', pickup_location),
      dropoff_location = COALESCE(p_edit->>'dropoff_location', dropoff_location),
      pickup_datetime = v_pickup_at,
      passengers = v_passengers,
      bags = v_bags,
      vehicle_type = CASE WHEN p_verdict = 'verified' THEN CASE p_vehicle_key
        WHEN 'tesla' THEN 'sedan' WHEN 'escalade' THEN 'suv'
        WHEN 'sprinter' THEN 'sprinter' END
        ELSE COALESCE(p_edit->>'vehicle_type', vehicle_type) END,
      vehicle_name = CASE WHEN p_verdict = 'verified' THEN CASE p_vehicle_key
        WHEN 'tesla' THEN 'Tesla Model Y'
        WHEN 'escalade' THEN 'Cadillac Escalade'
        WHEN 'sprinter' THEN 'Mercedes Sprinter' END
        ELSE COALESCE(p_edit->>'vehicle_name', vehicle_name) END,
      booking_mode = v_booking_mode,
      -- R1: provider duration is never persisted; an edit is a new write,
      -- so it also clears any legacy stored value on the row it touches.
      duration_minutes = NULL,
      customer_name = v_customer_name,
      customer_phone = v_customer_phone,
      customer_email = v_customer_email,
      booker_name = v_booker_name,
      booker_phone = v_booker_phone,
      payment_method = v_payment_method,
      flight_number = COALESCE(NULLIF(p_edit->>'flight_number',''), flight_number),
      notes = COALESCE(NULLIF(p_edit->>'notes',''), notes),
      pickup_sign = COALESCE(NULLIF(p_edit->>'pickup_sign',''), pickup_sign),
      promo_code = COALESCE(NULLIF(p_edit->>'promo_code',''), promo_code),
      host_commission = v_host_commission,
      price = v_price,
      price_cents = v_cents,
      price_authority = v_authority,
      -- A full-form edit changes the ride intent.  If the replacement intent
      -- was not verified, retaining the old canonical identity would falsely
      -- claim that it still described the edited route.  Downgrade honestly.
      canonical_place_id = CASE WHEN v_effective_verdict = 'verified' AND v_mode <> 'off'
        THEN p_canonical_place_id ELSE NULL END,
      airport_code = CASE WHEN v_effective_verdict = 'verified' AND v_mode <> 'off'
        THEN p_airport_code ELSE NULL END,
      route_authority = CASE WHEN v_effective_verdict = 'verified' AND v_mode <> 'off'
        THEN 'canonical' ELSE 'legacy_text' END,
      details_version = details_version + 1,
      updated_at = now()
    WHERE id = p_booking_id;

    IF v_effective_verdict = 'verified' THEN
      INSERT INTO quote_acceptances (
        jti, token_digest, booking_id, purpose, auth_user_id, customer_id,
        kid, vehicle_key, final_cents, client_cents, authority,
        pricing_version, engine_version, resolved_version,
        canonical_place_id, airport_code, booking_mode, pickup_at, passengers,
        payload_projection
      ) VALUES (
        p_jti, p_token_digest, p_booking_id, 'edit', p_auth_user_id, p_customer_id,
        p_payload->>'kid', p_vehicle_key, (p_payload->>'finalCents')::INTEGER,
        CASE WHEN v_mode <> 'enforce' THEN v_cents ELSE NULL END,
        v_authority,
        p_payload->>'pricingVersion', p_payload->>'engineVersion', p_payload->>'resolvedVersion',
        p_canonical_place_id, p_airport_code,
        v_booking_mode,
        to_timestamp(((p_payload->>'pickupAtMs')::BIGINT) / 1000.0),
        v_passengers,
        -- R1 fail-closed acceptance projection: an explicit ALLOWLIST of the
        -- token's non-provider fields. routeQuality (Google Routes
        -- fallbackInfo) is excluded, and any future token field stays out
        -- until it is named here. Distance/duration exist only inside the
        -- keyed commitment hash and were never plaintext.
        jsonb_build_object(
          'v', p_payload->'v',
          'kid', p_payload->'kid',
          'jti', p_payload->'jti',
          'purpose', p_payload->'purpose',
          'authUserId', p_payload->'authUserId',
          'customerId', p_payload->'customerId',
          'bookingId', p_payload->'bookingId',
          'assignmentEpoch', p_payload->'assignmentEpoch',
          'vehicle', p_payload->'vehicle',
          'pickupAtMs', p_payload->'pickupAtMs',
          'commitment', p_payload->'commitment',
          'finalCents', p_payload->'finalCents',
          'pricingVersion', p_payload->'pricingVersion',
          'engineVersion', p_payload->'engineVersion',
          'resolvedVersion', p_payload->'resolvedVersion',
          'iat', p_payload->'iat',
          'exp', p_payload->'exp'
        )
      );
    END IF;

    IF v_has_request_id THEN
      INSERT INTO operation_receipts (
        operation_request_id, kind, auth_user_id, customer_id,
        request_digest, booking_id, details_version
      ) VALUES (
        p_operation_request_id, 'edit_quoted', p_auth_user_id, p_customer_id,
        p_request_digest, p_booking_id, v_row.details_version + 1
      );
    END IF;

    -- Acceptance/receipt uniqueness can block after the post-row-lock clock
    -- check. Roll back the edit and all acceptance/receipt writes if the price
    -- hold expires during that final wait.
    IF p_verdict = 'verified' THEN
      v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
      IF (p_payload->>'iat')::BIGINT > v_now_ms + 60000 THEN
        v_effective_verdict := 'not_yet_valid';
      ELSIF v_now_ms >= (p_payload->>'exp')::BIGINT THEN
        v_effective_verdict := 'expired';
      END IF;
      IF v_effective_verdict <> 'verified' THEN
        RAISE EXCEPTION USING ERRCODE = 'ZQ017', MESSAGE = v_effective_verdict;
      END IF;
    END IF;

    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, booking_id, identity_hash,
      client_cents, server_cents
    ) VALUES (
      v_effective_verdict,
      v_mode, 'edit',
      CASE WHEN v_effective_verdict = 'verified' THEN p_jti ELSE NULL END,
      CASE WHEN v_effective_verdict = 'verified' THEN p_token_digest ELSE NULL END,
      p_booking_id, v_idhash,
      CASE WHEN p_client_price IS NOT NULL THEN round(p_client_price * 100)::INTEGER ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN (p_payload->>'finalCents')::INTEGER ELSE NULL END
    );

    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    RETURN jsonb_build_object('outcome', 'updated', 'booking_id', p_booking_id,
      'details_version', v_row.details_version + 1, 'authority', v_authority);

  EXCEPTION WHEN SQLSTATE 'ZQ017' THEN
    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, booking_id, identity_hash
    ) VALUES (v_effective_verdict, v_mode, 'edit', p_jti, p_token_digest,
              p_booking_id, v_idhash);
    RETURN jsonb_build_object('outcome', CASE
      WHEN v_effective_verdict = 'expired' THEN 'quote_expired'
      ELSE 'quote_not_yet_valid' END);

  WHEN unique_violation THEN
    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    -- The block above rolled back, its telemetry included: the losing
    -- attempt's evidence is written HERE, where it commits (mirrors
    -- the create RPC's handler).
    IF v_constraint IN ('quote_acceptances_jti_key', 'quote_acceptances_token_digest_key') THEN
      SELECT * INTO v_accept FROM quote_acceptances
        WHERE jti = p_jti OR token_digest = p_token_digest
        ORDER BY (token_digest = p_token_digest) DESC LIMIT 1;
      IF FOUND AND v_accept.auth_user_id = p_auth_user_id
               AND v_accept.customer_id = p_customer_id
               AND v_accept.purpose = 'edit'
               AND v_accept.booking_id = p_booking_id THEN
        IF v_accept.token_digest = p_token_digest THEN
          SELECT details_version INTO v_current_details_version
            FROM bookings WHERE id = v_accept.booking_id;
          INSERT INTO quote_verifications (verdict, mode, purpose, jti, token_digest, booking_id, identity_hash)
            VALUES ('replay_idempotent', v_mode, 'edit', p_jti, p_token_digest, v_accept.booking_id, v_idhash);
          RETURN jsonb_build_object('outcome', 'idempotent',
            'booking_id', v_accept.booking_id,
            'details_version', v_current_details_version);
        END IF;
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
          VALUES ('quote_consumed', v_mode, 'edit', p_jti, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'quote_consumed', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN FOUND AND v_accept.auth_user_id = p_auth_user_id
                    AND v_accept.customer_id = p_customer_id
                  THEN 'replay_context_mismatch'
                  ELSE 'replay_identity_mismatch'
                END, v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    ELSIF v_constraint = 'operation_receipts_operation_request_id_key' THEN
      SELECT * INTO v_receipt FROM operation_receipts
        WHERE operation_request_id = p_operation_request_id;
      IF FOUND AND v_receipt.auth_user_id = p_auth_user_id
               AND v_receipt.customer_id = p_customer_id
               AND v_receipt.kind = 'edit_quoted'
               AND v_receipt.booking_id = p_booking_id
               AND v_receipt.request_digest = p_request_digest THEN
        SELECT details_version INTO v_current_details_version
          FROM bookings WHERE id = v_receipt.booking_id;
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_receipt.booking_id, 'details_version', v_current_details_version);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES (CASE
                  WHEN FOUND AND (v_receipt.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_receipt.customer_id IS DISTINCT FROM p_customer_id)
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
    RAISE;
  END;
END $$;

-- ------------------------------------------------------------
-- Self-verification (017 discipline): raise = whole transaction aborts.
-- ------------------------------------------------------------
DO $r1_verify$
DECLARE
  v_def TEXT;
  v_row RECORD;
BEGIN
  -- One function per name IN public — namespace-qualified, so a same-named
  -- function in another schema can neither satisfy nor confuse this.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'accept_quote_create') <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'accept_quote_edit') <> 1 THEN
    RAISE EXCEPTION 'R1: overload detected — replacement must not add a signature';
  END IF;

  FOR v_row IN SELECT * FROM r1_pre_state LOOP
    -- CREATE OR REPLACE preserves oid, owner and ACL; verify rather than trust.
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid = v_row.oid AND n.nspname = 'public'
        AND p.proname = v_row.proname
        AND p.proowner = v_row.proowner
        AND p.proacl IS NOT DISTINCT FROM v_row.proacl
    ) THEN
      RAISE EXCEPTION 'R1: identity/owner/ACL drifted for % during replacement', v_row.proname;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_row.oid) THEN
      RAISE EXCEPTION 'R1: SECURITY DEFINER was lost on %', v_row.proname;
    END IF;
    -- Exact-config comparison, not a some-search_path-exists scan: the
    -- replacement must reproduce the canonical proconfig byte-for-byte, so
    -- a body whose SET search_path silently dropped `extensions` aborts.
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE oid = v_row.oid
        AND proconfig IS NOT DISTINCT FROM v_row.proconfig
    ) OR v_row.proconfig IS NULL
      OR array_to_string(v_row.proconfig, ',') NOT LIKE '%search_path%' THEN
      RAISE EXCEPTION 'R1: SET search_path/config drifted on %', v_row.proname;
    END IF;
    -- The role privilege ceiling, verified BEHAVIORALLY, not by text: this is
    -- the check whose absence let an executed mutant commit 018 after
    -- revoking service_role EXECUTE (Codex round 1).
    IF NOT has_function_privilege('service_role', v_row.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'R1: service_role lost EXECUTE on %', v_row.proname;
    END IF;
    IF has_function_privilege('anon', v_row.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'R1: client role gained EXECUTE on %', v_row.proname;
    END IF;

    v_def := pg_get_functiondef(v_row.oid);
    IF v_def LIKE '%verified'' AND v_duration_minutes IS NULL%' THEN
      RAISE EXCEPTION 'R1: the verified-duration requirement is still present in %', v_row.proname;
    END IF;
    -- The bodies legitimately INSPECT routeQuality while validating the
    -- token schema (plan R1: transient inspection is permitted). What must
    -- never exist is the PROJECTION PAIR that would persist it.
    IF v_def LIKE '%''routeQuality'', p_payload%' THEN
      RAISE EXCEPTION 'R1: routeQuality reached the persisted projection in %', v_row.proname;
    END IF;
    -- Discriminating anchor: the allowlist must be built exactly where the
    -- acceptance insert's VALUES slot is — an unrelated jsonb_build_object
    -- elsewhere in the body cannot satisfy this (Codex round-1 mutant).
    IF v_def NOT LIKE '%v_passengers,%jsonb_build_object(%''commitment'', p_payload%' THEN
      RAISE EXCEPTION 'R1: the fail-closed projection allowlist is missing from the acceptance insert in %', v_row.proname;
    END IF;
  END LOOP;

  SELECT pg_get_functiondef(oid) INTO v_def
    FROM r1_pre_state WHERE proname = 'accept_quote_create';
  IF v_def NOT LIKE '%NULL::INTEGER%' THEN
    RAISE EXCEPTION 'R1: the create insert still persists a duration';
  END IF;
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM r1_pre_state WHERE proname = 'accept_quote_edit';
  IF v_def NOT LIKE '%duration_minutes = NULL%' THEN
    RAISE EXCEPTION 'R1: the edit update still persists a duration';
  END IF;
END;
$r1_verify$;

-- ------------------------------------------------------------
-- ROLLBACK-CONTAINED BEHAVIORAL SMOKE (017 discipline, sentinel ZZ018):
-- proves with real writes that create and edit persist NULL duration, that
-- the verified acceptance stores EXACTLY the allowlisted projection keys and
-- rejects routeQuality from storage (EXACTLY 15 keys on create, 17 on edit),
-- and leaves ZERO row residue. Every mutation happens inside a nested block
-- force-rolled-back by the sentinel; row counts are proven unchanged.
-- Sequence values consumed by the smoke are DELIBERATELY not rewound — a
-- setval races concurrent inserts and is global/non-transactional; gaps are
-- harmless and accepted.
-- ------------------------------------------------------------
DO $r1_smoke$
DECLARE
  v_bookings_before BIGINT;
  v_customers_before BIGINT;
  v_accept_before BIGINT;
  v_verify_before BIGINT;
  v_receipts_before BIGINT;
  v_customer_a UUID;
  v_customer_b UUID;
  v_auth_a UUID := gen_random_uuid();
  v_auth_b UUID := gen_random_uuid();
  v_booking_a UUID;
  v_booking_b UUID;
  v_op_create UUID := gen_random_uuid();
  v_op_edit UUID := gen_random_uuid();
  v_op_quote UUID := gen_random_uuid();
  v_jti UUID := gen_random_uuid();
  v_jti_edit UUID := gen_random_uuid();
  v_op_vedit UUID := gen_random_uuid();
  v_req4 TEXT;
  v_tok_digest_edit TEXT;
  -- Digests are DERIVED from this run's random ids: fixed literals would
  -- trip the token-digest replay branch against any committed acceptance
  -- that happened to share them (found by the executed chain test).
  v_tok_digest TEXT;
  v_req1 TEXT;
  v_req2 TEXT;
  v_req3 TEXT;
  v_now_ms BIGINT;
  v_pickup_at TIMESTAMPTZ;
  v_payload JSONB;
  v_booking_json JSONB;
  v_result JSONB;
  v_projection JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pricing_state WHERE singleton AND mode = 'off'
  ) THEN
    RAISE EXCEPTION 'R1 smoke requires pricing mode ''off'' — runbook STOP applies';
  END IF;

  SELECT count(*) INTO v_bookings_before FROM bookings;
  SELECT count(*) INTO v_customers_before FROM customers;
  SELECT count(*) INTO v_accept_before FROM quote_acceptances;
  SELECT count(*) INTO v_verify_before FROM quote_verifications;
  SELECT count(*) INTO v_receipts_before FROM operation_receipts;

  BEGIN
    v_tok_digest := encode(extensions.digest(v_jti::text || ':tok', 'sha256'), 'hex');
    v_req1 := encode(extensions.digest(v_op_create::text, 'sha256'), 'hex');
    v_req2 := encode(extensions.digest(v_op_edit::text, 'sha256'), 'hex');
    v_req3 := encode(extensions.digest(v_op_quote::text, 'sha256'), 'hex');
    v_req4 := encode(extensions.digest(v_op_vedit::text, 'sha256'), 'hex');
    v_tok_digest_edit := encode(extensions.digest(v_jti_edit::text || ':tok', 'sha256'), 'hex');
    v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
    v_pickup_at := to_timestamp((v_now_ms + 86400000) / 1000.0);

    INSERT INTO customers (name, phone, email, type, source)
      VALUES ('MIGRATION-018-R1-SMOKE-A','0000000018','r1smoke-a@example.invalid','guest','website')
      RETURNING id INTO v_customer_a;
    INSERT INTO customers (name, phone, email, type, source)
      VALUES ('MIGRATION-018-R1-SMOKE-B','0000000018','r1smoke-b@example.invalid','guest','website')
      RETURNING id INTO v_customer_b;

    -- 1. no-token create SUBMITTING a duration: stored row must hold NULL.
    v_booking_json := jsonb_build_object(
      'trip_id','MIG018-R1-LEGACY','customer_name','MIGRATION-018-R1-SMOKE-A',
      'customer_phone','0000000018','pickup_location','r1-smoke-origin',
      'dropoff_location','r1-smoke-destination','pickup_datetime',v_pickup_at::TEXT,
      'passengers',1,'bags',0,'vehicle_type','sedan','vehicle_name','Tesla Model Y',
      'booking_mode','dropoff','source','website','duration_minutes',777
    );
    v_result := accept_quote_create(
      v_auth_a, v_customer_a, v_op_create, v_req1,
      'no_token', NULL, NULL, NULL, 40.00, NULL, NULL, NULL, v_booking_json
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'created' THEN
      RAISE EXCEPTION 'R1 smoke: no-token create failed: %', v_result;
    END IF;
    v_booking_a := (v_result->>'booking_id')::UUID;
    IF EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_a AND duration_minutes IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'R1 smoke: create persisted a duration';
    END IF;

    -- 2. no-token edit SUBMITTING a duration: still NULL, other fields land.
    v_result := accept_quote_edit(
      v_auth_a, v_customer_a, v_op_edit, v_req2,
      v_booking_a, 1, 'no_token', NULL, NULL, NULL, 41.00, NULL, NULL, NULL,
      jsonb_build_object('duration_minutes',89,'notes','r1-smoke-edit')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated'
       OR (v_result->>'details_version')::INTEGER IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'R1 smoke: no-token edit failed: %', v_result;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_a
        AND duration_minutes IS NULL AND notes = 'r1-smoke-edit'
    ) THEN
      RAISE EXCEPTION 'R1 smoke: edit persisted a duration or dropped its edit';
    END IF;

    -- 3. VERIFIED create in mode off: consumed + recorded; the projection is
    -- exactly the fifteen allowlisted keys and never routeQuality; the
    -- booking row still refuses the duration.
    v_payload := jsonb_build_object(
      'v',2,'kid','migration-018-smoke','jti',v_jti::text,
      'purpose','create','authUserId',v_auth_b::text,
      'customerId',v_customer_b::text,'vehicle','tesla',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('a',64),
      'routeQuality','traffic_aware','finalCents',5678,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 1000,'exp',v_now_ms + 899000
    );
    v_result := accept_quote_create(
      v_auth_b, v_customer_b, v_op_quote, v_req3, 'verified',
      v_jti, v_tok_digest, v_payload, 56.78,
      'r1-smoke-place-id', 'MIA', 'tesla',
      v_booking_json || jsonb_build_object(
        'trip_id','MIG018-R1-QUOTE','customer_name','MIGRATION-018-R1-SMOKE-B',
        'airport_code','MIA','duration_minutes',555)
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'created' THEN
      RAISE EXCEPTION 'R1 smoke: verified off-mode create failed: %', v_result;
    END IF;
    v_booking_b := (v_result->>'booking_id')::UUID;
    IF EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_b AND duration_minutes IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'R1 smoke: verified create persisted a duration';
    END IF;
    SELECT payload_projection INTO v_projection
      FROM quote_acceptances WHERE jti = v_jti;
    IF v_projection IS NULL THEN
      RAISE EXCEPTION 'R1 smoke: verified acceptance was not recorded';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v_projection)) <> 15
       OR NOT (v_projection ?& ARRAY[
         'v','kid','jti','purpose','authUserId','customerId','vehicle',
         'pickupAtMs','commitment','finalCents','pricingVersion',
         'engineVersion','resolvedVersion','iat','exp'])
       OR v_projection ? 'routeQuality' THEN
      RAISE EXCEPTION 'R1 smoke: acceptance projection is not the exact allowlist: %',
        (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_projection) k);
    END IF;

    -- 4. VERIFIED EDIT in mode off: the edit projection must be EXACTLY the
    -- seventeen allowlisted keys (create's fifteen plus bookingId and
    -- assignmentEpoch) and never routeQuality; the row still refuses the
    -- duration a stale client submits.
    v_payload := jsonb_build_object(
      'v',2,'kid','migration-018-smoke','jti',v_jti_edit::text,
      'purpose','edit','authUserId',v_auth_b::text,
      'customerId',v_customer_b::text,'bookingId',v_booking_b::text,
      'assignmentEpoch',0,'vehicle','tesla',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('b',64),
      'routeQuality','traffic_aware','finalCents',6789,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 1000,'exp',v_now_ms + 899000
    );
    v_result := accept_quote_edit(
      v_auth_b, v_customer_b, v_op_vedit, v_req4,
      v_booking_b, 1, 'verified', v_jti_edit, v_tok_digest_edit,
      v_payload, 57.89, 'r1-smoke-place-id', 'MIA', 'tesla',
      jsonb_build_object('pickup_datetime', v_pickup_at::TEXT,
                         'duration_minutes', 91, 'notes', 'r1-smoke-vedit')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated' THEN
      RAISE EXCEPTION 'R1 smoke: verified off-mode edit failed: %', v_result;
    END IF;
    IF EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_b AND duration_minutes IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'R1 smoke: verified edit persisted a duration';
    END IF;
    SELECT payload_projection INTO v_projection
      FROM quote_acceptances WHERE jti = v_jti_edit;
    IF v_projection IS NULL THEN
      RAISE EXCEPTION 'R1 smoke: verified edit acceptance was not recorded';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(v_projection)) <> 17
       OR NOT (v_projection ?& ARRAY[
         'v','kid','jti','purpose','authUserId','customerId','bookingId',
         'assignmentEpoch','vehicle','pickupAtMs','commitment','finalCents',
         'pricingVersion','engineVersion','resolvedVersion','iat','exp'])
       OR v_projection ? 'routeQuality' THEN
      RAISE EXCEPTION 'R1 smoke: EDIT acceptance projection is not the exact allowlist: %',
        (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_projection) k);
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'ZZ018', MESSAGE = 'MIGRATION_018_R1_SMOKE_ROLLBACK';
  EXCEPTION WHEN SQLSTATE 'ZZ018' THEN
    IF SQLERRM <> 'MIGRATION_018_R1_SMOKE_ROLLBACK' THEN RAISE; END IF;
  END;

  -- DELIBERATELY NO sequence restore (round-2 P1): sequence changes are
  -- global and non-transactional, and a setval back to a snapshot races any
  -- concurrent insert that took the next value — the rewound sequence would
  -- then re-issue it and break the identity PK. The smoke may consume a few
  -- quote_verifications sequence values without rows; gaps are harmless and
  -- accepted. Row residue below remains a hard zero.
  IF (SELECT count(*) FROM bookings) <> v_bookings_before
     OR (SELECT count(*) FROM customers) <> v_customers_before
     OR (SELECT count(*) FROM quote_acceptances) <> v_accept_before
     OR (SELECT count(*) FROM quote_verifications) <> v_verify_before
     OR (SELECT count(*) FROM operation_receipts) <> v_receipts_before THEN
    RAISE EXCEPTION 'R1 smoke residue: rollback-contained smoke changed row counts';
  END IF;
END;
$r1_smoke$;

COMMIT;
