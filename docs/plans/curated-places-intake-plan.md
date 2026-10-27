# Terminal ranking first — first PR (plan v7, approved)

Branch `feature/curated-places-intake` · **Approved by Andres 2026-10-26**
(plan mode) · History: v1 dbc6243 · v2 2f5557b (Codex seq:0253 #1–#9) ·
v3 d90f4c5 · v4 79b14b0 (seq:0260) · v5 f177b27 (rich dropdown; Codex
seq:0262) · v6 narrowed to ranking first (Andres + Codex seq:0263) ·
**v7 = v6 + Andres's GO-WITH-CHANGES** (all seven companies before
complete; one record per physical terminal; safe edit pre-read).
v6/v7 were drafted in the session's plan file and are recorded here for
review. The dropdown design was kept through v7; Andres's compact-design
decision of 2026-10-27 (see "Compact-design review scope" below) supersedes
that, and photos/official artwork remain the next stage
(`curated-dropdown-mockup.html` is now the local review harness).

**Status (2026-10-27):** commits 1–4 done (`0cdadb4` registry + matcher,
`b3780c5` dropdown, `e9ae5f7` browser identity guard, `054e091` server
projection); `0bdca4f` resolved the six remaining terminals as drafts and
commit 5 verified them on Andres's confirmations (2026-10-27); docs
(commit 6, `3a89465`) done. Draft PR #120 open with CI and the Netlify
preview building from it (secrets-scan exemption `715a102`). Codex review
seq:0264 (2026-10-27): findings #1–#3
fixed and #4's wording aligned in the two commits after `7c754f7`. Full
suite green. Draft PR #120 open for review and preview (Codex seq:0266: GO
for controlled browser acceptance); no merge. Compact design (Andres,
2026-10-27; Codex relay 0268 implementation + 0269 corrections after
Claude's findings 1–7) committed as `433ee09` and pushed to the same draft
PR under Andres's authorization; the preview rebuilt from it (Netlify
deploy `6ae074ff72fc4b11298eeab2`). Andres re-confirmed the three
terminal-source questions on 2026-10-27 (all stand as stored). Codex relay
0272 (2026-10-27, review of Claude's search-coverage assessment) superseded
0271's "no new code findings" with one P2 (explicit terminal letters
promoted the wrong terminal) and one P3 (Royal Caribbean aliases); both are
fixed in the commit that adds the "Search coverage round" section below.
Still no merge.

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

**Acceptance record — compact design (2026-10-27, head `433ee09`, preview
deploy-preview-120 / Netlify deploy `6ae074ff72fc4b11298eeab2`, signed in
with Andres's account, no booking submitted):** desktop (Claude, app
browser) and phone (Andres) both pass. Desktop: the preview serves the
compact module and CSS, and the service worker installs `linkmia-v1.3.50`
/ `linkmia-runtime-v27`; "Virgin" → one row under the "LinkMia terminals"
caption (VV tile · Virgin Voyages · PortMiami · Terminal V); "Carnival" →
three Carnival rows (Terminals D/E/F) above the "Google suggestions"
caption, Google's rows and logo intact beneath; "Terminal F" → one neutral
C/D row naming Carnival · Disney, Google's own rows intact beneath (its
"Cruise Terminal F - Port of Miami" entry included); ArrowDown twice +
Enter on the Carnival list selects Terminal E — the field shows
`PortMiami Terminal E, 1265 N Cruise Blvd, Miami, FL 33132` with the
Google Maps attribution. Node 20 CI for `433ee09`: all three time-zone
jobs pass (Actions run 40484457875) and the Netlify Deploy Preview check
passes. Phone: Andres reports the compact rows look right on his phone (no
further detail recorded). Not verified by either pass: saved booking and
driver card (preview pricing env unset by decision — wait for a controlled
destination or production), Google terms gate (checklist Q1–Q8), Codex's
re-review of `433ee09`, and Andres's merge decision. The three
terminal-source questions (Terminal V street, Celebrity → G, Disney → F)
were answered by Andres later on 2026-10-27: all stand as stored
(Decision 1 below).

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
guessing); compact initials treatment approved below; passenger default stays 1; pricing
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
  **Verified by Andres 2026-10-27:** A → Royal Caribbean, B → Norwegian,
  D/E/F → Carnival, F also → Disney, G → Celebrity, AA → MSC. **Re-sourced
  2026-10-27 (Codex recommendation):** assignments and addresses now come
  from PortMiami's official pages (miamidade.gov/portmiami "Cruise
  Terminals" and "Directions to PortMiami") — A 2000, B 1761, D 1435,
  E 1265, F 1103, G 909, AA 2200 N Cruise Blvd — and no Google-returned
  text or coordinates remain in the file; place IDs stay as identifiers.
  Terminal V keeps Andres's 718 N Cruise Blvd (PortMiami prints "718 W.
  Cruise Blvd."). PortMiami lists Terminal G as Royal Caribbean's future
  terminal (opening 2027), not Celebrity, and names only Carnival at
  Terminal F (Disney unlisted). **Re-confirmed by Andres 2026-10-27, shown
  those differences:** all three stand as stored (V at 718 N, Celebrity →
  G, Disney → F); only the three `source` notes changed to record it.
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
**Terminal letter (Codex relay 0272 #1):** a word of at most two characters
right before or right after the word "terminal" (or an unfinished prefix
of it) is the terminal letter and matches only the start of a terminal's
own letter(s) — "terminal a" → A then AA, "terminal aa" → AA, "terminal c"
/ "c terminal" / "norwegian terminal c" → nothing while no verified
Terminal C exists (Google's rows stand alone; a letter never reaches
"cruise" or "disney"). Longer neighbours ("terminal carnival", "msc
terminal") and letters elsewhere ("norwegian c" → B) keep prefix
completion. Each record names its letter after the word "terminal" in its
name or keywords; the validator requires it, bounds it to two characters
and keeps it unique across records.

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
- Google's list stays intact beneath ours (Codex recommendation
  2026-10-27, accepted by Andres; replaces an earlier duplicate omission): a
  terminal may appear again further down in Google's own words; ours is
  still first. Google logo only when Google rows exist. Andres's subsequent
  compact design approval (2026-10-27): plain colored initials, short company
  name, PortMiami subtitle and a terminal badge; “LinkMia terminals” above
  ours and “Google suggestions” above Google's rows in a mixed list. The
  responsive panel bounds and Google row styling stay the same; curated
  rows use compact padding and can grow for longer names. Captions never
  count as selectable rows. Full selection labels and IDs stay unchanged.
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
- `service-worker.js`: this unreleased PR uses v1.3.50 / runtime-v27 for
  the registry and compact presentation together, with one shared
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
  decision record). Google's list is left intact and LinkMia's rows are
  captioned already.

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
   Disney merged into F; addresses since re-sourced from PortMiami's
   official pages (Terminal D's number found there: 1435). Two
   re-confirmations were put to Andres: Terminal V's street (Andres: 718 N
   Cruise Blvd; PortMiami: 718 W. Cruise Blvd.) and the official page's
   wording that Terminal G is Royal Caribbean's future terminal and that
   only Carnival uses F. **Answered by Andres 2026-10-27: all three stand
   as stored** (V at 718 N Cruise Blvd, Celebrity → G, Disney → F) — his
   first-hand assignments; the registry's three `source` notes record the
   confirmation and no other data changed.
