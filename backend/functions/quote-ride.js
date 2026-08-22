// Server quote endpoint (PR 3C-2B1) — DARK by design.
//   POST /api/quote-ride { mode, airportCode, placeId, pickupAt,
//                          passengers }
//     -> all-vehicles server quote, each with a signed token.
//
// Nothing in production calls this endpoint: it exists so the
// authoritative quote pipeline (trusted intent -> server route facts
// -> 3C-2A engine -> signed quote) can run and be measured before the
// browser integrates (2B2) and the write endpoints enforce (2C).
// Zero passenger-visible behavior. Zero PRICING storage — no route
// facts, no quotes, nothing about the trip persists (the Google
// storage-policy review gates 2C, not this). The ONE write is the
// ambassador ensure-row, which mirrors create-booking's approved
// identity recovery so a quote and a booking can never disagree about
// who is allowed to proceed.
//
// TRUSTED-INTENT BOUNDARY: the client sends intent ONLY. The field
// set is a strict allowlist; any route-fact-shaped or unknown field is
// a 400. The server derives route facts itself and resolves the
// place_id to ONE identity used for routing and the future stored
// address alike.
//
// ALL VEHICLES, NO PREFERENCE: this endpoint prices every vehicle on
// the card and signs one token per vehicle, each bound to ITS OWN
// vehicle through both the payload field and the intentHash. There is
// deliberately no `vehicle` request field — in an all-vehicles contract
// a "preference" could only perturb the hash, which is exactly the
// incoherence that would let a token's payload vehicle and its
// intentHash disagree. The passenger's choice is expressed by which
// token they present at 2C.
//
// CANONICAL PLACE ID: the response echoes the id Google RESOLVED, not
// the id submitted (Google may supersede an id). 2B2 must resubmit
// `quote.intent.placeId` verbatim so 2C's intentHash recomputation
// matches without a second Places call.
//
// ACCESS (dark phase): signed-in customer AND the explicit
// QUOTE_SHADOW_ALLOWLIST of auth user ids — "signed-in" is every
// passenger, and a dark endpoint must not let curiosity spend Google
// quota. The allowlist check precedes every Google call; removing the
// allowlist is a deliberate 2B2 change.
//
// Kill switch QUOTE_SERVICE_DISABLED=1 answers 503 before anything.

const { createClient } = require('@supabase/supabase-js');

// The authenticated subject, in one place.
function authUserIdOf(userData) {
  return userData.user.id;
}
const { airportByCode, isValidPlaceId, resolvePlace } = require('./lib/place-identity');
const { computeRouteFacts, isMeaningfullyPast } = require('./lib/route-facts');
const { resolveRateCard } = require('./lib/rate-card-resolver');
const { computeIntentHash, signQuoteToken, resolveSigningKeys, QUOTE_TTL_MS } = require('./lib/quote-token');
const { quoteRide } = require('./lib/ride-quote');

// The strict intent allowlist — the boundary is enforced, not advisory.
const ALLOWED_FIELDS = ['mode', 'airportCode', 'placeId', 'pickupAt', 'passengers'];

// RFC 3339 with a MANDATORY offset. `Date.parse` would happily accept
// '2026-08-20' and '2026-08-20T10:00:00' — the latter is interpreted in
// the SERVER's local zone, so the same submitted string would mean a
// different contractual instant depending on where the function runs
// (13 hours apart between UTC and Asia/Tokyo). A pickup instant is a
// contract; it must be unambiguous on its face.
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;

// Parse a strict RFC 3339 instant, or NaN. The calendar is checked
// explicitly because Date.parse SILENTLY ROLLS OVER an impossible date
// — '2099-02-30T10:00:00Z' becomes March 2 rather than an error, which
// would book a different day than the passenger wrote.
function parseRfc3339(value) {
  if (typeof value !== 'string') return NaN;
  const m = RFC3339_RE.exec(value);
  if (!m) return NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return NaN;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return NaN;
  return Date.parse(value);
}

function authUnavailable(error) {
  return error?.name === 'AuthRetryableFetchError' || !error?.status || error.status >= 500;
}

// One SHARED budget for both provider calls. This is OUR product
// choice, not a platform constraint: Netlify's synchronous limit is 60s
// and is not configurable, so the platform would happily wait out two
// independent 8s calls. The budget exists because a passenger-facing
// quote must not hang, and because an invocation that dies late still
// pays for every Google call it already made. 7s bounds the worst case
// while leaving headroom for the two Supabase round trips.
const PROVIDER_BUDGET_MS = 7000;

