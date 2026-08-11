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
- `driver.html` — GetTransfer-style driver app behind a real login
  (admin-provisioned Supabase accounts, `Authorization: Bearer` session
  JWT — the shared passcode is retired): Requests/My rides tabs show
  unassigned pending requests + ONLY this driver's own rides (busy
  drivers see just their rides and cannot accept; inactive is rejected).
  No driver-side Decline (shared requests — not accepting IS declining).
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
  against the shipped routing, watchdog dispatchOne),
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
`cancelled` (passenger, pending-only). Transitions are server-enforced in
`update-booking-status.js`: Accept wins only an UNASSIGNED pending request
and stamps `assigned_driver` atomically; every later action requires an
EXACT ownership match. A stale/foreign action matches 0 rows → the backend
answers 200 `{idempotent:true}` ONLY when status AND owner both match
(verified duplicate), else 409 with `currentStatus` — the client never
interprets a 409 as success. Legacy status `assigned` kept for old rows.

Passenger cancellation (PR 1A, pending only — Blacklane-style policy,
pilot = shadow fees): authorization lives in `lib/cancel-core.js`, shared
verbatim by `/api/cancel-booking` (quote + guarded cancel) and the legacy
`/api/booking-status` cancel action so the rules can never diverge.
`customer_id` set → signed-in OWNER required (401/403/500, auth-outage
discipline); `customer_id` NULL (legacy guest) → the unguessable UUID
remains the capability. Every cancellation stamps the migration-013
shadow audit (from-status, pickup snapshot, policy version `pilot-2026-08`,
fee %/amount, collected $0 — DB CHECK enforced — waiver, actor role +
auth UUID) in the SAME guarded UPDATE as the status flip, and the 013
outbox TRIGGER inserts the `ride_cancelled_admin` ledger event in the
SAME transaction (manual admin SQL cancels get it free). Delivery is the
watchdog's (~5 min); PR 1A has NO immediate dispatch — the API honestly
reports `immediateSubmission:'deferred'`. Confirmed/on_the_way/arrived
self-service cancellation (50%/100% shadow brackets), the driver
`ride_cancelled` push event, and the shared-dispatcher extraction are
PR 2/3 per the Codex-approved progression.

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
   ride. A truly simultaneous first-insert race remains recorded for the
   migration-014 database constraint (013 is the pending-edit version guard).
   Ambassadors remain explicitly
   multi-ride.
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
- Approved, NOT yet built: "Release ride" — a driver returns an accepted
  ride to the shared pool instead of any driver-side decline. Rules:
  CONFIRMED-only (after On my way, releasing requires dispatch/admin
  intervention — the passenger has been told someone is coming); records
  the releasing driver + reason as history; the re-pooled request is NOT
  offered back to the releasing driver; the passenger is informed of the
  driver change; admin is notified on every release. Also approved:
  invitation-only driver onboarding — emailed invite / password-set flow
  replacing admin-set passwords. Record only; implement post-RLS.
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
