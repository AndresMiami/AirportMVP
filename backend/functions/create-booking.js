// Secure booking creation — PR 3C-2C-B PR-1 (plan v3.1): the WRITER SWAP.
// The booking row is no longer inserted directly; every create flows through
// migration 017's accept_quote_create RPC, which verifies, consumes, and
// stores what ride-quote.js calculated (the RPC is not a second calculator).
// The Telegram doorbell only fires after a genuinely NEW `created` outcome.
//
// Flag-dark and COMPATIBLE for valid current submissions — not byte-identical.
// Deliberate tightenings over the legacy handler (each recorded in the PR):
//   * booking_mode normalized to 'pickup'|'dropoff' (update-pending parity);
//   * unparseable dateTime -> 400 (was an unhandled 500);
//   * unknown vehicle display name -> sanitized 400 (the silent 'sedan'
//     substitution is removed);
//   * text fields bounded (update-pending's text() rule);
//   * price must be a finite 0.01..100000 number (edit-endpoint parity);
//   * a database unique-violation can no longer leak raw constraint text —
//     the RPC arbitrates the one-active rule and answers `active_exists`;
//   * the fabricated `B<epoch>` display id is gone: the response carries the
//     STORED trip_id (or null), so idempotent replays reproduce it.
//
// ACCOUNT GATE (unchanged): new bookings are AUTHENTICATED-ONLY. 401 for a
// missing/invalid/expired token, 403 when the identity cannot be resolved to
// a customers row, 500 on auth/database failure. No anonymous insert path.
// Legacy guest bookings and their /trip links are untouched; "book for
// someone else" remains a signed-in booker arranging a ride for another
// passenger.

const { createClient } = require('@supabase/supabase-js');
const {
  sha256Hex, isUuid, readPresentedToken, signingKeysAvailable,
  classifyToken, recoveryLookup,
  sharedOutcomeResponse, unknownOutcomeResponse
} = require('./lib/booking-writer');
const { isValidPlaceId } = require('./lib/place-identity');

// Legacy 'assigned' is a nonterminal status and occupies an active slot
// (migration 017); the fast pre-check must agree with the database index.
const ACTIVE_BOOKING_STATUSES = ['pending', 'assigned', 'confirmed', 'on_the_way', 'arrived', 'in_progress'];

const VEHICLE_TYPE = {
  Sedan: 'sedan', sedan: 'sedan', 'Tesla Model Y': 'sedan',
  SUV: 'suv', suv: 'suv', Escalade: 'suv', escalade: 'suv',
  'Black Escalade': 'suv', 'Cadillac Escalade': 'suv',
  Sprinter: 'sprinter', sprinter: 'sprinter', 'Mercedes Sprinter': 'sprinter'
};

const VEHICLE_KEYS = ['tesla', 'escalade', 'sprinter'];
const AIRPORT_CODES = ['MIA', 'FLL', 'PBI'];

// Fields the passenger-facing response and the doorbell render from — an
// explicit allowlist read AFTER the RPC commits (the RPC returns outcome
// JSON, never a row).
const RESPONSE_FIELDS = 'id, trip_id, status, pickup_location, dropoff_location, pickup_datetime, vehicle_type, vehicle_name, passengers, bags, price, duration_minutes, details_version';

function text(value, max, required = false) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if (required && !cleaned) return null;
  return cleaned ? cleaned.slice(0, max) : null;
}

