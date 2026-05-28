-- ============================================
-- PASSENGERS TABLE MIGRATION
-- For Telegram-linked passenger profiles
-- Run this in Supabase SQL Editor
-- ============================================

-- Create passengers table
CREATE TABLE IF NOT EXISTS passengers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Telegram integration
    telegram_chat_id TEXT UNIQUE,
    telegram_username TEXT,
    telegram_linked BOOLEAN DEFAULT false,

    -- Contact info
    phone TEXT,
    email TEXT,
    name TEXT,

    -- Preferences
    preferred_language TEXT DEFAULT 'es',
    preferred_vehicle TEXT CHECK (preferred_vehicle IN ('sedan', 'suv', 'escalade', 'sprinter', NULL)),

    -- Statistics
    total_rides INTEGER DEFAULT 0,
    total_spent DECIMAL(10, 2) DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_passengers_telegram ON passengers(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_passengers_phone ON passengers(phone);
CREATE INDEX IF NOT EXISTS idx_passengers_telegram_username ON passengers(telegram_username);

-- Enable Row Level Security
ALTER TABLE passengers ENABLE ROW LEVEL SECURITY;

-- Policy: Allow all access (adjust for production)
CREATE POLICY "Allow all access to passengers" ON passengers
    FOR ALL USING (true);

-- Trigger for auto-updating updated_at timestamp
-- (Uses existing update_updated_at function from linkmia-schema.sql)
CREATE TRIGGER update_passengers_updated_at
    BEFORE UPDATE ON passengers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- LINK PASSENGERS TO BOOKINGS
-- Add foreign key reference
-- ============================================

-- Add passenger_id column to bookings table (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bookings' AND column_name = 'passenger_id'
    ) THEN
        ALTER TABLE bookings ADD COLUMN passenger_id UUID REFERENCES passengers(id);
    END IF;
END $$;

-- Index for passenger lookups on bookings
CREATE INDEX IF NOT EXISTS idx_bookings_passenger ON bookings(passenger_id);

-- ============================================
-- HELPER VIEW: Passenger booking history
-- ============================================
CREATE OR REPLACE VIEW passenger_booking_history AS
SELECT
    p.id AS passenger_id,
    p.name AS passenger_name,
    p.telegram_chat_id,
    p.phone,
    b.id AS booking_id,
    b.pickup_location,
    b.dropoff_location,
    b.pickup_datetime,
    b.price,
    b.status,
    b.vehicle_type
FROM passengers p
LEFT JOIN bookings b ON b.passenger_id = p.id
ORDER BY b.pickup_datetime DESC;

-- Grant access to view
GRANT SELECT ON passenger_booking_history TO authenticated;
GRANT SELECT ON passenger_booking_history TO anon;
