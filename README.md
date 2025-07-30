# 🚗 Secure Airport Booking Application

A professional airport transfer booking system with enterprise-grade Google Maps API security implementation.

## 🔐 Security Features

- **Complete API Key Protection**: Google Maps API key never exposed to client-side code
- **Server-Side Proxy Architecture**: All Google Maps API calls go through secure proxy server
- **CORS Protection**: Proper cross-origin request handling and security headers
- **Rate Limiting Ready**: Built-in request throttling capabilities
- **Environment Variable Security**: Sensitive data stored securely server-side

## 🎯 Features

- **Smart Address Autocomplete**: Real-time address suggestions using secure proxy
- **Dynamic Route Calculation**: Live distance and duration calculations with traffic data
- **Multi-Airport Support**: Miami (MIA), Fort Lauderdale (FLL), Palm Beach (PBI)
- **Vehicle Selection**: Tesla Model S, Cadillac Escalade, Mercedes Sprinter
- **Dynamic Pricing**: Real-time pricing based on distance, time, and demand
- **Date/Time Scheduling**: Flexible booking with validation and warnings
- **Mobile-Optimized**: Responsive design for all devices
- **Guest Booking**: Support for booking on behalf of others

## 🚀 Quick Start

### 1. Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/airport-booking-app.git
cd airport-booking-app
```

### 2. Set up the proxy server
```bash
cd airport-booking-api-proxy
npm install
```

### 3. Configure environment variables
```bash
# Copy the example file
cp .env.example .env

# Edit .env and add your Google Maps API key
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
PORT=3001
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:5500
```

### 4. Start the server
```bash
npm start
```

### 5. Open the application
- **Proxy Server**: http://localhost:3001
- **Client App**: Use Live Server extension for `indexMVP.html`

## 🏗️ Architecture

```
┌─────────────────┐    HTTPS Requests    ┌─────────────────┐    Secure API Calls    ┌─────────────────┐
│   Client App    │ ──────────────────► │  Proxy Server   │ ────────────────────► │ Google Maps API │
│ (indexMVP.html) │                     │  (port 3001)    │                       │                 │
└─────────────────┘                     └─────────────────┘                       └─────────────────┘
```

## 📁 Project Structure

```
├── indexMVP.html                 # Main booking application
├── style.css                     # Application styling
├── pricing.js                    # Dynamic pricing engine
├── supabase.js                   # Database integration
├── airport-booking-api-proxy/    # Secure Google Maps proxy
│   ├── server.js                 # Express proxy server
│   ├── package.json              # Server dependencies
│   ├── .env                      # Environment variables (DO NOT COMMIT)
│   └── README.md                 # Server documentation
├── images/                       # Vehicle and UI images
│   ├── luxury-sedan.jpg
│   ├── premium-suv-escalade.jpg
│   └── vip-sprinter.jpg
└── netlify/                      # Serverless functions
    └── Functions/
        ├── calculate-price.js
        ├── create-booking.js
        └── maps-proxy.js
```

## 🔧 Development

The application uses a secure proxy architecture:
- **Client-side**: Makes requests to localhost:3001 proxy endpoints
- **Server-side**: Handles Google Maps API calls with secure key management
- **Security**: API key stored in environment variables, never exposed to browser

### Key Security Implementation:
1. **CustomAutocomplete Class**: Uses `/api/places/autocomplete` instead of direct Google API
2. **Place Details**: Fetches through `/api/places/details` proxy endpoint
3. **Route Calculations**: Uses `/api/directions` for secure distance/duration data
4. **Map Visualization**: Limited direct Google Maps usage for display components only

## 📊 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/maps-script` | GET | Load Google Maps JavaScript library securely |
| `/api/places/autocomplete` | GET | Address autocomplete suggestions |
| `/api/places/details` | GET | Detailed place information by place_id |
| `/api/directions` | POST | Route calculations for pricing and duration |

## ⚠️ Security Best Practices

1. **Never commit .env files** - They contain your API keys
2. **Use environment variables** for all sensitive configuration
3. **Proxy server required** - Direct Google API calls are disabled for security
4. **HTTPS recommended** for production deployment
5. **Regular key rotation** - Rotate API keys periodically

## 🚀 Deployment

### Development
```bash
# Start proxy server
cd airport-booking-api-proxy && npm start

# Open client app with Live Server
# Point to indexMVP.html
```

### Production Deployment
1. Deploy proxy server to hosting platform (Heroku, AWS, etc.)
2. Set environment variables in hosting platform dashboard
3. Update client-side API URLs to production server
4. Enable HTTPS and configure proper CORS policies
5. Set up monitoring and logging

## 🛡️ Security Validation

✅ **API Key Protection**: Google Maps API key completely hidden from client-side  
✅ **Request Proxying**: All Google API calls go through secure server  
✅ **Session Management**: Client-side token generation without Google dependency  
✅ **CORS Security**: Proper cross-origin request handling  
✅ **Rate Limiting**: Built-in protection against API abuse  
✅ **Environment Variables**: Secure configuration management  

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

**Built with security-first architecture for enterprise-grade applications** 🔐

*Google Maps API integration that prioritizes security without sacrificing functionality.*
