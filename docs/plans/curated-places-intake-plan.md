# Terminal ranking first — first PR (plan v7, approved)

Branch `feature/curated-places-intake` · **Approved by Andres 2026-10-26**
(plan mode) · History: v1 dbc6243 · v2 2f5557b (Codex seq:0253 #1–#9) ·
v3 d90f4c5 · v4 79b14b0 (seq:0260) · v5 f177b27 (rich dropdown; Codex
seq:0262) · v6 narrowed to ranking first (Andres + Codex seq:0263) ·
**v7 = v6 + Andres's GO-WITH-CHANGES** (all seven companies before
complete; one record per physical terminal; safe edit pre-read).
v6/v7 were drafted in the session's plan file and are recorded here for
review. The current dropdown design is kept; photos are the next stage
(the v5 mockup `curated-dropdown-mockup.html` describes that stage).

**Status (2026-10-27):** commits 1–4 done (`0cdadb4` registry + matcher,
`b3780c5` dropdown, `e9ae5f7` browser identity guard, `054e091` server
projection); `0bdca4f` resolved the six remaining terminals as drafts and
commit 5 verified them on Andres's confirmations (2026-10-27); docs
(commit 6, `3a89465`) done. Draft PR #120 open with CI and the Netlify
preview building from it (secrets-scan exemption `715a102`). Codex review
seq:0264 (2026-10-27): findings #1–#3
fixed and #4's wording aligned in the two commits after `7c754f7`. Full
suite green. Draft PR #120 open for review and preview (Codex seq:0266: GO
for controlled browser acceptance); no merge.

**Acceptance record (2026-10-27, head `fc64fce`, preview
deploy-preview-120, signed in as Andres, no booking submitted):**
desktop (Claude, app browser) and phone (Andres) both pass — every
supported company query puts its terminal(s) first, instantly and after
Google's rows render ("Virgin"/"Virgin voya"/"Virgin voyage" → Terminal V;
Carnival → D/E/F; Royal/RCCL → A; Norwegian/NCL → B; Celebrity → G; MSC →
AA; Disney/DCL → F; "Terminal F" names both lines); Google's duplicate of a
curated place is removed; click and keyboard selection carry the terminal
label, place ID and live coordinates into the booking in BOTH directions
(headers "PortMiami Terminal V → MIA" and "MIA → PortMiami Terminal V…");
hotel and "Virginia" queries show Google rows only; Escape dismisses; the
panel keeps its height and scrolls. Preview pricing errors by decision
(preview env), so saved-booking and driver-card verification wait for a
controlled destination or production. Known, pre-existing: keystrokes
within ~150 ms of the field's first focus precede the lazily loaded module.
Open: Google terms gate, Terminal D street number, Andres's merge decision.

## Context

