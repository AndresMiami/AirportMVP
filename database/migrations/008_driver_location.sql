-- Migration 008: Live driver location for in-app tracking
-- Run this in the Supabase SQL Editor.
--
-- The driver page broadcasts browser geolocation while a ride is active
-- (on_the_way / arrived / in_progress); the passenger trip page reads it
-- and shows a live car marker on the route map.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS driver_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS driver_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS driver_location_at TIMESTAMPTZ;
