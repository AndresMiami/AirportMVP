# Apple Pay Integration Guide

## How It Works

### Development (localhost)
- **Apple Pay is DISABLED** on localhost/127.0.0.1
- No Apple Pay API calls are made
- No errors will occur
- Only credit/debit cards shown in payment modal

### Production (HTTPS)
- **Apple Pay is ENABLED** on your live site (https://i-love-miami.netlify.app)
- Automatically detects if user has Apple Pay configured
- Shows Apple Pay option if available
- Falls back gracefully if not supported

## Environment Detection

The code automatically detects your environment:

```javascript
// Production Detection Logic
const isProduction = 
    window.location.protocol === 'https:' &&     // Must be HTTPS
    !window.location.hostname.includes('localhost') &&  // Not localhost
    !window.location.hostname.includes('127.0.0.1');    // Not local IP
```

## Apple Pay Requirements

For Apple Pay to appear in production, ALL of these must be true:

1. **HTTPS Connection** ✅ (Netlify provides this)
2. **Safari Browser** (or Safari WebView in iOS apps)
3. **Apple Device** (Mac, iPhone, iPad)
4. **Apple Pay Configured** (user has cards in Wallet)
5. **Supported Region** (user's region supports Apple Pay)

## Testing Apple Pay

### Local Development
```
http://localhost:5500/indexMVP.html
- Apple Pay: ❌ Disabled
- Cards: ✅ Available
- Errors: None
```

### Production
```
https://i-love-miami.netlify.app
- Apple Pay: ✅ Available (if requirements met)
- Cards: ✅ Available
- Errors: None
```

## What Users Will See

### On Desktop (Mac with Safari)
- If Apple Pay configured: Shows "🍎 Apple Pay" option
- If not configured: Shows only card options

### On iPhone/iPad
- If Apple Pay configured: Shows "🍎 Apple Pay" option
- If not configured: Shows only card options

### On Windows/Android/Chrome
- Apple Pay never shows (not supported)
- Shows only card options

## Stripe Integration for Apple Pay

When you're ready to process real payments:

### 1. Configure Stripe
```javascript
// In payment-modal-enhanced.js
const stripe = Stripe('pk_live_YOUR_STRIPE_KEY'); // Your live key
```

### 2. Create Payment Request
```javascript
const paymentRequest = stripe.paymentRequest({
    country: 'US',
    currency: 'usd',
    total: {
        label: 'LuxeRide Airport Transfer',
        amount: amount * 100, // in cents
    },
    requestPayerName: true,
    requestPayerEmail: true,
});
```

### 3. Process Payment
```javascript
paymentRequest.on('paymentmethod', async (ev) => {
    // Send to your backend
    const response = await fetch('/.netlify/functions/create-payment-intent', {
        method: 'POST',
        body: JSON.stringify({
            paymentMethodId: ev.paymentMethod.id,
            amount: amount
        })
    });
    
    // Complete the payment
    ev.complete('success');
});
```

## Domain Verification for Apple Pay

### Required for Production:
1. Log into [Stripe Dashboard](https://dashboard.stripe.com)
2. Go to Settings → Payment Methods → Apple Pay
3. Add your domain: `i-love-miami.netlify.app`
4. Download verification file
5. Place at: `/.well-known/apple-developer-merchantid-domain-association`
6. Deploy to Netlify

## Troubleshooting

### Apple Pay not showing in production?

Check these in order:
1. Using Safari? (Chrome doesn't support Apple Pay on web)
2. HTTPS connection? (check for padlock in address bar)
3. Cards in Wallet? (Settings → Wallet & Apple Pay)
4. Console errors? (Cmd+Option+I → Console)

### Still getting errors on localhost?

1. Clear browser cache: Cmd+Option+E
2. Hard refresh: Cmd+Shift+R
3. Use private window: Cmd+Shift+N
4. Check you have latest code with `?v=3` parameter

## Security Notes

- Apple Pay tokens are one-time use
- Card numbers never touch your server
- Stripe handles all PCI compliance
- User authenticates with Face ID/Touch ID

## Browser Support

| Browser | Apple Pay Support |
|---------|------------------|
| Safari (Mac) | ✅ Yes |
| Safari (iOS) | ✅ Yes |
| Chrome (Mac) | ❌ No |
| Chrome (iOS) | ❌ No |
| Firefox | ❌ No |
| Edge | ❌ No |

## Summary

- **Development**: Apple Pay disabled, no errors
- **Production**: Apple Pay enabled on HTTPS with Safari
- **Fallback**: Always shows credit card options
- **User Experience**: Seamless in both environments

---

Last Updated: August 2025
Status: Ready for production deployment