# Setup & Deployment Guide

## 🚀 Quick Setup

### 1. Environment Variables

Create `.env` file in `backend/api-proxy/`:
```env
GOOGLE_MAPS_API_KEY=your_key_here
ALLOWED_ORIGINS=http://localhost:*,https://i-love-miami.netlify.app
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
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `STRIPE_SECRET_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
3. Auto-deploys on push to main

### Railway (API Proxy)
1. Connect GitHub repo
2. Set root directory: `/backend/api-proxy`
3. Add environment variables (same as .env)
4. Auto-deploys on push to main

## 🗺️ Google Maps Setup

### Get API Key
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create new project or select existing
3. Enable APIs:
   - Maps JavaScript API
   - Places API
4. Create credentials → API Key
5. Restrict key to your domains

### Configure Proxy
The proxy protects your API key by:
- Keeping key on server only
- Validating allowed origins
- Rate limiting requests

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