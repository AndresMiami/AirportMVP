-- Migration 009: Driver identity — link drivers to auth accounts
-- Run this in the Supabase SQL Editor BEFORE merging the driver-identity PR.
--
-- Drivers are ADMIN-PROVISIONED (CreditEngine pattern) — there is no driver
-- signup anywhere, ever. To provision a driver:
--   1. Supabase Dashboard -> Authentication -> Add user
--      (email + password, "Auto Confirm User" ON).
--   2. Copy the new auth user's UUID and link it to the driver row:
--        UPDATE drivers SET user_id = '<auth-user-uuid>'
--        WHERE name = 'Andres';  -- or whichever driver is being provisioned
--   3. The driver signs into /driver with that email + password.
-- To revoke a driver: UPDATE drivers SET status = 'inactive' WHERE ... ;
-- (the backend rejects non-active drivers regardless of a valid login).
--
-- Plain ADD COLUMN: the SELECT * views from migrations 006/007 do NOT need
-- to be dropped/recreated (they simply won't include the new column).

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS user_id UUID UNIQUE REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_drivers_user_id ON drivers(user_id);
