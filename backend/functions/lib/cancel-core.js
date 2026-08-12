// Shared passenger-cancellation core (PR 1A: PENDING only).
//
// Used by BOTH /api/cancel-booking (quote + guarded cancel) and the legacy
// /api/booking-status cancel action, so the authorization tightening can
// never diverge between endpoints. Lives in lib/ (no index.js) so Netlify
// never deploys it as its own endpoint; esbuild bundles it.
//
// Authorization matrix (Codex-reviewed):
//   * customer_id IS NULL (legacy guest booking): the unguessable booking
//     UUID remains the capability — these accounts cannot sign in.
//   * customer_id set (account booking): the signed-in OWNER is required.
//     A leaked trip UUID is never enough, pending included: 401 for a
//     missing/invalid token, 403 for an authenticated non-owner, 500 when
//     auth verification is unreachable (never mislabeled as expired —
//     create-booking discipline).
//
// Policy (PR 1A): pending cancels are FREE — feePercent 0, dueNow $0.
// Confirmed/on_the_way/arrived are NOT cancellable through this core yet
// ('unsupported_status' -> support path); PR 2 brings the real fee
// brackets. Terminal rows answer 'terminal'.
//
// Audit: every cancellation stamps the migration-013 shadow-audit columns
// in the SAME guarded UPDATE as the status flip. The 013 outbox trigger
// then inserts the 'ride_cancelled_admin' ledger event in the SAME
// database transaction — a cancelled ride can never exist without its
// notification intention. Delivery is the watchdog's job (~5 min bound);
// PR 1A deliberately has no immediate-dispatch path.

const { createClient } = require('@supabase/supabase-js');

const POLICY_VERSION = 'pilot-2026-08';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelisted booking fields for passenger-facing responses — excludes
// private contact data, internal ids, and ALL cancellation audit fields
// (policy numbers travel only in quote/cancel payloads, never the public
// GET). details_version is deliberately public: the trip page carries it
// into the pending-edit intent, and it is only an edit counter. Single
// source of truth: booking-status.js imports this.
const PASSENGER_FIELDS = 'id, trip_id, status, pickup_location, dropoff_location, pickup_datetime, vehicle_type, vehicle_name, passengers, bags, price, payment_status, customer_name, flight_number, duration_minutes, driver_lat, driver_lng, driver_location_at, details_version';

// What the cancel handlers need to authorize and decide — internal only.
const CANCEL_READ_FIELDS = 'id, trip_id, status, customer_id, pickup_datetime, price';

const TERMINAL_STATUSES = ['completed', 'cancelled', 'declined'];

async function readBookingForCancel(db, id) {
  const { data, error } = await db
    .from('bookings')
    .select(CANCEL_READ_FIELDS)
    .eq('id', id)
    .maybeSingle();
  if (error) return { status: 500, error: 'Lookup failed' };
  if (!data) return { status: 404, error: 'Booking not found' };
  return { booking: data };
}

// Resolve the caller's cancellation identity for this booking.
// Returns { actor: { cancelledBy, userId } } or { status, error }.
async function authorizeCancel(event, booking, { supabaseUrl, anonKey, db }) {
  if (!booking.customer_id) {
    // Legacy guest booking: the UUID itself is the (pending-only) capability.
    return { actor: { cancelledBy: 'uuid_link', userId: null } };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { status: 401, error: 'Not authenticated' };

  try {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError) {
      // Outages arrive as error RESULTS. A network/service failure must be
      // 500 — never mislabeled as an expired session.
      const retryable = userError.name === 'AuthRetryableFetchError' ||
        !userError.status || userError.status >= 500;
      if (retryable) {
        console.error('❌ Cancel auth verification unavailable:', userError.message);
        return { status: 500, error: 'Could not verify sign-in' };
      }
      return { status: 401, error: 'Invalid session' };
    }
    if (!userData?.user) return { status: 401, error: 'Invalid session' };

    const { data: customer, error: customerError } = await db
      .from('customers')
      .select('id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (customerError) {
      console.error('❌ Cancel owner lookup failed:', customerError.message);
      return { status: 500, error: 'Could not verify account' };
    }
    if (!customer || customer.id !== booking.customer_id) {
      return { status: 403, error: 'This booking belongs to a different account' };
    }
    return { actor: { cancelledBy: 'passenger_auth', userId: userData.user.id } };
  } catch (authError) {
    console.error('❌ Cancel auth verification failed:', authError.message);
    return { status: 500, error: 'Could not verify sign-in' };
  }
}

