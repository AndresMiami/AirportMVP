# LinkMia — Miami Airport Transfers

Chat-free, web-app-centric ride dispatch platform. Owner (Andres) is currently
admin + the only driver. Passengers book on the web; dispatch, statuses, and
verified checkpoint locations all live in the web app backed by Supabase.

## Architecture (one path, one database)

- **Frontend + serverless**: Netlify. Static pages at repo root, functions in
  `backend/functions/`, routes in `netlify.toml`. Deploys from `main`.
- **Database**: Supabase project `qvtqqggtpxesfcmpftej` (paid org). Single
  source of truth: `bookings` is the dispatch table. Anon key is public
  (hardcoded in `supabase.js`) but AUTH-ONLY since the RLS lockdown
  (migration 010): default-deny policies + zero client-role grants on all
  tables and views. ALL data access flows through `backend/functions/`
  with the service key (Netlify env only).
- **Railway** (`reliable-warmth-production-d382.up.railway.app`): Google Maps
  proxy ONLY (`backend/api-proxy/server.js`). No booking logic lives there.
- **Telegram**: send-only "bookkeeper" — new-request doorbell, trip-started
  ping, completion receipt. No webhook, no buttons, no state. Never rebuild
  dispatch inside a chat app (tried once; removed deliberately).
- **WhatsApp**: human conversation only, via `wa.me` links. No API, no
  automation (Meta forbids automating live-location; number can't be on both
  Business app and API).

## Key pages

- `indexMVP.html` — booking flow (Where → When → Vehicle → Who's traveling).
  ACCOUNT-ONLY (account-gate PR): the session is verified behind a neutral
  loading screen BEFORE the booking app boots — signed-out visitors get
  `location.replace('/login.html')`, auth-check failure shows an honest
  retry screen, never guest fallback. Session prefills the passenger
  modal and restores the account's nearest nonterminal booking directly
  into the live trip sheet, independent of browser storage. Normal
  passenger accounts have one nonterminal booking at a time; create-booking
  returns the existing id on conflict so stale tabs reopen it instead of
  inserting a duplicate. Ambassador accounts are deliberately exempt and
  stay multi-ride. Submit re-reads a FRESH session; a failed/401/403 API
  booking keeps the form and shows a real error — only a database bookingId
  opens the live trip sheet (iframe of `/trip?embed=1`). "Book for someone
  else" remains: a signed-in booker arranging a ride for another
  passenger is not guest checkout.
- `trip.html` — passenger status page: stepper, vehicle hero, booking-time
  ETA, static verified-checkpoint map marker (honest labels, Miami-time
  stamps, never a moving dot), WhatsApp button, Edit ride/Cancel. Pending
  edits reuse the existing booking form and update the same booking row in
  place (`/api/update-pending-booking`, signed-in owner only): UUID, trip
  code, owner, creation time, and trip URL remain stable, and a guarded
  details_version prevents an edit from racing driver Accept. Cancel is
  QUOTE-FIRST (PR 1A): tap → server quote from `/api/cancel-booking` →
  inline card shows the SERVER's verdict (pending: a plain "hasn't been
  accepted yet — cancelling is free" sentence, no fee arithmetic; the
  fee ledger + pilot-waiver wording renders when PR 2's 50%/100%
  brackets exist; never "charged") → final Cancel ride sends the reviewed
  quote back as `expected` and any drift 409s with a fresh quote (409 is
  never success). Account-owned bookings attach the owner's session via a
  lazy, deadline-bounded load of the SAME supabase-js CDN bundle indexMVP
  uses plus the same-origin supabase.js client (CDN failure = guest path,
  the server still decides); legacy guest links keep bare-UUID
  (pending only). `CANCEL_QUOTE_DISABLED=1` 503s the new endpoint and the
  page falls back to the legacy path (same server-side authorization). SEALED smart
  polling of `/api/booking-status`: cadence by status (pending 15s /
  confirmed 30s only within 30 min of pickup — farther out sleeps locally
  with zero network / on_the_way 30s / arrived 15s / in_progress 60s),
  hard per-status cutoffs, absolute pickup+6h boundary, persistent
  500-request/booking budget, 5-failure initial budget followed by one
  recovery check per visibility return, and a default 30-min leash for
  unknown statuses or malformed timestamps. A 404 permanently stops that
  page session instead of restarting on later visibility returns. Paused
  card is notice-only (NO manual refresh button — deliberate); hidden tab =
  zero requests; one automatic check on visibility return is the resume path.
  RELEASED bookings (PR 3C-1): `/api/booking-status` adds `reassigning` +
  `reassigningSince` on pending rows with release history (fail-closed
  lookup); the page shows the explicit "We're finding you a new driver"
  card, wipes former-driver identity to the defaults, and re-anchors the
  pending poll window ONCE per release via the persistent
  `reassigningSince` anchor identity (a reload reuses the stored anchor;
  the request BUDGET is never reset by a release).
