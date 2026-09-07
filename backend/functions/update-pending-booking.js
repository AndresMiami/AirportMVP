// Authenticated, in-place editing for an account-owned pending ride —
// PR 3C-2C-B PR-1 (plan v3.1): the WRITER SWAP. The guarded direct UPDATE is
// replaced by migration 017's accept_quote_edit RPC — ONE lane for every
// full-form edit (accept_optional_edit is reserved for Manage Ride's future
// explicit patch interface; no diff-based lane selection exists anywhere).
// The RPC owns ownership, the pending+unassigned gate, the details_version
// CAS, optional-field preservation, booker coherence, and the frozen
// commission ratio; the booking identity never changes.
//
// payment_method is IGNORED UNCONDITIONALLY and never included in p_edit:
// the current browser force-sends a default ('cash'), so field presence can
// never mean "the passenger changed payment". The stored value survives
// every edit until a real payment-control contract exists.

const { createClient } = require('@supabase/supabase-js');
const {
  sha256Hex, isUuid, readPresentedToken, classifyToken, recoveryLookup,
  sharedOutcomeResponse, unknownOutcomeResponse
} = require('./lib/booking-writer');
const { isValidPlaceId } = require('./lib/place-identity');
const { resolveRateCard } = require('./lib/rate-card-resolver');
const {
  VEHICLE_KEYS: CONTRACT_KEYS, WRITER_CEILINGS,
  ownVehicle, storedPairToKey
} = require('./lib/vehicle-contract');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VEHICLE_TYPE = {
  Sedan: 'sedan', sedan: 'sedan', 'Tesla Model Y': 'sedan',
  SUV: 'suv', suv: 'suv', Escalade: 'suv', escalade: 'suv',
  'Black Escalade': 'suv', 'Cadillac Escalade': 'suv',
  Sprinter: 'sprinter', sprinter: 'sprinter', 'Mercedes Sprinter': 'sprinter'
};
const VEHICLE_KEYS = ['tesla', 'escalade', 'sprinter'];
const AIRPORT_CODES = ['MIA', 'FLL', 'PBI'];

const RESPONSE_FIELDS = 'id, trip_id, status, pickup_location, dropoff_location, pickup_datetime, vehicle_type, vehicle_name, passengers, bags, price, payment_status, customer_name, flight_number, duration_minutes, details_version';

function text(value, max, required = false) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if (required && !cleaned) return null;
  return cleaned ? cleaned.slice(0, max) : null;
}

function authUnavailable(error) {
  return error?.name === 'AuthRetryableFetchError' || !error?.status || error.status >= 500;
}

async function requirePassenger(event, supabaseUrl, anonKey, db) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { status: 401, error: 'Not authenticated' };

  try {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError) {
      if (authUnavailable(userError)) return { status: 500, error: 'Could not verify sign-in' };
      return { status: 401, error: 'Invalid session' };
    }
    if (!userData?.user) return { status: 401, error: 'Invalid session' };

    const { data: customer, error: customerError } = await db
      .from('customers')
      .select('id')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (customerError) {
      console.error('pending-edit customer lookup failed:', customerError.code || 'db_error');
      return { status: 500, error: 'Could not verify account' };
    }
    if (!customer) return { status: 403, error: 'Account profile incomplete' };
    return { customerId: customer.id, authUserId: userData.user.id };
  } catch (error) {
    console.error('pending-edit auth failed:', error.code || error.name || 'auth_error');
    return { status: 500, error: 'Could not verify sign-in' };
  }
}

