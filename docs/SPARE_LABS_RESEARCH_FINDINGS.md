# Spare Labs Integration Research Findings

> **Research Date**: December 2024
> **Decision**: Proceed with Spare Labs integration
> **Confidence Level**: HIGH (technical) / MEDIUM (operational)

---

## Executive Summary

| Metric | Rating | Notes |
|--------|--------|-------|
| Overall Sentiment | Mixed-to-Positive | Strong API, some driver app concerns |
| Technical Viability | HIGH | Open API, OpenAPI spec, 6-month deprecation policy |
| Operational Flexibility | MEDIUM | Algorithmic-first can conflict with manual control |
| Miami Suitability | HIGH | Airport precedent exists (MSP), real-time traffic integration |

### Top 3 Benefits
1. **Open API** - Only provider with fully public API documentation
2. **60-Second Optimization** - Real-time reshuffling with Google Maps traffic data
3. **Open Fleets** - Automatic overflow to Uber/Lyft/taxi when fleet is busy

### Top 3 Concerns
1. **Manual Override Friction** - Algorithm may resist human intervention
2. **Driver App Stability** - Connection loss when app not active, screen burn-in
3. **Pricing Scales with Vehicles** - Budget increases as fleet grows

---

## Technical Findings

### API Architecture

| Specification | Value |
|---------------|-------|
| API Type | RESTful |
| Documentation | OpenAPI (Swagger), HTML, PDF |
| Authentication | Bearer Token (API Key) |
| Key Scope | **UNSCOPED** - Full admin privileges |
| Deprecation Policy | 6 months for breaking changes |
| Sandbox | Available for testing |

### Critical Security Note

```
⚠️ API keys are UNSCOPED and carry FULL ADMIN privileges.
   NEVER expose in client-side code.
   MUST implement server-side middleware.
```

**Implication for LinkMia**: All Spare API calls must route through Netlify Functions, not the browser.

### Webhook Support
Real-time event notifications included for:
- Trip created/updated
- Driver assigned
- Driver en route
- Arrival
- Trip completed
- Cancellation

---

## Operational Case Studies

### Directly Relevant: SouthWest Transit (MSP Airport)
- **Use Case**: Airport transfers with 14-day advance booking
- **Validates**: LinkMia's exact business model is proven in Spare
- **Features Used**: Advance booking + on-demand returns

### Performance Benchmark: Waco Transit
- **Before Spare**: 60% on-time performance
- **After Spare**: 95% on-time, 97% rider satisfaction
- **Efficiency Gain**: 10% from software alone

### Scale Proof: DART (Dallas)
- **Growth**: 4 zones → 30 zones
- **Volume**: "One of largest multi-modal DRT services in world"
- **Validates**: LinkMia's 10→200 trips/week growth is trivial for Spare

---

## Pain Points Identified

### 1. Driver App Issues
| Problem | Impact | Mitigation |
|---------|--------|------------|
| Connection loss when backgrounded | Lost driver visibility | Provide dedicated tablets |
| Screen burn-in from always-on | Device damage | Use OLED-safe settings, rotate devices |
| Hardware-specific glitches | Inconsistent experience | Standardize on tested device model |

**Recommendation**: Issue company tablets (Samsung Galaxy Tab) rather than using personal phones.

### 2. Algorithm vs. Human Control
The PSTA case study revealed:
- Spare's algorithm has "absolute commitment" to automation
- Manual overrides may be re-optimized in next 60-second cycle
- Some routes were less efficient than legacy systems ($1,000-$1,500/day extra)

**Mitigation**: Ask Spare about "Dispatch Intervention" feature for VIP handling.

### 3. Black Box Routing
- No transparency on how optimization decisions are made
- Can't explain to customer why a specific route was chosen
- Must trust the algorithm

---

## Competitive Analysis

| Platform | API Access | Best For | Weakness |
|----------|------------|----------|----------|
| **Spare Labs** | HIGH (Open) | Startups needing flexibility | Manual override friction |
| **Via** | Moderate | Turnkey operations | 90% revenue from managed services |
| **RideCo** | Moderate | High-productivity routing | Enterprise-heavy UX |
| **Routematch** | Low | Legacy agencies | Manual processes, workarounds |
| **Custom Build** | N/A | Full control | 3-4 months dev, ongoing maintenance |

**Verdict**: Spare is the best fit for LinkMia's "own the customer, outsource dispatch" model.

---

## Pricing Intelligence

