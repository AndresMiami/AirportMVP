-- ============================================================
-- Migration 017 — Quote enforcement foundation (PR 3C-2C-A)
-- ============================================================
-- Run manually in the Supabase SQL editor. Atomic: one transaction,
-- self-verifying, aborts loudly rather than guessing. "Success. No
-- rows returned" = pass; any red ERROR = the transaction rolled back
-- and nothing changed.
--
-- NOTE ON NUMBERING: CLAUDE.md reserved 017 for 3C-3's revision
-- history; per plan v5 that reservation renumbers (the 014 header
-- records the same precedent).
--
-- What this migration is, honestly: the DATABASE half of "no LinkMia
-- endpoint may accept a price invented or modified by the browser."
-- It is EXPAND-SAFE (plan v5 C8): every writer that exists today —
-- create-booking's direct insert, update-pending-booking's direct
-- update, manual SQL in this editor — keeps working, and a
-- compatibility trigger derives the new columns for them. Nothing
-- passenger-facing changes when this runs. Enforcement is a MODE
-- (pricing_state) that starts at 'off' and moves only through the
-- guarded transition function.
--
-- Contents:
--   1. bookings: price_cents + price_authority (+ backfill, NOT NULL,
--      equality CHECK), multi_booking_exempt (frozen actor class),
--      active_slot (+ partial unique index — the one-nonterminal rule
--      becomes a constraint, ambassadors exempt), assignment_epoch
--      (driver-era counter for edit tokens), canonical route identity
--      (canonical_place_id, airport_code, route_authority).
--   2. pricing_state singleton + append-only audit + guarded
--      transition function (off -> observe -> enforce; after enforce,
--      only blocked <-> enforce — the one-way valve is a constraint).
--   3. bookings_guard trigger: mode fence (FOR SHARE on the
--      singleton), column population for legacy writers, post-high-
--      water protection of ride-intent columns, DB-maintained slot /
--      exemption / epoch.
--   4. quote_acceptances (successful consumptions ONLY, jti UNIQUE,
--      token digest — never the raw token), quote_verifications
--      (sanitized attempt telemetry), operation_receipts (universal
--      request idempotency).
--   5. RPCs accept_quote_create / accept_quote_edit — the ONE atomic
--      writer for every mode (plan v5 C7), constraint-name branching,
--      identity-gated idempotency and disclosure.
--   6. Default-deny grants (010 lockdown pattern) + self-verification.
-- ============================================================

BEGIN;

-- digest() needs pgcrypto. On Supabase it is pre-installed in the
-- `extensions` schema, so the CREATE below is usually a no-op that
-- does NOT place it in `public` — which is why every SECURITY DEFINER
-- function here pins `search_path = public, extensions, pg_temp` and
-- why self-verification PROVES digest() resolves under that exact
-- path. Without that, the migration would commit clean and every RPC
-- call would die at runtime with "function digest(...) does not exist".
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 0. Pre-flight: this migration refuses to guess.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_null_price INTEGER;
  v_dupes INTEGER;
