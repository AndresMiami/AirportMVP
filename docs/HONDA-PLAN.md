# The Honda Plan — making LinkMia easy to understand and easy to fix

**Status:** plan of record for the maintainability pass, written 2026-09-09
from a read-only audit of `main` at 2f83c3e (six independent readers, one
synthesizer, one adversarial verifier per recommendation; every claim below
was checked against the code by a second pass, and the verifiers' corrections
are folded in). Nothing in this document is authorization; each item is its
own PR under the usual branch → PR → Andres merges path.

**The standard, in Andres's words:** "I want a Honda, not a BMW." A mechanic
must be able to open the hood, find the part, and fix it the same day —
without the fix becoming a one-week job. Complexity that protects money or
database truth stays; complexity that only exists by accident goes; and a new
developer gets a map on day one.

---

## 1. How a fix reaches production today (honest timings)

| Bug class | Where it lives | Path to production | Realistic time | Heavy review? |
|---|---|---|---|---|
| Passenger sentence on trip.html / login.html | inline script in the page (trip.html cancel card ~:1139-1219; login.html guest block :262-268) | edit → `node --check` the extracted script → update the suite that pins the sentence → PR → merge; these pages are network-first, no cache bump | 30–60 min | No |
| Passenger sentence on the booking page (indexMVP.html) | inline script (`PICKUP_ELAPSED_COPY` :767 etc.) | same, PLUS the service-worker cache bump because the page is precached (today: two constants, five literal pins, and the prose scan's offender list) | half a day, almost all of it the bump ceremony | No |
| Driver UI (labels, layout, quick messages) | driver.html single script (labels :442-450, card renderer ~:440-600) | edit → `node --check` → tests/driver-identity, departure-window, driver-push-frontend, release-ride → PR → merge; driver.html is excluded from the root worker, so NO cache bump | 1–2 h (half a day if the pinned departure-window region is touched) | No |
| Notification text (Telegram doorbell/receipt, push copy) | lib/notify.js renderEvent :132-197; create-booking.js :87-93; update-pending-booking.js ~:160-175; update-booking-status.js sendReceipt :455-470 | edit template → tests/notification-ledger, dispatch-module, booking-auth, driver-identity → PR → merge; no bump, no migration | ~1 h | No, but the diff lands in money-adjacent files today |
| Backend endpoint bug | backend/functions/<endpoint>.js (11 handlers) + lib/ (12 modules, no index) | edit → `node --check` → grep tests/ for the require path to find the suite → run → PR → merge | 2–4 h; a full day if the bug is in a copy-pasted helper (driver auth = four files) | Yes |
| Pricing / quote bug | lib/ride-rate-card.js + ride-quote.js (golden parity), quote-ride.js, lib/quote-token.js, the booking page's quote state machine | engine/endpoint suites → docs/PRICING_STRUCTURE.md → PR → Codex round → merge (+ cache bump if browser-side) | 1 day server-side; 2–3 days browser-side. This is protective. | Yes |
| Database writer bug (RPC or its JS envelope) | JS: lib/booking-writer.js; SQL: the RPC bodies live in migration files — 018 is INSTALLED, 019 is generated and NOT RUN | JS: half a day–1 day. SQL: a NEW migration (never patch 018/019), regenerated through the transform, preflight + runbook, PGlite chain, Andres-run window | a week or more, dominated by review and the window, not the SQL | Yes |
| Plain migration (column, constraint, view) | database/migrations/NNN_*.sql (next free number 020) | SQL → PGlite chain (fix the chain filter first, see 5.0) → read-only preflight grids one at a time → PITR marker → WATCHDOG_DISABLED=1 + trigger deploy → paste once → verify → unset + redeploy → record | 2–5 days end to end; the SQL itself is an hour | Yes |

**The verdict:** ordinary fixes are already same-day. Two things make some of
them slower than they need to be — the service-worker bump ceremony for
precached files, and helpers copy-pasted across handlers — and two things
slow a newcomer down: no test front door and no operations map. Every one of
those is fixable without changing what passengers or drivers see.

## 2. Fast lane and careful lane (by file)

**Fast lane** — ordinary PR, green suite, merge: trip.html, login.html,
driver.html, driver-sw.js, css/, images/, js/*-modal.js, notification
templates (once extracted, see 5.2), most endpoint logic that does not touch
money or the writers, docs/.

**Careful lane** — the two-reviewer protocol and, where a migration is
involved, the runbook discipline: lib/ride-rate-card.js, lib/ride-quote.js,
quote-ride.js, lib/quote-token.js, lib/booking-writer.js, create-booking.js
and update-pending-booking.js (the writer envelope), lib/cancel-core.js,
lib/dispatch.js and lib/notify.js's ledger semantics, update-booking-status.js
TRANSITIONS, database/migrations/ and tools/, the service-worker cache-name
invariant, and the protected Google path (backend/api-proxy/server.js and
autocomplete.js — behaviour-preserving edits only, revert-first, Andres
field-tests).

**Rule for the future:** when a fast-lane change is forced through a
careful-lane file only because a string or helper happens to live there,
that is a smell to fix in this plan, not a reason to slow the change down.

## 3. What stays exactly as it is (protective complexity)

- The guarded single UPDATE state machine in update-booking-status.js and the
  verified-idempotency classification after it.
- lib/booking-writer.js's fail-closed outcome registry and the byte-exact
  "blocked" string the browser compares.
- lib/cancel-core.js as the ONE cancellation authorization matrix.
- The submission envelope: operationId inside the body, exact-byte single
  retry, registry-shaped "definitive", read-only recovery.
- The migration transform, its byte-pinned generated artifacts, and the
  installed-body fingerprint gates; migrations stay immutable history.
- The forward-only cache-name INVARIANT (both names move together; a burned
  name is never reused). Item 5.1 removes the ceremony around it, not the rule.
- The service worker never intercepting any data API; `private, no-store` on
  every function.
- The .md inventory walk (every tracked .md outside docs/ needs a force-404
  rule) and CI's sentinel rule, 33-suite floor and three-timezone matrix.
- The vehicle-metadata drift guard, the quote-browser vm harness with its
  mutation proofs, and golden-parity pinning of the pricing engine.
- pricing.js and the flag-false branches until enforce is separately
  authorized (they are the reviewed rollback).
- The kill switches (QUOTE_SERVICE_DISABLED, CANCEL_QUOTE_DISABLED,
  PUSH_DISABLED, WATCHDOG_DISABLED, pricing_state 'blocked') and
  QUOTE_ACCESS_MODE's fail-closed default.
- The passenger polling seal, the Railway proxy request shape, the dispatch
  ledger's claim-by-insert semantics, migration 017's NOWAIT window
  discipline, and driver.html's departure-window mirror.

## 4. The plan, in order

Effort: S = under a day, M = a few days, L = a week or more. "Gate" names
what has to happen besides the engineering.

### Phase 0 — orientation (no behaviour change; ordinary PRs)

**0.1 A front door for the tests** (S). Add `scripts/run-tests.js` that
mirrors `.github/workflows/tests.yml` exactly (loop tests/*.test.js, require
the "ALL n CHECKS PASS" sentinel, fail on the first miss, enforce the suite
floor); wire `npm test`, `npm run test:fast` (skips the one slow PGlite
suite), `npm run test:one <name>`, `npm run test:tz`; have CI call `npm test`
so local and CI cannot diverge; add `.nvmrc` (20) and `engines`; fix the four
documents that still say "30 suites" and "Node 18+" (supabase-js 2.98 already
requires Node 20). Today `npm test` answers "Missing script".

**0.2 Archive the dead documents and root files; regenerate `.env.example`
from the code** (S). Move the four December-2024 analyses in docs/ and the
six bannered root guides to docs/archive/ (docs/ is already force-404 and
skipped by the inventory walk, so six root 404 rules can go); add a ten-line
docs/README.md listing the LIVE documents; move the three unreferenced demo
pages to dev/archive/ (note: they are served 200 today, so this is a
behaviour change confined to three dead URLs); replace the `/api/track-flight`
redirect to a non-existent function with a one-rule 404; rewrite
`.env.example` from the live inventory (drop STRIPE_*, DRIVER_PASSCODE,
RATE_LIMIT_*, APP_*/SUPPORT_*; add the quote, signing, VAPID, push, watchdog
and cancel variables) and state "link first; .env is the fallback"; fix the
package.json name. Today the first file a newcomer copies tells them to set
Stripe keys under a LuxeRide banner.

