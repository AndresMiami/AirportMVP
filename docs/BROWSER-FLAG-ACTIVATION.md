# Browser-flag activation (SERVER_QUOTE_ENABLED) — record and rollback

This document records the step-5 activation PR of the post-R1 sequence and
carries its REVIEWED FORWARD ROLLBACK. It is procedure and record, not
authorization: every completed production action here was separately
authorized by Andres in Claude's chat, and the release itself waits on ONE
further authorization — merge/production release (merge deploys; see
below).

## The cache-version ladder (forward-only, one deployment per rung)

PRs #86/#87 advanced main and DEPLOYED static cache `linkmia-v1.3.26`
before this activation was reviewed, so the activation takes the NEXT
rungs — a cache name, once deployed, is burned forever (reusing one for
different bytes leaves returning clients on stale pages under a "current"
name):

| Deployment                                        | Static cache      | Runtime cache        |
| ------------------------------------------------- | ----------------- | -------------------- |
| Stripe removal, commit `57f617c` via #87 (shipped) | `linkmia-v1.3.26` | `linkmia-runtime-v3` |
| THIS activation               | `linkmia-v1.3.27` | `linkmia-runtime-v4` |
| Browser-flag rollback         | `linkmia-v1.3.28` | `linkmia-runtime-v5` |
| Emergency R1 code revert      | `linkmia-v1.3.29` | `linkmia-runtime-v6` |

## What the activation PR changes — and nothing else

1. `indexMVP.html`: `SERVER_QUOTE_ENABLED` false → **true**.
2. `service-worker.js`: static cache `linkmia-v1.3.26` → **`linkmia-v1.3.27`**.
3. `service-worker.js`: runtime cache `linkmia-runtime-v3` → **`linkmia-runtime-v4`**.
4. Test harness: `makeContext` normalizes the flag to the REQUESTED mode in
   both directions, so ON and OFF stay genuinely exercised regardless of the
   shipped default (the old one-way replace would have left every
   "disabled" context enabled after this flip). Three ROLLBACK/DISABLED
   checks drive the flag-off path for real: legacy fares computed and
   posted to the carousel; a route change re-priced through pricing.js;
   and one tap submitting the pricing.js fare as an actual HTTP POST
   (JSON body, session header, no token fields), with `/api/quote-ride`
   unrouted so any quote call fails loudly.
5. Cache pins updated (static v1.3.27 in three suites; a pin asserts the
   runtime cache moved with it) and stale rollout docs corrected:
   CLAUDE.md (activation state, superseded dark/blocking/017-unrun
   claims, sequencing decision), this file, docs/R1-MIGRATION-RUNBOOK.md
   (status banner, post-activation rollback amendments),
   docs/MIGRATION-017-RUNBOOK.md (install recorded, sections marked
   historical), docs/PRICING_STRUCTURE.md (authority table and roadmap
   status), and prose-only comment/label/title updates in
   tests/vehicle-metadata-drift.test.js and
   tests/quote-browser-integration.test.js (no assertion or
   implementation bytes changed).

This document describes the release's CONDITIONAL behavior. MERGE IS THE
RELEASE GATE: Netlify deploys `main` automatically, so merging this PR IS
the production release — there is no separate deploy pause, and none is
promised. Until Andres gives that ONE explicit merge/production-release
authorization in Claude's chat (after the PRE-MERGE gate below),
production runs the flag-false legacy path under observe mode.

NO SQL, environment, Railway, pricing-formula, token, RPC, or vehicle
changes. `QUOTE_SERVICE_DISABLED` stays present in Netlify (value 0) as the
one-edit emergency stop for the ENDPOINT; this flag is the browser side.

## What it means once deployed

- Passengers SEE and SUBMIT server prices. A missing or expired quote blocks
  Book (with the quiet refresh flow shipped in 2C-B).
- `pricing.js` becomes SHADOW-ONLY. It is deliberately left unchanged for
  rollback safety until the post-enforce split (the P0 drift guard pins its
  vehicle METADATA against the rate card — keys, names, capacities — not
  every byte of the file).
- `pricing_state` is `observe` (set 2026-09-03): the RPCs verify and consume
  tokens, bookings stamp `price_authority='client_observe'` with the
  submitted amount, and `quote_verifications` records server vs client cents
  per write. Nothing is rejected on price in observe mode.
- Both caches bump TOGETHER. The runtime cache can retain booking HTML, so a
  static-only bump is not a dependable rollback lever.

## Post-merge controlled verification (one pass, Andres at the browser)

1. One real booking >24h out through the normal flow: the displayed price is
   the server quote; Book succeeds.
2. `quote_verifications` (read-only): verdict `verified`, mode `observe`,
   `client_cents = server_cents`, booking id stamped.
3. `bookings` row: `price_authority = 'client_observe'`, canonical place
   identity stored, `duration_minutes` NULL.
4. Edit the booking (pending edit): same checks on the edit write;
   `details_version` incremented.
5. Cancel by the usual protocol (CANCEL, never DELETE). Doorbells and admin
   messages arrive as usual.
6. Then OBSERVE REAL TRAFFIC. Graduation evidence (zero non-test
   `no_token` / `no_request_id` / `verify_failed`) precedes any enforce
   discussion. Legacy verdicts drain as PAGES RELOAD OR NAVIGATE — a
   browser picking up the v1.3.27 worker does not change the JavaScript
   already running in an open booking tab; only the next navigation loads
   the flag-true page.

