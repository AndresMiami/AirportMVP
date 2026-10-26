# Curated places + intake fixes — plan v2

Branch: `feature/curated-places-intake` · Status: **PLAN ONLY — no code until
Andres approves** · Author: Claude · v1 2026-10-26 (dbc6243) · v2 2026-10-26
applies Codex review relay seq:0253 #1–#9 and Andres's scope ruling on #10.

## Why (field evidence, 2026-10-26)

First real private-client booking, return trip **LM-EFFA** (Sun Nov 1, 1:00 PM,
PortMiami → MIA), booked in-app by an older couple during onboarding:

1. Typing "Virgin voyage" ranked a generic result and then **Virgin Voyages,
   South Pine Island Rd, Plantation** (the corporate office) above
   **Terminal V, 718 N Cruise Blvd**. Every row looks the same (text + pin).
2. The booking stored the pickup as **"Miami, FL 33132, USA"**.
3. Passengers came through as **1 for a party of 2**.
4. The driver card shows FROM/TO as text only (no map).

## Root causes (verified by Claude, confirmed by Codex seq:0253 #3–#5)

- **Passenger count is never asked.** `state.passengers` starts at 1
  (`indexMVP.html:972`); the quote reads it (`:2825`), the submit snapshot
  copies it (`:4674`), the payload adds its own `|| 1` (`:4802`), and no
  new-booking path assigns it. The server's `parseInt(...) || 1`
  (`create-booking.js:236`) also turns 0/invalid into 1 and truncates `2.5`
  or `'2abc'`.
- **"Bags: 4" is vehicle capacity, not luggage input** (`indexMVP.html:2717`,
  `:2725`, `:2732`, submitted `:4804`). The confirmation summary also shows
  vehicle *capacity* passengers (`:5311`, rendered `:5375`), not the party.
- **The stored label is Google's `formatted_address`** (`autocomplete.js:320`,
  `:359`) → input → `booking.pickup` → `pickup_location`
  (`create-booking.js:231`, `:579`). For a terminal that can be just
  "Miami, FL 33132, USA".
- **Driver navigation uses that same text** (`driver.html:1175`, `:1411`).
- **Ranking is Google's alone** (`autocomplete.js:210` renders predictions in
  order; loading/result/error share one container `:181`–`:218`).

## Order of operations (simple → complex)

Ruling (Andres, this chat, 2026-10-26 — controls over any other chat's
summary): Phase 1 as planned; Cruise Port = **port ↔ airport only for now**;
**SMS last, provider not decided**. Each phase is reviewed as a diff in chat
before any PR; the table is sequencing, not permission to open PRs.

| Phase | What | DB change | Pricing change |
|---|---|---|---|
| **1** | Passenger count step · curated places list · curated-first search · verified place name carried to booking + driver | none | none |
| 2 | "Cruise Port" trip type (port ↔ airport only) | none | none |
| 3 | Airline → terminal on airport trips | decide then (likely migration 022) | none |
| 4 | Driver card route map (A/B pins) | none | none |
| 5 | SMS status messages — reopens recorded decision 8 ("never SMS"); provider, consent and carrier registration decided in its own plan | yes | none |

Non-goals for every phase: voice/conversational booking, any payment
collection or fare custody, any pricing-logic change. Hotel ↔ port and other
non-airport endpoints are **out** until a separate pricing/feasibility
decision (the engine prices airport ↔ address only).

---

## Phase 1 — detailed scope

### 1A. Passenger count is a deliberate step (seq:0253 #3, #4)

- **UI:** a clearly labeled **"How many travelers?"** stepper (big −/+),
  starting **unset**. The flow can't continue until a number is chosen.
  Placed right before the vehicle carousel; vehicles that can't seat the
  party are disabled using the existing capacity data. Changing the count
  after quoting re-quotes through the existing flow (`passengers` is already
  a committed intent fact; the engine is unchanged).
- **Client contract:** remove the new-client `|| 1` fallback (`:4802`); the
  snapshot carries the chosen integer or the submit refuses with a visible,
  recoverable message.
- **Server contract (create):** strict integer, 1..12. Accept a JSON integer
  only (also a digit-only string from legacy clients), no truncation, no
  default. Missing / null / 0 / negative / fractional / malformed / > 12 →
  400 with a user-facing message; the form stays filled.
- **Stale pages (documented limitation):** a tab still holding the old page
  sends `passengers: 1` and keeps passing — the server can't tell a stale 1
  from a real 1. The service-worker bump delivers the new page on next load;
  no client-version gate in Phase 1 (could be proposed separately).
- **Displays:** party size shown on its own, prominently ("👥 2 travelers"),
  in the booking summary, trip sheet and driver card. The confirmation
  summary's "Capacity" line stays clearly labeled as the vehicle's capacity,
  never presented as the party.
- Bags stay capacity-only; no luggage input or luggage pricing in Phase 1.

### 1B. Curated places list (seq:0253 #7, #8)

