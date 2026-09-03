# Archived: legacy Stripe integration — never re-enable

**Archived September 3, 2026.**

These files implemented one-off card payments charged on the platform's own
Stripe account. That payment model has been superseded by an internal
governing architecture decision (**INV-3**): passenger payments are not
processed on the platform's own account.

The sanctioned replacement, when payments are built, is **Stripe Connect with
Standard accounts per operator and direct charges on the operator's account**,
with the platform's fixed per-booking fee as the application fee. Never
Express or Custom accounts, never destination charges, never
separate-charges-and-transfers for fares.

**Never re-enable these files.** They are kept only as historical reference.

## Contents

| File | What it was |
|---|---|
| `create-payment-intent.js` | Created PaymentIntents on the platform's own account |
| `create-payment.js` | Sibling one-off charge endpoint |
| `create-checkout-session.js` | One-time Checkout session, same account model |
| `stripe-config.js` | Served the publishable key to the browser |
| `stripe-payment.js` | Frontend module that called the endpoints above |

Their `/api/*` redirects were removed from `netlify.toml`, the
`REQUIRE_PAYMENT` flag path was removed from `indexMVP.html`, and the `stripe`
dependency was removed from `package.json`, so no configuration change can
re-arm this path. Current payment model: cash/Zelle collected by the driver.
