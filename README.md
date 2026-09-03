# LinkMia — Miami Airport Transfer Platform

A production booking and dispatch platform for premium airport transfers in
Miami: passengers book on the web with live pricing, drivers run rides from an
installable driver app with verified status checkpoints, and passengers follow
their ride on a live trip page.

**Live:** https://linkmia.com

## What's in the box

- **Booking app** (`indexMVP.html`) — account-based booking flow: route,
  date/time, vehicle selection with live pricing, passenger details. Guest
  checkout is visible but disabled ("coming later").
- **Driver app** (`driver.html`) — installable PWA (scope `/driver`): shared
  request feed, one-tap accept, server-enforced status lifecycle
  (on my way → arrived → start trip → complete) with GPS-verified checkpoints,
  Google Maps navigation handoffs, payment-collected tracking, web push
  reminders. Driver accounts are admin-provisioned.
- **Trip page** (`trip.html`) — live passenger status: progress stepper,
  verified checkpoint map, driver contact via WhatsApp, self-service edit and
  cancel for pending rides. Adaptive, budget-capped polling.
- **Login / landing** (`login.html`, `index.html`) — passenger email+password
  accounts (self-service signup) and the public landing page.
- **Backend** — Netlify serverless functions over Supabase (Postgres + Auth),
  with row-level security locked down: all data access goes through the
  functions using the service key. A Railway Express proxy fronts Google
  Maps REST APIs so the private key never reaches a browser.
- **Notifications** — Telegram doorbell/receipts to the admin (send-only);
  Web Push to drivers (VAPID, per-device subscriptions) with a scheduled
  watchdog and delivery ledger.

## Quick start

### Prerequisites
- Node.js 18+ (Netlify functions run Node 20)
- npm
- Two dedicated Google Maps keys: private Railway REST key + public
  referrer-restricted browser Maps JS key
- Supabase project (database + auth)

### Local development

See [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) for the full guide.

```bash
git clone https://github.com/AndresMiami/AirportMVP.git
cd AirportMVP
npm install
netlify dev            # serves the site + functions on http://localhost:3001
```

The committed Maps browser config is deliberately disabled locally: address
search and booking work; the optional map stays hidden. Exercise the real map
through a referrer-restricted Deploy Preview — the config generator refuses to
place a non-null browser key in an ordinary local checkout.

### Tests

```bash
npm install
for t in tests/*.test.js; do node "$t"; done   # 30 suites, exit nonzero on failure
```

The suites mock `@supabase/supabase-js` via `require.cache` and run the real
function handlers, asserting exact payloads and query filters. Several suites
are deliberate tripwires (service-worker cache version pins, the tracked-`.md`
force-404 inventory) that fail when repo conventions are skipped.

## Project structure

```
AirportMVP/
├── indexMVP.html            # Booking app
├── driver.html              # Driver PWA (+ driver-sw.js, driver-manifest.json)
├── trip.html                # Live passenger trip page
├── login.html / index.html  # Front door + landing
├── terms.html / privacy.html
├── css/                     # Stylesheets
├── js/                      # Modal controllers (passenger, payment, notes, promo)
├── pricing.js               # Client pricing engine
├── maps-loader.js           # Direct Maps JS loader (browser key)
├── service-worker.js        # Passenger PWA cache (versioned; bump on asset change)
├── backend/
│   ├── api-proxy/server.js  # Railway Google Maps proxy
│   └── functions/           # Netlify serverless functions + lib/
├── database/                # Schema + numbered migrations (run manually in
│                            #   the Supabase SQL editor, in order)
├── tests/                   # 30 behavioral test suites
├── docs/                    # Internal documentation (not publicly served)
└── dev/archive/             # Retired code kept for history (never re-enable)
```

## Configuration

### Railway (Google Maps REST proxy — private key)
```env
GOOGLE_MAPS_API_KEY=your_private_rest_key
ALLOWED_ORIGINS=http://localhost:*,https://linkmia.com,https://i-love-miami.netlify.app
NODE_ENV=production
PORT=3001
```

