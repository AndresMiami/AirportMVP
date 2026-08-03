-- Migration 007: LinkMia commission becomes NET of ambassador share
-- Run this in the Supabase SQL Editor.
--
-- Before: linkmia_commission = price * 0.25 (gross), ambassador share
-- tracked separately, so the numbers didn't add up at a glance.
-- After:  linkmia_commission = price * 0.25 - host_commission (net).
-- Example: $105 ride, 6% ambassador -> driver 78.75, ambassador 6.30,
-- LinkMia 19.95 (19% of gross). Rows recompute automatically.
--
-- bookings_with_ambassador is dropped and recreated because it selects
-- host_commission; revenue_summary because it selects linkmia_commission.

DROP VIEW IF EXISTS revenue_summary;
DROP VIEW IF EXISTS bookings_with_ambassador;

ALTER TABLE bookings DROP COLUMN IF EXISTS linkmia_commission;
ALTER TABLE bookings ADD COLUMN linkmia_commission DECIMAL(10,2)
    GENERATED ALWAYS AS (price * 0.25 - COALESCE(host_commission, 0)) STORED;

CREATE OR REPLACE VIEW revenue_summary AS
SELECT
    DATE_TRUNC('month', completed_at) as month,
    COUNT(*) as total_rides,
    SUM(price) as total_revenue,
    SUM(linkmia_commission) as total_commission,
    SUM(host_commission) as total_ambassador_commissions,
    SUM(driver_payout) as total_driver_payouts
FROM bookings
WHERE status = 'completed'
GROUP BY DATE_TRUNC('month', completed_at)
ORDER BY month DESC;

CREATE OR REPLACE VIEW bookings_with_ambassador AS
SELECT
    b.id,
    b.trip_id,
    b.created_at,
    b.status,
    b.customer_name,
    b.pickup_location,
    b.dropoff_location,
    b.pickup_datetime,
    b.vehicle_name,
    b.price,
    b.host_commission,
    h.name          AS ambassador_name,
    h.property_name AS ambassador_organization,
    h.referral_code AS ambassador_code
FROM bookings b
LEFT JOIN hosts h ON h.id = b.referred_by_host;
