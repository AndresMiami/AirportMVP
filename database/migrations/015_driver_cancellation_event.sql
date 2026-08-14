-- Migration 015: driver cancellation event in the outbox trigger (PR 3B).
--
-- ROLLOUT (Codex-chosen option b, mirrors the 013 rollout):
--   1. Netlify: set WATCHDOG_DISABLED=1, redeploy production.
--   2. Run THIS file unedited in the Supabase SQL Editor; expect
--      "Success. No rows returned" (the NOTICE is often swallowed —
--      a red ERROR is the only failure signal, and it rolls back).
--   3. Merge + deploy PR 3B.
--   4. Remove WATCHDOG_DISABLED, redeploy, watch the first cycle.
--   The window exists because a cancellation of an ACCEPTED ride
--   between this migration and the deploy would emit a ride_cancelled
--   driver event the OLD deployed code cannot render. Queued events
--   carry not_after = now()+6h — keep the window comfortably shorter.
--
-- What this changes: CREATE OR REPLACE of bookings_cancellation_outbox()
-- at its documented extension point (migration 013). The admin event is
-- unchanged; the function additionally inserts the assigned-driver
-- 'ride_cancelled' event when the cancelled row was an ACCEPTED ride
-- (confirmed / on_the_way / arrived with a driver). Passenger fee policy
-- is CLOCK-based and silent (PR 3B code); this trigger only creates the
-- notification intentions, atomically with the status flip, for every
-- cancellation path including manual admin SQL.
--
-- Numbering note: 015 is claimed by this migration; the reserved
-- one-active-booking constraint moves to 016.

BEGIN;

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

  -- Assigned-driver event (PR 3B): only when a driver had actually
  -- committed — the "do not proceed" that must never be missed.
  -- recipient_key is the driver AT cancellation time (OLD row), so a
  -- reassignment can never redirect the notice.
  IF OLD.assigned_driver IS NOT NULL
     AND OLD.status IN ('confirmed', 'on_the_way', 'arrived') THEN
    INSERT INTO notification_events
      (booking_id, event_type, recipient_role, recipient_key, state, due_at, not_after)
    VALUES
      (NEW.id, 'ride_cancelled', 'driver', OLD.assigned_driver::text, 'pending', now(), now() + interval '6 hours')
    ON CONFLICT ON CONSTRAINT notification_events_identity DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION bookings_cancellation_outbox() FROM PUBLIC, anon, authenticated;

-- The trigger itself (from migration 013) is unchanged; recreating the
-- function body is sufficient. Assert it still exists and fires on the
-- same condition, then LIVE-smoke both event branches.

DO $$
DECLARE
  n INTEGER;
  smoke_id UUID;
  smoke_driver UUID;
BEGIN
  -- Trigger still present and enabled on bookings
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'bookings' AND t.tgname = 'trg_bookings_cancellation_outbox'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: trg_bookings_cancellation_outbox missing';
  END IF;

  -- Function is SECURITY DEFINER with pinned search_path; clients cannot execute
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'bookings_cancellation_outbox'
      AND p.prosecdef
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%')
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: outbox function missing, not SECURITY DEFINER, or search_path unpinned';
  END IF;
  IF has_function_privilege('anon', 'public.bookings_cancellation_outbox()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.bookings_cancellation_outbox()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: client roles can execute the outbox function';
  END IF;

  -- LIVE SMOKE 1: an ACCEPTED-ride cancellation emits BOTH events.
  SELECT id INTO smoke_driver FROM drivers LIMIT 1;
  IF smoke_driver IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: no drivers row available for the smoke test';
  END IF;

  INSERT INTO bookings (customer_name, pickup_location, dropoff_location,
                        pickup_datetime, status, price, assigned_driver)
  VALUES ('MIGRATION-015-SMOKE', 'smoke-a', 'smoke-b',
          now() + interval '1 day', 'confirmed', 55.00, smoke_driver)
  RETURNING id INTO smoke_id;

  UPDATE bookings SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_from_status = 'confirmed',
    cancelled_by = 'admin',
    cancel_pickup_at = now() + interval '1 day',
    cancel_policy_version = 'migration-015-smoke',
    cancel_fee_percent = 50,
    cancel_fee_policy_amount = 27.50,
    cancel_fee_collected = 0,
    cancel_waiver_reason = 'pilot_waiver',
    cancel_waived_by = 'system'
  WHERE id = smoke_id AND status = 'confirmed';

  SELECT count(*) INTO n FROM notification_events
  WHERE booking_id = smoke_id AND event_type = 'ride_cancelled_admin'
    AND recipient_role = 'admin' AND state = 'pending';
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: expected 1 admin event, found %', n;
  END IF;
  SELECT count(*) INTO n FROM notification_events
  WHERE booking_id = smoke_id AND event_type = 'ride_cancelled'
    AND recipient_role = 'driver' AND recipient_key = smoke_driver::text
    AND state = 'pending';
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: expected 1 driver event keyed to the assigned driver, found %', n;
  END IF;

  DELETE FROM bookings WHERE id = smoke_id;
  SELECT count(*) INTO n FROM notification_events WHERE booking_id = smoke_id;
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: smoke events survived booking deletion (% rows)', n;
  END IF;

  -- LIVE SMOKE 2: a PENDING (unassigned) cancellation emits ONLY the
  -- admin event — no driver, no driver notice.
  INSERT INTO bookings (customer_name, pickup_location, dropoff_location,
                        pickup_datetime, status, price)
  VALUES ('MIGRATION-015-SMOKE-2', 'smoke-a', 'smoke-b',
          now() + interval '1 day', 'pending', 55.00)
  RETURNING id INTO smoke_id;

  UPDATE bookings SET
    status = 'cancelled', cancelled_at = now(), cancelled_from_status = 'pending',
    cancelled_by = 'admin', cancel_pickup_at = now() + interval '1 day',
    cancel_policy_version = 'migration-015-smoke', cancel_fee_percent = 0,
    cancel_fee_policy_amount = 0, cancel_fee_collected = 0
  WHERE id = smoke_id AND status = 'pending';

  SELECT count(*) INTO n FROM notification_events WHERE booking_id = smoke_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: pending cancel must emit exactly the admin event, found %', n;
  END IF;
  SELECT count(*) INTO n FROM notification_events
  WHERE booking_id = smoke_id AND event_type = 'ride_cancelled';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: pending cancel must never emit a driver event';
  END IF;

  DELETE FROM bookings WHERE id = smoke_id;

  RAISE NOTICE 'DRIVER CANCELLATION EVENT VERIFIED: accepted-ride cancels emit admin+driver events atomically; pending cancels stay admin-only; clean teardown.';
END $$;

COMMIT;

-- ============================================================
-- COMPLETE EMERGENCY ROLLBACK — restores the migration-013 (admin-only)
-- function body. Copy, uncomment, and run only if PR 3B must be reversed.
-- ============================================================
-- BEGIN;
-- CREATE OR REPLACE FUNCTION bookings_cancellation_outbox()
-- RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
-- SET search_path = public, pg_temp AS $$
-- BEGIN
--   INSERT INTO notification_events
--     (booking_id, event_type, recipient_role, recipient_key, state, due_at, not_after)
--   VALUES
--     (NEW.id, 'ride_cancelled_admin', 'admin', 'admin', 'pending', now(), now() + interval '6 hours')
--   ON CONFLICT ON CONSTRAINT notification_events_identity DO NOTHING;
--   RETURN NEW;
-- END;
-- $$;
-- COMMIT;
