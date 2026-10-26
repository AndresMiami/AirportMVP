# Curated places + intake fixes — plan v1

Branch: `feature/curated-places-intake` · Status: **PLAN ONLY — no code until
Andres (and Codex) approve** · Author: Claude, 2026-10-26

## Why (field evidence, 2026-10-26)

First real private-client booking, return trip **LM-EFFA** (Sun Nov 1, 1:00 PM,
PortMiami → MIA), booked in-app by an older couple during onboarding:

1. Typing "Virgin voyage" ranked a generic result and then **Virgin Voyages,
   South Pine Island Rd, Plantation** (the corporate office) above
   **Terminal V, 718 N Cruise Blvd**. Every row looks the same (text + pin).
2. The booking stored the pickup as **"Miami, FL 33132, USA"**.
3. Passengers came through as **1 for a party of 2**.
4. The driver card shows FROM/TO as text only (no map).

## Root causes found in the code (verified, not guessed)

- **Passenger count is never asked.** `indexMVP.html` initializes
  `state.passengers: 1` and no new-booking code path ever assigns it; the
  submit snapshot sends that 1 (`submitState.passengers`), and create-booking
  accepts it (`|| 1`). Every new booking since the account gate is 1
  passenger unless edited. The pending-edit card *does* have a passenger
  control, so edits work and creates don't.
- **"Bags: 4" was not real data.** `bags` comes from the vehicle's capacity
  (`config.capacity.bags`), not from the passenger. The UI collects no bag
  count (this matches the recorded quote-service decision: bags dormant).
- **The stored label is Google's `formatted_address`.** `autocomplete.js`
  `selectSuggestion` sets `displayName = formatted_address`, and the input
  value becomes that string; create-booking stores the client text verbatim
  (`booking.pickup` → `pickup_location`). For a terminal Google can return
  only "Miami, FL 33132, USA", and that is what we saved.
- **Driver navigation uses that same text.** `driver.html` hands
  `b.pickup_location` / `b.dropoff_location` to Google Maps as the
  destination, so a bare zip label also degrades the driver's handoff.
- **Ranking is Google's alone.** `renderSuggestions` prints Google's
  predictions in order; nothing of ours sits ahead of them.

Already on our side: `bookings.canonical_place_id` exists (migration 017) and
the quote service resolves `place_id` server-side to one canonical identity.

## Order of operations (simple → complex; one PR per phase)

| Phase | What | DB change | Pricing change |
|---|---|---|---|
| **1** | Passenger count step · curated places list · curated-first search · resolved name carried to booking + driver | none | none |
| 2 | "Cruise Port" trip type (port ↔ airport only) | none | none |
| 3 | Airline → terminal on airport trips | decide then (likely migration 022) | none |
| 4 | Driver card route map (A/B pins) | none | none |
| 5 | SMS status messages — **reopens recorded decision 8 ("never SMS")**; own plan, carrier registration, opt-in column | yes | none |

Non-goals for every phase: voice/conversational booking, any payment
collection or fare custody, any pricing-logic change.
Hotel ↔ port (no airport) is **out** until a separate pricing decision.

---

## Phase 1 — detailed scope (the PR to review first)

### 1A. Passenger count is a deliberate step

- Add a clearly labeled **"How many travelers?"** control to the booking flow
  (big −/+ stepper, starts **unset**, not 1). Booking cannot continue until a
  number is chosen. Placement: in the When → Vehicle transition, before the
  vehicle carousel, because the count drives capacity (vehicles that can't
  seat the party are disabled, using the existing capacity data).
- The count is part of the quote intent (`passengers` is already one of the
  seven committed intent facts), so changing it re-quotes through the
  existing flow — no pricing-logic change, the engine already reads it.
- Show it prominently: booking summary, passenger modal confirmation, trip
  sheet, and the driver card ("👥 2 travelers").
- Server: create-booking keeps its 1..12 validation; we **remove the silent
  `|| 1` default for creates** so a missing count is a 400, not a fake 1
  (open question Q3 — confirm this tightening).

### 1B. Curated places list (editable data file)

- One file: **`data/curated-places.json`**, read by the browser (static fetch,
  precached) and by Netlify functions (`require`, bundled via
  `included_files`). One source, so browser and server never disagree.
- Entries (Phase 1 uses cruise terminals + airports; airlines are stored now
  but only used in Phase 3):
  ```json
  {
    "version": 1,
    "places": [{
      "id": "pom-terminal-v",
      "kind": "cruise_terminal",
      "name": "PortMiami Terminal V",
      "subtitle": "Virgin Voyages",
      "address": "718 N Cruise Blvd, Miami, FL 33132",
      "placeId": "<canonical Google place_id — verified in smoke>",
      "lines": ["virgin"],
      "keywords": ["virgin", "virgin voyages", "terminal v", "portmiami", "cruise"],
      "badge": { "label": "Virgin", "color": "#CC0000" }
    }],
    "cruiseLines": [{ "key": "virgin", "name": "Virgin Voyages", "badgeColor": "#CC0000" }],
    "airlines": [{ "airport": "MIA", "code": "AA", "name": "American", "terminal": "North · Concourse D" }]
  }
  ```
- Coverage: PortMiami terminals for Virgin, Carnival, Royal Caribbean,
  Norwegian, Celebrity, MSC, Disney; MIA and FLL. Terminal-to-line mapping
  and addresses are **operational facts Andres confirms** before merge
  (lines move terminals; Claude will draft, not assert).
- **Google policy boundary:** we store the `place_id` (Google allows indefinite
  place-ID storage) and **our own** name/address text. We do **not** store
  Google coordinates or Google-returned content in the file; coordinates come
  live from Place Details at selection time, exactly as today.
