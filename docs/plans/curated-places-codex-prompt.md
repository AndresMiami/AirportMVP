CODEX REVIEW REQUEST — LinkMia curated places + intake fixes (plan v1)

Repo: AndresMiami/AirportMVP · branch: feature/curated-places-intake
Plan to review: docs/plans/curated-places-intake-plan.md (read CLAUDE.md first;
its decisions log and guardrails win any conflict).

Context: On 2026-10-26 we ran our first real private-client booking. The return
trip LM-EFFA (Sun Nov 1, 1:00 PM, PortMiami -> MIA) showed four failures:
(1) typing "Virgin voyage" ranked the Virgin Voyages corporate office in
Plantation above PortMiami Terminal V; (2) the pickup was stored as
"Miami, FL 33132, USA"; (3) a party of 2 was stored as 1 passenger;
(4) the driver card shows FROM/TO as text only.

Agreed order of operations (Andres, 2026-10-26), simple -> complex, one PR each:
  1. Passenger count as a deliberate step + curated places data file +
     curated-first address search + resolved place name carried to the
     booking and driver screens. No migration, no pricing change.
  2. "Cruise Port" trip type, port <-> airport only (hotel <-> port is out:
     the engine prices airport <-> address only and pricing is a non-goal).
  3. Airline -> terminal on airport trips (storage decision deferred to then).
  4. Driver card route map (A/B pins).
  5. SMS status messages LAST, as its own plan, because it reverses recorded
     decision 8 ("never SMS").
Non-goals throughout: voice/conversational booking, payment collection or
fare custody, pricing-logic changes.

Please review ONLY Phase 1 in detail; sanity-check the order of 2-5.
Specifically verify or refute:
  a. Root cause of the passenger bug: state.passengers starts at 1 in
     indexMVP.html and no new-booking path assigns it; create-booking
     defaults a missing count to 1. Is anything else setting it?
  b. "Bags: 4" is vehicle capacity, not passenger input. Correct?
  c. The stored label is Google formatted_address via autocomplete.js
     selectSuggestion -> input value -> booking.pickup -> pickup_location.
  d. Server-authoritative curated label: create-booking (and the pending-edit
     writer path) writes "<curated name> — <address>" when the quote's
     canonical place_id matches a curated entry. Is the canonical place_id
     reliably available at that point for both create and edit, and does this
     interact badly with the token/intentHash contract or the edit card's
     "stored label round-trips byte for byte" rule?
  e. Google policy: we store place_ids + our own name/address text only (no
     Google coordinates/content in the data file), curated rows are visually
     separate from Google rows, and Google rows keep their attribution. Any
     Places/Autocomplete terms problem with pinning our own results above
     Google predictions and de-duplicating by place_id?
  f. One shared data file (data/curated-places.json) for browser + functions
     via netlify.toml included_files — any bundling or caching pitfall,
     including the service-worker bump rules?
  g. Curated place_ids must be the canonical ids the quote resolver returns;
     they should join the rollout smoke matrix. Anything else needed?
  h. Making a missing passenger count a 400 on create — safe for stale tabs
     / old clients still holding the old page?

Answer with: GO / GO WITH CHANGES / NO-GO for Phase 1, then numbered findings
(severity, file:line evidence, proposed fix). No code yet — plan review only.