### Netlify builds (public browser key)
```env
GOOGLE_MAPS_BROWSER_API_KEY=your_referrer_restricted_browser_key
```
Use separate Production and Deploy Preview contextual values (and a Branch
Deploy value if branch deploys are enabled). This browser key is visible to
every browser by design; restrict it in GCP to the approved website referrers
and only the APIs it needs. Use the exact preview hostname — never a broad
`*.netlify.app` referrer. Never reuse the private Railway key. Before merge,
also complete the quota caps, billing alerts, and fail-closed Netlify ordering
in [SETUP.md](SETUP.md).

### Netlify functions (set in the Netlify dashboard)
```env
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_service_key        # secret — functions only
TELEGRAM_BOT_TOKEN=your_telegram_bot_token   # secret
ADMIN_TELEGRAM_CHAT_ID=your_admin_chat_id
```
Web push additionally uses VAPID keys; quote-signing and feature kill switches
use their own variables — see the function headers for the authoritative list.

## API endpoints

### Netlify functions
- `POST /api/create-booking` — create a booking (authenticated)
- `POST /api/update-pending-booking` — edit a pending ride in place
- `GET  /api/booking-status` — passenger trip status (+ legacy cancel action)
- `POST /api/cancel-booking` — quote-first passenger cancellation
- `GET  /api/driver-bookings` — driver request feed + own rides
- `POST /api/update-booking-status` — driver lifecycle actions (accept → complete)
- `POST /api/release-booking` — driver releases a confirmed ride back to the pool
- `POST /api/quote-ride` — server-side quote service
- `GET  /api/operation-status` — booking-operation receipt lookup
- `GET  /api/profile` — passenger profile + account continuity
- `POST /api/driver-push-subscription` — driver push device management
- `notification-watchdog` — scheduled function (every 5 minutes)
- `/api/track-flight` — reserved (not yet implemented)

### Railway proxy
- `GET /health` · `GET /api/places/autocomplete` · `GET /api/places/details`
- `POST /api/directions` · `GET /api/geocoding`

## Payments

Cash or Zelle, collected by the driver and tracked in-app. The legacy in-app
card path is archived under `dev/archive/legacy-stripe/` per internal
architecture decision INV-3 and must not be re-enabled.

## Vehicles

| Vehicle | Class | Passengers |
|---|---|---|
| Tesla Model Y | sedan | 4 |
| Cadillac Escalade | suv | 7 |
| Mercedes Sprinter | sprinter | 12 |

## Security

- Row-level security: default-deny on all tables; zero client-role grants;
  data flows only through serverless functions holding the service key
- Google Maps private key never leaves the Railway proxy; browser key is
  referrer- and API-restricted in GCP
- Service worker never intercepts data APIs (no `/api/*`, no functions, no
  proxy); driver pages are never cached
- Internal Markdown is force-404'd by enumerated `netlify.toml` rules
  (test-enforced), so the published site serves no project docs
- Rate limiting on the API proxy (100 req/15min)

## Deployment

- **Netlify** (site + functions): auto-deploys from `main`; settings in
  `netlify.toml`. Set the context-specific `GOOGLE_MAPS_BROWSER_API_KEY`
  with **Builds** scope before merging browser-key changes.
- **Railway** (Maps proxy): root directory `/backend/api-proxy`,
  auto-deploys from `main`.
- **Database**: migrations in `database/migrations/` are run manually in the
  Supabase SQL editor, in numbered order.

## Development workflow

Branch → commit → push → pull request → review → merge to `main` (never push
to `main` directly). Service-worker `CACHE_NAME` must be bumped whenever
cached assets change — the test suite enforces it. Inline `<script>` blocks
can be syntax-checked by extraction + `node --check`.

## Documentation

- [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md) — local setup
- [SETUP.md](SETUP.md) — keys, quotas, deployment ordering
- [ARCHITECTURE.md](ARCHITECTURE.md) — system overview
- `docs/` — internal design docs and runbooks (not publicly served)

## Project status

- **Status:** production, live at https://linkmia.com
- **Last updated:** September 2026

## License

Private repository — all rights reserved.

---

Built with ❤️ for Miami airport transfers
