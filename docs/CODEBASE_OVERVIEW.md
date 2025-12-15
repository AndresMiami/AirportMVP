# LinkMia / AirportMVP - Complete Codebase Overview

> **Purpose**: Context document for AI assistants and developers to understand the current state of this project.

---

## 1. Project Structure

```
AirportMVP/
├── index.html                  # Landing page (simple entry)
├── indexMVP.html               # Main booking app (122KB - full featured)
├── admin.html                  # Dispatch dashboard for managing bookings
├── LandingLOGIN_STANDALONE.html # Auth/login page with Supabase
├── offline.html                # PWA offline fallback
├── manifest.json               # PWA manifest
├── service-worker.js           # PWA service worker
│
├── css/
│   ├── style.css               # Core dark theme styles
│   ├── booking-confirmation.css # Booking modal styles
│   ├── maps-autocomplete.css   # Google Maps autocomplete dropdown
│   └── vehicle-carousel.css    # Vehicle selection carousel
│
├── js/
│   ├── stripe-payment.js       # Stripe payment integration
│   ├── payment-modal.js        # Payment method selector modal
│   ├── passenger-modal.js      # Passenger info collection
│   ├── pickup-note-modal.js    # Pickup notes modal
│   └── promotion-modal.js      # Promo code modal
│
├── backend/
│   ├── api-proxy/
│   │   └── server.js           # Express server (Google Maps proxy)
│   └── functions/              # Netlify serverless functions
│       ├── create-payment-intent.js
│       ├── create-booking.js
│       ├── calculate-price.js
│       ├── create-payment.js
│       └── stripe-config.js
│
├── database/
│   └── linkmia-schema.sql      # Supabase PostgreSQL schema
│
├── dev/
│   ├── archive/                # Archived code (driver app, tracking app prototypes)
│   └── templates/              # Login templates
│
├── pricing.js                  # Sophisticated tiered pricing engine
├── supabase.js                 # Supabase client & helper functions
├── autocomplete.js             # Google Places autocomplete logic
├── api-config.js               # API endpoint configuration
├── datetime-utils.js           # Date/time utilities
├── error-handler.js            # Global error handling
├── debug.js                    # Debug utilities
│
├── netlify.toml                # Netlify deployment config
├── package.json                # Node.js dependencies
└── .env.example                # Environment variables template
```

---

## 2. Tech Stack

### Frontend
- **Pure HTML/CSS/JavaScript** - No React/Vue/Angular
- **CSS Variables** - Dark theme with orange accent (`#FF9933`)
- **PWA Support** - Service worker, manifest, offline capability
- **Supabase JS SDK** (v2) - via CDN

### Backend
- **Express.js** - API proxy server (deployed on Railway)
- **Netlify Functions** - Serverless functions for payments & bookings

### Database
- **Supabase (PostgreSQL)** - Cloud-hosted with Row Level Security

### External Services
- **Google Maps Platform** - Places API, Directions API, Geocoding
- **Stripe** - Payment processing (test mode configured)
- **Twilio** - SMS/WhatsApp notifications (configured but not actively integrated)

### Deployment
- **Netlify** - Frontend hosting + serverless functions
- **Railway** - Google Maps API proxy server
- **Supabase** - Database & authentication

---

## 3. Current Features (Working)

### Booking Flow ✅
1. **Mode Selection** - "Going to Airport" vs "Arriving at Airport"
2. **Address Input** - Google Places autocomplete
3. **Airport Selection** - MIA, FLL, PBI (Miami area airports)
4. **Date/Time Picker** - Today, Tomorrow, Calendar picker
5. **Flight Number** (optional) - For flight tracking
6. **Vehicle Selection** - Carousel with 3 vehicle types:
   - Tesla Model Y (4 passengers)
   - Cadillac Escalade (7 passengers)
   - Mercedes Sprinter (12 passengers)
7. **Pricing Display** - Real-time calculation with breakdown
8. **Passenger Details** - Modal for name/email/phone or "booking for someone else"
9. **Payment Selection** - Modal with saved cards (UI only)
10. **Booking Confirmation** - Creates booking record

