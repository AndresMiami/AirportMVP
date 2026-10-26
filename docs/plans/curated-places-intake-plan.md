# Rich address search — first PR plan (v5)

Branch: `feature/curated-places-intake` · Status: **PLAN ONLY — no code until
Andres approves** · Author: Claude · History: v1 dbc6243 · v2 2f5557b (Codex
seq:0253 #1–#9) · v3 d90f4c5 · v4 79b14b0 (seq:0260) · **v5 = first PR
re-scoped per Codex seq:0262** (passenger step removed; rich, image-supported
curated-first dropdown is the first PR).

**How we work:** Andres and Codex discuss strategy; Codex posts direction and
reviews one way to the relay (`~/Projects/linkmia-relay`); Claude responds
with feedback in the Claude chat, which Andres relays back. Andres approves
decision points and merges. This file records where the strategy has
converged. Mockup: `docs/plans/curated-dropdown-mockup.html`.

## Why (field evidence, 2026-10-26)

First real private-client booking, return trip **LM-EFFA** (Sun Nov 1, 1:00 PM,
PortMiami → MIA), booked in-app by an older couple: typing "Virgin voyage"
ranked a generic result and the **Virgin Voyages corporate office in
Plantation** above **Terminal V, 718 N Cruise Blvd**; every row looked the
same (pin + text); the pickup was stored as **"Miami, FL 33132, USA"**; the
driver card and navigation use that bare text.

## Settled decisions (Andres, via Codex seq:0262)

- **Passenger count: removed from this roadmap.** Default stays 1; existing
  behavior untouched (no mandatory step, no strict validation, no fallback
  removal). *Consequence to know, not to act on now:* driver card and
  doorbell keep showing "👥 1 of N" for every booking.
- **First PR = rich address search:** curated places shown first, visually
  self-explanatory with images, name carried through booking and driver
  views. Includes the minimum editable registry as a dependency.
- **Everything else waits** until this PR completes: airline → terminal,
  driver map, Cruise Port path, SMS, end-to-end. Not scaffolded here.
- Port ↔ airport only; no pricing, payment, or passenger changes.

## Root causes (verified; confirmed by Codex seq:0253, seq:0262)

- `autocomplete.js:210` renders Google predictions in order; `:240` renders
  uniform "📍 + text" rows; loading / results / error all share one
  container (`:181`–`:218`), so a Google failure wipes whatever is shown.
- Selection stores Google's `formatted_address` as the label (`:320`,
  `:359`); create-booking persists that client text (`create-booking.js:231`,
  `:579`); the driver card shows it (`driver.html:1175`) and navigates by it
  (`:1411`).
- The dropdown panel is **light** (white, `css/maps-autocomplete.css:13`)
  on the dark page, and the policy test pins the exact dark-gray Google logo
  asset, which is the variant for light backgrounds
  (`tests/google-policy-readiness.test.js:213`, `:217`).
- `bookings.canonical_place_id` exists (migration 017); the quote resolver
  returns the canonical id and already flags a replacement
  (`lib/place-identity.js:166` `substituted`).

---

## The first PR

### A. What the passenger sees (mockup: `curated-dropdown-mockup.html`)

Typing ≥ 3 characters opens the dropdown with **two sections**:

1. **"LinkMia places"** (instant, no network) — up to 3 curated rows:
   - 48×48 **image** (own photo of the terminal / airport), rounded 8px;
     if missing or failed to load, a **vector icon** (ship / plane) on the
     badge color.
   - **Name** bold ("PortMiami Terminal V"), **badge** in brand color
     ("Virgin"), **subtitle** ("PortMiami · Terminal V"), **address** in
     secondary text ("718 N Cruise Blvd, Miami, FL 33132").
   - Orange-gradient left stripe (`#FF9933 → #FF5733`) marks the section.
