// Route facts (PR 3C-2B1) — the server's authoritative answer to "how
// far, how long," replacing trust in browser-computed facts. One
// Routes API computeRoutes call, place_id waypoints on BOTH sides
// (Google's access-point behavior — an airport routes to its pickup
// curb, not a rooftop coordinate), TRAFFIC_AWARE, with the results
// quantized EXACTLY as the browser quantizes today so the pricing
// engine receives parity-identical inputs:
//   miles   = Math.round(meters * 0.000621371 * 10) / 10   (0.1 mi)
//   minutes = Math.round(seconds / 60)                     (whole)
// (indexMVP.html getRouteData — the parity contract.)
//
// departureTime rule (plan v3): the CONTRACTUAL pickup instant is
// never rewritten. A pickup more than PAST_TOLERANCE_MS in the past
// must be rejected by the CALLER before this module runs; a pickup
// within ±NEAR_WINDOW_MS of now OMITS departureTime (Google defaults);
// a future pickup is passed verbatim. Google rejects past departure
// times, and fabricating "now" as the pickup would misrepresent the
// contract.
//
// COST, STATED HONESTLY — two levers, not one. Google bills a
// computeRoutes request at the highest tier ANY single element
// triggers, so:
//   * `routingPreference: TRAFFIC_AWARE` sets the FLOOR: every one of
//     these calls is a **Compute Routes Pro** request, and no field
//     mask can undo that. Budget and quota planning must use Pro
//     pricing — a gate to clear BEFORE the dark-phase allowlist is
//     removed and real passenger volume reaches this call.
//   * the request shape AND field mask jointly hold the CEILING.
//     Enterprise triggers include TWO_WHEELER routing, toll calculation,
//     and traffic-on-polyline; they require request features such as
//     travelMode/extraComputations as well as their response fields.
//     Eco-routing is Pro (it requires TRAFFIC_AWARE_OPTIMAL), not
//     Enterprise. Keeping both surfaces minimal prevents a future
//     feature addition from silently repricing every call upward.
// Two traps for whoever tries to "reduce cost" here: dropping to
// TRAFFIC_UNAWARE would move real prices (routeMinutes feeds the
// engine's hourly-protection floor) and would make the whole
// departureTime contract meaningless; trimming fallbackInfo would make
// routeQuality report 'traffic_aware' for every degraded route.
//
// Discipline: minimal field mask INCLUDING fallbackInfo (a masked-out
// field is never returned); 8s bounded timeout; STRICT provider-value
// validation; exactly ONE attempt — no blind retries against quota.
// Failures are structured classes, never raw provider text, never a
// fabricated number.

const ROUTES_TIMEOUT_MS = 8000;
const FIELD_MASK = 'routes.distanceMeters,routes.duration,fallbackInfo';
const NEAR_WINDOW_MS = 5 * 60 * 1000; // ±5 min of now: omit departureTime
const PAST_TOLERANCE_MS = 5 * 60 * 1000; // beyond this in the past: caller rejects

// Provider-value bounds. distanceMeters is documented int32; the metre
// bound is an operational sanity limit far beyond any drivable
// transfer, and the seconds bound mirrors the pricing engine's own
// one-week routeMinutes ceiling so nothing absurd can reach it.
const MAX_ROUTE_METERS = 20000000; // 20,000 km
const MAX_ROUTE_SECONDS = 604800; // one week, = engine's 10080-minute cap

// protobuf Duration wire format: decimal seconds, up to 9 fractional
// digits, suffixed 's'. Anything else is refused rather than coerced.
const DURATION_RE = /^\d{1,12}(\.\d{1,9})?s$/;

// Quantizers — the browser formulas, verbatim.
function quantizeMiles(meters) {
  return Math.round(meters * 0.000621371 * 10) / 10;
}
function quantizeMinutes(seconds) {
  return Math.round(seconds / 60);
}

function isMeaningfullyPast(pickupAtMs, nowMs) {
  return pickupAtMs < nowMs - PAST_TOLERANCE_MS;
}

