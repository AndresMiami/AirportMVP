-- Migration 006: Ambassador reporting views
-- Run this in the Supabase SQL Editor.
--
-- bookings_with_ambassador: bookings with the ambassador's name/code joined
-- in, so the Table Editor shows who referred each ride at a glance.
--
-- ambassador_earnings: the monthly payout sheet. Commissions count as
-- earned ONLY on completed rides — cancelled/declined never pay out.

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

CREATE OR REPLACE VIEW ambassador_earnings AS
SELECT
    h.id,
    h.name,
    h.property_name,
    h.referral_code,
    h.commission_rate,
    h.status,
    COUNT(b.id) FILTER (WHERE b.status = 'completed')                                   AS completed_rides,
    COUNT(b.id) FILTER (WHERE b.status NOT IN ('completed', 'cancelled', 'declined'))   AS active_rides,
    COALESCE(SUM(b.host_commission) FILTER (WHERE b.status = 'completed'), 0)           AS earned_total
FROM hosts h
LEFT JOIN bookings b ON b.referred_by_host = h.id
GROUP BY h.id;