- `driver.html` — GetTransfer-style driver app behind a real login
  (admin-provisioned Supabase accounts, `Authorization: Bearer` session
  JWT — the shared passcode is retired): Requests/My rides tabs show
  unassigned pending requests + ONLY this driver's own rides (busy
  drivers see just their rides and cannot accept; inactive is rejected).
  No driver-side Decline (shared requests — not accepting IS declining);
  CONFIRMED rides instead carry **Release ride** (PR 3C-1): a bottom-sheet
  with 5 structured reasons (note required for Other) posting
  `/api/release-booking` — see the lifecycle section for the full rules.
  Adaptive polling,
  CHECKPOINT capture — On my way / Arrived / Start trip each grab one fresh
  GPS fix (6s bound, maximumAge 0) inside the tap and send it WITH the
  status POST; no continuous tracking (a mobile browser can't broadcast
  while Google Maps is foreground). Location permission is first requested
  at On my way, never at Accept. Same-tab Maps handoffs only after status
  success; lost responses retry once, and only the BACKEND declares a
  verified idempotent duplicate (status + owner both match) — the client
  never treats a 409 as success. Driver PWA Push (Driver PWA Push PR):
  dedicated manifest (id "/driver") + no-cache driver-sw.js at scope
  /driver; readiness reminders arrive as Web Push on the installed app —
  enabled ONLY by an explicit tap, bound to driver+device
  (push_subscriptions; newest activated_at device wins; endpoints are
  never reassigned across accounts — 409 + fresh resubscribe), push-first
  with Telegram fallback (never both; ADMIN-role events are Telegram-only —
  driver events, the urgent ask included, route push-first: verified
  against the shipped routing — per-event execution lives in the SHARED
  dispatcher `lib/dispatch.js` since PR 3A, used by the watchdog and,
  next, the cancellation endpoint; only dispatchOne is exported and its
  options {summary, dbFail, maxAttempts} are validated up front),
  absolute TTLs + per-booking Topic/Tag, durable failure_class routing,
  PUSH_DISABLED kill switch. Clicks deep-link to /driver?ride=<id>;
  notifications never mutate ride state.
- `login.html` — passenger email+password (self-service signUp) and the
  FRONT DOOR for booking: the homepage CTA and the PWA "Book" shortcut land
  here; a signed-in session forwards straight to `/indexMVP.html?book=1`.
  Guest checkout is VISIBLE but inert ("Guest checkout — coming later" —
  no href, no handler, no keyboard activation). Drivers ARE
  admin-provisioned (CreditEngine pattern, migration 009) — no signup ever.
- `admin.html` — RETIRED (Phase B): `/admin` + `/admin.html` 404 to a
  static notice. Supabase Dashboard is the interim admin tool until the
  LinkMia admin portal ships.

## Booking lifecycle

`pending → confirmed → on_the_way → arrived → in_progress → completed`
Terminals: `declined` (legacy/admin-only — driver-side decline was removed),
`cancelled` (passenger self-service through `arrived`; in_progress and
terminals only via admin SQL). One BACKWARD transition exists (PR 3C-1):
**Release ride** — `confirmed → pending` via the migration-016
`release_booking()` RPC ONLY (guarded flip + full commitment-state clear +
booking_releases audit row + admin `ride_released` outbox event, one
transaction; raw status-flip SQL is NOT a supported release). Rules: the
releasing driver + structured reason + pickup/ROUTE/price/name/PAYMENT
SNAPSHOTS are recorded; the live payment stamp is PRESERVED through a
release (MVP decision: a paid passenger must never be charged twice —
a non-unpaid snapshot adds a reconcile warning to the admin notice and
the human referees the money between drivers); a DB trigger blocks the
releaser from EVER re-accepting; the
re-pooled request is hidden from their feed (fail-closed lookup); the
passenger sees an explicit "We're finding you a new driver" notice
(never the reason, no former-driver traces); admin Telegram includes
driver/reason/snapshot pickup, URGENT when the SNAPSHOT is <2h out
(immutable — post-release pending edits never re-classify it). Release
stays available inside 2h (an emergency surfaced beats one hidden) and
to busy drivers. DELIBERATE policy: a release resets the passenger's
cancellation bracket (the row is genuinely pending → cancel free) —
the driver abandoned the commitment, the passenger never inherits its
late-cancel bracket. Sequential release→cancel yields BOTH admin
messages (release is historical fact, no relevance gate). Transitions are server-enforced in
`update-booking-status.js`: Accept wins only an UNASSIGNED pending request
and stamps `assigned_driver` atomically; every later action requires an
EXACT ownership match. A stale/foreign action matches 0 rows → the backend
answers 200 `{idempotent:true}` ONLY when status AND owner both match
(verified duplicate), else 409 with `currentStatus` — the client never
interprets a 409 as success. Legacy status `assigned` kept for old rows.