async function sendDoorbell(row, { ambassadorName }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.warn('⚠️ Telegram not configured - skipping doorbell');
    return false;
  }

  // All display times in Miami local time — the function itself runs in UTC.
  const MIAMI_TZ = 'America/New_York';
  const tripDate = new Date(row.pickup_datetime);
  const formattedDate = tripDate.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: MIAMI_TZ
  });
  const fmtTime = (d) => d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: MIAMI_TZ
  });
  const isToday = new Date().toLocaleDateString('en-US', { timeZone: MIAMI_TZ })
    === tripDate.toLocaleDateString('en-US', { timeZone: MIAMI_TZ });
  const isUrgent = (tripDate - new Date()) < (2 * 60 * 60 * 1000);

  const CAPACITY = { sedan: [4, 4], suv: [7, 8], escalade: [7, 8], sprinter: [12, 15] };
  const [capPax, capBags] = CAPACITY[row.vehicle_type] || CAPACITY.sedan;
  const etaLine = row.duration_minutes
    ? `⏱ ~${row.duration_minutes} min · est. arrival ${fmtTime(new Date(tripDate.getTime() + row.duration_minutes * 60000))}\n`
    : '';
  const ambassadorLine = ambassadorName ? `\n★ via Ambassador ${ambassadorName}` : '';
  const siteUrl = process.env.URL || 'https://i-love-miami.netlify.app';
  const doorbell = `🆕 New ride ${row.trip_id || row.id.slice(0, 8)} — ${isToday ? 'TODAY' : formattedDate} at ${fmtTime(tripDate)}${isUrgent ? ' (URGENT <2h)' : ''}
${row.pickup_location} → ${row.dropoff_location}
${etaLine}🚘 ${row.vehicle_name || row.vehicle_type} · 👥 ${row.passengers || 1} of ${capPax} · 🧳 ${row.bags || 0} of ${capBags}
💵 $${row.price} · pay driver (cash/Zelle)${ambassadorLine}
Open driver page: ${siteUrl}/driver`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: doorbell }),
      signal: controller.signal
    });
    if (res.ok) {
      console.log(`📱 Doorbell sent for booking ${row.trip_id || row.id}`);
      return true;
    }
    console.error('⚠️ Doorbell failed:', res.status);
    return false;
  } catch (telegramError) {
    console.error('⚠️ Doorbell error:', telegramError.name || 'send_error');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

exports.handler = async (event, context) => {
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
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // ============================================
  // INITIALIZE SUPABASE CLIENT
  // ============================================
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Missing Supabase configuration');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error - missing database credentials' })
    };
  }

  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    console.error('❌ Missing SUPABASE_ANON_KEY — cannot verify sessions');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error' })
    };
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // ============================================
  // ACCOUNT GATE: require a valid session (CreditEngine requireAuth
  // pattern — checks BOTH the auth error and the missing user; the old
  // optional-identity block checked neither and silently fell through
  // to an anonymous insert).
  //   missing token           -> 401
  //   invalid/expired token   -> 401
  //   verification unreachable -> 500 (never guess)
  // ============================================
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };
  }
  let user;
  try {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError) {
      // Supabase reports outages as error RESULTS, not throws. A
      // network/service failure must be 500 — never mislabeled as an
      // expired session (which would bounce a valid user to sign-in).
      const retryable = userError.name === 'AuthRetryableFetchError' ||
        !userError.status || userError.status >= 500;
      if (retryable) {
        console.error('❌ Auth verification unavailable:', userError.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify sign-in' }) };
      }
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }
    if (!userData?.user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }
    user = userData.user;
  } catch (authError) {
    console.error('❌ Auth verification failed:', authError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify sign-in' }) };
  }

  try {
    // The RAW body string is the envelope identity: request_digest hashes
    // exactly these bytes, so an exact-envelope retry matches its receipt
    // by construction. Never log this string — it carries passenger data
    // and, when quote-backed, a bearer token.
    const rawBody = event.body || '';
    const booking = JSON.parse(rawBody);

    // Validate required fields (truthiness, as before — price stays
    // required: every current browser sends it, and off/observe modes
    // store it as the honest client-priced fare).
    const requiredFields = [
      'customerName', 'phone', 'pickup', 'dropoff',
      'dateTime', 'vehicle', 'price', 'mode'
    ];
    const missingFields = requiredFields.filter(field => !booking[field]);
    if (missingFields.length > 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields',
          missing: missingFields
        })
      };
    }

    // ---- tightened field validation (update-pending-booking parity) ----
    const customerName = text(booking.customerName, 120, true);
    const customerPhone = text(booking.phone, 40, true);
    const pickupLocation = text(booking.pickup, 500, true);
    const dropoffLocation = text(booking.dropoff, 500, true);
    const vehicleName = text(booking.vehicle, 120, true);
    const price = Number(booking.price);
    const pickupMs = Date.parse(booking.dateTime);
    const passengers = Number.parseInt(booking.passengers, 10) || 1;
    const bags = Number.parseInt(booking.bags, 10) || 0;

    if (!customerName || !customerPhone || !pickupLocation || !dropoffLocation || !vehicleName ||
        !Number.isFinite(price) || price <= 0 || price > 100000 ||
        !Number.isFinite(pickupMs) ||
        !Number.isInteger(passengers) || passengers < 1 || passengers > 12 ||
        !Number.isInteger(bags) || bags < 0 || bags > 15) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid ride details' }) };
    }

    const vehicleType = VEHICLE_TYPE[vehicleName];
    if (!vehicleType) {
      // Sanitized 400 — the silent sedan substitution is deliberately gone.
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid vehicle' }) };
    }

    const bookingMode = booking.mode === 'pickup' ? 'pickup' : 'dropoff';

    // Legacy duration stays lenient (stored only on the no-token path);
    // the verified path uses commitment-verified routeMinutes instead.
    const legacyDuration = Number.parseInt(booking.durationMinutes, 10);
    const durationMinutes = Number.isInteger(legacyDuration) &&
      legacyDuration >= 1 && legacyDuration <= 1440 ? legacyDuration : null;

    // Envelope identity: operationId travels INSIDE the serialized body;
    // request_digest binds these exact bytes to the operation receipt.
    const operationId = booking.operationId ?? null;
    if (operationId !== null && !isUuid(operationId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid ride details' }) };
    }
    const requestDigest = operationId ? sha256Hex(rawBody) : null;

    // An omitted token is legitimate legacy traffic while pricing mode is
    // off/observe. A PRESENT malformed token is a broken modern contract and
    // must never be silently relabelled as legacy traffic.
    const presentedToken = readPresentedToken(booking);
    if (presentedToken.invalid) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'quote_invalid', requote: true }) };
    }
    const quoteToken = presentedToken.token;

    // ============================================
    // RESOLVE THE CUSTOMER IDENTITY — every new booking is stamped.
    // The trip payload carries the TRAVELING PASSENGER's details (the
    // ambassador flow deliberately clears the account holder's info), so
    // payload data must NEVER become the authenticated account's
    // identity — Andres booking for Maria must not mint a customers row
    // named Maria with Maria's phone and email.
    //   customers row exists                 -> use it
    //   missing + ACTIVE ambassador host row -> ensure-row from the HOST
    //     record (hosts.name/phone/email, user.email as email fallback)
    //     — approved as an ambassador-recovery mechanism only
    //   missing + no host                    -> 403 (heal by signing in
    //     again: the login flow saves the profile)
    //   lookup/creation failure              -> 500, fail closed
    // ============================================
    let customerId = null;
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (customerError) {
      console.error('❌ Customer lookup failed:', customerError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
    }

    // Active ambassador host on this account: needed for attribution AND
    // as the only approved ensure-row source.
    const { data: ambassadorHost, error: hostError } = await supabase
      .from('hosts')
      .select('id, name, phone, email, commission_rate')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle();

    if (customer) {
      customerId = customer.id;
      if (hostError) {
        // Attribution is optional when identity is already resolved.
        console.warn('⚠️ Ambassador lookup skipped:', hostError.message);
      }
    } else {
      if (hostError) {
        // Without the host we cannot decide between recovery and 403.
        console.error('❌ Host lookup failed during identity recovery:', hostError.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
      }
      if (!ambassadorHost) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Account profile incomplete — please sign in again to finish setting up your account' })
        };
      }
      // A valid quote can only be minted after quote-ride has ensured this
      // customer row. If the row is missing and signing configuration is
      // unavailable, refuse before creating identity state: an outage may
      // recover completed work, but it may never authorize a new write.
      if (quoteToken && !signingKeysAvailable(process.env)) {
        console.error('❌ Quote signing configuration unavailable before ambassador recovery');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not process this request' }) };
      }
      // Ambassador recovery: the account's row comes from the HOST
      // record — never from the traveling passenger's details.
      // Concurrency-safe (quote-ride pattern): a simultaneous ensure-row
      // race loses the unique insert and re-reads the winner.
      const { data: created, error: createError } = await supabase
        .from('customers')
        .insert([{
          user_id: user.id,
          name: ambassadorHost.name,
          phone: ambassadorHost.phone || null,
          email: ambassadorHost.email || user.email || null,
          type: 'guest',
          source: 'website'
        }])
        .select('id')
        .single();
      if (createError) {
        if (createError.code === '23505') {
          const { data: raced, error: racedError } = await supabase
            .from('customers')
            .select('id')
            .eq('user_id', user.id)
            .maybeSingle();
          if (racedError || !raced) {
            console.error('❌ Customer profile race re-read failed:', racedError?.message || 'missing row');
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create account profile' }) };
          }
          customerId = raced.id;
        } else {
          console.error('❌ Customer profile creation failed:', createError.message);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create account profile' }) };
        }
      } else if (created) {
        customerId = created.id;
      } else {
        console.error('❌ Customer profile creation returned no row');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create account profile' }) };
      }
    }

    // ============================================
    // TOKEN CLASSIFICATION — three distinct cases (plan v3.1 §3.2).
    // Signing configuration is resolved LAZILY: the no-token path never
    // touches it (PR-1 runs with every quote secret absent).
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
      // The contract fields the browser echoes alongside the token. A
      // malformed modern contract is a re-quote, never a legacy fallback.
      vehicleKey = booking.vehicleKey;
      airportCode = booking.airportCode;
      canonicalPlaceId = booking.placeId;
      const routeMilesTenths = booking.routeMilesTenths;
      routeMinutes = booking.routeMinutes;
      const contractValid =
        VEHICLE_KEYS.includes(vehicleKey) &&
        AIRPORT_CODES.includes(airportCode) &&
        isValidPlaceId(canonicalPlaceId) &&
        Number.isInteger(routeMilesTenths) && routeMilesTenths >= 0 &&
        Number.isInteger(routeMinutes) && routeMinutes >= 1 && routeMinutes <= 1440 &&
        Number.isSafeInteger(pickupMs);
      if (!contractValid) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'quote_invalid', requote: true }) };
      }

      const classification = classifyToken(quoteToken, {
        env: process.env,
        nowMs: Date.now(),
        expected: {
          purpose: 'create',
          authUserId: user.id,
          customerId,
          vehicle: vehicleKey,
          intent: {
            mode: bookingMode,
            airportCode,
            placeId: canonicalPlaceId,
            pickupAtMs: pickupMs,
            passengers,
            routeMilesTenths,
            routeMinutes
          }
        }
      });

      if (classification.kind === 'oversize') {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'quote_invalid', requote: true }) };
      }
      if (classification.kind === 'keys_unavailable') {
        // READ-ONLY recovery only: an exact completed operation is
        // returned idempotently; anything unmatched is a sanitized 500
        // with NO RPC call and NO write, in every mode. A signing outage
        // never becomes financial authorization.
        const recovered = await recoveryLookup(supabase, {
          operationId,
          requestDigest,
          tokenDigest: classification.digest,
          authUserId: user.id,
          customerId,
          kind: 'create'
        });
        if (recovered && recovered.bookingId) {
          const { data: row, error: rereadError } = await supabase
            .from('bookings')
            .select(RESPONSE_FIELDS)
            .eq('id', recovered.bookingId)
            .maybeSingle();
          if (rereadError || !row) {
            console.error('❌ Recovery re-read failed');
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not process this request' }) };
          }
          return {
            statusCode: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: true,
              bookingId: row.id,
              tripId: row.trip_id || null,
              message: 'Booking saved successfully',
              telegramSent: false,
              urgent: (new Date(row.pickup_datetime) - new Date()) < (2 * 60 * 60 * 1000),
              idempotent: true
            })
          };
        }
        console.error('❌ Quote signing configuration unavailable — unmatched request refused');
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
    // FAST PRE-CHECK — bare legacy requests only. A request carrying an
    // operationId or a token goes straight to the RPC, which arbitrates
    // receipt -> exact-token retry -> active slot atomically: a lost
    // response + exact retry must return idempotent success, never be
    // intercepted here as "you already have a ride".
    // Ambassadors manage independent rides for multiple guests and are
    // exempt from the one-active rule (the RPC agrees).
    // ============================================
    if (!operationId && !quoteToken && !ambassadorHost) {
      const { data: existingActive, error: activeError } = await supabase
        .from('bookings')
        .select('id, trip_id, status, pickup_datetime')
        .eq('customer_id', customerId)
        .in('status', ACTIVE_BOOKING_STATUSES)
        .order('pickup_datetime', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (activeError) {
        console.error('❌ Active booking lookup failed:', activeError.code || 'db error');
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Could not verify existing bookings' })
        };
      }
      if (existingActive) {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: 'Active booking already exists',
            existingBookingId: existingActive.id,
            tripId: existingActive.trip_id,
            status: existingActive.status
          })
        };
      }
    }

    // ============================================
    // REFERRAL ATTRIBUTION — resolved BEFORE the RPC, which requires an
    // ACTIVE host with a valid rate and refuses anything else. A stale or
    // deactivated host degrades to an unattributed booking, never a 500.
    // The RPC derives host_commission itself from the authoritative fare.
    // ============================================
    let referredByHost = null;
    let ambassadorName = null;
    try {
      let host = ambassadorHost;
      if (!host && booking.refCode) {
        const { data: refHost } = await supabase
          .from('hosts')
          .select('id, name, commission_rate')
          .eq('referral_code', String(booking.refCode).trim().toLowerCase())
          .eq('status', 'active')
          .maybeSingle();
        host = refHost || null;
      }
      if (host) {
        const rate = Number.parseFloat(host.commission_rate);
        if (Number.isFinite(rate) && rate >= 0 && rate <= 1) {
          referredByHost = host.id;
          ambassadorName = host.name || null;
        } else {
          console.warn('⚠️ Referral attribution skipped: invalid commission rate');
        }
      }
    } catch (refError) {
      console.warn('⚠️ Referral attribution skipped:', refError.message);
    }

    // Booker info is stored only when someone books on behalf of another
    // passenger — customer_* is always the person the driver picks up.
    const isBookerDifferent = booking.bookerName &&
      booking.bookerName !== booking.customerName;

    // ============================================
    // THE ATOMIC WRITER — accept_quote_create (migration 017). The RPC
    // forces status 'pending', derives host_commission, prices from the
    // signed token in enforce, and records the ledgers; generated
    // driver_payout / linkmia_commission follow the stored fare.
    // ============================================
    const pBooking = {
      trip_id: text(booking.tripId, 40) || null,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: text(booking.email, 254),
      booker_name: isBookerDifferent ? text(booking.bookerName, 120) : null,
      booker_phone: isBookerDifferent ? text(booking.bookerPhone, 40) : null,
      pickup_location: pickupLocation,
      dropoff_location: dropoffLocation,
      pickup_datetime: new Date(pickupMs).toISOString(),
      passengers,
      bags,
      vehicle_type: vehicleType,
      vehicle_name: vehicleName,
      booking_mode: bookingMode,
      payment_status: 'unpaid',
      payment_method: text(booking.paymentMethod, 30) || 'cash',
      flight_number: text(booking.flightNumber, 80),
      notes: text(booking.notes, 2000),
      pickup_sign: text(booking.pickupSign, 160),
      promo_code: text(booking.promoCode, 80),
      referred_by_host: referredByHost,
      // Any surviving quote contract carries a validated 1..1440
      // routeMinutes — as client-trusted as the legacy durationMinutes, so
      // verify_failed keeps the ETA too. Bare legacy keeps its own field.
      duration_minutes: quoteToken ? routeMinutes : durationMinutes,
      source: 'website'
    };

    const { data: result, error: rpcError } = await supabase.rpc('accept_quote_create', {
      p_auth_user_id: user.id,
      p_customer_id: customerId,
      p_operation_request_id: operationId,
      p_request_digest: requestDigest,
      p_verdict: verdict,
      p_jti: verdict === 'verified' ? verifiedJti : null,
      p_token_digest: verdict === 'no_token' ? null : presentedDigest,
      p_payload: verdict === 'verified' ? verifiedPayload : null,
      p_client_price: price,
      p_canonical_place_id: verdict === 'verified' ? canonicalPlaceId : null,
      p_airport_code: verdict === 'verified' ? airportCode : null,
      p_vehicle_key: verdict === 'verified' ? vehicleKey : null,
      p_booking: pBooking
    });

    if (rpcError) {
      // Sanitized always — RPC exceptions (including any unexpected
      // unique violation) never leak constraint or SQL text to a client.
      console.error('❌ accept_quote_create failed:', rpcError.code || 'rpc_error');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create booking' }) };
    }

    const outcome = result && typeof result === 'object' ? result.outcome : null;

    if (outcome === 'created' || outcome === 'idempotent') {
      const { data: row, error: rereadError } = await supabase
        .from('bookings')
        .select(RESPONSE_FIELDS)
        .eq('id', result.booking_id)
        .maybeSingle();
      if (rereadError || !row) {
        // The write is committed; the browser treats this 500 as an
        // UNKNOWN result and retries the exact envelope, which lands on
        // the idempotent receipt. (The doorbell for this rare path is
        // lost by design — an idempotent replay never re-sends it.)
        console.error('❌ Post-commit re-read failed');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not confirm the booking' }) };
      }

      let telegramSent = false;
      if (outcome === 'created') {
        telegramSent = await sendDoorbell(row, { ambassadorName });
      }

      const isUrgent = (new Date(row.pickup_datetime) - new Date()) < (2 * 60 * 60 * 1000);
      const responseBody = {
        success: true,
        bookingId: row.id,
        tripId: row.trip_id || null,
        message: 'Booking saved successfully',
        telegramSent,
        urgent: isUrgent
      };
      if (outcome === 'idempotent') responseBody.idempotent = true;
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(responseBody)
      };
    }

    if (outcome === 'active_exists' || outcome === 'quote_consumed') {
      // Identity-gated by the RPC: this caller owns the disclosed booking.
      if (result.booking_id) {
        const { data: existing } = await supabase
          .from('bookings')
          .select('id, trip_id, status')
          .eq('id', result.booking_id)
          .maybeSingle();
        if (existing) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({
              error: 'Active booking already exists',
              existingBookingId: existing.id,
              tripId: existing.trip_id,
              status: existing.status
            })
          };
        }
      }
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Could not process this request' }) };
    }

    const shared = sharedOutcomeResponse(outcome);
    const mapped = shared || unknownOutcomeResponse(outcome);
    return { statusCode: mapped.statusCode, headers, body: JSON.stringify(mapped.body) };

  } catch (error) {
    console.error('❌ Booking error:', error.name || 'error');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to create booking'
      })
    };
  }
};
