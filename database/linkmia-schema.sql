-- ============================================
-- LINKMIA DATABASE SCHEMA
-- Run this in your Supabase SQL Editor
-- ============================================

-- ============================================
-- 1. CUSTOMERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    type TEXT DEFAULT 'guest' CHECK (type IN ('guest', 'repeat', 'vip', 'host')),
    source TEXT DEFAULT 'telegram' CHECK (source IN ('telegram', 'imessage', 'website', 'referral', 'host_link')),
    telegram_chat_id TEXT, -- Telegram chat ID for direct messaging
    referred_by UUID REFERENCES customers(id),
    notes TEXT,
    total_rides INTEGER DEFAULT 0,
    total_spent DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_type ON customers(type);

-- ============================================
-- 2. DRIVERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    telegram_chat_id TEXT, -- Telegram chat ID for ride notifications
    vehicle_type TEXT CHECK (vehicle_type IN ('sedan', 'suv', 'escalade', 'sprinter', 'other')),
    vehicle_details TEXT, -- e.g., "Black Escalade 2024"
    license_plate TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'busy', 'inactive')),
    commission_rate DECIMAL(3,2) DEFAULT 0.75, -- 75% to driver
    total_rides INTEGER DEFAULT 0,
    total_earnings DECIMAL(10,2) DEFAULT 0,
    rating DECIMAL(2,1) DEFAULT 5.0,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);

-- ============================================
-- 3. HOSTS TABLE (For B2B referrals) - Created before bookings due to FK
-- ============================================
CREATE TABLE IF NOT EXISTS hosts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id),

    -- Host info
    name TEXT NOT NULL,
    property_name TEXT, -- e.g., "Casa Miami"
    referral_code TEXT UNIQUE NOT NULL, -- e.g., "casa-miami"

    -- Contact
    phone TEXT,
    email TEXT,

    -- Commission settings
    commission_rate DECIMAL(3,2) DEFAULT 0.10, -- 10% kickback

    -- Stats
    total_referrals INTEGER DEFAULT 0,
    total_earnings DECIMAL(10,2) DEFAULT 0,

    -- Status
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'pending', 'inactive')),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosts_referral_code ON hosts(referral_code);

-- ============================================
-- 4. BOOKINGS TABLE (Main dispatch table)
-- ============================================
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Customer info (can link to customers table or store directly)
    customer_id UUID REFERENCES customers(id),
    customer_name TEXT NOT NULL,
    customer_phone TEXT,

    -- Trip details
    pickup_location TEXT NOT NULL,
    dropoff_location TEXT NOT NULL,
    pickup_datetime TIMESTAMPTZ NOT NULL,

    -- Passengers & luggage
    passengers INTEGER DEFAULT 1,
    bags INTEGER DEFAULT 0,

    -- Vehicle
    vehicle_type TEXT DEFAULT 'sedan' CHECK (vehicle_type IN ('sedan', 'suv', 'escalade', 'sprinter', 'multiple')),
    vehicles_needed INTEGER DEFAULT 1,

    -- Status workflow
    status TEXT DEFAULT 'pending' CHECK (status IN (
        'pending',      -- Just received, not confirmed
        'confirmed',    -- Confirmed with customer
        'assigned',     -- Driver assigned
        'in_progress',  -- Ride is happening
        'completed',    -- Ride finished
        'cancelled'     -- Cancelled
    )),

    -- Assignment
    assigned_driver UUID REFERENCES drivers(id),

    -- Pricing
    price DECIMAL(10,2) DEFAULT 0,
    driver_payout DECIMAL(10,2) GENERATED ALWAYS AS (price * 0.75) STORED,
    linkmia_commission DECIMAL(10,2) GENERATED ALWAYS AS (price * 0.25) STORED,

    -- Payment
    payment_status TEXT DEFAULT 'unpaid' CHECK (payment_status IN (
        'unpaid',
        'paid_by_guest',
        'driver_paid'
    )),
    payment_method TEXT,

    -- Additional info
    flight_number TEXT,
    cruise_ship TEXT,
    notes TEXT,

    -- Referral tracking
    source TEXT DEFAULT 'telegram',
    referred_by_host UUID REFERENCES hosts(id),
    host_commission DECIMAL(10,2) DEFAULT 0,

    -- Passenger communication (linked when passenger taps Telegram link)
    passenger_telegram_chat_id TEXT,

    -- Group bookings (link related multi-car bookings)
    group_booking_id UUID,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup_datetime ON bookings(pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_bookings_assigned_driver ON bookings(assigned_driver);
CREATE INDEX IF NOT EXISTS idx_bookings_customer_phone ON bookings(customer_phone);
CREATE INDEX IF NOT EXISTS idx_bookings_group ON bookings(group_booking_id);

-- ============================================
-- 5. PAYMENTS TABLE (For tracking payouts)
-- ============================================
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID REFERENCES bookings(id),

    amount DECIMAL(10,2) NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        'guest_payment',
        'driver_payout',
        'host_commission'
    )),
    method TEXT CHECK (method IN ('cash', 'zelle', 'venmo', 'stripe', 'card', 'other')),

    -- Reference
    reference_number TEXT,
    notes TEXT,

    -- Timestamps
    payment_date TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_type ON payments(type);