// Server-computed cancellation quote. PR 1A: pending is free; accepted
// statuses are not yet self-service (PR 2 brings the 50%/100% brackets).
function computeQuote(booking, nowMs) {
  const base = {
    status: booking.status,
    policyVersion: POLICY_VERSION,
    pickupAt: booking.pickup_datetime,
    serverTime: new Date(nowMs).toISOString()
  };
  if (booking.status === 'pending') {
    return {
      ...base,
      cancellable: true,
      reason: 'pending_free',
      feePercent: 0,
      policyAmount: 0,
      waiverAmount: 0,
      dueNow: 0
    };
  }
  if (TERMINAL_STATUSES.includes(booking.status)) {
    return { ...base, cancellable: false, reason: 'terminal' };
  }
  // confirmed / on_the_way / arrived / in_progress / legacy 'assigned'
  return { ...base, cancellable: false, reason: 'unsupported_status' };
}

// Compare the quote the passenger reviewed against a fresh computation.
// Values are NEVER policy inputs — only a compare-and-set expectation.
function expectedMatchesQuote(expected, quote) {
  if (!expected || typeof expected !== 'object') return false;
  return expected.status === quote.status &&
    Number(expected.feePercent) === quote.feePercent &&
    Number(expected.policyAmount) === quote.policyAmount &&
    expected.policyVersion === quote.policyVersion &&
    Date.parse(expected.pickupAt) === Date.parse(quote.pickupAt);
}

// Guarded cancellation: status flip + full shadow audit + coordinate
// clear in ONE conditional UPDATE (the 013 outbox trigger makes the
// ledger event part of the same transaction). 0 rows = lost the race.
async function performCancel(db, booking, quote, actor, nowMs) {
  const updates = {
    status: 'cancelled',
    cancelled_at: new Date(nowMs).toISOString(),
    cancelled_from_status: booking.status,
    cancelled_by: actor.cancelledBy,
    cancel_actor_user_id: actor.userId,
    cancel_pickup_at: booking.pickup_datetime,
    cancel_policy_version: quote.policyVersion,
    cancel_fee_percent: quote.feePercent,
    cancel_fee_policy_amount: quote.policyAmount,
    cancel_fee_collected: 0,
    // Free bracket: nothing to waive. PR 2 stamps pilot_waiver/system on
    // the fee-bearing brackets.
    cancel_waiver_reason: quote.feePercent > 0 ? 'pilot_waiver' : null,
    cancel_waived_by: quote.feePercent > 0 ? 'system' : null,
    // Privacy: uniform coordinate clear (pending rows have none, but the
    // rule is one rule).
    driver_lat: null,
    driver_lng: null,
    driver_location_at: null
  };

  const { data, error } = await db
    .from('bookings')
    .update(updates)
    .eq('id', booking.id)
    .eq('status', booking.status)
    .select(PASSENGER_FIELDS);

  if (error) return { dbError: error };
  if (!data || data.length === 0) return { conflict: true };
  return { row: data[0] };
}

module.exports = {
  POLICY_VERSION,
  UUID_RE,
  PASSENGER_FIELDS,
  TERMINAL_STATUSES,
  readBookingForCancel,
  authorizeCancel,
  computeQuote,
  expectedMatchesQuote,
  performCancel
};
