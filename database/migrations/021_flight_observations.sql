-- Migration 021: flight observations -- the flight-facts fast path (plan step 2).
--
-- DECISIONS (Andres, 2026-10-05):
--   D1  An external flight sensor reaches LinkMia only through two narrow
--       endpoints and a revocable token (/api/flight-watchlist,
--       /api/flight-facts). It never holds a database key; the
--       service-key-only lockdown of migration 010 stays intact.
--   D2  Notifications reuse the commit-then-dispatch path cancellation and
--       release already use: this table's AFTER INSERT trigger writes the
--       ledger event in the SAME transaction, the endpoint gives it one
--       bounded dispatch pass after commit, and the untouched 5-minute
--       watchdog sends anything that pass missed. No database webhook.
--   D3  TELL ONLY. Nothing here reads into or writes bookings.pickup_datetime
--       for any purpose but choosing the event's expiry; the booked pickup
--       and every mechanism anchored to it are unchanged.
--
-- ROLLOUT ORDER (the order is load-bearing):
--   1. Merge + deploy the code first. The dispatcher must already know the
--      flight event types: an event it cannot render is PERMANENTLY
--      suppressed as no_template, which would spend that band's one-time
--      notification slot for that booking. The endpoints stay inert until
--      FLIGHT_SENSOR_TOKEN is set, so deploying first is safe.
--   2. Run THIS file unedited in the Supabase SQL Editor; expect
--      "Success. No rows returned". A red ERROR rolls everything back.
--   3. Set FLIGHT_SENSOR_TOKEN and FLIGHT_SENSOR_DRIVER_ALLOWLIST, redeploy.
--   No watchdog pause is needed: until step 3 nothing can write a row, so
--   no flight event can exist while PostgREST reloads its schema cache.
--   Full runbook: docs/FLIGHT-FACTS-RUNBOOK.md.
--
-- What this adds:
--   * flight_observations -- APPEND-ONLY history, one row per material
--     change the sensor reports. The row is both the record of what the
--     sensor said (and when) and the notification source, exactly as a
--     booking_releases row is (migration 016). bookings is not altered.
--   * trg_flight_observations_outbox -- AFTER INSERT: for the five news
--     bands only, and only for a ride still in progress with an assigned
--     driver, inserts ONE driver event 'flight_<band>' under the ledger's
--     (booking, type, recipient) identity -- so each band notifies at most
--     once per booking per driver, by construction.
--
-- Why a side table and not columns on bookings: bookings is the most
-- guarded table in the repo (enumerated writer columns, the
-- details_version CAS against Accept, Release's commitment-state clear).
-- A sensor writing there could collide with all three. Here it has its
-- own table, the narrowest grants, and a clean DROP for rollback.
--
-- GRANTS ARE EXPLICIT (migration 020 discipline): a table created after
-- Supabase's 30 October 2026 change receives no automatic Data API
-- privileges, service_role included. The backend gets SELECT and INSERT
-- only -- append-only is enforced by privilege, not by convention.

BEGIN;

-- ---------------------------------------------------------------
-- 1. The observation history.
-- ---------------------------------------------------------------
CREATE TABLE flight_observations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- The flight AS TRACKED, normalized (lib/flight-facts.js). Kept on the
  -- row so a later change of the booking's flight makes old facts visibly
  -- stale instead of silently re-attributed (the dispatcher suppresses a
  -- mismatch as flight_changed).
  flight_number      TEXT NOT NULL CHECK (flight_number ~ '^([A-Z][A-Z0-9]|[0-9][A-Z]|[A-Z]{3})[0-9]{1,4}[A-Z]?$'),
  -- The booking's Miami pickup date the sensor was given -- an identity
  -- echo, not the flight's departure date.
  pickup_date        DATE NOT NULL,
  airport_code       TEXT NOT NULL CHECK (airport_code ~ '^[A-Z]{3}$'),
  band               TEXT NOT NULL CHECK (band IN
    ('on_time', 'delay_30', 'delay_60', 'delay_120', 'cancelled', 'diverted', 'landed')),
  -- Whole minutes versus schedule (negative = early); NULL when the
  -- flight is cancelled or diverted.
  delay_minutes      INTEGER,
  scheduled_arrival  TIMESTAMPTZ NOT NULL,
  estimated_arrival  TIMESTAMPTZ,
  actual_arrival     TIMESTAMPTZ,
  observed_at        TIMESTAMPTZ NOT NULL,     -- when the SENSOR read it
  source             TEXT NOT NULL CHECK (source ~ '^[a-z0-9_-]{1,32}$'),
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when WE stored it

  -- The band is DERIVED from the times (the endpoint computes it; the
  -- database refuses any row where label and numbers disagree), so a
  -- sensor can never call a 20-minute delay "delay_60".
  CHECK (band NOT IN ('on_time', 'delay_30', 'delay_60', 'delay_120')
         OR (estimated_arrival IS NOT NULL AND delay_minutes IS NOT NULL)),
  CHECK (band <> 'on_time'   OR delay_minutes < 30),
  CHECK (band <> 'delay_30'  OR delay_minutes BETWEEN 30 AND 59),
  CHECK (band <> 'delay_60'  OR delay_minutes BETWEEN 60 AND 119),
  CHECK (band <> 'delay_120' OR delay_minutes >= 120),
  CHECK (band <> 'landed'    OR (actual_arrival IS NOT NULL AND delay_minutes IS NOT NULL)),
  CHECK (band NOT IN ('cancelled', 'diverted') OR delay_minutes IS NULL),

  -- A sensor retry of the same reading is the same row: the endpoint
  -- answers the duplicate as an idempotent success.
  CONSTRAINT flight_observations_reading UNIQUE (booking_id, observed_at)
);

