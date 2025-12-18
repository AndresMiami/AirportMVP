# Dispatch Vendor Decision: Onde Selected

**Date:** December 18, 2025
**Status:** DECIDED - Onde.Light
**Architecture:** Headless Dispatch Integration

---

## Executive Summary

After evaluating multiple dispatch vendors, **Onde** has been selected as the dispatch backend for LinkMia MVP. The "headless" architecture allows LinkMia to maintain full control of the customer-facing booking experience while leveraging Onde for driver dispatch, GPS tracking, and driver app functionality.

---

## Vendor Comparison Matrix

| Criteria | Onde.Light | Limo Anywhere | Moovs |
|----------|------------|---------------|-------|
| **REST API** | ✅ Modern, synchronous | ❌ Deprecated | ❌ None |
| **Real-time integration** | ✅ Direct API calls | ⚠️ Zapier (1-2 min latency) | ❌ Iframe only |
| **Cost (MVP)** | ✅ FREE (1,000 trips/mo) | ~$130-150/mo | $199/mo |
| **Cost (Scale)** | ~1.9% commission | Fixed monthly | Fixed monthly |
| **Driver app** | ✅ Included | ✅ Included | ✅ Included |
| **Custom frontend** | ✅ Full control | ✅ Via Zapier | ❌ Must use theirs |
| **Enterprise gatekeeping** | ✅ None | ⚠️ Legal agreements | ❓ Unknown |
| **Affiliate network** | ❌ None | ✅ LA Net | ❌ None |

---

## Why Onde Won

### 1. Real REST API
```
LinkMia → POST /v1/orders → Onde → Driver App
              ↑
         Direct, synchronous, <1 second
```

vs. Limo Anywhere:
```
LinkMia → Webhook → Zapier → Limo Anywhere → Driver App
                      ↑
                 1-2 minute latency
```

### 2. Zero Upfront Cost
- First 1,000 trips/month: **FREE**
- After 1,000: ~1.9% commission
- No monthly subscription during validation phase

### 3. No Enterprise Gatekeeping
- Self-serve API key generation
- No legal agreements required
- No "email us for access" friction

---

## Disqualified Vendors

### Moovs - HARD BLOCK ❌
- **Reason:** No public REST API
- **Integration method:** Iframe embedding or email parsing
- **Verdict:** Incompatible with custom frontend goals

### Limo Anywhere - SOFT BLOCK ⚠️
- **Reason:** Customer API deprecated Jan 2022
- **Integration method:** Zapier webhooks (1-2 min latency)
- **Verdict:** Not acceptable for real-time MVP
- **Future use:** Phase 2 for LA Net affiliate network access

---

## Architecture: Headless Dispatch

```
┌─────────────────────────────────────────────────────────────┐
│                    CUSTOMER EXPERIENCE                       │
│                    (LinkMia Branded)                         │
├─────────────────────────────────────────────────────────────┤
│  LinkMia.com                                                 │
│  ├── Custom booking interface                                │
│  ├── Custom pricing engine                                   │
│  ├── Stripe payment processing                               │
│  └── Customer accounts & history                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼ POST /v1/orders
┌─────────────────────────────────────────────────────────────┐
│                    DISPATCH ENGINE                           │
│                    (Onde - External Microservice)            │
├─────────────────────────────────────────────────────────────┤
│  Onde.Light                                                  │
│  ├── Geospatial driver assignment                            │
│  ├── Driver mobile app                                       │
│  ├── Real-time GPS tracking                                  │
│  └── Status webhooks → LinkMia                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Order Creation
```
1. Customer books on LinkMia.com
2. LinkMia calculates custom price
3. LinkMia charges customer via Stripe
4. LinkMia sends order to Onde API:

POST /v1/orders
{
  "customer_name": "John Doe",
  "phone_number": "+13055551234",
  "pickup_lat": 25.7617,
  "pickup_long": -80.1918,
  "dropoff_lat": 25.7959,
  "dropoff_long": -80.2870,
  "scheduled_time": "2025-12-18T14:30:00Z",
  "vehicle_class": "sedan"
}

5. Onde returns order_id
6. Onde assigns driver via algorithm
7. Driver receives job in Onde app
```

### Status Updates (Webhooks)
```
Onde → POST /api/webhooks/onde/status-update → LinkMia

Webhook Events:
├── driver_assigned → SMS customer: "Driver John, Black Toyota Camry"
├── driver_en_route → Update tracking page
├── arrived → SMS: "Your ride is here"
├── passenger_on_board → Update status
└── completed → Trigger any post-trip logic
```

---

## Pricing Strategy: Fixed Price Override

**Problem:** Onde's meter may not match LinkMia's custom pricing (zone fees, surge, etc.)

**Solution:**
1. Calculate price on LinkMia side
2. Charge customer via Stripe immediately
3. Push job to Onde as "Fixed Price" or "Account" job
4. Driver sees $0 to collect (LinkMia pays driver separately)

```
Customer pays: $75 (to LinkMia via Stripe)
Driver receives: $55 (from LinkMia, weekly payout)
LinkMia keeps: $20 margin
Onde commission: ~$1.43 (1.9% of $75)
```

---

## Implementation Roadmap

### Step 1: API Validation ("Hello World" Test)
- [ ] Sign up for Onde.Light free tier
- [ ] Locate Developer/Integrations tab
- [ ] Generate API key
- [ ] Test dummy order via curl/Postman
- **Success:** 200 OK with order_id
- **Failure:** 403 or "Upgrade Required"

### Step 2: Data Modeling
- [ ] Map LinkMia ride object to Onde schema
- [ ] Handle vehicle class translation
- [ ] Implement coordinate extraction from addresses

### Step 3: Webhook Handler
- [ ] Create endpoint: POST /api/webhooks/onde/status-update
- [ ] Implement status-based notifications:
  - driver_assigned → SMS with driver info
  - arrived → "Your ride is here" notification
  - completed → Payment capture confirmation

### Step 4: Integration Testing
- [ ] End-to-end test: LinkMia booking → Onde dispatch → Driver app
- [ ] Verify webhook delivery and handling
- [ ] Test customer tracking experience

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Onde.Light API is read-only on free tier | Fallback to TaxiCaller ($28/mo/vehicle) |
| Complex pricing not supported by Onde meter | Calculate price on LinkMia, use "Fixed Price" job |
| Onde discontinues free tier | Budget for 1.9% commission or switch to TaxiCaller |
| Driver app quality issues | Test thoroughly before committing |

---

## Fallback: TaxiCaller

If Onde.Light validation fails:

| Feature | TaxiCaller |
|---------|------------|
| API | ✅ Documented, job creation allowed |
| Pricing | $28/month per vehicle |
| Driver app | ✅ Included |
| Risk | Higher fixed cost, but proven reliability |

---

## Next Steps

1. **Immediate:** Sign up for Onde.Light, get API key
2. **This week:** Complete "Hello World" API test
3. **If successful:** Build webhook handler
4. **If failed:** Pivot to TaxiCaller

---

## References

- Onde Developer Documentation: [To be added after signup]
- TaxiCaller API: https://www.taxicaller.com/
- Previous research: LIMO_ANYWHERE_ZAPIER_RESEARCH.md