// Permanent place-identity failures must NOT look retryable: a 502
// invites a retry that buys another Places + Compute Routes Pro pair
// and can never succeed. These are exactly the identity outcomes a
// passenger can act on. Denied/restricted keys, quota, timeout, network,
// 5xx, and unparseable provider responses remain sanitized 502s. A
// misconfigured key must never surface as "reselect your address" or
// "no drivable route"; that would hide an outage as passenger error.
const PLACE_INPUT_FAILURES = new Set([
  'invalid_place_id',
  'places_invalid_request',
  'places_not_found'
]);
const NO_ROUTE_FAILURES = new Set(['routes_no_route']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (process.env.QUOTE_SERVICE_DISABLED === '1' || process.env.QUOTE_SERVICE_DISABLED === 'true') {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Quote service temporarily unavailable' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const routesKey = process.env.GOOGLE_ROUTES_API_KEY;
  const placesKey = process.env.GOOGLE_PLACES_SERVER_API_KEY;
  const allowlistRaw = process.env.QUOTE_SHADOW_ALLOWLIST;
  // ACCESS MODE — explicit, never inferred. A MISSING allowlist must never
  // read as "everyone is allowed": that is the failure where deleting one
  // variable silently opens a paid Google endpoint to the internet. So the
  // mode is named, defaults to the restrictive value, and an unknown value
  // is a refusal rather than a guess.
  //   'allowlist'     (default) — signed-in AND on QUOTE_SHADOW_ALLOWLIST
  //   'authenticated'           — every signed-in customer; no allowlist needed
  const accessMode = String(process.env.QUOTE_ACCESS_MODE || 'allowlist').trim().toLowerCase();
  if (accessMode !== 'allowlist' && accessMode !== 'authenticated') {
    console.error('❌ quote-ride QUOTE_ACCESS_MODE invalid');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  if (!supabaseUrl || !serviceKey || !anonKey || !routesKey || !placesKey) {
    console.error('❌ quote-ride configuration incomplete');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  if (accessMode === 'allowlist' && !allowlistRaw) {
    console.error('❌ quote-ride allowlist mode requires QUOTE_SHADOW_ALLOWLIST');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  // Signing keys go through the ONE canonical resolver that 2C's
  // verification will also use: a present-but-weak secret is NOT
  // configured, and a half-configured rotation is a refusal.
  const signing = resolveSigningKeys(process.env);
  if (!signing.ok) {
    console.error('❌ quote-ride signing key configuration invalid:', signing.reason);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const db = createClient(supabaseUrl, serviceKey);

  const startedMs = Date.now();
  let placesMs = 0;
  let routesMs = 0;

  try {
    // ---- authentication (CreditEngine discipline: outage is 500) ----
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };

    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError) {
      if (authUnavailable(userError)) {
        console.error('❌ quote-ride auth verification unavailable');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify sign-in' }) };
      }
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }
    if (!userData?.user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    const authUserId = authUserIdOf(userData);

    // ---- access gate: FIRST, before any database read, write or Google call ----
    // A denied account must leave no trace. When this sat after the identity
    // lookup, an unlisted ambassador got a customers row minted for them and
    // THEN a 403 — a write performed on behalf of someone being refused.
    if (accessMode === 'allowlist') {
      const allowlist = allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (!allowlist.includes(authUserId)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not enabled for this account' }) };
      }
    }

    const { data: customer, error: customerError } = await db
      .from('customers')
      .select('id')
      .eq('user_id', authUserId)
      .maybeSingle();
    if (customerError) {
      console.error('❌ quote-ride customer lookup failed');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
    }
    // AMBASSADOR RECOVERY — must mirror create-booking exactly. Without it
    // an active ambassador who has never booked is refused a PRICE and then
    // allowed to BOOK, so the quote and the booking disagree about who may
    // proceed. create-booking already treats "no customers row + ACTIVE
    // ambassador host row" as recoverable and mints the row from the HOST
    // record (never from passenger details); the same rule applies here, on
    // the same approved source.
    let customerId = customer ? customer.id : null;
    if (!customerId) {
      const { data: ambassadorHost, error: hostError } = await db
        .from('hosts')
        .select('id, name, phone, email')
        .eq('user_id', authUserId)
        .eq('status', 'active')
        .maybeSingle();
      if (hostError) {
        console.error('❌ quote-ride host lookup failed during identity recovery');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
      }
      if (!ambassadorHost) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Account profile incomplete — please sign in again to finish setting up your account' })
        };
      }
      const { data: createdCustomer, error: createError } = await db
        .from('customers')
        .insert([{
          user_id: authUserId,
          name: ambassadorHost.name,
          phone: ambassadorHost.phone || null,
          email: ambassadorHost.email || userData.user.email || null,
          type: 'guest',
          source: 'website'
        }])
        .select('id')
        .single();
      if (createError) {
        // customers.user_id carries a UNIQUE index, so two requests racing to
        // recover the same ambassador will collide by design. The loser must
        // re-read the winner's row, not fail the quote.
        const conflict = createError.code === '23505' ||
          /duplicate key|unique constraint/i.test(createError.message || '');
        if (!conflict) {
          console.error('❌ quote-ride ambassador ensure-row failed');
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
        }
        const { data: existing, error: rereadError } = await db
          .from('customers')
          .select('id')
          .eq('user_id', authUserId)
          .maybeSingle();
        if (rereadError || !existing) {
          console.error('❌ quote-ride ambassador ensure-row reread failed');
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
        }
        customerId = existing.id;
      } else if (!createdCustomer) {
        console.error('❌ quote-ride ambassador ensure-row returned no row');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
      } else {
        customerId = createdCustomer.id;
      }
    }

    // ---- trusted-intent validation ----
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    // A JSON null, array, or primitive is a malformed REQUEST, not a
    // server fault: answer 400 rather than letting Object.keys(null)
    // throw into the 500 catch.
    if (!isPlainObject(body)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body must be a JSON object' }) };
    }
    for (const key of Object.keys(body)) {
      if (!ALLOWED_FIELDS.includes(key)) {
        // Route facts, prices, coordinates, bags, vehicle preference —
        // anything beyond the intent — is rejected by NAME so the
        // boundary is visible.
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Unexpected field '${String(key).slice(0, 40)}' — this endpoint accepts intent only` }) };
      }
    }
    const { mode, airportCode, placeId, pickupAt, passengers } = body;

    if (mode !== 'pickup' && mode !== 'dropoff') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "mode must be 'pickup' or 'dropoff'" }) };
    }
    const airport = airportByCode(airportCode);
    if (!airport) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown airport code' }) };
    }
    if (!isValidPlaceId(placeId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid place identity' }) };
    }
    const pickupAtMs = parseRfc3339(pickupAt);
    if (!Number.isFinite(pickupAtMs)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'pickupAt must be a real RFC 3339 datetime with a UTC offset (e.g. 2026-08-20T14:00:00Z)' }) };
    }
    const nowMs = Date.now();
    if (isMeaningfullyPast(pickupAtMs, nowMs)) {
      // A quote for a past pickup is meaningless — REJECTED, never
      // silently re-routed as "now".
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'pickupAt is in the past' }) };
    }
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > 100) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'passengers must be a positive integer' }) };
    }
    const card0 = await resolveRateCard({ authUserId, customerId, pickupAtMs });
    if (!card0 || !card0.ok) {
      console.error('❌ quote-ride rate card resolution failed');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Pricing unavailable' }) };
    }
    // The card is in hand and it already knows every seat count, so a
    // party no vehicle can carry is refused HERE — for free — instead of
    // buying a Places call and a Compute Routes Pro call only for the
    // engine to refuse all three vehicles afterwards.
    const maxSeats = Math.max(
      ...Object.values(card0.card.vehicles).map((v) => v.capacity.passengers)
    );
    if (passengers > maxSeats) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `No vehicle seats ${passengers} passengers (maximum ${maxSeats})` })
      };
    }

    // ---- place identity: ONE identity for routing and storage ----
    const providerDeadline = Date.now() + PROVIDER_BUDGET_MS;
    const placesStart = Date.now();
    const place = await resolvePlace(placeId, { apiKey: placesKey, deadlineMs: providerDeadline });
    placesMs = Date.now() - placesStart;
    if (!place.ok) {
      logTelemetry({ startedMs, placesMs, routesMs, outcome: place.reason });
      const permanent = PLACE_INPUT_FAILURES.has(place.reason);
      return {
        statusCode: permanent ? 400 : 502,
        headers,
        body: JSON.stringify({
          error: permanent
            ? 'That address could not be resolved — please reselect it'
            : 'Could not resolve the address right now'
        })
      };
    }
    // The CANONICAL id — used for routing, for the response, and for
    // the intentHash alike. Never a mix.
    const canonicalPlaceId = place.placeId;

    // ---- server route facts (place_id waypoints, both sides) ----
    const originPlaceId = mode === 'dropoff' ? canonicalPlaceId : airport.placeId;
    const destinationPlaceId = mode === 'dropoff' ? airport.placeId : canonicalPlaceId;
    const routesStart = Date.now();
    const route = await computeRouteFacts(
      { originPlaceId, destinationPlaceId, pickupAtMs, nowMs },
      { apiKey: routesKey, deadlineMs: providerDeadline }
    );
    routesMs = Date.now() - routesStart;
    if (!route.ok) {
      logTelemetry({ startedMs, placesMs, routesMs, outcome: route.reason });
      const noRoute = NO_ROUTE_FAILURES.has(route.reason);
      return {
        statusCode: noRoute ? 422 : 502,
        headers,
        body: JSON.stringify({
          error: noRoute
            ? 'No drivable route between those places'
            : 'Could not compute the route right now'
        })
      };
    }

    // ---- price every vehicle on the card ----
    const { card, resolvedVersion } = card0;

    const vehicles = {};
    const centsByVehicle = {};
    let vehiclesOk = 0;
    for (const key of Object.keys(card.vehicles)) {
      const q = quoteRide({
        vehicle: key,
        routeMiles: route.routeMiles,
        routeMinutes: route.routeMinutes,
        pickupAtMs,
        passengers,
        // Bags are DELIBERATELY unchecked: the UI collects no bag
        // count today (the submitted `bags` field in bookings is the
        // carousel's capacity spec echoed back). The engine's bag
        // machinery stays dormant until the UI genuinely asks.
        bags: 0,
        bookingMode: mode,
        rateCard: card
      });
      if (!q.ok) {
        vehicles[key] = { ok: false, error: q.error };
        continue;
      }
      // Each token's intentHash covers ITS OWN vehicle, so a payload
      // vehicle and its hash can never disagree.
      const intentHash = computeIntentHash({
        mode,
        airportCode,
        placeId: canonicalPlaceId,
        pickupAtMs,
        passengers,
        vehicle: key
      });
      const quoteToken = signQuoteToken({
        purpose: 'create',
        authUserId,
        customerId,
        vehicle: key,
        pickupAtMs,
        intentHash,
        routeQuality: route.routeQuality,
        finalCents: q.quote.finalCents,
        pricingVersion: q.quote.pricingVersion,
        engineVersion: q.quote.engineVersion,
        resolvedVersion
      }, { keyId: signing.current.id, secret: signing.current.secret, nowMs });
      vehicles[key] = {
        ok: true,
        vehicleName: q.quote.vehicleName,
        finalCents: q.quote.finalCents,
        protectionApplied: q.quote.protectionApplied,
        appliedSurcharges: q.quote.appliedSurcharges.map((s) => ({ type: s.type, rate: s.rate })),
        passengerCapacityChecked: true,
        luggageCapacityChecked: false,
        token: quoteToken,
        expiresAt: new Date(nowMs + QUOTE_TTL_MS).toISOString()
      };
      centsByVehicle[key] = q.quote.finalCents;
      vehiclesOk++;
    }

    logTelemetry({
      startedMs, placesMs, routesMs,
      outcome: 'ok',
      routeQuality: route.routeQuality,
      miles: Math.round(route.routeMiles),
      minutes: Math.round(route.routeMinutes / 5) * 5,
      // Whether Google superseded the submitted id — a boolean, never
      // either id.
      placeIdSubstituted: place.substituted === true,
      vehiclesOk,
      vehiclesRefused: Object.keys(card.vehicles).length - vehiclesOk,
      cents: centsByVehicle
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        quote: {
          intent: {
            mode,
            airportCode,
            // CANONICAL — 2B2 resubmits this verbatim.
            placeId: canonicalPlaceId,
            formattedAddress: place.formattedAddress,
            airportName: airport.formattedAddress,
            pickupAt: new Date(pickupAtMs).toISOString(),
            passengers
          },
          route: {
            miles: route.routeMiles,
            minutes: route.routeMinutes,
            quality: route.routeQuality
          },
          vehicles,
          // A consumer must not have to iterate `vehicles` to discover
          // that nothing is bookable (e.g. a route beyond the service
          // area refuses every vehicle while still answering 200).
          vehiclesOk,
          vehiclesRefused: Object.keys(card.vehicles).length - vehiclesOk,
          bookable: vehiclesOk > 0,
          pricingVersion: card.pricingVersion,
          resolvedVersion,
          cardSource: card0.source,
          ttlMinutes: QUOTE_TTL_MS / 60000,
          issuedAt: new Date(nowMs).toISOString()
        }
      })
    };
  } catch (error) {
    console.error('❌ quote-ride error:', error && error.name ? error.name : 'unexpected');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

// Sanitized telemetry: latency, outcome class, quantized route buckets,
// cents. NEVER addresses, place IDs, coordinates, identities, or raw
// provider errors — asserted by tests.
function logTelemetry(fields) {
  const { startedMs, ...rest } = fields;
  console.log('quote_telemetry ' + JSON.stringify({
    totalMs: Date.now() - startedMs,
    ...rest
  }));
}
