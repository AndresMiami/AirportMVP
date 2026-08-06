# LinkMia — Miami Airport Transfers

Chat-free, web-app-centric ride dispatch platform. Owner (Andres) is currently
admin + the only driver. Passengers book on the web; dispatch, statuses, and
verified checkpoint locations all live in the web app backed by Supabase.

## Architecture (one path, one database)

- **Frontend + serverless**: Netlify. Static pages at repo root, functions in
  `backend/functions/`, routes in `netlify.toml`. Deploys from `main`.
- **Database**: Supabase project `qvtqqggtpxesfcmpftej` (paid org). Single
  source of truth: `bookings` is the dispatch table. Anon key is public
  (hardcoded in `supabase.js`); the service key lives ONLY in Netlify env.
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
  Optional auth: session prefills the passenger modal; guests book freely.
  On success the live trip sheet slides up (iframe of `/trip?embed=1`).
- `trip.html` — passenger status page: stepper, vehicle hero, booking-time
  ETA, static verified-checkpoint map marker (honest labels, Miami-time
  stamps, never a moving dot), WhatsApp button, Go back/Cancel. SEALED smart
  polling of `/api/booking-status`: cadence by status (pending 15s /
  confirmed 30s only within 30 min of pickup — farther out sleeps locally
  with zero network / on_the_way 30s / arrived 15s / in_progress 60s),
  hard per-status cutoffs, absolute pickup+6h boundary, persistent
  500-request/booking budget, 5-failure budget per visit, default 30-min
  leash for unknown statuses or malformed timestamps. Paused card is
  notice-only (NO manual refresh button — deliberate); hidden tab = zero
  requests; one automatic check on visibility return is the resume path.
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
  success; lost responses retry once with 409-duplicate-success
  reconciliation.
- `login.html` — passenger email+password (self-service signUp). Drivers ARE
  admin-provisioned (CreditEngine pattern, migration 009) — no signup ever.
- `admin.html` — legacy dashboard reading Supabase directly with anon key.

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
`DRIVER_PASSCODE`, `TELEGRAM_BOT_TOKEN` (secret), `ADMIN_TELEGRAM_CHAT_ID`,
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
3. Passengers: self-service email+password + guest checkout preserved.
   Drivers: admin-provisioned only. Session: 30-day inactivity timeout.
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
   bypass the functions/service-key boundary). Long-term push channel is
   SMS milestone notifications (Blacklane pattern), not sockets — WhatsApp
   stays a human-only conversation link (see decision 2), never automated.
9. Driver identity (PR #49): admin-provisioned Supabase accounts only,
   `assigned_driver` stamped at Accept ONLY (unassigned requests, active
   drivers; busy = finish own rides, no new accepts), exact-match
   ownership on all later actions, idempotent success declared ONLY by
   the backend after verifying status + owner, no driver-side Decline,
   and a passenger WhatsApp button that hides rather than falling back
   to another driver's number.

## Known gaps / next up

- Phase B: RLS lockdown — IMMEDIATELY after PR #49 field-tests clean,
  before any real second driver and before two-ETA (allow-all policies
  still exist; auth alone is not the security boundary). Unblocks
  Supabase Realtime afterwards.
- Driver PWA (plan approved): mobile-first LinkMia Driver app shell —
  bottom nav, payout-primary ride cards, Settings, dedicated manifest +
  icons, SW privacy fixes (networkOnly for all /api/, no-store headers,
  runtime-cache purge), Home-Screen install flow.
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
  displays at 10 min — the server-side rule is still open); RLS lockdown
  (anon key currently open via admin.html); SMS milestone notifications
  with return links (WhatsApp stays human-only); in-app chat + web push
  (parked).
- Collaboration pattern: Andres relays between Claude and a second AI
  reviewer (Codex); diagnostics and plans get reviewed before
  implementation is authorized. Respect that gate.
