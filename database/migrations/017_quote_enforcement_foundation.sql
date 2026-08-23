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
--      token digest — never the raw token; a verified token is consumed
--      in off/observe/enforce so one quote can never multiply bookings),
--      quote_verifications
--      (sanitized attempt telemetry), operation_receipts (universal
--      request idempotency).
--   5. RPCs accept_quote_create / accept_quote_edit /
--      accept_optional_edit — the ONE atomic
--      writer for every mode (plan v5 C7), constraint-name branching,
--      identity-gated idempotency and disclosure.
--   6. Default-deny grants (010 lockdown pattern) + self-verification.
-- ============================================================

BEGIN;

-- Freeze every relation that defines the reviewed historical actor set before
-- checking the manifest. Under READ COMMITTED, a check without these locks
-- could pass and then see a newly committed booking/host link during backfill,
-- silently defaulting that actor to non-exempt. NOWAIT makes the rollout abort
-- rather than wait behind live traffic or enter a lock-order deadlock; run 017
-- only in the documented brief maintenance window and retry from the beginning
-- if any relation is busy. The transaction already needs an ACCESS EXCLUSIVE
-- bookings lock for ALTER TABLE, so taking the complete set up front also
-- avoids a later lock upgrade.
LOCK TABLE public.bookings, public.customers, public.hosts
  IN ACCESS EXCLUSIVE MODE NOWAIT;

-- pgcrypto is shared platform infrastructure, not owned by migration 017.
-- Require Supabase's existing copy in the trusted `extensions` schema rather
-- than installing something this migration's rollback cannot safely remove.
-- Every call below is schema-qualified, so a public.digest lookalike can never
-- shadow the cryptographic primitive inside a SECURITY DEFINER RPC.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto' AND n.nspname = 'extensions'
  ) OR to_regprocedure('extensions.digest(text,text)') IS NULL THEN
    RAISE EXCEPTION '017 pre-flight: pgcrypto digest(text,text) must already exist in schema extensions';
  END IF;
END $$;

-- HISTORICAL ACTOR DECISIONS (load-bearing rollout input).
--
-- This TEMP table is the reviewed, literal decision set for every customer
-- who BOTH has at least one historical booking and is linked (through
-- customers.user_id) to ANY hosts row, regardless of that host's CURRENT
-- status. Current host status is not historical truth, so the migration must
-- never infer the frozen exemption from it. Before production execution,
-- replace the commented example with the exact customer UUIDs and Andres's
-- reviewed decision for each candidate. The exact-set pre-flight below aborts
-- if a candidate is missing or an unrelated customer was added.
CREATE TEMP TABLE migration_017_ambassador_decisions (
  customer_id UUID PRIMARY KEY,
  multi_booking_exempt BOOLEAN NOT NULL
) ON COMMIT DROP;
-- INSERT INTO migration_017_ambassador_decisions
--   (customer_id, multi_booking_exempt)
-- VALUES
--   ('00000000-0000-0000-0000-000000000000', TRUE); -- REVIEWED EXAMPLE ONLY

-- ------------------------------------------------------------
-- 0. Pre-flight: this migration refuses to guess.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_null_price INTEGER;
  v_unsafe_price INTEGER;
  v_dupes INTEGER;
  v_actor_missing INTEGER;
  v_actor_extra INTEGER;
BEGIN
  -- price becomes NOT NULL below; a NULL-price row needs human
  -- adjudication, not a fabricated zero (cancel-core's own rule).
  SELECT count(*) INTO v_null_price FROM bookings WHERE price IS NULL;
  IF v_null_price > 0 THEN
    RAISE EXCEPTION '017 pre-flight: % booking rows have NULL price — adjudicate them before running (SELECT id, trip_id, status FROM bookings WHERE price IS NULL)', v_null_price;
  END IF;

  SELECT count(*) INTO v_unsafe_price
  FROM bookings
  WHERE price::text IN ('NaN','Infinity','-Infinity')
     OR price < 0
     OR price > 21474836.47;
  IF v_unsafe_price > 0 THEN
    RAISE EXCEPTION '017 pre-flight: % booking rows have negative, non-finite, or INTEGER-cents-unrepresentable prices — adjudicate them before running', v_unsafe_price;
  END IF;

  -- Historical ambassador status is a HUMAN decision, not a current-status
  -- lookup. The literal table above must match the exact historical candidate
  -- set: every booked customer whose auth identity appears in ANY hosts row.
  SELECT count(*) INTO v_actor_missing
  FROM (
    SELECT DISTINCT b.customer_id
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    JOIN hosts h ON h.user_id = c.user_id
    WHERE b.customer_id IS NOT NULL
    EXCEPT
    SELECT customer_id FROM migration_017_ambassador_decisions
  ) missing;

  SELECT count(*) INTO v_actor_extra
  FROM (
    SELECT customer_id FROM migration_017_ambassador_decisions
    EXCEPT
    SELECT DISTINCT b.customer_id
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    JOIN hosts h ON h.user_id = c.user_id
    WHERE b.customer_id IS NOT NULL
  ) extra;

  IF v_actor_missing > 0 OR v_actor_extra > 0 THEN
    RAISE EXCEPTION '017 pre-flight: historical ambassador decision set is not exact (missing %, extra %). Review: SELECT DISTINCT b.customer_id, c.user_id, h.id AS host_id, h.status FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN hosts h ON h.user_id=c.user_id ORDER BY b.customer_id',
      v_actor_missing, v_actor_extra;
  END IF;

  -- The partial unique index below makes "one nonterminal booking per
  -- non-ambassador customer" a constraint. Existing duplicates would make it
  -- unbuildable. The decision table is authoritative for historical rows;
  -- every non-candidate defaults to non-exempt. Legacy `assigned` is still a
  -- nonterminal status and must occupy a slot too.
  SELECT count(*) INTO v_dupes FROM (
    SELECT b.customer_id
    FROM bookings b
    LEFT JOIN migration_017_ambassador_decisions d ON d.customer_id = b.customer_id
    WHERE b.status IN ('pending','confirmed','assigned','on_the_way','arrived','in_progress')
      AND b.customer_id IS NOT NULL
      AND NOT COALESCE(d.multi_booking_exempt, FALSE)
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
-- The existing updated_at trigger is deliberately suspended for the
-- deterministic backfill: adding pricing metadata must not make every
-- historical ride look freshly edited.
ALTER TABLE bookings DISABLE TRIGGER update_bookings_updated_at;

UPDATE bookings SET
  price_cents = round(price * 100)::INTEGER,
  price_authority = 'backfill'
WHERE price_cents IS NULL;

-- Frozen actor class (plan v5 C9): historical rows use the literal reviewed
-- decision table above. Non-candidates default false. New rows are classified
-- once by the insert trigger from the actor's then-current active host record.
-- Later host activation/deactivation never rewrites an existing booking.
UPDATE bookings b SET multi_booking_exempt = COALESCE((
  SELECT d.multi_booking_exempt
  FROM migration_017_ambassador_decisions d
  WHERE d.customer_id = b.customer_id
), FALSE)
WHERE multi_booking_exempt IS NULL;

-- active_slot: customer_id while the ride is nonterminal and the actor
-- is not exempt; NULL otherwise. NULL never collides in a unique
-- index, which is exactly how ambassadors stay multi-ride.
UPDATE bookings SET active_slot = CASE
  WHEN status IN ('pending','confirmed','assigned','on_the_way','arrived','in_progress')
       AND NOT multi_booking_exempt
  THEN customer_id
  ELSE NULL
END
WHERE active_slot IS DISTINCT FROM (CASE
  WHEN status IN ('pending','confirmed','assigned','on_the_way','arrived','in_progress')
       AND NOT multi_booking_exempt
  THEN customer_id ELSE NULL END);

UPDATE bookings SET assignment_epoch = 0 WHERE assignment_epoch IS NULL;
UPDATE bookings SET route_authority = 'legacy_text' WHERE route_authority IS NULL;

ALTER TABLE bookings ENABLE TRIGGER update_bookings_updated_at;

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
  -- Canonical route identity is exact and closed: legacy rows carry neither
  -- claim; canonical rows carry a nonblank Place identity plus one airport
  -- from the quote service's pinned registry.
  ADD CONSTRAINT bookings_route_identity_check CHECK
    ((route_authority = 'legacy_text'
       AND canonical_place_id IS NULL AND airport_code IS NULL)
     OR
     (route_authority = 'canonical'
       AND NULLIF(btrim(canonical_place_id), '') IS NOT NULL
       AND airport_code IN ('MIA','FLL','PBI'))),
  -- The dual-truth drift guard. Both columns are NOT NULL after this
  -- migration, so unlike the vacuous-NULL variant this CHECK binds
  -- every row. round() returns numeric; the cast makes the comparison
  -- exact integer-to-integer.
  ADD CONSTRAINT bookings_price_cents_equal_check CHECK
    (round(price * 100)::INTEGER = price_cents),
  ADD CONSTRAINT bookings_price_nonnegative_check CHECK
    (price >= 0 AND price <= 21474836.47 AND price_cents >= 0),
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
  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pricing_state_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON pricing_state
  FOR EACH ROW EXECUTE FUNCTION pricing_state_guard();
CREATE TRIGGER pricing_state_truncate_guard_trg
  BEFORE TRUNCATE ON pricing_state
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_state_guard();
CREATE TRIGGER pricing_state_audit_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON pricing_state_audit
  FOR EACH ROW EXECUTE FUNCTION pricing_state_guard();
CREATE TRIGGER pricing_state_audit_truncate_guard_trg
  BEFORE TRUNCATE ON pricing_state_audit
  FOR EACH STATEMENT EXECUTE FUNCTION pricing_state_guard();

CREATE OR REPLACE FUNCTION set_pricing_mode(p_mode TEXT, p_actor TEXT)
RETURNS TABLE (mode TEXT, enforcement_started_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_state pricing_state%ROWTYPE;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('off','observe','enforce','blocked') THEN
    RAISE EXCEPTION 'unknown pricing mode %', p_mode;
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'set_pricing_mode requires an actor';
  END IF;

  SELECT * INTO v_state FROM pricing_state WHERE singleton FOR UPDATE;

  -- Exact transition matrix. In particular, `off -> enforce` is impossible:
  -- the observe evidence gate cannot be skipped by a typo or an eager rollout.
  -- Once enforcement starts, the high-water valve permanently reduces the
  -- state machine to enforce <-> blocked (same-state calls are idempotent).
  IF NOT (
       (v_state.mode = 'off'     AND p_mode IN ('off','observe'))
    OR (v_state.mode = 'observe' AND p_mode IN ('off','observe','enforce'))
    OR (v_state.mode = 'enforce' AND p_mode IN ('enforce','blocked'))
    OR (v_state.mode = 'blocked' AND p_mode IN ('blocked','enforce'))
  ) THEN
    RAISE EXCEPTION 'invalid pricing mode transition % -> %', v_state.mode, p_mode;
  END IF;
  IF v_state.enforcement_started_at IS NOT NULL AND p_mode IN ('off','observe') THEN
    RAISE EXCEPTION 'enforcement high-water mark is set (%): mode may only move between enforce and blocked',
      v_state.enforcement_started_at;
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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

  -- Reject invalid money before any numeric-to-INTEGER cast. The table CHECK
  -- repeats this invariant; the trigger provides a stable, useful failure.
  IF NEW.price IS NULL
     OR NEW.price::text IN ('NaN','Infinity','-Infinity')
     OR NEW.price < 0
     OR NEW.price > 21474836.47 THEN
    RAISE EXCEPTION 'booking price must be finite, non-negative, and representable as INTEGER cents';
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
      IF NOT (
           (v_mode = 'off'     AND NEW.price_authority = 'client_legacy')
        OR (v_mode = 'observe' AND NEW.price_authority = 'client_observe')
        OR (v_mode = 'enforce' AND NEW.price_authority = 'server_quote')
      ) THEN
        RAISE EXCEPTION 'RPC insert price authority % is invalid in mode %',
          COALESCE(NEW.price_authority, 'NULL'), v_mode;
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
    IF NEW.multi_booking_exempt IS DISTINCT FROM OLD.multi_booking_exempt THEN
      RAISE EXCEPTION 'multi_booking_exempt is frozen at booking creation';
    END IF;

    -- e. assignment era: exactly the transitions that change the
    -- assigned driver are new eras; direct epoch writes are refused.
    IF NEW.assigned_driver IS DISTINCT FROM OLD.assigned_driver THEN
      NEW.assignment_epoch := OLD.assignment_epoch + 1;
    ELSIF NEW.assignment_epoch IS DISTINCT FROM OLD.assignment_epoch THEN
      RAISE EXCEPTION 'assignment_epoch is maintained by the database';
    END IF;

    IF v_rpc THEN
      IF NOT (
           (v_mode = 'off'     AND NEW.price_authority = 'client_legacy')
        OR (v_mode = 'observe' AND NEW.price_authority = 'client_observe')
        OR (v_mode = 'enforce' AND NEW.price_authority = 'server_quote')
      ) THEN
        RAISE EXCEPTION 'RPC update price authority % is invalid in mode %',
          COALESCE(NEW.price_authority, 'NULL'), v_mode;
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
      -- Before enforcement, legacy writers may still change route text.  A
      -- canonical identity describes the old route and must not survive that
      -- change.  Downgrade rather than making a claim the edit did not prove.
      IF NEW.pickup_location IS DISTINCT FROM OLD.pickup_location
         OR NEW.dropoff_location IS DISTINCT FROM OLD.dropoff_location
         OR NEW.booking_mode IS DISTINCT FROM OLD.booking_mode THEN
        NEW.canonical_place_id := NULL;
        NEW.airport_code := NULL;
        NEW.route_authority := 'legacy_text';
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
    WHEN NEW.status IN ('pending','confirmed','assigned','on_the_way','arrived','in_progress')
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
  authority TEXT NOT NULL CHECK (authority IN ('client_legacy','client_observe','server_quote')),
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
    'replay_identity_mismatch','replay_context_mismatch',
    'rejected_no_token','rejected_invalid',
    'blocked','no_request_id','edit_conflict'
  )),
  mode TEXT NOT NULL CHECK (mode IN ('off','observe','enforce','blocked')),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('create','edit')),
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
--
-- Recorded rollout decisions (2026-08-23 correction addendum):
--   * an authentic expired/not-yet-valid token cannot authorize a NEW write
--     in any mode; its exact-digest retry may still recover prior success;
--     the endpoint MUST pass such an authentic token as verdict `verified`
--     with its projection (never relabel it `verify_failed`) and 2C-B must
--     silently re-quote either stale outcome in every mode;
--   * the keyed commitment covers mode, airport, canonical place identity,
--     pickup instant, passengers, route miles in integer tenths, whole route
--     minutes, vehicle and cents. Node verifies those facts before this RPC;
--   * route distance is never persisted. `duration_minutes` temporarily keeps
--     the commitment-verified whole-minute ETA snapshot so existing passenger
--     and operator displays do not silently disappear before the Google
--     storage-policy review settles the long-term retention rule;
--   * off mode still stores client money, but a verified token is consumed and
--     recorded with authority client_legacy. Operation IDs remain optional in
--     off/observe and are mandatory (428/outdated_client) in enforce.

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
     OR (p_verdict = 'verified' AND v_duration_minutes IS NULL) THEN
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
      -- Whole-minute duration is already part of today's passenger and ops
      -- contract. Keep it until the Google storage review resolves its
      -- long-term retention; distance remains commitment-only and unstored.
      v_duration_minutes,
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
        p_payload
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
  v_duration_minutes := COALESCE(
    NULLIF(p_edit->>'duration_minutes','')::INTEGER, v_row.duration_minutes);
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
     OR (v_effective_verdict = 'verified' AND v_duration_minutes IS NULL)
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
      duration_minutes = v_duration_minutes,
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
        p_payload
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