2. Initials tiles — **settled by Andres 2026-10-27**: match the compact
   colored VV example for every company; no generic ship icons or official
   logo artwork. Codex implements this specific change, Claude reviews it.
3. Company not stored on the booking (only the terminal name/address) — OK?
4. Who reads Google's Places terms for the release gate — **settled by
   Andres 2026-10-27: he reads `docs/google-places-terms-checklist.md`
   (Q1–Q8) himself and answers in chat; the checklist's decision record is
   filled from his answers with the reviewed commit and preview deploy.**

Next stage (own PR, reuses this registry): photos/official logo artwork only
after its separate approval. Compact initials, terminal badges and section
captions are covered by Andres's later design decision above.

### Compact-design review scope (2026-10-27)

Codex's local, uncommitted presentation change is based on `d57053a`.
Andres explicitly reversed the roles for this change only: Codex implements,
Claude independently reviews. This does not change the standing workflow.
The seven company styles use VV, C, RC, NCL, CC, MSC and D; a generic
Terminal F query stays one neutral C/D row naming Carnival and Disney.
The matcher, registry data, quote handling, server labels and pricing are
unchanged. Claude is the independent reviewer for this change; commit,
push, preview deployment and merge still require Andres's authorization.

`docs/plans/curated-dropdown-mockup.html` imports the real component, CSS
and registry, with illustrative provider responses and external calls
blocked. It checks local layout/interaction, not live Google results,
phone keyboard behavior, saved bookings or the driver screen. The earlier
phone/preview acceptance applied to the earlier design; the compact design
received its own desktop + phone preview acceptance at `433ee09` (see the
second acceptance record at the top of this plan).

