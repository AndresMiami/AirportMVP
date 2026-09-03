> **SUPERSEDED (September 3, 2026).** This document describes the legacy
> Stripe integration, which has been removed per an internal governing
> architecture decision (INV-3). The code it documents is archived in
> `dev/archive/legacy-stripe/` and must never be re-enabled. The sanctioned
> future design is Stripe Connect Standard with direct charges on the
> operator's account. Kept for historical reference only.

# Stripe Payment Integration Setup Guide

## Overview
This guide walks you through setting up Stripe payment processing with Apple Pay support for your LuxeRide application.

## Architecture
We're using **Option 1: Embedded Payment Methods** which:
- Keeps your sleek black UI design
- Shows Apple Pay as a payment method option
- No jarring redirects to Stripe
- Full control over the payment flow

## Setup Steps

### 1. Get Your Stripe Keys

1. Go to [Stripe Dashboard](https://dashboard.stripe.com)
2. Sign up or log in
3. Navigate to **Developers → API Keys**
4. Copy your keys:
   - **Publishable key**: `pk_test_...` (for frontend)
   - **Secret key**: `sk_test_...` (for backend)

### 2. Configure Environment Variables

#### For Netlify:
1. Go to your Netlify dashboard
2. Navigate to **Site settings → Environment variables**
3. Add these variables:
   ```
   STRIPE_PUBLIC_KEY=pk_test_YOUR_KEY_HERE
   STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
   ```

#### For Local Development:
1. Create a `.env` file in your root directory
2. Add your keys:
   ```env
   STRIPE_PUBLIC_KEY=pk_test_YOUR_KEY_HERE
   STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
   ```

### 3. Update Payment Handler

Edit `payment-handler.js` line 21:
```javascript
// Replace this line:
this.stripe = window.Stripe('pk_test_YOUR_STRIPE_PUBLIC_KEY');

// With your actual test key:
this.stripe = window.Stripe('pk_test_51H...'); // Your actual key
```

Or better, fetch it from the backend:
```javascript
const response = await fetch('/.netlify/functions/stripe-config');
const config = await response.json();
this.stripe = window.Stripe(config.publicKey);
```

### 4. Enable Apple Pay in Stripe

1. Go to **Stripe Dashboard → Settings → Payment methods**
2. Enable **Apple Pay**
3. Add your domain: `i-love-miami.netlify.app`
4. Download and host the verification file

### 5. Test Payment Flow

#### Test Cards:
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 0002`
- 3D Secure: `4000 0025 0000 3155`

#### Apple Pay Testing:
- Use Safari on Mac or iPhone
- Must have a card in Wallet
- Domain must be verified in Stripe

## How It Works

### User Flow:
1. User clicks payment selector → Custom modal opens
2. Shows payment options:
   - 🍎 Apple Pay (if available)
   - 💳 Saved cards
   - ➕ Add new card
3. User selects method → Updates display
4. User clicks "Schedule ride" → Payment processes
5. Success → Booking confirmed

### Technical Flow:
1. `selectPaymentMethod()` → Opens payment modal
2. User selects payment method
3. `confirmBooking()` → Processes payment
4. `processPayment()` → Calls Stripe API
5. Backend creates payment intent
6. Frontend confirms payment
7. Show confirmation screen

## File Structure

```
/AirportMVP
├── payment-handler.js          # Main payment logic
├── css/
│   └── payment-modal.css      # Payment modal styles
├── backend/functions/
│   ├── create-payment-intent.js    # Process payments
│   ├── create-checkout-session.js  # Backup checkout
│   └── stripe-config.js           # Public config
└── indexMVP.html               # Updated with payment integration
```

## API Endpoints

### `/.netlify/functions/stripe-config`
Returns public Stripe configuration

### `/.netlify/functions/create-payment-intent`
Creates a payment intent for processing

### `/.netlify/functions/create-checkout-session`
Creates a hosted checkout session (backup option)

## Customization

### Change Payment Modal Theme:
Edit `css/payment-modal.css`:
```css
.payment-modal-content {
    background: #ffffff; /* Change to black: #000000 */
}
```

### Change Apple Pay Priority:
Edit `payment-handler.js` line 91:
```javascript
// Move Apple Pay to top of list
${this.applePayAvailable ? `...` : ''}
```

### Add More Payment Methods:
Stripe supports:
- Google Pay
- Link (Stripe's 1-click checkout)
- Klarna, Afterpay (BNPL)
- Bank transfers
- Wallets (Cash App, WeChat Pay)

## Security Notes

1. **Never expose secret keys** in frontend code
2. **Always validate amounts** on backend
3. **Use HTTPS** for production
4. **Implement webhook handlers** for reliable confirmations
5. **Add fraud detection rules** in Stripe Dashboard

## Troubleshooting

### Apple Pay not showing:
- Check domain verification in Stripe
- Ensure HTTPS is enabled
- Test in Safari (not Chrome)
- Check device has cards in Wallet

### Payment fails:
- Check Stripe keys are correct
- Verify backend functions deployed
- Check browser console for errors
- Review Stripe Dashboard logs

### Modal not opening:
- Check payment-handler.js is loaded
- Verify CSS is linked correctly
- Check for JavaScript errors

## Next Steps

1. **Add saved cards to backend** (not just localStorage)
2. **Implement webhooks** for payment confirmations
3. **Add receipt emails** via Stripe
4. **Set up subscription billing** for frequent travelers
5. **Add refund functionality**
6. **Implement SCA/3D Secure** for European cards

## Support

- [Stripe Documentation](https://stripe.com/docs)
- [Apple Pay Web Integration](https://stripe.com/docs/apple-pay)
- [Stripe Support](https://support.stripe.com)

---

*Last updated: August 2025*
*Integration type: Embedded Payment Methods with Apple Pay*