-- Optional-only pending edits are atomic too. This RPC owns the booking CAS
-- and operation receipt in one transaction while refusing every field that
-- can affect route, capacity, price, assignment, payment, or lifecycle.
CREATE OR REPLACE FUNCTION accept_optional_edit(
  p_auth_user_id UUID,
  p_customer_id UUID,
  p_operation_request_id UUID,
  p_request_digest TEXT,
  p_booking_id UUID,
  p_expected_details_version INTEGER,
  p_patch JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_mode TEXT;
  v_high_water TIMESTAMPTZ;
  v_row bookings%ROWTYPE;
  v_receipt operation_receipts%ROWTYPE;
  v_has_request_id BOOLEAN;
  v_constraint TEXT;
  v_row_found BOOLEAN;
  v_idhash TEXT := encode(extensions.digest(p_auth_user_id::text, 'sha256'), 'hex');
  v_new_booker_name TEXT;
  v_new_booker_phone TEXT;
BEGIN
  IF p_auth_user_id IS NULL OR p_customer_id IS NULL OR p_booking_id IS NULL THEN
    RAISE EXCEPTION 'authenticated identities and booking_id are required';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'optional edit patch must be a JSON object';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_patch) AS k(key)
    WHERE k.key NOT IN (
      'customer_name','customer_phone','customer_email',
      'booker_name','booker_phone','flight_number','notes',
      'pickup_sign','promo_code'
    )
  ) THEN
    RAISE EXCEPTION 'optional edit contains a protected or unknown field';
  END IF;
  IF p_patch = '{}'::JSONB THEN
    RAISE EXCEPTION 'optional edit patch is empty';
  END IF;
  IF (p_operation_request_id IS NULL) <> (p_request_digest IS NULL) THEN
    RAISE EXCEPTION 'operation_request_id and request_digest must be supplied together';
  END IF;
  v_has_request_id := p_operation_request_id IS NOT NULL;
  IF p_request_digest IS NOT NULL AND p_request_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'request_digest must be lowercase SHA-256 hex';
  END IF;

  SELECT ps.mode, ps.enforcement_started_at INTO v_mode, v_high_water
    FROM pricing_state ps WHERE ps.singleton FOR SHARE;
  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'pricing_state singleton missing';
  END IF;
  IF v_high_water IS NOT NULL AND v_mode IN ('off','observe') THEN
    RAISE EXCEPTION 'impossible pricing state: mode % after enforcement began', v_mode;
  END IF;

  IF v_has_request_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_request_id::text, 17017));
    SELECT * INTO v_receipt FROM operation_receipts
      WHERE operation_request_id = p_operation_request_id;
    IF FOUND THEN
      IF v_receipt.auth_user_id = p_auth_user_id
         AND v_receipt.customer_id = p_customer_id
         AND v_receipt.kind = 'edit_optional'
         AND v_receipt.booking_id = p_booking_id
         AND v_receipt.request_digest = p_request_digest THEN
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_receipt.booking_id,
          'details_version', v_receipt.details_version);
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

  -- A pricing emergency blocks new and price-affecting operations, not
  -- contact/flight/note corrections. This optional-only path remains open and
  -- is still protected by ownership, status, CAS, receipt, and field allowlist.
  IF NOT v_has_request_id AND v_mode IN ('enforce','blocked') THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, booking_id, identity_hash)
      VALUES ('no_request_id', v_mode, 'edit', p_booking_id, v_idhash);
    RETURN jsonb_build_object('outcome', 'outdated_client');
  END IF;
  IF NOT v_has_request_id THEN
    INSERT INTO quote_verifications (verdict, mode, purpose, booking_id, identity_hash)
      VALUES ('no_request_id', v_mode, 'edit', p_booking_id, v_idhash);
  END IF;

  SELECT * INTO v_row FROM bookings WHERE id = p_booking_id FOR UPDATE;
  v_row_found := FOUND;
  IF v_has_request_id THEN
    SELECT * INTO v_receipt FROM operation_receipts
      WHERE operation_request_id = p_operation_request_id;
    IF FOUND THEN
      IF v_receipt.auth_user_id = p_auth_user_id
         AND v_receipt.customer_id = p_customer_id
         AND v_receipt.kind = 'edit_optional'
         AND v_receipt.booking_id = p_booking_id
         AND v_receipt.request_digest = p_request_digest THEN
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_receipt.booking_id,
          'details_version', v_receipt.details_version);
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
    RETURN jsonb_build_object('outcome', 'not_editable', 'status', v_row.status);
  END IF;
  IF v_row.details_version IS DISTINCT FROM p_expected_details_version THEN
    RETURN jsonb_build_object('outcome', 'version_conflict',
      'details_version', v_row.details_version);
  END IF;
  IF p_patch ? 'customer_name' AND
     NULLIF(btrim(p_patch->>'customer_name'), '') IS NULL THEN
    RAISE EXCEPTION 'customer_name may not be cleared';
  END IF;
  IF p_patch ? 'customer_phone' AND
     NULLIF(btrim(p_patch->>'customer_phone'), '') IS NULL THEN
    RAISE EXCEPTION 'customer_phone may not be cleared';
  END IF;

  v_new_booker_name := CASE WHEN p_patch ? 'booker_name'
    THEN NULLIF(btrim(p_patch->>'booker_name'), '') ELSE v_row.booker_name END;
  v_new_booker_phone := CASE
    WHEN v_new_booker_name IS NULL THEN NULL
    WHEN p_patch ? 'booker_phone' THEN NULLIF(btrim(p_patch->>'booker_phone'), '')
    ELSE v_row.booker_phone
  END;

  BEGIN
    UPDATE bookings SET
      customer_name = CASE WHEN p_patch ? 'customer_name'
        THEN btrim(p_patch->>'customer_name') ELSE customer_name END,
      customer_phone = CASE WHEN p_patch ? 'customer_phone'
        THEN btrim(p_patch->>'customer_phone') ELSE customer_phone END,
      customer_email = CASE WHEN p_patch ? 'customer_email'
        THEN NULLIF(btrim(p_patch->>'customer_email'), '') ELSE customer_email END,
      booker_name = v_new_booker_name,
      booker_phone = v_new_booker_phone,
      flight_number = CASE WHEN p_patch ? 'flight_number'
        THEN NULLIF(btrim(p_patch->>'flight_number'), '') ELSE flight_number END,
      notes = CASE WHEN p_patch ? 'notes'
        THEN NULLIF(p_patch->>'notes', '') ELSE notes END,
      pickup_sign = CASE WHEN p_patch ? 'pickup_sign'
        THEN NULLIF(btrim(p_patch->>'pickup_sign'), '') ELSE pickup_sign END,
      promo_code = CASE WHEN p_patch ? 'promo_code'
        THEN NULLIF(btrim(p_patch->>'promo_code'), '') ELSE promo_code END,
      details_version = details_version + 1,
      updated_at = now()
    WHERE id = p_booking_id;

    IF v_has_request_id THEN
      INSERT INTO operation_receipts (
        operation_request_id, kind, auth_user_id, customer_id,
        request_digest, booking_id, details_version
      ) VALUES (
        p_operation_request_id, 'edit_optional', p_auth_user_id, p_customer_id,
        p_request_digest, p_booking_id, v_row.details_version + 1
      );
    END IF;

    RETURN jsonb_build_object('outcome', 'updated', 'booking_id', p_booking_id,
      'details_version', v_row.details_version + 1);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'operation_receipts_operation_request_id_key' THEN
      SELECT * INTO v_receipt FROM operation_receipts
        WHERE operation_request_id = p_operation_request_id;
      IF FOUND AND v_receipt.auth_user_id = p_auth_user_id
               AND v_receipt.customer_id = p_customer_id
               AND v_receipt.kind = 'edit_optional'
               AND v_receipt.booking_id = p_booking_id
               AND v_receipt.request_digest = p_request_digest THEN
        RETURN jsonb_build_object('outcome', 'idempotent',
          'booking_id', v_receipt.booking_id,
          'details_version', v_receipt.details_version);
      END IF;
      INSERT INTO quote_verifications (verdict, mode, purpose, booking_id, identity_hash)
        VALUES (CASE
                  WHEN FOUND AND (v_receipt.auth_user_id IS DISTINCT FROM p_auth_user_id
                    OR v_receipt.customer_id IS DISTINCT FROM p_customer_id)
                  THEN 'replay_identity_mismatch'
                  ELSE 'replay_context_mismatch'
                END, v_mode, 'edit', p_booking_id, v_idhash);
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
REVOKE EXECUTE ON FUNCTION accept_quote_create(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION accept_quote_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION accept_optional_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION bookings_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION pricing_state_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE pricing_state_audit_id_seq, quote_verifications_id_seq
  FROM PUBLIC, anon, authenticated;

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
GRANT EXECUTE ON FUNCTION accept_quote_create(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION accept_quote_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION accept_optional_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, JSONB) TO service_role;
GRANT SELECT ON pricing_state, pricing_state_audit,
  quote_acceptances, quote_verifications, operation_receipts TO service_role;
-- Sanitized pre-verification evidence may be written by the service endpoint
-- before it can enter an RPC. Receipts and successful booking mutations stay
-- RPC-only so a receipt can never exist without its atomic business result.
GRANT INSERT ON quote_verifications TO service_role;
-- quote_verifications uses a BIGINT identity; INSERT needs its sequence.
-- pricing_state_audit remains definer-only and gets no sequence privilege.
REVOKE ALL ON SEQUENCE pricing_state_audit_id_seq, quote_verifications_id_seq
  FROM service_role;
GRANT USAGE ON SEQUENCE quote_verifications_id_seq TO service_role;
-- Existing production functions already read/write bookings with the service
-- key. Restate that pre-017 contract explicitly so the new definer trigger is
-- exercised under the same role during installation and future restores do
-- not depend on project-default grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON bookings TO service_role;
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
  v_probe TEXT;
  v_role TEXT;
  v_table TEXT;
  v_priv TEXT;
  v_signature TEXT;
BEGIN
  -- Data invariants and total backfill.
  SELECT count(*) INTO v_count FROM bookings
    WHERE price_cents IS NULL OR price_authority IS NULL
       OR multi_booking_exempt IS NULL OR assignment_epoch IS NULL
       OR route_authority IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION '017 self-check: % rows escaped backfill', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM bookings
    WHERE price::text IN ('NaN','Infinity','-Infinity')
       OR price < 0 OR price > 21474836.47 OR price_cents < 0
       OR round(price * 100)::INTEGER <> price_cents;
  IF v_count > 0 THEN
    RAISE EXCEPTION '017 self-check: % rows have price/cents drift', v_count;
  END IF;

  -- active_slot integrity, including legacy `assigned`.
  SELECT count(*) INTO v_count FROM bookings
    WHERE (status IN ('pending','confirmed','assigned','on_the_way','arrived','in_progress')
           AND NOT multi_booking_exempt AND active_slot IS DISTINCT FROM customer_id)
       OR ((status NOT IN ('pending','confirmed','assigned','on_the_way','arrived','in_progress')
            OR multi_booking_exempt) AND active_slot IS NOT NULL);
  IF v_count > 0 THEN
    RAISE EXCEPTION '017 self-check: % rows have an inconsistent active_slot', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'bookings'
    AND column_name IN (
      'price_cents','price_authority','multi_booking_exempt','active_slot',
      'assignment_epoch','canonical_place_id','airport_code','route_authority'
    );
  IF v_count <> 8 THEN
    RAISE EXCEPTION '017 self-check: expected 8 bookings columns, found %', v_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings'
      AND column_name IN ('price_cents','price_authority','multi_booking_exempt',
                          'assignment_epoch','route_authority')
      AND is_nullable <> 'NO'
  ) THEN
    RAISE EXCEPTION '017 self-check: a required bookings foundation column remains nullable';
  END IF;
  SELECT count(*) INTO v_count FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'bookings' AND c.convalidated
    AND c.conname IN (
      'bookings_price_authority_check','bookings_route_authority_check',
      'bookings_route_identity_check','bookings_price_cents_equal_check',
      'bookings_price_nonnegative_check','bookings_assignment_epoch_check'
    );
  IF v_count <> 6 THEN
    RAISE EXCEPTION '017 self-check: expected 6 validated bookings constraints, found %', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'bookings'
      AND indexname = 'bookings_one_active_per_customer'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%WHERE (active_slot IS NOT NULL)%'
  ) THEN
    RAISE EXCEPTION '017 self-check: active-slot partial unique index missing or invalid';
  END IF;

  SELECT mode INTO v_mode FROM pricing_state
    WHERE singleton AND enforcement_started_at IS NULL;
  IF v_mode IS DISTINCT FROM 'off' OR (SELECT count(*) FROM pricing_state) <> 1 THEN
    RAISE EXCEPTION '017 self-check: pricing_state must be one off row with no high-water mark';
  END IF;

  -- The valve must exist and refuse: probe it in a nested block.
  BEGIN
    UPDATE pricing_state SET mode = 'enforce' WHERE singleton;
    RAISE EXCEPTION '017 self-check: direct pricing_state UPDATE was not refused';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%set_pricing_mode%' THEN RAISE; END IF;
  END;

  -- The schema-qualified primitive must execute before the migration can
  -- commit RPCs that depend on it. Qualification is the anti-shadowing seal.
  BEGIN
    -- Plain invoker function: Postgres refuses to EXECUTE a SECURITY
    -- DEFINER function living in pg_temp, and the probe only needs the
    -- SET clause (search-path resolution is identical either way).
    CREATE OR REPLACE FUNCTION pg_temp.digest_path_probe() RETURNS TEXT
      LANGUAGE plpgsql SET search_path = public, extensions, pg_temp
      AS 'BEGIN RETURN encode(extensions.digest(''probe'', ''sha256''), ''hex''); END';
    SELECT pg_temp.digest_path_probe() INTO v_probe;
    IF v_probe IS NULL OR length(v_probe) <> 64 THEN
      RAISE EXCEPTION '017 self-check: digest() probe returned garbage';
    END IF;
    DROP FUNCTION pg_temp.digest_path_probe();
  EXCEPTION WHEN undefined_function THEN
    RAISE EXCEPTION '017 self-check: extensions.digest(text,text) is unavailable';
  END;

  -- All five foundation tables are default-deny RLS: enabled, zero policies,
  -- zero table/column grants for clients or PUBLIC.
  SELECT count(*) INTO v_count FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('pricing_state','pricing_state_audit','quote_acceptances',
                      'quote_verifications','operation_receipts')
    AND c.relkind = 'r' AND c.relrowsecurity;
  IF v_count <> 5 THEN
    RAISE EXCEPTION '017 self-check: expected RLS on 5 foundation tables, found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('pricing_state','pricing_state_audit','quote_acceptances',
                      'quote_verifications','operation_receipts');
  IF v_count <> 0 THEN
    RAISE EXCEPTION '017 self-check: foundation tables require zero RLS policies, found %', v_count;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH v_table IN ARRAY ARRAY['pricing_state','pricing_state_audit','quote_acceptances',
                                    'quote_verifications','operation_receipts'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                     'TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF has_table_privilege(v_role, 'public.' || v_table, v_priv) THEN
          RAISE EXCEPTION '017 self-check: % retains % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE n.nspname = 'public'
      AND c.relname IN ('pricing_state','pricing_state_audit','quote_acceptances',
                        'quote_verifications','operation_receipts')
      AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION '017 self-check: direct PUBLIC table grants remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) x
    WHERE n.nspname = 'public'
      AND c.relname IN ('pricing_state','pricing_state_audit','quote_acceptances',
                        'quote_verifications','operation_receipts')
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      AND (x.grantee = 0 OR x.grantee::regrole::text IN ('anon','authenticated'))
  ) THEN
    RAISE EXCEPTION '017 self-check: client/PUBLIC column ACLs remain';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH v_table IN ARRAY ARRAY['pricing_state','pricing_state_audit','quote_acceptances',
                                    'quote_verifications','operation_receipts'] LOOP
      SELECT count(*) INTO v_count
      FROM information_schema.columns c
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(priv)
      WHERE c.table_schema = 'public' AND c.table_name = v_table
        AND has_column_privilege(v_role, 'public.' || v_table, c.column_name, p.priv);
      IF v_count <> 0 THEN
        RAISE EXCEPTION '017 self-check: % retains column privilege on %', v_role, v_table;
      END IF;
    END LOOP;
  END LOOP;

  -- Service-role ceiling: read tables, call the four public RPCs, and append
  -- only sanitized verification telemetry (plus its identity sequence).
  -- Acceptances, receipts, pricing state, and audit remain direct-write closed.
  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.bookings', v_priv) THEN
      RAISE EXCEPTION '017 self-check: service_role lacks required % on bookings', v_priv;
    END IF;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['pricing_state','pricing_state_audit','quote_acceptances',
                                  'quote_verifications','operation_receipts'] LOOP
    IF NOT has_table_privilege('service_role', 'public.' || v_table, 'SELECT')
       OR (has_table_privilege('service_role', 'public.' || v_table, 'INSERT')
           IS DISTINCT FROM (v_table = 'quote_verifications'))
       OR has_table_privilege('service_role', 'public.' || v_table, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || v_table, 'DELETE')
       OR has_table_privilege('service_role', 'public.' || v_table, 'TRUNCATE')
       OR has_table_privilege('service_role', 'public.' || v_table, 'REFERENCES')
       OR has_table_privilege('service_role', 'public.' || v_table, 'TRIGGER') THEN
      RAISE EXCEPTION '017 self-check: service_role table ceiling is wrong for %', v_table;
    END IF;
  END LOOP;
  IF has_sequence_privilege('service_role', 'public.pricing_state_audit_id_seq', 'USAGE')
     OR has_sequence_privilege('service_role', 'public.pricing_state_audit_id_seq', 'SELECT')
     OR NOT has_sequence_privilege('service_role', 'public.quote_verifications_id_seq', 'USAGE')
     OR has_sequence_privilege('service_role', 'public.quote_verifications_id_seq', 'SELECT')
     OR has_sequence_privilege('service_role', 'public.quote_verifications_id_seq', 'UPDATE') THEN
    RAISE EXCEPTION '017 self-check: service_role sequence privileges are incomplete';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF has_sequence_privilege(v_role, 'public.pricing_state_audit_id_seq', 'USAGE')
       OR has_sequence_privilege(v_role, 'public.pricing_state_audit_id_seq', 'SELECT')
       OR has_sequence_privilege(v_role, 'public.quote_verifications_id_seq', 'USAGE')
       OR has_sequence_privilege(v_role, 'public.quote_verifications_id_seq', 'SELECT') THEN
      RAISE EXCEPTION '017 self-check: % retains sequence privilege', v_role;
    END IF;
  END LOOP;

  -- Function contract: four service RPCs are SECURITY DEFINER; every
  -- foundation function has a pinned search_path; clients cannot EXECUTE.
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('set_pricing_mode','accept_quote_create','accept_quote_edit',
                      'accept_optional_edit','bookings_guard','pricing_state_guard');
  IF v_count <> 6 THEN
    RAISE EXCEPTION '017 self-check: expected 6 foundation functions, found %', v_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('set_pricing_mode','accept_quote_create','accept_quote_edit',
                        'accept_optional_edit','bookings_guard')
      AND NOT p.prosecdef
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('set_pricing_mode','accept_quote_create','accept_quote_edit',
                        'accept_optional_edit','bookings_guard','pricing_state_guard')
      AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION '017 self-check: function SECURITY DEFINER/search_path contract is incomplete';
  END IF;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.set_pricing_mode(text,text)',
    'public.accept_quote_create(uuid,uuid,uuid,text,text,uuid,text,jsonb,numeric,text,text,text,jsonb)',
    'public.accept_quote_edit(uuid,uuid,uuid,text,uuid,integer,text,uuid,text,jsonb,numeric,text,text,text,jsonb)',
    'public.accept_optional_edit(uuid,uuid,uuid,text,uuid,integer,jsonb)'
  ] LOOP
    IF NOT has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR has_function_privilege('anon', v_signature, 'EXECUTE')
       OR has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION '017 self-check: function ACL is wrong for %', v_signature;
    END IF;
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.bookings_guard()', 'public.pricing_state_guard()'
  ] LOOP
    IF has_function_privilege('anon', v_signature, 'EXECUTE')
       OR has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION '017 self-check: trigger function is directly executable: %', v_signature;
    END IF;
  END LOOP;

  -- All five triggers must exist and be enabled in normal replication mode.
  SELECT count(*) INTO v_count FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled = 'O'
    AND ((c.relname = 'bookings' AND t.tgname = 'bookings_guard_trg')
      OR (c.relname = 'pricing_state' AND t.tgname = 'pricing_state_guard_trg')
      OR (c.relname = 'pricing_state' AND t.tgname = 'pricing_state_truncate_guard_trg')
      OR (c.relname = 'pricing_state_audit' AND t.tgname = 'pricing_state_audit_guard_trg')
      OR (c.relname = 'pricing_state_audit' AND t.tgname = 'pricing_state_audit_truncate_guard_trg'));
  IF v_count <> 5 THEN
    RAISE EXCEPTION '017 self-check: expected 5 enabled foundation triggers, found %', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'bookings'
      AND t.tgname = 'update_bookings_updated_at'
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION '017 self-check: legacy bookings updated_at trigger was not restored';
  END IF;

