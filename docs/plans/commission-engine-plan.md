# Commission Engine & Fee Model — Implementation Plan

> **DRAFT — DO NOT MERGE OR IMPLEMENT.** Gated behind pricing-enforcement
> activation and the partner earnings dashboard. Supersedes nothing until
> promoted. Design rationale lives in internal governing architecture
> decisions (INV-2, INV-3, INV-4) and is deliberately not restated here.

This document parks a ratified engineering design so it does not have to be
re-derived when its build window opens. Scope is engineering only: schema,
states, integration points, and sequencing.

## 1. Future schema migration (claims no migration number)

- Rename the concept `linkmia_commission` → `operator_margin`. This is a
  rename of meaning, not of math: the generated column keeps its exact
  current derivation (including the net-of-host-commission form introduced in
  migration 007). Dependent views drop/recreate in the same script per the
  migration-ledger discipline.
- Model the platform's flat per-booking technology fee as its own concept: a
  fixed amount per vehicle class, stored as a fixed schedule. It is never
  derived from the fare (INV-2). Values default to 0/placeholder until the
  operator agreement sets them.
- Commission derivation gains a per-class dollar floor:
  `GREATEST(commission_rate × captured_fare, class_floor)`. Rate and floor
  values are configuration set by the operator agreement, not constants in
  this plan.
- Commission lifecycle states, layered on the existing
  `ambassador_earnings` machinery:
  `pending` (at booking) → `earned` (at capture/completion, from the actual
  captured amount) → `adjusted` (refund handling is deduct-forward against
  future earnings, never invoiced back) → `paid` (on disbursement
  confirmation).
- Payee records reference business entities (tax-document-ready), not
  individuals.

## 2. Integration points (design level only — no implementation in this PR)

**Payments (per INV-3):** Stripe Connect with Standard accounts per
operator; direct charges on the operator's account; the platform's fixed fee
as `application_fee_amount` (a fixed integer, never computed from the charge
total). Scheduled-ride lifecycle: SetupIntent at booking (save card, charge
nothing) → off-session authorization at T-24/48h for the signed-quote amount
→ capture after completion, capture ≤ authorization. Changed bookings are
cancel-and-rebook via a new signed quote, never in-place mutation of a
priced booking.

**Disbursement provider interface (per INV-3/INV-4):** the operator is the
customer of record of a licensed disbursement provider, authorized once at
onboarding. Platform code has exactly two verbs here: **instruct** (submit
the monthly commission run via the provider's API) and **verify** (consume
payment-status webhooks into the ledger). No code path in this platform
moves, holds, or forwards partner funds. Missed or reversed cycles raise a
**routing-pause flag** wired into the planned operator compliance registry;
the pause clears when the cycle is cured.

**Ledger feeds:** commissions score at capture from the captured amount;
partner statements and their operator-side payable mirrors auto-generate at
month close. No invoicing step exists anywhere in the flow.

## 3. Ordered build sequence — each gate requires explicit sign-off

- [ ] **Gate 1 — Pricing enforcement active.** Server-side pricing is the
      production authority (in-progress activation ladder completes).
- [ ] **Gate 2 — Partner earnings dashboard shipped.** Partners can see
      per-ride earnings computed from real amounts.
- [ ] **Gate 3 — Schema migration.** Section 1, claiming the next free
      migration number at build time.
- [ ] **Gate 4 — Stripe Connect design doc reviewed.** Account type, charge
      type, and lifecycle per Section 2; reviewed before any Stripe code.
- [ ] **Gate 5 — Disbursement provider selected** and sandbox-integrated
      (instruct + webhook verbs proven end-to-end).
- [ ] **Gate 6 — Implementation and activation**, including the routing-pause
      wiring into the compliance registry.

## 4. Open items blocking implementation

- External reviews pending: the INV-4 amendment, disbursement-provider
  selection, and counsel items.
- Fee, rate, and floor values are set by the operator agreement; this plan
  intentionally contains none.