Passenger cancellation (PR 3B — CLOCK-based SILENT shadow policy):
self-service through `arrived`. Authorization lives in
`lib/cancel-core.js`, shared verbatim by `/api/cancel-booking` (quote +
guarded cancel) and the legacy `/api/booking-status` cancel action
(pending-only) so the rules can never diverge. `customer_id` set →
signed-in OWNER required (401/403/500, auth-outage discipline);
`customer_id` NULL → bare-UUID capability for PENDING only; legacy-guest
ACCEPTED rows answer `requires_support`. The shadow percentage comes
from the SERVER clock vs `pickup_datetime` ONLY (accepted >2h out 0%,
T-2h→pickup 50%, at/after pickup 100%) — driver checkpoints gate
eligibility and notifications, never the percent. SILENCE: fee numbers
are stripped from EVERY passenger payload (quote, 409s, applied) unless
`CANCEL_FEE_DISPLAY` is set (future activation lever); the CAS compares
status/pickupAt/policyVersion (fee terms only while displayed, extras
ignored, `serverTime` never). Invalid stored price → hypothetical
amount recorded NULL (a real $0 fare stays $0), cancellation never
blocked. Every cancellation stamps the migration-013 audit (collected
$0 DB-CHECK-enforced, `pilot_waiver/system` when the percent > 0) in
the SAME guarded UPDATE; the outbox TRIGGER (013 admin + 015 driver)
inserts the ledger events in the SAME transaction — manual admin SQL
cancels included. After commit the endpoint gives THIS booking's
cancellation events one bounded pass through `lib/dispatch.js`
(`immediateSubmission` reports submitted/deferred from STORED truth; a
notification failure never fails a committed cancel; watchdog recovers
≤ ~5 min). The driver stop-notice routes push-first with honest copy
("Do not proceed. No action is required."), no rideId deep link (click
opens /driver), readiness-topic reuse (replaces stale readiness
banners), and dispatch-time `duplicate_target` dedup when its Telegram
fallback would land in the admin chat. Trip-sheet card: pending "hasn't
been accepted yet — cancelling is free"; confirmed/on_the_way "your
driver will be notified right away"; arrived adds the soft "driver has
already arrived… late cancellations may in the future" line;
in_progress/terminal cannot cancel. Kill switch `CANCEL_QUOTE_DISABLED`:
pending falls back to the legacy flow, accepted rides get the support
message (never a doomed dialog).

Checkpoint model (5 statuses, 3 verified locations, 1 cleanup): `on_my_way`,
`arrived`, `start_trip` may carry `lat`/`lng`, stamped atomically with the
status into `bookings.driver_lat/lng/location_at`. A checkpoint WITHOUT fresh
valid coords CLEARS the stored location (an old point must never be relabeled
as the current checkpoint). `complete` erases coordinates (privacy). Accept
captures nothing.

## Identity & roles

- `customers.user_id` → auth.users. Profile via `/api/profile` (Bearer JWT).
- **Ambassadors** = `hosts` row with `user_id` + `status='active'` (granted
  manually by Andres via SQL). Effects: "For myself" locked in the passenger
  modal, gold chip badge, bookings stamped `referred_by_host` +
  `host_commission` (price × their rate). QR attribution: `?ref=CODE`
  (30-day localStorage). Commission counts as EARNED only on `completed`
  (see `ambassador_earnings` view).
- Money per ride: driver 75% (`driver_payout`), ambassador ~6%
  (`host_commission`), LinkMia net = 25% − ambassador (`linkmia_commission`,
  generated column).

## Conventions

- Dark theme tokens: bg `#1C1C1E`, panels `#2C2C2E`, brand gradient
  `#FF9933→#FF5733`, green `#32D74B`, gold (ambassador) `#d4af37`.