function parseEdit(body) {
  const bookingId = body.bookingId;
  const expectedVersion = Number(body.expectedDetailsVersion);
  const customerName = text(body.customerName, 120, true);
  const phone = text(body.phone, 40, true);
  const pickup = text(body.pickup, 500, true);
  const dropoff = text(body.dropoff, 500, true);
  const vehicleName = text(body.vehicle, 120, true);
  const price = Number(body.price);
  const pickupMs = Date.parse(body.dateTime);
  const passengers = Number.parseInt(body.passengers, 10);
  const bags = Number.parseInt(body.bags, 10);
  const duration = body.durationMinutes == null || body.durationMinutes === ''
    ? null : Number.parseInt(body.durationMinutes, 10);

  if (!UUID_RE.test(bookingId || '') || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { error: 'Invalid booking edit identity' };
  }
  if (!customerName || !phone || !pickup || !dropoff || !vehicleName ||
      !Number.isFinite(price) || price <= 0 || price > 100000 ||
      !Number.isFinite(pickupMs) ||
      !Number.isInteger(passengers) || passengers < 1 || passengers > 12 ||
      !Number.isInteger(bags) || bags < 0 || bags > 15 ||
      (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1440))) {
    return { error: 'Invalid ride details' };
  }

  const vehicleType = VEHICLE_TYPE[vehicleName];
  if (!vehicleType) return { error: 'Invalid vehicle' };

  const operationId = body.operationId ?? null;
  if (operationId !== null && !isUuid(operationId)) {
    return { error: 'Invalid ride details' };
  }

  return {
    bookingId,
    expectedVersion,
    operationId,
    price,
    pickupMs,
    // Full-replace ride details (the form re-validates them every edit).
    // payment_method is deliberately ABSENT — ignored unconditionally.
    values: {
      customer_name: customerName,
      customer_phone: phone,
      pickup_location: pickup,
      dropoff_location: dropoff,
      pickup_datetime: new Date(pickupMs).toISOString(),
      passengers,
      bags,
      vehicle_type: vehicleType,
      vehicle_name: vehicleName,
      booking_mode: body.mode === 'pickup' ? 'pickup' : 'dropoff'
      // R1: duration is validated above for input strictness but never
      // forwarded — migration 018's writer persists NULL in every mode and
      // actively clears any legacy stored value on the row it touches.
    },
    // Optional personal details: omitted keys mean "not submitted/blank" —
    // the RPC preserves the stored value in that case (a restored session
    // or fresh device starts from an empty form and must never silently
    // erase data the passenger didn't retype).
    optional: {
      customer_email: text(body.email, 254),
      flight_number: text(body.flightNumber, 80),
      notes: text(body.notes, 2000),
      pickup_sign: text(body.pickupSign, 160),
      promo_code: text(body.promoCode, 80)
    },
    // Booker pair: the RPC resolves coherence against the stored row (a
    // phone may only ever be stored alongside a name; submitting the
    // passenger's own name clears the pair; a blank name preserves it).
    booker: {
      name: text(body.bookerName, 120),
      phone: text(body.bookerPhone, 40)
    }
  };
}