- One data file, **`data/curated-places.json`**, with a `version` and a
  `verifiedAt` date per entry. Read by the browser (versioned static URL) and
  by the functions (static `require`, explicitly listed in `netlify.toml`
  `included_files`; both the create **and** edit function bundles are checked
  to load it).
- **Server authority, not lockstep:** an open tab or cached JSON can lag a
  new deployment. The server's copy always decides the stored label; the
  browser copy only drives suggestions. Registry schema and label length are
  validated at load; an invalid registry disables curated labeling (falls
  back to today's behavior) rather than failing bookings.
- Entry shape (airlines stored now, used in Phase 3):
  ```json
  {
    "version": 1,
    "places": [{
      "id": "pom-terminal-v",
      "kind": "cruise_terminal",
      "name": "PortMiami Terminal V",
      "subtitle": "Virgin Voyages",
      "address": "718 N Cruise Blvd, Miami, FL 33132",
      "placeId": "<canonical id from the resolver — never typed by hand>",
      "lines": ["virgin"],
      "keywords": ["virgin", "virgin voyages", "terminal v", "portmiami"],
      "badge": { "label": "Virgin", "color": "#CC0000" },
      "source": "<where name/address/line mapping came from>",
      "verifiedAt": "2026-10-xx"
    }],
    "cruiseLines": [{ "key": "virgin", "name": "Virgin Voyages", "badgeColor": "#CC0000" }],
    "airlines": [{ "airport": "MIA", "code": "AA", "name": "American", "terminal": "North · Concourse D" }]
  }
  ```
- **Provenance:** names, addresses and line→terminal mappings come from an
  independent source recorded per entry; Claude drafts, Andres confirms. No
  invented IDs or coordinates. A line that uses several terminals lists them
  all and the passenger chooses — never a falsely universal terminal.
- **Place IDs:** each one is run through the existing quote resolver
  (`lib/place-identity.js`); the stored ID is the **canonical** one it
  returns, and the physical terminal/entrance is checked, not just a 200.
  All curated IDs join the rollout smoke matrix. A refresh procedure is
  documented; a retired/replaced ID simply stops matching (the booking falls
  back to today's label behavior), never blocks a booking.
- **Google boundary:** the file holds place IDs plus **our own** name/address
  text; no Google coordinates or Google-returned content.

### 1C. Curated-first address search (seq:0253 #6)

- New pure module **`js/curated-places.js`**: `matchCurated(query, places)`
  → ranked hits (keyword / name prefix, case- and accent-insensitive,
  ≥ 3 characters, ≤ 3 hits).
- `autocomplete.js` renders **two separate sections**: curated (instant, no
  network) above Google. Loading, empty and error states belong to the Google
  section only — a slow, empty or failed Google response never erases the
  curated cards.
- Preserved behavior: request/selection sequence guards, keyboard navigation
  across both sections with a correct index mapping, validation cleared when
  the passenger types again, HTML escaping of every rendered string.
- Late registry load: if the JSON arrives after typing started, the curated
  section re-renders for the current query; if it never loads, search works
  exactly as today.
- Curated rows look different on purpose: brand badge + bold name +
  "PortMiami · Terminal V" subtitle. Google rows keep their current look and
  their attribution area. Google rows with the same place_id as a curated
  hit are dropped (no duplicates) — subject to the policy gate in 1E.
- Selecting a curated row: the input shows the curated name; the existing
  Place Details path still runs for live coordinates, and **every attribution
  Details returns is still displayed** (`autocomplete.js:308`, `:368`), even
  though the visible label is ours. Details failure keeps today's safe
  fallback (prediction/curated text, null coordinates).
- **Airport entries** don't become arbitrary addresses: selecting MIA/FLL
  enters the existing airport identity flow (airport code), not the address
  slot.

### 1D. The verified place name reaches the booking and the driver (seq:0253 #1, #2, #5)

- **Verified only:** the server applies a curated label **only when the
  quote token classified as `verified`** (`create-booking.js:478`; the edit
  path's equivalent in `update-pending-booking.js`) and its canonical
  place_id matches a curated entry. Unverified, no-token, mismatched-token
  and non-curated cases keep today's behavior exactly — client text is never
  upgraded to a curated name.
- **Right endpoint:** the label goes to `pickup_location` or
  `dropoff_location` according to `booking_mode`. The airport endpoint keeps
  using the airport-code registry.
- **Label format:** `"<name> (<subtitle>) — <address>"`, e.g. *"PortMiami
  Terminal V (Virgin Voyages) — 718 N Cruise Blvd, Miami, FL 33132"*. The
  street address stays in so the driver's Google Maps handoff keeps working.
- **Edits:** on an unchanged route the server-read stored labels are
  preserved byte for byte (matches `pending-edit-model.js:131`); the curated
  label applies only on create and on an actual route change. No incidental
  repair of old bookings' labels.
- **Never touched:** the raw request envelope, its digest, and the signed
  intent. The label is projected after classification, outside the intent
  fields, so the token contract is unchanged and no migration is needed (the
  RPCs already accept location strings).
- Trip page, trip sheet, driver card and Telegram doorbell all read
  `pickup_location`/`dropoff_location`, so they inherit the name.
- **Acceptance limit, stated plainly:** non-curated addresses can still
  store a bare "City, FL zip" label after Phase 1. That stays on the open
  address-storage track.

### 1E. Release mechanics and gates (seq:0253 #7, #9)

- Service-worker bump to the next unused pair (both caches together, history
  line appended, `service-worker.js:67`), with the exact versioned query
  strings the page requests (`:86`). JSON is network-first today (`:109`):
  test the real versioned URL and the offline fallback, not just the
  precache list.
- No migration. No change to `ride-quote.js` / `ride-rate-card.js`.
- **Open release gate — Google terms:** the mixed curated/Google list and
  place_id de-duplication are a sensible technical boundary, **not a policy
  clearance**. Before release, Andres (or counsel) reads the current official
  Places/Autocomplete terms
  (https://developers.google.com/maps/documentation/places/web-service/policies)
  and confirms. If dedup is a problem, curated rows simply sit above an
  undeduplicated Google list. Tests prove rendering, not compliance.

### Phase 1 tests

- **Ranking** (`tests/curated-places-ranking.test.js`): "virgin", "virgin
  voyage", "virgin voyages", "terminal v" → Terminal V first; the Plantation
  office and Virginia Key/Gardens never above it; dedupe by place_id; nothing
  under 3 characters; registry schema (required fields, unique ids/placeIds,
  label length, provenance + verifiedAt present).
- **Autocomplete behavior**: curated section survives slow / empty / failed
  Google responses; late registry load re-renders; keyboard index mapping
  across sections; typing clears validation; escaping; curated selection
  keeps Details attributions; airport entries take the airport path; a quote
  replacement can't detach a terminal label from its place_id.
- **Server label** (create and edit, both booking modes): verified + curated
  → curated label on the right endpoint; mismatched token, no token,
  verify_failed, non-curated id → unchanged behavior; unchanged-route edit →
  stored labels byte for byte; route-change edit → curated label; invalid
  registry → today's behavior.
- **Passengers**: missing / null / 0 / negative / fractional / malformed /
  13 → 400 with message; 1..12 integers pass; a stale-page payload of 1
  passes (documented); changing the count after quoting re-quotes; vehicles
  too small for the party are disabled; summary shows party separately from
  capacity.
- **Bundling**: the packaged create and edit functions load the registry.
- Every existing `tests/*.test.js` still passes; inline-script `node --check`.

### Phase 1 acceptance (LM-EFFA re-run on a Deploy Preview)

Typing "Virgin" shows **PortMiami Terminal V** first with the Virgin badge;
choosing it and booking stores and shows **"PortMiami Terminal V (Virgin
Voyages) — 718 N Cruise Blvd…"** on the trip page and driver card; the party
of 2 is chosen explicitly and shows as 2 everywhere; Google attributions
still display. Release still waits on the Google-terms gate (1E).

---

## Phases 2–5 (outline only — each gets its own short plan before code)

- **Phase 2 — Cruise Port button (port ↔ airport only).** Third big button
  next to "Going to Airport" / "Arriving at Airport": cruise-line cards →
  terminal card (choice when a line has several) → direction + airport.
  Under the hood it is the existing airport mode with a curated place as the
  address end, so pricing is untouched. LM-EFFA = Cruise Port → Virgin →
  Terminal V → to MIA. Hotel ↔ port needs its own pricing decision first.
- **Phase 3 — Airline → terminal.** After the airport, airline cards resolve
  terminal/concourse for the passenger summary and the driver. Storage
  decided then (likely migration 022 + writer RPC update, run by Andres via
  runbook), possibly tied to the existing flight fields.
- **Phase 4 — Driver card map.** Small Maps JS map with A/B pins above
  Accept, via the existing direct loader and browser key (driver scope added
  to its referrer restrictions), loaded lazily per card to bound map cost.
  Can proceed independently after Phase 1.
- **Phase 5 — SMS.** Reverses decision 8 and needs Andres's explicit
  reversal; provider not decided; opt-in consent column + ledger channel
  migration, carrier registration (weeks), transactional-only copy. Last.

## Open questions for Andres (before Phase 1 code)

- **Q1.** Terminal ↔ cruise line list: Claude drafts from a public source
  with provenance, Andres corrects? (default: yes)
- **Q2.** Travelers step right before the vehicle carousel? (default: yes)
- **Q3.** Strict 1..12 integer, 400 on anything else, stale-page 1 accepted as
  a documented limitation? (default: yes)
- **Q4.** Non-curated addresses keep today's label in Phase 1? (default: yes)
- **Q5.** A "LinkMia pick" marker on curated rows — keep or drop?
- **Q6.** Who reads the Google terms for the 1E gate — Andres, or counsel?
