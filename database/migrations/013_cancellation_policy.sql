-- Migration 013: Cancellation policy shadow audit + atomic notification
-- outbox (PR 1A — pending cancellation only).
--
-- Run in the Supabase SQL Editor BEFORE merging the PR: everything here is
-- ADDITIVE and invisible to the running code. The whole migration is ONE
-- transaction with self-verification (including a live outbox smoke test)
-- at the end: if ANY assertion fails, everything rolls back and the
-- database is untouched. Safe to run unedited, top to bottom, and safe to
-- re-run.
--
-- What this creates:
--   * bookings: cancellation shadow-audit columns. Every cancellation
--     records status-at-cancellation, the pickup snapshot, the policy
--     version, the HYPOTHETICAL fee, the collected amount ($0 during the
--     pilot — enforced by CHECK), waiver state, who cancelled (role +
--     auth.users UUID), and when. These are the rows a future card-
--     authorization phase compares against.
--   * bookings_cancellation_outbox(): an AFTER UPDATE trigger that
--     atomically inserts the 'ride_cancelled_admin' notification event in
--     the SAME transaction as any status -> 'cancelled' flip. This is the
--     durability fix from the Codex v4 review: a cancelled ride can never
--     exist without its ledger event, no matter which path cancelled it —
--     the API handlers AND the manual admin runbook below both get outbox
--     coverage for free. Delivery stays with the watchdog (~5 min bound).
--
-- PR 1A scope note: the trigger emits the ADMIN event only. PR 2
-- (confirmed-ride cancellation) will CREATE OR REPLACE the function to
-- also emit the assigned-driver 'ride_cancelled' event when
-- OLD.assigned_driver IS NOT NULL and OLD.status was an accepted status.
-- Until then a manual admin cancellation of an accepted ride notifies the
-- admin chat (where today's driver also lives) — never silence.
--
-- MANUAL UN-CANCEL WARNING: the outbox identity is UNIQUE (booking_id,
-- event_type, recipient_key) with ON CONFLICT DO NOTHING, so if a
-- cancelled booking is ever manually flipped back and cancelled AGAIN,
-- the second cancellation emits NO new admin event (the first row already
-- exists). Un-cancelling is not a supported flow; if it is ever done by
-- hand, also delete the booking's ride_cancelled_admin row from
-- notification_events so a later re-cancellation can notify.
--
-- PILOT-SCOPED CONSTRAINTS (deliberate): CHECK (cancel_fee_collected = 0)
-- and CHECK (cancel_fee_percent IN (0, 50, 100)) encode the pilot policy.
-- The future real-collection migration relaxes them deliberately;
-- cancel_policy_version records which regime stamped each row.
--
-- ============================================================
-- ADMIN RUNBOOK — driver/LinkMia-failure FREE cancellation (manual pilot
-- procedure; there is no admin endpoint — the retired admin page stays
-- retired). Run in the SQL Editor, replacing <booking-uuid>. The outbox
-- trigger emits the admin ledger event automatically.
--
-- UPDATE bookings SET
--   status = 'cancelled',
--   cancelled_at = now(),
--   cancelled_from_status = status,
--   cancelled_by = 'admin',
--   cancel_actor_user_id = NULL,  -- or the admin's auth.users UUID
--   cancel_pickup_at = pickup_datetime,
--   cancel_policy_version = 'pilot-2026-08',
--   cancel_fee_percent = 0,
--   cancel_fee_policy_amount = 0,
--   cancel_fee_collected = 0,
--   cancel_waiver_reason = 'driver_failure',
--   cancel_waived_by = 'admin',
--   driver_lat = NULL, driver_lng = NULL, driver_location_at = NULL
-- WHERE id = '<booking-uuid>'
--   AND status IN ('pending', 'confirmed', 'on_the_way', 'arrived');
-- ============================================================

BEGIN;

-- ============================================================
-- STEP 1: bookings — cancellation shadow-audit columns.
-- Plain ADD COLUMN (the SELECT * views predate these columns, so no view
-- needs dropping). Column-level CHECKs ride the IF NOT EXISTS clause, so
-- re-running skips them cleanly. All CHECKs are NULL-tolerant: historical
-- and non-cancelled rows are untouched.
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancelled_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_from_status    TEXT
      CHECK (cancelled_from_status IN ('pending', 'confirmed', 'on_the_way', 'arrived')),
  ADD COLUMN IF NOT EXISTS cancelled_by             TEXT
      CHECK (cancelled_by IN ('passenger_auth', 'uuid_link', 'admin')),
  -- Role explains HOW; the UUID identifies WHO. NULL for uuid_link
  -- (capability-link cancellations carry no verified identity).
  ADD COLUMN IF NOT EXISTS cancel_actor_user_id     UUID
      REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Pickup snapshot at cancellation time: pickup_datetime is immutable
  -- today, but future reschedules will mutate it — the snapshot keeps the
  -- audit self-contained and anchors the late-change policy (Stage 3).
  ADD COLUMN IF NOT EXISTS cancel_pickup_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_policy_version    TEXT,
  ADD COLUMN IF NOT EXISTS cancel_fee_percent       NUMERIC(5,2)
      CHECK (cancel_fee_percent IN (0, 50, 100)),
  ADD COLUMN IF NOT EXISTS cancel_fee_policy_amount NUMERIC(10,2)
      CHECK (cancel_fee_policy_amount >= 0),
  -- Pilot: shadow fees are RECORDED, never collected. Enforced here so a
  -- code bug cannot invent a real charge.
  ADD COLUMN IF NOT EXISTS cancel_fee_collected     NUMERIC(10,2)
      CHECK (cancel_fee_collected = 0),
  ADD COLUMN IF NOT EXISTS cancel_waiver_reason     TEXT
      CHECK (cancel_waiver_reason IN ('pilot_waiver', 'driver_failure')),
  ADD COLUMN IF NOT EXISTS cancel_waived_by         TEXT
      CHECK (cancel_waived_by IN ('system', 'admin'));

-- The auth.users FK needs a supporting index or every auth-user deletion
-- (dashboard cleanups) seq-scans bookings for the ON DELETE SET NULL.
-- Partial: only cancelled-by-authenticated-owner rows carry a value.
CREATE INDEX IF NOT EXISTS idx_bookings_cancel_actor
  ON bookings (cancel_actor_user_id)
  WHERE cancel_actor_user_id IS NOT NULL;

-- ============================================================
-- STEP 2: cancellation outbox trigger — event creation is ATOMIC with the
-- status flip. SECURITY DEFINER (created by postgres in the SQL Editor)
-- with a pinned search_path, so the insert succeeds regardless of the
-- caller's grants on notification_events (RLS default-deny, migration
-- 011). ON CONFLICT on the event identity keeps it idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION bookings_cancellation_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Admin operational event: every cancellation, every path. due now;
  -- not_after is a generous absolute leash (NEVER pickup-anchored — a
  -- near-pickup cancellation must still be deliverable).
  INSERT INTO notification_events
    (booking_id, event_type, recipient_role, recipient_key, state, due_at, not_after)
  VALUES
    (NEW.id, 'ride_cancelled_admin', 'admin', 'admin', 'pending', now(), now() + interval '6 hours')
  ON CONFLICT ON CONSTRAINT notification_events_identity DO NOTHING;

  -- PR 2 adds here: the assigned-driver 'ride_cancelled' event when
  -- OLD.assigned_driver IS NOT NULL AND OLD.status IN
  -- ('confirmed', 'on_the_way', 'arrived').
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION bookings_cancellation_outbox() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bookings_cancellation_outbox ON bookings;
CREATE TRIGGER trg_bookings_cancellation_outbox
  AFTER UPDATE OF status ON bookings
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION bookings_cancellation_outbox();

