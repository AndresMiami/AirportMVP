// Server quote endpoint (PR 3C-2B1) — DARK by design.
//   POST /api/quote-ride { mode, airportCode, placeId, pickupAt,
//                          passengers, vehicle? }
//     -> all-vehicles server quote, each with a signed token.
//
// Nothing in production calls this endpoint: it exists so the
// authoritative quote pipeline (trusted intent -> server route facts
// -> 3C-2A engine -> signed quote) can run and be measured before the
// browser integrates (2B2) and the write endpoints enforce (2C).
// Zero passenger-visible behavior. Zero storage — no route facts, no
// quotes, nothing persists (the Google storage-policy review gates 2C,
// not this).
//
// TRUSTED-INTENT BOUNDARY: the client sends intent ONLY. The field
// set is a strict allowlist; any route-fact-shaped or unknown field is
// a 400. The server derives route facts itself and resolves the
// place_id to ONE identity used for routing and the future stored
// address alike.
//
// ACCESS (dark phase): signed-in customer AND the explicit
// QUOTE_SHADOW_ALLOWLIST of auth user ids — "signed-in" is every
// passenger, and a dark endpoint must not let curiosity spend Google
// quota. The allowlist check precedes every Google call; removing the
// allowlist is a deliberate 2B2 change.
//
// Kill switch QUOTE_SERVICE_DISABLED=1 answers 503 before anything.

const { createClient } = require('@supabase/supabase-js');
const { airportByCode, isValidPlaceId, resolvePlace } = require('./lib/place-identity');
const { computeRouteFacts, isMeaningfullyPast } = require('./lib/route-facts');
const { resolveRateCard } = require('./lib/rate-card-resolver');
const { computeIntentHash, signQuoteToken, QUOTE_TTL_MS } = require('./lib/quote-token');
const { quoteRide } = require('./lib/ride-quote');

// The strict intent allowlist — the boundary is enforced, not advisory.
const ALLOWED_FIELDS = ['mode', 'airportCode', 'placeId', 'pickupAt', 'passengers', 'vehicle'];

function authUnavailable(error) {
  return error?.name === 'AuthRetryableFetchError' || !error?.status || error.status >= 500;
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
  const signingId = process.env.QUOTE_SIGNING_CURRENT_ID;
  const signingSecret = process.env.QUOTE_SIGNING_CURRENT_SECRET;
  const allowlistRaw = process.env.QUOTE_SHADOW_ALLOWLIST;
  if (!supabaseUrl || !serviceKey || !anonKey || !routesKey || !placesKey ||
      !signingId || !signingSecret || !allowlistRaw) {
    console.error('❌ quote-ride configuration incomplete');
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
    const authUserId = userData.user.id;

    const { data: customer, error: customerError } = await db
      .from('customers')
      .select('id')
      .eq('user_id', authUserId)
      .maybeSingle();
    if (customerError) {
      console.error('❌ quote-ride customer lookup failed');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
    }
    if (!customer) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Account profile incomplete' }) };
    }

    // ---- dark-phase allowlist (BEFORE any Google call) ----
    const allowlist = allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowlist.includes(authUserId)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not enabled for this account' }) };
    }

    // ---- trusted-intent validation ----
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    for (const key of Object.keys(body)) {
      if (!ALLOWED_FIELDS.includes(key)) {
        // Route facts, prices, coordinates, bags — anything beyond the
        // intent — is rejected by NAME so the boundary is visible.
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Unexpected field '${String(key).slice(0, 40)}' — this endpoint accepts intent only` }) };
      }
    }
    const { mode, airportCode, placeId, pickupAt, passengers, vehicle } = body;

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
    const pickupAtMs = typeof pickupAt === 'string' ? Date.parse(pickupAt) : NaN;
    if (!Number.isFinite(pickupAtMs)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'pickupAt must be an ISO datetime' }) };
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
    const card0 = resolveRateCard({ authUserId, customerId: customer.id, pickupAtMs });
    if (!card0.ok) {
      console.error('❌ quote-ride rate card resolution failed');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Pricing unavailable' }) };
    }
    if (vehicle !== undefined && !Object.prototype.hasOwnProperty.call(card0.card.vehicles, vehicle)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown vehicle' }) };
    }

    // ---- place identity: ONE identity for routing and storage ----
    const placesStart = Date.now();
    const place = await resolvePlace(placeId, { apiKey: placesKey });
    placesMs = Date.now() - placesStart;
    if (!place.ok) {
      logTelemetry({ startedMs, placesMs, routesMs, outcome: place.reason });
      return { statusCode: place.reason === 'invalid_place_id' ? 400 : 502, headers, body: JSON.stringify({ error: 'Could not resolve the address' }) };
    }

    // ---- server route facts (place_id waypoints, both sides) ----
    const originPlaceId = mode === 'dropoff' ? placeId : airport.placeId;
    const destinationPlaceId = mode === 'dropoff' ? airport.placeId : placeId;
    const routesStart = Date.now();
    const route = await computeRouteFacts(
      { originPlaceId, destinationPlaceId, pickupAtMs, nowMs },
      { apiKey: routesKey }
    );
    routesMs = Date.now() - routesStart;
    if (!route.ok) {
      logTelemetry({ startedMs, placesMs, routesMs, outcome: route.reason });
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not compute the route' }) };
    }

    // ---- price every vehicle on the card ----
    const { card, resolvedVersion } = card0;
    const intentHash = computeIntentHash({
      mode, airportCode, placeId, pickupAtMs, passengers, vehicle: vehicle ?? null
    });

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
      const quoteToken = signQuoteToken({
        purpose: 'create',
        authUserId,
        customerId: customer.id,
        vehicle: key,
        pickupAtMs,
        intentHash,
        routeQuality: route.routeQuality,
        finalCents: q.quote.finalCents,
        pricingVersion: q.quote.pricingVersion,
        engineVersion: q.quote.engineVersion,
        resolvedVersion
      }, { keyId: signingId, secret: signingSecret, nowMs });
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
            placeId,
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
