# LinkMia booking flow — design critique brief

**What this is:** a design critique request, grounded in reading the code. The
attached `booking-flow-mockup.html` is a self-contained interactive prototype of
a redesigned passenger booking journey. Read the source to understand the design,
then critique the **design** — the flow, the decisions asked of the passenger, the
information hierarchy, the honesty of the copy. This is not a request for a
production code review; nothing here is production code and none of it is
proposed for merge as-is.

**Status: design exploration only.** No production file has been changed. The
mockup lives under `docs/mockups/` so it is not served by the site.

---

## How to read the source

The file is one HTML document: a page wrapper, then a `.phone` block that is the
prototype, then design notes. No build step, no network calls — open it in a
browser and click through. Vehicle photos and the Google attribution logo are
inline SVG placeholders so the file stays readable; the rest is byte-identical to
what was reviewed on screen.

The design is legible from five places in the source:

| Where | What it tells you |
|---|---|
| `.phone { --primary … }` | The design system. Every token is copied from the production `css/style.css`. |
| `var st = { … }` | **The entire data model of the journey.** Everything the passenger can decide is a field here. If a field looks unnecessary, that is a design finding. |
| `function refresh()` | The single render pass. Every visible string is derived here, so you can read the whole screen-state machine in one function. |
| `function trip()` | The routing rule: what combination of endpoints is a valid trip. |
| `focusField()` / `blurField()` | The picker mode — the only modal state on the main screen. |
| `startArrival/Departure/Other` | The entry presets. Note they only set `st` fields; nothing reads `st.entry` to make a decision. |

Screens are `#s0` (entry), `#s1` (where & when), `#s2` (choose a ride),
`#s3` (confirm, which becomes "your ride" after booking).

---

## Context

Scheduled airport transfers in South Florida. Owner is currently admin and the
only driver. Rides are **always scheduled ahead** — this is not a hail-now
product. Payment is cash or Zelle to the driver. Production today is
`indexMVP.html` (booking, account-gated), `trip.html`, `driver.html`, and
Netlify functions over a default-deny Supabase.

The mockup is drawn to the production app's measured dimensions: 361-pt booking
card, 313-pt content column, 229-pt carousel cards in a 220-pt frame, the real
bottom-sheet chrome, the real trip-page card and stepper.

---

## The design decisions, and the reasoning behind each

1. **Entry screen with three cards** — "I'm landing", "I'm flying out", "Another
   kind of ride". They are **presets, not modes**: each pre-fills the route box
   and opens the right field, then gets out of the way. A wrong tap costs one
   correction, not a trip back.
2. **Direction tabs deleted.** "Going to / Arriving at Airport" is inferred from
   which side of the route box the terminal lands on. Rationale: the app already
   has the answer, so asking is asking twice.
3. **A Pickup / Destination route box** replaces the separate address step and
   airport grid. Pickup prefills with current location.
4. **Saved places are MIA, FLL, PBI and the Port of Miami — no recents feed.**
   Rationale: rides are scheduled and infrequent, so a recents list is mostly
   noise; a short curated list of terminals is what people actually tap.
5. **Terminal-to-terminal is a valid trip** (Port of Miami → MIA). A trip must
   touch at least one terminal and cannot start and end at the same one.
6. **On arrivals, the flight replaces the time question.** "Pickup time" becomes
   "Your flight"; the passenger gives flight number, landing time and
   domestic/international, and the app states the derived answer ("Driver at the
   curb 5:15 PM"). This works with **no flight feed at all**, which is the point —
   it is shippable before any integration exists.
7. **Decisions redistributed.** Choose-a-ride is the carousel plus one "who and
   how you pay" row. Promotion and the booking note moved to Confirm. The note
   *for the driver* moved to Your Ride, where it is actually written. The price
   rides on the button, so the total row is gone.
8. **Quiet pass.** One accent colour per screen, white-on-gray selections, 56-pt
   borderless rows, screen titles instead of progress dots.

---

## Where this conflicts with the existing plan in the repo

`docs/flight-first-integration-plan.md` (v1.0, Dec 2024) reached the same core
conclusion — flight as the organizing principle for arrivals — but differs on two
substantive points. **Please arbitrate; the mockup may well be wrong.**

**a) Buffer size.** The plan specifies a 35–40 min post-landing buffer plus a
30 min international customs allowance, while its own decision table records
"international buffer: 45 min". The mockup uses 30 min domestic / 45 min
international, which is more aggressive than either reading. For a premium
transfer where the driver waits rather than circling, which is right — and should
the buffer differ for MIA specifically, where immigration queues are long?

