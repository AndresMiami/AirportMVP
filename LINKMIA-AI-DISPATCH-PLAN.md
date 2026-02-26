# LinkMia AI-Powered Ride Dispatch System — Build Plan

## Table of Contents
- [Step 1: Codebase Exploration Findings](#step-1--codebase-exploration-findings)
- [Step 2: Gap Analysis](#step-2--gap-analysis)
- [Step 3: Phased Build Plan](#step-3--phased-build-plan)
- [Step 4: Agent SDK Architecture](#step-4--agent-sdk-architecture)
- [Technical Risks & Mitigations](#technical-risks--mitigations)

---

## Step 1 — Codebase Exploration Findings

### Tech Stack
| Layer | Technology | Status |
|-------|-----------|--------|
| Frontend | Vanilla HTML/CSS/JS (no framework) | Deployed on Netlify |
| Backend | Netlify serverless functions (Node.js) | 6 functions live |
| API Proxy | Express.js on Railway | Google Maps proxy with caching |
| Database | Supabase PostgreSQL | 6 tables, views, RLS enabled |
| Payments | Stripe (test mode) | Fully integrated, disabled in flow |
| Telegram | Telegram Bot API | Passenger + driver + admin messaging |
| Maps | Google Maps via Railway proxy | Autocomplete, directions, geocoding |

### Database Schema (Supabase)

**6 Tables:**

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `customers` | id, name, phone, email, type (guest/repeat/vip/host), total_rides, total_spent | Passenger profiles |
| `drivers` | id, name, phone, vehicle_type, status (active/busy/inactive), commission_rate (default 0.75), rating | Driver profiles |
| `bookings` | id, customer_id, pickup_location, dropoff_location, pickup_datetime, vehicle_type, status, assigned_driver, price, payment_status | Main dispatch table |
| `payments` | id, booking_id, amount, type, method | Payment tracking |
| `hosts` | id, name, referral_code, commission_rate (0.10) | B2B referral partners |
| `activity_log` | id, entity_type, action, old_value (JSONB), new_value (JSONB) | Audit trail |

**3 Views:** `todays_bookings`, `pending_assignments`, `revenue_summary`

**Booking Status Flow:** `pending → confirmed → assigned → in_progress → completed | cancelled`

**Driver Payout:** Computed as `price * 0.75` (75% to driver, 25% LinkMia commission)

### Backend Functions (Netlify Serverless)

| Function | Endpoint | Status | What It Does |
|----------|----------|--------|-------------|
| `create-booking.js` | POST `/api/create-booking` | **Working** | Creates booking + Telegram admin notification |
| `calculate-price.js` | POST `/api/calculate-price` | **Working** | Server-side pricing (prevents tampering) |
| `create-payment-intent.js` | POST `/api/create-payment-intent` | **Working** | Stripe PaymentIntent creation |
| `create-payment.js` | POST `/api/create-payment` | **Working** | Duplicate of above |
| `create-checkout-session.js` | POST `/api/create-checkout-session` | **Working** | Stripe Checkout hosted page |
| `stripe-config.js` | GET `/api/stripe-config` | **Working** | Returns Stripe public key |
| `confirm-payment.js` | `/api/confirm-payment` | **Missing** | Referenced but not built |
| `track-flight.js` | `/api/track-flight` | **Missing** | Referenced but not built |

### Express Proxy Server (Railway)

Deployed at `reliable-warmth-production-d382.up.railway.app`

| Endpoint | Purpose | Caching |
|----------|---------|---------|
| GET `/api/places/autocomplete` | Address suggestions | None |
| GET `/api/places/details` | Place details | 7-day cache |
| POST `/api/directions` | Route distance/duration | 24-hour cache |
| GET `/api/geocoding` | Address → coordinates | None |
| GET `/api/maps-script` | Google Maps JS library | Cached |

Features: Rate limiting (100 req/15 min), in-memory caching, CORS, pre-cached airports (MIA, FLL, PBI).

### Frontend Application

**`indexMVP.html`** — 2,671 lines, single monolith file. 3-step booking flow:
1. **WHERE** — Address autocomplete + airport grid (MIA, FLL, PBI) + trip mode toggle
2. **WHEN** — Date picker + time selector + optional flight number
3. **VEHICLE** — Carousel (Tesla $132, Escalade $165, Sprinter $220) + passenger modal + booking confirmation

**JavaScript files (7,216 lines total):**
- `pricing.js` (794 lines) — Tiered pricing, surcharges (night +15%, weekend +10%, rush +20%), popular route flat rates, psychological pricing
- `autocomplete.js` (532 lines) — Google Places API wrapper with session tokens and caching
- `datetime-utils.js` (313 lines) — Date/time picker logic
- `js/payment-modal.js` (1,302 lines) — Card selection, Apple Pay detection
- `js/passenger-modal.js` (840 lines) — Self/guest passenger forms
- `js/stripe-payment.js` (809 lines) — Full Stripe integration with retry logic
- `js/promotion-modal.js` (793 lines) — Promo code validation
- `js/pickup-note-modal.js` (554 lines) — Chauffeur notes

**`admin.html`** — Dispatch dashboard with booking management, driver list, customer management, real-time Supabase subscription.

### Existing Integrations

**Stripe:** Fully integrated. Test key `pk_test_51R05aBI...`. PaymentIntents, Checkout Sessions, Apple Pay. Currently disabled (`REQUIRE_PAYMENT = false`) — payments handled manually via Telegram.

**Telegram:** `create-booking.js` sends formatted admin notifications with inline keyboard buttons for approve/reject. Bot token stored in `TELEGRAM_BOT_TOKEN`.

**Google Maps:** Full integration via Railway proxy — autocomplete, directions, geocoding with caching.

### What Does NOT Exist

| Feature | Status |
|---------|--------|
| Telegram bot handlers | **Zero code** — notification works, no incoming handler |
| Firebase | **Zero code** — no config, no references |
| AI/Claude/Agent SDK | **Zero code** — no references |
| Incoming Telegram handling | **Nothing** — only outbound notifications |
| Real-time driver tracking | **Nothing** — no location code |
| Driver-facing app | **Archived HTML mockups only** in `dev/archive/` |
| Memory/personalization | **Nothing** |
| Bilingual support | **English only** |
| Payment webhooks | **Nothing** — no Stripe webhook handler |
| Ride lifecycle state machine | **Nothing** — status exists in DB but no enforcement |

### Archive Directory (`dev/archive/`)

| File | What It Contains | Reusable? |
|------|-----------------|-----------|
| `airport-transfer-system/driver-app/Driver.html` | Driver dashboard UI mockup with booking cards, flight tracking timeline, status buttons | UI patterns only |
| `airport-transfer-system/passenger-app/Passenger.html` | Passenger tracking page with live map, ETA, driver info, progress timeline | UI patterns for tracking page |
| `pricing-simple.js` | Earlier version of pricing service | Superseded by current `pricing.js` |
| `tracking-app/index.html` | Generic tracking interface | Minimal |

### Environment Variables Required

```
# Google Maps (Railway)
GOOGLE_MAPS_API_KEY, ALLOWED_ORIGINS, PORT

# Supabase
SUPABASE_URL=https://hncpybxwblpkyxvskoxd.supabase.co
SUPABASE_ANON_KEY=[exists, hardcoded in supabase.js]

# Stripe
STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET

# Telegram
TELEGRAM_BOT_TOKEN=[create via @BotFather]
TELEGRAM_WEBHOOK_SECRET=[random string]
ADMIN_TELEGRAM_CHAT_ID=[get via getUpdates API]
```

---

## Step 2 — Gap Analysis

### Can Reuse Directly (No Changes)

| Asset | File | Why |
|-------|------|-----|
| Pricing engine | `pricing.js` | Already has vehicle configs, tiered rates, surcharges. Can wrap in MCP server directly. |
| Database schema | `database/linkmia-schema.sql` | Booking status flow, driver/customer tables, payment tracking — all designed for dispatch. |
| Google Maps proxy | `backend/api-proxy/server.js` | Caching, rate limiting, all needed endpoints. MCP server wraps existing proxy. |
| Stripe payment functions | `backend/functions/create-payment-intent.js` | PaymentIntent creation logic reusable for payment links. |
| Admin dashboard | `admin.html` | Realtime Supabase subscriptions, booking/driver/customer management — works as admin view. |
| Supabase client | `supabase.js` | Connection config, CRUD helpers. |

### Needs Modification

| Asset | File | Change Needed |
|-------|------|---------------|
| `create-booking.js` | `backend/functions/` | Currently does NOT write to Supabase — only sends notifications. Add Supabase insert. |
| `server.js` (Railway) | `backend/api-proxy/` | Add webhook route for Telegram. Currently only handles Maps. |
| Database schema | `database/linkmia-schema.sql` | Add `customer_memory` table for personalization. Add `language` column to customers. |

### Must Build From Scratch

| Component | Complexity | Details |
|-----------|-----------|---------|
| Telegram bot + handlers | Medium | Bot setup, command handlers, inline keyboards, callback queries, live location processing, passenger + driver handling |
| Firebase setup + integration | Medium | Project creation, Realtime DB for driver locations + ride state, security rules |
| Claude Agent SDK bridge | Medium | The core ~150-line bridge: message → Claude subprocess → response |
| SKILL.md dispatch context | Small | System prompt defining Claude's dispatcher persona and rules |
| 5 MCP servers | Large | supabase-mcp (8 tools), maps-mcp (3 tools), pricing-mcp (3 tools), messaging-mcp (4 tools), stripe-mcp (4 tools) |
| Ride state machine | Small | Firebase state management with valid transition enforcement |
| Dispatch engine | Medium | Driver matching, offer queue, timeout handling |
| Conversation state manager | Small | Per-phone conversation context with TTL |
| Memory layer | Medium | Fact extraction, persistence, injection into agent context |
| Language detection + i18n | Small | Spanish/English detection + bilingual notification templates |
| Tracking page | Medium | Live map with Firebase driver location, ETA, status |
| Payment link flow | Small | Stripe Payment Links + webhook handler |
| Driver earnings/availability | Small | Commission calculation, status management, Telegram commands |

### Biggest Technical Risk

**Claude agent latency vs Telegram user expectations.** Claude subprocess may take 5-15 seconds. Mitigation: Send immediate "Un momento..." / "One moment..." acknowledgment within 1 second via Telegram sendChatAction, process agent response async, send follow-up message.

---

## Step 3 — Phased Build Plan

### Phase 1: Foundation (Must Exist Before Anything Works)

**Goal:** Infrastructure that all subsequent phases depend on — Firebase, webhook receivers, Telegram bot skeleton, message routing.

#### 1.1 Firebase Project Setup

Create Firebase project and configure Realtime Database.

**Files to create:**
- `agent/firebase/firebase-config.js` — Firebase Admin SDK initialization
- `agent/firebase/ride-state.js` — Ride lifecycle state machine
  ```
  States: pending → driver_offered → driver_assigned → driver_en_route →
          driver_arrived → in_progress → completed | cancelled

  Firebase structure:
  /rides/{bookingId}: { status, driverId, passengerId, pickup, dropoff, ... }
  /drivers/{driverId}/location: { lat, lng, timestamp }
  /drivers/{driverId}/status: "available" | "offered" | "busy" | "offline"
  ```
- `agent/firebase/driver-location.js` — Read/write driver location
- `agent/firebase/database.rules.json` — Security rules

**Environment variables to add:**
```
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
FIREBASE_DATABASE_URL
```

#### 1.2 Telegram Bot Setup

Create unified Telegram bot for both passengers and drivers.

**Files to create:**
- `agent/telegram/telegram-bot.js` — Bot initialization using `node-telegram-bot-api`. Registers webhook at `POST /webhook/telegram` on the Railway server.
  - Handles `/start` with payload: `t.me/LinkMiaBot?start=booking_B1234` → greets passenger with booking info
  - Handles `/start` without payload: new user greeting
  - Handles `/available`, `/busy`, `/offline` for drivers
- `agent/telegram/telegram-handlers.js` — Processes callback queries (accept_ride, decline_ride, approve_booking, reject_booking), incoming commands, and live location updates.
- `agent/telegram/telegram-templates.js` — Bilingual message templates for notifications.

**Files to modify:**
- `backend/api-proxy/server.js` — Add `POST /webhook/telegram` route.

**Environment variables:**
```
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
ADMIN_TELEGRAM_CHAT_ID
```

#### 1.3 Message Router

Normalize messages from Telegram into a common format.

**Files to create:**
- `agent/router/message-router.js` — Accepts messages from Telegram, normalizes to `{ source, chatId, text, timestamp, metadata, isDriver }`, routes to appropriate handler (agent bridge for passengers, command handler for drivers).

#### 1.4 Fix create-booking.js

**Files to modify:**
- `backend/functions/create-booking.js` — Add Supabase insert after generating booking ID. Currently only sends Telegram notification but doesn't persist to database.

#### Testing Phase 1
1. Firebase: Write and read a test ride document via Node.js script
2. Telegram passenger: Click `t.me/LinkMiaBot?start=booking_TEST`, verify bot responds with greeting
3. Telegram driver: Send `/start` to bot, verify it responds with driver menu
4. Message router: Send test messages, verify normalization

---

### Phase 2: Core Dispatch Loop (Minimum Viable Ride)

**Goal:** Passenger sends Telegram message → Claude processes intent → booking created → driver notified via Telegram. No live tracking yet.

**Dependencies:** Phase 1 complete

#### 2.1 Agent Bridge (The Core — ~150 Lines)

**Files to create:**
- `agent/bridge/agent-bridge.js` — Main entry point. Structure:
  ```javascript
  // 1. Receive normalized message from router
  // 2. Load conversation state for this phone number
  // 3. Load user memory from Supabase (if returning customer)
  // 4. Build system prompt: SKILL.md + memory context
  // 5. Spawn Claude Agent SDK subprocess with:
  //    - System prompt
  //    - Conversation history
  //    - MCP server configs (supabase, maps, pricing, messaging)
  //    - maxTurns: 10
  //    - model: claude-sonnet-4-20250514
  // 6. Collect agent response
  // 7. Send response via Telegram (through messaging tools or direct API)
  // 8. Update conversation state
  ```
- `agent/bridge/skill-loader.js` — Reads SKILL.md, appends dynamic context (memory, active rides)
- `agent/bridge/response-sender.js` — Routes agent output to correct channel

#### 2.2 SKILL.md (Dispatch Context)

**Files to create:**
- `agent/SKILL.md` — System prompt defining Claude's dispatcher persona:
  ```markdown
  # LinkMia AI Dispatch Agent

  ## Identity
  You are the AI dispatcher for LinkMia, a premium transportation
  service in Miami. You communicate with passengers via Telegram
  in their preferred language (Spanish or English).

  ## Vehicles
  - Tesla Model Y: 4 pax, 4 bags, ~$132+
  - Cadillac Escalade: 7 pax, 8 bags, ~$165+
  - Mercedes Sprinter: 12 pax, 15 bags, ~$220+

  ## Dispatch Flow
  1. Greet passenger. Detect language.
  2. Extract: pickup, dropoff, date/time, party size.
  3. If info missing, ask naturally (one question at a time).
  4. Use get_route_info tool for distance/duration.
  5. Use calculate_price tool for vehicle options.
  6. Present options with prices.
  7. On confirmation, use create_booking tool.
  8. Use find_available_driver tool.
  9. Use notify_driver tool.
  10. Confirm to passenger.

  ## Language
  - Spanish message → respond in Spanish
  - English message → respond in English
  - Mixed → default to Spanish (Miami market)

  ## Constraints
  - Never share driver phone numbers
  - Never quote price without calculate_price tool
  - Always confirm details before creating booking
  - Service area: South Florida, max 280 miles
  ```

#### 2.3 MCP Servers (5 Servers, 22 Tools)

**`agent/mcp-servers/supabase-mcp/index.js`** — 8 tools:
| Tool | Purpose |
|------|---------|
| `lookup_customer(phone)` | Find customer by phone |
| `create_customer(name, phone, language)` | Insert new customer |
| `create_booking(data)` | Insert into Supabase bookings + create Firebase ride state |
| `update_booking_status(bookingId, status)` | Update both Supabase and Firebase |
| `find_available_driver(vehicleType, location)` | Query drivers where status=active, match vehicle |
| `assign_driver(bookingId, driverId)` | Update booking, update Firebase, set driver busy |
| `get_booking(bookingId)` | Fetch booking details |
| `get_customer_history(phone)` | Get past bookings |

**`agent/mcp-servers/maps-mcp/index.js`** — 3 tools (wraps existing Railway proxy):
| Tool | Purpose |
|------|---------|
| `get_route_info(origin, destination)` | Distance, duration via existing `/api/directions` |
| `geocode_address(address)` | Lat/lng via existing `/api/geocoding` |
| `autocomplete_place(input)` | Suggestions via existing `/api/places/autocomplete` |

**`agent/mcp-servers/pricing-mcp/index.js`** — 3 tools (wraps existing `pricing.js`):
| Tool | Purpose |
|------|---------|
| `calculate_price(vehicleType, distance, duration, dateTime)` | Uses existing PricingService class |
| `get_all_vehicle_prices(distance, duration, dateTime)` | All 3 vehicles compared |
| `check_surge_pricing(dateTime)` | Active surcharges for time |

**`agent/mcp-servers/messaging-mcp/index.js`** — 4 tools:
| Tool | Purpose |
|------|---------|
| `send_telegram(chatId, message, keyboard)` | Send via Telegram bot (passengers and drivers) |
| `send_telegram_admin(message, keyboard)` | Send to admin chat (booking notifications) |
| `notify_driver_new_ride(driverId, bookingData)` | Formatted ride offer with accept/decline |
| `notify_passenger_driver_assigned(chatId, driverName, vehicle, eta)` | Telegram confirmation to passenger |

**`agent/mcp-servers/stripe-mcp/index.js`** — 4 tools (Phase 5, but skeleton in Phase 2):
| Tool | Purpose |
|------|---------|
| `create_payment_intent(bookingId, amount)` | Reuses existing Netlify function logic |
| `send_payment_link(chatId, bookingId, amount)` | Stripe Payment Link via Telegram |
| `check_payment_status(bookingId)` | Payment intent status check |
| `process_refund(bookingId, amount)` | Stripe refund |

#### 2.4 Conversation State

**Files to create:**
- `agent/state/conversation-state.js` — In-memory store keyed by phone number:
  ```javascript
  {
    phone: '+1234567890',
    messages: [{ role: 'user'|'assistant', content: '...' }],
    currentBooking: { /* partial booking data */ },
    language: 'es' | 'en',
    lastActivity: timestamp,
    ttl: 30 * 60 * 1000  // 30 min timeout
  }
  ```

#### 2.5 Dispatch Engine

**Files to create:**
- `agent/dispatch/dispatch-engine.js` — Driver matching and offer queue:
  1. Query available drivers matching vehicle type
  2. Sort by proximity (if location available) or round-robin
  3. Offer to best driver via Telegram with accept/decline inline keyboard
  4. Wait 2 minutes for response
  5. If declined or timeout, offer to next driver
  6. After 3 attempts, notify passenger of delay

#### Testing Phase 2
1. Send Telegram: "Necesito un ride de MIA a Brickell" → verify agent asks for time
2. Complete full conversation → verify booking in Supabase
3. Verify driver gets Telegram notification with accept/decline buttons
4. Driver taps Accept → verify passenger gets Telegram confirmation
5. Driver declines → verify next driver gets the offer

---

### Phase 3: Live Tracking + Passenger Experience

**Goal:** Real-time driver location, "Where's my driver?" queries, ETA updates, shareable tracking page.

**Dependencies:** Phase 2 complete

#### 3.1 Driver Location via Telegram

**Files to modify:**
- `agent/telegram/telegram-handlers.js` — On `accept_ride` callback, request driver to share live location. Process Telegram `edited_message` with `location` type → write to Firebase `/drivers/{id}/location`.

**Files to create:**
- `agent/telegram/location-tracker.js` — Processes Telegram live location updates → Firebase writes

#### 3.2 Tracking Page

**Files to create:**
- `tracking.html` — Lightweight page accessible via `?ride={bookingId}&token={token}`:
  - Google Map with live driver marker (Firebase listener)
  - Pickup/dropoff markers with route line
  - ETA card (updates every 30 seconds via Maps API)
  - Driver info card (name, vehicle, plate — no phone)
  - Status indicator (en route / arriving / in progress)

- `agent/tracking/tracking-token.js` — HMAC-SHA256 tokens for tracking URLs

#### 3.3 "Where's My Driver?" via Telegram

**Files to modify:**
- `agent/SKILL.md` — Add tracking query instructions
- `agent/mcp-servers/supabase-mcp/index.js` — Add `get_active_ride(chatId)` tool

Agent flow: passenger asks → lookup active ride → get driver location from Firebase → calculate ETA via Maps → respond with ETA + tracking link.

#### 3.4 Proactive ETA Notifications

**Files to create:**
- `agent/tracking/eta-notifier.js` — Monitors active rides via Firebase. Sends Telegram when driver is 5 minutes away.

#### Testing Phase 3
1. Accept ride as driver → share live location → verify marker moves on tracking page
2. Send "Where's my driver?" → verify ETA response with tracking link
3. Simulate driver approaching → verify 5-minute notification fires

---

### Phase 4: Memory + Personalization

**Goal:** Remember passengers, detect language, proactive suggestions, relationship building.

**Dependencies:** Phase 2 complete (can run parallel to Phase 3)

#### 4.1 Memory Layer

**Database change — add to Supabase:**
```sql
CREATE TABLE customer_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone TEXT NOT NULL,
  memory_type TEXT NOT NULL,  -- 'preference', 'fact', 'pattern'
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  confidence DECIMAL(3,2) DEFAULT 1.0,
  source TEXT DEFAULT 'inferred',
  last_used TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_memory_phone_key ON customer_memory(customer_phone, key);
```

**Files to create:**
- `agent/memory/memory-layer.js` — Read/write memory entries per phone number
- `agent/memory/memory-extractor.js` — Post-conversation Claude call to extract facts
- `agent/memory/memory-formatter.js` — Builds memory context string for SKILL.md injection
- `agent/memory/customer-tier.js` — Auto-upgrade: guest → repeat (3+ rides) → VIP (10+ rides or $2000+)

**Example memory entries:**
```
{ key: 'language', value: 'es', confidence: 0.95 }
{ key: 'preferred_vehicle', value: 'escalade', confidence: 0.8 }
{ key: 'home_address', value: '1200 Brickell Ave', confidence: 0.9 }
{ key: 'child_seats_needed', value: 2, confidence: 1.0 }
```

#### 4.2 Bilingual Support

**Files to create:**
- `agent/i18n/language-detector.js` — Pattern matching for Spanish indicators (accented chars, common words). Falls back to memory preference. Default: Spanish.
- `agent/i18n/templates.js` — Structured notifications in both languages:
  ```javascript
  driver_assigned: {
    en: (name, vehicle, eta) => `Your driver ${name} is on the way in a ${vehicle}. ETA: ${eta} min.`,
    es: (name, vehicle, eta) => `Tu chofer ${name} va en camino en un ${vehicle}. Llega en: ${eta} min.`
  }
  ```

#### 4.3 Proactive Suggestions

**Files to modify:**
- `agent/SKILL.md` — Add section on using memory for suggestions:
  - If returning passenger, reference past rides ("Same route as last time?")
  - Pre-suggest preferred vehicle
  - Offer to schedule at usual time

#### Testing Phase 4
1. Complete 2 rides in Spanish → verify language memory is stored
2. Start new conversation from same number → verify Spanish greeting
3. Verify preferred vehicle is suggested based on history
4. Verify customer auto-upgrades after 3 rides

---

### Phase 5: Payments + Driver Management

**Goal:** Stripe charges on completion, payment links via Telegram, driver earnings tracking, availability management.

**Dependencies:** Phase 2 complete

#### 5.1 Payment Flow

**Files to create:**
- `agent/payments/payment-links.js` — Generate Stripe Payment Links with booking metadata
- `agent/payments/receipt-generator.js` — Bilingual receipt formatting for Telegram
- `backend/api-proxy/webhooks/stripe-webhook.js` — Handle `payment_intent.succeeded` and `payment_intent.payment_failed`

**Payment sequence:**
1. Driver taps "Completed" in Telegram
2. Firebase ride state → `completed`
3. Agent sends passenger: payment summary + Stripe Payment Link via Telegram
4. Passenger taps link → pays on Stripe-hosted page
5. Stripe webhook fires → updates `bookings.payment_status` to `paid_by_guest`
6. Passenger receives receipt via Telegram
7. Driver receives earnings confirmation via Telegram

**Files to modify:**
- `backend/api-proxy/server.js` — Add `POST /webhook/stripe` route

#### 5.2 Driver Earnings

**Files to create:**
- `agent/drivers/earnings-tracker.js` — Commission calculation (75%), daily/weekly/monthly totals
- `agent/drivers/availability-manager.js` — Status management across Supabase + Firebase, auto-offline after inactivity

#### 5.3 Telegram Driver Commands

**Files to modify:**
- `agent/telegram/telegram-handlers.js` — Add:
  - `/earnings` — Today + weekly summary
  - `/history` — Last 5 completed rides
  - `/available` / `/busy` / `/offline` — Status toggles

#### Testing Phase 5
1. Complete ride → verify payment link sent via Telegram
2. Pay with Stripe test card → verify webhook fires and booking updates
3. Check driver earnings via `/earnings` command
4. Toggle availability, verify both Supabase and Firebase update

---

## Step 4 — Agent SDK Architecture

### Conceptual Bridge File (`agent/bridge/agent-bridge.js`)

```javascript
import { AgentSDK } from '@anthropic-ai/claude-agent-sdk';

// ~150 lines total
export async function handleIncomingMessage(normalizedMessage) {
  const { phone, text, source } = normalizedMessage;

  // 1. Load conversation state
  const conversation = conversationState.get(phone);

  // 2. Load user memory
  const memories = await memoryLayer.getMemories(phone);
  const memoryContext = memoryFormatter.format(memories);

  // 3. Build system prompt
  const skillDoc = await skillLoader.load();
  const systemPrompt = `${skillDoc}\n\n${memoryContext}`;

  // 4. Configure MCP servers
  const mcpServers = {
    supabase: { command: 'node', args: ['./mcp-servers/supabase-mcp/index.js'] },
    maps:     { command: 'node', args: ['./mcp-servers/maps-mcp/index.js'] },
    pricing:  { command: 'node', args: ['./mcp-servers/pricing-mcp/index.js'] },
    messaging:{ command: 'node', args: ['./mcp-servers/messaging-mcp/index.js'] },
    stripe:   { command: 'node', args: ['./mcp-servers/stripe-mcp/index.js'] }
  };

  // 5. Spawn Claude subprocess
  const agent = new AgentSDK({
    model: 'claude-sonnet-4-20250514',
    systemPrompt,
    mcpServers,
    maxTurns: 10,
    messages: conversation.messages
  });

  // 6. Run agent
  const response = await agent.run(text);

  // 7. Send response
  await responseSender.send(phone, response, source);

  // 8. Update state
  conversationState.update(phone, text, response);

  // 9. Extract memories (async, non-blocking)
  memoryExtractor.extract(phone, conversation.messages).catch(console.error);
}
```

### MCP Server Summary

```
agent/mcp-servers/
├── supabase-mcp/    8 tools  (database operations)
├── maps-mcp/        3 tools  (wraps existing Railway proxy)
├── pricing-mcp/     3 tools  (wraps existing PricingService)
├── messaging-mcp/   4 tools  (Telegram outbound for passengers, drivers, admin)
└── stripe-mcp/      4 tools  (payments)

Total: 22 tools across 5 MCP servers
```

### Full File Tree for `agent/` Directory

```
agent/
├── bridge/
│   ├── agent-bridge.js          # Core: message → Claude subprocess → response
│   ├── skill-loader.js          # Loads SKILL.md + dynamic context
│   └── response-sender.js       # Routes to Telegram (passengers or drivers)
├── SKILL.md                     # Dispatch persona and rules
├── mcp-servers/
│   ├── supabase-mcp/index.js    # 8 database tools
│   ├── maps-mcp/index.js        # 3 maps tools (wraps Railway proxy)
│   ├── pricing-mcp/index.js     # 3 pricing tools (wraps pricing.js)
│   ├── messaging-mcp/index.js   # 4 messaging tools
│   └── stripe-mcp/index.js      # 4 payment tools
├── firebase/
│   ├── firebase-config.js       # Admin SDK init
│   ├── ride-state.js            # State machine
│   ├── driver-location.js       # Location read/write
│   └── database.rules.json      # Security rules
├── telegram/
│   ├── telegram-bot.js          # Bot setup + webhook
│   ├── telegram-handlers.js     # Commands + callbacks
│   ├── telegram-templates.js    # Bilingual message templates
│   └── location-tracker.js      # Live location → Firebase
├── router/
│   └── message-router.js        # Channel-agnostic message normalization
├── state/
│   └── conversation-state.js    # Per-phone conversation context (30 min TTL)
├── dispatch/
│   └── dispatch-engine.js       # Driver matching + offer timeout queue
├── memory/
│   ├── memory-layer.js          # Read/write user memories
│   ├── memory-extractor.js      # Post-conversation fact extraction
│   ├── memory-formatter.js      # Memory → system prompt context
│   └── customer-tier.js         # Auto-upgrade logic
├── i18n/
│   ├── language-detector.js     # Spanish/English detection
│   └── templates.js             # Structured bilingual notifications
├── tracking/
│   ├── tracking-token.js        # HMAC tokens for tracking URLs
│   └── eta-notifier.js          # Proactive ETA Telegram updates
├── payments/
│   ├── payment-links.js         # Stripe Payment Link generation
│   └── receipt-generator.js     # Bilingual receipt formatting
├── drivers/
│   ├── earnings-tracker.js      # 75% commission calculation
│   └── availability-manager.js  # Status management
└── tests/
    ├── test-mcp-servers.js
    ├── test-agent-bridge.js
    └── test-dispatch-flow.js
```

### How Memory Layer Works

1. **On message receive:** Query `customer_memory` table for sender's phone → returns all entries
2. **Inject into prompt:** `memory-formatter.js` converts to natural language, appended to SKILL.md
3. **Post-conversation:** `memory-extractor.js` runs lightweight Claude call to extract facts → upsert into table
4. **Decay:** Entries unused for 90 days lose 0.1 confidence. Below 0.3 → archived
5. **Budget:** Max 20 memory entries per user in system prompt (sorted by confidence × recency)

---

## Technical Risks & Mitigations

### Risk 1: Claude Agent Latency (HIGH)
**Problem:** 5-15 second processing time. Telegram users expect near-instant replies.
**Mitigation:** Send immediate "Un momento..." / "One moment..." acknowledgment within 1 second via Telegram sendChatAction. Process agent async. Send response as follow-up message.

### Risk 2: Firebase + Supabase Dual-Write Consistency (MEDIUM)
**Problem:** Writing to both systems risks inconsistency if one fails.
**Mitigation:** Supabase is source of truth. Firebase is derived cache. Write Supabase first, then Firebase. Reconciliation job every 5 minutes corrects Firebase divergence.

### Risk 3: Concurrent Driver Dispatch (MEDIUM)
**Problem:** Two rides offered to same driver simultaneously.
**Mitigation:** Firebase transactions for driver status changes. Atomically check-and-set from `available` to `offered`. Transaction failure → skip to next driver.

### Risk 4: Agent Cost Control (MEDIUM)
**Problem:** Each message spawns Claude subprocess with multiple tool calls.
**Mitigation:** (a) Use Sonnet not Opus. (b) `maxTurns: 10` hard limit. (c) Per-chatId rate limit: 20 agent calls/hour. (d) Cache common queries. (e) Daily spend alerts.

### Risk 5: Railway Single Point of Failure (LOW)
**Problem:** Railway server handles webhooks + bot + agent bridge.
**Mitigation:** Railway auto-restart + health checks. Acceptable for MVP. Scale to multi-instance later.

---

## New Dependencies to Add

```json
{
  "@anthropic-ai/claude-agent-sdk": "latest",
  "firebase-admin": "^12.0.0",
  "node-telegram-bot-api": "^0.66.0",
  "@modelcontextprotocol/sdk": "latest"
}
```

## New Environment Variables

```
# Firebase
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIREBASE_DATABASE_URL=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=

# Anthropic
ANTHROPIC_API_KEY=

# Stripe (additional)
STRIPE_WEBHOOK_SECRET=
```
