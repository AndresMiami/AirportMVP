-- Migration 002: Dispatch statuses for the driver-page flow
-- Run this in the Supabase SQL Editor.
--
-- Expands the booking status lifecycle so the driver page can progress rides:
--   pending -> confirmed -> on_the_way -> arrived -> completed
--   terminals: declined (driver), cancelled (passenger)
-- Legacy values (assigned, in_progress) are kept so existing rows and
-- admin.html remain valid.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
    'pending',      -- awaiting driver accept
    'confirmed',    -- driver accepted
    'on_the_way',   -- driver en route to pickup
    'arrived',      -- driver at pickup
    'completed',    -- ride finished
    'declined',     -- driver declined
    'cancelled',    -- passenger cancelled
    'assigned',     -- legacy
    'in_progress'   -- legacy
));

-- Promote the LM-XXXX display code out of the notes text into its own column.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS trip_id TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_trip_id ON bookings(trip_id);
