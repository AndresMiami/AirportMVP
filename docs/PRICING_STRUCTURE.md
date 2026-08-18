# LinkMia Pricing Structure

**Status:** Current production rates · updated for PR 3C-2A (August 2026)

---

## Who is the pricing authority? (read this first)

| Layer | Where | Status |
|---|---|---|
| **Live booking authority** | `pricing.js` (browser, loaded by `indexMVP.html`) | **This is what passengers are charged today.** Unchanged by 3C-2A. |
| **Canonical server engine** | `backend/functions/lib/ride-rate-card.js` + `ride-quote.js` | Built in 3C-2A. Cent-exact parity with `pricing.js`, proven by golden tests. **NOT wired to any live path yet** — invisible infrastructure. |
| Legacy server endpoint | `backend/functions/calculate-price.js` | Pre-dates the tiered system; **drifted** (flat per-mile rates, older base prices) and is not the booking authority. Untouched. |

During 3C-2A nothing about production behavior changes. The server engine
becomes authoritative only through the future, coordinated steps below.

**Roadmap (deferred, in order):**
1. **3C-2B** — authoritative route/quote service (server-side route facts
   via the Routes API work; signed quotes).
2. **3C-2C** — endpoint enforcement: `create-booking` /
   `update-pending-booking` verify prices against the server engine.
3. Versioned **Supabase pricing profiles** + ambassador pricing
   dashboard + configurable markups (the rate-card architecture already
   supports supplying any validated card).
4. Evaluation of a **time-dominant with distance-floor** rate card
   against real ride data (deliberately not adopted yet).

---

## Vehicle Fleet & Per-Mile Rates

Rates are tiered by distance — longer trips get lower per-mile rates.

| Vehicle | 0-15 mi | 16-50 mi | 51-100 mi | 101-280 mi | Passengers | Luggage |
|---------|---------|----------|-----------|------------|------------|---------|
| Tesla Model Y | $3.25 | $2.85 | $2.45 | $2.15 | 4 | 4 bags |
| Cadillac Escalade | $4.50 | $3.95 | $3.45 | $2.95 | 7 | 8 bags |
| Mercedes Sprinter | $6.25 | $5.50 | $4.85 | $4.25 | 12 | 15 bags |

> **Implementation note (preserved behavior):** the shipped tier loop
> bills `min(remaining, max − min + 1)` miles per tier, so tier 1
> (0-15) is 16 miles wide — a 16-mile trip bills entirely at the
> tier-1 rate, and each later tier starts one mile "late." The server
> engine reproduces this exactly; changing it is a fare change and
> needs its own reviewed PR.

## Fixed Fees

| Fee Type | Tesla | Escalade | Sprinter | Notes |
|----------|-------|----------|----------|-------|
| Airport Fee | $10 | $15 | $25 | Scales down with distance |
| Hourly Minimum | $100/hr | $125/hr | $150/hr | Fare is max(mileage + fee, hourly) |
| Cancellation | $15 | $15 | $15 | Config value; the live pilot collects $0 (migration 013) |

**Airport fee scaling:** ≤10 mi → 100% · ≤30 mi → 75% · ≤60 mi → 50% · beyond → 25%.

## Time-Based Surcharges

Surcharges stack **multiplicatively**, applied in this order: night,
weekend, peak, holiday.

| Surcharge | Rate | When applied |
|-----------|------|--------------|
| Night | ×1.15 | 22:00–05:59 |
| Weekend | ×1.10 | Saturday & Sunday |
| Peak | ×1.20 | 07:00–08:59 |
| Holiday | ×1.25 | Jan 1, Jul 4, Thanksgiving, Dec 25 (2026 dates) |

> **Preserved quirks (recorded, not fixed):**
> * The live browser calculator evaluates hour/day in the **passenger's
>   browser timezone**; the holiday check uses the **UTC calendar
>   date** of the pickup — so the holiday window is shifted 4-5 hours
>   earlier than Miami's day (July 4th *evening* in Miami is not a
>   "holiday"; July 3rd late evening is). The server engine pins
>   America/New_York for wall-clock rules (identical for the canonical
>   Miami browser) and faithfully reproduces the UTC-date holiday
>   behavior.
> * Displayed per-surcharge amounts are computed on the pre-surcharge
>   base individually, so when surcharges stack, the amounts sum to
>   less than the actual compounded increase.

## Popular Route Flat Rates

| Route | Tesla | Escalade | Sprinter |
|-------|-------|----------|----------|
| MIA↔MCO | $450 | $650 | $850 |
| MIA→TPA | $650 | $950 | $1,400 |
| TPA→MIA | $520 | $750 | $950 |
| FLL↔PBI | $120 | $165 | $220 |

> **Preserved finding:** popular-route flat rates are **unreachable in
> production booking** — the booking page passes a Google `place_id`
> (never an airport code) as the destination, so route keys like
> `MIA-MCO` never match. The rates are carried in the rate card for
> code parity. Note also that a matched "flat" rate still gains the
> scaled airport fee, still competes with the hourly minimum, and still
> receives surcharges and psychological rounding on top.

## Psychological Rounding

Production strategy `auto` (fares ≥ $10) produces **whole-dollar**
endings by price band: under $50 → ends in 9 · $50–150 → ends in 5 ·
$150–500 → ends in 9 · $500+ → ends in 45/95. Endings like `.99`
never occur (earlier revisions of this document showed them in error).
Discontinuities are real and preserved (a raw $23 rounds *down* to
$19; a raw $50.00 becomes $45).

## Service Limits

- **Maximum distance:** 280 miles (280.0 prices; beyond refuses).
- **One vehicle per booking** — the quote engine reports which larger
  vehicles fit an oversized party but never auto-splits into multiple
  vehicles.

---

## Sample Calculations (engine-verified against the live calculator)

### Example 1 — Short airport run
Tesla · 8 mi · 15 min · Tuesday 2:00 PM
```
Mileage: 8 × $3.25            = $26.00
Airport fee (≤10 mi, 100%)    = $10.00
Subtotal                      = $36.00   (hourly check: 15 min = $25 → mileage wins)
Psychological rounding        → $39
```

### Example 2 — Popular-route code path (unreachable in production; shown for completeness)
Escalade · MIA→MCO · 240 mi · 210 min · Saturday 8:00 AM
```
Flat rate                     = $650.00
Airport fee (>60 mi, 25%)     = $3.75
Base                          = $653.75  (hourly check: 3.5 h = $437.50 → flat wins)
Weekend ×1.10, Peak ×1.20     = $862.95
Psychological rounding        → $895
```

### Example 3 — Late-night pickup
Sprinter · 28 mi · 40 min · Friday 11:30 PM
```
Mileage: 16 × $6.25 + 12 × $5.50 = $166.00   (tier-1 is 16 miles wide — see note)
Airport fee (≤30 mi, 75%)        = $18.75
Base                             = $184.75   (hourly check: $100 → mileage wins)
Night ×1.15                      = $212.46
Psychological rounding           → $209
```

---

## Notes

- All prices USD. The server engine stores and returns **integer
  cents**; the live calculator's float arithmetic is mirrored
  operation-for-operation for parity.
- Rate changes: edit the **rate card** (`ride-rate-card.js`), never the
  calculation machinery — and any change to the numbers above is a
  fare change requiring review and a version bump.
