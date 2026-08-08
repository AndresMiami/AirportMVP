-- Migration 011: Notification ledger + driver readiness state (PR 1 of the
-- proactive scheduled-ride operating system).
--
-- Run in the Supabase SQL Editor BEFORE merging the PR: everything here is
-- ADDITIVE and invisible to the running code, so the deployed functions
-- never race a missing table or column. The whole migration is ONE
-- transaction with self-verification at the end: if ANY assertion fails,
-- everything rolls back and the database is untouched. Safe to run
-- unedited, top to bottom, and safe to re-run.
--
-- What this creates:
--   * notification_events      — one row per business intention
--                                (booking, event_type, recipient_key unique)
--   * notification_deliveries  — one row per channel-specific send attempt.
--                                Rows are permanent audit history: never
--                                deleted or replaced; state fields update in
--                                place as outcomes are determined.
--   * system_state             — tiny key/value ops store (heartbeat guard)
--
-- Channels are telegram and webpush ONLY (LinkMia will not use SMS;
-- WhatsApp stays the human conversation channel and is never automated).
-- Neither channel can prove a person SAW a notification, so the honest
-- terminal success state for both events and deliveries is 'submitted' —
-- the provider accepted the send. There is no 'delivered' state anywhere.
--   * bookings: durable transition timestamps (accepted_at, on_the_way_at,
--     arrived_at, started_at — completed_at already exists) + readiness
--     state (driver_ready_by/at/source) + at_risk_at
--   * drivers.telegram_chat_id — exists in the historical schema file but
--     was never established by a numbered migration; guaranteed here.
--
-- Security posture (migration 010 discipline): RLS ENABLED with ZERO
-- policies on every new table, plus an EXPLICIT REVOKE from PUBLIC, anon,
-- and authenticated — never relying on default privileges alone. The
-- Netlify functions' service_role key remains the only data path.
--
-- CODE CONTRACT (readiness vs reassignment): readiness is valid only while
-- driver_ready_by = assigned_driver. ANY future code path that changes
-- assigned_driver MUST, in the same UPDATE, clear driver_ready_by,
-- driver_ready_at, driver_ready_source, and at_risk_at. The watchdog also
-- treats a driver_ready_by/assigned_driver mismatch as not-ready (defense
-- in depth), and notification events are keyed by recipient so a
-- replacement driver receives their own reminders.

BEGIN;

-- ============================================================
-- STEP 1: guarantee drivers.telegram_chat_id (historical schema column
-- that no numbered migration ever established).
-- ============================================================

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;

-- ============================================================
-- STEP 2: bookings — durable transition timestamps + readiness state.
-- Plain ADD COLUMN: the SELECT * views predate these columns and do not
-- auto-include them, so no view needs dropping or recreating.
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS accepted_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS on_the_way_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrived_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS driver_ready_by     UUID REFERENCES drivers(id),
  ADD COLUMN IF NOT EXISTS driver_ready_at     TIMESTAMPTZ,
  -- 'implicit' is reserved but currently unwritten: On my way no longer
  -- stamps readiness fields (race-safety — an explicit 'web' confirmation
  -- must never be overwritten); the on_the_way status itself is the
  -- implicit readiness proof.
  ADD COLUMN IF NOT EXISTS driver_ready_source TEXT
      CHECK (driver_ready_source IN ('web', 'implicit', 'recent_accept')),
  ADD COLUMN IF NOT EXISTS at_risk_at          TIMESTAMPTZ;

-- ============================================================
-- STEP 3: notification_events — one business intention each.
-- recipient_key is part of the identity so a reassigned ride's replacement
-- driver gets their OWN readiness events (the old driver's rows are
-- suppressed by the watchdog, never reused).
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  recipient_role  TEXT NOT NULL CHECK (recipient_role IN ('driver', 'passenger', 'admin')),
  recipient_key   TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'in_delivery', 'submitted',
                                   'exhausted', 'suppressed')),
  due_at          TIMESTAMPTZ NOT NULL,
  not_after       TIMESTAMPTZ,
  suppress_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_events_identity UNIQUE (booking_id, event_type, recipient_key)
);

-- The watchdog's live working set: only pending/in_delivery events are
-- ever re-examined ('submitted' is terminal — no channel has callbacks).
CREATE INDEX IF NOT EXISTS idx_events_live ON notification_events (due_at)
  WHERE state IN ('pending', 'in_delivery');

-- ============================================================
-- STEP 4: notification_deliveries — one channel-specific attempt each.
-- Creation IS the claim: the (event_id, channel, attempt_no) unique
-- constraint arbitrates racing workers in a single statement.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            UUID NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('telegram', 'webpush')),
  attempt_no          INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'claimed'
                      CHECK (state IN ('claimed', 'submitted', 'failed', 'ambiguous')),
  target              TEXT,
  claimed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at        TIMESTAMPTZ,
  finalized_at        TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_attempt UNIQUE (event_id, channel, attempt_no)
);

