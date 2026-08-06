-- Migration 010: RLS lockdown — the public keys become auth-only.
-- Run in the Supabase SQL Editor AFTER the Phase B PR is merged (the PR
-- retires admin.html, the last direct anon-key consumer).
--
-- The whole migration is ONE transaction with self-verification at the
-- end: if ANY assertion fails, everything rolls back and the database is
-- untouched. Safe to run unedited, top to bottom.
--
-- Live state this reverses (inventoried directly from production,
-- Aug 2026):
--   * 7 tables with "Allow all access" USING(true) policies (role public)
--   * anon + authenticated hold ALL privileges (incl. TRUNCATE) on every
--     table and every view
--   * 6 definer-mode views that bypass table RLS (all flagged ERROR by
--     the Supabase security advisor)
--   * pg_default_acl: creator roles postgres AND supabase_admin grant ALL
--     to anon/authenticated on FUTURE public tables/sequences/functions
--   * no sequences in public; no direct PUBLIC grants on relations
--
-- DOCUMENTED LIMITATION: default privileges declared BY supabase_admin
-- cannot be altered by the postgres role (ALTER DEFAULT PRIVILEGES FOR
-- ROLE requires membership in that role). They apply only to objects
-- CREATED BY supabase_admin — Supabase-managed internals, not our tables,
-- which are created by postgres via the SQL Editor. Every EXISTING object
-- is covered by the blanket REVOKE regardless of creator. If Supabase
-- ever creates a client-readable object in public, the Netlify functions
-- (service key) remain the only data path our app uses.
--
-- After running: all app traffic continues through the Netlify functions'
-- service_role key (bypasses RLS, keeps its own grants). The anon key can
-- authenticate but read/write NOTHING in public.
--
-- NOTE on Realtime: this creates a SAFE FOUNDATION only. Realtime remains
-- deferred and would still require deliberately scoped SELECT grants plus
-- per-row policies when intentionally implemented.

BEGIN;

-- ============================================================
-- STEP 1: default-deny — drop every allow-all policy.
-- RLS stays ENABLED on all seven tables; with no policies, client roles
-- get nothing even where grants exist.
-- ============================================================

DROP POLICY IF EXISTS "Allow all access to customers"    ON customers;
DROP POLICY IF EXISTS "Allow all access to drivers"      ON drivers;
DROP POLICY IF EXISTS "Allow all access to bookings"     ON bookings;
DROP POLICY IF EXISTS "Allow all access to hosts"        ON hosts;
DROP POLICY IF EXISTS "Allow all access to payments"     ON payments;
DROP POLICY IF EXISTS "Allow all access to activity_log" ON activity_log;
DROP POLICY IF EXISTS "Allow all access to passengers"   ON passengers;

-- ============================================================
-- STEP 2: revoke every client-role privilege on every EXISTING table,
-- view, and sequence. PUBLIC included: a PUBLIC grant is inherited by
-- anon and authenticated.
-- ============================================================

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- ============================================================
-- STEP 3: FUTURE objects created by postgres (the SQL Editor / dashboard
-- role — the creator of every LinkMia table) get no client grants.
-- Explicit FOR ROLE per the PostgreSQL docs: default privileges apply
-- only to objects created by the named role.
-- ============================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- PostgreSQL grants EXECUTE to PUBLIC on every NEW function via a built-in
-- GLOBAL default. A schema-scoped default-privilege revoke cannot cancel
-- that built-in — only a global one (no IN SCHEMA) can. The schema-scoped
-- revocations above still handle the explicit anon/authenticated default
-- ACL entries.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- ============================================================
-- STEP 4: the six reporting views become security_invoker so they can
-- never again bypass table RLS, even if a grant ever returns.
-- Pre-check: all six must exist (typo protection before ALTER).
-- ============================================================

DO $$
DECLARE
  v TEXT;
BEGIN
  FOREACH v IN ARRAY ARRAY['passenger_booking_history','todays_bookings',
    'pending_assignments','revenue_summary','bookings_with_ambassador',
    'ambassador_earnings']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v AND c.relkind = 'v'
    ) THEN
      RAISE EXCEPTION 'Expected view public.% not found — aborting before ALTER', v;
    END IF;
  END LOOP;
END $$;

ALTER VIEW passenger_booking_history SET (security_invoker = true);
ALTER VIEW todays_bookings           SET (security_invoker = true);
ALTER VIEW pending_assignments       SET (security_invoker = true);
ALTER VIEW revenue_summary           SET (security_invoker = true);
ALTER VIEW bookings_with_ambassador  SET (security_invoker = true);
ALTER VIEW ambassador_earnings       SET (security_invoker = true);

-- ============================================================
-- STEP 5: pin the trigger function's search_path (advisor WARN).
-- ============================================================

ALTER FUNCTION public.update_updated_at() SET search_path = public;

-- ============================================================
-- STEP 6: SELF-VERIFICATION — any failure raises and rolls back the
-- entire migration.
-- ============================================================

DO $$
DECLARE
  tables TEXT[] := ARRAY['bookings','customers','drivers','hosts',
                         'passengers','payments','activity_log'];
  views  TEXT[] := ARRAY['passenger_booking_history','todays_bookings',
                         'pending_assignments','revenue_summary',
                         'bookings_with_ambassador','ambassador_earnings'];
  t TEXT;
  v TEXT;
  role_name TEXT;
  priv TEXT;
  rec RECORD;
  n INTEGER;
