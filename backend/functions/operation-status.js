// R1 — read-only operation-status recovery (address plan v3, ordered
// prerequisite R1; contract ratified in relay seq:77/seq:86).
//
//   POST /api/operation-status { operationId, kind, bookingId? }
//     -> { settled: true, bookingId, tripId, detailsVersion? }
//     -> { settled: false }
//
// This endpoint exists so the interrupted-booking envelope can stop
// persisting the request body (route facts, addresses, the quote token) in
// sessionStorage: after a reload, "Check again" asks THIS endpoint whether
// the original write settled, instead of re-POSTing stored bytes. Because
// ambassadors are exempt from the one-active-booking rule, the byte-exact
// operation receipt is their only duplicate-booking defence — recovery must
// therefore be a READ, never a write.
//
// Deliberate properties:
//   * POST, not GET — the recovery capability never lands in an access-log
//     URL.
//   * The caller is the Bearer JWT, never a body field.
//   * kind maps to the receipt vocabulary: create -> 'create',
//     edit -> 'edit_quoted'. For edits the retained bookingId must equal the
//     receipt's booking_id.
//   * A miss and EVERY identity/kind/booking mismatch return the identical
//     { settled: false } — no booking reference is disclosed, and no RPC,
//     provider call, database write or notification is performed on any
//     path. This endpoint only ever SELECTs.
//   * The settled response is an allowlist: bookingId, tripId, and
//     detailsVersion for edits. Nothing else from either row leaves.

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Null-prototype map: an inherited-property lookup would accept
// kind:"toString" (round-2 executed probe). Own keys only, ever.
const KIND_TO_RECEIPT = Object.freeze(Object.assign(Object.create(null), {
  create: 'create', edit: 'edit_quoted'
}));

// Supabase auth outages must read as outages, never as "invalid session"
// (CreditEngine discipline, same classifier as the booking writers).
function authUnavailable(error) {
  // Canonical writer classifier (quote-ride.js:96): a retryable fetch error,
  // a MISSING status (network-shaped failures carry none), or any 5xx. The
  // first version omitted the missing-status case and answered a network
  // failure with a false 401 — caught by Codex's executed probe.
  return error?.name === 'AuthRetryableFetchError' || !error?.status || error.status >= 500;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('❌ operation-status configuration incomplete');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }
  // Valid JSON is not necessarily a usable request: null, arrays and
  // primitives parse cleanly and then explode on property access.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const operationId = typeof body.operationId === 'string' ? body.operationId.trim() : '';
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const receiptKind = Object.prototype.hasOwnProperty.call(KIND_TO_RECEIPT, kind)
    ? KIND_TO_RECEIPT[kind] : undefined;
  // bookingId strictness: PRESENCE of the key is invalid for create (a
  // numeric or null value must not normalize into acceptance); edit requires
  // a UUID STRING, never a coerced value.
  const bookingId = typeof body.bookingId === 'string' ? body.bookingId.trim() : '';
  if (!UUID_RE.test(operationId) || !receiptKind ||
      (kind === 'edit' && (typeof body.bookingId !== 'string' || !UUID_RE.test(bookingId))) ||
      (kind === 'create' && 'bookingId' in body)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  // ---- requireAuth (profile.js pattern + outage discipline) ----
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };
  }
  const authClient = createClient(supabaseUrl, anonKey);
  let userData, userError;
  try {
    ({ data: userData, error: userError } = await authClient.auth.getUser(token));
  } catch (e) {
    // A THROWN auth failure is an outage, identical to a returned one.
    console.error('❌ operation-status auth verification threw');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify sign-in' }) };
  }
  if (userError) {
    if (authUnavailable(userError)) {
      console.error('❌ operation-status auth verification unavailable');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify sign-in' }) };
    }
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
  }
  if (!userData?.user?.id) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
  }
  const authUserId = userData.user.id;

  const miss = { statusCode: 200, headers, body: JSON.stringify({ settled: false }) };

  try {
    const db = createClient(supabaseUrl, serviceKey);
    const { data: receipt, error: receiptError } = await db
      .from('operation_receipts')
      .select('operation_request_id, kind, auth_user_id, booking_id')
      .eq('operation_request_id', operationId)
      .maybeSingle();

    if (receiptError) {
      console.error('❌ operation-status receipt lookup failed:', receiptError.code || 'db_error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup unavailable' }) };
    }

    // Miss and mismatch are DELIBERATELY indistinguishable.
    if (!receipt ||
        receipt.auth_user_id !== authUserId ||
        receipt.kind !== receiptKind ||
        (kind === 'edit' && receipt.booking_id !== bookingId)) {
      return miss;
    }

    const { data: bookingRow, error: bookingError } = await db
      .from('bookings')
      .select('id, trip_id, details_version')
      .eq('id', receipt.booking_id)
      .maybeSingle();

    if (bookingError || !bookingRow) {
      // The receipt proves the write settled; a missing row is a server-side
      // inconsistency, not a passenger-correctable state.
      console.error('❌ operation-status booking read failed');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup unavailable' }) };
    }

    const out = { settled: true, bookingId: bookingRow.id, tripId: bookingRow.trip_id || null };
    if (kind === 'edit') out.detailsVersion = bookingRow.details_version;
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    console.error('❌ operation-status failed:', e?.message ? 'internal' : 'unknown');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup unavailable' }) };
  }
};
