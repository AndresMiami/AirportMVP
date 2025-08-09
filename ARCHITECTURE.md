# Architecture Overview

## Project Structure

```
AirportMVP/
├── indexMVP.html         # Main app (all UI in one file)
├── css/                  # Styling
├── backend/              # Server code
│   ├── api-proxy/       # Google Maps proxy (Railway)
│   └── functions/       # Netlify serverless
├── dev/                  # Development files
├── *.js (root)          # Frontend JavaScript
└── images/              # Assets
```

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JavaScript (no build)
- **Backend:** Node.js + Express
- **Database:** Supabase
- **Payments:** Stripe
- **SMS:** Twilio
- **Maps:** Google Maps API
- **Hosting:** Netlify (frontend) + Railway (proxy)

## Data Flow

```
User → indexMVP.html → JavaScript → API
                                     ↓
                          Netlify Functions (booking, payment)
                          Railway Proxy (maps)
                                     ↓
                          External Services (Stripe, Google, Twilio)
```

## Key Files

- `indexMVP.html` - Entire UI (2,335 lines)
- `autocomplete.js` - Address search
- `pricing.js` - Price calculation
- `backend/api-proxy/server.js` - Maps proxy
- `backend/functions/*.js` - Serverless functions

## Why This Structure?

- **No build process** - Direct browser execution
- **Single HTML file** - Simple deployment
- **Modular CSS/JS** - Easy maintenance
- **Serverless functions** - Scalable backend
- **Proxy server** - Secure API keys