async function sendUpdatedDoorbell(booking) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const pickup = new Date(booking.pickup_datetime);
  const when = pickup.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York'
  });
  const message = `✏️ Ride ${booking.trip_id || booking.id.slice(0, 8)} updated\n${when}\n${booking.pickup_location} → ${booking.dropoff_location}\n🚘 ${booking.vehicle_name || booking.vehicle_type} · 👥 ${booking.passengers} · 🧳 ${booking.bags}\n💵 $${booking.price}\nOpen driver page: ${(process.env.URL || 'https://linkmia.com')}/driver`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: controller.signal
    });
    if (!res.ok) {
      // Sanitized: status code only — never the token, chat id, or body.
      console.warn('pending-edit Telegram rejected:', res.status);
    }
  } catch (error) {
    // The database is authoritative; an ops notification failure must not
    // turn a committed edit into a false passenger failure.
    console.warn('pending-edit Telegram unavailable:', error.code || error.name || 'send_error');
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// PR-A — AUTHENTICATED HYDRATION READ (plan v8.6 §3A).
//
// Dark for PASSENGERS (no UI and no first-party caller ship with PR-A) but
// LIVE ON THE WIRE from merge: an authenticated owner can read their own
// ride, and an anonymous GET now answers 401 instead of today's 405.
//
// The ordering below is the contract, not an implementation detail. Each
// gate runs before the next, and the rate-card resolver is reached ONLY
// after ownership, editability and full stored-row validity have passed —
// a bad id, a foreign row, a non-editable row or an invalid row costs zero
// resolver calls.
// ============================================================

// One fixed body for every post-authentication failure that is not a typed
// 400/404/409. It never echoes a stored category, name or driver message.
const HYDRATION_FAILURE = { error: 'Ride details unavailable' };

// A stored string ROUND-TRIPS only if the endpoint's own normalizer would
// hand the writer back exactly these bytes. text() trims and slices, so a
// padded or over-long stored value would be silently rewritten by an edit
// that never touched that field. Such a row fails closed instead.
function roundTrips(value, max, { required }) {
  if (value === null || value === undefined) return !required;
  if (typeof value !== 'string') return false;
  if (value !== value.trim()) return false;
  if (value.length > max) return false;
  return required ? value.length > 0 : true;
}

function normalizedBlank(value) {
  return typeof value === 'string' && value.trim() === '';
}

function isIntInRange(value, lo, hi) {
  return Number.isInteger(value) && value >= lo && value <= hi;
}

// Classify the stored route from its AUTHORITY and identity tuple alone.
// Labels never decide a route family: a row is not an airport transfer
// merely because today's UI sells airport transfers.
function classifyRoute(row) {
  const labelsOk = roundTrips(row.pickup_location, 500, { required: true }) &&
    roundTrips(row.dropoff_location, 500, { required: true });
  const modeOk = row.booking_mode === 'pickup' || row.booking_mode === 'dropoff';
  if (!labelsOk || !modeOk) return null;

  if (row.route_authority === 'canonical') {
    if (!AIRPORT_CODES.includes(row.airport_code)) return null;
    if (!isValidPlaceId(row.canonical_place_id)) return null;
    return {
      kind: 'airport_transfer_v1',
      authority: 'canonical',
      bookingMode: row.booking_mode,
      airportCode: row.airport_code,
      canonicalPlaceId: row.canonical_place_id,
      pickupLabel: row.pickup_location,
      dropoffLabel: row.dropoff_location
    };
  }

  if (row.route_authority === 'legacy_text') {
    // The installed edit writer still PRODUCES this state today on any
    // non-verified verdict or in mode off (migration 018:1206-1211), so it
    // is a live reachable state, not a backfill artifact. It asserts only
    // that the route family is neither stored nor provable.
    if (row.airport_code !== null || row.canonical_place_id !== null) return null;
    return {
      kind: 'legacy_unclassified_v1',
      authority: 'legacy_text',
      bookingMode: row.booking_mode,
      airportCode: null,
      canonicalPlaceId: null,
      pickupLabel: row.pickup_location,
      dropoffLabel: row.dropoff_location
    };
  }

  return null;
}

// Every value PR-B must resubmit is validated here rather than inferred.
// Trimming may validate formatting; it may never synthesize a value.
function validateStoredRow(row) {
  if (!isIntInRange(row.details_version, 1, Number.MAX_SAFE_INTEGER)) return null;

  const pickupMs = Date.parse(row.pickup_datetime);
  if (!Number.isFinite(pickupMs)) return null;
  // PostgreSQL TIMESTAMPTZ keeps MICROseconds; a JavaScript Date does not.
  // Re-emitting a truncated instant would let an edit that never touched the
  // time silently move it (.123456Z -> .123Z), which breaks round-trip
  // closure. Precision the browser cannot carry fails closed instead.
  if (typeof row.pickup_datetime === 'string') {
    const frac = /\.(\d+)/.exec(row.pickup_datetime);
    if (frac && /[1-9]/.test(frac[1].slice(3))) return null;
  }

  if (!roundTrips(row.customer_name, 120, { required: true })) return null;
  if (!roundTrips(row.customer_phone, 40, { required: true })) return null;
  if (!roundTrips(row.customer_email, 254, { required: false })) return null;
  if (!roundTrips(row.notes, 2000, { required: false })) return null;
  if (!roundTrips(row.pickup_sign, 160, { required: false })) return null;
  if (!roundTrips(row.booker_name, 120, { required: false })) return null;
  if (!roundTrips(row.booker_phone, 40, { required: false })) return null;

  // A booker phone cannot exist without a name (the writer resolves the
  // pair coherently), and a booker name equal to the traveller name is the
  // installed writer's CLEAR-BOOKER command — a row spelled that way would
  // lose its booker to an edit that never touched it.
  const bookerName = row.booker_name || null;
  // A PRESENT-but-empty stored phone is not the same as an absent one: the
  // installed writer applies NULLIF(...,'') whenever a booker name is
  // submitted (migration 018:1093-1100), so an unrelated edit would turn ''
  // into NULL. Accept only absent or genuinely non-blank.
  if (row.booker_phone !== null && row.booker_phone !== undefined &&
      normalizedBlank(row.booker_phone)) {
    return null;
  }
  const bookerPhone = row.booker_phone || null;
  if (bookerPhone && !bookerName) return null;
  if (bookerName && bookerName === row.customer_name) return null;

  if (!isIntInRange(row.passengers, 1, WRITER_CEILINGS.passengers)) return null;
  if (!isIntInRange(row.bags, 0, WRITER_CEILINGS.bags)) return null;

  const cents = Number.isInteger(row.price_cents)
    ? row.price_cents
    : Math.round(Number(row.price) * 100);
  if (!isIntInRange(cents, 1, 100000 * 100)) return null;

  // Only the three exact canonical pairs round-trip. Legacy aliases (a
  // stored vehicle_type of 'escalade', a name like 'Black Escalade') resolve
  // to no key: an unrelated edit must never silently canonicalize them.
  const vehicleKey = storedPairToKey(row.vehicle_type, row.vehicle_name);
  if (!vehicleKey) return null;

  const route = classifyRoute(row);
  if (!route) return null;

  return { pickupMs, route, vehicleKey, cents, bookerName, bookerPhone };
}

// A validated card must ALSO be writer-compatible before any DTO leaves.
// The rate-card validator deliberately accepts a far wider shape (any
// nonblank name, capacities to 1000), so card validity alone cannot
// underwrite what a booking will persist.
function projectVehicles(card, selectedKey) {
  if (!card || typeof card !== 'object' || !card.vehicles) return null;
  const cardVehicles = card.vehicles;
  if (!Object.prototype.hasOwnProperty.call(cardVehicles, selectedKey)) return null;

  // A validated card may expose any NONEMPTY SUBSET of the canonical keys
  // (ride-rate-card.js:203-205 fails only on an empty map), so a card that
  // deliberately omits an unavailable vehicle is legitimate and must project
  // its remaining alternatives. What may NEVER pass is an unknown exposed key
  // or a missing BOOKED key — that is the plan's malformed-card 500
  // (plan v8.6:418-428). Requiring all three keys here would refuse an honest
  // partial card, and the operator-configurable fleet direction makes partial
  // cards expected rather than exotic.
  const exposed = Object.keys(cardVehicles);
  if (exposed.length === 0) return null;
  for (const key of exposed) {
    if (!ownVehicle(key)) return null;
  }

  // Canonical ORDER is the contract's, never the card's key order.
  const out = [];
  for (const key of CONTRACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(cardVehicles, key)) continue;
    const v = cardVehicles[key];
    const expected = ownVehicle(key);
    if (!v || !expected) return null;

    // The card's name must be an OWN property of the endpoint's VEHICLE_TYPE
    // map and must map to this key's own category — an inherited-property
    // name ('constructor', 'toString') must never satisfy this.
    if (v.name !== expected.name) return null;
    if (!Object.prototype.hasOwnProperty.call(VEHICLE_TYPE, v.name)) return null;
    if (VEHICLE_TYPE[v.name] !== expected.category) return null;

    const pax = v.capacity && v.capacity.passengers;
    const bags = v.capacity && v.capacity.bags;
    // Exact per-vehicle equality catches WITHIN-ceiling drift (Tesla 4 -> 5),
    // and the independent ceilings catch a card no write could carry.
    if (pax !== expected.passengers || bags !== expected.bags) return null;
    if (!isIntInRange(pax, 1, WRITER_CEILINGS.passengers)) return null;
    if (!isIntInRange(bags, 0, WRITER_CEILINGS.bags)) return null;

    out.push({ key, name: expected.name, passengerCapacity: pax, bagCapacity: bags });
  }
  return out;
}