## PRE-MERGE GATE (all read-only; each item recorded before Andres's separate merge authorization)

1. Exact current head: the PR head SHA Codex reviewed, byte-identical
   (diff sha256 recorded in the review thread).
2. `SELECT mode, enforcement_started_at FROM pricing_state;` →
   `observe`, NULL (the high-water mark must not be set).
3. Quiet window: zero nonterminal rides
   (`status NOT IN ('completed','cancelled','declined')`), so no live
   passenger straddles the cache turnover mid-ride.
4. Ledger baseline: `quote_verifications` verdict/mode counts recorded, so
   post-deploy `verified` rows are attributable to this release.
5. Anonymous `POST /api/quote-ride` answers 401 (endpoint enabled, config
   valid, authenticated-only).
6. Google quota caps confirmed in place (GetPlace and ComputeRoutes 100/day
   — quotas are project-wide).
7. Full test matrix green in CI across all three timezones at that head.
8. Andres's explicit merge/production-release authorization in Claude's
   chat (merge triggers the Netlify production deploy) — separate from
   every authorization above.

## FORWARD ROLLBACK (reviewed with this PR — the only sanctioned rollback)

Cache names only ever move FORWARD. The reason is not versioning: browsers
decide whether a worker is new by comparing its SCRIPT BYTES, so any edit
installs a new worker regardless of the numbers inside it. What the unique
forward names buy is that the new worker never REUSES a historical cache
namespace — a reused name could keep serving pages cached under that same
name by an earlier deployment (exactly the v1.3.26 collision this release
sidestepped). The rollback is therefore a new commit, exactly:

1. `indexMVP.html`: `SERVER_QUOTE_ENABLED` true → false.
2. `service-worker.js`: `CACHE_NAME` → `'linkmia-v1.3.28'`.
3. `service-worker.js`: `RUNTIME_CACHE` → `'linkmia-runtime-v5'`.
4. Test updates mirroring the same sites this PR touched: in the
   ship-state check, flip the REGEX EXPECTATION back to false AND rewrite
   the check TITLE and assert MESSAGE to say the default ships false
   (rolled back) — a passing check whose title still announces "the
   activation" is a lie the next reader inherits. That regex literal
   appears exactly once; do NOT touch the quoted replacement strings
   inside makeContext, which must remain the two-way true/false pair.
   Then the three static pins to v1.3.28 and the runtime pin to v5. The
   two-way harness normalization itself needs NO change — that is why it
   exists, and the ROLLBACK/DISABLED checks (legacy fare computed, posted,
   re-priced on route change, and submitted) keep the flag-off path
   genuinely proven either way.

THE ROLLBACK IS NOT INSTANT for everyone, in two ways to expect and not
treat as an incident:

- ALREADY-OPEN TABS keep the flag they loaded: the const is baked into the
  page at parse time, so an open booking tab continues showing and
  submitting SERVER prices until it reloads (the new worker takes control
  quickly via skipWaiting/clients.claim, but running page JS only changes
  on the next navigation or reload).
- TOKEN ISSUANCE DOES NOT STOP with this rollback. An open flag-true tab
  keeps requesting FRESH 15-minute tokens for as long as it stays open and
  `/api/quote-ride` stays enabled — the overlap is unbounded, not "short".
  The writers verify and consume those tokens normally in observe mode, so
  mixed server-priced and legacy-priced submissions are EXPECTED for as long
  as such tabs live, and the `quote_verifications` ledger records both
  honestly. The 15-minute TTL bounds the overlap ONLY after the separately
  authorized kill-switch change (`QUOTE_SERVICE_DISABLED=1` + redeploy):
  from then on no new token can be minted, already-issued tokens expire
  within 15 minutes, and a stale flag-true tab's Book is blocked (its quote
  requests fail) until the passenger reloads into the flag-false page.

This exact rollback was EXECUTED as a simulation during the activation
PR's review (title/message rewrite included): the full matrix ran green
with the ROLLBACK/DISABLED fare checks passing under the rolled-back
default, then the activation tree was restored. The simulation also
demonstrated the one trap: a global replace of the flag string inside the
test file corrupts the harness's two-way pair — hence the scoped-edit
instruction above.

Deploy via the normal branch → PR → merge path. This rolls back PASSENGER
pricing display/submission only; `pricing_state` stays `observe`, which is
safe with the flag off: a no-token write in observe records verdict
`no_token` and still succeeds, storing the client amount with
`client_observe` authority — verified against the INSTALLED migration-018
writer bodies (create: mode branch `:367-395`, telemetry insert
`:550-560`; edit: enforce-only rejection `:970-977`, observe branch
`:1138-1144`, telemetry insert `:1285-1295`) — so bookings keep working.
Two further, independent levers exist and
are NOT part of this rollback: closing the ENDPOINT is the one-edit
Netlify change (`QUOTE_SERVICE_DISABLED=1` + redeploy), and reverting
`pricing_state` to `off` (`set_pricing_mode('off','andres')`, legal until
enforcement ever starts) is for a misbehaving observe-mode write path
only.

## What this document does NOT cover

- Enforce-mode activation (graduation evidence first; its own review).
- The venue-directory/address program (sequenced AFTER pricing activation by
  Andres's 2026-09-03 decision — order only, the address-storage question
  remains open).
- R2 historical duration cleanup (separate, non-blocking).