**b) Departure timing.** The plan derives the departure pickup as
`flight time − 150 min`. The mockup does **not**: it treats the flight as nearly
irrelevant for departures and collects the flight number only as an optional
courtesy for the driver, leaving the passenger to choose their own pickup time.
The plan is arguably right — a passenger on a 6 AM flight genuinely does not know
whether to leave at 3:30 or 4:00, and "we'll get you there 2.5 hours early" is a
real service. Counter-argument: a derived departure time is a promise about
traffic and TSA queues that LinkMia cannot verify, whereas an arrival buffer only
promises when the driver shows up. Which reasoning holds?

The plan also contemplates cruise handling (`+60 min / −180 min` from dock time),
which aligns with the Port of Miami work in the mockup.

---

## Design questions

**Flow and sequencing**

1. On an arrival, the order is airport → destination → flight. The flight cannot
   come first because "find your flight to ___" needs the airport. Is
   destination-before-flight right, or does asking for the flight while it is
   front-of-mind beat keeping the route box visually complete?
2. Proposed but not built: move the landing **date** inside the flight sheet for
   arrivals, since a flight implies its date. The date row would return for
   departures and when the "I don't know my flight yet" escape fires. Does that
   conditional appearance help or confuse?
3. Proposed but not built: add **Home** to saved places. On an arrival the
   destination is almost always home or a hotel, and it makes a repeat booking
   four taps. Is a curated "Home" meaningfully different from the recents feed
   that was deliberately removed, or is that a distinction without a difference?

**The decisions asked of the passenger**

4. Read `var st` and judge whether any field is a decision the app should be
   making instead. `st.flight.intl` is the one we are least sure about — it is
   derivable from the origin airport once a feed exists, but is a manual toggle
   acceptable in the interim or does it read as busywork?
5. The vehicle screen now asks only two things (which vehicle, and one combined
   who/payment row). Is anything important now buried that should not be?
6. Cancel was demoted to a text link on Your Ride, below the trip code. Is that
   too far?

**Copy and honesty**

7. The copy deliberately says "we share your flight with your driver" and never
   "we'll adjust your pickup automatically", because the second sentence moves a
   committed driver's schedule and the machinery does not exist yet. Is the
   current wording clear enough about what the passenger is getting?
8. There is no ETA or trip-duration anywhere, by policy. Does the flow feel like
   it is missing something a passenger needs, or does the pickup time carry it?

**Structure**

9. The entry cards are presets that only write `st` fields — nothing downstream
   reads `st.entry`. Is that separation actually clean in the code, or does the
   auto-focus chaining in `pickSaved()` smuggle mode-like behaviour back in?
10. `refresh()` is a single render pass over the whole app. Good for a prototype;
    is the design it encodes still legible if this were split into real
    components, or does the design depend on global re-render to stay coherent?

---

## Deliberate omissions — please do not treat as oversights

- No ETA or trip-duration display anywhere (open Google storage/retention
  decision; duration was removed from production by an earlier change).
- No "we adjust automatically" copy.
- Payment reads "Cash or Zelle — pay your driver at pickup" everywhere.
- Google-sourced results stay on the white card with the official logo footer;
  LinkMia's own saved places are dark.
- Airport→airport is allowed because the screen cannot distinguish it from
  Port→MIA. Whether it is sellable is a rate-card question, not a UI one.

---

## Two findings from the codebase, unrelated to the redesign

- The vehicle photos contradict the catalog: the SUV image is baked with
  "Acura MDX · 5 · 5 bags" and the Tesla with "3 bags", while bookings store
  Cadillac Escalade 7/8 and Tesla Model Y 4/4.
- On a 393-pt phone the fixed Terms/Privacy and Sign-out pills float over the
  Continue button until you scroll. The mockup moves them into the flow.

---

## Secondary: implementation implications (only if useful to the critique)

Noted because a design that cannot be built is not a good design — but these are
not the focus of this review.

- A quote is keyed to one airport code plus one address. Port→MIA has two
  terminals; Port→hotel has no airport. The key would need to become "an origin
  and a destination, either of which may be a terminal".
- The buffer decides when a driver is committed, so it looks like a pricing and
  dispatch rule rather than a display value.
- Flight-driven rescheduling is an edit to a confirmed booking plus a driver
  push; a multi-hour delay is a release event.
- Route-based flight lookup needs a schedules feed; flight-number lookup is a
  single call. Flight-number-first is the assumed sequencing.
