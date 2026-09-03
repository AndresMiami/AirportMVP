# Architecture Overview

LinkMia is one platform with three user-facing apps sharing one backend and
one source of truth.

## The apps

```
indexMVP.html   Booking app (account-based; ~4,700 lines, all UI inline)
driver.html     Driver PWA  (scope /driver; own service worker + manifest)
trip.html       Live passenger trip page (embedded in the booking app or standalone)
login.html      Passenger accounts — the front door for booking
index.html      Public landing page
```

## Tech stack

- **Frontend:** vanilla HTML/CSS/JavaScript, no build step
- **Backend:** Netlify serverless functions (Node 20)
- **Database + auth:** Supabase (Postgres, row-level security locked to
  default-deny; all data access via functions holding the service key)
- **Maps:** Google Maps — private REST key behind a Railway Express proxy
  (Places, Directions, Geocoding); public referrer-restricted browser key
  for the Maps JS map itself, loaded directly from Google
- **Notifications:** Telegram Bot API (admin, send-only) and Web Push/VAPID
  (drivers, per-device), with a scheduled watchdog + delivery ledger
- **Payments:** cash/Zelle collected by the driver, tracked in-app (legacy
  in-app card path archived under `dev/archive/legacy-stripe/`; INV-3)
- **Hosting:** Netlify (site + functions) and Railway (maps proxy), both
  deploying from `main`

## Data flow

```
Passenger ──▶ indexMVP.html ──▶ /api/* Netlify functions ──▶ Supabase
                    │                (service key; the ONLY data path)
                    ├──▶ Railway proxy (autocomplete, route facts)
                    └──▶ maps.googleapis.com (map display, browser key)

Driver ─────▶ driver.html ────▶ /api/driver-* + /api/update-booking-status
                                    │  server-enforced lifecycle:
                                    │  accept → on my way → arrived
                                    │  → start trip → complete
                                    └─ GPS checkpoint captured in the
                                       same atomic status update

Trip page ──▶ /api/booking-status (adaptive, budget-capped polling)

Watchdog (scheduled, 5 min) ──▶ ledger ──▶ Web Push ▶ driver
                                        └▶ Telegram ▶ admin
```

## Core principles

- **One source of truth.** Dispatch state lives in Supabase only. Telegram
  and WhatsApp are channels, never state.
- **Default-deny database.** RLS is enabled with zero client-role grants;
  the anon key is auth-only. Every read and write flows through a serverless
  function.
- **Server-enforced lifecycle.** Ride transitions are guarded updates:
  accept atomically claims an unassigned request; every later action
  requires exact ownership; retries are recognized as idempotent only by
  the backend after verifying status and owner.
- **Checkpoint location model.** Driver location is captured once, inside
  each status tap, and stamped atomically with the transition. No continuous
  tracking; coordinates are cleared at completion.
- **No build step.** Pages run as committed. The passenger service worker is
  versioned (`CACHE_NAME`) and must be bumped when cached assets change —
  test-enforced. Data APIs are never service-worker intercepted.
- **Key separation.** The private Maps key never leaves Railway; the browser
  key is public by design and restricted in GCP by referrer and API.

## Key files

- `indexMVP.html` — booking UI + inline app logic
- `driver.html`, `driver-sw.js`, `driver-manifest.json` — driver PWA
- `trip.html` — live trip page
- `pricing.js` — client pricing engine
- `backend/functions/` — API endpoints + `lib/` (shared dispatch,
  notification, quote modules)
- `backend/api-proxy/server.js` — Railway maps proxy
- `database/` — schema + numbered migrations (run manually, in order)
- `tests/` — 30 behavioral suites (mock the DB, run real handlers)
