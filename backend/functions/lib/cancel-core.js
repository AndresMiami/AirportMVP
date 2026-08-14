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
// Policy (PR 3B — CLOCK-based, SILENT): pending / confirmed / on_the_way
// / arrived are self-service cancellable. The shadow percentage comes
// from the SERVER clock vs pickup_datetime ONLY — driver-controlled
// checkpoints never move it: accepted >2h out -> 0; from T-2h through
// pickup -> 50; at/after pickup -> 100. in_progress and terminals are
// not cancellable; legacy guest ACCEPTED rows (customer_id NULL, no way
// to authenticate ownership) -> 'requires_support'.
//
// SILENCE: the fee numbers are computed and AUDITED on every
// cancellation but never shown — visibleQuote() strips them from every
// passenger-facing payload (quote, 409s, applied) unless
// CANCEL_FEE_DISPLAY is set (the future activation lever). An invalid
// stored price never blocks cancellation and never fabricates $0: the
// hypothetical amount is recorded as NULL (a real $0 fare stays $0.00).
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

// Self-service cancellable statuses (eligibility — never the percent).
const SELF_SERVICE_STATUSES = ['pending', 'confirmed', 'on_the_way', 'arrived'];

// The clock line: strictly MORE than 2h before pickup is free.
const FREE_WINDOW_MS = 2 * 60 * 60 * 1000;

// Activation lever for the fee DISPLAY (never collection — that stays
// impossible via the migration-013 CHECK until its own future PR).
function feeDisplayEnabled() {
  return process.env.CANCEL_FEE_DISPLAY === '1' || process.env.CANCEL_FEE_DISPLAY === 'true';
}

// Fields the CAS compares. serverTime is NEVER compared (it changes
// between requests by nature); fee fields join only while displayed.
function casFields() {
  return feeDisplayEnabled()
    ? ['status', 'pickupAt', 'policyVersion', 'feePercent', 'policyAmount']
    : ['status', 'pickupAt', 'policyVersion'];
}

// The passenger-facing projection of a quote: with display OFF the fee
// arithmetic is absent from EVERY response — quote, 409 conflicts, and
// the final applied summary alike.
function visibleQuote(quote) {
  if (!quote) return quote;
  if (feeDisplayEnabled()) return quote;
  const { feePercent, policyAmount, waiverAmount, dueNow, ...visible } = quote;
  return visible;
}

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

// Server-computed cancellation quote — the INTERNAL truth. Callers must
// pass it through visibleQuote() before it reaches a passenger.
function computeQuote(booking, nowMs) {
  const base = {
    status: booking.status,
    policyVersion: POLICY_VERSION,
    pickupAt: booking.pickup_datetime,
    serverTime: new Date(nowMs).toISOString()
  };
  if (TERMINAL_STATUSES.includes(booking.status)) {
    return { ...base, cancellable: false, reason: 'terminal' };
  }
  if (booking.status === 'in_progress') {
    return { ...base, cancellable: false, reason: 'in_progress' };
  }
  if (!SELF_SERVICE_STATUSES.includes(booking.status)) {
    // legacy 'assigned' and any future surprise: support path.
    return { ...base, cancellable: false, reason: 'requires_support' };
  }
  if (booking.status !== 'pending' && !booking.customer_id) {
    // Legacy guest ACCEPTED ride: no way to authenticate ownership, and
    // a bare UUID must never cancel a committed driver's ride.
    return { ...base, cancellable: false, reason: 'requires_support' };
  }

  // Shadow percentage: SERVER clock vs the scheduled pickup, nothing
  // else. Checkpoints gate eligibility above, never the percent.
  let feePercent;
  let reason;
  if (booking.status === 'pending') {
    feePercent = 0;
    reason = 'pending_free';
  } else {
    const pickupMs = Date.parse(booking.pickup_datetime);
    if (!Number.isFinite(pickupMs)) {
      // Defensive only (pickup_datetime is NOT NULL timestamptz): an
      // unclockable pickup records NULL percent/amount, never a guess.
      feePercent = null;
      reason = 'accepted_unclocked';
    } else if (nowMs >= pickupMs) {
      feePercent = 100;
      reason = 'after_pickup_time';
    } else if (pickupMs - nowMs > FREE_WINDOW_MS) {
      feePercent = 0;
      reason = 'accepted_free_window';
    } else {
      feePercent = 50;
      reason = 'accepted_late';
    }
  }

  // Hypothetical amount: an invalid stored price records NULL — never a
  // fabricated $0 — while a real zero-dollar fare stays $0.00. Absence
  // is rejected BEFORE conversion: Number(null) and Number('') are both
  // 0, and bookings.price is nullable.
  const rawPrice = booking.price;
  const priceAbsent = rawPrice === null || rawPrice === undefined ||
    (typeof rawPrice === 'string' && rawPrice.trim() === '');
  const priceNum = priceAbsent ? NaN : Number(rawPrice);
  const priceValid = Number.isFinite(priceNum) && priceNum >= 0;
  const policyAmount = (feePercent === null || !priceValid)
    ? null
    : Math.round(priceNum * feePercent) / 100;

  return {
    ...base,
    cancellable: true,
    reason,
    feePercent,
    policyAmount,
    waiverAmount: policyAmount,
    dueNow: 0
  };
}

// Compare the quote the passenger reviewed against a fresh computation.
// Values are NEVER policy inputs — only a compare-and-set expectation.
// INTERSECTION rule: exactly the casFields() are compared; extra client
// fields are ignored (an already-open older trip tab may still send fee
// fields the silent server no longer exposes); serverTime is never
// compared (it changes between requests by nature).
function expectedMatchesQuote(expected, quote) {
  if (!expected || typeof expected !== 'object') return false;
  for (const field of casFields()) {
    if (!(field in expected)) return false;
    if (field === 'pickupAt') {
      if (Date.parse(expected.pickupAt) !== Date.parse(quote.pickupAt)) return false;
    } else if (field === 'feePercent' || field === 'policyAmount') {
      const exp = expected[field] === null ? null : Number(expected[field]);
      if (exp !== quote[field]) return false;
    } else if (expected[field] !== quote[field]) {
      return false;
    }
  }
  return true;
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
  SELF_SERVICE_STATUSES,
  readBookingForCancel,
  authorizeCancel,
  computeQuote,
  expectedMatchesQuote,
  performCancel,
  visibleQuote,
  feeDisplayEnabled
};