2. **"More results"** — Google predictions exactly as today (pin + text),
   followed by the Google Maps logo. Its own loading line ("Searching…"),
   its own quiet failure line ("More results unavailable right now"), never
   touching section 1. Google rows whose `place_id` equals a curated
   entry's are dropped (subject to the terms gate in F).

"No results found" appears only when both sections are empty. Keyboard:
one ordered list across both sections (ArrowUp/Down, Enter, Escape as
today); `role="listbox"` / `role="option"` / `aria-selected`; images are
decorative (`alt=""`) — the text carries meaning.

**Recommendation (not settled): keep the light dropdown panel.** It is
high-contrast on the dark page (iOS style), and a dark panel would require
Google's light logo variant and a re-pin of the policy test — a theme
change that belongs in its own PR. Curated rows get the brand/orange
accents inside the light panel.

Mobile: rows are 64px tall; the panel keeps `max-height: 300px` with
scrolling; with the keyboard up, 3 curated rows + the first Google rows fit
on an iPhone SE width (mockup checked at 375px).

### B. Registry (editable data file) — `data/curated-places.json`

```json
{
  "version": 1,
  "places": [{
    "id": "pom-terminal-v",
    "kind": "cruise_terminal",
    "name": "PortMiami Terminal V",
    "subtitle": "PortMiami · Terminal V",
    "address": "718 N Cruise Blvd, Miami, FL 33132",
    "placeId": "<canonical id from the resolver — never typed by hand>",
    "badge": { "label": "Virgin", "color": "#CC0000" },
    "image": "/images/places/pom-terminal-v.jpg",
    "keywords": ["virgin", "virgin voyages", "terminal v", "portmiami", "port miami", "cruise"],
    "source": "<where name/address/line mapping came from>",
    "verifiedAt": "2026-10-xx"
  }]
}
```

- **Contents for v1: only entries Andres can verify.** Terminal V (Virgin),
  MIA, FLL at minimum. Other PortMiami terminals are drafted in the PR
  description as a to-verify list and added only with `verifiedAt` set
  (lines move terminals; a line with several terminals gets one entry per
  terminal). Claude drafts, Andres confirms (Q1).
- **Place IDs:** run through the existing resolver; the stored id is the
  canonical one it returns; the physical entrance is checked, not just a
  200. All curated ids join the rollout smoke matrix. Refresh procedure:
  re-run the resolver, update `placeId` + `verifiedAt`, new commit.
- **No Google content in the file** (no coordinates, no Google photos, no
  Google text). Our own name/address text + Google place IDs only.
- Loaded in the browser by versioned URL (`/data/curated-places.json?v=1`,
  precached); loaded in functions by a **static `require`** (esbuild inlines
  JSON at build time — no runtime file read, so `included_files` is not
  needed; a packaging test proves the create AND edit functions load it).
  Server copy always decides stored labels; browser copy only drives
  suggestions. Invalid registry (schema/length) → curated features off,
  today's behavior, bookings unaffected.

### C. Images — sources and rights

- **Recommended: LinkMia's own photos.** Andres drives to these terminals;
  one phone photo per place, cropped square, ~96×96 px source (2× for
  48 px), JPEG ≤ 15 KB, stored at `images/places/<id>.jpg`. Clean rights,
  no attribution burden. Until a photo exists the icon fallback shows.
- **Alternative:** Wikimedia Commons photos under CC-BY / CC-BY-SA with a
  credit line in the Terms/Privacy attribution area; more work per image.