**0.3 `docs/OPERATIONS.md` and `database/migrations/README.md`** (S). One
page with: the change-type → extra-steps table (reference the
STATIC_CACHE_URLS constant, never copy it); the rollback rule (revert on a
branch + next unused cache pair + PR — NEVER the Netlify dashboard "Rollback
to this deploy", which revives a burned cache name; Railway = revert commit;
database = per-migration runbook); the env/kill-switch table (variable, where
read, scope, accepted values, what the user sees, how to confirm it took, and
the set → trigger deploy → confirm checklist — fix the netlify.toml watchdog
comment that omits the redeploy); and a migrations folder map (file · role:
migration / read-only preflight / emergency rollback / GENERATED · installed
date · runbook), with database/SETUP.md corrected so nobody pastes a preflight
or the rollback whole. The new README under database/ needs its own force-404
rule, exactly like SETUP.md's.

**0.4 Two urgent test fixes** (S). Replace the PGlite chain filter
`!/preflight|^018_|^019_/` in tests/r1-migration-chain and
tests/prt-pickup-integrity with an explicit numeric baseline, or the first
020 file will be applied BEFORE 018 and 019; and rewrite the two wall-clock
replay checks in the PR-T suite on the database clock the way its own
crossing helper already does, so a loaded CI runner cannot fail them with a
message that reads like a migration bug.

