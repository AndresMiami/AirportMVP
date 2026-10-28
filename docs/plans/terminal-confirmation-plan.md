# Cruise terminal summary and optional spot map — plan v1.6 (R1 implementation plan; Codex GO 0286 with its two amendments recorded; Andres's implementation go 0287)

Status: **R1 under implementation** on branch
`feature/terminal-confirmation-r1` from main `cc84afd` (Andres, relay 0287:
"add that guard and start R1 … open a draft PR with a preview"; the plan is
committed with that PR as the reviewed basis; the mockup
`docs/plans/terminal-confirmation-mockup.html` stays an untracked visual aid,
not bundled). v1.6 records the two amendments Codex prescribed in 0286 before
implementation: the **Change terminal reopening guard** (0286 #2; §3.2, §3.7,
§5) and the **boundary wording** (0286 #5; §5). Nothing else changed in the
reviewed contract.
Flow decided by Andres 2026-10-27 (Codex relays 0273, 0275, 0276, 0277):
the confirm sheet opens on the terminal pick, a short reminder block sits
at the top of When, Change terminal reopens the sheet, the sheet slides down
to let the passenger type a brand-new address, the map comes later inside
the same sheet; the approved dropdown stays as it is. v1.4 answered Codex
relay 0277 findings 2–6 and added the state/transition table requested in
0282. **v1.5 applies relays 0284 and 0285:** the session-token fallback
(F1) is removed as a gate (Andres's decision, 0284); the selection
lifecycle gains a **synchronous selection-start boundary** so a dismissed
sheet can never be reopened by a late Details result and Confirm/Skip lock
the instant another terminal is tapped (0285 #2); the canonical guard keeps
an **identity-bound resolution record** so an obsolete terminal stays
suppressed through pickup-time and other pricing-input changes (0285 #3);
the R2 reversal wording defers to the existing full-draft comparator
(0285 #5). Both 0285 gaps were reproduced in-memory against the real
`autocomplete.js` and `indexMVP.html` methods on main, and the two
corrected contracts were run against the same event order (probe kept
outside the repo). Nothing here is implemented; the implementation go is
Andres's after Codex's check (0283, 0284). Code references are to main at
`cc84afd`, whose application code is identical to `affcacf` and `c095d3b`
for every line cited.

History: v1 (trip block + pending picker) · v1.1 (When-top, driver place-ID
handoff) · v1.2 (experience first; 0276 corrections) · v1.3 (decided flow:
sheet + When reminder; drag-to-dismiss) · v1.4 (lifecycle, metadata, echo
guard, release boundaries, edit staging, state table) · v1.5 (F1 skipped;
selection-start boundary; resolution record; R2 comparator wording) ·
**v1.6 (this file: the Change terminal reopening guard and the boundary
wording, both prescribed by Codex 0286; R1 implementation started).**

## 1. Problem

The dropdown stores the terminal a cruise company *usually* uses. The ride
needs the terminal the passenger's *ship uses on that date*, which lives only
in the passenger's latest cruise instructions. No machine source of future
assignments exists (PortMiami's Daily Dock Report is a CAPTCHA'd human form;
MarineTraffic sells past berth calls). So the passenger checks, and the
driver's own check is the backstop. Two decisions stay apart (0276 #1):
**terminal identity** (the signed canonical place ID) and **meeting point**
(display and driver handoff, never a client coordinate the server trusts).
PortMiami has terminals, not gates: every surface says "terminal".

## 2. The passenger experience (decided; unchanged from v1.3 except §2.4, §2.6 and the sheet's opening instant in §2.1–§2.2)

### 2.1 Journey, new booking
1. **Where.** The passenger picks a LinkMia terminal row (released in PR
   #120). **The tap itself opens the confirm sheet** (§2.2, §3.2) with the
   tapped row showing "Checking…" while the existing selection path (label,
   place ID, coordinates lookup; `indexMVP.html:1638-1661`) settles behind
   it; Confirm and Skip enable once it has. (v1.4 opened the sheet on the
   coordinates response; 0285 #2 showed that a sheet keyed on the response
   could be reopened by a late one.)
   - Going to Airport (`state.mode === 'dropoff'`, port → airport): the
     terminal is the pickup and is picked first; after the sheet the
     passenger is back on Where to pick the airport, whose tap auto-advances
     to When as today (`indexMVP.html:1521-1540`).
   - Arriving at Airport (`state.mode === 'pickup'`, airport → port): the
     terminal is the drop-off and completes the route; the auto-advance is
     **deferred** to Confirm or Skip, then When opens.
2. **The sheet** (§2.2): Confirm or Skip continues; sliding it down, ✕, the
   backdrop or Escape closes it and stays on Where with the address box
   focused, so the passenger can type a brand-new address.
3. **When.** The reminder block is the first thing on the panel (§2.3):
   role word, terminal, cruise line, the reminder line and **Change
   terminal**, which goes back to Where and reopens the sheet with the
   current terminal marked. Date, time and flight controls are untouched.
4. Vehicle, traveler, Book as today. After booking, the trip card repeats
   the reminder (§2.4).

### 2.2 The confirm sheet (one component; two caller modes, §2.6)
House bottom-sheet pattern (dimmed backdrop rgba(0,0,0,0.7), panel max-width
576 px, 20 px top radius, slideUp 0.3 s; `js/passenger-modal.js`), with a
drag handle.
```
▬▬                                                   (drag handle)
Confirm pickup terminal                          ✕    (Going to Airport)
PortMiami
[ map: later release, §2.5 ]
Terminal V   Virgin Voyages
Terminal A   Royal Caribbean                 Selected
Terminal B   Norwegian Cruise Line
…
Terminal AA  MSC Cruises
Check this is the terminal your ship docks at.
[ Confirm terminal ]
  Skip
```
- Title by direction: "Confirm pickup terminal" (Going to Airport) /
  "Confirm drop-off terminal" (Arriving at Airport); subtitle "PortMiami".
- List: the eight verified terminals in registry order with their cruise
  lines; the current terminal marked "Selected" (§3.3 says when nothing is
  marked). In **create** mode, tapping another row re-selects it
  **through the autocomplete's curated selection path** (the same code a
  dropdown pick runs: label, place ID, coordinates lookup, the same events);
  the address box behind the sheet changes with it; the row shows
  "Checking…" until that selection settles (§3.2). In **edit** mode the tap
  only stages the row (§2.6).
- Reminder line by direction: "Check this is the terminal your ship docks
  at." (pickup) / "Check this matches your latest cruise instructions."
  (drop-off).
- **Confirm terminal** and **Skip** keep the current selection and continue
  (§3.2 defines "continue"). Both are disabled from the instant any row is
  tapped — the first pick included — until that selection settles (§3.2),
  so an old terminal is never confirmed while a new one is pending and a
  late result never finds an enabled button.
- **Slide down, ✕, backdrop, Escape** close the sheet and **stay on Where**
  with the current terminal still selected and the address input focused
  with its text selected; typing a brand-new address runs the existing
  clearing path (`indexMVP.html:1673-1687`). No advance happens on a close;
  nothing reopens the sheet on focus, typing, restore, re-render or a late
  response (Andres's rule, 0277 #1); only a deliberate new terminal pick or
  Change terminal opens it again.
- Drag-to-dismiss: pointer drag on the handle or the title row; release past
  about 80 px or a fast flick closes, otherwise it snaps back;
  `prefers-reduced-motion` disables the animation only.
- Accessibility as the traveler dialog: `role="dialog"`, `aria-modal`,
  labelled title, focus trapped, Escape closes, focus returns to the
  address input on close in create mode and to the opener control in edit
  mode (§2.6); on continue, to the next panel's first control.
- Nothing in the sheet is a quote surface: no price; in create mode the only
  network call is the coordinates lookup every pick already makes; in edit
  mode none.

### 2.3 The When reminder block (create flow only)
First block in the When panel, above the arrival/time basis and the date
buttons (`indexMVP.html:194-215`), shown only when the selected address is a
verified terminal **and not superseded** (§3.3):
```
Pickup: PortMiami Terminal A · Royal Caribbean         (Going to Airport)
Check this is the terminal your ship docks at.
Change terminal
```
Role word from `state.mode` (`pickup` → "Drop-off", `dropoff` → "Pickup";
the server uses the same mapping for the stored column,
`backend/functions/lib/curated-places.js:28-31`). **Change terminal** =
`navigateToPanel('where')` (`:1951-1990`) and open the sheet directly
(§3.2, event "Change terminal"). Two lines and one link; nothing else on
When changes.

### 2.4 After booking: the trip card reminder — R1 has no new action (0277 #5)
In `trip.html`'s `.card` under the route rows and above `#flightLine`
(`trip.html:313-337`), only when the status payload carries `terminal`
(§3.4): the same two lines, then a third line by status. **R1:** pending →
"Need a different terminal? Use Manage ride." (the existing Manage ride
button directly below opens the existing review card, whose "Change route"
path is the way to change it; the trip page posts the same `lm-edit`
message as today, `trip.html:1463-1469`, and the standalone intent is
unchanged, `:1470-1479`); confirmed / on_the_way / arrived → "Need a
different terminal? Message your chauffeur." or the LinkMia-line variant
when no contact is shown; in_progress, terminal statuses, reassigning →
hidden. No control on the trip page promises the sheet before it exists.
**R2:** the pending line becomes a **Change terminal** link that posts
`lm-edit` with `focus:'terminal'` (and the standalone intent carries the
same field) so the card opens with the sheet in view. `#routeAttribution`
and the lifecycle-notice copy stay byte-identical
(`tests/google-policy-readiness.test.js:648-659`,
`tests/passenger-polling.test.js:516-577`). View spot is not on the trip
card in the first delivery.

### 2.5 View spot (inside the same sheet; later release, R4)
Unchanged from v1.3: a Google map in the upper part of the sheet with
Google's points for the selected terminal, fetched request-scoped on open
and on a settled re-selection through `GET /api/place-spot?placeId=`
(§3.6), labels naming what Google returned, honest caption, loading / error
/ no-points states, the stale guard keyed by the place ID at request time.
Idle = zero Google calls. Until R4 the sheet has no map area and no "View
spot" control anywhere.

### 2.6 Pending edits: the same sheet from the review card, edit-scoped (0277 #6)
When the hydrated address side is a verified terminal, the card's route row
gains **Change terminal** beside "Change route"; it opens the sheet in
**edit mode**:
- **Staging, not applying.** A row tap stages `{ placeId, label,
  terminalId }` inside the sheet and marks the row; the card draft, the
  create flow's `state.locations`, the autocomplete and the quote are all
  untouched; no coordinates lookup, no quote.
- **Cancel** (slide, ✕, backdrop, Escape) discards the staged row, closes,
  and returns focus to the card's Change terminal control; the draft is
  exactly as it was when the sheet opened, including unrelated changes made
  before (a new time, say).
- **Confirm** compares the staged terminal with the **opening draft's**
  address identity (`toQuoteIntent(draft.route).placeId` at open time):
  equal → close, nothing changes, no quote. Different → `draft.route =
  withAddress(draft.route, { placeId, label })` (new pure model operation:
  canonical kind only, identity recomputed, coordinates null, attributions
  empty), then the **existing** rules decide what that means (0285 #5): if
  the new identity equals the SAVED snapshot's identity, the complete saved
  ROUTE tuple is restored (stored labels back — exactly what the Where lane
  does today, `js/pending-edit-card.js:718-726`); either way
  `scheduleQuote()` runs and the existing full-draft comparator
  (`js/pending-edit-model.js:330-355`: route, pickupAt, passengers,
  vehicle, traveler) together with the held-quote freshness rules decides
  whether a quote is needed. Zero calls happen only when the complete
  intent is unchanged from the snapshot or a suitable fresh held quote
  already satisfies it; a reversal that leaves another change behind (saved
  A at T0 → draft B at T1 → choose the saved A keeps T1) still buys its one
  edit quote, as it would through Change route today. So "changed A → B
  earlier, reopen, choose the saved A, Confirm" is a real route reversal,
  and "changed A → B, reopen, cancel" leaves B. Unrelated draft changes
  survive both, because only `draft.route` is replaced.
- Save continues as today: identity compare → edit quote → "Updated total"
  → Save → envelope → the server writes the terminal label on identity
  change (`backend/functions/update-pending-booking.js:708-726`) → trip
  sheet reopens. The Where screen remains the path for any non-terminal
  address. The card still may not name route internals
  (`tests/pending-edit-card.test.js:921-937`): the opening identity and the
  staged terminal are compared through the adapter's `toQuoteIntent`, and
  `withAddress` lives in the model.

### 2.7 Lifecycle (where the terminal can change)
| Status | Change? | Path |
|---|---|---|
| booking | yes | dropdown; sheet on pick; When → Change terminal → sheet |
| pending | yes | Manage ride → card → (R1: Change route; R2: the sheet) |
| confirmed, on_the_way, arrived | no | notice + WhatsApp (`trip.html:1129-1147`); confirmed editing is PR 3C-3 |
| in_progress and after | no | — |
| released → pending | yes again | as pending |

## 3. Engineering derived from the experience (read-side only)

### 3.1 Curated metadata contract (0277 #2)
- The autocomplete's selection carries the registry identity on BOTH
  successful paths. In `selectSuggestion` the `place` object built after a
  successful Details call (`autocomplete.js:575-587`) and the one built by
  the Details-failure fallback (`:596-612`) both gain
  `curated: curated ? { terminalId: curated.terminalId, companyKey:
  curated.companyKey, placeId: curated.placeId } : null` (the registry row
  already carries all three, `js/curated-places.js:318-331`); a Google
  prediction yields `curated: null` explicitly. `applySelection` emits it
  unchanged in the existing `place-selected` detail (`:637-639`) and in the
  `onSelect` call (`:635`); `place-coordinates` (`:640-642`) gains only
  `selectionId` (§3.2), nothing else.
- The host stores it beside the identity it already stores
  (`indexMVP.html:1638-1642`): `state.locations.curated = (detail.curated
  && detail.curated.placeId === placeId) ? { terminalId, companyKey } :
  null` — the guard now has a `placeId` to compare, so valid metadata is
  kept, a mismatch or a Google row clears it. The same handler stores
  `state.locations.selectionId = detail.selectionId` (§3.2: the autocomplete's
  sequence number for the selection that produced this identity) and nulls
  `state.locations.resolution` (§3.3). All three are nulled wherever
  `placeId` is nulled (`:1681-1682`, `:1611`). Renderers never trust the
  metadata alone: they re-derive the terminal from the registry by
  `state.locations.placeId` and use `companyKey` only if that company sails
  from that terminal; with `companyKey` null (a sheet row names a terminal,
  not a company) the reminder lists the terminal's companies as the sheet
  row does.
- Contract tests (`tests/curated-autocomplete.test.js`): success path
  carries the metadata; null-coordinate fallback carries it; a subsequent
  Google selection clears it; a mismatched `placeId` is rejected.

### 3.2 Selection lifecycle: a synchronous start boundary, one record per selection (0277 #3; 0285 #2)
**Facts the contract is built on (main `cc84afd`).** `selectSuggestion`
(`autocomplete.js:511-614`) bumps `selectionSequence` (`:524`) and then
awaits Details; it emits NOTHING to the host before that await resolves.
The winning-result guards are `:558` (success) and `:589` (catch) — not
`:285-306`, which v1.4 cited wrongly. The fallback (`:596-612`) applies the
curated label with null coordinates; a curated row can never reach
`showError` (`:600-603`), because its label and place ID are always
present. After the await, `applySelection` (`:616-646`) emits `onSelect` →
`place-selected` → `place-coordinates`, in that order. So any host rule
keyed on `place-selected` (v1.4's "opening intent") runs AFTER the
response, and a sheet dismissed in between would meet a brand-new intent
and reopen; Confirm/Skip would stay enabled while the second tap's Details
was still pending. Both reproduced in-memory on the real code.

**The boundary (autocomplete side).** `selectSuggestion(index)` becomes a
thin wrapper over `selectItem(item)` (today's body), and the sheet's
create-mode row tap calls `selectItem({ source: 'curated', row })` with a
registry row built by the matcher's own row builder for that terminal
(`companyKey: null` — the sheet lists terminals; one exported helper, so
the two row shapes cannot drift). BOTH entry points — dropdown click/Enter
(`:504-506`, `:752-756`) and the sheet row — therefore run the same code.
`selectItem` dispatches, synchronously, right after `cancelPendingSuggestions()`
and `++this.selectionSequence` and BEFORE anything is awaited:
```
input.dispatchEvent(new CustomEvent('selection-started', { detail: {
  selectionId: selectionSequence,          // the autocomplete's number for THIS selection
  placeId,                                 // curated.placeId or the prediction's place_id
  source: 'curated' | 'google',
  curated: curated ? { terminalId, companyKey, placeId } : null
}}))
```
It carries no Google content (a place ID plus LinkMia's own registry
fields). It fires before the session-token/params code (`:538-551`), which
is untouched: token generation, `sessionLastActivityTime`,
`sessionRequestCount`, the Details request and `clearSession` (`:644`)
keep their exact order and bytes (0284: the released handling stays). The
completion events carry the same identity: the `place` object built on both
paths gains `selectionId` beside `curated` (§3.1), and `applySelection`
includes `selectionId` in the `onSelect` payload, the `place-selected`
detail and the `place-coordinates` detail. The dropdown list under the
sheet's backdrop clears when the selection applies, as today.

**The host record.**
```
state.terminalFlow = null | {
  generation,            // host counter, see below
  selectionId,           // the selection this record is about (null for Change terminal)
  placeId,
  stage: 'settling' | 'open' | 'closed' | 'continued'
}
state.selectionGeneration   // increments on every selection-started, validation-cleared, mode reset (:1611), Change terminal
```
A record whose `generation` is not current is dead. v1.4's 'opening' stage
is gone: **nothing is ever allocated on a completion.**
- **`onSelectionStarted(detail)`** — a new live handler bound beside the
  three existing ones (`indexMVP.html:1157-1167`), `if (this._editRoute)
  return` like them (PR-B's Change-route lane is untouched): `generation++`;
  a Google row, or metadata that fails §3.1's validation (placeId mismatch,
  or not a verified registry terminal) → `terminalFlow = null` (the terminal
  intent is cleared) and return; otherwise `terminalFlow = { generation,
  selectionId, placeId, stage: 'settling' }`, then `openTerminalSheet('create')`
  — idempotent: it opens the sheet if closed (the FIRST pick opens it on the
  tap itself) and re-renders it if open; the tapped row shows "Checking…";
  **Confirm and Skip are disabled at this instant.** The intent is consumed
  here, once, before any await.
- **`onAddressCoordinates(detail)`** — the live wrapper (`:1513-1518`;
  restoration and hydration still call `handleAddressCoordinates` directly
  and never reach it):
  ```
  handleAddressCoordinates(detail)                       // state, invalidateQuote, as today
  const f = state.terminalFlow
  if (!f) { maybeAutoAdvanceAfterRouteSelection('address'); return }   // no terminal intent: today's behaviour (Google row)
  const live = f.generation === state.selectionGeneration && f.selectionId === detail.selectionId
  if (!live) return                                      // a terminal intent exists but this is not its selection: nothing
  if (f.stage === 'settling') { f.stage = 'open'; sheet.settled() }   // row marked from state, buttons enabled
  // 'open', 'closed', 'continued': a late or duplicate result changes nothing
  ```
  A completion can only settle the record its own `selectionId` names; it
  never creates one. The auto-advance for a terminal pick is never taken by
  the wrapper; it is taken once by `continueAfterSheet()`. The existing
  pins that `maybeAutoAdvanceAfterRouteSelection` is called only from the
  two live wrappers (`tests/booking-route-auto-advance.test.js`) stay true.
- **Re-selection inside the sheet (create mode).** Tapping row B runs the
  boundary before the await: a NEW record `{ generation+1, selectionId: B's,
  placeId: B, stage: 'settling' }`, "Checking…", Confirm/Skip disabled
  immediately. The autocomplete's own sequence bump means an in-flight A
  result is dropped at `:558`/`:589` before it reaches the host. B's
  completion (coordinates, or the null-coordinate fallback — both are
  `applySelection`) settles B's record → 'open', row marked, buttons
  enabled, address box shows B. A → B → C in quick succession: only C's
  result reaches the host (verified in-memory on the real guard) and only
  C's record is live.
- **Close while settling.** Any close sets `stage: 'closed'` (the record
  stays, so a late completion for the same `selectionId` settles nothing
  visible: no reopen, no advance), closes the sheet and focuses the input
  with its text selected. If B's result then lands, the state and the
  address box become B because the autocomplete applies it (the dropdown's
  own behaviour for a selection in flight, unchanged); the sheet stays
  closed. Details failure → the fallback applies B with null coordinates
  (`:596-612`) — same outcome.
- **Typing after a close** → `validation-cleared` → `generation++`,
  `terminalFlow = null`; the autocomplete's own `++selectionSequence`
  (`:192`) has already made the pending result lose its guard. **Close and
  type a hotel** → the Google row's boundary keeps `terminalFlow = null` →
  its completion takes today's auto-advance.
- **Confirm / Skip** call `continueAfterSheet()`: refused unless the record
  is current and `stage === 'open'`; otherwise `stage = 'continued'`, close
  the sheet, then `if (canContinue()) navigateToPanel('when') else stay on
  Where` (Going to Airport before the airport is chosen: the airport grid is
  next; Change terminal from When in either direction: the route is
  complete, so back to When). Runs at most once per record: a second tap or
  a late event finds 'continued'.
- **Change terminal (When) — with the reopening guard (0286 #2).** v1.5 let
  a completion still pending from before (Going to Airport: A committed,
  B tapped, Details pending, closed, airport tapped, When, Change terminal)
  apply B after the sheet had reopened on A — Confirm could accept A and
  B's late completion silently replaced it. The prescribed contract: (1)
  **first** invalidate any earlier in-flight autocomplete selection with
  the existing `autocomplete.invalidateRawCapture()`
  (`autocomplete.js:826-829`, main `cc84afd`): its sequence advances, so a
  pending Details result loses the winning guards (`:558`/`:589`) and
  produces NO completion callbacks or events — it can neither mutate nor
  replace the committed selection; (2) then `generation++`, derive the
  COMMITTED terminal/selection from `state.locations`, allocate
  `terminalFlow = { generation, selectionId: null, placeId:
  state.locations.placeId, stage: 'open' }`, `navigateToPanel('where')`
  and open the sheet directly (no selection happens, so no boundary
  event); (3) A's visible label, selected identity, `isValidated` and the
  current resolution evidence are preserved — `clearValidation` is never
  used here and no new Details call is made merely to reopen. Ordinary
  close-without-reopen keeps the v1.5 behaviour: its winning selection may
  still apply silently while the panel stays closed.
- **Inert events.** Focus, blur, Back/forward between panels, host restore
  (`resumeAccountBookingWhenReady` paths), hydration, re-render, the map's
  completion (R4), the summary bar: none of them opens, closes or advances;
  they read state only. The sheet's marked row and the When reminder are
  always derived from state at render time.
- **Proofs (0285 #2).** (1) B pending → Confirm and Skip refused and
  rendered disabled; (2) B pending → close → late success OR the
  null-coordinate fallback → sheet stays closed, no advance, box shows B;
  (3) close → type a hotel → A's old result is rejected (by the autocomplete
  guard, and the host record is null anyway) → the Google row takes today's
  advance; (4) A → B → C → only C settles; (5) ONE synchronous
  `selection-started` event before Details, zero COMPLETION
  callbacks/events until the winning Details result, then `onSelect` →
  `place-selected` → `place-coordinates` (the order the contract relies
  on, pinned; the unmodified-main baseline was zero host events of any
  kind before the response); (6) the 0286 #2 regression, both Details
  outcomes: A → B pending → close → airport → When → Change terminal →
  Confirm A → B resolves / B rejects → A stays selected and confirmed, no
  late reopen, no advance, no B mutation, resolution evidence intact.

### 3.3 Canonical guard: an identity-bound resolution record (0277 #4; 0285 #3)
**Facts (main `cc84afd`).** `reconcileQuoteLabel` (`indexMVP.html:3162-3178`)
deliberately keeps `state.locations.placeId` as the SUBMITTED ID for
quote-key stability and rewrites only the display address.
`invalidateQuote` (`:2845-2863`) — reached by a pickup-time change
(`:2552-2555`), a passenger change, any new selection — clears the quote's
status, key and data but touches neither `placeId` nor the rewritten
address. v1.4's guard read the live quote, so an ordinary time change
erased its evidence while Google's address stayed: the obsolete terminal
reappeared beside it (reproduced in-memory with the real `quoteIntent`,
`quoteKey`, `invalidateQuote` and `reconcileQuoteLabel`: superseded → time
change → not superseded, submitted ID unchanged, Google's address present).

**The record.** Resolution evidence lives with the ADDRESS SELECTION, not
with the price quote:
```
state.locations.resolution = null | { placeId, selectionId, canonicalPlaceId }
```
- **Written in exactly one place:** the quote-ready branch of
  `requestServerQuote` (`:3134-3137`, beside `reconcileQuoteLabel`), which
  is reached only after both `seq` rechecks (`:3071`, `:3081`) — i.e. only
  by the winning response for the CURRENT intent:
  `resolution = { placeId: state.locations.placeId, selectionId:
  state.locations.selectionId, canonicalPlaceId: quote.intent.placeId }`. A
  later winning matching quote overwrites it (a refresh). The forced
  requote on the Book tap (`:4155`) reaches the same branch.
- **Never touched by `invalidateQuote`:** it survives pickup-time,
  passenger, vehicle, flight and every other pricing-input change, a
  requote that is loading, and a requote that failed.
- **Cleared exactly where the passenger changes or drops the identity:**
  `handleAddressSelected` on a live completion (`:1638-1642`, which also
  stores the new `selectionId`, §3.1), `handleAddressValidationCleared`
  (`:1681-1682`), `resetSelections` (`:1611`). A restored saved booking
  starts with `resolution = null` and `selectionId = null`.
- **A delayed old quote cannot poison a later selection:** a new selection
  bumps `q.seq` through `invalidateQuote`, so the old response is dropped
  at `:3071`/`:3081` before the ready branch; and a record written for an
  earlier selection cannot apply anyway, because the guard compares both
  `placeId` and `selectionId` with the current selection.
- **Never overwrites** `state.locations.placeId`, the quote key or the
  quote data (0277 #4).
```
function selectedTerminalDisplay() {
  const selected = state.locations.placeId
  if (!selected) return null
  const r = state.locations.resolution
  const evidence = (r && r.placeId === selected && r.selectionId === state.locations.selectionId) ? r : null
  if (evidence && evidence.canonicalPlaceId !== selected) return { superseded: true }   // Google resolved this address to a different place
  const terminal = registry.byPlaceId[selected]
  return terminal ? { superseded: false, terminal, company: companyFor(state.locations.curated, terminal) } : null
}
```
No quote status enters the decision.
- The When reminder renders only for `{ superseded: false }`; the
  mismatch-quote → Back to When case shows no reminder (the summary bar
  shows Google's address, as `reconcileQuoteLabel` set), and it STAYS hidden
  after a pickup-time or passenger change, while the requote is loading, and
  after it failed — until a later winning matching resolution or a new
  deliberate selection provides new identity evidence.
- Change terminal is still offered from the summary bar's Edit as today; if
  the sheet is opened while superseded (Change terminal from the reminder
  cannot happen, since the reminder is hidden; the card path in R2 reads the
  hydrated route, not the create state), it opens with **no row marked** and
  the line "Google resolved this address to a different place. Pick a
  terminal, or close to keep the address." A pick is a new selection → the
  record is cleared with the identity and `invalidateQuote` runs (existing,
  `:1661`) → the reminder shows the new terminal until the next winning
  quote says otherwise. The submitted `placeId` is never overwritten.
- Tests: resolution equal → reminder shown; different → hidden on the next
  render, after Back from Vehicle, after mismatch → change time → requote
  loading → Back, after mismatch → change time → requote failed → Back, and
  after mismatch → change passengers → Back; a deliberate re-pick of the
  same terminal → shown again until the next winning quote; a later winning
  quote resolving to the registry ID → shown again; `state.locations.placeId`
  and `state.quote.key` never written by the record; a stale old response
  dropped by `seq` never writes it; the superseded sheet has no marked row
  and its copy line. (The v1.5 record was run through the same in-memory
  probe: suppressed across the time and passenger changes and the
  loading/failed requote, cleared only by a new selection, refreshed by a
  later winning quote.)

### 3.4 Trip page: derived `terminal` with explicit projection
`/api/booking-status` selects `booking_mode, canonical_place_id,
route_authority` beside `PASSENGER_FIELDS` (`lib/cancel-core.js:51`
unchanged), derives `terminal: { name, side }` through
`lib/curated-places.js` `findVerifiedTerminal` when `route_authority =
'canonical'` and the ID is a verified terminal, then **deletes the three
columns before serializing**, as it does for `assigned_driver`
(`backend/functions/booking-status.js:85`, `:114-120`). Non-port, legacy and
unverified rows carry no `terminal` key. The page fetches no registry.

### 3.5 Driver handoff (R3; unchanged from v1.3)
Leg-aware `navigation: { pickup: { placeId }, dropoff: { placeId } }`
derived by one shared helper for both driver response paths from
`booking_mode` + `canonical_place_id` + `route_authority`, source columns
stripped, omitted on pending offers; `navigationUrl` appends
`&destination_place_id=` only for the leg matching the action, text
destination kept; claim limited to terminal identification until the V
pilot (Andres's separate authorization).

### 3.6 View spot dependencies (R4; unchanged from v1.3)
Authenticated `GET /api/place-spot?placeId=` limited to verified registry
IDs, Places API (New) field mask `id,navigationPoints,entrances`, no
persistence; the map area in the sheet; the terms question added to the
checklist; the V pilot.

### 3.7 State / transition table (create flow unless marked edit)
| State | Event | Outcome |
|---|---|---|
| Where, no selection | Google row picked | boundary: gen++, `terminalFlow = null`; completion → today's selection and auto-advance |
| Where, no selection | LinkMia row picked | boundary (before the await): record `{gen, selectionId, placeId, settling}`, sheet opens NOW, row "Checking…", Confirm/Skip disabled; completion → `open`, row marked, buttons enabled; no auto-advance |
| Sheet open | row B tapped | boundary before the await: new record (gen+1, B's selectionId, `settling`), "Checking…", Confirm/Skip disabled at once |
| Sheet open, settling | B's completion (coordinates or null-coordinate fallback) | settles the record its selectionId names: `open`, B marked, buttons enabled; address box shows B |
| Sheet open, settling | A's late result | dropped by the autocomplete's guard (`:558`/`:589`) before the host; nothing |
| Sheet open or settling | Confirm / Skip | refused unless the record is `open`; else `continued`, close, When if the route is complete, otherwise Where (airport grid) |
| Sheet open or settling | slide / ✕ / backdrop / Escape | `closed`, close, stay on Where, input focused + selected; no advance |
| Sheet closed | late completion for the same selectionId | state and address box update (the autocomplete applies it); sheet stays closed; no advance; nothing allocated |
| Sheet closed | typing | `validation-cleared`: gen++, record null; identity, text and resolution cleared together; the autocomplete's own sequence bump drops the pending result |
| Sheet closed | typing a hotel → Google row | boundary keeps `terminalFlow = null`; completion → today's auto-advance |
| Sheet closed | focus / blur / Back / re-render / restore / hydration | nothing |
| Sheet closed | Continue (dropoff: after the airport tap; pickup: manual) | today's advance; When renders the reminder if not superseded |
| When | reminder render | shown iff `selectedTerminalDisplay().superseded === false`; absent for non-terminal addresses |
| When | Change terminal | FIRST `autocomplete.invalidateRawCapture()` (an older in-flight selection produces no completion and cannot mutate the committed terminal; 0286 #2), then gen++, record `{gen, selectionId: null, placeId, open}`, Where, sheet opens with the COMMITTED row marked (or none, if superseded); label, identity, validation and resolution evidence preserved; no Details call |
| Vehicle | winning quote resolves the submitted ID to a different ID | `reconcileQuoteLabel` (address only) + resolution record `{placeId, selectionId, canonicalPlaceId}` |
| Vehicle → When (Back) | resolution ≠ submitted ID | reminder hidden; summary bar shows Google's address |
| When | pickup time / passengers changed after a mismatch; requote loading or failed | `invalidateQuote` only; the resolution record survives; reminder stays hidden |
| Any | deliberate new address selection | `placeId`, `selectionId`, `curated` replaced and `resolution` cleared together; reminder from the new identity; the next winning quote writes a new record |
| Any | host restore / hydration | state handlers only: no sheet, no advance, reminder from state; `resolution` and `selectionId` start null |
| Edit: card open | Change terminal | sheet opens in edit mode, current hydrated terminal marked; nothing staged |
| Edit: sheet open | row tapped | staged only; no autocomplete, no coordinates, no quote |
| Edit: sheet open | cancel (slide / ✕ / backdrop / Escape) | staged discarded; draft untouched; focus back to the opener |
| Edit: sheet open | Confirm, staged = opening identity | close; nothing changes; no quote |
| Edit: sheet open | Confirm, staged = saved snapshot's identity (reversal) | `withAddress` then the existing saved-ROUTE restore; `scheduleQuote()`; the full-draft comparator decides: zero quotes only if the complete intent matches the snapshot or a fresh held quote covers it; unrelated draft changes kept |
| Edit: sheet open | Confirm, staged = new identity | `withAddress`, `scheduleQuote()`, "Updated total", Save path as today |
| Edit: any | Save / Discard / lifecycle handoff | as today; the sheet never outlives the card |

### 3.8 What is untouched
The priced route endpoint, the canonical place ID resolved once and used on
both endpoints (`backend/functions/quote-ride.js:425-459`, echoed `:613-621`),
the signed commitment (`backend/functions/lib/quote-token.js:173-194`), the
quote trigger (first call when the Vehicle panel opens, `:1987-1990`; a
change invalidates; the price binds at Book), `details_version` CAS,
envelope and retry, pricing rules, passenger default 1, the dropdown design,
the service-worker pair until a release is cut. The session-token handling
(`autocomplete.js:538-551`, `clearSession` `:644`) and the Railway
request shape: the boundary event fires before them and changes nothing
(0284). `invalidateQuote` (`:2845-2863`) is not modified: the resolution
record is written and cleared elsewhere (§3.3). No client coordinate is
ever sent to the server; `state.locations.placeId` is never overwritten by
a quote echo or by the resolution record.

## 4. Delivery sequence and PR boundaries (0277 #5; 0284 supersedes 0282 #4's F1-first order)
| Step | Scope | Server / DB | Ships |
|---|---|---|---|
| F1 session-token fallback | **SKIPPED** — Andres's decision (relay 0284, 2026-10-27): the released Google request/session handling stays; it was an optional billing choice, not a defect or a prerequisite. The packet `docs/plans/session-token-fallback-packet.md` is kept as a record only and is reopened only if Andres says so | none | not scheduled |
| R1 confirm | §2.2 sheet in create mode (no map) + §2.3 When reminder + §3.1 metadata + §3.2 boundary, lifecycle and the 0286 #2 reopening guard + §3.3 resolution record + §2.4 trip reminder (no new action) + §3.4 projection | booking-status read-side | **IN PROGRESS**: branch `feature/terminal-confirmation-r1` from main `cc84afd` (Codex GO 0286; Andres's go 0287: draft PR + Netlify Deploy Preview, no merge under that instruction) |
| R2 picker | §2.6 edit mode of the same sheet + model `withAddress` + the trip page's Change terminal link with `focus:'terminal'` | none | after R1 |
| R3 driver | §3.5 | read-side field lists | independent; V pilot after deploy |
| R4 View spot | §2.5 + §3.6 | read function | after the terms question; V pilot evidence |
| Parallel | Terminal C/J research (verified-subset follow-up, never an R1 gate); driver-row contact check (Andres, production data); UX follow-ups: first-focus lazy load, payment placeholder label | — | — |
| Separate proposals | ship name (existing column, owner endpoint); stored confirmation (migration); LinkMia-authored meeting point | each its own review | not prerequisites |

Cache pair: R1 touches precached booking assets → next unused pair at
release time (not now); trip.html is network-first; driver.html is under its
own worker (`service-worker.js:216-220`).

## 5. Acceptance (0276 #6, 0277 #3 cases)
- Metadata: success, null-coordinate fallback, Google row clears,
  mismatched placeId rejected (§3.1).
- Lifecycle, both directions: the tap opens the sheet once, synchronously,
  with Confirm/Skip disabled until the selection settles; `selection-started`
  fires before any await, from the dropdown (click and Enter) and from the
  sheet row alike, and the session-token/Details request bytes are
  unchanged; delayed Details success and failure settle the same record;
  A → B → C (only C settles); B pending → Confirm/Skip refused; B pending →
  close → late success or fallback (no reopen, no advance, box shows B);
  close and type a hotel (old result rejected; Google path, today's
  advance); continue exactly once; late or duplicate results after
  `continued` do nothing; Change terminal with a completion still pending
  (0286 #2, both outcomes): A → B pending → close → airport → When → Change
  terminal → Confirm A → B resolves / rejects → A remains selected and
  confirmed, no late reopen, no advance, no B mutation, evidence intact;
  focus/blur/Back/re-render inert; restore and hydration never open the
  sheet or advance; the `maybeAutoAdvanceAfterRouteSelection` call-site
  pins unchanged; one synchronous `selection-started` event before
  Details, zero COMPLETION callbacks/events until the winning Details
  result, then `onSelect` → `place-selected` → `place-coordinates`
  (pinned; 0286 #5 wording — the zero-host-event observation was the
  unmodified-main baseline).
- Resolution record: equal resolution shows the reminder; a different one
  hides it, also after Back from Vehicle, after mismatch → change time →
  requote loading → Back, after mismatch → change time → requote failed →
  Back, and after mismatch → change passengers → Back; a deliberate re-pick
  resets; a later winning quote refreshes; a stale response dropped by
  `seq` never writes it; the superseded sheet has no marked row;
  `state.locations.placeId` and the quote key unchanged throughout.
- Change terminal: Where with the input focused and selected; nothing
  cleared on tap; first keystroke clears identity and text together
  (`:1673-1687`); airport, mode and date untouched; Confirm/Skip return to
  When when the route is complete.
- Trip reminder (R1): status × direction copy in the polling harness with
  exact fetch counts; absent without `terminal`; embedded and standalone
  edit paths byte-identical to today; the public payload has no
  `booking_mode`, `canonical_place_id` or `route_authority` key. R2: the
  link posts `focus:'terminal'` in both paths.
- Edit mode (R2): staged-only taps (no autocomplete, no coordinates, no
  quote); cancel restores the opening draft including unrelated changes;
  Confirm with the opening identity is a no-op; changed A → B → reopen →
  cancel leaves B; changed A → B → choose saved A → Confirm restores the
  saved route tuple — zero quotes when nothing else changed, one quote when
  the time (or any other intent field) also changed; a new identity buys
  one quote; payload shape unchanged; forbidden-words pin kept.
- Driver (R3) and View spot (R4): as v1.3.
- **V pilot** (Andres's separate authorization): the map's point for
  Terminal V and where the driver's Maps app lands are compared on the day
  and recorded here before any copy links the two.

**Acceptance record — R1 desktop (2026-10-28, head `b19b131`, PR #122,
preview deploy-preview-122 / Netlify deploy `6ae16050ff3d5a8300c73e03`,
permalink `6ae16050ff3d5a8300c73e03--i-love-miami.netlify.app`, signed in
with Andres's account in the desktop app's built-in browser, real clicks,
keystrokes, a pointer drag and state reads from the live page; NO booking
submitted):** the preview serves the R1 code (service worker
`linkmia-v1.3.51` / `linkmia-runtime-v28` activated, `TerminalSheet` and
`CuratedPlaces.terminalRow` present, the new state fields on boot).
PASSED — Going to Airport: "Virgin" renders the LinkMia Terminal V row;
the tap opens the sheet SYNCHRONOUSLY (read before the lookup answered:
dialog/aria-modal/labelled title, eight rows, Terminal V "Checking…",
Confirm and Skip disabled, record `settling`, identity still unset, focus
on the checking row, the booking card inert); the lookup settles it
(Terminal V "Selected", buttons enabled, LinkMia's label in the box,
registry metadata and selection number stored); Confirm closes the sheet
(record `continued`), stays on Where with focus on the airport grid; the
MIA tap advances once; When shows "Pickup: PortMiami Terminal V · Virgin
Voyages", the pickup line and Change terminal, summary "PortMiami Terminal
V → MIA". Change terminal: Where plus the sheet on the COMMITTED terminal
(record `{selectionId: null, open}`, the autocomplete sequence advanced,
validation and label preserved, no new Details request); tapping Terminal
A re-records synchronously (V "Selected" + A "Checking…", buttons
disabled), settles to A "Selected" with A's label, metadata `companyKey
null` (a sheet row); Confirm returns to When with "Pickup: PortMiami
Terminal A · Royal Caribbean", focus on Today. Dismissals — Escape, ✕,
backdrop, and a pointer drag of the handle — each close the sheet (record
`closed`, no overlay left, inert lifted), stay on Where with the address
box focused and its text selected; Continue reaches When each time with
the reminder intact. Keyboard: focus enters the marked row; Tab/Shift+Tab
move through the rows; ten Tabs wrap to ✕ inside the dialog; Escape
closes. Typing over the selection clears identity, metadata, selection
number, resolution and the record together (generation bumped, reminder
hidden, airport kept). Arriving at Airport: the mode switch resets
everything and closes nothing stale; MIA then "Carnival" lists D/E/F;
the Terminal E tap opens "Confirm drop-off terminal" with the drop-off
line; the completion does NOT auto-advance (route complete, panel stays
Where); Skip goes to When exactly once ("Drop-off: PortMiami Terminal E ·
Carnival Cruise Line", focus on By flight arrival); a second
continueAfterSheet() is refused. Back, Continue, focus and blur never
reopen the sheet; the reminder re-renders from state. Exactly three
Details requests for three taps, none for the reopenings. Console: no
R1 errors — only the proxy failures below and their expected app lines.
BLOCKED (configuration, not R1): the Railway proxy still rejects the
preview origin — the browser's autocomplete, Details and directions calls
from `https://deploy-preview-122--i-love-miami.netlify.app` are refused
with no `Access-Control-Allow-Origin`; preflights from the exact origin
answer 500 while deploy-preview-120 and linkmia.com answer 200; Railway
shows NO deployment of the proxy service `reliable-warmth` after the #121
merge (2026-10-27 21:29Z) and no staged changes, so the `ALLOWED_ORIGINS`
edit is not live (the project also has an `AirportMVP` service — the
edit must be on `reliable-warmth`, production, exact origin with
`https://`, no trailing slash, and that service must redeploy). So every
selection settled through the null-coordinate FALLBACK (a real path, not
the success path); Google's rows never rendered. NOT verified on this
preview: the Details success path (coordinates, "Route estimate" on
When), the hotel/Google-row path, the resolution record on a real quote
(preview pricing env unset by decision), phone swipe and real-device
drag feel, the trip-card reminder on a real row, and Andres's own visual
review of the sheet. Observation (preview UI, not ours): Netlify's
"Deploy Preview" pill sits over the Skip button at the sheet's bottom on
this desktop viewport; Skip stayed reachable by keyboard.

**Success-path rerun (2026-10-28, ~05:02–05:12Z, same head `b19b131` and
preview, after Andres authorized the allowlist change in chat — Claude set
`ALLOWED_ORIGINS` on the Railway service `reliable-warmth` (production)
through the Railway connector to the three production origins
(`https://linkmia.com`, `https://www.linkmia.com`,
`https://i-love-miami.netlify.app`) plus
`https://deploy-preview-122--i-love-miami.netlify.app`, removing the
deploy-preview-120 entry on Andres's instruction; the value was written
whole without reading the service's variables back, so the private Maps
key never entered the transcript; Railway deployment `a25d6463` went live
at 05:02Z; preflight from the preview origin then 200, the production
origins 200, deploy-preview-120 refused):** "Virgin" lists the LinkMia
Terminal V row under "LinkMia terminals" and Google's five rows under
"Google suggestions" with one Google logo; the Terminal V tap opens the
sheet synchronously as before and the Details SUCCESS settles it with
coordinates (25.7800848, −80.179946) and the selected-place attribution
visible; Confirm, then MIA → When shows the reminder plus "Drop-off at
airport approx. 1:39 AM" and "Estimated ride duration of 24 min (live
data)" (13.5 mi / 24 min, Google Maps attribution visible). Hotel path,
Going to Airport: Back, "Fontainebleau" → Google rows only; the first row
(Fontainebleau Miami Beach → "4441 Collins Ave, Miami Beach, FL 33140,
USA") opens no sheet, records no terminal intent, stores coordinates and
stays on Where (an address never completes this direction); Continue →
When without the reminder ("4441 Collins Ave → MIA"). Hotel path,
Arriving at Airport: mode switch, MIA, "Fontainebleau" → the first row
takes today's auto-advance to When, no sheet, no reminder. Console after
the fix: no new errors. STILL NOT verified: the resolution record on a
real quote (preview pricing env unset by decision), phone swipe and
real-device drag feel, the trip-card reminder on a real row, and Andres's
own visual review of the sheet. Follow-up proposed (not R1): a proxy rule
admitting this site's Netlify deploy previews by pattern, so the
allowlist stops changing per PR — its own PR.

## 6. Separate proposals (not prerequisites; each needs its own review)
Ship name (existing `cruise_ship` column, owner-only endpoint, guarded UPDATE
outside the pricing RPCs); stored terminal confirmation (migration;
driver-side signal only — a view-only sheet stores nothing); LinkMia-authored
meeting point (coordinates only from a documented on-site survey approved by
Andres; the Terminal V evidence on file is Google's returned points plus
Andres's visual acceptance, not a survey).

## 7. Decisions (Andres) and what remains
Decided 2026-10-27: the sheet on the pick with Confirm and Skip; the When
reminder; Change terminal reopens the sheet; slide-down to type a new
address; no reopening on focus, typing, restore or a late response; the map
later inside the same sheet; R1 without any map control; the dropdown
released as a verified subset first; F1 skipped (0284); v1.5 passed Codex's
targeted check with the two 0286 amendments (recorded here as v1.6); R1
implementation authorized (0287). Remaining: (1) Codex's review of the R1
implementation on the draft PR and its Deploy Preview; (2) shared preview
testing (both directions, terminal changes, delayed/failed lookups,
dismissal/reopening, keyboard/focus, phone swipe — no booking submitted);
(3) Andres's merge/release decision; (4) R3 as its own PR; (5) R4 after
the terms question and the V pilot; (6) ship name / stored confirmation as
separate proposals; (7) airport-side place IDs later.

## 8. Answers to relays 0277, 0282 (§3–§4), 0284, 0285 and 0286
Items 1–7 answer 0277 (kept from v1.4; item 3's mechanism is now the
boundary of §3.2 and item 4's the record of §3.3). Items 8–11 answer 0284
and 0285; items 12–13 answer 0286.
1. **Confirmed rule recorded** (§2.2, §3.2, §3.7): dismissal never reopens
   on focus, typing, restore or a late response; only a deliberate pick or
   Change terminal reopens; a hotel address continues without the sheet.
2. **Metadata contract fixed** (§3.1): `curated` now carries `placeId`, is
   validated against the top-level selection ID, travels through both the
   success and the Details-fallback paths, and a Google row clears it
   explicitly; four contract tests named.
3. **Lifecycle specified** (§3.2, §3.7): a per-generation record with a
   consumed opening intent and a deferred advance; dismissal cancels the
   intent so a late result can neither reopen nor advance; the live-wrapper
   vs state-handler boundary (`indexMVP.html:1513-1518`) is the only place
   the decision runs; Confirm/Skip refused while a re-selection is settling
   and taken at most once; the test list in §5 covers delayed success and
   failure, A → B → C, close-before-response, close-and-type-hotel,
   Confirm/Skip while pending, both directions, restore and hydration.
4. **Echo guard made explicit** (§3.3): the reminder and the sheet's marked
   row depend on the current matching quote's canonical ID, not on the
   registry lookup alone; the submitted `placeId` is never overwritten; the
   mismatch → Back to When case and the superseded sheet are defined and
   tested.
5. **R1 usable on its own** (§2.4, §4): the trip-page reminder ships in R1
   with accurate wording that routes through the existing Manage ride /
   Change route experience; the Change terminal link and `focus:'terminal'`
   move to R2 with the sheet's edit mode; embedded and standalone paths are
   tested unchanged in R1.
6. **Edit-scoped rules** (§2.6, §3.7): the sheet stages in edit mode and
   applies in create mode; cancel returns focus to the opener and leaves the
   draft untouched; Confirm compares with the opening draft, and restoration
   to the saved snapshot stays the existing comparator's job, so choosing
   the saved terminal after an earlier change is a real reversal.
7. **Limits acknowledged**: the mockup is visual evidence only (synchronous
   rendered divs); the network race, real typing, focus containment, phone
   swipe, pricing, saved booking and driver navigation are untested for
   this feature until R1 exists.
8. **F1 removed as a gate** (0284; 0285 #1): §4 records the session-token
   fallback as SKIPPED by Andres's decision, the released handling stays,
   §7 no longer lists a separate F1 approval, and R1 is based directly on
   main once this plan passes the check. No application code changed.
9. **Selection-start boundary** (0285 #2; §3.2, §3.7, §5): v1.4 keyed the
   intent on `place-selected`, which the real `applySelection` emits only
   AFTER Details — reproduced in-memory on the real code (zero host events
   before resolution; then `onSelect` → `place-selected` →
   `place-coordinates`), so a dismissal could be followed by a fresh
   opening intent and Confirm/Skip stayed enabled while a second tap was
   pending. v1.5 dispatches a synchronous `selection-started` event inside
   `selectItem`, right after the sequence bump and before any await, from
   both entry points (dropdown click/Enter and the sheet row, which now
   share `selectItem`), carrying `selectionId`, `placeId`, `source` and
   the curated metadata; the host allocates the generation, consumes the
   intent, opens the sheet and disables Confirm/Skip there; completions
   carry the same `selectionId` and can only settle that record, never
   create one; Google rows clear the intent; typing and the mode reset
   invalidate it; hydration stays inert; the session-token code is
   untouched. The guard citation is corrected to `:558`/`:589`. The four
   requested proofs are in §3.2 and §5.
10. **Resolution record** (0285 #3; §3.3, §3.7, §5): reproduced in-memory
   with the real `quoteIntent`, `quoteKey`, `invalidateQuote` and
   `reconcileQuoteLabel` (superseded → pickup-time change → not superseded,
   submitted ID unchanged, Google's address still displayed). v1.5 keeps
   `state.locations.resolution = { placeId, selectionId, canonicalPlaceId }`,
   written only by the winning matching quote response, untouched by
   `invalidateQuote`, cleared only with the identity (new selection,
   validation clear, reset), refreshed by a later winning quote; the guard
   compares the record's `placeId` and `selectionId` with the current
   selection and never reads quote status; the submitted ID and the pricing
   key are never overwritten; the mismatch → change time → loading/failed →
   Back cases are added to the tests and acceptance.
11. **R2 reversal wording** (0285 #5; §2.6, §3.7, §5): choosing the saved
   terminal restores the complete saved ROUTE tuple when the identity
   matches the snapshot; the existing full-draft comparator and held-quote
   freshness rules then decide quote needs; zero calls only when the
   complete intent is unchanged or a fresh held quote already covers it.
   Does not block R1.
12. **Change terminal reopening guard** (0286 #2; §3.2, §3.7, §5): Change
   terminal now cancels any older in-flight autocomplete selection with
   the existing `invalidateRawCapture()` BEFORE reopening on the committed
   terminal, preserving label, identity, validation and resolution
   evidence and making no Details call; a pending result from before the
   reopen produces no completion and cannot mutate the confirmed
   selection. The regression scenario (both Details outcomes) is in §3.2's
   proofs and §5, and executed by `tests/terminal-confirmation.test.js`
   (C9) against the real `selectItem`, `applySelection` and
   `invalidateRawCapture`.
13. **Boundary wording** (0286 #5; §3.2 proof 5, §5): the implemented
   expectation is one synchronous `selection-started` event before
   Details and zero COMPLETION callbacks/events until the winning result,
   then `onSelect` → `place-selected` → `place-coordinates`; the
   zero-host-event observation is kept only as the unmodified-main
   baseline.

## 9. Not in scope
Automatic sailing-assignment lookup; ship names as registry keywords;
photos/logos; confirmed-ride editing (PR 3C-3); passenger push; any change
to pricing, the quote contract, passenger default or the dropdown.
