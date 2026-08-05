# LinkMia — Miami Airport Transfers

Chat-free, web-app-centric ride dispatch platform. Owner (Andres) is currently
admin + the only driver. Passengers book on the web; dispatch, statuses, and
live tracking all live in the web app backed by Supabase.

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
- `trip.html` — passenger live status page (polls `/api/booking-status` 7s):
  stepper, vehicle hero, ETA, live driver map, WhatsApp button, Go back/Cancel.
- `driver.html` — GetTransfer-style driver app behind `DRIVER_PASSCODE`
  (sent as `x-driver-secret`): Requests/My rides tabs, status progression,
  Google Maps navigation handoffs, GPS broadcaster (watchPosition → 10s).
- `login.html` — passenger email+password (self-service signUp). Drivers will
  be admin-provisioned (CreditEngine pattern) — no driver signup ever.
- `admin.html` — legacy dashboard reading Supabase directly with anon key.

## Booking lifecycle

`pending → confirmed → on_the_way → arrived → in_progress → completed`
Terminals: `declined` (driver), `cancelled` (passenger, pending-only).
Transitions are server-enforced in `update-booking-status.js` (stale action →
409). Legacy statuses `assigned` kept for old rows.

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
- Test harness for booking data-mapping exists in session scratchpads —
  pattern: mock `@supabase/supabase-js` via require.cache, run the real
  `create-booking.handler`, assert inserted record fields.
- Verify inline-script syntax by extracting `<script>` blocks → `node --check`.

## Decisions log (do not relitigate casually)

1. Dispatch state NEVER lives in chat apps — web app + Supabase own it.
2. Telegram = private ops notifications; WhatsApp = human channel. Both are
   channels, not infrastructure.
3. Passengers: self-service email+password + guest checkout preserved.
   Drivers: admin-provisioned only. Session: 30-day inactivity timeout.
4. In-app GPS (browser geolocation → Supabase → trip-page map) is the
   tracking backbone; WhatsApp live-location is a manual premium layer.
5. Escalade categorizes as `suv`; display names preserved in `vehicle_name`.
6. Support/driver phone: +1 (786) 509-3955.

## Recently landed (stabilization round, reviewed by a second engineer)

Three commits on the working branch (PR-1/2/3 pattern — merge + field-test):
1. Trip sheet is dismiss-proof (no backdrop close); confirmed cancellation →
   sessionStorage notice → targeted storage cleanup → reload → one-time
   "Booking cancelled" banner on the Where screen. All sheet postMessages
   validated (origin + iframe source + bookingId match).
2. GPS reliability: one-shot location warm-up at Accept (memory-only during
   confirmed); On-my-way/Start-trip run position-fix concurrently with the
   status POST, send the first coordinate (2.5s bound), THEN navigate
   same-tab to Google Maps — navigation is guaranteed after status success.
   Adaptive send tiers (12/45/60/20/60s by status+movement, 30m haversine
   threshold), explicit visible-only gating, single-watcher invariant,
   instant recovery ping on visibility return. trip.html live map now
   initializes via its own window.initGoogleMaps callback (fixes
   "initGoogleMaps is not a function"). Completing a ride wipes stored
   coordinates (privacy).
3. Adaptive polling: driver 12s-with-work / 30→60s idle / paused hidden or
   locked / exponential failure backoff; passenger poll paused while hidden,
   instant on return, 7s while visible. SW cache bumped per PR (v1.3.x).

Driver flow: Requests/My rides tabs; Accept → On my way (nav to pickup) →
Arrived → Start trip (nav to dropoff) → Complete; payment toggle; WhatsApp
links per card. Passenger trip sheet: live map with driver dot + freshness,
WhatsApp pairing button, Go back / Cancel. Telegram doorbell + receipts are
CONFIGURED AND LIVE (env vars set; bot @LinkMiamiBot, send-only).

## Known gaps / next up

- Field-run the stabilization test matrix (plan file / recent session) after
  merging the three stabilization commits.
- Driver identity (admin-provisioned accounts, `assigned_driver` stamping,
  retire shared passcode) — NEXT BUILD, agreed.
- Ambassador dashboard (mock approved; all queries exist as views).
- Pending-request timeout rule; RLS lockdown (anon key currently open via
  admin.html); SMS/WhatsApp notifications with return links; in-app chat +
  web push (parked).
- Collaboration pattern: Andres relays between Claude and a second AI
  reviewer (Codex); diagnostics and plans are reviewed before
  implementation is authorized. Respect that gate.
