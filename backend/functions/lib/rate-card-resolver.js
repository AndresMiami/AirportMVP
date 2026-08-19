// Rate-card resolver (PR 3C-2B1) — the seam between "which price list
// applies?" and "what does the ride cost?". Today it always returns
// the validated in-code LinkMia card. Its SIGNATURE is future-shaped:
// context in (even though it is ignored today), validated card +
// provenance out, so Supabase-stored pricing profiles, per-customer or
// per-fleet overrides, and the Pricing Studio can slot in behind this
// function without any caller changing.
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

// Context: { authUserId, customerId, hostId, pickupAtMs } — accepted
// and currently unused (the future override lookup keys on it).
// Returns { ok:true, card, source, resolvedVersion }.
// eslint-disable-next-line no-unused-vars
function resolveRateCard(context) {
  return {
    ok: true,
    card: DEFAULT_CARD,
    source: 'code',
    resolvedVersion: DEFAULT_CARD.pricingVersion
  };
}

module.exports = { resolveRateCard };
