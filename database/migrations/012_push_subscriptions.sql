-- Migration 012: Driver PWA Push subscriptions + durable delivery
-- failure classification (Driver PWA Push PR).
--
-- Run in the Supabase SQL Editor BEFORE merging the PR: everything here
-- is ADDITIVE and invisible to the running code. One transaction with
-- self-verification: any assertion failure rolls the whole migration
-- back. Safe to run unedited, top to bottom, and safe to re-run (all
-- DDL is idempotent, including the coherence constraint via a
-- pg_constraint existence check).
--
-- What this creates:
--   * push_subscriptions — one row per (driver, device). endpoint,
--     p256dh, and auth are SECRETS: never logged, never returned by any
--     API (the GET endpoint exposes only a sha256 fingerprint), never
--     placed in browser caches (the driver service worker caches
--     nothing).
--       - activated_at is the DEVICE-SELECTION key: stamped at every
--         enable/re-enable, so the device the driver most recently
--         enabled is the device that receives pushes. last_success_at
--         is health information ONLY.
--       - disabled_reason has exactly one value ('expired', from a
--         404/410 push-service answer). Sign-out DELETEs the row, and
--         401/403 VAPID-configuration failures never disable a
--         subscription.
--       - An endpoint is NEVER reassigned between driver accounts
--         (enforced in code with a 409; the endpoint UNIQUE constraint
--         is the backstop).
--   * notification_deliveries.failure_class — durable, CHECK'd outcome
--     classification so channel routing (including Telegram-fallback
--     continuation after a crash) is restart-safe from delivery history
--     alone, never parsed out of free-text last_error. A coherence
--     constraint REQUIRES a class on every failed/ambiguous webpush
--     delivery and forbids it everywhere else.
--
-- Security posture (migration 010/011 discipline): RLS ENABLED with
-- ZERO policies on the new table, plus an EXPLICIT REVOKE from PUBLIC,
-- anon, and authenticated. The Netlify functions' service_role key
-- remains the only data path.

BEGIN;

-- ============================================================
-- STEP 1: push_subscriptions
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  device_id       UUID NOT NULL,
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_error      TEXT,
  disabled_at     TIMESTAMPTZ,
  disabled_reason TEXT CHECK (disabled_reason = 'expired'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_endpoint UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_device   UNIQUE (driver_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_active
  ON push_subscriptions (driver_id, activated_at)
  WHERE disabled_at IS NULL;

DROP TRIGGER IF EXISTS update_push_subscriptions_updated_at ON push_subscriptions;
CREATE TRIGGER update_push_subscriptions_updated_at
  BEFORE UPDATE ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- STEP 2: durable delivery failure classification
-- ============================================================

ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS failure_class TEXT
    CHECK (failure_class IN ('expired_endpoint',   -- 404/410: sub disabled + fallback
                             'vapid_config',       -- 401/403: sub KEPT + fallback (our config)
                             'payload',            -- 400/413: sub kept + fallback
                             'provider_rejected',  -- any other 4xx: definitive + fallback
                             'throttled',          -- 429: same-channel retry
                             'pre_transmission',   -- DNS/conn-refused: retry
                             'ambiguous'));        -- may have transmitted: terminal

-- Coherence: every failed/ambiguous WEBPUSH delivery carries exactly one
-- class; successful/claimed rows (and all telegram rows) carry none.
-- Existing rows satisfy this (all telegram, failure_class NULL).
-- Idempotent via pg_constraint: a plain ADD CONSTRAINT would fail on
-- re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deliveries_failure_class_coherent'
      AND conrelid = 'public.notification_deliveries'::regclass
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT deliveries_failure_class_coherent CHECK (
        (channel = 'webpush' AND state IN ('failed', 'ambiguous'))
          = (failure_class IS NOT NULL)
      );
  END IF;
END $$;

-- ============================================================
-- STEP 3: security — RLS on with ZERO policies + explicit revokes
-- ============================================================

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_subscriptions FROM PUBLIC, anon, authenticated;

-- ============================================================
-- STEP 4: SELF-VERIFICATION — any failure raises and rolls back.
-- ============================================================

DO $$
DECLARE
  role_name TEXT;
  priv TEXT;
  n INTEGER;
BEGIN
  -- 4a: table exists with RLS enabled
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relname = 'push_subscriptions'
      AND c.relkind = 'r' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: push_subscriptions missing or RLS not enabled';
  END IF;

  -- 4b: zero policies
  SELECT count(*) INTO n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'push_subscriptions';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % policies present on push_subscriptions', n;
  END IF;

  -- 4c: no client-role privilege of any type
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(role_name, 'public.push_subscriptions', priv) THEN
        RAISE EXCEPTION 'ASSERTION FAILED: % still has % on push_subscriptions', role_name, priv;
      END IF;
    END LOOP;
  END LOOP;

  -- 4d: both unique constraints present
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_endpoint') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: push_subscriptions_endpoint constraint missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_device') THEN
    RAISE EXCEPTION 'ASSERTION FAILED: push_subscriptions_device constraint missing';
  END IF;

  -- 4e: activated_at present (the selection key)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'push_subscriptions'
      AND column_name = 'activated_at'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: push_subscriptions.activated_at missing';
  END IF;

  -- 4f: failure_class column + its CHECK present
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_deliveries'
      AND column_name = 'failure_class'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: notification_deliveries.failure_class missing';
  END IF;

  -- 4g: coherence constraint present
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deliveries_failure_class_coherent'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: deliveries_failure_class_coherent constraint missing';
  END IF;

  RAISE NOTICE 'PUSH SUBSCRIPTIONS VERIFIED: table RLS-on/zero-policy/zero-client-privilege with activated_at selection key; notification_deliveries.failure_class present with enforced coherence.';
END $$;

COMMIT;

-- ============================================================
-- COMPLETE EMERGENCY ROLLBACK — copy, uncomment, and run only if the
-- Driver PWA Push PR must be fully reversed. Safe: no view references
-- these objects. Note: rows in notification_deliveries created by push
-- dispatch reference failure_class values — rollback of the COLUMN
-- requires those rows to be gone or is best left in place (the column
-- is harmless when unused).
-- ============================================================
-- BEGIN;
-- DROP TABLE IF EXISTS push_subscriptions;
-- ALTER TABLE notification_deliveries
--   DROP CONSTRAINT IF EXISTS deliveries_failure_class_coherent;
-- ALTER TABLE notification_deliveries
--   DROP COLUMN IF EXISTS failure_class;
-- COMMIT;
