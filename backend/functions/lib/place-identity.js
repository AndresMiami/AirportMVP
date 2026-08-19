// Place identity (PR 3C-2B1) — the trusted-intent boundary's address
// half. The quote service accepts an airport CODE plus a Google
// place_id; this module turns those into ONE identity used for both
// routing (the place_id waypoint itself — Google's access-point
// behavior) and the canonical formatted address a booking will later
// store. Clients never supply coordinates or free text, so the routed
// place and the stored place can never silently differ.
//
// ONE CANONICAL ID: Google may answer a Place Details lookup with a
// DIFFERENT place id than the one submitted (ids are refreshed and
// superseded over time). The resolved id is therefore the canonical
// one, and the caller must use it for routing, for the response, and
// for the intentHash alike — never a mix. The response returns it so
// 2B2 resubmits the canonical id and 2C's intentHash recomputation
// matches without a second Places call.
//
// Server-side ONLY: the Places API (New) call uses the dedicated
// GOOGLE_PLACES_SERVER_API_KEY (restricted to Places API (New)) —
// never the browser-recoverable maps key. One attempt, bounded
// timeout, no retries; failures are structured, never thrown.

// LinkMia's service airports — server-known identities (place IDs and
// canonical display data mirror the Railway proxy's pre-cache, the
// same identities the autocomplete surfaces to passengers today).
//
// OPERATIONAL RISK, RECORDED: these three ids are PINNED and never pass
// through resolvePlace, even though this module's whole premise is that
// Google supersedes place ids. Every route request uses one of them as
// an endpoint, so if Google retires one, EVERY quote for that airport
// fails — surfacing only as a generic routing refusal. There is no code
// fix worth a per-request Places call for a static list; the control is
// operational: verify all three resolve as part of the rollout smoke
// matrix, and re-verify whenever quotes for one airport start failing.
const AIRPORTS = Object.freeze({
  MIA: Object.freeze({
    code: 'MIA',
    placeId: 'ChIJQ2DP_4u02YgRPNlKgMr9gBE',
    name: 'Miami International Airport',
    formattedAddress: 'Miami International Airport (MIA), 2100 NW 42nd Ave, Miami, FL 33142'
  }),
  FLL: Object.freeze({
    code: 'FLL',
    placeId: 'ChIJ9frI5Hq42YgR4bCqA7w1_Ww',
    name: 'Fort Lauderdale-Hollywood International Airport',
    formattedAddress: 'Fort Lauderdale-Hollywood International Airport (FLL), 100 Terminal Dr, Fort Lauderdale, FL 33315'
  }),
  PBI: Object.freeze({
    code: 'PBI',
    placeId: 'ChIJd_cFKRUu2YgR6Me7ie5YMO0',
    name: 'Palm Beach International Airport',
    formattedAddress: 'Palm Beach International Airport (PBI), 1000 James L Turnage Blvd, West Palm Beach, FL 33415'
  })
});

// Google place_id shape: an opaque token. Google states verbatim that
// "there is no maximum length for place IDs", and the documented
// long-form example runs past 600 characters — a 512 bound would have
// refused a place ID straight out of Google's own documentation. So
// MAX_PLACE_ID_LEN is a declared operational bound of OURS (a request
// body sane enough to route and log), set well clear of any published
// example. The character class matches Google's URL-safe-base64 form,
// including that long example; the value is also URL-encoded at the
// call site, so neither the bound nor the class is the only thing
// standing between a client string and a request URL.
//
// ONE CONTRACT, BOTH DIRECTIONS: this is the ONLY place-id validator,
// applied identically to a client's submitted id and to Google's
// returned id. Validating them differently is what lets the service
// hand the browser a "canonical" id that its own next request would
// reject with 400.
const MAX_PLACE_ID_LEN = 2048;
const PLACE_ID_RE = new RegExp(`^[A-Za-z0-9_-]{10,${MAX_PLACE_ID_LEN}}$`);

const PLACES_TIMEOUT_MS = 8000;

// Own-property lookup ONLY: a bare `AIRPORTS[code]` answers truthily for
// 'constructor', 'toString', '__proto__' and every other prototype
// member, which would carry an unknown code past the whitelist and on
// into paid Places and Routes calls.
function airportByCode(code) {
  if (typeof code !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(AIRPORTS, code)) return null;
  return AIRPORTS[code];
}

function isValidPlaceId(placeId) {
  return typeof placeId === 'string' && PLACE_ID_RE.test(placeId);
}

// Resolve a place_id to its canonical identity via Places API (New).
// Returns { ok:true, placeId, requestedPlaceId, substituted, formattedAddress }
// or { ok:false, reason } — reasons are sanitized classes, never raw
// provider text. `placeId` is the CANONICAL id: the one Google
// returned, which we REQUIRE. A successful response that omits `id`
// (we ask for it in the field mask) or returns one that fails the
// shared contract is a response we do not understand — it fails as
// places_parse_error. It must NEVER fall back to the submitted id
// while keeping the resolved place's address: that silent pairing is
// exactly the identity split this module exists to prevent.
// fetchImpl is injectable.
async function resolvePlace(placeId, { apiKey, fetchImpl, deadlineMs }) {
  if (!isValidPlaceId(placeId)) {
    return { ok: false, reason: 'invalid_place_id' };
  }
  const doFetch = fetchImpl || fetch;
  // The per-call bound never outlives the caller's SHARED budget: two
  // independent 8s waits would exceed the platform's synchronous
  // function limit and get the invocation killed AFTER the paid calls.
  const budget = Number.isFinite(deadlineMs)
    ? Math.min(PLACES_TIMEOUT_MS, deadlineMs - Date.now())
    : PLACES_TIMEOUT_MS;
  if (budget <= 0) return { ok: false, reason: 'places_timeout' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await doFetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'id,formattedAddress'
        },
        signal: controller.signal
      }
    );
    if (!res.ok) {
      // NARROW classification. Only an obsolete/unknown place id is the
      // PASSENGER's to correct. A 401/403 means a broken key, a wrong
      // API restriction, or a disabled API; a 400 means WE built a bad
      // request. Telling a passenger to "reselect the address" because
      // a server key is misconfigured hides an outage as user error —
      // and a fresh restricted key is exactly what rollout provisions.
      if (res.status >= 500) return { ok: false, reason: 'places_5xx' };
      if (res.status === 404) return { ok: false, reason: 'places_not_found' };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'places_denied' };
      if (res.status === 429 || res.status === 408) return { ok: false, reason: 'places_rate_limited' };
      return { ok: false, reason: 'places_bad_request' };
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body.formattedAddress !== 'string' || body.formattedAddress.trim() === '') {
      return { ok: false, reason: 'places_parse_error' };
    }
    if (!isValidPlaceId(body.id)) {
      return { ok: false, reason: 'places_parse_error' };
    }
    const resolvedId = body.id;
    return {
      ok: true,
      placeId: resolvedId,
      requestedPlaceId: placeId,
      substituted: resolvedId !== placeId,
      formattedAddress: body.formattedAddress
    };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'places_timeout' : 'places_network_error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  AIRPORTS,
  airportByCode,
  isValidPlaceId,
  resolvePlace,
  MAX_PLACE_ID_LEN
};
