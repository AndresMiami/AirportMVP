# Backend Services

This directory contains all **server-side code** and backend services.

## Structure

### `api-proxy/`
Google Maps API proxy server
- Handles API key security
- Rate limiting
- CORS management
- Request caching

### `functions/`
Netlify serverless functions
- `booking-submit.js` - Process bookings
- `price-calculate.js` - Server-side pricing
- `availability-check.js` - Check availability

## Deployment
- Each service can be deployed independently
- Follows microservices architecture
- Environment variables in `.env`

## Guidelines
✅ Keep services isolated
✅ Document API endpoints
✅ Handle errors gracefully
✅ Implement rate limiting
❌ Don't expose API keys
❌ Don't mix frontend code