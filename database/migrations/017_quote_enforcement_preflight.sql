-- ============================================================
-- Migration 017 — READ-ONLY production preflight
-- ============================================================
-- Run this file BEFORE filling the reviewed ambassador-decision manifest
-- in 017_quote_enforcement_foundation.sql. It changes nothing. Preserve
-- the complete result as rollout evidence and stop if any stated gate fails.

BEGIN;
SET TRANSACTION READ ONLY;

-- A. Migration 017 must not be partially installed.
SELECT
  to_regclass('public.pricing_state') AS pricing_state,
  to_regclass('public.pricing_state_audit') AS pricing_state_audit,
  to_regclass('public.quote_acceptances') AS quote_acceptances,
  to_regclass('public.quote_verifications') AS quote_verifications,
  to_regclass('public.operation_receipts') AS operation_receipts,
  to_regclass('public.bookings_one_active_per_customer') AS active_index,
  (
    SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'set_pricing_mode','accept_quote_create','accept_quote_edit',
        'accept_optional_edit','bookings_guard','pricing_state_guard',
        'pricing_state_audit_guard'
      )
  ) AS migration_functions,
  (
    SELECT array_agg(t.tgname ORDER BY t.tgname)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND t.tgname IN (
        'bookings_guard_trg','pricing_state_guard_trg',
        'pricing_state_audit_guard_trg'
      )
  ) AS migration_triggers,
  (
    SELECT array_agg(c.conname ORDER BY c.conname)
    FROM pg_constraint c
    WHERE c.conrelid = 'public.bookings'::regclass
      AND c.conname IN (
        'bookings_price_authority_check','bookings_route_authority_check',
        'bookings_route_identity_check','bookings_price_cents_equal_check',
        'bookings_price_nonnegative_check','bookings_assignment_epoch_check'
      )
  ) AS migration_constraints;
-- PASS: every field is NULL.

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'bookings'
  AND column_name IN (
    'price_cents','price_authority','multi_booking_exempt','active_slot',
    'assignment_epoch','canonical_place_id','airport_code','route_authority'
  )
ORDER BY column_name;
-- PASS: zero rows.

SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'bookings'
  AND column_name = 'price';
-- PASS before migration 017: one row with is_nullable='YES'. A NO here means
-- someone changed the legacy contract outside the atomic migration; stop.

-- B. The cents backfill must be representable and must never legitimize
-- invalid money. INTEGER cents tops out at $21,474,836.47.
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE price IS NULL) AS null_prices,
  count(*) FILTER (
    WHERE price::text IN ('NaN','Infinity','-Infinity')
       OR price < 0
       OR price > 21474836.47
  ) AS unsafe_prices,
  min(price) AS minimum_price,
  max(price) AS maximum_price
FROM public.bookings;
-- PASS: null_prices=0 and unsafe_prices=0.

-- C. Review every live status. `assigned` is retained legacy state and is
-- deliberately treated as nonterminal by migration 017.
SELECT status, count(*)
FROM public.bookings
GROUP BY status
ORDER BY status;

-- D. Legacy guest rows cannot participate in the account-level active-slot
-- constraint because customer_id is NULL. Accept them consciously.
SELECT id, trip_id, status, customer_id, pickup_datetime
FROM public.bookings
WHERE status IN ('pending','assigned','confirmed','on_the_way','arrived','in_progress')
  AND customer_id IS NULL
ORDER BY pickup_datetime;

-- E. Duplicate non-exempt active bookings are a hard stop. This report uses
-- no host-status guess: the final decision comes from the reviewed manifest.
SELECT
  b.customer_id,
  count(*) AS active_count,
  array_agg(b.trip_id ORDER BY b.pickup_datetime) AS trips
FROM public.bookings b
WHERE b.status IN ('pending','assigned','confirmed','on_the_way','arrived','in_progress')
  AND b.customer_id IS NOT NULL
GROUP BY b.customer_id
HAVING count(*) > 1
ORDER BY b.customer_id;
-- REVIEW: every row must be either adjudicated down to one active booking or
-- explicitly approved as multi_booking_exempt in the manifest.

-- F. This is the complete historical ambassador-decision candidate set:
-- host-linked customers who actually have at least one historical booking.
-- Copy each distinct customer_id into migration_017_ambassador_decisions and
-- explicitly choose TRUE or FALSE after human review. Current host status is
-- evidence only; it is never the frozen answer by itself.
WITH candidates AS (
  SELECT DISTINCT c.id AS customer_id, c.user_id
  FROM public.customers c
  JOIN public.bookings b ON b.customer_id = c.id
  JOIN public.hosts h ON h.user_id = c.user_id
), booking_stats AS (
  SELECT
    b.customer_id,
    count(*) AS total_bookings,
    count(*) FILTER (
      WHERE b.status IN ('pending','assigned','confirmed','on_the_way','arrived','in_progress')
    ) AS nonterminal_bookings,
    array_agg(b.trip_id ORDER BY b.pickup_datetime) AS trips
  FROM public.bookings b
  JOIN candidates c ON c.customer_id = b.customer_id
  GROUP BY b.customer_id
)
SELECT
  c.customer_id,
  c.user_id,
  array_agg(DISTINCT h.id ORDER BY h.id) AS host_ids,
  array_agg(DISTINCT h.status ORDER BY h.status) AS current_host_statuses,
  array_agg(DISTINCT h.name ORDER BY h.name) AS host_names,
  bs.total_bookings,
  bs.nonterminal_bookings,
  bs.trips
FROM candidates c
JOIN public.hosts h ON h.user_id = c.user_id
JOIN booking_stats bs ON bs.customer_id = c.customer_id
GROUP BY c.customer_id, c.user_id, bs.total_bookings, bs.nonterminal_bookings, bs.trips
ORDER BY c.customer_id;

-- G. Required roles, pgcrypto location, and existing booking triggers.
SELECT rolname
FROM pg_roles
WHERE rolname IN ('anon','authenticated','service_role')
ORDER BY rolname;
-- PASS: all three roles.

SELECT extname, extnamespace::regnamespace AS schema
FROM pg_extension
WHERE extname = 'pgcrypto';
-- PASS: exactly one row with schema `extensions`.

SELECT to_regprocedure('extensions.digest(text,text)') AS digest_function;
-- PASS: `extensions.digest(text,text)`, never NULL.

SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.bookings'::regclass
  AND NOT tgisinternal
ORDER BY tgname;
-- PASS: every existing trigger has tgenabled='O'.

ROLLBACK;