### Phase 1 — after the PR-T migration and the PR-B release are verified

**1.1 Shrink the service-worker bump from a ten-file ceremony to a
three-line edit** (S engineering; gate: relay to Codex, because the numbered
ladder is part of the reviewed rollback plan). One suite owns the real rule:
both cache names present, both strictly greater than a recorded
"last shipped" pair (lagging by one so main never fails right after a ship),
both changed together. Convert the five literal pins to the floor form four
suites already use; delete the repo-wide prose scan and its exact-string pins
on a markdown table row, runbook steps, a CLAUDE.md sentence, an HTML comment
and another test's assertion message; replace the pre-assigned reserved
ladder with one sentence — "a release or rollback takes the NEXT unused pair
at execution time" (the service worker's own comment already admits this).
Verified by simulation: a bump today fails four suites and produces a
34-line to-do list in a test named "pending-edit-hydration". The forward-only
invariant is untouched.

### Phase 2 — de-duplicate the backend, one helper per small PR

**2.1 Extract the copy-pasted helpers byte-for-byte** (M total; each PR is S;
careful lane because handlers are touched). lib/require-driver.js (four
copies, moved verbatim behind options so every suite stays green — the
deliberate unification to release-booking's 500-on-outage semantics for the
other three endpoints is a separate one-line behaviour-change decision for
Andres, because today a Supabase auth blip signs drivers out on three
endpoints and not the fourth); lib/auth-outage.js (six copies of the same
classifier, landed in six separate commits); `text()`; point the ten UUID
regexes at the existing export; lib/http.js parameterized for the eleven
CORS/env-guard blocks (they are NOT byte-identical — booking-status and
profile lack the 405 branch, create-booking has a two-stage guard — so the
helper takes knobs); lib/telegram.js for the three fire-and-forget senders
(sendReceipt keeps its no-timeout behaviour explicitly). Do NOT fold the
vehicle maps into this batch: the drift guard slices those literals out of
the handlers' source text, so that change is a guard redesign of its own.

### Phase 3 — remove what is dead, keep what explains

**3.1 Delete the dead code inside the next scheduled cache bump** (S).
showBookingConfirmation (227 lines, no caller) and its stylesheet, the fake
driver block, the always-failing `config.js` import tier (keep the literal the
drift test anchors on), the phantom `/config.js` precache entry that fails
install every time, `/api-config.js` and `/datetime-utils.js` (nothing loads
them), the no-op sync handler, the redundant SKIP_WAITING listener, and the
`luxeride-` prefix filter; `window.db` and `window.realtime` in supabase.js
(they contradict the RLS lockdown and decision 8). Annotate — do not edit —
the Railway server's dead static mounts; their removal waits for zero
/api/maps-script traffic and a field test. NOT included: the Visa button and
payment/promotion modals — passenger-visible, Andres's product decision.

