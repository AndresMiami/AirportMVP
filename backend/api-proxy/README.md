# Airport Booking API Proxy 🚗

A secure Node.js proxy server for Google Maps API to protect API keys and provide controlled access to Google Maps services for the Airport Booking application.

## 🎯 Purpose

This proxy server acts as a secure middleware between your frontend application and Google Maps API, providing:

- **API Key Protection**: Keeps your Google Maps API key secure on the server-side
- **Rate Limiting**: Prevents API abuse and controls usage costs
- **CORS Security**: Restricts access to authorized domains only
- **Request Logging**: Monitors API usage and performance
- **Error Handling**: Provides consistent error responses

## 🏗️ Project Structure

```
airport-booking-api-proxy/
├── server.js              # Main server file
├── package.json           # Project configuration
├── .env.example          # Environment variables template
├── .gitignore            # Git ignore rules
├── README.md             # This file
└── routes/               # API route handlers (to be added)
    ├── geocoding.js      # Geocoding API proxy
    ├── directions.js     # Directions API proxy
    ├── places.js         # Places API proxy
    └── distance.js       # Distance Matrix API proxy
```

## 🚀 Quick Start

### Prerequisites

- Node.js >= 14.0.0
- npm or yarn
- Google Maps API Key with appropriate permissions

### Installation

1. **Clone and navigate to the project:**
   ```bash
   cd airport-booking-api-proxy
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your configuration:
   ```env
   PORT=3001
   NODE_ENV=development
   GOOGLE_MAPS_API_KEY=your_actual_api_key_here
   ALLOWED_ORIGINS=http://localhost:3000,https://yourdomain.com
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

5. **For production:**
   ```bash
   npm start
   ```

## 🔑 Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port number | No | 3001 |
| `NODE_ENV` | Environment (development/production) | No | development |
| `GOOGLE_MAPS_API_KEY` | Your Google Maps API key | **Yes** | - |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins | No | http://localhost:3000 |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in milliseconds | No | 900000 (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | No | 100 |

## 📡 API Endpoints

### Health Check
- **GET** `/health` - Server health status

### Google Maps Proxy Endpoints (To be implemented)
- **GET** `/api/geocoding` - Geocoding API proxy
- **GET** `/api/directions` - Directions API proxy  
- **GET** `/api/places/autocomplete` - Places Autocomplete proxy
- **GET** `/api/places/details` - Place Details proxy
- **GET** `/api/distance-matrix` - Distance Matrix API proxy

## 🔒 Security Features

- **Helmet.js**: Security headers
- **CORS**: Cross-Origin Resource Sharing protection
- **Rate Limiting**: Prevents API abuse (100 requests per 15 minutes per IP)
- **Input Validation**: Sanitizes and validates all inputs
- **Error Handling**: Secure error responses without sensitive data leaks

## 🛠️ Development

### Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with auto-reload
- `npm test` - Run test suite (when tests are added)

### Adding New Endpoints

1. Create a new route file in `routes/` directory
2. Implement the Google Maps API proxy logic
3. Add route to `server.js`
4. Update this README with the new endpoint

### Example Route Structure

```javascript
// routes/geocoding.js
const express = require('express');
const axios = require('axios');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { address } = req.query;
    
    if (!address) {
      return res.status(400).json({ error: 'Address parameter required' });
    }

    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        address,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Geocoding request failed' });
  }
});

module.exports = router;
```

## 🚦 Usage with Frontend

### Frontend Integration Example

```javascript
// In your frontend application
const API_BASE_URL = 'http://localhost:3001';

// Instead of calling Google Maps directly:
// https://maps.googleapis.com/maps/api/geocode/json?address=...&key=YOUR_KEY

// Call your proxy server:
const response = await fetch(`${API_BASE_URL}/api/geocoding?address=${encodeURIComponent(address)}`);
const data = await response.json();
```

## 📊 Monitoring & Logging

The server includes:
- Request logging with Morgan
- Error tracking
- Performance monitoring
- Health check endpoint for uptime monitoring

## 🌐 Deployment

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure proper `ALLOWED_ORIGINS`
- [ ] Set up SSL/HTTPS
- [ ] Configure reverse proxy (nginx/Apache)
- [ ] Set up process manager (PM2/systemd)
- [ ] Configure logging and monitoring
- [ ] Set up automated backups

### Environment-Specific Configurations

**Development:**
```env
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000
```

**Production:**
```env
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

For support and questions:
- Check the [Issues](../../issues) page
- Review the Google Maps API documentation
- Ensure your API key has the correct permissions

---

**Note**: This is a security-focused proxy server. Never expose your Google Maps API key in frontend code when using this proxy.