- Vehicle catalog: Tesla Model Y (sedan 4/4), Cadillac Escalade (suv 7/8),
  Mercedes Sprinter (sprinter 12/15). `vehicle_type` = category,
  `vehicle_name` = display name. Images in `images/`.
- All user-facing times in `America/New_York` (functions run in UTC!).
- Migrations live in `database/migrations/` — run manually in the Supabase
  SQL Editor, numbered sequentially. Views depending on altered columns must
  be dropped/recreated in the same script (`SELECT *` views depend on ALL
  columns).
- Bottom-sheet modals: dimmed backdrop rgba(0,0,0,0.7), panel max-width
  576px, border-radius 20px 20px 0 0, slideUp 0.3s (see passenger-modal.js).
- Service worker: cache name must be BUMPED when cached assets change;
  never intercepts non-GET; disabled on localhost.

## Env vars (Netlify)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (secret),
`TELEGRAM_BOT_TOKEN` (secret), `ADMIN_TELEGRAM_CHAT_ID`,
`GOOGLE_MAPS_API_KEY`, Stripe keys (Stripe currently disabled,
`REQUIRE_PAYMENT=false` in indexMVP; payment = cash/Zelle to driver).
Railway env: `GOOGLE_MAPS_API_KEY`, `ALLOWED_ORIGINS` (localhost allowed).

## Workflow

- Branch → commit → push → PR → Andres merges → Netlify/Railway deploy from
  `main`. Never push to main directly.
- Local dev: see `LOCAL_DEVELOPMENT.md` (`netlify dev` on :3001, linked env).
- Committed tests live in `tests/` — run `node tests/driver-identity.test.js`
  (needs `npm install`; exits nonzero on failure). Pattern: mock
  `@supabase/supabase-js` via require.cache, run the real handlers, assert
  payloads/filters. Same pattern works ad hoc in session scratchpads.
- Verify inline-script syntax by extracting `<script>` blocks → `node --check`.

## Decisions log (do not relitigate casually)

1. Dispatch state NEVER lives in chat apps — web app + Supabase own it.
2. Telegram = private ops notifications; WhatsApp = human channel. Both are
   channels, not infrastructure.
