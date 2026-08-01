-- Migration 004: Store the estimated ride duration
-- Run this in the Supabase SQL Editor.
--
-- The booking flow already computes a traffic-aware ride duration via the
-- directions API; storing it lets the trip status page show an estimated
-- arrival time alongside the pickup time.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