-- ============================================
-- 6. ACTIVITY LOG (For tracking changes)
-- ============================================
CREATE TABLE IF NOT EXISTS activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    entity_type TEXT NOT NULL, -- 'booking', 'customer', 'driver', etc.
    entity_id UUID NOT NULL,
    action TEXT NOT NULL, -- 'created', 'updated', 'status_changed', etc.

    old_value JSONB,
    new_value JSONB,

    performed_by TEXT, -- 'admin', 'system', driver name, etc.

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);

-- ============================================
-- 7. HELPER FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables
CREATE TRIGGER update_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_drivers_updated_at
    BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_hosts_updated_at
    BEFORE UPDATE ON hosts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 8. ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- For now, allow all access (you're the only admin)
-- In production, you'd want more restrictive policies

CREATE POLICY "Allow all access to customers" ON customers FOR ALL USING (true);
CREATE POLICY "Allow all access to drivers" ON drivers FOR ALL USING (true);
CREATE POLICY "Allow all access to bookings" ON bookings FOR ALL USING (true);
CREATE POLICY "Allow all access to hosts" ON hosts FOR ALL USING (true);
CREATE POLICY "Allow all access to payments" ON payments FOR ALL USING (true);
CREATE POLICY "Allow all access to activity_log" ON activity_log FOR ALL USING (true);

-- ============================================
-- 9. SAMPLE DATA (Optional - for testing)
-- ============================================

-- Insert yourself as a driver
INSERT INTO drivers (name, phone, vehicle_type, vehicle_details, status, notes)
VALUES
    ('Andres', '+1-555-000-0001', 'escalade', 'Black Escalade 2024', 'active', 'Founder/Primary driver'),
    ('Carlos M.', '+1-555-000-0002', 'suv', 'Black Suburban 2023', 'active', 'Reliable backup driver'),
    ('David R.', '+1-555-000-0003', 'sprinter', 'Black Sprinter 2022', 'active', 'Large groups specialist')
ON CONFLICT DO NOTHING;

-- Insert sample customers
INSERT INTO customers (name, phone, type, notes)
VALUES
    ('Chrissy Rice', '+1-555-123-4567', 'vip', 'Family group of 19, cruise customers'),
    ('Cruise Port Lady', '+1-555-234-5678', 'repeat', 'Regular cruise pickup customer')
ON CONFLICT DO NOTHING;

-- ============================================
-- 10. USEFUL VIEWS
-- ============================================

-- Today's bookings view
CREATE OR REPLACE VIEW todays_bookings AS
SELECT
    b.*,
    d.name as driver_name,
    d.phone as driver_phone
FROM bookings b
LEFT JOIN drivers d ON b.assigned_driver = d.id
WHERE DATE(b.pickup_datetime) = CURRENT_DATE
ORDER BY b.pickup_datetime;

-- Pending assignments view
CREATE OR REPLACE VIEW pending_assignments AS
SELECT * FROM bookings
WHERE status IN ('pending', 'confirmed')
AND assigned_driver IS NULL
ORDER BY pickup_datetime;

-- Revenue summary view
CREATE OR REPLACE VIEW revenue_summary AS
SELECT
    DATE_TRUNC('month', completed_at) as month,
    COUNT(*) as total_rides,
    SUM(price) as total_revenue,
    SUM(linkmia_commission) as total_commission,
    SUM(driver_payout) as total_driver_payouts
FROM bookings
WHERE status = 'completed'
GROUP BY DATE_TRUNC('month', completed_at)
ORDER BY month DESC;

-- ============================================
-- DONE! Your LinkMia database is ready.
-- ============================================
