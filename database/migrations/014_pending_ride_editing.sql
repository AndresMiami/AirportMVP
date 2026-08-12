-- Migration 014: race-safe in-place editing for pending rides
-- (renumbered from 013 — that slot shipped as the cancellation-policy
-- migration with PR #58; the one-active-booking constraint reservation
-- moves to 015)
-- Run this file unedited in the Supabase SQL Editor before deploying the
-- Pending Ride Editing code. Additive and backwards-compatible: old code
-- ignores details_version, while the new passenger and driver endpoints use
-- it to arbitrate Edit-vs-Accept races.

BEGIN;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS details_version INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_details_version_check'
  ) THEN
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_details_version_check
      CHECK (details_version >= 1);
  END IF;
END $$;

-- Self-verification: any failure aborts the whole transaction.
DO $$
DECLARE
  col_not_null BOOLEAN;
  col_default TEXT;
BEGIN
  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
  INTO col_not_null, col_default
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relname = 'bookings'
    AND a.attname = 'details_version'
    AND NOT a.attisdropped;

  IF col_not_null IS DISTINCT FROM TRUE
     OR col_default IS NULL
     OR replace(col_default, ' ', '') NOT IN ('1', '1::integer') THEN
    RAISE EXCEPTION 'details_version must exist as NOT NULL DEFAULT 1';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_details_version_check'
      AND pg_get_constraintdef(oid) LIKE '%details_version >= 1%'
  ) THEN
    RAISE EXCEPTION 'bookings_details_version_check missing or incorrect';
  END IF;

  IF has_column_privilege('anon', 'public.bookings', 'details_version', 'SELECT')
     OR has_column_privilege('authenticated', 'public.bookings', 'details_version', 'SELECT') THEN
    RAISE EXCEPTION 'client role unexpectedly gained details_version access';
  END IF;

  RAISE NOTICE 'PENDING RIDE EDITING VERIFIED: details_version is guarded and client-inaccessible';
END $$;

COMMIT;

-- Emergency rollback (only while no edit-enabled deployment is live):
-- BEGIN;
-- ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_details_version_check;
-- ALTER TABLE public.bookings DROP COLUMN IF EXISTS details_version;
-- COMMIT;
