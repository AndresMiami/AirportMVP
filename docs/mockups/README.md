# Booking-flow mockups

Design exploration only. **Nothing here is production code**, nothing here is
proposed for merge into the app, and no file outside this directory is touched by
this branch. Both mockups are self-contained: no build step, no network calls —
open either one in a browser and click through it. Vehicle photos and the Google
attribution logo are inline SVG placeholders so the files stay readable.

`docs/` is force-404'd by `netlify.toml`, so neither file is served by the site.

## The three explorations

| File | Scope | Status |
|---|---|---|
| `booking-flow-v7.html` | **Route-inferred.** The bounded flow, with the journey derived from where the airport sits and a contextual flight finder. Still exactly one supported airport. | Current direction. |
| `booking-flow-v6.html` | **Bounded.** A rearrangement of controls that already exist in production, keeping the direction selector. | Superseded by v7; the safe fallback. |
| `booking-flow-mockup.html` | **Flight-first.** The bounded rearrangement *plus* four new products. | Preserved for later; **not** a plan of record. |

## v7 — the route answers the direction question

The passenger chooses a Pickup and a Destination. Where the airport appears
decides the journey, so nobody is asked "are you arriving or departing":

| Route | Airport is | Journey | Mode sent to the server | v1 |
|---|---|---|---|---|
| MIA → Fontainebleau | Pickup | Arrival | `pickup` | enabled |
| Fontainebleau → MIA | Destination | Departure | `dropoff` | enabled |
| Hotel → Restaurant | neither | Scheduled ride | — | refused |
| MIA → FLL | both | Airport transfer | — | refused |

Four rules hold this together:

- **Airports are recognised by identity, not by string.** `AIRPORTS` is a map of
  verified codes; an endpoint counts as an airport only when its `kind` is
  `'airport'` and its code is in that map. A place literally named "Miami
  International Airport" arriving from address search is *not* an airport — this
  is asserted in the verification pass.
- **Exactly one supported airport**, because a quote takes one airport code plus
  one place id. Zero and two are both refused with honest copy. Only
  `routeState()` has to loosen when Route Intent v2 lands; no passenger screen
  changes.
- **The flight finder is a contextual tool, not a step.** It appears only for
  arrivals and opens itself once the route is complete — never over a half-filled
  form. Three ways in: flight number, route (flying from + the arrival date
  already on screen), or "choose a pickup time instead".
- **"Recommended" is load-bearing.** The flight service says when the aircraft
  lands; `BUFFER` decides when the chauffeur should be at the curb, and the
  passenger can override it while keeping the flight attached. Domestic versus
  international is derived from the flight's origin, never asked — San Juan
  counts as domestic because there is no immigration queue.

Departures reveal an optional flight number only. A derived departure time needs
drive time, airport lead time, traffic and an operational buffer, so the copy
promises nothing: "We share it with your driver. Your pickup time stays exactly
as you set it."

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
  committed, so it belongs with dispatch, not with a form. v7 carries the
  question in one named constant (`BUFFER`, 30/45) marked as a placeholder, so
  the open decision is visible in the code rather than buried in copy.

Two further things v7 shows but does not act on:

- **Live flight status is displayed, never acted upon.** A delayed flight shows
  its delay; nothing reschedules a committed driver, and no copy claims it does.
  Acting on it is an edit to a confirmed booking plus a driver push, and a
  multi-hour delay is a release event.
- **The Route tab needs a schedules feed**, which costs more than a
  flight-number lookup. Shipping the flight-number tab first leaves Route as a
  later upgrade to the same sheet.

`REVIEW-BRIEF.md` documents v5 in full, including a reading guide to its source
and the open questions.
