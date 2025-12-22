# LinkMia Pricing Structure

**For Review By:** Fleet Operations
**Date:** December 2024
**Status:** Current Production Rates

---

## Vehicle Fleet & Per-Mile Rates

Rates are tiered by distance - longer trips get lower per-mile rates to stay competitive on intercity runs.

| Vehicle | 0-15 mi | 16-50 mi | 51-100 mi | 101-280 mi | Passengers | Luggage |
|---------|---------|----------|-----------|------------|------------|---------|
| Tesla Model Y | $3.25 | $2.85 | $2.45 | $2.15 | 4 | 4 bags |
| Cadillac Escalade | $4.50 | $3.95 | $3.45 | $2.95 | 7 | 8 bags |
| Mercedes Sprinter | $6.25 | $5.50 | $4.85 | $4.25 | 12 | 15 bags |

---

## Fixed Fees

| Fee Type | Tesla | Escalade | Sprinter | Notes |
|----------|-------|----------|----------|-------|
| Airport Fee | $10 | $15 | $25 | Scales down on longer trips |
| Hourly Minimum | $100/hr | $125/hr | $150/hr | Protects short trip revenue |
| Cancellation | $15 | $15 | $15 | Flat fee all vehicles |

**Airport Fee Scaling:**
- 0-10 miles: 100% of fee
- 10-30 miles: 75% of fee
- 30-60 miles: 50% of fee
- 60+ miles: 25% of fee

---

## Time-Based Surcharges

Surcharges stack multiplicatively (e.g., a Sunday night ride gets both weekend + night surcharges).

| Surcharge | Rate | When Applied |
|-----------|------|--------------|
| Night | +15% | 10:00 PM - 6:00 AM |
| Weekend | +10% | Saturday & Sunday |
| Peak Hours | +20% | 7:00 AM - 9:00 AM |
| Holiday | +25% | New Year, July 4th, Thanksgiving, Christmas |

---

## Popular Route Flat Rates

These flat rates override the tiered calculation for common intercity routes.

| Route | Distance | Tesla | Escalade | Sprinter |
|-------|----------|-------|----------|----------|
| Miami to Orlando | 240 mi | $450 | $650 | $850 |
| Orlando to Miami | 240 mi | $450 | $650 | $850 |
| Miami to Tampa | 280 mi | $650 | $950 | $1,400 |
| Tampa to Miami | 280 mi | $520 | $750 | $950 |
| Fort Lauderdale to Palm Beach | 45 mi | $120 | $165 | $220 |
| Palm Beach to Fort Lauderdale | 45 mi | $120 | $165 | $220 |

---

## Pricing Logic (How It Works)

1. **Check Popular Routes** - If the trip matches a known route, use the flat rate
2. **Calculate Tiered Mileage** - Apply per-mile rates based on distance tiers
3. **Add Airport Fee** - Add the scaled airport fee based on trip distance
4. **Apply Hourly Minimum** - Compare to hourly protection; use whichever is higher
5. **Add Surcharges** - Apply night/weekend/peak/holiday multipliers
6. **Psychological Pricing** - Round to .99 or .95 endings for better perception

---

## Service Limits

- **Maximum Distance:** 280 miles per trip
- **Service Area:** South Florida (MIA, FLL, PBI airports)

---

## Sample Calculations

### Example 1: Short Airport Run
- Route: Downtown Miami to MIA Airport (8 miles)
- Vehicle: Tesla Model Y
- Time: Tuesday 2:00 PM

```
Mileage: 8 mi × $3.25 = $26.00
Airport Fee: $10.00 (full fee, under 10 mi)
Subtotal: $36.00
Hourly Min Check: ~15 min = $25.00 (mileage wins)
Final: $36.00 → $35.99 (psychological pricing)
```

### Example 2: Intercity Trip
- Route: Miami to Orlando (240 miles)
- Vehicle: Escalade
- Time: Saturday 8:00 AM

```
Base: $650 (popular route flat rate)
Weekend Surcharge: +10% = $65.00
Peak Hour Surcharge: +20% = $130.00
Final: $650 × 1.10 × 1.20 = $858.00 → $859.00
```

### Example 3: Late Night Pickup
- Route: South Beach to FLL Airport (28 miles)
- Vehicle: Sprinter
- Time: Friday 11:30 PM

```
Mileage: 15 mi × $6.25 + 13 mi × $5.50 = $93.75 + $71.50 = $165.25
Airport Fee: $25 × 0.75 = $18.75 (10-30 mi scaling)
Subtotal: $184.00
Night Surcharge: +15% = $27.60
Final: $211.60 → $209.99 (psychological pricing)
```

---

## Questions for Fleet Review

1. **Per-Mile Rates** - Are these competitive for the Miami market?
2. **Tiered Structure** - Is discounting longer trips standard practice?
3. **Hourly Minimums** - Are $100-150/hr appropriate revenue protection?
4. **Intercity Flat Rates** - Do Orlando/Tampa runs leave enough margin?
5. **Surcharge Rates** - Are these percentages in line with industry norms?
6. **Missing Fees** - Should we add meet & greet, child seats, extra stops?

---

## Notes

- All prices in USD
- Rates effective December 2024
- Subject to change based on fuel costs and market conditions
