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
// Discipline: minimal field mask (cost-tier control) INCLUDING
// fallbackInfo (a masked-out field is never returned); 8s bounded
// timeout; STRICT duration parsing; exactly ONE attempt — no blind
// retries against quota. Failures are structured classes, never raw
// provider text, never a fabricated number.

const ROUTES_TIMEOUT_MS = 8000;
const FIELD_MASK = 'routes.distanceMeters,routes.duration,fallbackInfo';
const NEAR_WINDOW_MS = 5 * 60 * 1000; // ±5 min of now: omit departureTime
const PAST_TOLERANCE_MS = 5 * 60 * 1000; // beyond this in the past: caller rejects

const DURATION_RE = /^\d+(\.\d+)?s$/;

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
  { apiKey, fetchImpl }
) {
  const doFetch = fetchImpl || fetch;

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
  const timer = setTimeout(() => controller.abort(), ROUTES_TIMEOUT_MS);
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
      return { ok: false, reason: res.status >= 500 ? 'routes_5xx' : 'routes_4xx' };
    }
    const payload = await res.json().catch(() => null);
    const route = payload && Array.isArray(payload.routes) ? payload.routes[0] : null;
    if (!route) return { ok: false, reason: 'routes_parse_error' };

    const meters = route.distanceMeters;
    if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) {
      return { ok: false, reason: 'routes_parse_error' };
    }
    // STRICT "123s" / "123.5s" duration format — anything else refuses;
    // nothing non-finite may ever reach the pricing engine.
    if (typeof route.duration !== 'string' || !DURATION_RE.test(route.duration)) {
      return { ok: false, reason: 'routes_parse_error' };
    }
    const seconds = Number(route.duration.slice(0, -1));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { ok: false, reason: 'routes_parse_error' };
    }

    // A degraded/fallback computation is still Google's authoritative
    // answer, but it must never masquerade as scheduled-traffic truth:
    // the quality label travels in the response AND the signed token,
    // and 2B2 owes a deliberate decision before displaying fallback
    // pricing as authoritative.
    const routeQuality = payload.fallbackInfo ? 'fallback' : 'traffic_aware';

    return {
      ok: true,
      routeMiles: quantizeMiles(meters),
      routeMinutes: quantizeMinutes(seconds),
      routeQuality
    };
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
  PAST_TOLERANCE_MS
};