### Municipal Contract Benchmarks
| Agency | Contract Value | Duration | Per-Vehicle Notes |
|--------|---------------|----------|-------------------|
| DCTA | $247,296 | 26 months | +$36,787 when vehicles added |
| Typical Agency | $50K-$100K | Annual | Scales with fleet size |

### Cost-Per-Trip Evolution
| Phase | Cost/Trip | Notes |
|-------|-----------|-------|
| Startup (low volume) | ~$72.57 | Amortized fixed costs |
| Scaled (high utilization) | ~$15.25 | Efficiency gains |

### Hidden Value
- Eliminates need for 24/7 dispatch staff
- Reduces "fire-fighting" labor
- Automation handles traffic-based replanning

**Question for Spare Sales**: Startup pricing tier for 10-50 trips/week?

---

## Questions for Spare Sales Call

### Technical
1. "Are scoped API keys (read-only, booking-only) on the roadmap?"
2. "What's the webhook retry policy if our endpoint is temporarily down?"
3. "Can we pass our own fare quote, or must we use Spare's pricing engine?"

### Operational
4. "How does Dispatch Intervention work? Will manual overrides persist through optimization cycles?"
5. "What specific improvements were made to driver app v2 regarding background connection?"
6. "Can we create vehicle classes (Sedan/SUV/Sprinter) with different capacity rules?"

### Commercial
7. "Do you offer startup pricing for <50 trips/week?"
8. "What's the implementation timeline and professional services cost?"
9. "Can we white-label the driver app with LinkMia branding?"

### Miami-Specific
10. "Do you have existing drivers in Miami, or do we bring our own fleet?"
11. "How do we configure airport-specific geofences with terminal buffers?"
12. "Does Open Fleets integrate with Miami-area taxi companies?"

---

## Recommended Integration Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CUSTOMER LAYER                           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ indexMVP    │    │   Stripe    │    │  Customer   │         │
│  │ (Booking)   │───▶│  Checkout   │───▶│ Confirmation│         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     LINKMIA BACKEND (Netlify Functions)         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ create-     │    │   spare-    │    │   spare-    │         │
│  │ booking.js  │───▶│ dispatch.js │◀──▶│ webhook.js  │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│         │                  │                  │                 │
│         ▼                  ▼                  ▼                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Supabase (PostgreSQL)                    ││
│  │  bookings table + spare_trip_id + spare_status columns      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        SPARE LABS LAYER                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │  Spare API  │    │Spare Engine │    │ Spare Driver│         │
│  │ POST /trips │───▶│ (60s cycle) │───▶│  Mobile App │         │
│  └─────────────┘    └─────────────┘    └─────────────┘         │
│                            │                                    │
│                            ▼                                    │
│                    ┌─────────────┐                              │
│                    │ Open Fleets │                              │
│                    │(Uber/Lyft/  │                              │
│                    │ Taxi backup)│                              │
│                    └─────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Decision: GO WITH SPARE

### Why Spare (Not Build Custom)
| Factor | Spare | Custom Build |
|--------|-------|--------------|
| Time to launch | 2-3 weeks | 12-16 weeks |
| Routing algorithm | Proven, traffic-aware | Must build from scratch |
| Driver app | Included (with caveats) | 4-6 weeks to build |
| Overflow handling | Open Fleets built-in | Complex Uber/Lyft API work |
| Ongoing maintenance | Their problem | Your problem |

### Conditions for Success
1. **Secure API key management** - Server-side only
2. **Standardized driver hardware** - Company tablets, not personal phones
3. **Open Fleets configured** - Backup to Uber/taxi for overflow
4. **Airport geofences tuned** - Buffer time for terminal navigation
5. **VIP handling process** - Document when to use manual override

---

## Next Steps

### Immediate (This Week)
- [ ] Schedule Spare Labs sales/demo call
- [ ] Request sandbox API access
- [ ] Ask about startup pricing tier

### Pre-Integration (Before Signing)
- [ ] Test sandbox with Miami airport coordinates
- [ ] Validate vehicle class configuration
- [ ] Confirm Stripe external payment is supported
- [ ] Negotiate SLA for driver app uptime

### Development (After Contract)
- [ ] Add lat/lng capture to booking flow
- [ ] Create `spare-dispatch.js` Netlify function
- [ ] Create `spare-webhook.js` for status updates
- [ ] Add `spare_trip_id` column to bookings table
- [ ] Build customer trip tracking page

---

*Research compiled from: Spare Labs documentation, PSTA case studies, DCTA board minutes, Waco Transit reports, SouthWest Transit implementation, developer forums, and competitive analysis.*
