# Booking-flow mockups

Design exploration only. **Nothing here is production code**, nothing here is
proposed for merge into the app, and no file outside this directory is touched by
this branch. Both mockups are self-contained: no build step, no network calls —
open either one in a browser and click through it. Vehicle photos and the Google
attribution logo are inline SVG placeholders so the files stay readable.

`docs/` is force-404'd by `netlify.toml`, so neither file is served by the site.

## The two explorations

| File | Scope | Status |
|---|---|---|
| `booking-flow-v6.html` | **Bounded.** A rearrangement of controls that already exist in production. | The plan of record. |
| `booking-flow-mockup.html` | **Flight-first.** The bounded rearrangement *plus* four new products. | Preserved for later; **not** a plan of record. |

## v6 — the bounded flow

Three steps, every control already in production:

1. **Where & When** — direction selector, Railway address search, MIA/FLL/PBI,
   date, time, then the map.
2. **Choose a Ride** — the existing carousel, with the same map element moved
   below it.
3. **Confirm & Pay → Your Ride** — summary, traveler, payment space, promotion
   and notes; the same screen then becomes status and edit tools.

Rules this version keeps:

- **The passenger's chosen pickup time is authoritative.** Nothing derives it.
- **Flight number is optional** and says exactly what it does: "We share it with
  your driver. Your pickup time stays exactly as you set it."
- No change to the quote contract is implied by anything on screen.

What changed is placement and styling, not behaviour: two screens merged into
one, a real Confirm step (production books straight from the vehicle screen), the
map moved rather than rebuilt, one accent colour per screen, larger borderless
rows, the price on the button, and the Terms/Sign-out pills moved into the flow
instead of floating over the Continue button.

## v5 — the flight-first exploration (preserved, not adopted)

Reviewed and set aside because it mixed the layout improvement above with four
separate new products, each of which needs its own decision:

- an entry screen of journey presets;
- Port of Miami and terminal-to-terminal routes;
- a Pickup/Destination route box with **inferred** direction, replacing the
  direction selector;
- flight-derived pickup timing with international buffers.

Two blockers are recorded rather than solved:

- **The quote contract supports one airport plus one address.**
  `backend/functions/quote-ride.js` allows exactly
  `['mode', 'airportCode', 'placeId', 'pickupAt', 'passengers']`. Port → MIA has
  two terminals; Port → hotel has no airport at all. Both need a contract change
  before they can be a screen.
- **The buffer question is unresolved.** `docs/flight-first-integration-plan.md`
  specifies 35–40 min post-landing plus 30 min for customs in one place and
  "45 min" in its own decision table. The buffer decides when a driver is
  committed, so it belongs with dispatch, not with a form.

`REVIEW-BRIEF.md` documents v5 in full, including a reading guide to its source
and the open questions.