-- Serves the dispatcher's enrichment read: the newest row in one band.
CREATE INDEX idx_flight_observations_band
  ON flight_observations (booking_id, band, observed_at DESC);

-- Lockdown (migration-010 discipline): default-deny, zero client grants,
-- explicit backend grants. No UPDATE, no DELETE: history is append-only.
ALTER TABLE flight_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flight_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE flight_observations TO service_role;

-- ---------------------------------------------------------------
-- 2. Outbox: the observation row IS the notification source.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION flight_observations_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_driver  UUID;
  v_status  TEXT;
  v_pickup  TIMESTAMPTZ;
BEGIN
  -- on_time and landed are recorded, never announced (decision D5 open:
  -- recovery and landing stay silent until Andres decides otherwise).
  IF NEW.band NOT IN ('delay_30', 'delay_60', 'delay_120', 'cancelled', 'diverted') THEN
    RETURN NEW;
  END IF;

  SELECT assigned_driver, status, pickup_datetime
    INTO v_driver, v_status, v_pickup
    FROM bookings
   WHERE id = NEW.booking_id;

  -- Only a ride still happening, with a driver committed to it. The
  -- dispatcher re-checks both on the LIVE row before sending (a release
  -- between this insert and the send suppresses as 'reassigned').
  IF v_driver IS NULL OR v_status IS NULL
     OR v_status NOT IN ('confirmed', 'on_the_way', 'arrived') THEN
    RETURN NEW;
  END IF;

  -- recipient_key = the driver AT observation time. not_after: three hours
  -- past the later of the booked pickup and the expected landing -- after
  -- that the alert is history, not news.
  INSERT INTO notification_events
    (booking_id, event_type, recipient_role, recipient_key, state, due_at, not_after)
  VALUES
    (NEW.booking_id, 'flight_' || NEW.band, 'driver', v_driver::text, 'pending', now(),
     GREATEST(v_pickup, COALESCE(NEW.estimated_arrival, NEW.scheduled_arrival), now())
       + interval '3 hours')
  ON CONFLICT ON CONSTRAINT notification_events_identity DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION flight_observations_outbox() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_flight_observations_outbox
  AFTER INSERT ON flight_observations
  FOR EACH ROW
  EXECUTE FUNCTION flight_observations_outbox();

-- ---------------------------------------------------------------
-- 3. Self-verification. Any failure raises and rolls back the whole file.
-- ---------------------------------------------------------------
DO $$
DECLARE
  client_role TEXT;
  priv        TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'flight_observations'
       AND c.relkind = 'r' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: flight_observations missing, not a table, or RLS off';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'flight_observations') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: flight_observations must have zero policies (default-deny)';
  END IF;

  FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT'] LOOP
    IF NOT has_table_privilege('service_role', 'public.flight_observations', priv) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: service_role lacks % on flight_observations', priv;
    END IF;
  END LOOP;

  -- Append-only for the backend. (PUBLIC is folded into these checks by
  -- has_table_privilege -- see migration 020's note.)
  FOREACH priv IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('service_role', 'public.flight_observations', priv) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: service_role must not hold % (history is append-only)', priv;
    END IF;
  END LOOP;

  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (
      SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                 'TRUNCATE','REFERENCES','TRIGGER']) AS p
       WHERE has_table_privilege(client_role, 'public.flight_observations', p)
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: % holds a privilege on flight_observations (lockdown broken)', client_role;
    END IF;
    IF has_function_privilege(client_role, 'public.flight_observations_outbox()', 'EXECUTE') THEN
      RAISE EXCEPTION 'ASSERTION FAILED: % can execute flight_observations_outbox()', client_role;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.flight_observations'::regclass
       AND t.tgname = 'trg_flight_observations_outbox'
       AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: outbox trigger missing or disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'flight_observations_outbox'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: outbox function must be SECURITY DEFINER with a pinned search_path';
  END IF;

  RAISE NOTICE 'MIGRATION 021 VERIFIED: flight_observations append-only, default-deny, service_role SELECT+INSERT only, outbox trigger live.';
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ---------------------------------------------------------------
-- ROLLBACK (manual, only if the feature is withdrawn). Turn the sensor
-- off first (FLIGHT_SENSOR_DISABLED=1, redeploy) so nothing writes while
-- the table goes. Notifications already sent cannot be unsent. Flight
-- events still pending must be retired FIRST: once the table is dropped,
-- the dispatcher's enrichment read fails (missing relation), which by
-- design leaves an event pending for retry rather than condemning it.
-- Worse, the watchdog treats any database failure as a broken cycle and
-- sends NOTHING further that cycle -- so a leftover flight event would
-- hold back every readiness reminder, every five minutes, until its
-- not_after passed. The UPDATE below is therefore mandatory, not tidy.
--
-- BEGIN;
-- UPDATE notification_events
--    SET state = 'suppressed', suppress_reason = 'feature_withdrawn'
--  WHERE event_type LIKE 'flight\_%' AND state IN ('pending', 'in_delivery');
-- DROP TRIGGER IF EXISTS trg_flight_observations_outbox ON flight_observations;
-- DROP FUNCTION IF EXISTS flight_observations_outbox();
-- DROP TABLE IF EXISTS flight_observations;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
