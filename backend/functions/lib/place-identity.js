// Place identity (PR 3C-2B1) — the trusted-intent boundary's address
// half. The quote service accepts an airport CODE plus a Google
// place_id; this module turns those into ONE identity used for both
// routing (the place_id waypoint itself — Google's access-point
// behavior) and the canonical formatted address a booking will later
// store. Clients never supply coordinates or free text, so the routed
// place and the stored place can never silently differ.
//
// Server-side ONLY: the Places API (New) call uses the dedicated
// GOOGLE_PLACES_SERVER_API_KEY (restricted to Places API (New)) —
// never the browser-recoverable maps key. One attempt, bounded
// timeout, no retries; failures are structured, never thrown.

// LinkMia's service airports — server-known identities (place IDs and
// canonical display data mirror the Railway proxy's pre-cache, the
// same identities the autocomplete surfaces to passengers today).
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

// Google place_id shape: opaque token, typically 27-80 chars. Bounded
// and character-restricted — never interpolated into logs or errors.
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,256}$/;

const PLACES_TIMEOUT_MS = 8000;

function airportByCode(code) {
  if (typeof code !== 'string') return null;
  return AIRPORTS[code] || null;
}

function isValidPlaceId(placeId) {
  return typeof placeId === 'string' && PLACE_ID_RE.test(placeId);
}

// Resolve a place_id to its canonical formatted address via Places API
// (New). Returns { ok:true, placeId, formattedAddress } or
// { ok:false, reason } — reasons are sanitized classes, never raw
// provider text. fetchImpl is injectable for tests.
async function resolvePlace(placeId, { apiKey, fetchImpl }) {
  if (!isValidPlaceId(placeId)) {
    return { ok: false, reason: 'invalid_place_id' };
  }
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);
  try {
    const res = await doFetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,formattedAddress'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      return { ok: false, reason: res.status >= 500 ? 'places_5xx' : 'places_4xx' };
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body.formattedAddress !== 'string' || body.formattedAddress.trim() === '') {
      return { ok: false, reason: 'places_parse_error' };
    }
    return { ok: true, placeId, formattedAddress: body.formattedAddress };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'places_timeout' : 'places_network_error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { AIRPORTS, airportByCode, isValidPlaceId, resolvePlace };