On 2026-10-26 the first real private client booked LM-EFFA (PortMiami → MIA).
Typing "Virgin voyage" showed the Virgin Voyages **corporate office in
Plantation** and Virginia places; the "Virgin" query had **no terminal
result at all**, so reordering Google's list cannot fix it. The pickup was
stored as "Miami, FL 33132, USA" (the brand result's Place Details address),
which the driver card shows and driver navigation uses.

Settled: the app gets its own small **verified list of cruise terminals**,
inserted above Google's suggestions; selecting one carries the **correct
place ID and an unambiguous terminal name** into booking and driver
screens; a company with several terminals shows every terminal (no
guessing); current row design stays; passenger default stays 1; pricing
unchanged. **Terminal V is the first development milestone; the PR is not
complete until all seven supported companies (Virgin, Carnival, Royal
Caribbean, Norwegian, Celebrity, MSC, Disney) have verified terminal
choices.** Airline → terminal, driver map, Cruise Port path, SMS, photos:
all after this PR.

## Root causes (verified in code)

- `autocomplete.js` rendered Google's raw predictions; loading, results
  and error shared one container, so a Google failure wiped the list.
- Selection stored Google's `formatted_address`; `create-booking.js`
  persisted the client text; `driver.html:1175` shows it, `:1411`
  navigates by it.
- Railway `/api/places/details` returns only `geometry,formatted_address`
  (`backend/api-proxy/server.js:530`) — no `place_id` back; the canonical
  id is known only from the quote echo (`quote.intent.placeId`; edit:
  `adoptCanonicalPlaceId`, `js/pending-edit-model.js`).
- Route identity = (mode, airportCode, canonicalPlaceId); labels excluded
  (`routeIdentity` in the model, `classifyRoute` in
  `update-pending-booking.js`).
- A verified or operationId edit bypasses the fast pre-checks and goes
  straight to `accept_quote_edit`, which enforces ownership,
  pending+unassigned, the `details_version` CAS and operation receipts;
  `pEdit` carries the client's labels.
- Resolver flags a replaced id (`substituted`, `lib/place-identity.js`).

## Approach

### 1. Registry — `data/curated-places.json` (one record per physical terminal)
```
companies: [{ key:"virgin", name:"Virgin Voyages", keywords:["virgin","virgin voyages"] }, …]
terminals: [{ id:"pom-terminal-v", name:"PortMiami Terminal V",
              address:"718 N Cruise Blvd, Miami, FL 33132", placeId:"<canonical>",
              companies:["virgin"], keywords:["terminal v"],
              source:"…", verifiedAt:"2026-10-26" }, …]
```
- A terminal shared by two companies is **one record** listing both; place
  IDs stay unique per record. The stored label is terminal-centric and
  unambiguous: `PortMiami Terminal V, 718 N Cruise Blvd, Miami, FL 33132`
  (the server knows only the place ID, so it never stores a company).
  The company appears in the dropdown row, not in the stored label
  (deliberate limit; revisit if drivers need it).
- `placeId` = the canonical id the resolver returns, checked against the
  physical terminal; all join the smoke matrix.
- **Records without `verifiedAt` are inert** (browser and server loaders
  skip them), so drafts can sit in the file safely.
- Coverage — PR complete only when every row is verified (Andres confirms
  the assignment; Claude resolves the place ID and records `source`).
  **Verified by Andres 2026-10-27:** A → Royal Caribbean, B → Norwegian
  (Google's address range kept), D/E/F → Carnival, F also → Disney (Google's
  separate "Disney Cruise Terminal" record is the same building, merged),
  G → Celebrity (the Celebrity-named record, 925 N Cruise Blvd), AA → MSC.
  Open: Terminal D's street number (Google has none; Andres may supply it).
- Browser: `/data/curated-places.json?v=1` (precached, versioned). Functions:
  static `require` (esbuild inlines JSON). Server copy decides labels;
  invalid registry → feature off.

### 2. Matcher — `js/curated-places.js` (pure, UMD for browser + server)
`matchCurated(query, registry)` → ordered rows `{terminal, company|null}`,
**no cap**. Normalize (lowercase, accents); ignore < 3 chars; every query
token must prefix-match a distinct token of a company keyword/name or a
terminal keyword/name — direction matters ("virgin", "virgin voya",
"virgin voyage", "virgin voyages" match; "virginia" does not). Company
match → one row per terminal of that company, showing the company.
Terminal/port match ("terminal v", "portmiami", "cruise") → the terminal
row showing its companies. Score: exact phrase 3 · company/terminal keyword
or name prefix 2 · mixed company+terminal wording 1; ties by registry order
(wording aligned with the code, Codex seq:0264 #4). Not fuzzy.

### 3. Dropdown — `autocomplete.js` (same look as today)
- Curated rows reuse `.suggestion-item`: main = `Virgin Voyages — PortMiami
  Terminal V` (or `PortMiami Terminal A — Royal Caribbean, Celebrity` for a
  terminal match), secondary = address, 🚢 instead of 📍. **Rendered
  immediately on keystroke** (synchronous, before the Google debounce);
  Google rows are appended when they arrive; Google "Loading…"/error lines
  render **below** curated rows and never replace them; "No results found"
  only when both are empty; a Google failure with curated rows on screen
  is not an address error.
- One unified item list (curated first) so `selectedIndex`,
  `highlightItem`, Enter/Escape and `requestSequence` guards work unchanged;
  stale Google responses dropped as today.
- Google rows with the same `place_id` as a curated row are dropped
  (reversible — see gate). Google logo only when Google rows exist.
- Registry loads once at boot, at most one retry for a transient failure;
  an invalid file is final for the page load; either way today's dropdown.
- Selecting any row cancels the queued debounce and invalidates an in-flight
  Google request (a late answer cannot reopen the list, a late failure
  cannot flag the chosen address); a keyboard highlight survives Google's
  loading / results / error updates of the same text by item identity and
  resets on new text or when the item is gone (Codex seq:0264 #1, #2).

### 4. Identity — the selected terminal survives to booking and driver
- Row carries the registry `placeId` + `label`. Selection runs the
  existing Details call for coordinates, renders every attribution, sets
  the input to `label`. Selection events and `selectedPlace` keep exactly
  today's shapes.
- **Quote reception (create: `reconcileQuoteLabel` in indexMVP; edit: the
  card after `adoptCanonicalPlaceId`, via `model.replaceAddressLabel`):**
  if the canonical echo ≠ the id the selection — or the hydrated booking —
  carried, the address label falls back to the quote's `formattedAddress`,
  Google's own label for the canonical place, **whether or not the old id
  was a curated terminal**. Decided from the quote alone, with no registry
  lookup, so hydrated edits are covered while the registry loads or after
  it failed (Codex seq:0264 #3; v7 first said a non-curated address keeps
  its label — in the replacement case the old label described the old id,
  so it is replaced too). A label is never carried onto an id it was not
  issued for. The submitted id stays in `state.locations.placeId` (the
  quote key must keep matching); the contract already submits the
  canonical id.
- **Server (authoritative), `backend/functions/lib/curated-places.js`
  `projectCuratedLabel(canonicalPlaceId, bookingMode)`:**
  - **Create:** after `verdict === 'verified'`, when the canonical id is a
    verified terminal, the registry label goes to the address side per
    `bookingMode`, ignoring client text.
  - **Edit — safe pre-read:** only when verified AND the canonical id is a
    verified terminal (in-memory check first). One service-key
    `select('customer_id, status, assigned_driver, details_version,
    booking_mode, airport_code, canonical_place_id, route_authority')`:
    * row missing, not the caller's, not pending/unassigned, or
      `details_version ≠ expectedDetailsVersion` → **skip projection**; the
      RPC runs unchanged with its own 404/403/409/receipt — no new refusal
      shape, never intercepts an exact-byte retry;
    * identity equal (canonical authority; booking_mode, airport_code,
      canonical_place_id = token's) → unchanged route → **no projection**;
    * identity differs (route change, or a legacy row's first verified
      edit) → `pEdit[addressColumn(mode)] = registry label`;
    * read error → skip projection, log, continue to the RPC.
  - Concurrency: a commit between the pre-read and the RPC fails the CAS →
    409; the projected label is discarded. Retry after success: the
    pre-read sees the advanced version → skips → the RPC returns the
    receipt; one write only.
  - Unverified / no-token / mismatched / non-curated → today's behavior.
    No migration (RPCs already take location strings).
- Replaced id (`substituted`) → quote succeeds, Google label. Retired id
  (`places_not_found`) → refused as today, form kept.
- `trip.html`, `driver.html`, doorbell read `pickup_location` — untouched.

### 5. Release
- `service-worker.js`: pair moved to v1.3.50 / runtime-v27 with its
  history line; `/js/curated-places.js?v=1` and
  `/data/curated-places.json?v=1` precached at the exact requested URLs;
  the model and card moved to `?v=3` / `?v=2` (both changed in this PR) so
  page and modules travel together.
- `tests/google-policy-readiness.test.js` pins: curated-only render → no
  Google logo; mixed → exactly one, after Google's rows.
- `CLAUDE.md`: short "Curated cruise terminals" section (commit 6).
- **Open gate (not a clearance):** Andres or counsel reads Google's current
  Places/Autocomplete policies before release, against
  `docs/google-places-terms-checklist.md` (behaviours A–H, questions 1–8,
  decision record); if dedup is a problem, curated rows sit above an
  undeduplicated Google list.

## Files
New: `data/curated-places.json`, `js/curated-places.js`,
`backend/functions/lib/curated-places.js`,
`tests/curated-places-registry.test.js`, `tests/curated-autocomplete.test.js`,
`tests/curated-label-server.test.js`.
Modified: `autocomplete.js`, `indexMVP.html` (script tags, quote-reception
guard), `js/pending-edit-model.js` (`replaceAddressLabel`),
`js/pending-edit-card.js` (relabel on identity replacement),
`backend/functions/create-booking.js`, `backend/functions/update-pending-booking.js`,
`service-worker.js`, `tests/google-policy-readiness.test.js`,
`tests/pending-edit-card.test.js`, `tests/pending-edit-hydration.test.js`,
`tests/quote-browser-integration.test.js`, `CLAUDE.md` (commit 6).
Not touched: `driver.html`, `trip.html`, `css/*`, pricing, migrations,
passenger code.

## Commits (small; reviewed one by one; no push, no PR)
1. `feat(places)`: registry schema + loader + matcher; Terminal V verified;
   ranking/coverage tests — **milestone 1** ✔ `0cdadb4`
2. `feat(search)`: curated rows above Google, immediate render, race/error
   handling, keyboard, dedup, attribution pins, SW bump ✔ `b3780c5`
3. `feat(quote)`: browser identity guard at both quote-reception points
   ✔ `e9ae5f7`
4. `feat(api)`: create projection; edit pre-read + projection; ownership /
   concurrent-edit / retry tests ✔ `054e091`
5. `feat(places)`: remaining six companies verified (`verifiedAt` set,
   place IDs resolved, `source` recorded) — drafts resolved in `0bdca4f`,
   verified on Andres's confirmations 2026-10-27 ✔ (coverage now asserted
   by `PR_COMPLETE = true`)
6. `docs`: CLAUDE.md section, acceptance record

## Verification
- Ranking: "virgin" / "virgin voya" / "virgin voyage" / "virgin voyages" →
  Terminal V first; "virginia", "virginia key" → none; each of the seven
  companies → all its verified terminals, in registry order; a shared
  terminal appears once and names both companies; "terminal v" /
  "portmiami" → terminal rows; generic/Plantation never above a matching
  terminal; < 3 chars → none; inert drafts never match; schema.
- Behavior (vm harness on the real module, live LM-EFFA Google shapes):
  Terminal V appears when Google omits it; curated rows survive slow /
  empty / failed Google and a stale response; keyboard order across both
  groups; Escape; escaping; attributions kept; logo rules; late registry.
- Identity: canonical echo ≠ registry id → label falls back (create and
  edit); echo = registry id → label kept.
- Server (mock `@supabase/supabase-js`, real handlers, real v2 tokens):
  create × verified / no-token / verify_failed / non-curated, both modes;
  edit: identity-equal → labels pass through; identity-changed → projected;
  legacy row → projected; foreign booking, moved version, concurrent
  commit, exact-byte retry, pre-read failure, non-curated (no read).
- `for t in tests/*.test.js; do node "$t"; done` all pass; packaging test
  loads the registry in both functions.
- **Acceptance (Deploy Preview, LM-EFFA re-run):** typing "Virgin"
  immediately makes Terminal V the first selectable result (before Google
  answers, and when Google omits it); booking it stores `PortMiami Terminal
  V, 718 N Cruise Blvd, Miami, FL 33132` with `canonical_place_id` = the
  registry id; the driver card shows that name. Each supported company
  keyword shows its verified terminal(s) first; shared terminals list both
  companies. Passenger stays 1; price unchanged.

## Decisions for Andres (recommendation first)
1. Terminal assignments — **settled 2026-10-27**: every draft confirmed;
   B keeps Google's address range; G uses the Celebrity record (925 N
   Cruise Blvd); Disney merged into F. Still open: Terminal D's street
   number (Andres may supply it).
2. 🚢 icon on curated rows (minimal distinction from Google rows) — shipped
   as the default; say if you'd rather keep 📍.
3. Company not stored on the booking (only the terminal name/address) — OK?
4. Who reads Google's Places terms for the release gate.

Next stage (own PR, reuses this registry): photos, badges, section headers.
