-- Migration 020: explicit service_role grants for the tables that predate
-- the practice (notification ledger + push subscriptions).
--
-- WHY THIS EXISTS
--   Supabase's 30 October cutover: a table created in the public schema after
--   that date receives NO automatic Data API privileges. That covers all three
--   Data API roles, service_role INCLUDED — so a new table without an explicit
--   grant answers "permission denied" even to the service key. Tables that
--   already existed before the cutover keep the privileges they had.
--
--   Nothing in production is broken by this today: every table below was
--   created and granted by project default long before the cutover, and the
--   backend has been reading and writing them successfully ever since. This
--   migration closes a REPLAY hazard, not a live outage.
--
--   The hazard: migrations 011 and 012 create four tables and grant nothing.
--   They work only because of project-default privileges that existed when
--   they were run. Replay that schema into a NEW project after 30 October —
--   disaster recovery, a staging clone, a fresh environment — and those four
--   tables come back ungranted while 26 backend call sites keep addressing
--   them through PostgREST. The notification ledger and driver push would both
--   fail, silently at first (dispatch failures are non-fatal by design).
--
--   Migration 017 already learned this and said so in its own comment:
--   "restate that pre-017 contract explicitly so future restores do not depend
--   on project-default grants." 011 and 012 predate that discipline. This is
--   the catch-up.
--
-- WHY NOT EDIT 011/012
--   They already ran. Editing an applied migration changes nothing in any live
--   database and only makes the file disagree with the schema it produced.
--   020 runs after them in any replay, so it covers production today and every
--   future rebuild. (Codex, 2026-09-26.)
--
-- SCOPE — service_role ONLY. This migration deliberately grants NOTHING to
--   anon or authenticated, and the assertion block below FAILS if it ever
--   appears to have done so. Migration 010 revoked every client-role privilege
--   in the public schema and stripped the postgres default privileges that
--   would hand them back; all data access runs through backend/functions/ with
--   the service key. Adding a client-role grant here would reopen the Data API
--   that lockdown deliberately closed (decision 9).
--
-- VERBS — derived from the operations the backend actually performs, not from
--   a blanket ALL. `.upsert()` needs INSERT + UPDATE; push unsubscribe needs
--   DELETE. No sequence grants: all four tables use
--   `UUID PRIMARY KEY DEFAULT gen_random_uuid()`, not identity columns, so
--   there is no sequence to privilege (contrast quote_verifications in 017,
--   which is BIGINT identity and did need one).
--
-- IDEMPOTENT. GRANT is a no-op when the privilege is already held, so this
--   file is safe to run more than once and safe to replay. It creates nothing,
--   alters no data, and can be reverted with the matching REVOKEs.
--
-- ROLLOUT
--   1. Run THIS file unedited in the Supabase SQL Editor.
--      Expect "Success. No rows returned"; a red ERROR is the only failure
--      signal and it rolls the whole thing back.
--   2. Nothing to deploy. No code change accompanies this.
--
-- STANDING RULE FROM HERE
--   Every CREATE TABLE in the public schema that the backend will address
--   through PostgREST carries its service_role GRANT in the SAME migration,
--   the way 016 and 017 already do. Do not rely on project defaults again.

BEGIN;

-- ---------------------------------------------------------------- 011 ----
-- notification_events      .select() .update() .upsert()
-- notification_deliveries  .select() .insert() .update()
-- system_state             .select() .update() .upsert()
GRANT SELECT, INSERT, UPDATE ON notification_events     TO service_role;
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO service_role;
GRANT SELECT, INSERT, UPDATE ON system_state            TO service_role;

-- ---------------------------------------------------------------- 012 ----
-- push_subscriptions  .select() .upsert() .update() .delete()
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO service_role;

-- ------------------------------------------------------------ VERIFY ----
DO $$
DECLARE
  t              TEXT;
  missing        TEXT[] := '{}';
  leaked         TEXT[] := '{}';
  expected       TEXT[];
  tables         TEXT[] := ARRAY[
    'notification_events', 'notification_deliveries',
    'system_state', 'push_subscriptions'];
  client_role    TEXT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Must be an ORDINARY TABLE (relkind 'r'). A missing name never reaches
    -- here -- the GRANT above already errored on it -- so this exists for the
    -- case the GRANT would happily accept: the name resolving to a VIEW or
    -- foreign table, where these privileges would mean something different.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: public.% is not an ordinary table', t;
    END IF;

    expected := CASE WHEN t = 'push_subscriptions'
                     THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
                     ELSE ARRAY['SELECT','INSERT','UPDATE'] END;

    IF NOT (SELECT bool_and(
              has_table_privilege('service_role', format('public.%I', t), p))
            FROM unnest(expected) AS p) THEN
      missing := missing || t;
    END IF;

    -- The lockdown must still hold. Any client-role privilege of any kind on
    -- these tables means something here (or elsewhere) reopened the Data API.
    -- 'public' is NOT listed: PUBLIC is a pseudo-role and has_table_privilege
    -- would raise "role \"public\" does not exist". It needs no separate check
    -- — has_table_privilege already folds in privileges held via PUBLIC, so a
    -- PUBLIC grant shows up under anon and authenticated below.
    FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (
        SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                   'TRUNCATE','REFERENCES','TRIGGER']) AS p
        WHERE has_table_privilege(client_role, format('public.%I', t), p)
      ) THEN
        leaked := leaked || (t || '/' || client_role);
      END IF;
    END LOOP;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: service_role still lacks the expected privileges on: %',
      array_to_string(missing, ', ');
  END IF;

  IF array_length(leaked, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: client-role privilege present (migration 010 lockdown broken) on: %',
      array_to_string(leaked, ', ');
  END IF;

  RAISE NOTICE 'MIGRATION 020 VERIFIED: service_role holds exactly the needed privileges on 4 tables; anon/authenticated hold none (PUBLIC folded in).';
END $$;

COMMIT;