END $$;

-- ------------------------------------------------------------
-- 8. BEHAVIORAL SMOKE — all mutations roll back inside this block.
-- ------------------------------------------------------------
DO $migration_017_smoke$
DECLARE
  v_bookings_before BIGINT;
  v_customers_before BIGINT;
  v_hosts_before BIGINT;
  v_drivers_before BIGINT;
  v_accept_before BIGINT;
  v_verify_before BIGINT;
  v_receipts_before BIGINT;
  v_audit_before BIGINT;
  v_customer_legacy UUID;
  v_customer_quote UUID;
  v_customer_assigned UUID;
  v_customer_enforce UUID;
  v_auth_legacy UUID := gen_random_uuid();
  v_auth_quote UUID := gen_random_uuid();
  v_auth_assigned UUID := gen_random_uuid();
  v_auth_enforce UUID := gen_random_uuid();
  v_driver UUID;
  v_host UUID;
  v_booking_legacy UUID;
  v_booking_off UUID;
  v_booking_quote UUID;
  v_booking_assigned UUID;
  v_booking_enforce UUID;
  v_op_create UUID := gen_random_uuid();
  v_op_off_create UUID := gen_random_uuid();
  v_op_off_sibling UUID := gen_random_uuid();
  v_op_off_expired_edit UUID := gen_random_uuid();
  v_op_optional UUID := gen_random_uuid();
  v_op_edit UUID := gen_random_uuid();
  v_op_future UUID := gen_random_uuid();
  v_op_active_conflict UUID := gen_random_uuid();
  v_op_blocked_optional UUID := gen_random_uuid();
  v_op_enforce_create UUID := gen_random_uuid();
  v_op_enforce_edit UUID := gen_random_uuid();
  v_op_enforce_no_token UUID := gen_random_uuid();
  v_op_enforce_invalid UUID := gen_random_uuid();
  v_jti_create UUID := gen_random_uuid();
  v_jti_off UUID := gen_random_uuid();
  v_jti_off_expired_edit UUID := gen_random_uuid();
  v_jti_edit UUID := gen_random_uuid();
  v_jti_expired UUID := gen_random_uuid();
  v_jti_future UUID := gen_random_uuid();
  v_jti_enforce_create UUID := gen_random_uuid();
  v_jti_enforce_edit UUID := gen_random_uuid();
  v_audit_seq_last BIGINT;
  v_audit_seq_called BOOLEAN;
  v_verify_seq_last BIGINT;
  v_verify_seq_called BOOLEAN;
  v_now_ms BIGINT;
  v_pickup_at TIMESTAMPTZ;
  v_payload JSONB;
  v_booking_json JSONB;
  v_result JSONB;
  v_count BIGINT;
  v_constraint TEXT;