// { originPlaceId, destinationPlaceId, pickupAtMs, nowMs } ->
// { ok:true, routeMiles, routeMinutes, routeQuality } |
// { ok:false, reason }
async function computeRouteFacts(
  { originPlaceId, destinationPlaceId, pickupAtMs, nowMs },
  { apiKey, fetchImpl, deadlineMs }
) {
  const doFetch = fetchImpl || fetch;
  const budget = Number.isFinite(deadlineMs)
    ? Math.min(ROUTES_TIMEOUT_MS, deadlineMs - Date.now())
    : ROUTES_TIMEOUT_MS;
  if (budget <= 0) return { ok: false, reason: 'routes_timeout' };

  const body = {
    origin: { placeId: originPlaceId },
    destination: { placeId: destinationPlaceId },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE'
  };
  // Omit departureTime inside the near window (Google defaults to
  // current traffic); pass the contractual instant verbatim otherwise.
  if (pickupAtMs > nowMs + NEAR_WINDOW_MS) {
    body.departureTime = new Date(pickupAtMs).toISOString();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await doFetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      // NARROW classification. The genuine "no route" answer is a 200
      // with an empty routes array (below) — NOT an HTTP error. A 400
      // here means WE sent a malformed request, and 401/403 means a
      // broken key or a wrong API restriction. Neither is a passenger's
      // routing problem, and neither may be reported as one.
      if (res.status >= 500) return { ok: false, reason: 'routes_5xx' };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'routes_denied' };
      if (res.status === 429 || res.status === 408) return { ok: false, reason: 'routes_rate_limited' };
      return { ok: false, reason: 'routes_bad_request' };
    }
    const payload = await res.json().catch(() => null);
    if (!payload || !Array.isArray(payload.routes)) {
      return { ok: false, reason: 'routes_parse_error' };
    }
    // computeRoutes answers 200 with an EMPTY routes array when no
    // route exists (unreachable place, or origin === destination). That
    // is an answer, not a malfunction.
    const route = payload.routes[0];
    if (!route) return { ok: false, reason: 'routes_no_route' };

    // distanceMeters is an int32 in the API contract: a fractional or
    // out-of-range value is a response we do not understand, not a
    // number to round.
    const meters = route.distanceMeters;
    if (!Number.isSafeInteger(meters) || meters <= 0 || meters > MAX_ROUTE_METERS) {
      return { ok: false, reason: 'routes_parse_error' };
    }
    // STRICT protobuf duration format; nothing non-finite or absurd may
    // ever reach the pricing engine.
    if (typeof route.duration !== 'string' || !DURATION_RE.test(route.duration)) {
      return { ok: false, reason: 'routes_parse_error' };
    }
    const seconds = Number(route.duration.slice(0, -1));
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_ROUTE_SECONDS) {
      return { ok: false, reason: 'routes_parse_error' };
    }

    // The quantized values are what the engine actually prices — assert
    // them directly rather than inferring their sanity from the inputs.
    const routeMiles = quantizeMiles(meters);
    const routeMinutes = quantizeMinutes(seconds);
    if (!Number.isFinite(routeMiles) || routeMiles < 0 ||
        !Number.isFinite(routeMinutes) || routeMinutes < 0) {
      return { ok: false, reason: 'routes_parse_error' };
    }

    // A degraded/fallback computation is still Google's authoritative
    // answer, but it must never masquerade as scheduled-traffic truth:
    // the quality label travels in the response AND the signed token,
    // and 2B2 owes a deliberate decision before displaying fallback
    // pricing as authoritative.
    const routeQuality = payload.fallbackInfo ? 'fallback' : 'traffic_aware';

    return { ok: true, routeMiles, routeMinutes, routeQuality };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'routes_timeout' : 'routes_network_error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  computeRouteFacts,
  quantizeMiles,
  quantizeMinutes,
  isMeaningfullyPast,
  FIELD_MASK,
  NEAR_WINDOW_MS,
  PAST_TOLERANCE_MS,
  MAX_ROUTE_METERS,
  MAX_ROUTE_SECONDS
};
