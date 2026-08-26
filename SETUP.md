# Setup & Deployment Guide

## 🚀 Quick Setup

### 1. Environment Variables

Create `.env` file in `backend/api-proxy/`:
```env
GOOGLE_MAPS_API_KEY=your_key_here
ALLOWED_ORIGINS=http://localhost:*,https://linkmia.com,https://i-love-miami.netlify.app
NODE_ENV=production
PORT=3001
```

### 2. Local Development
```bash
npm install
npm start  # Starts proxy server on :3001
# Open indexMVP.html in Live Server
```

## 📦 Deployment

### Netlify (Frontend)
1. Connect GitHub repo
2. Add environment variables:
   - `GOOGLE_MAPS_BROWSER_API_KEY` (Builds scope; separate Production and
     Deploy Preview values; Branch Deploy too if enabled)
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `STRIPE_SECRET_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
3. Auto-deploys on push to main

### Railway (API Proxy)
1. Connect GitHub repo
2. Set root directory to `/backend/api-proxy`
3. Add environment variables (same as .env)
4. Auto-deploys on push to main

`ALLOWED_ORIGINS` must enumerate every intentional browser origin (production,
the Netlify production alias, and any exact preview origin used for testing).

## 🗺️ Google Maps Setup

### Create two dedicated keys
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create new project or select existing
3. Enable the APIs used today:
   - Maps JavaScript API
   - Places API (legacy web-service endpoints)
   - Directions API (Legacy)
   - Geocoding API
4. Create a private Railway web-service key restricted to Places API,
   Directions API, Geocoding API and—only during the one-release stale-client
   transition—Maps JavaScript API
5. Create a separate browser key for Maps JavaScript
6. On the browser key, set **Websites** restrictions for only the approved
   production/preview origins and API restrictions for **Maps JavaScript API**
   plus **Directions API (Legacy)**. Add each preview's exact hostname; never
   grant a broad `*.netlify.app` referrer. The first preview build intentionally
   fails until its Deploy Preview value exists in Netlify.

Because the loader sends only the origin as its referrer, add both the
pathless and wildcard form for every supported host. Production examples:

```text
https://linkmia.com
https://linkmia.com/*
https://i-love-miami.netlify.app
https://i-love-miami.netlify.app/*
```

For a preview, use that one PR's exact pair—for example
`https://deploy-preview-79--i-love-miami.netlify.app` and the same value with
`/*`. Do not use `deploy-preview-*--...` (wildcards cannot sit in the middle)
or `*.netlify.app` (far broader than LinkMia). Add `www.linkmia.com` only if
that hostname is intentionally served rather than redirected.

### Configure Proxy
The proxy protects the private REST key by:
- Keeping key on server only
- Validating allowed origins
- Rate limiting requests

The browser key is public by design and loads the Maps JavaScript API directly
from `maps.googleapis.com`. Its protection is the GCP website/API restriction,
not secrecy. Address autocomplete still goes through Railway and does not
depend on the browser map loader.

Local/static checkouts intentionally use a null browser config: autocomplete
and booking work, but the optional map is disabled. To exercise maps locally,
generate `maps-browser-config.js` with a separate localhost-restricted browser
key, then restore the committed null file before committing.

## 🧪 Testing

Before deploying, test:
- [ ] Autocomplete works
- [ ] Pricing calculates
- [ ] CSS loads properly
- [ ] Mobile responsive

## 🔧 Troubleshooting

**CSS not loading:** Check `/css` folder is in Git  
**Autocomplete failing:** Verify API key and Railway proxy  
**Build errors:** Check npm dependencies are installed  

## 📞 Support

Create GitHub issue for help.