BEGIN
  -- 6a: RLS still enabled on all seven tables
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = t AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: RLS not enabled on %', t;
    END IF;
  END LOOP;

  -- 6b: zero policies remain on those tables (true default-deny)
  SELECT count(*) INTO n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = ANY(tables);
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % policies still present', n;
  END IF;

  -- 6c: anon/authenticated hold NO privilege of ANY type on any public
  -- table or view (all seven types validated queryable on views).
  -- has_table_privilege also sees PUBLIC-inherited grants.
  FOR rec IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r','v')
  LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE',
                                  'TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF has_table_privilege(role_name, format('public.%I', rec.relname), priv) THEN
          RAISE EXCEPTION 'ASSERTION FAILED: % still has % on %',
            role_name, priv, rec.relname;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 6d: no direct PUBLIC grants remain on any relation
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE ns.nspname = 'public' AND c.relkind IN ('r','v') AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: direct PUBLIC grants remain on a relation';
  END IF;

  -- 6e: sequences (none today; guards any future ones) — correct
  -- privilege function per object type: has_sequence_privilege
  FOR rec IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      FOREACH priv IN ARRAY ARRAY['USAGE','SELECT','UPDATE'] LOOP
        IF has_sequence_privilege(role_name, format('public.%I', rec.sequencename), priv) THEN
          RAISE EXCEPTION 'ASSERTION FAILED: % still has % on sequence %',
            role_name, priv, rec.sequencename;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 6f: all six views are security_invoker
  FOREACH v IN ARRAY views LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = v
        AND c.reloptions::text LIKE '%security_invoker=true%'
    ) THEN
      RAISE EXCEPTION 'ASSERTION FAILED: view % is not security_invoker', v;
    END IF;
  END LOOP;

  -- 6h: no client role can EXECUTE any public function
  -- (has_function_privilege sees PUBLIC-inherited grants too)
  FOR rec IN
    SELECT p.oid AS foid, p.proname FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
  LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_function_privilege(role_name, rec.foid, 'EXECUTE') THEN
        RAISE EXCEPTION 'ASSERTION FAILED: % can still EXECUTE %',
          role_name, rec.proname;
      END IF;
    END LOOP;
  END LOOP;

  -- 6i: no COLUMN-level privileges remain for PUBLIC, anon, or
  -- authenticated on any public relation
  IF EXISTS (
    SELECT 1 FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(att.attacl) a
    WHERE ns.nspname = 'public' AND c.relkind IN ('r','v')
      AND att.attacl IS NOT NULL
      AND (a.grantee = 0 OR a.grantee::regrole::text IN ('anon','authenticated'))
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: column-level client privileges remain';
  END IF;

  -- 6g: postgres-creator default ACLs in public no longer grant to client
  -- roles (supabase_admin's default ACL is out of postgres's authority —
  -- see the documented limitation in the header)
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclnamespace = 'public'::regnamespace
      AND pg_get_userbyid(d.defaclrole) = 'postgres'
      AND a.grantee::regrole::text IN ('anon','authenticated')
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: postgres default privileges still grant to client roles';
  END IF;

  RAISE NOTICE 'RLS LOCKDOWN VERIFIED: 7 tables default-deny with RLS on; no client or PUBLIC privilege of any type (table, column, sequence, function) on any public object; 6 invoker views; postgres default privileges stripped incl. the global function default.';
END $$;

COMMIT;

-- ============================================================
-- COMPLETE EMERGENCY ROLLBACK (restores the pre-010 state, including
-- view security mode and postgres default privileges; the harmless
-- search_path pin from STEP 5 is intentionally left in place).
-- Copy, uncomment, and run only if the lockdown must be reversed.
-- ============================================================
-- BEGIN;
-- GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated;
-- GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
-- GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
-- CREATE POLICY "Allow all access to customers"    ON customers    FOR ALL USING (true);
-- CREATE POLICY "Allow all access to drivers"      ON drivers      FOR ALL USING (true);
-- CREATE POLICY "Allow all access to bookings"     ON bookings     FOR ALL USING (true);
-- CREATE POLICY "Allow all access to hosts"        ON hosts        FOR ALL USING (true);
-- CREATE POLICY "Allow all access to payments"     ON payments     FOR ALL USING (true);
-- CREATE POLICY "Allow all access to activity_log" ON activity_log FOR ALL USING (true);
-- CREATE POLICY "Allow all access to passengers"   ON passengers   FOR ALL USING (true);
-- ALTER VIEW passenger_booking_history RESET (security_invoker);
-- ALTER VIEW todays_bookings           RESET (security_invoker);
-- ALTER VIEW pending_assignments       RESET (security_invoker);
-- ALTER VIEW revenue_summary           RESET (security_invoker);
-- ALTER VIEW bookings_with_ambassador  RESET (security_invoker);
-- ALTER VIEW ambassador_earnings       RESET (security_invoker);
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--   GRANT ALL ON TABLES TO anon, authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--   GRANT ALL ON SEQUENCES TO anon, authenticated;
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--   GRANT ALL ON FUNCTIONS TO anon, authenticated;
-- -- Restores PostgreSQL's built-in global default (PUBLIC EXECUTE on new
-- -- functions created by postgres):
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres
--   GRANT ALL ON FUNCTIONS TO PUBLIC;
-- COMMIT;