- **Not used:** Google Place Photos (cannot be stored or cached; billed per
  display); cruise-line **logos** (trademarks imply affiliation — the badge
  uses the line's *name* in text on a color, which is ours).
- Images are `loading="lazy"`, `alt=""`, with `onerror` → icon fallback.
  Not precached by the service worker (network, with the fallback).

### D. Ranking — `js/curated-places.js` (pure, unit-tested)

`matchCurated(query, registry)` → ≤ 3 hits, deterministic:

- Normalize: lowercase, strip accents, collapse spaces; ignore queries
  < 3 characters.
- Tokenize the query; a hit requires **every query token to prefix-match a
  distinct token** of a keyword or of the name. Direction matters:
  `"virgin"` matches keyword token `virgin`; `"virginia"` does **not**
  (`virgin` does not start with `virginia`) — so Virginia Key / Gardens
  never pin Terminal V. `"virgin voyage"` matches `virgin voyages`.
- Score: exact keyword 3 · keyword prefix 2 · name prefix 1; ties by
  registry order.
- Not a fuzzy search; misspellings fall through to Google as today.

### E. The name reaches the booking and the driver (trust chain)

- **Label text (ASCII, comma-separated — changed from v4's em dash):**
  `PortMiami Terminal V (Virgin Voyages), 718 N Cruise Blvd, Miami, FL 33132`.
  Keeps the street address so the driver's Google Maps handoff keeps
  working; comma form is what Maps parses best; ASCII avoids round-trip
  surprises in the edit path's byte-exact checks
  (`update-pending-booking.js:213`). 75 chars, well under the 500 limit.
- **Browser:** a curated row carries the registry `placeId`. Selection runs
  the existing Place Details call with that id for live coordinates and
  shows every returned attribution (`autocomplete.js:308`, `:368`), then
  puts the **curated label** in the input. The quote request sends that
  place id; the response echoes the canonical `quote.intent.placeId`. **If
  it differs from the registry id, the browser drops the curated label**
  and shows Google's formatted address — the name is never claimed for an
  id it does not match. Same rule binds the image: it is keyed by registry
  id, which is bound to that `placeId`.
- **Server (authoritative):** in create-booking, and in the pending-edit
  writer on an actual route change, when the token classified **`verified`**
  and its canonical place id equals a registry `placeId`, the server writes
  the registry label to the endpoint that `booking_mode` says is the address
  side, ignoring client text. Unverified / no-token / mismatched / non-
  curated → today's behavior exactly. Unchanged-route edits keep stored
  labels byte for byte. Request envelope, digest and signed intent are
  never touched; no migration (RPCs already take location strings).
- **Replaced vs retired ids:** resolver `substituted: true` → quote
  succeeds, label falls back to Google's address until the registry is
  refreshed. `places_not_found` → refused as today, form kept, passenger
  picks another live result. Never route by label; never bypass
  verification.
- Trip page, trip sheet, driver card and Telegram doorbell read
  `pickup_location` / `dropoff_location` — no changes there. **Driver map
  is NOT in this PR.**
- Acceptance limit: non-curated addresses keep today's label behavior.

### F. Release mechanics and gates

- Service-worker bump to the next unused pair (both caches together,
  history line appended, `service-worker.js:67`); precache the exact
  versioned URLs (`/js/curated-places.js?v=1`, `/data/curated-places.json?v=1`);
  test the versioned URL and the offline fallback (JSON is network-first,
  `:109`).
- `google-policy-readiness.test.js` gains pins: curated-only render shows
  **no** Google logo; mixed render shows exactly one logo, inside the Google
  section; curated rows never use Google row classes; a curated selection
  still renders every Details attribution.
- **Open gate — Google terms:** separate sections, our own text/images,
  place-ID storage only and dedup by place_id are a sound technical boundary,
  **not a clearance**. Andres (or counsel) reads the current Places /
  Autocomplete policies before release (Q4). If dedup is a problem, curated
  rows sit above an undeduplicated Google list (one-line change).
- No pricing, payment, passenger or migration changes.

### G. Files touched

| File | Change |
|---|---|
| `data/curated-places.json` | new registry |
| `js/curated-places.js` | new: loader, schema validation, `matchCurated` |
| `autocomplete.js` | two sections, unified item list, curated selection path, label guard |
| `css/maps-autocomplete.css` | curated row/section styles, image + icon fallback |
| `images/places/*.jpg` | own photos (as available) |
| `backend/functions/lib/curated-places.js` | server loader + `projectCuratedLabel(canonicalId, mode)` |
| `backend/functions/create-booking.js`, `update-pending-booking.js` | verified-only label projection |
| `service-worker.js` | cache pair bump + precache entries |
| `tests/curated-places-registry.test.js` | schema + ranking (incl. Virginia, Plantation, dedup) |
| `tests/curated-autocomplete.test.js` | behavior: sections, slow/failed Google, late registry, keyboard, image fallback, label guard |
| `tests/curated-label-server.test.js` | create + edit, both modes, verified/unverified/mismatch/replaced/retired |
| `tests/google-policy-readiness.test.js` | new pins (above) |
| `CLAUDE.md` | short "Curated places" section |

Not touched: `driver.html`, `trip.html`, pricing engine, migrations,
passenger code.

### H. Commits (small, reviewable, in order)

1. `feat(places): curated registry + matcher + tests`
2. `feat(search): two-section rich dropdown + image fallback + behavior tests + SW bump`
3. `feat(api): verified-only curated label projection (create + edit) + tests`
4. `docs: CLAUDE.md curated places section; plan acceptance record`

**Recommendation:** one PR, reviewed commit by commit. If the diff is too
large to review comfortably, split after commit 2 (browser) and ship commit
3 (server trust) as PR 1b — PR 1a alone already stores the curated label
from the client, 1b makes it tamper-proof.

### I. Tests and acceptance

- Ranking: "virgin", "virgin voyage", "virgin voyages", "terminal v" →
  Terminal V first; "virginia", "virginia key" → no curated hit; the
  Plantation office never above the terminal; ≤ 3 hits; < 3 chars → none;
  dedup by place_id; schema (required fields, unique ids/placeIds, label
  ≤ 500, `verifiedAt` present).
- Behavior: curated section survives slow / empty / failed Google; late
  registry load re-renders; keyboard order across sections; typing again
  clears validation; escaping; image `onerror` → icon; curated selection
  keeps Details attributions; canonical-id mismatch drops the curated label.
- Server: both booking modes × verified / no-token / verify_failed /
  mismatched / non-curated / replaced / retired; unchanged-route edit keeps
  labels byte for byte; route-change edit applies the label; invalid
  registry → today's behavior; packaging test loads the registry in both
  functions.
- Every existing `tests/*.test.js` passes; inline-script `node --check`.
- **Acceptance (Deploy Preview, LM-EFFA re-run):** typing "Virgin" shows
  PortMiami Terminal V first with its photo and Virgin badge; booking it
  stores and shows `PortMiami Terminal V (Virgin Voyages), 718 N Cruise
  Blvd, Miami, FL 33132` on the trip page and the driver card; Google
  attributions still display; a stale tab behaves as today.

## Unresolved decisions (Andres)

- **Q1.** Registry v1 contents: Terminal V + MIA + FLL only, with the other
  PortMiami terminals added as Andres verifies them? Claude drafts the
  to-verify list.
- **Q2.** Images: own photos (recommended) or Wikimedia CC with credits?
- **Q3.** Keep the light dropdown panel (recommended) or restyle dark in a
  later PR?
- **Q4.** Who reads the Google Places/Autocomplete terms for gate F?
- **Q5.** Section header wording: "LinkMia places" (proposed) — instead of a
  per-row "LinkMia pick" marker.

## Later roadmap (unchanged order; nothing scaffolded now)

Airline → terminal (own plan; likely migration 022) · Driver card map ·
Cruise Port path (port ↔ airport; line → terminal cards) · SMS (own plan,
provider undecided, reverses decision 8 only if Andres says so) · End-to-end
test. Parked with findings: hotel ↔ port / non-airport endpoints (airport
fee, token `airportCode` fact, migration 017 CHECK — a contract change).