BEGIN
  -- price becomes NOT NULL below; a NULL-price row needs human
  -- adjudication, not a fabricated zero (cancel-core's own rule).
  SELECT count(*) INTO v_null_price FROM bookings WHERE price IS NULL;
  IF v_null_price > 0 THEN
    RAISE EXCEPTION '017 pre-flight: % booking rows have NULL price — adjudicate them before running (SELECT id, trip_id, status FROM bookings WHERE price IS NULL)', v_null_price;
  END IF;

  -- The partial unique index below makes "one nonterminal booking per
  -- non-ambassador customer" a constraint. Existing duplicates would
  -- make it unbuildable — surface them for adjudication instead of
  -- failing mid-DDL. Ambassador-held rows are exempt by the same rule
  -- the index uses (an ACTIVE hosts row on the booking's customer).
  SELECT count(*) INTO v_dupes FROM (
    SELECT b.customer_id
    FROM bookings b
    WHERE b.status IN ('pending','confirmed','on_the_way','arrived','in_progress')
      AND b.customer_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM customers c JOIN hosts h ON h.user_id = c.user_id
        WHERE c.id = b.customer_id AND h.status = 'active'
      )
    GROUP BY b.customer_id
    HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION '017 pre-flight: % non-ambassador customers hold multiple nonterminal bookings — adjudicate before running', v_dupes;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. bookings columns
-- ------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS price_authority TEXT,
  ADD COLUMN IF NOT EXISTS multi_booking_exempt BOOLEAN,
  ADD COLUMN IF NOT EXISTS active_slot UUID,
  ADD COLUMN IF NOT EXISTS assignment_epoch INTEGER,
  ADD COLUMN IF NOT EXISTS canonical_place_id TEXT,
  ADD COLUMN IF NOT EXISTS airport_code TEXT,
  ADD COLUMN IF NOT EXISTS route_authority TEXT;

-- Backfill. Authority 'backfill' names the provenance honestly: these
-- cents are derived from the historical client-supplied price, not
-- from any server quote.
UPDATE bookings SET
  price_cents = round(price * 100)::INTEGER,
  price_authority = 'backfill'
WHERE price_cents IS NULL;

-- Frozen actor class (plan v5 C9): derived ONCE from the ambassador
-- relationship as it stands at migration time for historical rows, and
-- at INSERT time (by trigger) for new rows. Host deactivation later
-- must not retroactively collide an ambassador's rides; activation
-- later must not free a normal passenger's slot.
-- RECORDED DEVIATION from C9's letter: the plan asked for an embedded,
-- human-approved frozen mapping; with 110 rows and 2 hosts this
-- migration substitutes automated current-status derivation plus the
-- pre-flight duplicate abort above. A currently-deactivated FORMER
-- host holding multiple nonterminal rows aborts loudly; one holding at
-- most one row is classed non-exempt without review. Also: the guard
-- trigger PINS the exemption on update (silently preserves it) rather
-- than raising, which is functionally the refusal C9 asked for.
UPDATE bookings b SET multi_booking_exempt = EXISTS (
  SELECT 1 FROM customers c JOIN hosts h ON h.user_id = c.user_id
  WHERE c.id = b.customer_id AND h.status = 'active'
)
WHERE multi_booking_exempt IS NULL;

-- active_slot: customer_id while the ride is nonterminal and the actor
-- is not exempt; NULL otherwise. NULL never collides in a unique
-- index, which is exactly how ambassadors stay multi-ride.
UPDATE bookings SET active_slot = CASE
  WHEN status IN ('pending','confirmed','on_the_way','arrived','in_progress')
       AND NOT multi_booking_exempt
  THEN customer_id
  ELSE NULL
END
WHERE active_slot IS DISTINCT FROM (CASE
  WHEN status IN ('pending','confirmed','on_the_way','arrived','in_progress')
       AND NOT multi_booking_exempt
  THEN customer_id ELSE NULL END);

UPDATE bookings SET assignment_epoch = 0 WHERE assignment_epoch IS NULL;
UPDATE bookings SET route_authority = 'legacy_text' WHERE route_authority IS NULL;

ALTER TABLE bookings
  ALTER COLUMN price SET NOT NULL,
  ALTER COLUMN price_cents SET NOT NULL,
  ALTER COLUMN price_authority SET NOT NULL,
  ALTER COLUMN multi_booking_exempt SET NOT NULL,
  ALTER COLUMN assignment_epoch SET NOT NULL,
  ALTER COLUMN route_authority SET NOT NULL;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_price_authority_check CHECK
    (price_authority IN ('backfill','client_legacy','client_observe','server_quote')),
  ADD CONSTRAINT bookings_route_authority_check CHECK
    (route_authority IN ('legacy_text','canonical')),
  -- Canonical route identity is all-or-nothing: a 'canonical' row must
  -- carry both ids; a legacy row carries neither claim.
  ADD CONSTRAINT bookings_route_identity_check CHECK
    (route_authority <> 'canonical' OR
     (canonical_place_id IS NOT NULL AND airport_code IS NOT NULL)),
  -- The dual-truth drift guard. Both columns are NOT NULL after this
  -- migration, so unlike the vacuous-NULL variant this CHECK binds
  -- every row. round() returns numeric; the cast makes the comparison
  -- exact integer-to-integer.
  ADD CONSTRAINT bookings_price_cents_equal_check CHECK
    (round(price * 100)::INTEGER = price_cents),
  ADD CONSTRAINT bookings_assignment_epoch_check CHECK (assignment_epoch >= 0);

-- The one-nonterminal rule as a CONSTRAINT (plan v5 C9 / v2 §3): binds
-- every writer including manual SQL — an advisory lock or RPC check
-- binds only cooperating callers and is NOT the mechanism of record.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_per_customer
  ON bookings (active_slot) WHERE active_slot IS NOT NULL;

-- ------------------------------------------------------------
-- 2. pricing_state — the mode, its audit, and the one-way valve
-- ------------------------------------------------------------

CREATE TABLE pricing_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL DEFAULT 'off'
    CHECK (mode IN ('off','observe','enforce','blocked')),
  enforcement_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO pricing_state (singleton, mode) VALUES (TRUE, 'off');

CREATE TABLE pricing_state_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor TEXT NOT NULL,
  from_mode TEXT NOT NULL,
  to_mode TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ordinary DML on the singleton and its audit is refused; the ONLY
-- mutation path is the SECURITY DEFINER transition function below,
-- which marks its transaction with a local GUC the guard checks.
-- Honest claim (plan v5 C10): guarded against ordinary DML, not
-- against a database OWNER with DDL authority — an owner can disable
-- triggers and is outside the application threat boundary.
CREATE OR REPLACE FUNCTION pricing_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('linkmia.pricing_state_writer', TRUE) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'pricing_state is mutated only through set_pricing_mode()';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pricing_state_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON pricing_state
  FOR EACH ROW EXECUTE FUNCTION pricing_state_guard();
CREATE TRIGGER pricing_state_audit_guard_trg
  BEFORE UPDATE OR DELETE ON pricing_state_audit
  FOR EACH ROW EXECUTE FUNCTION pricing_state_guard();

CREATE OR REPLACE FUNCTION set_pricing_mode(p_mode TEXT, p_actor TEXT)
RETURNS TABLE (mode TEXT, enforcement_started_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_state pricing_state%ROWTYPE;
BEGIN
  IF p_mode NOT IN ('off','observe','enforce','blocked') THEN
    RAISE EXCEPTION 'unknown pricing mode %', p_mode;
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'set_pricing_mode requires an actor';
  END IF;

  SELECT * INTO v_state FROM pricing_state WHERE singleton FOR UPDATE;

  -- THE ONE-WAY VALVE: once enforcement has ever started, the only
  -- reachable modes are 'enforce' and 'blocked'. Returning to client-
  -- priced writes ('observe'/'off') is rejected BY THE DATABASE —
  -- breaking the RPC must never become a way to reopen browser-price
  -- trust (plan v4 C3 / v5 C10).
  IF v_state.enforcement_started_at IS NOT NULL
     AND p_mode IN ('off','observe') THEN
    RAISE EXCEPTION 'enforcement high-water mark is set (%): mode may only move between enforce and blocked', v_state.enforcement_started_at;
  END IF;

  PERFORM set_config('linkmia.pricing_state_writer', 'on', TRUE);
  INSERT INTO pricing_state_audit (actor, from_mode, to_mode)
    VALUES (p_actor, v_state.mode, p_mode);
  UPDATE pricing_state SET
    mode = p_mode,
    enforcement_started_at = CASE
      WHEN p_mode = 'enforce' AND pricing_state.enforcement_started_at IS NULL THEN now()
      ELSE pricing_state.enforcement_started_at END,
    updated_at = now()
  WHERE singleton;
  PERFORM set_config('linkmia.pricing_state_writer', 'off', TRUE);

  RETURN QUERY SELECT ps.mode, ps.enforcement_started_at FROM pricing_state ps WHERE ps.singleton;
END $$;

-- ------------------------------------------------------------
-- 3. bookings_guard — the compatibility + protection trigger
-- ------------------------------------------------------------
-- One BEFORE trigger, deliberately, so the ordering of its concerns is
-- explicit rather than spread across trigger alphabetical order:
--   a. mode fence: FOR SHARE on the singleton — a mode transition and
--      a booking write serialize against each other, so no client-
--      priced write can commit on a stale mode read (plan v5 C8).
--   b. immutable columns: customer_id and the frozen exemption never
--      change; direct writes to slot/epoch/authority are refused.
--   c. population: a legacy writer that knows nothing of the new
--      columns gets them derived; an RPC write (marked by a
--      transaction-local GUC only the SECURITY DEFINER functions set)
--      passes its explicit, verified values through.
--   d. post-high-water fence: once enforcement has started, client-
--      authority price/intent mutations are refused. Unrelated status,
--      cancellation, release, checkpoint, and contact updates on an
--      existing row still pass (IS DISTINCT FROM comparisons).
--   e. maintenance: active_slot recomputed; assignment_epoch bumped
--      exactly when assigned_driver changes (plan v5 C13).

CREATE OR REPLACE FUNCTION bookings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_mode TEXT;
  v_high_water TIMESTAMPTZ;
  v_rpc BOOLEAN := current_setting('linkmia.rpc_writer', TRUE) = 'on';
BEGIN
  -- a. mode fence
  SELECT ps.mode, ps.enforcement_started_at INTO v_mode, v_high_water
    FROM pricing_state ps WHERE ps.singleton FOR SHARE;
  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'pricing_state singleton missing';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_mode = 'blocked' THEN
      RAISE EXCEPTION 'bookings are temporarily blocked (pricing_state=blocked)';
    END IF;

    -- b/c. frozen actor class: DB-derived, caller input ignored.
    NEW.multi_booking_exempt := EXISTS (
      SELECT 1 FROM customers c JOIN hosts h ON h.user_id = c.user_id
      WHERE c.id = NEW.customer_id AND h.status = 'active'
    );
    NEW.assignment_epoch := 0;

    IF v_rpc THEN
      -- The RPC supplies price/price_cents/authority explicitly and
      -- the pair must already agree (the table CHECK re-verifies).
      IF NEW.price_authority IS NULL OR
         NEW.price_authority NOT IN ('client_observe','server_quote') THEN
        RAISE EXCEPTION 'RPC insert must carry an approved price authority';
      END IF;
    ELSE
      -- Legacy writer: derive, and never allow a self-declared
      -- server authority.
      IF NEW.price IS NULL THEN
        RAISE EXCEPTION 'a booking requires a price';
      END IF;
      NEW.price_cents := round(NEW.price * 100)::INTEGER;
      NEW.price_authority := 'client_legacy';
      NEW.canonical_place_id := NULL;
      NEW.airport_code := NULL;
      NEW.route_authority := 'legacy_text';
      -- Post-high-water, client-priced INSERTs are refused outright:
      -- every legitimate writer is the RPC by then (plan v5 C8).
      IF v_high_water IS NOT NULL THEN
        RAISE EXCEPTION 'client-priced booking writes are closed after enforcement (use the accept_quote RPCs)';
      END IF;
    END IF;

  ELSE  -- UPDATE
    -- b. immutable columns, every mode, every writer.
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
      RAISE EXCEPTION 'bookings.customer_id is immutable';
    END IF;
    NEW.multi_booking_exempt := OLD.multi_booking_exempt;

    -- e. assignment era: exactly the transitions that change the
    -- assigned driver are new eras; direct epoch writes are refused.
    IF NEW.assigned_driver IS DISTINCT FROM OLD.assigned_driver THEN
      NEW.assignment_epoch := OLD.assignment_epoch + 1;
    ELSIF NEW.assignment_epoch IS DISTINCT FROM OLD.assignment_epoch THEN
      RAISE EXCEPTION 'assignment_epoch is maintained by the database';
    END IF;

    IF v_rpc THEN
      IF NEW.price_authority IS NULL OR
         NEW.price_authority NOT IN ('client_observe','server_quote') THEN
        RAISE EXCEPTION 'RPC update must carry an approved price authority';
      END IF;
    ELSE
      -- Legacy price coherence: a writer that changes price without
      -- coherently changing cents gets both derived.
      IF NEW.price IS DISTINCT FROM OLD.price THEN
        NEW.price_cents := round(NEW.price * 100)::INTEGER;
        NEW.price_authority := 'client_legacy';
      ELSIF NEW.price_cents IS DISTINCT FROM OLD.price_cents
         OR NEW.price_authority IS DISTINCT FROM OLD.price_authority THEN
        RAISE EXCEPTION 'price_cents/price_authority are maintained by the database';
      END IF;
      -- Route identity is RPC-only territory.
      IF NEW.canonical_place_id IS DISTINCT FROM OLD.canonical_place_id
         OR NEW.airport_code IS DISTINCT FROM OLD.airport_code
         OR NEW.route_authority IS DISTINCT FROM OLD.route_authority THEN
        RAISE EXCEPTION 'canonical route identity is maintained by the accept_quote RPCs';
      END IF;

      -- d. post-high-water fence over the protected intent columns.
      IF v_high_water IS NOT NULL AND (
           NEW.price IS DISTINCT FROM OLD.price
        OR NEW.pickup_location IS DISTINCT FROM OLD.pickup_location
        OR NEW.dropoff_location IS DISTINCT FROM OLD.dropoff_location
        OR NEW.pickup_datetime IS DISTINCT FROM OLD.pickup_datetime
        OR NEW.vehicle_type IS DISTINCT FROM OLD.vehicle_type
        OR NEW.vehicle_name IS DISTINCT FROM OLD.vehicle_name
        OR NEW.passengers IS DISTINCT FROM OLD.passengers
        OR NEW.bags IS DISTINCT FROM OLD.bags
        OR NEW.booking_mode IS DISTINCT FROM OLD.booking_mode
        OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
      ) THEN
        RAISE EXCEPTION 'ride-intent columns are closed to direct writes after enforcement (use the accept_quote RPCs)';
      END IF;
    END IF;
  END IF;

  -- e. active_slot: ALWAYS recomputed — caller input is irrelevant, so
  -- a legacy writer, the RPC, and manual SQL are all equally bound by
  -- the unique index (plan v5 C9: NULL must not be able to bypass it).
  NEW.active_slot := CASE
    WHEN NEW.status IN ('pending','confirmed','on_the_way','arrived','in_progress')
         AND NOT NEW.multi_booking_exempt
    THEN NEW.customer_id
    ELSE NULL
  END;

  RETURN NEW;
END $$;

CREATE TRIGGER bookings_guard_trg
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_guard();

-- ------------------------------------------------------------
-- 4. Quote tables
-- ------------------------------------------------------------

-- Successful consumptions ONLY (plan v4 §7 as corrected by v5 C7): a
-- row here means a booking exists against this quote. Rejections and
-- observations live in quote_verifications and NEVER consume a jti.
-- The RAW TOKEN IS NEVER STORED — it is a live bearer credential until
-- exp. The digest carries the audit identity (canonical bytes: one
-- token = one string = one digest) with zero credential value.
CREATE TABLE quote_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jti UUID NOT NULL UNIQUE,
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('create','edit')),
  auth_user_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  kid TEXT NOT NULL,
  vehicle_key TEXT NOT NULL,
  final_cents INTEGER NOT NULL CHECK (final_cents >= 0),
  client_cents INTEGER,          -- observe mode: what was actually charged
  authority TEXT NOT NULL CHECK (authority IN ('client_observe','server_quote')),
  pricing_version TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  resolved_version TEXT NOT NULL,
  canonical_place_id TEXT NOT NULL,
  airport_code TEXT NOT NULL,
  booking_mode TEXT NOT NULL,
  pickup_at TIMESTAMPTZ NOT NULL,
  passengers INTEGER NOT NULL,
  payload_projection JSONB NOT NULL,   -- the full VERIFIED projection
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sanitized attempt telemetry: the observe ledger and the post-
-- enforcement rejection monitor. jti/digest are recorded ONLY when the
-- signature verified (plan v2 §7a: an unverified jti must never touch
-- any keyed lookup). Identities are hashed — this table is evidence of
-- traffic shape, not a person registry. Short retention is operational
-- policy: prune with
--   DELETE FROM quote_verifications WHERE created_at < now() - interval '90 days';
CREATE TABLE quote_verifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verdict TEXT NOT NULL CHECK (verdict IN (
    'active_conflict',
    'verified','no_token','verify_failed','expired','not_yet_valid',
    'replay_idempotent','would_quote_consumed','quote_consumed',
    'replay_identity_mismatch','rejected_no_token','rejected_invalid',
    'blocked','no_request_id'
  )),
  mode TEXT NOT NULL,
  purpose TEXT,
  jti UUID,                       -- only when signature verified
  token_digest TEXT CHECK (token_digest IS NULL OR token_digest ~ '^[0-9a-f]{64}$'),
                                  -- only when signature verified
  booking_id UUID,                -- when a booking exists (observe writes)
  identity_hash TEXT NOT NULL,    -- sha256(auth_user_id), never the id
  client_cents INTEGER,
  server_cents INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Universal request idempotency (plan v5 C7/C11): one random id per
-- user action, reused verbatim on every retry of that action. Same id
-- + same identities + same request digest = the stored result; any
-- mismatch = generic conflict. Independent of quote jti, which is why
-- no-token observe traffic is idempotent too.
CREATE TABLE operation_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_request_id UUID NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('create','edit_optional','edit_quoted')),
  auth_user_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  details_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quote_verifications_created_idx ON quote_verifications (created_at);

-- ------------------------------------------------------------
-- 5. The atomic writers
-- ------------------------------------------------------------
-- Endpoints (service role) verify tokens in Node — signature, schema,
-- identity, keyed commitment — and hand the RPC the VERIFIED
-- projection plus their verdict. The RPC owns everything transactional:
-- the mode read (share-locked), operation idempotency, jti consumption
-- with constraint-name branching, the booking write (through
-- bookings_guard, marked as an RPC write), the receipt, and the
-- telemetry row. One transaction; a failure rolls back all of it.
--
-- Identity gates (plan v4 C5 / v5 C11): every idempotent return and
-- every disclosure of an existing booking id happens ONLY after the
-- SERVER-authenticated identities match the stored row. The values
-- compared come from the endpoint's authentication of THIS request,
-- never from the presented token.

CREATE OR REPLACE FUNCTION accept_quote_create(
  p_auth_user_id UUID,
  p_customer_id UUID,
  p_operation_request_id UUID,
  p_request_digest TEXT,
  p_verdict TEXT,               -- 'verified' | 'no_token' | 'verify_failed'
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
  v_idhash TEXT := encode(digest(p_auth_user_id::text, 'sha256'), 'hex');
  v_constraint TEXT;
BEGIN
  IF p_operation_request_id IS NULL OR p_request_digest IS NULL THEN
    RAISE EXCEPTION 'operation_request_id and request_digest are required';
  END IF;
  IF p_verdict IS NULL OR p_verdict NOT IN ('verified','no_token','verify_failed') THEN
    RAISE EXCEPTION 'unknown verdict %', COALESCE(p_verdict, 'NULL');
  END IF;
  IF p_verdict = 'verified' AND (p_jti IS NULL OR p_token_digest IS NULL
      OR p_payload IS NULL OR p_canonical_place_id IS NULL) THEN
    RAISE EXCEPTION 'a verified consumption requires jti, digest, payload, and the canonical place id';
  END IF;

  -- Mode, share-locked for the whole transaction (plan v5 C7/C8).
  SELECT ps.mode, ps.enforcement_started_at INTO v_mode, v_high_water
    FROM pricing_state ps WHERE ps.singleton FOR SHARE;
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
  SELECT * INTO v_receipt FROM operation_receipts
    WHERE operation_request_id = p_operation_request_id;
  IF FOUND THEN
    IF v_receipt.auth_user_id = p_auth_user_id
       AND v_receipt.customer_id = p_customer_id
       AND v_receipt.request_digest = p_request_digest THEN
      RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_receipt.booking_id);
    END IF;
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('replay_identity_mismatch', v_mode, 'create', v_idhash);
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  IF v_mode = 'blocked' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('blocked', v_mode, 'create', v_idhash);
    RETURN jsonb_build_object('outcome', 'blocked');
  END IF;

  -- Exact-digest token retry (plan v5 C11 Path A): even expired, even
  -- after key retirement — identity-gated.
  IF p_token_digest IS NOT NULL THEN
    SELECT * INTO v_accept FROM quote_acceptances WHERE token_digest = p_token_digest;
    IF FOUND THEN
      IF v_accept.auth_user_id = p_auth_user_id AND v_accept.customer_id = p_customer_id THEN
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, token_digest, booking_id, identity_hash)
          VALUES ('replay_idempotent', v_mode, 'create', v_accept.jti, p_token_digest, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('replay_identity_mismatch', v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;

  -- Sibling-token check (same quote, different vehicle token).
  IF p_jti IS NOT NULL THEN
    SELECT * INTO v_accept FROM quote_acceptances WHERE jti = p_jti;
    IF FOUND THEN
      IF v_accept.auth_user_id = p_auth_user_id AND v_accept.customer_id = p_customer_id THEN
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
          VALUES (CASE WHEN v_mode = 'enforce' THEN 'quote_consumed' ELSE 'would_quote_consumed' END,
                  v_mode, 'create', p_jti, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'quote_consumed', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('replay_identity_mismatch', v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;

  -- Enforcement: no unverified write, ever.
  IF v_mode = 'enforce' AND p_verdict <> 'verified' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES (CASE WHEN p_verdict = 'no_token' THEN 'rejected_no_token' ELSE 'rejected_invalid' END,
              v_mode, 'create', v_idhash);
    RETURN jsonb_build_object('outcome',
      CASE WHEN p_verdict = 'no_token' THEN 'quote_required' ELSE 'quote_invalid' END);
  END IF;

  -- Authority (plan v5 C7 matrix).
  IF v_mode = 'enforce' THEN
    v_cents := (p_payload->>'finalCents')::INTEGER;
    v_price := v_cents / 100.0;
    v_authority := 'server_quote';
  ELSE
    IF p_client_price IS NULL THEN
      RAISE EXCEPTION 'off/observe modes require the client price';
    END IF;
    v_price := round(p_client_price * 100) / 100.0;
    v_cents := round(p_client_price * 100)::INTEGER;
    -- 'off' mode reaches this RPC only after 2C-B routes every mode
    -- through it; a client_legacy stamp there would claim the trigger
    -- derived it. client_observe is the honest RPC-written label for
    -- both, and the mode column in telemetry preserves the distinction.
    v_authority := 'client_observe';
  END IF;

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
      (p_booking->>'pickup_datetime')::TIMESTAMPTZ,
      COALESCE((p_booking->>'passengers')::INTEGER, 1),
      COALESCE((p_booking->>'bags')::INTEGER, 0),
      p_booking->>'vehicle_type', p_booking->>'vehicle_name',
      v_price, v_cents, v_authority,
      CASE WHEN p_verdict = 'verified' THEN p_canonical_place_id ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN p_booking->>'airport_code' ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN 'canonical' ELSE 'legacy_text' END,
      p_booking->>'booking_mode', COALESCE(p_booking->>'payment_status','unpaid'),
      COALESCE(p_booking->>'payment_method','cash'),
      p_booking->>'flight_number', p_booking->>'notes',
      p_booking->>'pickup_sign', p_booking->>'promo_code',
      NULLIF(p_booking->>'referred_by_host','')::UUID,
      NULLIF(p_booking->>'host_commission','')::NUMERIC,
      NULLIF(p_booking->>'duration_minutes','')::INTEGER,
      'pending', COALESCE(p_booking->>'source','website')
    ) RETURNING id INTO v_booking_id;

    IF p_verdict = 'verified' THEN
      INSERT INTO quote_acceptances (
        jti, token_digest, booking_id, purpose, auth_user_id, customer_id,
        kid, vehicle_key, final_cents, client_cents, authority,
        pricing_version, engine_version, resolved_version,
        canonical_place_id, airport_code, booking_mode, pickup_at, passengers,
        payload_projection
      ) VALUES (
        p_jti, p_token_digest, v_booking_id, 'create', p_auth_user_id, p_customer_id,
        p_payload->>'kid', p_payload->>'vehicle', (p_payload->>'finalCents')::INTEGER,
        CASE WHEN v_mode <> 'enforce' THEN v_cents ELSE NULL END,
        v_authority,
        p_payload->>'pricingVersion', p_payload->>'engineVersion', p_payload->>'resolvedVersion',
        p_canonical_place_id, p_booking->>'airport_code',
        p_booking->>'booking_mode',
        to_timestamp(((p_payload->>'pickupAtMs')::BIGINT) / 1000.0),
        COALESCE((p_booking->>'passengers')::INTEGER, 1),
        p_payload
      );
    END IF;

    INSERT INTO operation_receipts (
      operation_request_id, kind, auth_user_id, customer_id,
      request_digest, booking_id
    ) VALUES (
      p_operation_request_id, 'create', p_auth_user_id, p_customer_id,
      p_request_digest, v_booking_id
    );

    -- Stored jti/digest are VERIFIED-ONLY (the table's contract): an
    -- unverifiable token's digest is used for the Path-A lookup above
    -- but never persisted as evidence.
    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, booking_id, identity_hash,
      client_cents, server_cents
    ) VALUES (
      CASE WHEN p_verdict = 'verified' THEN 'verified' ELSE p_verdict END,
      v_mode, 'create',
      CASE WHEN p_verdict = 'verified' THEN p_jti ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN p_token_digest ELSE NULL END,
      v_booking_id, v_idhash,
      CASE WHEN p_client_price IS NOT NULL THEN round(p_client_price * 100)::INTEGER ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN (p_payload->>'finalCents')::INTEGER ELSE NULL END
    );

    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    RETURN jsonb_build_object('outcome', 'created', 'booking_id', v_booking_id,
                              'authority', v_authority);

  EXCEPTION WHEN unique_violation THEN
    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    -- Constraint-name branching is mandatory (plan v2 §3): with several
    -- unique constraints live, a bare handler would misread one race
    -- as another. NOTE: everything inside the block above — including
    -- its telemetry rows — rolled back with the subtransaction, so the
    -- LOSING attempt's evidence is written HERE, where it commits.
    IF v_constraint = 'bookings_one_active_per_customer' THEN
      SELECT id INTO v_booking_id FROM bookings
        WHERE active_slot = p_customer_id;
      INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
        VALUES ('active_conflict', v_mode, 'create', p_jti, v_booking_id, v_idhash);
      RETURN jsonb_build_object('outcome', 'active_exists', 'booking_id', v_booking_id);
    ELSIF v_constraint IN ('quote_acceptances_jti_key', 'quote_acceptances_token_digest_key') THEN
      -- Lost the consumption race: re-classify under the identity gate.
      SELECT * INTO v_accept FROM quote_acceptances WHERE jti = p_jti;
      IF FOUND AND v_accept.auth_user_id = p_auth_user_id
               AND v_accept.customer_id = p_customer_id THEN
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
        VALUES ('replay_identity_mismatch', v_mode, 'create', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    ELSIF v_constraint = 'operation_receipts_operation_request_id_key' THEN
      SELECT * INTO v_receipt FROM operation_receipts
        WHERE operation_request_id = p_operation_request_id;
      IF FOUND AND v_receipt.auth_user_id = p_auth_user_id
               AND v_receipt.customer_id = p_customer_id
               AND v_receipt.request_digest = p_request_digest THEN
        RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_receipt.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('replay_identity_mismatch', v_mode, 'create', v_idhash);
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
  p_verdict TEXT,
  p_jti UUID,
  p_token_digest TEXT,
  p_payload JSONB,
  p_client_price NUMERIC,
  p_canonical_place_id TEXT,    -- the commitment-verified canonical id (NULL unless verified)
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
  v_idhash TEXT := encode(digest(p_auth_user_id::text, 'sha256'), 'hex');
  v_constraint TEXT;
BEGIN
  IF p_operation_request_id IS NULL OR p_request_digest IS NULL THEN
    RAISE EXCEPTION 'operation_request_id and request_digest are required';
  END IF;

  IF p_verdict IS NULL OR p_verdict NOT IN ('verified','no_token','verify_failed') THEN
    RAISE EXCEPTION 'unknown verdict %', COALESCE(p_verdict, 'NULL');
  END IF;
  IF p_verdict = 'verified' AND (p_jti IS NULL OR p_token_digest IS NULL
      OR p_payload IS NULL OR p_canonical_place_id IS NULL) THEN
    RAISE EXCEPTION 'a verified consumption requires jti, digest, payload, and the canonical place id';
  END IF;

  SELECT ps.mode, ps.enforcement_started_at INTO v_mode, v_high_water
    FROM pricing_state ps WHERE ps.singleton FOR SHARE;
  -- Impossible-state fence (plan v5 C10): the valve makes these modes
  -- unreachable after the high-water mark; if we ever see one anyway,
  -- something bypassed the valve — refuse rather than write.
  IF v_high_water IS NOT NULL AND v_mode IN ('off','observe') THEN
    RAISE EXCEPTION 'impossible pricing state: mode % after enforcement began', v_mode;
  END IF;
  -- Universal idempotency FIRST — even before the blocked gate (see
  -- the create RPC's note; same rule, same reason).
  SELECT * INTO v_receipt FROM operation_receipts
    WHERE operation_request_id = p_operation_request_id;
  IF FOUND THEN
    IF v_receipt.auth_user_id = p_auth_user_id
       AND v_receipt.customer_id = p_customer_id
       AND v_receipt.request_digest = p_request_digest THEN
      RETURN jsonb_build_object('outcome', 'idempotent',
        'booking_id', v_receipt.booking_id, 'details_version', v_receipt.details_version);
    END IF;
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('replay_identity_mismatch', v_mode, 'edit', v_idhash);
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  IF v_mode = 'blocked' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES ('blocked', v_mode, 'edit', v_idhash);
    RETURN jsonb_build_object('outcome', 'blocked');
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
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, token_digest, booking_id, identity_hash)
          VALUES ('replay_idempotent', v_mode, 'edit', v_accept.jti, p_token_digest, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('replay_identity_mismatch', v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;
  IF p_jti IS NOT NULL THEN
    SELECT * INTO v_accept FROM quote_acceptances WHERE jti = p_jti;
    IF FOUND THEN
      IF v_accept.auth_user_id = p_auth_user_id AND v_accept.customer_id = p_customer_id THEN
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
          VALUES (CASE WHEN v_mode = 'enforce' THEN 'quote_consumed' ELSE 'would_quote_consumed' END,
                  v_mode, 'edit', p_jti, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'quote_consumed', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('replay_identity_mismatch', v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    END IF;
  END IF;

  -- A quoted ride-details edit is the only edit this RPC performs;
  -- optional-only patches stay in the endpoint (they touch no
  -- protected column, so the guard passes them in every mode).
  IF v_mode = 'enforce' AND p_verdict <> 'verified' THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
      VALUES (CASE WHEN p_verdict = 'no_token' THEN 'rejected_no_token' ELSE 'rejected_invalid' END,
              v_mode, 'edit', v_idhash);
    RETURN jsonb_build_object('outcome',
      CASE WHEN p_verdict = 'no_token' THEN 'quote_required' ELSE 'quote_invalid' END);
  END IF;

  -- The guarded row read: ownership, status, CAS, and ERA all checked
  -- against live truth under lock.
  SELECT * INTO v_row FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR v_row.customer_id IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_row.status <> 'pending' OR v_row.assigned_driver IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'not_editable', 'status', v_row.status);
  END IF;
  IF v_row.details_version IS DISTINCT FROM p_expected_details_version THEN
    RETURN jsonb_build_object('outcome', 'version_conflict',
      'details_version', v_row.details_version);
  END IF;
  IF p_verdict = 'verified' THEN
    -- Edit tokens bind bookingId + assignmentEpoch (plan v5 C12/C13):
    -- a token issued before an Accept/Release era cannot apply after.
    IF (p_payload->>'bookingId')::UUID IS DISTINCT FROM p_booking_id THEN
      RETURN jsonb_build_object('outcome', 'quote_mismatch');
    END IF;
    IF (p_payload->>'assignmentEpoch')::INTEGER IS DISTINCT FROM v_row.assignment_epoch THEN
      RETURN jsonb_build_object('outcome', 'epoch_conflict');
    END IF;
  END IF;

  IF v_mode = 'enforce' THEN
    v_cents := (p_payload->>'finalCents')::INTEGER;
    v_price := v_cents / 100.0;
    v_authority := 'server_quote';
  ELSE
    IF p_client_price IS NULL THEN
      RAISE EXCEPTION 'off/observe modes require the client price';
    END IF;
    v_price := round(p_client_price * 100) / 100.0;
    v_cents := round(p_client_price * 100)::INTEGER;
    v_authority := 'client_observe';
  END IF;

  PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);
  BEGIN
    UPDATE bookings SET
      pickup_location = COALESCE(p_edit->>'pickup_location', pickup_location),
      dropoff_location = COALESCE(p_edit->>'dropoff_location', dropoff_location),
      pickup_datetime = COALESCE((p_edit->>'pickup_datetime')::TIMESTAMPTZ, pickup_datetime),
      passengers = COALESCE((p_edit->>'passengers')::INTEGER, passengers),
      bags = COALESCE((p_edit->>'bags')::INTEGER, bags),
      vehicle_type = COALESCE(p_edit->>'vehicle_type', vehicle_type),
      vehicle_name = COALESCE(p_edit->>'vehicle_name', vehicle_name),
      booking_mode = COALESCE(p_edit->>'booking_mode', booking_mode),
      duration_minutes = COALESCE((p_edit->>'duration_minutes')::INTEGER, duration_minutes),
      flight_number = p_edit->>'flight_number',
      notes = p_edit->>'notes',
      pickup_sign = p_edit->>'pickup_sign',
      promo_code = p_edit->>'promo_code',
      host_commission = NULLIF(p_edit->>'host_commission','')::NUMERIC,
      price = v_price,
      price_cents = v_cents,
      price_authority = v_authority,
      canonical_place_id = CASE WHEN p_verdict = 'verified'
        THEN p_canonical_place_id ELSE canonical_place_id END,
      airport_code = CASE WHEN p_verdict = 'verified'
        THEN p_edit->>'airport_code' ELSE airport_code END,
      route_authority = CASE WHEN p_verdict = 'verified'
        THEN 'canonical' ELSE route_authority END,
      details_version = details_version + 1,
      updated_at = now()
    WHERE id = p_booking_id;

    IF p_verdict = 'verified' THEN
      INSERT INTO quote_acceptances (
        jti, token_digest, booking_id, purpose, auth_user_id, customer_id,
        kid, vehicle_key, final_cents, client_cents, authority,
        pricing_version, engine_version, resolved_version,
        canonical_place_id, airport_code, booking_mode, pickup_at, passengers,
        payload_projection
      ) VALUES (
        p_jti, p_token_digest, p_booking_id, 'edit', p_auth_user_id, p_customer_id,
        p_payload->>'kid', p_payload->>'vehicle', (p_payload->>'finalCents')::INTEGER,
        CASE WHEN v_mode <> 'enforce' THEN v_cents ELSE NULL END,
        v_authority,
        p_payload->>'pricingVersion', p_payload->>'engineVersion', p_payload->>'resolvedVersion',
        p_canonical_place_id, p_edit->>'airport_code',
        COALESCE(p_edit->>'booking_mode', v_row.booking_mode),
        to_timestamp(((p_payload->>'pickupAtMs')::BIGINT) / 1000.0),
        COALESCE((p_edit->>'passengers')::INTEGER, v_row.passengers),
        p_payload
      );
    END IF;

    INSERT INTO operation_receipts (
      operation_request_id, kind, auth_user_id, customer_id,
      request_digest, booking_id, details_version
    ) VALUES (
      p_operation_request_id, 'edit_quoted', p_auth_user_id, p_customer_id,
      p_request_digest, p_booking_id, v_row.details_version + 1
    );

    INSERT INTO quote_verifications (
      verdict, mode, purpose, jti, token_digest, booking_id, identity_hash,
      client_cents, server_cents
    ) VALUES (
      CASE WHEN p_verdict = 'verified' THEN 'verified' ELSE p_verdict END,
      v_mode, 'edit',
      CASE WHEN p_verdict = 'verified' THEN p_jti ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN p_token_digest ELSE NULL END,
      p_booking_id, v_idhash,
      CASE WHEN p_client_price IS NOT NULL THEN round(p_client_price * 100)::INTEGER ELSE NULL END,
      CASE WHEN p_verdict = 'verified' THEN (p_payload->>'finalCents')::INTEGER ELSE NULL END
    );

    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    RETURN jsonb_build_object('outcome', 'updated', 'booking_id', p_booking_id,
      'details_version', v_row.details_version + 1, 'authority', v_authority);

  EXCEPTION WHEN unique_violation THEN
    PERFORM set_config('linkmia.rpc_writer', 'off', TRUE);
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    -- The block above rolled back, its telemetry included: the losing
    -- attempt's evidence is written HERE, where it commits (mirrors
    -- the create RPC's handler).
    IF v_constraint IN ('quote_acceptances_jti_key', 'quote_acceptances_token_digest_key') THEN
      SELECT * INTO v_accept FROM quote_acceptances WHERE jti = p_jti;
      IF FOUND AND v_accept.auth_user_id = p_auth_user_id
               AND v_accept.customer_id = p_customer_id THEN
        IF v_accept.token_digest = p_token_digest THEN
          INSERT INTO quote_verifications (verdict, mode, purpose, jti, token_digest, booking_id, identity_hash)
            VALUES ('replay_idempotent', v_mode, 'edit', p_jti, p_token_digest, v_accept.booking_id, v_idhash);
          RETURN jsonb_build_object('outcome', 'idempotent', 'booking_id', v_accept.booking_id);
        END IF;
        INSERT INTO quote_verifications (verdict, mode, purpose, jti, booking_id, identity_hash)
          VALUES ('quote_consumed', v_mode, 'edit', p_jti, v_accept.booking_id, v_idhash);
        RETURN jsonb_build_object('outcome', 'quote_consumed', 'booking_id', v_accept.booking_id);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('replay_identity_mismatch', v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'refused');
    ELSIF v_constraint = 'operation_receipts_operation_request_id_key' THEN
      SELECT * INTO v_receipt FROM operation_receipts
        WHERE operation_request_id = p_operation_request_id;
      IF FOUND AND v_receipt.auth_user_id = p_auth_user_id
               AND v_receipt.customer_id = p_customer_id
               AND v_receipt.request_digest = p_request_digest THEN
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_receipt.booking_id, 'details_version', v_receipt.details_version);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('replay_identity_mismatch', v_mode, 'edit', v_idhash);
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
    RAISE;
  END;
END $$;

-- ------------------------------------------------------------
-- 6. Grants — 010 lockdown pattern: default deny, service-only.
-- ------------------------------------------------------------

REVOKE ALL ON pricing_state, pricing_state_audit,
  quote_acceptances, quote_verifications, operation_receipts
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION set_pricing_mode(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION accept_quote_create(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION accept_quote_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- The service role is the ONLY caller (016 precedent: REVOKE from
-- clients is defense-in-depth; the explicit service_role GRANT is what
-- makes the endpoints work at all — without it, db.rpc() answers
-- permission denied). The REVOKE from service_role FIRST makes the
-- narrow grants the REAL ceiling: 010 stripped creator defaults only
-- for PUBLIC/anon/authenticated, so without this, service_role would
-- inherit ALL on the new tables and the grants below would be
-- decorative. The RPCs run as owner and are unaffected.
REVOKE ALL ON pricing_state, pricing_state_audit,
  quote_acceptances, quote_verifications, operation_receipts
  FROM service_role;
GRANT EXECUTE ON FUNCTION set_pricing_mode(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION accept_quote_create(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION accept_quote_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, JSONB) TO service_role;
GRANT SELECT ON pricing_state, pricing_state_audit,
  quote_acceptances, quote_verifications, operation_receipts TO service_role;
-- Endpoint-side writes the plan assigns OUTSIDE the RPCs: pre-RPC
-- refusal telemetry ('expired'/'not_yet_valid'/'no_request_id' are
-- endpoint verdicts) and — in 2C-B — the optional-only edit receipt
-- (kind 'edit_optional' has no RPC; that two-step gap vs C7's
-- same-transaction rule is recorded as a 2C-B design point).
GRANT INSERT ON quote_verifications TO service_role;
GRANT INSERT ON operation_receipts TO service_role;
-- NOTE: the two GUC markers (linkmia.pricing_state_writer,
-- linkmia.rpc_writer) are transaction-local COORDINATION flags that
-- distinguish deliberate code paths; any session can set a GUC, so
-- they are NOT privilege boundaries — the grants above and the
-- SECURITY DEFINER ownership are.

ALTER TABLE pricing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_state_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_receipts ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 7. Self-verification — the migration proves itself or rolls back.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_count INTEGER;
  v_mode TEXT;
BEGIN
  SELECT count(*) INTO v_count FROM bookings
    WHERE price_cents IS NULL OR price_authority IS NULL
       OR multi_booking_exempt IS NULL OR assignment_epoch IS NULL
       OR route_authority IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION '017 self-check: % rows escaped backfill', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM bookings
    WHERE round(price * 100)::INTEGER <> price_cents;
  IF v_count > 0 THEN
    RAISE EXCEPTION '017 self-check: % rows have price/cents drift', v_count;
  END IF;

  SELECT mode INTO v_mode FROM pricing_state WHERE singleton;
  IF v_mode <> 'off' THEN
    RAISE EXCEPTION '017 self-check: pricing_state must start at off, found %', v_mode;
  END IF;

  -- The valve must exist and refuse: probe it in a nested block.
  BEGIN
    UPDATE pricing_state SET mode = 'enforce' WHERE singleton;
    RAISE EXCEPTION '017 self-check: direct pricing_state UPDATE was not refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%set_pricing_mode%' THEN RAISE; END IF;
  END;

  -- digest() must resolve under the EXACT search_path the DEFINER
  -- functions pin — otherwise the migration commits clean and every
  -- RPC call dies at runtime (pgcrypto usually lives in `extensions`
  -- on Supabase, which plain `public` excludes).
  DECLARE v_probe TEXT;
  BEGIN
    -- Plain invoker function: Postgres refuses to EXECUTE a SECURITY
    -- DEFINER function living in pg_temp, and the probe only needs the
    -- SET clause (search-path resolution is identical either way).
    CREATE FUNCTION pg_temp.digest_path_probe() RETURNS TEXT
      LANGUAGE plpgsql SET search_path = public, extensions, pg_temp
      AS 'BEGIN RETURN encode(digest(''probe'', ''sha256''), ''hex''); END';
    SELECT pg_temp.digest_path_probe() INTO v_probe;
    IF v_probe IS NULL OR length(v_probe) <> 64 THEN
      RAISE EXCEPTION '017 self-check: digest() probe returned garbage';
    END IF;
  EXCEPTION WHEN undefined_function THEN
    RAISE EXCEPTION '017 self-check: digest() does not resolve under search_path public,extensions — locate pgcrypto before running (SELECT extnamespace::regnamespace FROM pg_extension WHERE extname = ''pgcrypto'')';
  END;

  -- The grants must be the real ceiling.
  IF NOT has_function_privilege('service_role',
      'accept_quote_create(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, JSONB)', 'EXECUTE') THEN
    RAISE EXCEPTION '017 self-check: service_role cannot execute accept_quote_create';
  END IF;
  IF has_table_privilege('service_role', 'quote_acceptances', 'INSERT')
     OR has_table_privilege('service_role', 'pricing_state', 'UPDATE')
     OR has_table_privilege('anon', 'quote_acceptances', 'SELECT')
     OR has_table_privilege('authenticated', 'operation_receipts', 'SELECT') THEN
    RAISE EXCEPTION '017 self-check: table privileges exceed the intended ceiling';
  END IF;

  -- active_slot integrity: every nonterminal non-exempt row occupies
  -- its slot; everything else is NULL.
  SELECT count(*) INTO v_count FROM bookings
    WHERE (status IN ('pending','confirmed','on_the_way','arrived','in_progress')
           AND NOT multi_booking_exempt AND active_slot IS DISTINCT FROM customer_id)
       OR ((status NOT IN ('pending','confirmed','on_the_way','arrived','in_progress')
            OR multi_booking_exempt) AND active_slot IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION '017 self-check: % rows have an inconsistent active_slot', v_count;
  END IF;
END $$;

COMMIT;
