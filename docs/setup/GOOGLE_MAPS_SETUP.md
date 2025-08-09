# 🔑 Google Maps API Setup Guide

## Current Issue
Your Airport Booking App is working perfectly, but the Google Maps API key is missing or invalid. This causes the warning:
```
Google Maps JavaScript API warning: InvalidKey
```

## Quick Fix

### 1. Get Your API Key
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable these APIs:
   - **Maps JavaScript API** ✅
   - **Places API** ✅  
   - **Directions API** ✅
   - **Geocoding API** ✅

4. Go to "Credentials" → "Create Credentials" → "API Key"

### 2. Secure Your API Key
**Important:** Restrict your API key for security:

#### Application Restrictions:
- Choose "HTTP referrers (web sites)"
- Add these referrers:
  ```
  localhost:*
  127.0.0.1:*
  your-production-domain.com/*
  ```

#### API Restrictions:
- Select "Restrict key"
- Choose only the 4 APIs listed above

### 3. Add API Key to Your Project
Edit this file: `airport-booking-api-proxy/.env`

Replace this line:
```bash
GOOGLE_MAPS_API_KEY=your_actual_google_maps_api_key_here
```

With your actual key:
```bash
GOOGLE_MAPS_API_KEY=AIzaSyD4-your-actual-key-here
```

### 4. Test Your Setup
1. Open: `test-api-key.html` in your browser
2. Click the test buttons to verify everything works
3. All tests should show green ✅

### 5. Restart Your App
The proxy server should restart automatically when you save the .env file. If not:
```bash
cd airport-booking-api-proxy
npm restart
```

## Your App Architecture 🏗️

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Your App      │────│  Proxy Server   │────│   Google Maps   │
│  (Frontend)     │    │  (port 3001)    │    │      API        │
│                 │    │                 │    │                 │
│ • indexMVP.html │    │ • Caches data   │    │ • Places API    │
│ • autocomplete  │    │ • Rate limits   │    │ • Directions    │
│ • pricing       │    │ • Secures keys  │    │ • Geocoding     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Benefits of This Setup ✨

- **Security**: API keys are hidden from frontend
- **Performance**: Intelligent caching reduces API calls
- **Cost Control**: Rate limiting prevents overuse
- **Reliability**: Fallback mechanisms for better UX

## Troubleshooting 🔧

### Common Issues:

1. **"InvalidKey" error**
   - Check if API key is correct in `.env` file
   - Verify APIs are enabled in Google Cloud Console

2. **"CORS error"**
   - Make sure proxy server is running on port 3001
   - Check allowed origins in server configuration

3. **"No predictions" in autocomplete**
   - Verify Places API is enabled
   - Check API key restrictions

4. **Rate limiting errors**
   - Normal behavior during heavy testing
   - Wait 15 minutes or restart server

### Test Commands:
```bash
# Check if proxy server is running
curl http://localhost:3001/health

# Test autocomplete endpoint
curl "http://localhost:3001/api/places/autocomplete?input=Miami"

# Test directions endpoint  
curl "http://localhost:3001/api/directions?origin=Miami&destination=Fort+Lauderdale"
```

## What's Working Already ✅

Your app is successfully:
- ✅ Loading and initializing
- ✅ Setting up the proxy server connection
- ✅ Initializing autocomplete functionality
- ✅ Loading pricing service
- ✅ Caching elements and binding events

Only the Google Maps API key needs to be configured! 🎯