BEGIN
  SELECT count(*) INTO v_bookings_before FROM bookings;
  SELECT count(*) INTO v_customers_before FROM customers;
  SELECT count(*) INTO v_hosts_before FROM hosts;
  SELECT count(*) INTO v_drivers_before FROM drivers;
  SELECT count(*) INTO v_accept_before FROM quote_acceptances;
  SELECT count(*) INTO v_verify_before FROM quote_verifications;
  SELECT count(*) INTO v_receipts_before FROM operation_receipts;
  SELECT count(*) INTO v_audit_before FROM pricing_state_audit;
  SELECT last_value, is_called INTO v_audit_seq_last, v_audit_seq_called
    FROM pricing_state_audit_id_seq;
  SELECT last_value, is_called INTO v_verify_seq_last, v_verify_seq_called
    FROM quote_verifications_id_seq;

  BEGIN
    INSERT INTO customers (name, phone, email, type, source)
      VALUES ('MIGRATION-017-SMOKE-LEGACY','0000000017','smoke017a@example.invalid','guest','website')
      RETURNING id INTO v_customer_legacy;
    INSERT INTO customers (name, phone, email, type, source)
      VALUES ('MIGRATION-017-SMOKE-QUOTE','0000000017','smoke017b@example.invalid','guest','website')
      RETURNING id INTO v_customer_quote;
    INSERT INTO customers (name, phone, email, type, source)
      VALUES ('MIGRATION-017-SMOKE-ASSIGNED','0000000017','smoke017c@example.invalid','guest','website')
      RETURNING id INTO v_customer_assigned;
    INSERT INTO customers (name, phone, email, type, source)
      VALUES ('MIGRATION-017-SMOKE-ENFORCE','0000000017','smoke017d@example.invalid','guest','website')
      RETURNING id INTO v_customer_enforce;
    INSERT INTO drivers (name, phone) VALUES ('MIGRATION-017-SMOKE-DRIVER','0000000017')
      RETURNING id INTO v_driver;
    INSERT INTO hosts (name, referral_code, commission_rate, status)
      VALUES ('MIGRATION-017-SMOKE-HOST','migration-017-smoke-host',0.10,'active')
      RETURNING id INTO v_host;

    -- Exercise the real service-role INSERT + identity-sequence path. Direct
    -- receipt fabrication remains denied; only sanitized attempt telemetry is
    -- writable outside the atomic RPCs.
    BEGIN
      EXECUTE 'SET LOCAL ROLE service_role';
      INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
        VALUES ('no_token', 'off', 'create', repeat('7',64));
      -- These are the actual unchanged application lanes: create-booking,
      -- driver Accept, and passenger cancellation all write bookings as the
      -- service key. The SECURITY DEFINER guard must make its share-lock read
      -- without widening service_role's pricing_state privileges.
      INSERT INTO bookings (
        customer_id, customer_name, customer_phone,
        pickup_location, dropoff_location, pickup_datetime,
        vehicle_type, price, status, source, multi_booking_exempt
      ) VALUES (
        v_customer_assigned, 'MIGRATION-017-SMOKE-ASSIGNED', '0000000017',
        'smoke-origin', 'smoke-destination', now() + interval '1 day',
        'sedan', 10.00, 'pending', 'website', TRUE
      ) RETURNING id INTO v_booking_assigned;
      UPDATE bookings SET status = 'confirmed', assigned_driver = v_driver
        WHERE id = v_booking_assigned;
      UPDATE bookings SET status = 'cancelled', cancelled_at = now()
        WHERE id = v_booking_assigned;
      UPDATE bookings SET status = 'assigned', cancelled_at = NULL
        WHERE id = v_booking_assigned;
      BEGIN
        INSERT INTO operation_receipts (
          operation_request_id, kind, auth_user_id, customer_id,
          request_digest, booking_id
        ) VALUES (
          gen_random_uuid(), 'create', v_auth_legacy, v_customer_legacy,
          repeat('7',64), gen_random_uuid()
        );
        RAISE EXCEPTION '017 smoke: service_role fabricated an operation receipt';
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
      RAISE;
    END;
    IF NOT EXISTS (
      SELECT 1 FROM quote_verifications
      WHERE identity_hash = repeat('7',64) AND verdict = 'no_token'
    ) THEN
      RAISE EXCEPTION '017 smoke: service_role telemetry insert did not persist';
    END IF;
    BEGIN
      EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN
        INSERT INTO quote_verifications (verdict, mode, purpose, identity_hash)
          VALUES ('no_token', 'off', 'create', repeat('4',64));
        RAISE EXCEPTION '017 smoke: authenticated role inserted foundation telemetry';
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
      RAISE;
    END;

    -- Legacy direct writer: derived cents/authority, frozen non-ambassador
    -- actor class, and legacy `assigned` all bind the active slot. The row
    -- was inserted/accepted/cancelled under service_role above.
    IF NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_assigned
        AND price_cents = 1000 AND price_authority = 'client_legacy'
        AND NOT multi_booking_exempt AND active_slot = v_customer_assigned
        AND assignment_epoch = 1 AND status = 'assigned'
    ) THEN
      RAISE EXCEPTION '017 smoke: legacy assigned writer escaped authority/actor/slot guards';
    END IF;
    BEGIN
      UPDATE bookings SET multi_booking_exempt = TRUE WHERE id = v_booking_assigned;
      RAISE EXCEPTION '017 smoke: frozen actor classification was mutable';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%multi_booking_exempt is frozen%' THEN RAISE; END IF;
    END;
    BEGIN
      INSERT INTO bookings (
        customer_id, customer_name, customer_phone,
        pickup_location, dropoff_location, pickup_datetime,
        vehicle_type, price, status, source
      ) VALUES (
        v_customer_assigned, 'MIGRATION-017-SMOKE-DUPLICATE', '0000000017',
        'smoke-origin', 'smoke-destination', now() + interval '2 days',
        'sedan', 10.00, 'pending', 'website'
      );
      RAISE EXCEPTION '017 smoke: duplicate active legacy booking was accepted';
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint <> 'bookings_one_active_per_customer' THEN RAISE; END IF;
    END;

    -- The database valve itself is tamper-resistant for every ordinary SQL
    -- operation. These probes run as the owner (the strongest application-
    -- adjacent role) and roll back their failed statements locally.
    BEGIN
      PERFORM set_pricing_mode(NULL, 'migration-017-smoke');
      RAISE EXCEPTION '017 smoke: NULL pricing mode was accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%unknown pricing mode%' THEN RAISE; END IF;
    END;
    BEGIN
      INSERT INTO pricing_state_audit (actor, from_mode, to_mode)
        VALUES ('forged-smoke', 'off', 'observe');
      RAISE EXCEPTION '017 smoke: direct pricing audit INSERT was accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%set_pricing_mode%' THEN RAISE; END IF;
    END;
    BEGIN
      TRUNCATE pricing_state;
      RAISE EXCEPTION '017 smoke: pricing_state TRUNCATE was accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%set_pricing_mode%' THEN RAISE; END IF;
    END;
    BEGIN
      TRUNCATE pricing_state_audit;
      RAISE EXCEPTION '017 smoke: pricing_state_audit TRUNCATE was accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%set_pricing_mode%' THEN RAISE; END IF;
    END;

    -- Strict transition matrix: off -> enforce is impossible; off -> observe
    -- remains available for the evidence period.
    BEGIN
      PERFORM set_pricing_mode('enforce', 'migration-017-smoke');
      RAISE EXCEPTION '017 smoke: off -> enforce unexpectedly succeeded';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%invalid pricing mode transition off -> enforce%' THEN RAISE; END IF;
    END;

    v_booking_json := jsonb_build_object(
      'trip_id','MIG017-LEGACY','customer_name','MIGRATION-017-SMOKE-LEGACY',
      'customer_phone','0000000017','pickup_location','smoke-origin',
      'dropoff_location','smoke-destination','pickup_datetime',(now() + interval '1 day')::text,
      'passengers',1,'bags',0,'vehicle_type','sedan','vehicle_name','Sedan',
      'booking_mode','dropoff','airport_code','MIA','source','website',
      'duration_minutes',99
    );
    v_result := accept_quote_create(
      v_auth_legacy, v_customer_legacy, NULL, NULL, 'no_token',
      NULL, NULL, NULL, 12.34, NULL, NULL, NULL, v_booking_json
    );
    v_booking_legacy := (v_result->>'booking_id')::UUID;
    IF v_result->>'outcome' IS DISTINCT FROM 'created' OR NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_legacy
        AND price = 12.34 AND price_cents = 1234
        AND price_authority = 'client_legacy' AND duration_minutes = 99
    ) OR EXISTS (SELECT 1 FROM operation_receipts WHERE booking_id = v_booking_legacy) THEN
      RAISE EXCEPTION '017 smoke: off-mode legacy RPC contract failed';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM quote_verifications WHERE booking_id = v_booking_legacy
        AND verdict = 'no_request_id' AND mode = 'off'
    ) THEN
      RAISE EXCEPTION '017 smoke: missing operation id was not telemetried in off mode';
    END IF;

    -- DQ-1/DQ-4: OFF controls which money wins, not whether an authentic
    -- quote is consumed. A valid quote records one client_legacy acceptance
    -- and preserves the commitment-verified duration. Once the booking is
    -- terminal (active slot free), a sibling token for the same jti must still
    -- be unable to multiply the quote. An authentic stale EDIT is refused in
    -- off too; it is never relabelled verify_failed to sneak through legacy
    -- pricing.
    v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
    v_pickup_at := to_timestamp((v_now_ms + 86400000) / 1000.0);
    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_off::text,
      'purpose','create','authUserId',v_auth_quote::text,
      'customerId',v_customer_quote::text,'vehicle','tesla',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('0',64),
      'routeQuality','traffic_aware','finalCents',5678,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 1000,'exp',v_now_ms + 899000
    );
    v_booking_json := jsonb_build_object(
      'trip_id','MIG017-OFF-VERIFIED','customer_name','MIGRATION-017-SMOKE-QUOTE',
      'customer_phone','0000000017','pickup_location','smoke-origin',
      'dropoff_location','smoke-destination','pickup_datetime',v_pickup_at::TEXT,
      'passengers',1,'bags',0,'vehicle_type','sedan','vehicle_name','Tesla Model Y',
      'booking_mode','dropoff','airport_code','MIA','source','website',
      'duration_minutes',88
    );
    v_result := accept_quote_create(
      v_auth_quote, v_customer_quote, v_op_off_create, repeat('0',64), 'verified',
      v_jti_off, repeat('0',64), v_payload, 43.21,
      'off-place-id', 'MIA', 'tesla', v_booking_json
    );
    v_booking_off := (v_result->>'booking_id')::UUID;
    IF v_result->>'outcome' IS DISTINCT FROM 'created' OR NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_off
        AND price = 43.21 AND price_cents = 4321
        AND price_authority = 'client_legacy' AND duration_minutes = 88
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_acceptances WHERE booking_id = v_booking_off
        AND purpose = 'create' AND jti = v_jti_off
        AND final_cents = 5678 AND client_cents = 4321
        AND authority = 'client_legacy'
    ) THEN
      RAISE EXCEPTION '017 smoke: off verified acceptance/duration contract failed';
    END IF;
    UPDATE bookings SET status = 'completed' WHERE id = v_booking_off;
    v_result := accept_quote_create(
      v_auth_quote, v_customer_quote, v_op_off_sibling, repeat('1',64), 'verified',
      v_jti_off, repeat('1',64), v_payload, 43.21,
      'off-place-id', 'MIA', 'tesla',
      v_booking_json || jsonb_build_object('trip_id','MIG017-OFF-SIBLING')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_consumed'
       OR (v_result->>'booking_id')::UUID IS DISTINCT FROM v_booking_off
       OR EXISTS (SELECT 1 FROM bookings WHERE trip_id = 'MIG017-OFF-SIBLING') THEN
      RAISE EXCEPTION '017 smoke: off sibling token multiplied one quote';
    END IF;

    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_off_expired_edit::text,
      'purpose','edit','authUserId',v_auth_legacy::text,
      'customerId',v_customer_legacy::text,'bookingId',v_booking_legacy::text,
      'assignmentEpoch',0,'vehicle','tesla',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('2',64),
      'routeQuality','traffic_aware','finalCents',1234,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 900001,'exp',v_now_ms - 1
    );
    v_result := accept_quote_edit(
      v_auth_legacy, v_customer_legacy, v_op_off_expired_edit, repeat('2',64),
      v_booking_legacy, 1, 'verified', v_jti_off_expired_edit, repeat('2',64),
      v_payload, 12.34, 'off-expired-place', 'MIA', 'tesla',
      jsonb_build_object('pickup_datetime',v_pickup_at::TEXT,'duration_minutes',99)
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_expired'
       OR EXISTS (SELECT 1 FROM quote_acceptances WHERE jti = v_jti_off_expired_edit)
       OR EXISTS (SELECT 1 FROM operation_receipts
                    WHERE operation_request_id = v_op_off_expired_edit)
       OR NOT EXISTS (SELECT 1 FROM bookings WHERE id = v_booking_legacy
                        AND details_version = 1 AND duration_minutes = 99) THEN
      RAISE EXCEPTION '017 smoke: off accepted an authentic stale edit quote';
    END IF;

    PERFORM set_pricing_mode('observe', 'migration-017-smoke');

    -- Prove the RPC marker cannot relabel money with an authority that does
    -- not match the current mode. Use a terminal row so active-slot
    -- uniqueness cannot be the reason this probe fails.
    BEGIN
      PERFORM set_config('linkmia.rpc_writer', 'on', TRUE);
      INSERT INTO bookings (
        customer_id, customer_name, customer_phone,
        pickup_location, dropoff_location, pickup_datetime,
        vehicle_type, price, price_cents, price_authority,
        canonical_place_id, airport_code, route_authority,
        status, source
      ) VALUES (
        v_customer_quote, 'must-refuse-authority', '0000000017',
        'smoke-origin', 'smoke-destination', now() + interval '3 days',
        'sedan', 10.00, 1000, 'server_quote',
        'smoke-authority-place', 'MIA', 'canonical',
        'completed', 'website'
      );
      RAISE EXCEPTION '017 smoke: RPC authority mismatch was accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%RPC insert price authority%invalid in mode observe%' THEN
        RAISE;
      END IF;
    END;

    v_now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT;
    v_pickup_at := to_timestamp((v_now_ms + 86400000) / 1000.0);
    v_booking_json := v_booking_json ||
      jsonb_build_object('pickup_datetime', v_pickup_at::TEXT);

    -- The RPC reaches the same active-slot constraint as a legacy writer and
    -- classifies the exact constraint rather than guessing from unique_violation.
    v_result := accept_quote_create(
      v_auth_assigned, v_customer_assigned, v_op_active_conflict, repeat('8',64),
      'no_token', NULL, NULL, NULL, 10.00, NULL, NULL, NULL,
      v_booking_json || jsonb_build_object('trip_id','MIG017-ACTIVE-CONFLICT')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'active_exists'
       OR (v_result->>'booking_id')::UUID IS DISTINCT FROM v_booking_assigned THEN
      RAISE EXCEPTION '017 smoke: active-slot RPC conflict was misclassified';
    END IF;

    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_future::text,
      'purpose','create','authUserId',v_auth_quote::text,
      'customerId',v_customer_quote::text,'vehicle','tesla',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('a',64),
      'routeQuality','traffic_aware','finalCents',5678,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms + 120000,'exp',v_now_ms + 1020000
    );
    v_booking_json := jsonb_build_object(
      'trip_id','MIG017-QUOTE','customer_name','MIGRATION-017-SMOKE-QUOTE',
      'customer_phone','0000000017','pickup_location','smoke-origin',
      'dropoff_location','smoke-destination','pickup_datetime',v_pickup_at::TEXT,
      'passengers',1,'bags',0,'vehicle_type','sedan','vehicle_name','Tesla Model Y',
      'booking_mode','dropoff','airport_code','MIA','source','website',
      'duration_minutes',777
    );
    v_result := accept_quote_create(
      v_auth_quote, v_customer_quote, v_op_future, repeat('6',64), 'verified',
      v_jti_future, repeat('6',64), v_payload, 43.21,
      'future-place-id', 'MIA', 'tesla',
      v_booking_json || jsonb_build_object('trip_id','MIG017-FUTURE')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_not_yet_valid'
       OR EXISTS (SELECT 1 FROM quote_acceptances WHERE jti = v_jti_future)
       OR EXISTS (SELECT 1 FROM operation_receipts WHERE operation_request_id = v_op_future)
       OR EXISTS (SELECT 1 FROM bookings WHERE trip_id = 'MIG017-FUTURE') THEN
      RAISE EXCEPTION '017 smoke: observe accepted a not-yet-valid quote';
    END IF;

    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_create::text,
      'purpose','create','authUserId',v_auth_quote::text,
      'customerId',v_customer_quote::text,'vehicle','tesla',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('a',64),
      'routeQuality','traffic_aware','finalCents',5678,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 1000,'exp',v_now_ms + 899000
    );
    BEGIN
      PERFORM accept_quote_create(
        v_auth_quote, v_customer_quote, gen_random_uuid(), repeat('5',64),
        'verified', v_jti_create, repeat('5',64),
        v_payload || jsonb_build_object('unsignedExtra', TRUE), 43.21,
        'smoke-place-id', 'MIA', 'tesla',
        v_booking_json || jsonb_build_object('trip_id','MIG017-BAD-PROJECTION')
      );
      RAISE EXCEPTION '017 smoke: unsigned payload field was accepted';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%verified create payload projection is invalid%' THEN RAISE; END IF;
    END;
    IF EXISTS (SELECT 1 FROM bookings WHERE trip_id = 'MIG017-BAD-PROJECTION') THEN
      RAISE EXCEPTION '017 smoke: malformed payload left booking residue';
    END IF;
    v_result := accept_quote_create(
      v_auth_quote, v_customer_quote, v_op_create, repeat('b',64), 'verified',
      v_jti_create, repeat('a',64), v_payload, 43.21,
      'smoke-place-id', 'MIA', 'tesla', v_booking_json
    );
    v_booking_quote := (v_result->>'booking_id')::UUID;
    IF v_result->>'outcome' IS DISTINCT FROM 'created' OR NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_quote
        AND price = 43.21 AND price_cents = 4321
        AND price_authority = 'client_observe' AND duration_minutes = 777
        AND canonical_place_id = 'smoke-place-id' AND route_authority = 'canonical'
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_acceptances WHERE booking_id = v_booking_quote
        AND purpose = 'create' AND final_cents = 5678 AND client_cents = 4321
    ) THEN
      RAISE EXCEPTION '017 smoke: observe create/acceptance contract failed';
    END IF;

    -- A direct pre-enforcement route-text edit remains compatible, but it
    -- cannot keep claiming the canonical identity of the route it replaced.
    UPDATE bookings SET pickup_location = 'smoke-direct-edited-origin'
      WHERE id = v_booking_quote;
    IF NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_quote
        AND pickup_location = 'smoke-direct-edited-origin'
        AND canonical_place_id IS NULL AND airport_code IS NULL
        AND route_authority = 'legacy_text'
    ) THEN
      RAISE EXCEPTION '017 smoke: legacy route edit retained stale canonical identity';
    END IF;

    -- Universal idempotency and receipt-kind isolation.
    v_result := accept_quote_create(
      v_auth_quote, v_customer_quote, v_op_create, repeat('b',64), 'verified',
      v_jti_create, repeat('a',64), v_payload, 43.21,
      'smoke-place-id', 'MIA', 'tesla', v_booking_json
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'idempotent'
       OR (v_result->>'booking_id')::UUID IS DISTINCT FROM v_booking_quote THEN
      RAISE EXCEPTION '017 smoke: create operation receipt was not idempotent';
    END IF;
    v_result := accept_quote_create(
      v_auth_quote, v_customer_quote, gen_random_uuid(), repeat('9',64), 'verified',
      v_jti_create, repeat('9',64), v_payload, 43.21,
      'smoke-place-id', 'MIA', 'tesla', v_booking_json
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_consumed'
       OR (v_result->>'booking_id')::UUID IS DISTINCT FROM v_booking_quote THEN
      RAISE EXCEPTION '017 smoke: sibling token did not return quote_consumed';
    END IF;
    v_result := accept_optional_edit(
      v_auth_quote, v_customer_quote, v_op_create, repeat('b',64),
      v_booking_quote, 1, jsonb_build_object('notes','must-not-write')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'conflict' OR EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_quote AND notes = 'must-not-write'
    ) THEN
      RAISE EXCEPTION '017 smoke: operation receipt kind mismatch was accepted';
    END IF;

    -- Optional edit is one atomic CAS+receipt operation and its retry is exact.
    v_result := accept_optional_edit(
      v_auth_legacy, v_customer_legacy, v_op_optional, repeat('c',64),
      v_booking_legacy, 1, jsonb_build_object('notes','optional-smoke')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated'
       OR (v_result->>'details_version')::INTEGER IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION '017 smoke: optional edit did not update atomically';
    END IF;
    v_result := accept_optional_edit(
      v_auth_legacy, v_customer_legacy, v_op_optional, repeat('c',64),
      v_booking_legacy, 1, jsonb_build_object('notes','optional-smoke')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'idempotent'
       OR (v_result->>'details_version')::INTEGER IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION '017 smoke: optional edit retry was not idempotent';
    END IF;

    -- Assignment eras cover legacy assigned and release-style transitions;
    -- unrelated intent stays editable only against the current epoch.
    UPDATE bookings SET status = 'assigned', assigned_driver = v_driver
      WHERE id = v_booking_legacy;
    UPDATE bookings SET status = 'pending', assigned_driver = NULL
      WHERE id = v_booking_legacy;
    IF NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_legacy
        AND assignment_epoch = 2 AND active_slot = v_customer_legacy
    ) THEN
      RAISE EXCEPTION '017 smoke: assignment epoch did not advance twice';
    END IF;

    -- Seed the full-form fields an edit must preserve/update atomically.
    -- Commission is a frozen 10% ratio on this booking; the RPC must derive
    -- the new amount from its chosen authoritative fare, never caller input.
    UPDATE bookings SET
      price = 10.00,
      referred_by_host = v_host,
      host_commission = 1.00,
      customer_email = 'preserve@example.invalid',
      booker_name = 'Original Booker',
      booker_phone = '0000000018',
      payment_method = 'cash',
      flight_number = 'AA100',
      notes = 'keep-note',
      pickup_sign = 'KEEP-SIGN',
      promo_code = 'KEEP-PROMO'
    WHERE id = v_booking_legacy;

    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_edit::text,
      'purpose','edit','authUserId',v_auth_legacy::text,
      'customerId',v_customer_legacy::text,'bookingId',v_booking_legacy::text,
      'assignmentEpoch',2,'vehicle','tesla','pickupAtMs',v_now_ms + 86400000,
      'commitment',repeat('d',64),'routeQuality','traffic_aware','finalCents',2222,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 1000,'exp',v_now_ms + 899000
    );

    v_result := accept_quote_edit(
      v_auth_quote, v_customer_quote, gen_random_uuid(), repeat('0',64),
      v_booking_legacy, 2, 'no_token', NULL, NULL, NULL, 20.00,
      NULL, NULL, NULL, '{}'::JSONB
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'not_found' THEN
      RAISE EXCEPTION '017 smoke: foreign edit did not stay generic';
    END IF;
    v_result := accept_quote_edit(
      v_auth_assigned, v_customer_assigned, gen_random_uuid(), repeat('0',64),
      v_booking_assigned, 1, 'no_token', NULL, NULL, NULL, 20.00,
      NULL, NULL, NULL, '{}'::JSONB
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'not_editable' THEN
      RAISE EXCEPTION '017 smoke: assigned booking remained editable';
    END IF;
    v_result := accept_quote_edit(
      v_auth_legacy, v_customer_legacy, gen_random_uuid(), repeat('0',64),
      v_booking_legacy, 999, 'no_token', NULL, NULL, NULL, 20.00,
      NULL, NULL, NULL, '{}'::JSONB
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'version_conflict' THEN
      RAISE EXCEPTION '017 smoke: stale edit version was accepted';
    END IF;
    v_result := accept_quote_edit(
      v_auth_legacy, v_customer_legacy, gen_random_uuid(), repeat('0',64),
      v_booking_legacy, 2, 'verified', v_jti_edit, repeat('d',64),
      jsonb_set(v_payload, '{assignmentEpoch}', '1'::JSONB), 20.00,
      'smoke-edit-place', 'MIA', 'tesla',
      jsonb_build_object('pickup_datetime',v_pickup_at::TEXT,'duration_minutes',777)
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'epoch_conflict' THEN
      RAISE EXCEPTION '017 smoke: stale assignment epoch was accepted';
    END IF;
    v_result := accept_quote_edit(
      v_auth_legacy, v_customer_legacy, gen_random_uuid(), repeat('0',64),
      v_booking_legacy, 2, 'verified', v_jti_edit, repeat('d',64),
      jsonb_set(v_payload, '{bookingId}', to_jsonb(gen_random_uuid()::TEXT)), 20.00,
      'smoke-edit-place', 'MIA', 'tesla',
      jsonb_build_object('pickup_datetime',v_pickup_at::TEXT,'duration_minutes',777)
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_mismatch' THEN
      RAISE EXCEPTION '017 smoke: cross-booking edit token was not classified';
    END IF;
    BEGIN
      PERFORM accept_optional_edit(
        v_auth_legacy, v_customer_legacy, gen_random_uuid(), repeat('0',64),
        v_booking_legacy, 2, jsonb_build_object('price',1.00)
      );
      RAISE EXCEPTION '017 smoke: optional edit accepted a protected field';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%protected or unknown%' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE bookings SET assignment_epoch = assignment_epoch + 1
        WHERE id = v_booking_legacy;
      RAISE EXCEPTION '017 smoke: assignment_epoch accepted a direct write';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%assignment_epoch is maintained%' THEN RAISE; END IF;
    END;
    BEGIN
      -- NULL avoids an unrelated active-slot collision, so this assertion
      -- proves the immutability guard itself is load-bearing.
      UPDATE bookings SET customer_id = NULL WHERE id = v_booking_legacy;
      RAISE EXCEPTION '017 smoke: customer_id accepted a direct write';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%customer_id is immutable%' THEN RAISE; END IF;
    END;

    v_result := accept_quote_edit(
      v_auth_legacy, v_customer_legacy, v_op_edit, repeat('d',64),
      v_booking_legacy, 2, 'verified', v_jti_edit, repeat('d',64),
      v_payload, 20.00, 'smoke-edit-place', 'MIA', 'tesla',
      jsonb_build_object(
        'passengers',2,'pickup_datetime',v_pickup_at::TEXT,'duration_minutes',777,
        'customer_name','Updated Passenger','customer_phone','0000000019',
        'customer_email','updated@example.invalid',
        'booker_name','Updated Booker','booker_phone','0000000020',
        'payment_method','zelle','notes',''
      )
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated' OR NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_legacy
        AND details_version = 3 AND assignment_epoch = 2
        AND duration_minutes = 777 AND price = 20.00
        AND price_authority = 'client_observe' AND route_authority = 'canonical'
        AND customer_name = 'Updated Passenger' AND customer_phone = '0000000019'
        AND customer_email = 'updated@example.invalid'
        AND booker_name = 'Updated Booker' AND booker_phone = '0000000020'
        AND payment_method = 'zelle'
        AND flight_number = 'AA100' AND notes = 'keep-note'
        AND pickup_sign = 'KEEP-SIGN' AND promo_code = 'KEEP-PROMO'
        AND host_commission = 2.00
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_acceptances WHERE booking_id = v_booking_legacy
        AND purpose = 'edit' AND jti = v_jti_edit
    ) THEN
      RAISE EXCEPTION '017 smoke: quoted edit/epoch/duration contract failed';
    END IF;
    v_result := accept_quote_edit(
      v_auth_legacy, v_customer_legacy, v_op_edit, repeat('d',64),
      v_booking_legacy, 2, 'verified', v_jti_edit, repeat('d',64),
      v_payload, 20.00, 'smoke-edit-place', 'MIA', 'tesla',
      jsonb_build_object(
        'passengers',2,'pickup_datetime',v_pickup_at::TEXT,'duration_minutes',777,
        'customer_name','Updated Passenger','customer_phone','0000000019',
        'customer_email','updated@example.invalid',
        'booker_name','Updated Booker','booker_phone','0000000020',
        'payment_method','zelle','notes',''
      )
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'idempotent' THEN
      RAISE EXCEPTION '017 smoke: quoted edit retry was not idempotent';
    END IF;
    v_result := accept_quote_create(
      v_auth_legacy, v_customer_legacy, gen_random_uuid(), repeat('0',64),
      'verify_failed', NULL, repeat('d',64), NULL, 20.00,
      NULL, NULL, NULL,
      v_booking_json || jsonb_build_object('trip_id','MIG017-PURPOSE-REFUSAL')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'refused'
       OR EXISTS (SELECT 1 FROM bookings WHERE trip_id = 'MIG017-PURPOSE-REFUSAL') THEN
      RAISE EXCEPTION '017 smoke: edit-token digest crossed into create';
    END IF;

    -- Enforce refuses legacy missing IDs and independently rechecks expiry,
    -- after all exact retry paths. Neither refusal creates/consumes anything.
    PERFORM set_pricing_mode('enforce', 'migration-017-smoke');

    -- Load-bearing money path: the token fare wins in enforce even when the
    -- caller submits a different browser price. Commission is derived from
    -- the active host rate, and observed client cents are not accepted truth.
    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_enforce_create::text,
      'purpose','create','authUserId',v_auth_enforce::text,
      'customerId',v_customer_enforce::text,'vehicle','escalade',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('1',64),
      'routeQuality','traffic_aware','finalCents',13200,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 1000,'exp',v_now_ms + 899000
    );
    v_booking_json := jsonb_build_object(
      'trip_id','MIG017-ENFORCE','customer_name','Enforce Passenger',
      'customer_phone','0000000021','customer_email','enforce@example.invalid',
      'pickup_location','smoke-origin','dropoff_location','smoke-destination',
      'pickup_datetime',v_pickup_at::TEXT,'passengers',3,'bags',1,
      'vehicle_type','suv','vehicle_name','Cadillac Escalade',
      'booking_mode','dropoff','payment_method','cash','duration_minutes',55,
      'referred_by_host',v_host::TEXT,'host_commission',999.99,
      'source','website'
    );
    v_result := accept_quote_create(
      v_auth_enforce, v_customer_enforce, v_op_enforce_create, repeat('1',64),
      'verified', v_jti_enforce_create, repeat('1',64), v_payload,
      1.00, 'enforce-place-id', 'MIA', 'escalade', v_booking_json
    );
    v_booking_enforce := (v_result->>'booking_id')::UUID;
    IF v_result->>'outcome' IS DISTINCT FROM 'created' OR NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_enforce
        AND price = 132.00 AND price_cents = 13200
        AND price_authority = 'server_quote' AND duration_minutes = 55
        AND host_commission = 13.20
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_acceptances WHERE booking_id = v_booking_enforce
        AND purpose = 'create' AND final_cents = 13200
        AND client_cents IS NULL AND authority = 'server_quote'
    ) THEN
      RAISE EXCEPTION '017 smoke: enforce create did not use server money';
    END IF;

    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_enforce_edit::text,
      'purpose','edit','authUserId',v_auth_enforce::text,
      'customerId',v_customer_enforce::text,'bookingId',v_booking_enforce::text,
      'assignmentEpoch',0,'vehicle','sprinter',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('2',64),
      'routeQuality','traffic_aware','finalCents',14500,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 1000,'exp',v_now_ms + 899000
    );
    v_result := accept_quote_edit(
      v_auth_enforce, v_customer_enforce, v_op_enforce_edit, repeat('2',64),
      v_booking_enforce, 1, 'verified', v_jti_enforce_edit, repeat('2',64),
      v_payload, 2.00, 'enforce-edit-place', 'FLL', 'sprinter',
      jsonb_build_object(
        'pickup_datetime',v_pickup_at::TEXT,'pickup_location','changed-origin',
        'dropoff_location','changed-destination','passengers',4,'bags',2,
        'booking_mode','pickup','duration_minutes',61,
        'customer_name','Enforce Passenger','customer_phone','0000000021',
        'payment_method','cash'
      )
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated' OR NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_enforce
        AND price = 145.00 AND price_cents = 14500
        AND price_authority = 'server_quote' AND host_commission = 14.50
        AND duration_minutes = 61 AND details_version = 2
    ) OR NOT EXISTS (
      SELECT 1 FROM quote_acceptances WHERE booking_id = v_booking_enforce
        AND purpose = 'edit' AND final_cents = 14500
        AND client_cents IS NULL AND authority = 'server_quote'
    ) THEN
      RAISE EXCEPTION '017 smoke: enforce edit did not use server money';
    END IF;

    v_result := accept_quote_edit(
      v_auth_enforce, v_customer_enforce, gen_random_uuid(), repeat('3',64),
      v_booking_enforce, 2, 'no_token', NULL, NULL, NULL, 145.00,
      NULL, NULL, NULL, '{}'::JSONB
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_required' THEN
      RAISE EXCEPTION '017 smoke: enforce edit accepted no token';
    END IF;

    v_result := accept_quote_create(
      v_auth_assigned, v_customer_assigned, v_op_enforce_no_token, repeat('3',64),
      'no_token', NULL, NULL, NULL, 10.00, NULL, NULL, NULL,
      v_booking_json || jsonb_build_object('trip_id','MIG017-ENFORCE-NO-TOKEN')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_required'
       OR EXISTS (SELECT 1 FROM bookings WHERE trip_id = 'MIG017-ENFORCE-NO-TOKEN') THEN
      RAISE EXCEPTION '017 smoke: enforce accepted a no-token create';
    END IF;
    v_result := accept_quote_create(
      v_auth_assigned, v_customer_assigned, v_op_enforce_invalid, repeat('4',64),
      'verify_failed', NULL, repeat('4',64), NULL, 10.00,
      NULL, NULL, NULL,
      v_booking_json || jsonb_build_object('trip_id','MIG017-ENFORCE-INVALID')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_invalid'
       OR EXISTS (SELECT 1 FROM bookings WHERE trip_id = 'MIG017-ENFORCE-INVALID') THEN
      RAISE EXCEPTION '017 smoke: enforce accepted an invalid token';
    END IF;

    BEGIN
      INSERT INTO bookings (
        customer_id, customer_name, customer_phone,
        pickup_location, dropoff_location, pickup_datetime,
        vehicle_type, price, status, source
      ) VALUES (
        v_customer_enforce, 'must-refuse', '0000000021', 'a', 'b',
        v_pickup_at, 'sedan', 1.00, 'completed', 'website'
      );
      RAISE EXCEPTION '017 smoke: direct INSERT survived enforcement';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%client-priced booking writes are closed%' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE bookings SET price = 1.00, pickup_location = 'must-refuse'
        WHERE id = v_booking_enforce;
      RAISE EXCEPTION '017 smoke: direct ride-intent UPDATE survived enforcement';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%ride-intent columns are closed%' THEN RAISE; END IF;
    END;

    -- Lifecycle-only writes remain available after the high-water mark.
    UPDATE bookings SET status = 'confirmed', assigned_driver = v_driver
      WHERE id = v_booking_enforce;
    UPDATE bookings SET status = 'cancelled', cancelled_at = now()
      WHERE id = v_booking_enforce;
    IF NOT EXISTS (
      SELECT 1 FROM bookings WHERE id = v_booking_enforce
        AND status = 'cancelled' AND assignment_epoch = 1 AND active_slot IS NULL
    ) THEN
      RAISE EXCEPTION '017 smoke: enforcement blocked lifecycle updates';
    END IF;

    v_result := accept_quote_create(
      v_auth_assigned, v_customer_assigned, NULL, NULL, 'no_token',
      NULL, NULL, NULL, 10.00, NULL, NULL, NULL, v_booking_json
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'outdated_client' THEN
      RAISE EXCEPTION '017 smoke: enforce accepted a missing operation id';
    END IF;
    v_payload := jsonb_build_object(
      'v',2,'kid','migration-017-smoke','jti',v_jti_expired::text,
      'purpose','create','authUserId',v_auth_assigned::text,
      'customerId',v_customer_assigned::text,'vehicle','tesla',
      'pickupAtMs',v_now_ms + 86400000,'commitment',repeat('e',64),
      'routeQuality','traffic_aware','finalCents',1000,
      'pricingVersion','smoke','engineVersion','smoke','resolvedVersion','smoke',
      'iat',v_now_ms - 900001,'exp',v_now_ms - 1
    );
    v_result := accept_quote_create(
      v_auth_assigned, v_customer_assigned, gen_random_uuid(), repeat('e',64),
      'verified', v_jti_expired, repeat('e',64), v_payload,
      10.00, 'expired-place', 'MIA', 'tesla', v_booking_json
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'quote_expired'
       OR EXISTS (SELECT 1 FROM quote_acceptances WHERE jti = v_jti_expired) THEN
      RAISE EXCEPTION '017 smoke: database accepted a newly expired quote';
    END IF;

    PERFORM set_pricing_mode('blocked', 'migration-017-smoke');
    BEGIN
      INSERT INTO bookings (
        customer_id, customer_name, customer_phone,
        pickup_location, dropoff_location, pickup_datetime,
        vehicle_type, price, status, source
      ) VALUES (
        v_customer_enforce, 'must-block', '0000000021', 'a', 'b',
        v_pickup_at, 'sedan', 1.00, 'pending', 'website'
      );
      RAISE EXCEPTION '017 smoke: direct INSERT survived blocked mode';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%temporarily blocked%' THEN RAISE; END IF;
    END;
    v_result := accept_quote_create(
      v_auth_assigned, v_customer_assigned, gen_random_uuid(), repeat('f',64),
      'no_token', NULL, NULL, NULL, 10.00, NULL, NULL, NULL, v_booking_json
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'blocked' THEN
      RAISE EXCEPTION '017 smoke: blocked mode did not refuse create';
    END IF;
    v_result := accept_optional_edit(
      v_auth_legacy, v_customer_legacy, v_op_blocked_optional, repeat('5',64),
      v_booking_legacy, 3, jsonb_build_object('notes','blocked-optional-smoke')
    );
    IF v_result->>'outcome' IS DISTINCT FROM 'updated'
       OR (v_result->>'details_version')::INTEGER IS DISTINCT FROM 4 THEN
      RAISE EXCEPTION '017 smoke: blocked mode refused an optional-only edit';
    END IF;
    PERFORM set_pricing_mode('enforce', 'migration-017-smoke');
    BEGIN
      PERFORM set_pricing_mode('observe', 'migration-017-smoke');
      RAISE EXCEPTION '017 smoke: high-water valve reopened observe';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%invalid pricing mode transition enforce -> observe%' THEN RAISE; END IF;
    END;

    -- Explicit teardown exercises FK-safe cleanup as a second belt. The
    -- sentinel below still rolls back this cleanup and every earlier mutation,
    -- including pricing_state/audit changes, so the smoke is self-contained.
    DELETE FROM quote_acceptances
      WHERE booking_id IN (v_booking_legacy, v_booking_off, v_booking_quote,
                           v_booking_assigned, v_booking_enforce);
    DELETE FROM quote_verifications
      WHERE identity_hash IN (
        encode(extensions.digest(v_auth_legacy::text, 'sha256'), 'hex'),
        encode(extensions.digest(v_auth_quote::text, 'sha256'), 'hex'),
        encode(extensions.digest(v_auth_assigned::text, 'sha256'), 'hex'),
        encode(extensions.digest(v_auth_enforce::text, 'sha256'), 'hex'),
        repeat('7',64)
      );
    DELETE FROM operation_receipts
      WHERE booking_id IN (v_booking_legacy, v_booking_off, v_booking_quote,
                           v_booking_assigned, v_booking_enforce);
    DELETE FROM bookings
      WHERE id IN (v_booking_legacy, v_booking_off, v_booking_quote,
                   v_booking_assigned, v_booking_enforce);
    DELETE FROM hosts WHERE name LIKE 'MIGRATION-017-SMOKE-%';
    DELETE FROM drivers WHERE id = v_driver;
    DELETE FROM customers
      WHERE id IN (v_customer_legacy, v_customer_quote, v_customer_assigned,
                   v_customer_enforce);

    -- Force rollback of every smoke mutation while preserving the DDL outside
    -- this nested subtransaction.
    RAISE EXCEPTION USING ERRCODE = 'ZZ017', MESSAGE = 'MIGRATION_017_SMOKE_ROLLBACK';
  EXCEPTION WHEN SQLSTATE 'ZZ017' THEN
    IF SQLERRM <> 'MIGRATION_017_SMOKE_ROLLBACK' THEN RAISE; END IF;
  END;

  -- Sequence increments are not transactional in PostgreSQL. Restore both
  -- identity sequences explicitly so even the smoke's counters leave no
  -- persistent footprint.
  PERFORM setval('public.pricing_state_audit_id_seq', v_audit_seq_last, v_audit_seq_called);
  PERFORM setval('public.quote_verifications_id_seq', v_verify_seq_last, v_verify_seq_called);
  IF EXISTS (
    SELECT 1 FROM pricing_state_audit_id_seq
    WHERE last_value IS DISTINCT FROM v_audit_seq_last
       OR is_called IS DISTINCT FROM v_audit_seq_called
  ) OR EXISTS (
    SELECT 1 FROM quote_verifications_id_seq
    WHERE last_value IS DISTINCT FROM v_verify_seq_last
       OR is_called IS DISTINCT FROM v_verify_seq_called
  ) THEN
    RAISE EXCEPTION '017 smoke residue: identity sequence state changed';
  END IF;

  -- Final smoke residue proof: counts, state, and sequences must match their
  -- pre-smoke values; no throwaway actor, booking, receipt, audit, or evidence.
  IF (SELECT count(*) FROM bookings) <> v_bookings_before
     OR (SELECT count(*) FROM customers) <> v_customers_before
     OR (SELECT count(*) FROM hosts) <> v_hosts_before
     OR (SELECT count(*) FROM drivers) <> v_drivers_before
     OR (SELECT count(*) FROM quote_acceptances) <> v_accept_before
     OR (SELECT count(*) FROM quote_verifications) <> v_verify_before
     OR (SELECT count(*) FROM operation_receipts) <> v_receipts_before
     OR (SELECT count(*) FROM pricing_state_audit) <> v_audit_before THEN
    RAISE EXCEPTION '017 smoke residue: rollback-contained behavior test changed row counts';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pricing_state
    WHERE singleton AND mode = 'off' AND enforcement_started_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM customers WHERE name LIKE 'MIGRATION-017-SMOKE-%'
  ) OR EXISTS (
    SELECT 1 FROM drivers WHERE name = 'MIGRATION-017-SMOKE-DRIVER'
  ) OR EXISTS (
    SELECT 1 FROM bookings WHERE trip_id LIKE 'MIG017-%'
  ) THEN
    RAISE EXCEPTION '017 smoke residue: state or named throwaway rows survived';
  END IF;
END $migration_017_smoke$;

-- PostgREST reads function/table shape from a cache; reload it before COMMIT.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- EMERGENCY ROLLBACK — complete reversal of migration 017.
-- Copy, uncomment, review, and run only while all pricing writers are paused.
-- Historical `price` values remain; the added audit tables/columns are removed.
-- DESTRUCTIVE CONSEQUENCES: this erases quote-consumption history, operation
-- receipts, verification telemetry, the reviewed actor classification, and
-- the enforcement high-water mark. A previously consumed quote/operation can
-- therefore be presented again after a later reinstallation. Take a PITR
-- marker first and use this only as a last-resort rollback while all booking
-- writers are disabled.
-- ============================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS bookings_guard_trg ON bookings;
-- DROP TRIGGER IF EXISTS pricing_state_guard_trg ON pricing_state;
-- DROP TRIGGER IF EXISTS pricing_state_truncate_guard_trg ON pricing_state;
-- DROP TRIGGER IF EXISTS pricing_state_audit_guard_trg ON pricing_state_audit;
-- DROP TRIGGER IF EXISTS pricing_state_audit_truncate_guard_trg ON pricing_state_audit;
-- DROP FUNCTION IF EXISTS accept_optional_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, JSONB);
-- DROP FUNCTION IF EXISTS accept_quote_edit(UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, TEXT, TEXT, JSONB);
-- DROP FUNCTION IF EXISTS accept_quote_create(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, JSONB, NUMERIC, TEXT, TEXT, TEXT, JSONB);
-- DROP FUNCTION IF EXISTS set_pricing_mode(TEXT, TEXT);
-- DROP FUNCTION IF EXISTS bookings_guard();
-- DROP FUNCTION IF EXISTS pricing_state_guard();
-- DROP TABLE IF EXISTS operation_receipts;
-- DROP TABLE IF EXISTS quote_verifications;
-- DROP TABLE IF EXISTS quote_acceptances;
-- DROP TABLE IF EXISTS pricing_state_audit;
-- DROP TABLE IF EXISTS pricing_state;
-- DROP INDEX IF EXISTS bookings_one_active_per_customer;
-- ALTER TABLE bookings ALTER COLUMN price DROP NOT NULL;
-- ALTER TABLE bookings
--   DROP CONSTRAINT IF EXISTS bookings_assignment_epoch_check,
--   DROP CONSTRAINT IF EXISTS bookings_price_nonnegative_check,
--   DROP CONSTRAINT IF EXISTS bookings_price_cents_equal_check,
--   DROP CONSTRAINT IF EXISTS bookings_route_identity_check,
--   DROP CONSTRAINT IF EXISTS bookings_route_authority_check,
--   DROP CONSTRAINT IF EXISTS bookings_price_authority_check,
--   DROP COLUMN IF EXISTS route_authority,
--   DROP COLUMN IF EXISTS airport_code,
--   DROP COLUMN IF EXISTS canonical_place_id,
--   DROP COLUMN IF EXISTS assignment_epoch,
--   DROP COLUMN IF EXISTS active_slot,
--   DROP COLUMN IF EXISTS multi_booking_exempt,
--   DROP COLUMN IF EXISTS price_authority,
--   DROP COLUMN IF EXISTS price_cents;
-- DO $rollback_017_verify$
-- DECLARE
--   v_count BIGINT;
-- BEGIN
--   IF to_regclass('public.pricing_state') IS NOT NULL
--      OR to_regclass('public.pricing_state_audit') IS NOT NULL
--      OR to_regclass('public.quote_acceptances') IS NOT NULL
--      OR to_regclass('public.quote_verifications') IS NOT NULL
--      OR to_regclass('public.operation_receipts') IS NOT NULL
--      OR to_regclass('public.bookings_one_active_per_customer') IS NOT NULL THEN
--     RAISE EXCEPTION '017 rollback self-check: relation or index residue remains';
--   END IF;
--
--   SELECT count(*) INTO v_count
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname IN (
--     'set_pricing_mode','accept_quote_create','accept_quote_edit',
--     'accept_optional_edit','bookings_guard','pricing_state_guard'
--   );
--   IF v_count <> 0 THEN
--     RAISE EXCEPTION '017 rollback self-check: % function overload(s) remain', v_count;
--   END IF;
--
--   SELECT count(*) INTO v_count
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'bookings'
--     AND column_name IN (
--       'price_cents','price_authority','multi_booking_exempt','active_slot',
--       'assignment_epoch','canonical_place_id','airport_code','route_authority'
--     );
--   IF v_count <> 0 THEN
--     RAISE EXCEPTION '017 rollback self-check: % bookings column(s) remain', v_count;
--   END IF;
--
--   IF EXISTS (
--     SELECT 1 FROM pg_attribute a
--     WHERE a.attrelid = 'public.bookings'::regclass
--       AND a.attname = 'price' AND a.attnotnull
--   ) OR EXISTS (
--     SELECT 1 FROM pg_constraint c
--     WHERE c.conrelid = 'public.bookings'::regclass
--       AND c.conname IN (
--         'bookings_assignment_epoch_check','bookings_price_nonnegative_check',
--         'bookings_price_cents_equal_check','bookings_route_identity_check',
--         'bookings_route_authority_check','bookings_price_authority_check'
--       )
--   ) OR EXISTS (
--     SELECT 1 FROM pg_trigger t
--     JOIN pg_class c ON c.oid = t.tgrelid
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE n.nspname = 'public' AND t.tgname IN (
--       'bookings_guard_trg','pricing_state_guard_trg',
--       'pricing_state_truncate_guard_trg','pricing_state_audit_guard_trg',
--       'pricing_state_audit_truncate_guard_trg'
--     )
--   ) THEN
--     RAISE EXCEPTION '017 rollback self-check: booking contract or trigger residue remains';
--   END IF;
-- END $rollback_017_verify$;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
