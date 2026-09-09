-- ============================================================
-- Migration 019 (PR-T) — READ-ONLY production preflight
-- ============================================================
-- Run BEFORE pasting 019_prt_pickup_time_integrity.sql. It changes nothing.
-- Preserve every result grid as rollout evidence and STOP if any stated gate
-- fails. Supabase SQL Editor shows only the last grid of a multi-statement
-- run: execute each labeled check separately. Every check is its own
-- BEGIN; SET TRANSACTION READ ONLY; one grid; ROLLBACK unit.
--
-- Procedure, not authorization: docs/PRT-MIGRATION-RUNBOOK.md.

BEGIN;
SET TRANSACTION READ ONLY;

-- A1. Exactly the two public writers, namespace-qualified, with the installed
--     018 identities: SECURITY DEFINER, search_path set, service_role EXECUTE
--     held, client roles barred. Expect 2 rows, prosecdef=true, sr_exec=true,
--     anon_exec=false, auth_exec=false, and search_path present in proconfig.
SELECT n.nspname, p.proname, p.oid::regprocedure AS signature,
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('accept_quote_create', 'accept_quote_edit')
ORDER BY p.proname;
ROLLBACK;

BEGIN;
SET TRANSACTION READ ONLY;
-- A2. The installed bodies are 018's (duration never persisted) and carry NO
--     pickup guard yet. is_018 is ROW-SPECIFIC (create's marker is the
--     NULL::INTEGER insert; edit's is `duration_minutes = NULL`). Expect
--     is_018=true AND guarded=false for BOTH rows.
SELECT p.proname,
       CASE p.proname
         WHEN 'accept_quote_create' THEN (pg_get_functiondef(p.oid) LIKE '%NULL::INTEGER%')
         WHEN 'accept_quote_edit'   THEN (pg_get_functiondef(p.oid) LIKE '%duration_minutes = NULL%')
       END AS is_018,
       (pg_get_functiondef(p.oid) LIKE '%linkmia_pickup_is_future%') AS guarded
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('accept_quote_create', 'accept_quote_edit')
ORDER BY p.proname;
ROLLBACK;

BEGIN;
SET TRANSACTION READ ONLY;
-- A3. The helper must NOT exist yet (019 creates it). Expect 0.
SELECT count(*) AS helper_signatures
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'linkmia_pickup_is_future';
ROLLBACK;

BEGIN;
SET TRANSACTION READ ONLY;
-- B1. Pricing state: mode 'observe' (or 'off') with NO enforcement high-water
--     mark. Expect mode IN ('off','observe') and enforcement_started_at NULL.
--     Any other combination: STOP — this runbook assumes pre-enforcement.
SELECT mode, enforcement_started_at, updated_at FROM pricing_state WHERE singleton;
ROLLBACK;

BEGIN;
SET TRANSACTION READ ONLY;
-- B2. The telemetry verdict CHECK is the closed 017 list (019 must not widen
--     it; an elapsed refusal writes no verdict row). Exactly ONE row: the named
--     CHECK constraint on public.quote_verifications (any NOT NULL constraint
--     row is deliberately excluded). Expect verdict_literals=16, widened=false.
SELECT c.conname,
       (SELECT count(*) FROM regexp_matches(pg_get_constraintdef(c.oid), '''[a-z_]+''', 'g')) AS verdict_literals,
       pg_get_constraintdef(c.oid) LIKE '%pickup_time_elapsed%' AS widened
FROM pg_constraint c
WHERE c.conrelid = 'public.quote_verifications'::regclass
  AND c.contype = 'c'
  AND c.conname = 'quote_verifications_verdict_check';
ROLLBACK;

BEGIN;
SET TRANSACTION READ ONLY;
-- C1. Activity snapshot (evidence, not a lock — 019 takes no NOWAIT table
--     locks; it replaces two functions and runs a rollback-contained smoke).
--     Record nonterminal bookings and any in-flight writer transactions.
SELECT
  (SELECT count(*) FROM bookings WHERE status NOT IN ('completed','cancelled','declined')) AS nonterminal_bookings,
  (SELECT count(*) FROM bookings WHERE status NOT IN ('completed','cancelled','declined')
     AND pickup_datetime < now()) AS nonterminal_with_elapsed_pickup,
  (SELECT count(*) FROM pg_stat_activity
     WHERE state <> 'idle' AND query ILIKE '%accept_quote_%' AND pid <> pg_backend_pid()) AS writer_calls_in_flight,
  now() AS snapshot_at;
ROLLBACK;

BEGIN;
SET TRANSACTION READ ONLY;
-- C2. The row counts the migration's smoke will prove unchanged. Record them.
SELECT
  (SELECT count(*) FROM bookings) AS bookings,
  (SELECT count(*) FROM customers) AS customers,
  (SELECT count(*) FROM quote_acceptances) AS quote_acceptances,
  (SELECT count(*) FROM quote_verifications) AS quote_verifications,
  (SELECT count(*) FROM operation_receipts) AS operation_receipts;
ROLLBACK;