**3.2 One pass per file to trim provenance narrative and fix the comments
that actively mislead** (M). Keep every sentence that states an invariant or
a non-obvious why; delete PR numbers, review rounds and reviewer names (git
carries them); fix the ones that lie today — the "Passcode gate" comment
above the email+password login, a stale line pointer in operation-status.js,
and the "pending edits remain on legacy pricing" comments contradicted by the
shipped edit quoting; add pricing.js's five-line retirement header.

### Phase 4 — the one structural change

**4.1 Split the booking page's 4,048-line inline script at its natural
seams, one seam per PR** (L; careful lane — the money path is moved, not
changed). No bundler: plain `<script src>` files in load order, using the
wrapper js/pending-edit-model.js already uses. Order by self-containment:
js/booking-envelope.js (the fetch/sessionStorage recovery logic — where a bug
most plausibly lands), js/account-gate.js (the pre-boot session gate, already
self-contained), js/quote-flow.js (quote intent, key, render, quiet refresh).
Inside confirmBooking (476 lines) name the steps in place — gate the quote,
build the payload, post the envelope, settle the response — and keep the
try/catch/finally single-flight lock exactly as it is. Each seam is cheap only
after 1.1 (each adds a precached file). Convert the fourteen static
source-shape assertions into behaviour checks against the extracted module.

### Decisions only Andres can make (not engineering)

- **CLAUDE.md.** The audit's proposal to split it mechanically into a map, a
  history and a state page was refuted: the second half is not history — it
  holds current contract rules, approved-not-built plans, the no-show
  principle and the review gate — and the HISTORICAL/CORRECTED markers encode
  authorizations. The honest version is a sentence-level triage into a short
  operating manual, a one-page current state, and dated records, done once
  with Andres and reviewed by Codex. The named invariants INV-2..4 are cited
  in twelve files and defined in none inside the repo (INV-1 is cited
  nowhere); whether to restate them is a deliberate owner decision.
- Whether the three driver endpoints should adopt release-booking's
  auth-outage semantics (see 2.1).
- Whether the Visa button and payment/promotion modals stay.
- `profile.js`'s active-status list lacks 'assigned' while create-booking's
  matches migration 017's index; PR-B's parked branch already adds it.

## 5. Rules of the road, so it stays a Honda

1. **Every change names its lane.** Fast lane: ordinary PR + green suite.
   Careful lane: the review protocol. A file that forces fast changes into
   the careful lane is a candidate for extraction.
2. **The tests are the map.** `npm test` runs what CI runs; one suite per
   feature; a new suite raises the CI floor in the same PR.
3. **Generated artifacts are never hand-edited** and every SQL artifact is
   ASCII-only; a migration is authored as a new number, never by patching an
   installed one.
4. **No reserved ladders.** A release or rollback takes the next unused cache
   pair at execution time; both names move together.
5. **A document has a date and an owner, or it lives in an archive.**
   docs/README.md lists what is live.
6. **Comments explain why, not who or when.** Git carries provenance.
7. **Copy strings and lifecycle lists live once**, in the smallest module
   that owns them — but only when the extraction is byte-for-byte on the
   wire and keeps every suite green; a status list that is a deliberate
   different slice stays where it is.

## 6. Corrections the verifiers made to the audit (kept for honesty)

- A cache bump today fails FOUR suites with a 34-line offender list (not
  five and 35). PR #88 touched 12 files, but most of those lines were a new
  document and new tests; the pin churn was four test files, the worker and
  five prose sites.
- The three demo pages are served 200 today, so archiving them is a
  behaviour change confined to dead URLs. The track-flight fix is a one-rule
  404, not a stub function.
- `netlify dev` fails without linking only on the quote path; the docs must
  say "link first".
- The eleven CORS/env-guard blocks are not identical; the helper takes knobs.
  The vehicle maps cannot be extracted without redesigning the drift guard.
- A "status ladder" module was refuted: only one pair of lists is a genuine
  divergence; the rest are deliberate different slices, and `grep` on a
  status token is already a complete lookup.
- Renaming test files by `git mv` is not free: two suite names are embedded
  in the generated migration SQL and byte-pinned.