-- Stale-claim recovery scans only unresolved claims ('submitted' is
-- terminal for both channels — nothing ever waits on a provider callback).
CREATE INDEX IF NOT EXISTS idx_deliveries_open ON notification_deliveries (claimed_at)
  WHERE state = 'claimed';

-- ============================================================
-- STEP 5: system_state — key/value ops store (ride-day heartbeat guard).
-- ============================================================

CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- STEP 6: updated_at triggers — reuse the existing update_updated_at()
-- (search_path pinned by migration 010). DROP-then-CREATE keeps the
-- migration re-runnable (CREATE TRIGGER has no IF NOT EXISTS).
-- ============================================================

DROP TRIGGER IF EXISTS update_notification_events_updated_at ON notification_events;
CREATE TRIGGER update_notification_events_updated_at
  BEFORE UPDATE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_notification_deliveries_updated_at ON notification_deliveries;
CREATE TRIGGER update_notification_deliveries_updated_at
  BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_system_state_updated_at ON system_state;
CREATE TRIGGER update_system_state_updated_at
  BEFORE UPDATE ON system_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- STEP 7: security — RLS on with ZERO policies, plus EXPLICIT revokes
-- from PUBLIC and both client roles (never default-privileges-only).
-- ============================================================

ALTER TABLE notification_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_state            ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON notification_events, notification_deliveries, system_state
  FROM PUBLIC, anon, authenticated;

-- ============================================================
-- STEP 8: SELF-VERIFICATION — any failure raises and rolls back the
-- entire migration (mirrors migration 010 §6a–6c for the new objects).
-- ============================================================

DO $$
DECLARE
  new_tables TEXT[] := ARRAY['notification_events', 'notification_deliveries', 'system_state'];
  booking_cols TEXT[] := ARRAY['accepted_at', 'on_the_way_at', 'arrived_at', 'started_at',
                               'driver_ready_by', 'driver_ready_at', 'driver_ready_source',
                               'at_risk_at'];
  t TEXT;
  col TEXT;
  role_name TEXT;
  priv TEXT;
  n INTEGER;
BEGIN
  -- 8a: every new table exists with RLS enabled
  FOREACH t IN ARRAY new_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = t AND c.relkind = 'r' AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: table % missing or RLS not enabled', t;
    END IF;
  END LOOP;

  -- 8b: zero policies on the new tables (true default-deny)
  SELECT count(*) INTO n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = ANY(new_tables);
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % policies present on new tables', n;
  END IF;

  -- 8c: anon/authenticated hold NO privilege of any type on the new tables
  -- (has_table_privilege also sees PUBLIC-inherited grants)
  FOREACH t IN ARRAY new_tables LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                  'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(role_name, format('public.%I', t), priv) THEN
          RAISE EXCEPTION 'ASSERTION FAILED: % still has % on %', role_name, priv, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 8d: all new bookings columns present
  FOREACH col IN ARRAY booking_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = col
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: bookings.% missing', col;
    END IF;
  END LOOP;

  -- 8e: drivers.telegram_chat_id guaranteed
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'drivers'
      AND column_name = 'telegram_chat_id'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: drivers.telegram_chat_id missing';
  END IF;

  -- 8f: identity constraints exist (event identity incl. recipient_key;
  -- delivery attempt uniqueness = the insert-as-claim arbiter)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_events_identity') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: notification_events_identity constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_attempt') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: notification_deliveries_attempt constraint missing';
  END IF;

  -- 8g: driver_ready_source CHECK constraint exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relname = 'bookings' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%driver_ready_source%'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: driver_ready_source CHECK constraint missing';
  END IF;

  RAISE NOTICE 'NOTIFICATION LEDGER VERIFIED: 3 new tables RLS-on/zero-policy/zero-client-privilege; bookings timestamps + readiness columns present; drivers.telegram_chat_id guaranteed; identity constraints in place.';
END $$;

COMMIT;

-- ============================================================
-- COMPLETE EMERGENCY ROLLBACK — copy, uncomment, and run only if PR 1
-- must be fully reversed. Safe: no view references any of these columns
-- (they were all created after every existing view; re-verify with
-- pg_depend if views have changed since — see migration 007's pattern).
-- drivers.telegram_chat_id is intentionally NOT dropped: it predates this
-- migration in the historical schema and may already hold data.
-- ============================================================
-- BEGIN;
-- DROP TABLE IF EXISTS notification_deliveries;
-- DROP TABLE IF EXISTS notification_events;
-- DROP TABLE IF EXISTS system_state;
-- ALTER TABLE bookings
--   DROP COLUMN IF EXISTS accepted_at,
--   DROP COLUMN IF EXISTS on_the_way_at,
--   DROP COLUMN IF EXISTS arrived_at,
--   DROP COLUMN IF EXISTS started_at,
--   DROP COLUMN IF EXISTS driver_ready_by,
--   DROP COLUMN IF EXISTS driver_ready_at,
--   DROP COLUMN IF EXISTS driver_ready_source,
--   DROP COLUMN IF EXISTS at_risk_at;
-- COMMIT;