### Pricing Engine ✅ (pricing.js)
- **Tiered Distance Pricing** - Rate decreases for longer trips
- **Dynamic Airport Fees** - Fee scales down with distance
- **Popular Route Flat Rates** - MIA-MCO, FLL-PBI, etc.
- **Time-Based Surcharges**:
  - Night (10pm-6am): +15%
  - Weekend: +10%
  - Peak Hours (7-9am): +20%
  - Holiday: +25%
- **Psychological Pricing** - Prices end in 5 or 9
- **Max Service Distance** - 280 miles

### Admin Dashboard ✅ (admin.html)
- View all bookings with status colors
- Filter by status (pending, confirmed, assigned, etc.)
- Booking cards show route, customer, price
- Tab navigation for different views
- Connects to Supabase for real data

### PWA Support ✅
- App manifest for home screen install
- Service worker for offline capability
- iOS/Android optimized meta tags

### Google Maps Integration ✅
- Places Autocomplete with debouncing
- Directions for route calculation
- Distance/duration estimation
- Map display on vehicle panel
- **Caching** - 24hr route cache, 7-day place cache
- **Rate Limiting** - 100 requests per 15 minutes

### Authentication ✅ (Development mode)
- Supabase Auth integration ready
- Login/signup page exists
- Currently bypassed with DEV_MODE = true

---

## 4. Database Schema

### Tables (in Supabase)

```sql
-- CUSTOMERS - Guest/repeat customer profiles
customers (id, name, phone, email, type, source, referred_by, total_rides, total_spent)

-- DRIVERS - Driver roster with vehicle info
drivers (id, name, phone, email, vehicle_type, vehicle_details, license_plate, status, commission_rate, rating)

-- HOSTS - B2B referral partners (hotels, Airbnb hosts)
hosts (id, user_id, name, property_name, referral_code, commission_rate, total_referrals, status)

-- BOOKINGS - Main dispatch/order table
bookings (
  id, customer_id, customer_name, customer_phone,
  pickup_location, dropoff_location, pickup_datetime,
  passengers, bags, vehicle_type, vehicles_needed,
  status, assigned_driver,
  price, driver_payout (computed), linkmia_commission (computed),
  payment_status, payment_method,
  flight_number, cruise_ship, notes,
  source, referred_by_host, host_commission,
  group_booking_id
)

-- PAYMENTS - Transaction tracking
payments (id, booking_id, amount, type, method, reference_number)

-- ACTIVITY_LOG - Audit trail
activity_log (id, entity_type, entity_id, action, old_value, new_value, performed_by)
```

### Key Booking Statuses
`pending` → `confirmed` → `assigned` → `in_progress` → `completed`
                                                    → `cancelled`

### Commission Model
- **Driver Payout**: 75% of fare
- **LinkMia Commission**: 25% of fare
- **Host Referral**: 10% kickback

---

## 5. Booking Flow Details

### User Journey
1. User lands on `index.html` → clicks "Book Now" → redirects to `indexMVP.html`
2. **WHERE Panel**: Select mode (to/from airport), enter address, pick airport
3. **WHEN Panel**: Select date, time, optional flight number
4. **VEHICLE Panel**:
   - View map with route
   - See vehicle carousel with prices
   - Add passenger details (modal)
   - Select payment method (modal)
5. **Schedule Ride** button triggers booking

### After Booking
- Booking saved to Supabase `bookings` table
- Status set to `pending`
- (Not implemented) SMS/WhatsApp notification to admin
- (Not implemented) Confirmation email to customer
- Booking appears in admin.html dashboard

### Payment Flow
1. Stripe Payment Intent created on server
2. Client receives `clientSecret`
3. Payment confirmed via Stripe.js
4. Currently using **test mode** with `tok_visa` test token

---

## 6. Driver/Dispatch System

### Current State: Partially Built

**What Exists:**
- `drivers` table in database schema
- Admin dashboard can view bookings
- Booking records can store `assigned_driver`
- Archived driver app prototype in `/dev/archive/driver-app/`

**What's Missing:**
- No live driver app
- No driver assignment UI in admin
- No real-time location tracking
- No driver notifications
- No driver acceptance/rejection flow
- No ETA updates to customers

---

## 7. Payment Integration

