// Rate-card resolver (PR 3C-2B1) — the seam between "which price list
// applies?" and "what does the ride cost?". Today it always returns
// the validated in-code LinkMia card. Its SIGNATURE is future-shaped:
// context in (even though it is ignored today), validated card +
// provenance out, so Supabase-stored customer/time pricing profiles can
// slot in behind this function without caller changes. Host/fleet
// pricing still requires the caller to supply that scope explicitly;
// the limitation is recorded below rather than implied away.
//
// FUTURE FAIL-CLOSED CONTRACT (documented now, testable only when the
// Supabase resolver exists — deliberately NOT overclaimed by any
// current test): the in-code card is the CURRENT DEFAULT, not an
// eternal outage fallback. Once scoped override cards exist, a
// resolver that cannot PROVE the absence of an applicable override
// (e.g. Supabase unreachable) must REFUSE to resolve rather than
// silently quote the wrong default — only a successful lookup showing
// "no override applies to this context" licenses falling back to the
// default card. An outage must never reprice a customer who has a
// negotiated card.

const { LINKMIA_RATE_CARD, validateRateCard } = require('./ride-rate-card');

// Validated once at module load; validateRateCard returns a deep-frozen
// registered clone, so this instance is immutable for the process.
const DEFAULT_CARD = validateRateCard(LINKMIA_RATE_CARD);

// Context: { authUserId, customerId, pickupAtMs } — what the endpoint
// ACTUALLY supplies today, accepted and currently unused (the future
// override lookup keys on it).
//
// SCOPE LIMIT, RECORDED HONESTLY: customer-scoped and time-scoped cards
// can slot in behind this seam untouched, but HOST/FLEET-scoped pricing
// cannot — no caller passes a hostId, so an ambassador- or fleet-scoped
// card needs the caller to look one up and pass it. The "no caller
// changes" promise covers the context that exists, not every scope the
// Pricing Studio may eventually want.
// Returns a Promise of { ok:true, card, source, resolvedVersion }.
//
// ASYNC BY CONTRACT, even though today's answer is synchronous: the
// override lookup this seam exists for is a database call. Declaring it
// async now is what actually makes the "slot in without any caller
// changing" promise true — a sync function whose caller does not await
// cannot be replaced by a Supabase-backed one without touching every
// call site.
// eslint-disable-next-line no-unused-vars
async function resolveRateCard(context) {
  return {
    ok: true,
    card: DEFAULT_CARD,
    source: 'code',
    resolvedVersion: DEFAULT_CARD.pricingVersion
  };
}

module.exports = { resolveRateCard };
