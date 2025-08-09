# Airport MVP - Deployment Guide

## Architecture Overview

This project uses a **hybrid architecture**:
- **Google Maps Proxy Server**: Custom autocomplete (bypasses shadow DOM)
- **Netlify Functions**: Stripe, Supabase, pricing (serverless)
- **Frontend**: Static site on Netlify CDN

```
User → Netlify Frontend
         ├→ Maps Proxy Server (Railway/Render)
         └→ Netlify Functions (Stripe/Supabase)
```

## Local Development

### 1. Install Dependencies
```bash
# Install main dependencies
npm install

# Install proxy server dependencies
cd airport-booking-api-proxy
npm install
cd ..
```

### 2. Set Up Environment Variables
Create `.env` file in root:
```env
# Copy from .env.example
GOOGLE_MAPS_API_KEY=your_key
SUPABASE_URL=your_url
SUPABASE_ANON_KEY=your_key
# Add Stripe keys when ready
```

### 3. Run Development Servers

**Option A: Two terminals**
```bash
# Terminal 1: Proxy server for Maps
cd airport-booking-api-proxy
npm start

# Terminal 2: Netlify dev for functions
netlify dev
```

**Option B: Single command (if configured)**
```bash
npm run dev
```

Access at: `http://localhost:3001`

## Production Deployment

### Step 1: Deploy Frontend to Netlify

1. **Connect GitHub to Netlify**
   - Go to [Netlify](https://app.netlify.com)
   - Click "Add new site" → "Import an existing project"
   - Choose GitHub and select your repository

2. **Configure Build Settings**
   - Build command: `npm run build` (if you have one)
   - Publish directory: `.`
   - Functions directory: `netlify/functions`

3. **Add Environment Variables in Netlify Dashboard**
   ```
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=eyJxxxxxx
   SUPABASE_SERVICE_KEY=eyJxxxxxx (for admin operations)
   
   # When ready for payments:
   STRIPE_PUBLISHABLE_KEY=pk_live_xxxxx
   STRIPE_SECRET_KEY=sk_live_xxxxx
   STRIPE_WEBHOOK_SECRET=whsec_xxxxx
   
   # For notifications (optional):
   TWILIO_ACCOUNT_SID=ACxxxxx
   TWILIO_AUTH_TOKEN=xxxxx
   TWILIO_WHATSAPP_NUMBER=+14155238886
   ADMIN_WHATSAPP_NUMBER=+1xxxxxxxxxx
   
   SENDGRID_API_KEY=SG.xxxxx
   ADMIN_EMAIL=admin@yourdomain.com
   ```

### Step 2: Deploy Maps Proxy Server

**Option A: Railway (Recommended - Easy)**

1. Go to [Railway](https://railway.app)
2. Create new project → Deploy from GitHub
3. Select your repo and point to `/airport-booking-api-proxy`
4. Add environment variables:
   ```
   GOOGLE_MAPS_API_KEY=your_key
   ALLOWED_ORIGINS=https://your-site.netlify.app,https://yourdomain.com
   RATE_LIMIT_WINDOW_MS=900000
   RATE_LIMIT_MAX_REQUESTS=300
   PORT=3001
   ```
5. Railway provides URL like: `https://your-app.railway.app`

**Option B: Render (Free tier available)**

1. Go to [Render](https://render.com)
2. New → Web Service → Connect GitHub
3. Root Directory: `airport-booking-api-proxy`
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Add same environment variables as Railway

### Step 3: Update Frontend Configuration

Edit `api-config.js`:
```javascript
getMapsProxyUrl() {
  if (this.isProduction) {
    return 'https://your-proxy.railway.app'; // Your deployed proxy URL
  }
  return 'http://localhost:3001';
}
```

### Step 4: Configure Supabase

1. **Create tables in Supabase:**
```sql
-- Bookings table
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  pickup_address TEXT NOT NULL,
  dropoff_address TEXT NOT NULL,
  pickup_coordinates JSONB,
  dropoff_coordinates JSONB,
  vehicle_type TEXT NOT NULL,
  scheduled_time TIMESTAMP NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  status TEXT DEFAULT 'pending',
  payment_intent_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add RLS policies
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
```

2. **Update Supabase keys in Netlify**

### Step 5: Set Up Stripe (When Ready)

1. Get API keys from [Stripe Dashboard](https://dashboard.stripe.com)
2. Add to Netlify environment variables
3. Set up webhook endpoint in Stripe pointing to:
   `https://your-site.netlify.app/.netlify/functions/stripe-webhook`

## Testing Production

1. **Test Maps Autocomplete:**
   - Should work with custom styling
   - No CORS errors

2. **Test Price Calculation:**
   - Server-side only (secure)
   - Check surge pricing

3. **Test Booking Creation:**
   - Should save to Supabase
   - Should send notifications

4. **Test Payment (when ready):**
   - Use Stripe test cards
   - Verify payment intent creation

## Monitoring & Logs

- **Netlify Functions**: Dashboard → Functions → View logs
- **Railway/Render**: Dashboard → Logs
- **Supabase**: Dashboard → Logs
- **Google Maps**: [Google Cloud Console](https://console.cloud.google.com)

## Cost Optimization

1. **Google Maps**: 
   - Monitor usage in Google Cloud Console
   - Caching reduces API calls by ~70%

2. **Netlify Functions**:
   - Free tier: 125k requests/month
   - Monitor in Netlify dashboard

3. **Railway/Render**:
   - Railway: $5/month for hobby
   - Render: Free tier available

## Security Checklist

✅ API keys only in environment variables
✅ Pricing logic server-side only
✅ CORS configured for your domains
✅ Rate limiting enabled
✅ Supabase RLS policies active
✅ Stripe webhook signature verification

## Support

- **Netlify Issues**: Check function logs
- **Proxy Issues**: Check Railway/Render logs
- **CORS Issues**: Verify ALLOWED_ORIGINS
- **Payment Issues**: Check Stripe dashboard

## Next Steps

1. [ ] Add Stripe payment flow
2. [ ] Implement flight tracking API
3. [ ] Add driver app functionality
4. [ ] Set up monitoring (Sentry/LogRocket)
5. [ ] Add analytics (Google Analytics/Mixpanel)