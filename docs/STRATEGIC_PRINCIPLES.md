# LinkMia Strategic Principles

> Living document for key decisions and guiding philosophy

---

## Principle #1: Validate Before You Build

> **"Don't build infrastructure until you've validated the business. Many startups die building tech nobody wanted. Ship with Spare, prove demand, then decide."**

### What This Means for LinkMia

| Decision | Build Custom | Use Existing | We Chose |
|----------|--------------|--------------|----------|
| Driver dispatch | 12-16 weeks | Spare (3 weeks) | ✅ **Spare** |
| Payment processing | 4-6 weeks | Stripe (1 day) | ✅ **Stripe** |
| Database | Self-hosted | Supabase | ✅ **Supabase** |
| Maps/routing | Build algorithms | Google Maps | ✅ **Google** |
| Booking UI | Framework (React) | Vanilla HTML/JS | ✅ **Vanilla** |

### The Validation Milestones

```
BEFORE building custom infrastructure, hit these numbers:

□ 100 completed trips        → Product works
□ 500 trips/month            → Repeatable demand
□ 70% repeat customer rate   → Product-market fit
□ $50K monthly revenue       → Business is real
□ Clear pain points with Spare → Reason to switch
```

### Questions to Ask Before Building Anything

1. **Can we buy/integrate this?** (Usually yes)
2. **Will this block us from launching?** (If no, skip it)
3. **Do customers actually want this?** (Ask them first)
4. **What's the cost of being wrong?** (Time > money)

---

## Principle #2: Own the Customer, Outsource the Ops

```
LINKMIA OWNS:              PARTNERS OWN:
─────────────              ─────────────
• Brand                    • Driver logistics (Spare)
• Customer relationship    • Payments (Stripe)
• Pricing & margins        • Database (Supabase)
• Booking experience       • Maps (Google)
• Growth & marketing       • SMS (Twilio)
```

**Why?** The customer relationship is the moat. Everything else is commodity infrastructure.

---

## Principle #3: Speed Beats Perfection

| Approach | Time | Risk | Learning |
|----------|------|------|----------|
| Perfect system, then launch | 6 months | High (no validation) | Zero |
| MVP, then iterate | 3 weeks | Low (small bets) | Maximum |

**Our choice**: Ship ugly, learn fast, improve continuously.

---

## When to Revisit These Principles

Trigger a strategy review when:

- [ ] Monthly trips exceed 1,000
- [ ] Spare costs exceed 15% of revenue
- [ ] A partner becomes a bottleneck
- [ ] Customer feedback demands custom features
- [ ] Opportunity to white-label/license emerges

---

## Decision Log

| Date | Decision | Reasoning | Revisit When |
|------|----------|-----------|--------------|
| Dec 2024 | Use Spare for dispatch | Validate demand first | 500+ trips/month |
| Dec 2024 | Keep Stripe for payments | Already integrated | Never (it works) |
| Dec 2024 | Stay with vanilla JS | No build complexity | Team grows to 3+ devs |

---

*"The best startup advice is almost always: do less, learn more, ship faster."*
