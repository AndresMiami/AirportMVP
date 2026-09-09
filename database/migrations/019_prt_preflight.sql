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
-- A2. The installed bodies are EXACTLY the reviewed 018 bodies — fingerprint =
--     sha256(pg_proc.prosrc), the same value migration 019's pre-capture
--     REQUIRES — and carry NO pickup guard yet. Expect, for BOTH rows,
--     is_reviewed_018=true, is_target_019=false, guarded=false. ANY other
--     body_sha256 means an unreviewed change is installed: STOP (019 would
--     refuse it too). The expected values between the markers are GENERATED
--     into this file by prt-guard-transform.js --write and verified by
--     --check and the executed suite — never hand-edit them.
SELECT p.proname,
       encode(extensions.digest(p.prosrc, 'sha256'), 'hex') AS body_sha256,
-- PRT-EXPECTED-FINGERPRINTS:BEGIN (generated — do not hand-edit)
       CASE p.proname
         WHEN 'accept_quote_create' THEN encode(extensions.digest(p.prosrc, 'sha256'), 'hex') = 'ed86cca5e4f5046dc9503771a38bb63f7b4140956dfb94b645f076cd59483388'
         WHEN 'accept_quote_edit'   THEN encode(extensions.digest(p.prosrc, 'sha256'), 'hex') = 'cc56cc673236db967d738209c9f9d5423e0e7117a74358e48280c08f0cd14b41'
       END AS is_reviewed_018,
       CASE p.proname
         WHEN 'accept_quote_create' THEN encode(extensions.digest(p.prosrc, 'sha256'), 'hex') = 'fc64b32ca907098b8ccceb5c912fa9d290a5e9c14a4f0704013d6b226f506396'
         WHEN 'accept_quote_edit'   THEN encode(extensions.digest(p.prosrc, 'sha256'), 'hex') = 'ce81f347112d3cd251738d9bece093154ea27cccd09b6a2c8ea0e21f75a6e50d'
       END AS is_target_019,
-- PRT-EXPECTED-FINGERPRINTS:END
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