-- ============================================================
-- STEP 3: SELF-VERIFICATION — any failure raises and rolls back the
-- entire migration (011 discipline), including a LIVE smoke test of the
-- outbox trigger using a throwaway booking that is deleted before commit.
-- ============================================================

DO $$
DECLARE
  cancel_cols TEXT[] := ARRAY['cancelled_at', 'cancelled_from_status', 'cancelled_by',
                              'cancel_actor_user_id', 'cancel_pickup_at',
                              'cancel_policy_version', 'cancel_fee_percent',
                              'cancel_fee_policy_amount', 'cancel_fee_collected',
                              'cancel_waiver_reason', 'cancel_waived_by'];
  col TEXT;
  n INTEGER;
  smoke_id UUID;
BEGIN
  -- 3a: all audit columns present
  FOREACH col IN ARRAY cancel_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = col
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: bookings.% missing', col;
    END IF;
  END LOOP;

  -- 3b: the pilot CHECK constraints exist
  FOREACH col IN ARRAY ARRAY['cancelled_from_status', 'cancelled_by', 'cancel_fee_percent',
                             'cancel_fee_policy_amount', 'cancel_fee_collected',
                             'cancel_waiver_reason', 'cancel_waived_by'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      WHERE c.relname = 'bookings' AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%' || col || '%'
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: CHECK constraint on bookings.% missing', col;
    END IF;
  END LOOP;

  -- 3c: outbox function is SECURITY DEFINER with a pinned search_path,
  -- and client roles cannot execute it directly
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'bookings_cancellation_outbox'
      AND p.prosecdef
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: bookings_cancellation_outbox missing, not SECURITY DEFINER, or search_path unpinned';
  END IF;
  IF has_function_privilege('anon', 'public.bookings_cancellation_outbox()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.bookings_cancellation_outbox()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: client roles can execute the outbox function';
  END IF;

  -- 3d: trigger exists on bookings
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'bookings' AND t.tgname = 'trg_bookings_cancellation_outbox'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: trg_bookings_cancellation_outbox missing';
  END IF;

  -- 3e: LIVE smoke test — cancel a throwaway booking, assert exactly one
  -- outbox event, assert the trigger does NOT re-fire on an already-
  -- cancelled row, then remove every trace (event rows cascade with the
  -- booking, migration 011 FK).
  INSERT INTO bookings (customer_name, pickup_location, dropoff_location,
                        pickup_datetime, status, price)
  VALUES ('MIGRATION-013-SMOKE', 'smoke-a', 'smoke-b',
          now() + interval '1 day', 'pending', 55.00)
  RETURNING id INTO smoke_id;

  UPDATE bookings SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_from_status = 'pending',
    cancelled_by = 'admin',
    cancel_pickup_at = now() + interval '1 day',
    cancel_policy_version = 'migration-013-smoke',
    cancel_fee_percent = 0,
    cancel_fee_policy_amount = 0,
    cancel_fee_collected = 0
  WHERE id = smoke_id AND status = 'pending';

  SELECT count(*) INTO n FROM notification_events
  WHERE booking_id = smoke_id AND event_type = 'ride_cancelled_admin'
    AND recipient_role = 'admin' AND recipient_key = 'admin' AND state = 'pending';
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: outbox smoke test expected 1 admin event, found %', n;
  END IF;

  -- Touching an already-cancelled row must not re-fire the outbox
  UPDATE bookings SET status = 'cancelled', notes = 'smoke-touch' WHERE id = smoke_id;
  SELECT count(*) INTO n FROM notification_events WHERE booking_id = smoke_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: outbox re-fired on already-cancelled row (% events)', n;
  END IF;

  DELETE FROM bookings WHERE id = smoke_id;
  SELECT count(*) INTO n FROM notification_events WHERE booking_id = smoke_id;
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: smoke event survived booking deletion (% rows)', n;
  END IF;

  RAISE NOTICE 'CANCELLATION POLICY VERIFIED: 11 audit columns with pilot CHECKs; outbox trigger SECURITY DEFINER/search_path-pinned/client-EXECUTE-revoked; live smoke test passed (event created atomically, no re-fire, clean teardown).';
END $$;

COMMIT;

-- ============================================================
-- COMPLETE EMERGENCY ROLLBACK — copy, uncomment, and run only if PR 1A
-- must be fully reversed. Safe: no view references these columns (all
-- created after every existing view), and the trigger/function are used
-- by nothing else.
-- ============================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_bookings_cancellation_outbox ON bookings;
-- DROP FUNCTION IF EXISTS bookings_cancellation_outbox();
-- ALTER TABLE bookings
--   DROP COLUMN IF EXISTS cancelled_at,
--   DROP COLUMN IF EXISTS cancelled_from_status,
--   DROP COLUMN IF EXISTS cancelled_by,
--   DROP COLUMN IF EXISTS cancel_actor_user_id,
--   DROP COLUMN IF EXISTS cancel_pickup_at,
--   DROP COLUMN IF EXISTS cancel_policy_version,
--   DROP COLUMN IF EXISTS cancel_fee_percent,
--   DROP COLUMN IF EXISTS cancel_fee_policy_amount,
--   DROP COLUMN IF EXISTS cancel_fee_collected,
--   DROP COLUMN IF EXISTS cancel_waiver_reason,
--   DROP COLUMN IF EXISTS cancel_waived_by;
-- COMMIT;