3. Passengers: self-service email+password; NEW bookings are
   account-required (account-gate PR): the homepage/PWA "Book" entry
   goes to /login.html, indexMVP verifies the session before the app
   boots, and create-booking enforces it server-side (401/403/500,
   never an anonymous insert; every new booking stamps customer_id —
   ensure-row creates a missing customers row from the booker identity).
   Guest checkout is VISIBLE but disabled ("Guest checkout — coming
   later") and may return; guest schema/code, legacy guest bookings
   (customer_id NULL), and guest /trip links all keep working. "Book
   for someone else" remains (signed-in booker ≠ guest checkout).
   Account continuity is server-backed: after login a normal passenger's
   nearest nonterminal booking reopens automatically, and create-booking
   blocks ordinary stale-tab/device duplicates by returning the existing
   ride. A truly simultaneous first-insert race remains recorded for a
   future database-constraint migration (013 shipped as the
   cancellation policy; 014 is the pending-edit details_version
   migration). Ambassadors remain explicitly multi-ride.
   Drivers: admin-provisioned only. Session: 30-day inactivity timeout.
   Passenger Push later binds to the authenticated customer UUID.
4. Checkpoint locations (browser geolocation at status taps → Supabase →
   trip-page map) are the tracking backbone; WhatsApp live-location is a
   manual premium layer. Continuous browser GPS was tried and deliberately
   removed (PR #45) — it cannot survive the Google Maps handoff. If real
   background tracking ever becomes a business need, the only door is a
   small native driver shell (Capacitor + background-geolocation, ~$99/yr).
5. Escalade categorizes as `suv`; display names preserved in `vehicle_name`.
6. Support/driver phone: +1 (786) 509-3955.
7. Passenger polling is SEALED (PR #46): status-tuned cadences, hard
   cutoffs, absolute pickup+6h boundary, persistent 500-request/booking
   budget. No code path polls indefinitely — keep it that way. The paused
   page is automatic-only: no manual refresh button (product decision).
8. Supabase Realtime is DEFERRED until the RLS lockdown + guest
   authorization make subscriptions safe (browser + public anon key would
   bypass the functions/service-key boundary). Long-term closed-page
   channels are PWA Web Push — Driver first, then AUTHENTICATED-passenger
   — never sockets and never SMS (Twilio/SMS rejected, Aug 2026; the
   notification ledger supports telegram + webpush only, and 'submitted'
   is the honest terminal state — no channel proves a human saw it).
   WhatsApp stays a human-only conversation link (see decision 2), never
   automated.
9. RLS lockdown (Phase B, migration 010): seven tables default-deny with
   zero client-role grants (PUBLIC included), six reporting views forced
   to security_invoker, postgres-creator default privileges stripped, and
   the service worker never intercepts any data API (no /api/*, no
   /.netlify/functions/*, no Railway; private, no-store on every function).
   This is a safe FOUNDATION for Realtime — not an unblock: Realtime would
   still need deliberately scoped SELECT grants + per-row policies.
10. Driver identity (PR #49): admin-provisioned Supabase accounts only,
   `assigned_driver` stamped at Accept ONLY (unassigned requests, active
   drivers; busy = finish own rides, no new accepts), exact-match
   ownership on all later actions, idempotent success declared ONLY by
   the backend after verifying status + owner, no driver-side Decline,
   and a passenger WhatsApp button that hides rather than falling back
   to another driver's number.

## Known gaps / next up

- ROADMAP (Aug 2026, Codex-approved order — no SMS anywhere):
  1. PR #54 — SHIPPED (merged; migration 011 run and production-verified;
     watchdog live on the 5-minute schedule with ride-day heartbeat).
  2. Account-required booking gate — SHIPPED as the account-gate PR
     (front-door /login.html entry, pre-init session guard on indexMVP,
     server-enforced 401/403/500 in create-booking, customer_id stamped
     via ensure-row, guest checkout visibly disabled, false local-success
     fallback removed; bookings.customer_id stays nullable for legacy
     guest rows).
  3. Driver PWA Push — SHIPPED (migration 012 + VAPID configured;
     locked-phone delivery, deep link, no-duplicate Telegram routing,
     readiness suppression, and sign-out/re-enable production-verified).
     Telegram stays the fallback and safety channel; PUSH_DISABLED=1
     reroutes everything to Telegram without touching the watchdog.
  4. Routes API + two-ETA work.
  5. Passenger PWA Push for authenticated passengers.
  6. Polling reduction reconsidered ONLY after real Push field evidence.
- Phase B RLS lockdown SHIPPED as code — run `database/migrations/`
  010_rls_lockdown.sql (atomic, self-verifying, unedited) right after
  merging, then security probes + full smoke test.
- Driver PWA (plan approved): mobile-first LinkMia Driver app shell —
  bottom nav, payout-primary ride cards, Settings, dedicated manifest +
  icons (the SW/API-cache privacy work already SHIPPED in Phase B),
  Home-Screen install flow. My Rides keeps
  COMPLETED rides visible (last 7 days, own rides only) as the driver's
  work record — with passenger contact/notes REDACTED after completion
  (Andres, Aug 2026: contact exists only while the ride is live, same
  principle as pending-offer redaction).
- Ride-change roadmap (Codex-approved 2026-08-14, Blacklane principle:
  "Self-service changes while operationally safe; direct coordination
  once the driver is committed; human review before declaring a no-show
  or driver compensation"):
  * PR 3C-1 Release ride — SHIPPED (merge 4512a17, migration 016) and
    PRODUCTION FIELD-TESTED (2026-08-17, multi-driver): sequential
    Andres/Jose releases, permanent reaccept exclusion, replacement
    accept, passenger reassignment messaging, urgent-from-snapshot,
    paid-stamp survival + reconcile warning, post-release cancel
    pending/free, push/Telegram/watchdog all verified. CONFIRMED-only
    driver escape hatch, rules recorded in the lifecycle section above.
    FUTURE operational follow-up (record only): when every eligible
    driver has released a booking, LinkMia may eventually need an
    explicit audited admin-assignment capability. It must preserve
    every release record and must not weaken the rule preventing
    drivers from reclaiming their own released commitments.
  * PR 3C-2A server pricing engine — SHIPPED (merge bda4249): the canonical,
    PURE server-side pricing/capacity engine
    (backend/functions/lib/ride-rate-card.js + ride-quote.js) — a
    validated, versioned, frozen RATE CARD separated from the
    calculation machinery; integer cents; America/New_York pinned;
    cent-exact golden parity with pricing.js (quirks preserved and
    recorded, never silently fixed — see docs/PRICING_STRUCTURE.md).
    DARK by design: **pricing.js remains the live booking authority**
    until the later coordinated enforcement — the server engine is NOT
    authoritative in production yet. Future Supabase pricing profiles /
    ambassador dashboard / markups and the time-dominant rate card are
    architecturally supported and explicitly deferred.
  * PR 3C-2B1 server quote service — SHIPPED (merge 41a2639; real-Google
    provider rollout and airport-identity correction closed by a2e9e92): DARK
    `/api/quote-ride` (nothing calls it). Trusted-INTENT boundary
    (strict field allowlist; airportCode + Google place_id resolved
    SERVER-side to one identity for routing and the future stored
    address; client route facts/coordinates/bags rejected by name);
    Routes API computeRoutes with place_id waypoints both sides,
    TRAFFIC_AWARE, minimal field mask incl. fallbackInfo, 8s timeout,
    strict "123s" duration parsing, ONE attempt; departureTime rule:
    >5min-past pickups 400 (never re-routed as now), ±5min omits
    departureTime, future passes the contractual instant verbatim;
    quantization mirrors indexMVP getRouteData exactly (0.1mi /
    whole minutes); routeQuality 'traffic_aware'|'fallback' stamped
    in response AND token (2B2 owes a deliberate decision before
    displaying fallback pricing); all-vehicles response with honest
    passengerCapacityChecked:true / luggageCapacityChecked:false
    (bags DELIBERATELY dormant — the UI collects no bag count);
    HISTORICAL TOKEN NOTE: the v1 details in this 2B1 record describe
    the original dark service. PR 3C-2C-A (merge 77fb91a) replaced v1
    outright with token v2 before any production token existed; there
    is no v1 compatibility window. The original rate-card-resolver seam
    (code card today; documented future fail-closed override contract)
    and signed-token record below remain the historical 2B1 contract;
    signed tokens used HMAC v1 with kid
    rotation via QUOTE_SIGNING_CURRENT/PREVIOUS_ID+SECRET, purpose
    'create' only, dual auth-user+customer binding, intentHash instead
    of location data, 15-min price-hold TTL — replay within TTL is a
    stated stateless-HMAC property, jti deferred to 2C); dark-phase
    QUOTE_SHADOW_ALLOWLIST (auth user ids) before any Google call;
    sanitized telemetry (no addresses/place_ids/identities/raw
    provider errors); kill switch QUOTE_SERVICE_DISABLED. ROLLOUT
    GATES (not code): two restricted server keys
    (GOOGLE_ROUTES_API_KEY, GOOGLE_PLACES_SERVER_API_KEY), GCP quota
    caps sized at **Compute Routes Pro** pricing (TRAFFIC_AWARE sets
    that floor; the minimal request shape and field mask jointly avoid
    Enterprise triggers), and the baseline Google policy review
    INCLUDING any Terms/Privacy/attribution work it requires — complete
    BEFORE
    enabling the production endpoint. Storage-specific Google review
    remains the 2C gate (2B1 stores nothing).
    CORRECTION ROUNDS (post-review, same PR) — contract rules that
    2B2/2C MUST honor: (1) CANONICAL PLACE ID — Google may answer Place
    Details with a REPLACEMENT id (address-range and subpremise inputs,
    i.e. LinkMia's condo/hotel class). The resolved id is canonical and
    is used for routing, the response, and intentHash alike; 2B2 must
    resubmit `quote.intent.placeId` VERBATIM (not autocomplete's
    original id) or 2C's hash recomputation will reject honest
    bookings. ONE validator governs BOTH the submitted and the returned
    id (a looser rule for provider output would hand the browser a
    "canonical" id the next request rejects); Google's returned `id` is
    REQUIRED — a successful response without a usable one fails as
    places_parse_error and NEVER falls back to the submitted id while
    keeping the resolved place's address. Length bound is 2048, a
    DECLARED operational bound of ours: Google documents no maximum and
    its own long-form example exceeds 600 characters. (2) NO `vehicle` REQUEST FIELD — this is an all-vehicles
    contract, so each token's intentHash covers ITS OWN vehicle; a
    shared preference hash gave zero vehicle binding (a cheap sibling
    token priced an expensive vehicle) and no fixed 2C recomputation
    rule could serve both request shapes. A client that sends `vehicle`
    now gets a 400. (3) TOKEN VERIFICATION FAILS CLOSED — exact v1
    schema (an unsigned extra property is a rejection), mandatory
    expectations incl. vehicle + intentHash, finite clock, exact TTL,
    inclusive `nowMs >= exp`, strict canonical base64url. (4) SIGNING
    KEYS resolve through ONE canonical `resolveSigningKeys` (32-byte
    floor, bounded key id, all-or-nothing distinct previous pair) that
    2C's verification MUST reuse — this is also what finally makes the
    advertised env-driven rotation real in runtime code. (5) ATOMIC
    TOKEN CONSUMPTION (single-use jti or an equivalent idempotency key
    written in the booking transaction) is a MANDATORY 2C gate: the
    one-nonterminal-booking check is check-then-insert and ambassadors
    are exempt, so it is NOT a replay defense and must never be cited
    as one. The token STRING is canonical (one quote = one valid
    string), so a jti/dedup gate finally has a stable key.
    THREE MORE 2C GATES surfaced by the same pass: (a) the ADDRESS a
    booking stores is bound by nothing — `bookings` has no place_id
    column and pickup/dropoff_location are client free text, so 2C must
    persist the quoted canonical place_id (migration) or the signed
    quote guarantees a price for a route the stored address need not
    match; (b) intentHash is an UNKEYED digest over a small guessable
    domain and the payload carries pickupAtMs/vehicle in plaintext — a
    leaked token is an address-CONFIRMATION oracle, so 2C should decide
    deliberately whether to key it (HMAC); (c) the three pinned airport
    place ids never pass through resolvePlace — verify they resolve in
    the rollout smoke matrix, since a retired id silently kills every
    quote for that airport. ROLLOUT FINDING (2026-08-21): the first live
    MIA quote reached Routes but returned NOT_FOUND. A one-shot direct
    diagnostic proved the passenger address resolved and that one of
    the two redacted route waypoints was unknown; it could not identify
    which waypoint because provider identities are intentionally absent
    from diagnostics. The complete MIA/FLL/PBI server registry and the
    Railway data-only cache were refreshed from the current Google
    identities. The corrected preview returning 200 for MIA, followed
    by FLL and PBI, remains the load-bearing root-cause confirmation —
    do not describe the provider rollout as complete before that matrix.
    PROVIDER FAILURES ARE NARROWLY CLASSIFIED (round 3): Places 400
    (INVALID_REQUEST: an invalid/truncated/modified id) and 404
    (obsolete/unknown id) are permanent passenger-correctable identity
    refusals; ONLY a successful Routes 200 with an empty routes array is
    422 "no drivable route". Authentication/permission (401/403), quota,
    timeout, network and 5xx remain sanitized 502 server/upstream
    failures with distinct telemetry classes (places_invalid_request /
    places_not_found / places_denied / routes_denied /
    *_bad_request / *_rate_limited). Rationale: rollout stands up two
    BRAND-NEW restricted keys, so a wrong restriction is the likeliest early
    failure — it must read as an outage, never as "reselect your
    address" or "no drivable route". The 7s shared provider budget is a
    PRODUCT latency/cost guard, NOT a platform limit (Netlify's
    synchronous limit is 60s and not configurable).
  * PR 3C-2B2 browser integration — SHIPPED DARK (merge 3d81073): the
    new-booking browser can display server quotes and carry their
    canonical place identity/token, but `SERVER_QUOTE_ENABLED` remains
    false, `/api/quote-ride` remains kill-switched, and `pricing.js`
    remains the live production pricing authority. Pending edits remain
    deliberately on the legacy flow until edit-purpose quoting lands.
  * PR 3C-2C-A pricing-enforcement foundation — SHIPPED DARK (merge
    77fb91a): token v2 and migration 017's database/RPC foundation are
    on main, but migration 017 has NOT been run in production. The
    correction/preflight pass must be reviewed and its historical ambassador
    decisions completed before rollout; the SQL file being deployed is not
    evidence that the schema exists. The corrected v2 contract carries
    canonical `airportCode` + `vehicleKey`. Its exact nine-field keyed intent is
    `mode`, `airportCode`, `placeId`, `pickupAtMs`, `passengers`,
    `routeMilesTenths`, `routeMinutes`, `vehicleKey`, and `finalCents`. The
    token library validates those integer fields at issuance; 2C-B
    must recompute the commitment from authoritative facts before calling SQL.
    Distance is never persisted; the existing whole-minute
    `duration_minutes` estimate MUST remain populated on verified creates and
    edits and is temporarily preserved from the verified
    commitment so the trip ETA and operator notices do not silently disappear
    before the Google Routes storage-policy review settles long-term retention.
    An authentic expired or not-yet-valid token cannot authorize a new write in
    ANY mode, although an exact-token retry may recover a result that already
    committed. This is the sole exception to "observe never rejects": 2C-B
    submits the authentic stale projection as verified, then silently re-quotes
    on `quote_expired`/`quote_not_yet_valid`. The browser shows **Updating
    price…** with no up-front TTL label, alert, or passenger-facing "refused"
    wording—even when Book detects the lapse. A verified token is consumed in
    off, observe, and enforce (off still stores client money with
    `client_legacy` authority), so one quote cannot multiply bookings; for an
    ambassador exempt from the active-slot rule, that receipt is the one-quote /
    one-booking guarantee. Missing operation IDs remain tolerated and
    telemetried in off/observe; enforce returns the outdated-client 428
    contract. Migration
    017 takes NOWAIT exclusive locks on bookings/customers/hosts before
    validating the reviewed historical actor manifest, so run it only in a
    brief maintenance window; a lock held at that instant aborts the whole
    transaction and requires a clean retry. See
    `docs/3C-2C-PLAN-V5-ADDENDUM.md` for the four ratified corrections and
    `docs/MIGRATION-017-RUNBOOK.md` for the preflight, quiet-window, live-smoke,
    and destructive emergency-rollback procedure.
  * PR 3C-2C — NEXT, in this order: run the reviewed migration 017 only
    after its production preflight passes; build 2C-B so create/edit
    writers verify and consume quotes through the atomic RPCs and replace
    2B2's stale-price alert with the ratified silent refresh; enter
    observe mode; restore the quote-service production configuration
    and smoke it while the browser flag remains off; flip the browser
    flag last; observe real traffic before the irreversible move to
    enforce. One mechanism serves pending and future confirmed edits;
    confirmed editing remains a later product step.
  * PR 3C-3 Manage ride — confirmed-ride editing = the PR #59 pending-edit
    machinery extended (same form/row/details_version CAS), edits
    immediately authoritative, NO driver approval queue (release is the
    valve), driver push "ride changed — review My Rides", urgency from
    the EARLIER of pre/post-edit pickup (>2h normal; ≤2h urgent driver
    push + admin Telegram; at/after pickup Manage ride closed), shadow
    REBOOKING audit from the pre-edit ride inside T-2h (0/50/100, $0
    pilot), before/after revision history (migration 018 or the next
    available number; 017 now belongs to pricing enforcement). NO WhatsApp
    change workflow — WhatsApp stays exceptional human coordination only.
  * NO-SHOW principle (record only, never implemented yet): a driver tap
    must NEVER create a compensated no-show — future review requires an
    Arrived GPS checkpoint, elapsed waiting time, attempted passenger
    contact, and explicit LinkMia approval. No driver payout or passenger
    fee from one status tap.
  * KNOWN LIMITATION (recorded 2026-08-14, flagged for Codex): ADMIN-keyed
    readiness events (at_risk_mark, admin_ready_escalation, recipient_key
    'admin') are one-shot per booking under the ledger identity — after a
    release + re-accept, the replacement driver's era re-stamps at_risk_at
    in the DB and fires fresh DRIVER-keyed asks, but the admin
    at-risk/escalation PINGS collide with the first era's rows and are
    silently skipped. Pilot-acceptable (admin already received the
    ride_released notice); the clean fix needs era-aware admin event
    identity (its own migration decision, not a patch).
- Approved, NOT yet built: invitation-only driver onboarding — emailed
  invite / password-set flow replacing admin-set passwords. Record only;
  implement post-RLS.
- Two-ETA model (Codex-outlined, follows identity) — booking-time estimate
  must use the scheduled pickup as departure time (Railway proxy currently
  uses `now` and its route cache ignores time-of-day); fresh driver→pickup
  ETA at On-my-way and pickup→dropoff at Start-trip (one route call per
  leg, stored via the next numbered migration). Use Google's current
  Routes API (`computeRoutes`, `departureTime` + TRAFFIC_AWARE), not more
  of the legacy Directions endpoint; review Google's storage/attribution
  policies before persisting ETAs. Rounded, timestamped snapshots.
- Ambassador dashboard (mock approved; all queries exist as views).
- Pending-request timeout rule (the trip page already pauses pending
  displays at 10 min — the server-side rule is still open; the watchdog
  is its natural future home). SMS was REJECTED (Aug 2026) — closed-page
  notifications are PWA Web Push per the roadmap above; in-app chat
  stays parked.
- Collaboration pattern: Andres relays between Claude and a second AI
  reviewer (Codex); diagnostics and plans get reviewed before
  implementation is authorized. Respect that gate.