- Every `placeId` must survive the quote service's resolver (Google may return
  a *replacement* id — the file must hold the canonical one). Add the curated
  ids to the rollout smoke matrix, same lesson as the airport-id NOT_FOUND
  finding (2026-08-21).

### 1C. Curated-first address search

- New pure module **`js/curated-places.js`**: `matchCurated(query, places)`
  → ranked curated hits (keyword / name prefix, accent- and case-insensitive,
  min 3 chars, max 3 hits). Pure, so it is unit-tested directly.
- `autocomplete.js` renders curated hits **pinned above** Google predictions,
  instantly (no network), and still fetches Google below them.
- Curated rows look different on purpose: brand badge + bold name +
  "PortMiami · Terminal V" subtitle, and a small "LinkMia pick" marker.
  Google rows keep their current look and the "Powered by Google" area stays
  with them only (keeps our content and Google's clearly separated —
  `google-policy-readiness.test.js` gets a pin for that).
- Google rows that duplicate a curated place (same place_id) are dropped, so
  the terminal never appears twice.
- Selecting a curated row: input shows the curated name; we call the existing
  Place Details path for live coordinates; the quote uses the curated
  canonical `placeId`.
- Ranking guarantee (tested): for "virgin", "virgin voyage", "virgin
  voyages", "terminal v" → Terminal V is row 1; the Plantation office and
  Virginia Key/Gardens are never above it.

### 1D. The resolved name reaches the booking and the driver

- **Server-authoritative label:** in create-booking (and the pending-edit
  writer path), when the quote's canonical place_id matches a curated entry,
  the server writes `"<name> — <address>"` (e.g. *"PortMiami Terminal V
  (Virgin Voyages) — 718 N Cruise Blvd, Miami, FL 33132"*) into
  `pickup_location`/`dropoff_location`, ignoring the client's text. A client
  can't spoof a curated name onto a different place.
- Keeping the street address in the label keeps the driver's Google Maps
  handoff working (it navigates by that text today).
- Non-curated places: unchanged in Phase 1 (the bare-zip fallback is a Google
  formatted_address problem; the open address-storage question stays on its
  own track). Q4 asks whether to also improve that now.
- Displays: trip page, trip sheet, driver card, Telegram doorbell all read
  `pickup_location`, so they inherit the name with no extra code.

### 1E. Release mechanics

- Service-worker bump to the next unused pair (both caches together, history
  line appended); precache `data/curated-places.json` and
  `js/curated-places.js` at the exact versioned URLs the page requests.
- No migration. No change to `ride-quote.js` / `ride-rate-card.js`.

### Phase 1 tests (new + existing)

- `tests/curated-places-ranking.test.js` — the LM-EFFA queries above;
  Plantation-type and Virginia results never outrank Terminal V; dedupe by
  place_id; no curated hit under 3 chars; data-file schema validation
  (every entry has id/name/address/placeId/badge; unique ids/placeIds).
- `tests/curated-label-server.test.js` — create-booking mocked per the repo
  pattern: curated place_id → curated label stored; client-supplied fake
  curated name on a non-curated place_id → client text not upgraded.
- `tests/passenger-count-step.test.js` — the flow blocks until a count is
  chosen; the chosen count reaches the submit snapshot and the quote intent;
  create without passengers → 400.
- Every existing `tests/*.test.js` still passes; inline-script `node --check`.

### Phase 1 acceptance (LM-EFFA re-run on a Deploy Preview)

Typing "Virgin" shows **PortMiami Terminal V** first with the Virgin badge;
selecting it books a ride whose stored and displayed pickup is
**"PortMiami Terminal V (Virgin Voyages) — 718 N Cruise Blvd…"** on the trip
page and the driver card; the party of 2 is chosen explicitly and shows as
2 everywhere.

---

## Phases 2–5 (outline only — each gets its own short plan before code)

- **Phase 2 — Cruise Port button.** Third big button next to "Going to
  Airport" / "Arriving at Airport". Flow: cruise-line card grid → terminal
  card → direction + airport. Under the hood it is the existing airport
  mode with a curated place as the address end, so pricing is untouched.
  LM-EFFA = Cruise Port → Virgin → Terminal V → to MIA.
- **Phase 3 — Airline → terminal.** After the airport, airline cards
  resolve terminal/concourse for passenger summary and driver. Storage
  decision then (likely migration 022 adding columns + writer RPC update,
  run by Andres via runbook), possibly tied to the flight fields that
  already exist.
- **Phase 4 — Driver card map.** Small Maps JS map with A/B pins above
  Accept, using the existing direct loader and the browser key (driver
  scope added to that key's referrer restrictions); loaded lazily per card
  to keep map loads (cost) bounded.
- **Phase 5 — SMS.** Reverses decision 8; needs Andres's explicit reversal,
  provider choice, A2P 10DLC registration (weeks), opt-in consent column +
  ledger channel migration, transactional-only copy. Planned last.

## Open questions (answer before Phase 1 code)

- **Q1.** Terminal ↔ cruise line list: OK for Claude to draft it from public
  PortMiami info for Andres to correct, or will Andres supply it?
- **Q2.** Where should the travelers step sit — before the vehicle carousel
  (proposed) or inside "Who's traveling"?
- **Q3.** OK to make a missing passenger count a 400 on create (removing the
  silent default of 1)?
- **Q4.** Phase 1 fixes curated places only. Should non-curated addresses
  also stop storing a bare "City, FL zip" label (e.g. show Google's place name
  when it has one)? That touches the open address-storage question, so the
  default is "not now".
- **Q5.** "LinkMia pick" marker wording on curated rows — keep or drop?
