-- Migration 003: Capture all booking form data points
-- Run this in the Supabase SQL Editor.
--
-- Adds columns for fields the booking form collects that previously
-- never reached the database:
--   customer_email  - guest's email (when booking for someone else)
--   pickup_sign     - name to show on the pickup sign
--   promo_code      - promotion code entered at booking
--   booking_mode    - 'dropoff' (to airport) or 'pickup' (from airport)
--   booker_name/booker_phone - who made the booking, when different from
--                              the traveling passenger (customer_*)

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_email TEXT,
  ADD COLUMN IF NOT EXISTS pickup_sign TEXT,
  ADD COLUMN IF NOT EXISTS promo_code TEXT,
  ADD COLUMN IF NOT EXISTS booking_mode TEXT,
  ADD COLUMN IF NOT EXISTS booker_name TEXT,
  ADD COLUMN IF NOT EXISTS booker_phone TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_name TEXT;
