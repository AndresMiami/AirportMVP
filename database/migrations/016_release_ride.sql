-- Migration 016: Release ride (PR 3C-1).
--
-- ROLLOUT (mirrors 013/015):
--   1. Netlify: set WATCHDOG_DISABLED=1, redeploy production.
--   2. Run THIS file unedited in the Supabase SQL Editor; expect
--      "Success. No rows returned" (the NOTICE is often swallowed —
--      a red ERROR is the only failure signal, and it rolls back).
--   3. Merge + deploy PR 3C-1.
--   4. Remove WATCHDOG_DISABLED, redeploy, watch the first cycle.
--   The flag window also guarantees PostgREST's schema-cache reload has
--   happened before the deployed code makes the repo's FIRST .rpc() call.
--
-- What this adds:
--   * booking_releases — the durable source of BOTH the release audit and
--     the notification intention. One row per (booking, driver) ever.
--   * release_booking() RPC — the ONLY supported release path: guarded
--     status flip + full commitment-state clear + history INSERT in ONE
--     transaction. Raw `UPDATE bookings SET status='pending'` is NOT a
--     supported release (no history, no event, no reaccept knowledge);
--     the supported manual/admin path is:
--       SELECT release_booking('<booking>','<driver>','other','reason');
--   * trg_booking_releases_outbox — AFTER INSERT on the history table
--     inserts the 'ride_released' ADMIN event (recipient_key = releasing
--     driver, so a second driver's release gets its own event identity),
--     due now, EXPLICIT six-hour not_after leash.
--   * trg_bookings_release_reaccept_guard — BEFORE UPDATE on bookings:
--     a driver who released a booking can never be assigned it again,
--     on ANY path (API accept or manual SQL).
--
-- Numbering note: the reserved one-active-booking constraint moves to 018+.

BEGIN;

-- ---------------------------------------------------------------
-- 1. Release history: durable audit + notification source.
-- ---------------------------------------------------------------
CREATE TABLE booking_releases (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  driver_id                   UUID NOT NULL REFERENCES drivers(id),
  details_version_at_release  INTEGER NOT NULL,
  -- Immutable snapshots: post-release the booking is pending again and
  -- therefore EDITABLE (PR #59) — the live row must never re-classify
  -- this release's urgency or audit.
  pickup_at_release           TIMESTAMPTZ NOT NULL,
  price_at_release            NUMERIC,
  driver_name_at_release      TEXT NOT NULL,
  reason                      TEXT NOT NULL CHECK (reason IN
    ('schedule_conflict', 'ride_details_changed', 'vehicle_issue', 'emergency', 'other')),
  note                        TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  CHECK (reason <> 'other' OR (note IS NOT NULL AND btrim(note) <> '')),
  released_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One release per driver per booking, ever. Booking_id-leading: also
  -- serves the reassigning EXISTS and the exact dispatch enrichment fetch.
  UNIQUE (booking_id, driver_id)
);

-- The requests-feed exclusion filters by driver_id ALONE — the UNIQUE
-- above is booking_id-leading and cannot serve it.
CREATE INDEX idx_booking_releases_driver ON booking_releases (driver_id);

-- Lockdown (migration-010 discipline): default-deny, zero client grants.
ALTER TABLE booking_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON booking_releases FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------
-- 2. The ONLY supported release path.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_booking(
  p_booking_id UUID,
  p_driver_id  UUID,
  p_reason     TEXT,
  p_note       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version INTEGER;
  v_pickup  TIMESTAMPTZ;
  v_price   NUMERIC;
  v_name    TEXT;
BEGIN
  -- Guarded flip + FULL commitment-state clear. A re-accepted ride must
  -- present as never-driven: acceptance, readiness, at-risk, checkpoint
  -- anchors, and coordinates all reset. Deliberately NO details_version
  -- CAS (Codex-approved): a driver escaping right after a passenger edit
  -- is the moment release matters most; the live version is RECORDED,
  -- never required.
  UPDATE bookings SET
    status = 'pending',
    assigned_driver = NULL,
    accepted_at = NULL,
    driver_ready_by = NULL,
    driver_ready_at = NULL,
    driver_ready_source = NULL,
    at_risk_at = NULL,
    on_the_way_at = NULL,
    arrived_at = NULL,
    started_at = NULL,
    driver_lat = NULL,
    driver_lng = NULL,
    driver_location_at = NULL
  WHERE id = p_booking_id
    AND status = 'confirmed'
    AND assigned_driver = p_driver_id
  RETURNING details_version, pickup_datetime, price
    INTO v_version, v_pickup, v_price;

  -- Non-STRICT INTO + FOUND: zero rows is a CLEAN concurrency conflict
  -- (the endpoint answers 409 from live truth), never an exception.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false);
  END IF;

  SELECT name INTO v_name FROM drivers WHERE id = p_driver_id;

  -- History INSERT in the SAME transaction; the AFTER INSERT trigger
  -- creates the admin notification event here too. Any failure (CHECK,
  -- UNIQUE, event insert) rolls back EVERYTHING — audit, state flip, and
  -- notification intention are indivisible.
  INSERT INTO booking_releases
    (booking_id, driver_id, details_version_at_release,
     pickup_at_release, price_at_release, driver_name_at_release,
     reason, note)
  VALUES
    (p_booking_id, p_driver_id, v_version,
     v_pickup, v_price, COALESCE(v_name, 'Unknown driver'),
     p_reason, p_note);

  RETURN jsonb_build_object('released', true);
END;
$$;

-- The PUBLIC revoke below is defense-in-depth (010's default-privilege
-- strip already covers new functions); the service_role GRANT is the
-- load-bearing clause — without it NOTHING can call the RPC.
REVOKE ALL ON FUNCTION release_booking(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION release_booking(UUID, UUID, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------
-- 3. Outbox: the history row IS the notification source.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION booking_releases_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- recipient_key = the RELEASING driver: gives every release row its
  -- own event under the (booking, type, key) identity — a later release
  -- by another driver is separate news, never swallowed. Admin routing
  -- ignores the key (admin events are Telegram-only to the admin chat).
  INSERT INTO notification_events
    (booking_id, event_type, recipient_role, recipient_key, state, due_at, not_after)
  VALUES
    (NEW.booking_id, 'ride_released', 'admin', NEW.driver_id::text, 'pending',
     now(), now() + interval '6 hours')
  ON CONFLICT ON CONSTRAINT notification_events_identity DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION booking_releases_outbox() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_booking_releases_outbox
  AFTER INSERT ON booking_releases
  FOR EACH ROW
  EXECUTE FUNCTION booking_releases_outbox();

-- ---------------------------------------------------------------
-- 4. Re-accept guard: a releaser never gets the booking back.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION bookings_release_reaccept_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM booking_releases
    WHERE booking_id = NEW.id AND driver_id = NEW.assigned_driver
  ) THEN
    RAISE EXCEPTION 'released_by_this_driver';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION bookings_release_reaccept_guard() FROM PUBLIC, anon, authenticated;

-- FOR EACH ROW is REQUIRED: a WHEN clause referencing OLD/NEW is invalid
-- on statement-level triggers. The release UPDATE itself never fires this
-- (NEW.assigned_driver IS NULL).
CREATE TRIGGER trg_bookings_release_reaccept_guard
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  WHEN (NEW.assigned_driver IS DISTINCT FROM OLD.assigned_driver
        AND NEW.assigned_driver IS NOT NULL)
  EXECUTE FUNCTION bookings_release_reaccept_guard();

-- ---------------------------------------------------------------
-- 5. Self-verification + LIVE smoke (clean teardown, throwaway rows).
-- ---------------------------------------------------------------
DO $$
DECLARE
  n INTEGER;
  smoke_id UUID;
  drv_a UUID;
  drv_b UUID;
  rel JSONB;
  ev_not_after TIMESTAMPTZ;
BEGIN
  -- 5a. All three functions: SECURITY DEFINER, pinned search_path, no
  -- client EXECUTE. The RPC additionally must be service_role-callable.
  FOR n IN 1..1 LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public'
        AND p.proname IN ('release_booking', 'booking_releases_outbox', 'bookings_release_reaccept_guard')
        AND (NOT p.prosecdef
             OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'))
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: a release function is not SECURITY DEFINER with pinned search_path';
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.release_booking(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.release_booking(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: client roles can execute release_booking';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.release_booking(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: service_role cannot execute release_booking';
  END IF;

  -- 5b. Both triggers present and enabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'booking_releases' AND t.tgname = 'trg_booking_releases_outbox'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: outbox trigger missing on booking_releases';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'bookings' AND t.tgname = 'trg_bookings_release_reaccept_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: reaccept guard trigger missing on bookings';
  END IF;

  -- 5c. THROWAWAY smoke drivers — never borrow real drivers rows.
  INSERT INTO drivers (name, phone) VALUES ('MIGRATION-016-SMOKE-A', '0000000016')
  RETURNING id INTO drv_a;
  INSERT INTO drivers (name, phone) VALUES ('MIGRATION-016-SMOKE-B', '0000000016')
  RETURNING id INTO drv_b;

  -- 5d. LIVE SMOKE: accepted ride released by A — full clear + history +
  -- event, snapshots intact.
  INSERT INTO bookings (customer_name, pickup_location, dropoff_location,
                        pickup_datetime, status, price, assigned_driver,
                        accepted_at, driver_ready_at, driver_ready_by,
                        driver_ready_source, at_risk_at)
  VALUES ('MIGRATION-016-SMOKE', 'smoke-a', 'smoke-b',
          now() + interval '1 day', 'confirmed', 55.00, drv_a,
          now(), now(), drv_a, 'recent_accept', now())
  RETURNING id INTO smoke_id;

  rel := release_booking(smoke_id, drv_a, 'schedule_conflict', NULL);
  IF (rel->>'released') <> 'true' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: release_booking did not release';
  END IF;

  SELECT count(*) INTO n FROM bookings
  WHERE id = smoke_id AND status = 'pending' AND assigned_driver IS NULL
    AND accepted_at IS NULL AND driver_ready_at IS NULL AND driver_ready_by IS NULL
    AND driver_ready_source IS NULL AND at_risk_at IS NULL
    AND on_the_way_at IS NULL AND arrived_at IS NULL AND started_at IS NULL
    AND driver_lat IS NULL AND driver_lng IS NULL AND driver_location_at IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: release did not clear all commitment state';
  END IF;

  SELECT count(*) INTO n FROM booking_releases
  WHERE booking_id = smoke_id AND driver_id = drv_a
    AND reason = 'schedule_conflict'
    AND driver_name_at_release = 'MIGRATION-016-SMOKE-A'
    AND pickup_at_release IS NOT NULL AND details_version_at_release >= 1;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: release history row missing or incomplete';
  END IF;

  SELECT not_after INTO ev_not_after FROM notification_events
  WHERE booking_id = smoke_id AND event_type = 'ride_released'
    AND recipient_role = 'admin' AND recipient_key = drv_a::text AND state = 'pending';
  IF ev_not_after IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: ride_released admin event missing';
  END IF;
  IF ev_not_after < now() + interval '5 hours 55 minutes'
     OR ev_not_after > now() + interval '6 hours 5 minutes' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: ride_released not_after is not the six-hour leash';
  END IF;

  -- 5e. NEGATIVE: A can never be assigned this booking again (guard).
  BEGIN
    UPDATE bookings SET status = 'confirmed', assigned_driver = drv_a
    WHERE id = smoke_id;
    RAISE EXCEPTION 'ASSERTION FAILED: reaccept guard did not fire for the releasing driver';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%released_by_this_driver%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO n FROM bookings
  WHERE id = smoke_id AND status = 'pending' AND assigned_driver IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: failed reaccept mutated the booking';
  END IF;

  -- 5f. Driver B accepts cleanly (guard only blocks past releasers).
  UPDATE bookings SET status = 'confirmed', assigned_driver = drv_b, accepted_at = now()
  WHERE id = smoke_id AND status = 'pending' AND assigned_driver IS NULL;
  SELECT count(*) INTO n FROM bookings
  WHERE id = smoke_id AND status = 'confirmed' AND assigned_driver = drv_b;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: driver B could not accept the released booking';
  END IF;

  -- 5g. NEGATIVE: reason=other with no note — CHECK fires and the WHOLE
  -- release rolls back (booking stays confirmed with B; no history row).
  BEGIN
    rel := release_booking(smoke_id, drv_b, 'other', NULL);
    RAISE EXCEPTION 'ASSERTION FAILED: other-without-note release was not rejected';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  SELECT count(*) INTO n FROM bookings
  WHERE id = smoke_id AND status = 'confirmed' AND assigned_driver = drv_b;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: rejected release did not roll back the status flip';
  END IF;
  SELECT count(*) INTO n FROM booking_releases WHERE booking_id = smoke_id AND driver_id = drv_b;
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: rejected release left a history row';
  END IF;

  -- 5h. NEGATIVE: oversized note — same full rollback.
  BEGIN
    rel := release_booking(smoke_id, drv_b, 'vehicle_issue', repeat('x', 501));
    RAISE EXCEPTION 'ASSERTION FAILED: oversized note was not rejected';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  SELECT count(*) INTO n FROM bookings
  WHERE id = smoke_id AND status = 'confirmed' AND assigned_driver = drv_b;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: oversized-note release did not roll back';
  END IF;

  -- 5i. B releases with a valid note: SECOND history row + SECOND event
  -- (distinct recipient_key) — multi-driver lifetime proven.
  rel := release_booking(smoke_id, drv_b, 'other', 'smoke: cannot accommodate');
  IF (rel->>'released') <> 'true' THEN
    RAISE EXCEPTION 'ASSERTION FAILED: driver B release failed';
  END IF;
  SELECT count(*) INTO n FROM booking_releases WHERE booking_id = smoke_id;
  IF n <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: expected 2 release history rows, found %', n;
  END IF;
  SELECT count(*) INTO n FROM notification_events
  WHERE booking_id = smoke_id AND event_type = 'ride_released';
  IF n <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: expected 2 ride_released events, found %', n;
  END IF;

  -- 5j. NEGATIVE: direct duplicate (booking, driver) INSERT — the UNIQUE
  -- is unreachable via supported paths (the guard blocks re-accept), so
  -- prove it by tampering directly.
  BEGIN
    INSERT INTO booking_releases
      (booking_id, driver_id, details_version_at_release,
       pickup_at_release, driver_name_at_release, reason)
    VALUES (smoke_id, drv_a, 1, now(), 'dup', 'emergency');
    RAISE EXCEPTION 'ASSERTION FAILED: duplicate (booking, driver) release row was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- 5k. Clean teardown: booking cascade removes history + events first,
  -- unblocking the throwaway driver deletes.
  DELETE FROM bookings WHERE id = smoke_id;
  SELECT count(*) INTO n FROM booking_releases WHERE booking_id = smoke_id;
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: release rows survived booking deletion';
  END IF;
  SELECT count(*) INTO n FROM notification_events WHERE booking_id = smoke_id;
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: events survived booking deletion';
  END IF;
  DELETE FROM drivers WHERE id IN (drv_a, drv_b);

  RAISE NOTICE 'RELEASE RIDE VERIFIED: guarded RPC-only release with indivisible audit+event, reaccept guard, six-hour leash, multi-driver history, clean teardown.';
END $$;

COMMIT;

-- ============================================================
-- COMPLETE EMERGENCY ROLLBACK — removes everything this migration added.
-- Copy, uncomment, and run only if PR 3C-1 must be reversed.
-- ============================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_bookings_release_reaccept_guard ON bookings;
-- DROP TRIGGER IF EXISTS trg_booking_releases_outbox ON booking_releases;
-- DROP FUNCTION IF EXISTS bookings_release_reaccept_guard();
-- DROP FUNCTION IF EXISTS booking_releases_outbox();
-- DROP FUNCTION IF EXISTS release_booking(UUID, UUID, TEXT, TEXT);
-- DROP TABLE IF EXISTS booking_releases;
-- COMMIT;