### Stripe Setup ✅
- **Public Key**: Hardcoded in `stripe-payment.js` (test key)
- **Secret Key**: Via environment variable `STRIPE_SECRET_KEY`
- **Netlify Function**: `create-payment-intent.js`
- **Apple Pay**: Detection code present, not fully implemented

### Current State
- Payment Intent creation works
- Test payments using `tok_visa` succeed
- No actual card entry form (Stripe Elements not mounted)
- No webhook handling for payment confirmation
- No refund functionality

### Environment Variables Needed
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## 8. Deployment Status

### Live URLs (from .env.example)
- **Frontend**: `https://i-love-miami.netlify.app`
- **API Proxy**: `https://reliable-warmth-production-d382.up.railway.app`
- **Database**: `https://hncpybxwblpkyxvskoxd.supabase.co`

### Deployment Architecture
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Netlify       │     │   Railway       │     │   Supabase      │
│   (Frontend)    │────▶│   (API Proxy)   │     │   (Database)    │
│                 │     │                 │     │                 │
│ - HTML/CSS/JS   │     │ - Express.js    │     │ - PostgreSQL    │
│ - Functions     │────▶│ - Google Maps   │     │ - Auth          │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## 9. What's Missing / Incomplete

### Critical for MVP Launch 🔴
1. **Real Card Payment** - Need Stripe Elements form for actual card entry
2. **Driver Assignment** - No way to assign drivers to bookings
3. **Customer Notifications** - No SMS/email confirmations
4. **Admin Booking Management** - Can't update status, assign drivers from UI

### Important Features 🟡
1. **Driver Mobile App** - For drivers to receive/accept jobs
2. **Real-time Tracking** - Customer can track driver location
3. **Flight Tracking Integration** - Auto-adjust pickup for delays
4. **Authentication** - Currently bypassed in dev mode
5. **Payment Webhooks** - Confirm payment completion
6. **Refund/Cancellation** - No mechanism to process refunds

### Nice to Have 🟢
1. **Multi-vehicle Booking** - Group booking with multiple cars
2. **Return Trip Booking** - Round-trip convenience
3. **Promo Codes** - UI exists, backend not connected
4. **Rate Limiting** - More sophisticated abuse prevention
5. **Analytics Dashboard** - Revenue, bookings over time
6. **Host Portal** - B2B partners see their referrals

### Technical Debt
1. **Large HTML Files** - indexMVP.html is 122KB, should be componentized
2. **No Build System** - No bundling/minification
3. **Test Coverage** - No automated tests
4. **TypeScript** - All plain JavaScript
5. **Error Reporting** - No Sentry or similar

---

## 10. Key Configuration Points

### Pricing Adjustments (pricing.js)
```javascript
// Vehicle tier rates (per mile)
tesla: { rate: 3.25 (0-15mi), 2.85 (16-50mi), 2.45 (51-100mi), 2.15 (101-280mi) }
escalade: { rate: 4.50, 3.95, 3.45, 2.95 }
sprinter: { rate: 6.25, 5.50, 4.85, 4.25 }

// Surcharges
night: 1.15 (15%)
weekend: 1.10 (10%)
peak: 1.20 (20%)
holiday: 1.25 (25%)
```

### Airports Supported
- **MIA** - Miami International
- **FLL** - Fort Lauderdale-Hollywood
- **PBI** - Palm Beach International

### Service Area
- Maximum distance: 280 miles
- Centered on Miami metro area

---

## Quick Start for Development

```bash
# Install dependencies
npm install

# Start local server (Railway proxy)
npm run dev

# Or use Netlify CLI for full local dev
netlify dev
```

### Environment Setup
1. Copy `.env.example` to `.env`
2. Add Google Maps API key
3. Add Stripe keys
4. Supabase URL/key already embedded for dev

---

## Summary for AI Context

This is a **Miami airport transfer booking MVP** called **LinkMia**. It's a functional booking interface with:
- Working customer-facing booking flow
- Sophisticated pricing engine
- Stripe payment infrastructure (test mode)
- Supabase database with full schema
- Admin dashboard shell

**Main gaps** are driver-side functionality, real payment processing, and notification systems. The frontend is pure HTML/JS (no framework), deployed on Netlify with a Railway-hosted API proxy for Google Maps.
