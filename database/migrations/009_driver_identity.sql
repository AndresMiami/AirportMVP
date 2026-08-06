-- Migration 009: Driver identity — link drivers to auth accounts
-- Run in the Supabase SQL Editor BEFORE merging the driver-identity PR.
--
-- Drivers are ADMIN-PROVISIONED (CreditEngine pattern) — there is no driver
-- signup anywhere, ever. The backend requires an ACTIVE or BUSY drivers row
-- linked to the auth user; 'inactive' is rejected regardless of login.
--
-- EXACT PROVISIONING ORDER (do not reorder):
--   1. Run STEP 1 below (the ALTER TABLE).
--   2. Supabase Dashboard -> Authentication -> Add user
--      (email + password set by admin, "Auto Confirm User" ON).
--      Password recovery for MVP = admin resets it in the dashboard.
--   3. Link the auth user to the driver row:
--        UPDATE drivers SET user_id = '<auth-user-uuid>'
--        WHERE id = '<driver-row-uuid>';
--      (find both:  SELECT id, name FROM drivers;  and the auth UUID in
--       the dashboard user list)
--   4. Run STEP 2 below (the legacy cutover), pasting Andres's DRIVER row
--      UUID where indicated.
--   5. Merge the PR. From that deploy the shared passcode stops working.
--
-- To revoke a driver: UPDATE drivers SET status = 'inactive' WHERE ... ;

-- ============================================================
-- STEP 1: identity link
-- ON DELETE SET NULL: deleting an auth user unlinks the driver (who then
-- cannot sign in) instead of erroring or cascading. UNIQUE already creates
-- its own index — no separate CREATE INDEX needed.
-- Plain ADD COLUMN: the SELECT * views from migrations 006/007 do NOT need
-- to be dropped/recreated.
-- ============================================================

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;

-- ============================================================
-- STEP 2: legacy cutover — run AFTER step 3 above.
-- Post-identity, every action requires an EXACT ownership match (there is
-- no claim-on-first-touch), so any booking mid-lifecycle at deploy time
-- must be assigned here, once, deliberately. Identify Andres by his exact
-- driver-row UUID (never by name — names are not unique).
-- Backfills ONLY unassigned, currently-active rides.
-- ============================================================

UPDATE bookings
SET assigned_driver = '<andres-driver-row-uuid>'  -- paste from: SELECT id, name FROM drivers;
WHERE status IN ('confirmed', 'on_the_way', 'arrived', 'in_progress')
  AND assigned_driver IS NULL;