const HYDRATION_FIELDS = [
  'id', 'trip_id', 'status', 'assigned_driver', 'details_version',
  'pickup_location', 'dropoff_location', 'pickup_datetime', 'booking_mode',
  'route_authority', 'airport_code', 'canonical_place_id',
  'vehicle_type', 'vehicle_name', 'passengers', 'bags', 'price', 'price_cents',
  'customer_name', 'customer_phone', 'customer_email',
  'booker_name', 'booker_phone', 'notes', 'pickup_sign'
].join(', ');

async function hydrationRead(event, db, auth, headers) {
  const fail = (statusCode, payload) => ({
    statusCode, headers, body: JSON.stringify(payload)
  });

  const bookingId = (event.queryStringParameters && event.queryStringParameters.id) || '';
  if (!UUID_RE.test(bookingId)) {
    return fail(400, { error: 'Invalid booking id' });
  }

  const { data: row, error: readError } = await db
    .from('bookings')
    .select(HYDRATION_FIELDS)
    .eq('id', bookingId)
    .eq('customer_id', auth.customerId)
    .maybeSingle();

  if (readError) {
    console.error('hydration read failed:', readError.code || 'db_error');
    return fail(500, HYDRATION_FAILURE);
  }
  // Missing and foreign are ONE answer — non-disclosure.
  if (!row) return fail(404, { error: 'Booking not found' });

  if (row.status !== 'pending' || row.assigned_driver) {
    return fail(409, { error: 'not_editable', currentStatus: row.status });
  }

  const validated = validateStoredRow(row);
  if (!validated) return fail(500, HYDRATION_FAILURE);

  let resolved;
  try {
    resolved = await resolveRateCard({
      authUserId: auth.authUserId,
      customerId: auth.customerId,
      pickupAtMs: validated.pickupMs
    });
  } catch (error) {
    console.error('hydration rate-card resolve threw:', error.code || error.name || 'resolver_error');
    return fail(500, HYDRATION_FAILURE);
  }
  if (!resolved || resolved.ok !== true || !resolved.card) return fail(500, HYDRATION_FAILURE);

  const vehicles = projectVehicles(resolved.card, validated.vehicleKey);
  if (!vehicles) return fail(500, HYDRATION_FAILURE);

  const selected = ownVehicle(validated.vehicleKey);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      bookingId: row.id,
      tripCode: row.trip_id,
      detailsVersion: row.details_version,
      status: 'pending',
      route: validated.route,
      pickupAt: new Date(validated.pickupMs).toISOString(),
      passengers: row.passengers,
      // Legacy stored capacity value. Validated so it round-trips; never
      // rendered, never passenger demand, never part of quote intent.
      bags: row.bags,
      bookedPriceCents: validated.cents,
      vehicle: { key: validated.vehicleKey, name: selected.name },
      vehicles,
      traveler: {
        name: row.customer_name,
        phone: row.customer_phone,
        email: row.customer_email || null
      },
      booker: validated.bookerName
        ? { name: validated.bookerName, phone: validated.bookerPhone }
        : null,
      optional: {
        notes: row.notes || null,
        pickupSign: row.pickup_sign || null
      }
    })
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // PR-A adds GET (authenticated hydration read). Every OTHER non-POST
  // method still answers 405 exactly as before.
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const db = createClient(supabaseUrl, serviceKey);
  const auth = await requirePassenger(event, supabaseUrl, anonKey, db);
  if (!auth.customerId) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }

  if (event.httpMethod === 'GET') {
    return hydrationRead(event, db, auth, headers);
  }

  // The RAW body string is the envelope identity (request_digest hashes
  // exactly these bytes). Never log it.
  const rawBody = event.body || '';
  let body;
  try { body = JSON.parse(rawBody); } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const edit = parseEdit(body);
  if (edit.error) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: edit.error }) };
  }
  const requestDigest = edit.operationId ? sha256Hex(rawBody) : null;
  const presentedToken = readPresentedToken(body);
  if (presentedToken.invalid) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'quote_invalid', requote: true }) };
  }
  const quoteToken = presentedToken.token;

  try {
    // ============================================
    // TOKEN CLASSIFICATION (edit purpose). PR-1 ships this dark — no
    // browser sends edit tokens until PR-2 — but the contract is complete
    // and behaviorally tested. Signing config resolves LAZILY.
    // ============================================
    let verdict = 'no_token';
    let verifiedPayload = null;
    let verifiedJti = null;
    let presentedDigest = null;
    let canonicalPlaceId = null;
    let airportCode = null;
    let vehicleKey = null;
    let routeMinutes = null;

    if (quoteToken) {
      vehicleKey = body.vehicleKey;
      airportCode = body.airportCode;
      canonicalPlaceId = body.placeId;
      const routeMilesTenths = body.routeMilesTenths;
      routeMinutes = body.routeMinutes;
      const contractValid =
        VEHICLE_KEYS.includes(vehicleKey) &&
        AIRPORT_CODES.includes(airportCode) &&
        isValidPlaceId(canonicalPlaceId) &&
        Number.isInteger(routeMilesTenths) && routeMilesTenths >= 0 &&
        Number.isInteger(routeMinutes) && routeMinutes >= 1 && routeMinutes <= 1440 &&
        Number.isSafeInteger(edit.pickupMs);
      if (!contractValid) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'quote_invalid', requote: true }) };
      }

      const classification = classifyToken(quoteToken, {
        env: process.env,
        nowMs: Date.now(),
        expected: {
          purpose: 'edit',
          authUserId: auth.authUserId,
          customerId: auth.customerId,
          vehicle: vehicleKey,
          intent: {
            mode: edit.values.booking_mode,
            airportCode,
            placeId: canonicalPlaceId,
            pickupAtMs: edit.pickupMs,
            passengers: edit.values.passengers,
            routeMilesTenths,
            routeMinutes
          }
        }
      });

      if (classification.kind === 'oversize') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'quote_invalid', requote: true }) };
      }
      if (classification.kind === 'keys_unavailable') {
        // READ-ONLY recovery only (plan v3.1 §3.2(c)); unmatched requests
        // are a sanitized 500 with no RPC call and no write, every mode.
        const recovered = await recoveryLookup(db, {
          operationId: edit.operationId,
          requestDigest,
          tokenDigest: classification.digest,
          authUserId: auth.authUserId,
          customerId: auth.customerId,
          kind: 'edit',
          bookingId: edit.bookingId
        });
        if (recovered && recovered.bookingId) {
          const { data: row, error: rereadError } = await db
            .from('bookings')
            .select(RESPONSE_FIELDS)
            .eq('id', recovered.bookingId)
            .maybeSingle();
          if (rereadError || !row) {
            console.error('pending-edit recovery re-read failed');
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not process this request' }) };
          }
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              bookingId: row.id,
              tripId: row.trip_id,
              detailsVersion: row.details_version,
              booking: row,
              idempotent: true
            })
          };
        }
        console.error('pending-edit signing configuration unavailable — unmatched request refused');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not process this request' }) };
      }
      if (classification.kind === 'verified') {
        verdict = 'verified';
        verifiedPayload = classification.payload;
        verifiedJti = classification.payload.jti;
        presentedDigest = classification.digest;
      } else {
        verdict = 'verify_failed';
        presentedDigest = classification.digest;
      }
    }

    // ============================================
    // FAST PRE-CHECKS — bare legacy requests only (today's 403/404/409
    // shapes). A request carrying an operationId or token goes straight
    // to the RPC so a lost response + exact retry lands on its receipt
    // instead of being intercepted by a state that already moved.
    // ============================================
    if (!edit.operationId && !quoteToken) {
      const { data: current, error: readError } = await db
        .from('bookings')
        .select('id, status, assigned_driver, customer_id')
        .eq('id', edit.bookingId)
        .maybeSingle();
      if (readError) {
        console.error('pending-edit booking lookup failed:', readError.code || 'db_error');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not load booking' }) };
      }
      if (!current) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      if (current.customer_id !== auth.customerId) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not your booking' }) };
      }
      if (current.status !== 'pending' || current.assigned_driver) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ error: 'Ride is no longer editable', currentStatus: current.status })
        };
      }
    }

    // ============================================
    // THE ATOMIC WRITER — accept_quote_edit (migration 017). One lane for
    // every full-form edit. The RPC enforces ownership, pending+unassigned,
    // the details_version CAS, epoch binding for edit tokens, optional
    // preservation, booker coherence, and derives host_commission from the
    // stored ratio and the authoritative fare.
    // ============================================
    const pEdit = { ...edit.values };
    // R1: no duration key in any verdict — the writer sets the column NULL
    // unconditionally (migration 018), so forwarding routeMinutes or legacy
    // duration would only create a value for the RPC to discard. The key
    // stays in the RPC's p_edit allowlist so stale cached clients that still
    // send it are tolerated, not refused.
    delete pEdit.duration_minutes;
    for (const [col, submitted] of Object.entries(edit.optional)) {
      if (submitted !== null) pEdit[col] = submitted;
    }
    if (edit.booker.name !== null) {
      pEdit.booker_name = edit.booker.name;
      if (edit.booker.phone !== null) pEdit.booker_phone = edit.booker.phone;
    }

    const { data: result, error: rpcError } = await db.rpc('accept_quote_edit', {
      p_auth_user_id: auth.authUserId,
      p_customer_id: auth.customerId,
      p_operation_request_id: edit.operationId,
      p_request_digest: requestDigest,
      p_booking_id: edit.bookingId,
      p_expected_details_version: edit.expectedVersion,
      p_verdict: verdict,
      p_jti: verdict === 'verified' ? verifiedJti : null,
      p_token_digest: verdict === 'no_token' ? null : presentedDigest,
      p_payload: verdict === 'verified' ? verifiedPayload : null,
      p_client_price: edit.price,
      p_canonical_place_id: verdict === 'verified' ? canonicalPlaceId : null,
      p_airport_code: verdict === 'verified' ? airportCode : null,
      p_vehicle_key: verdict === 'verified' ? vehicleKey : null,
      p_edit: pEdit
    });

    if (rpcError) {
      console.error('❌ accept_quote_edit failed:', rpcError.code || 'rpc_error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Changes were not saved' }) };
    }

    const outcome = result && typeof result === 'object' ? result.outcome : null;

    if (outcome === 'updated' || outcome === 'idempotent') {
      const { data: row, error: rereadError } = await db
        .from('bookings')
        .select(RESPONSE_FIELDS)
        .eq('id', edit.bookingId)
        .maybeSingle();
      if (rereadError || !row) {
        console.error('pending-edit post-commit re-read failed');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not confirm the changes' }) };
      }
      if (outcome === 'updated') {
        await sendUpdatedDoorbell(row);
      }
      const responseBody = {
        success: true,
        bookingId: row.id,
        tripId: row.trip_id,
        detailsVersion: row.details_version,
        booking: row
      };
      if (outcome === 'idempotent') responseBody.idempotent = true;
      return { statusCode: 200, headers, body: JSON.stringify(responseBody) };
    }

    if (outcome === 'version_conflict' || outcome === 'not_editable') {
      // Honest live truth, as before: a present booking answers with its
      // real status + version; a missing one is 404; a failed re-read is
      // a real 500 — never a guessed conflict.
      const { data: latest, error: rereadError } = await db
        .from('bookings')
        .select('status, details_version')
        .eq('id', edit.bookingId)
        .maybeSingle();
      if (rereadError) {
        console.error('pending-edit conflict re-read failed:', rereadError.code || 'db_error');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
      }
      if (!latest) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      }
      if (outcome === 'not_editable') {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({ error: 'Ride is no longer editable', currentStatus: latest.status })
        };
      }
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'Booking changed while you were editing',
          currentStatus: latest.status,
          currentDetailsVersion: latest.details_version
        })
      };
    }

    if (outcome === 'not_found') {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
    }

    if (outcome === 'quote_consumed') {
      // Identity-gated by the RPC: this caller's quote already bought an
      // edit of THIS booking (a sibling vehicle token replay). The edit
      // registry answers with requote guidance plus the live version so
      // the browser reloads state and quotes fresh — the create-side
      // reopen shape does not fit an edit.
      const { data: latest } = await db
        .from('bookings')
        .select('details_version')
        .eq('id', edit.bookingId)
        .maybeSingle();
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: 'quote_stale',
          requote: true,
          currentDetailsVersion: latest ? latest.details_version : null
        })
      };
    }

    const shared = sharedOutcomeResponse(outcome);
    const mapped = shared || unknownOutcomeResponse(outcome);
    return { statusCode: mapped.statusCode, headers, body: JSON.stringify(mapped.body) };
  } catch (error) {
    console.error('pending-edit unexpected failure:', error.code || error.name || 'unexpected');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Changes were not saved' }) };
  }
};