Initial local verification by Codex (before Claude's 0268 review): seven
relevant Node v24.22.1 suites passed
(243 checks): curated-autocomplete (24), curated-places-registry (39),
curated-label-server (18), google-policy-readiness (32),
autocomplete-raw-capture (19), autocomplete-session (11), and
pending-edit-hydration (100). Real-component browser harness: seven
company styles and the shared F row inspected; long names and Terminal AA
fit the 320px card; Virgin mixed list inspected at 390px; Carnival D/E/F
fit at 320px, with the rest scrolling under the same height cap;
ArrowDown twice + Enter selected Terminal E with the full registry
address and place ID. These use fake provider responses / Details fallback,
not a live provider or saved-booking check. Node 20 CI was not rerun here.

After Claude's review of 0268, Codex corrected the LinkMia spelling, replaced
the newer property-check API with the existing compatible idiom, moved shared
short names into the presentation table, and derived neutral fallback initials
from registry company names. The presentation test now reads the registry's
terminal assignments rather than duplicating them. The same unreleased PR
keeps its already-assigned cache pair; the extra uncommitted bump was withdrawn.
The release checklist now describes the initials, colors, source captions and
sticky Google footer; its policy/branding decisions remain open.

Correction validation: the same seven local suites passed, now 245 checks
(curated-autocomplete: 26; the other six counts above unchanged). A test
removes Object.hasOwn from an isolated VM realm and exercises the real typing
handler and both result sections. Temporarily restoring the two newer-API
calls in memory makes this test fail, confirming it detects the regression.
No file was changed for that negative control. These checks ran on Node
v24.22.1; they do not replace a real older-phone pass or Node 20 CI. Claude
then re-ran all 46 suites on the corrected tree (diff SHA `2425efbc…`,
unchanged across the run) before committing it as `433ee09` and pushing it
to the draft PR under Andres's authorization.

### Search coverage round (Codex relay 0272, 2026-10-27)

Codex reviewed Claude's assessment of the registry against PortMiami's
official pages and probed the real matcher, superseding relay 0271's "no
new code findings" with one P2 and one P3, both to be fixed in this PR
before merge; the wider scope questions (more companies, ship names, other
ports) stay separate decisions for Andres.

1. **P2 — explicit terminal letters (fixed here).** At `bc736c8` a lone
   letter prefix-matched any word: "terminal c" listed every terminal ("c"
   → "cruise"), "terminal d" added Disney's F ("d" → "disney"), "Norwegian
   terminal c" answered B and "Royal Caribbean terminal c" answered A — a
   destination-selection defect against this plan's no-guessing rule. The
   matcher now carries the TERMINAL-LETTER rule recorded in §2: a word of at
   most two characters right before or right after the word "terminal" (or
   an unfinished prefix of it) is the terminal letter and matches only the
   start of a terminal's own letter(s) — "terminal a" → A then AA, "terminal
   aa" → AA, "terminal c" / "c terminal" / "norwegian c terminal" / "term
   c" → nothing (Google's rows stand alone). Longer words next to
   "terminal" and letters elsewhere keep ordinary prefix completion
   ("terminal carnival", "msc terminal", "terminal msc", "norwegian c" → B,
   "terminal dis" → F). The validator requires every record to name its
   letter after the word "terminal" in its name or keywords, bounds it to
   two characters and keeps it unique across records (one record per
   physical terminal); the real registry yields exactly V, A, B, D, E, F,
   G, AA. Executed in `tests/curated-places-registry.test.js` (fixture
   rule, `parseQuery` pins, schema guards, and Codex's four queries plus the
   reverse word order and the unfinished word on the real registry).
   Negative control: the same suite run against the `bc736c8` module fails
   at the first terminal-letter check. Deliberate residual: a two-letter
   prefix of a company word next to "terminal" ("terminal ca") finds
   nothing until a third letter is typed.
2. **P3 — Royal Caribbean aliases (fixed here, data only).** Keywords added:
   "royal caribbean international", "royal caribbean cruises", "rci",
   "rcl". The probe showed the same gap class for plural forms and one more
   initialism, so the same commit also adds "carnival cruises", "carnival
   cruise lines", "ccl", "norwegian cruises", "norwegian cruise lines",
   "disney cruises", "disney cruise lines" and "virgin cruises" — ways
   passengers write already supported companies (Claude's addition beyond
   Codex's three; Andres may strike any). Executed on the real registry. No
   name, address, place ID, assignment or `verifiedAt` changed.
3. **Verified expansion vs inferred assignments — agreed.** Terminals C and
   J stay out until Andres confirms who sails from them today and the place
   IDs resolve; no assignment is taken from older reports or future plans.
   OPEN FOR ANDRES: does Norwegian currently use Terminal C as a second
   terminal? If yes, this plan's "every terminal of a company" rule wants a
   verified C record under Norwegian; if no, nothing changes.
4. **Count and port-risk precision — accepted.** PortMiami's cruise-lines
   directory has 26 entries; six overlap the registry (Disney is absent from
   that directory, which does not undo Andres's confirmation), so 20 are
   uncovered, not 19. The one wrong-port exposure is a company-only query
   such as "Celebrity", whose row explicitly says PortMiami; "Celebrity Port
   Everglades" finds no curated row.
5. **Limits.** Node-only verification of the matcher on the real registry;
   no new browser, phone or saved-booking pass for this head yet. The
   service-worker pair stays v1.3.50 / runtime-v27: the PR is unreleased,
   and the worker serves `.js`/`.json` network-first, so the preview picks
   the changed module up without a bump. Still open before merge: the
   Google terms/branding decision record (Andres reading Q1–Q8), Codex's
   re-review of this head, Andres's merge decision.
