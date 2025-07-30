const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP to allow external scripts
  crossOriginResourcePolicy: false // Disable CORP to allow cross-origin resources
}));
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow any localhost origin
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }
    
    // Allow specific origins if defined
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    return callback(null, true); // Allow all origins for development
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});
app.use('/api/', limiter);

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from the main project directory
app.use(express.static(path.join(__dirname, '..')));

// Serve specific app directories
app.use('/passenger-app', express.static(path.join(__dirname, '../passenger-app')));
app.use('/driver-app', express.static(path.join(__dirname, '../driver-app')));
app.use('/tracking-app', express.static(path.join(__dirname, '../tracking-app')));
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Airport Booking Server with Google Maps Proxy'
  });
});

// Main app routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../indexMVP.html'));
});

app.get('/passenger', (req, res) => {
  res.sendFile(path.join(__dirname, '../passenger-app/indexMVP.html'));
});

app.get('/driver', (req, res) => {
  res.sendFile(path.join(__dirname, '../driver-app/index.html'));
});

app.get('/tracking/:tripId?', (req, res) => {
  res.sendFile(path.join(__dirname, '../tracking-app/index.html'));
});

// Google Maps API Proxy Routes

// Google Places Autocomplete
app.get('/api/places/autocomplete', async (req, res) => {
  try {
    const { input, types, location, radius, components, sessiontoken } = req.query;
    
    // Trim input and validate
    const trimmedInput = input?.trim();
    
    if (!trimmedInput) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    // Validate input length
    if (trimmedInput.length > 100) {
      return res.status(400).json({ 
        error: 'Input too long',
        status: 'ERROR'
      });
    }

    const params = {
      input: trimmedInput,
      key: process.env.GOOGLE_MAPS_API_KEY
    };

    // Add optional parameters if provided
    if (types) params.types = types.trim();
    if (location) params.location = location.trim();
    if (radius) params.radius = radius;
    if (components) params.components = components.trim();
    if (sessiontoken) params.sessiontoken = sessiontoken.trim();

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/autocomplete/json',
      { params }
    );

    // Filter response to only return essential fields
    const filteredResponse = {
      status: response.data.status,
      predictions: response.data.predictions?.map(prediction => ({
        place_id: prediction.place_id,
        description: prediction.description,
        structured_formatting: prediction.structured_formatting,
        types: prediction.types
      })) || []
    };

    res.json(filteredResponse);
  } catch (error) {
    console.error('Places Autocomplete Error:', error.message);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Place Details
app.get('/api/places/details', async (req, res) => {
  try {
    const { place_id, fields, sessiontoken } = req.query;
    
    // Trim and validate place_id
    const trimmedPlaceId = place_id?.trim();
    
    if (!trimmedPlaceId) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    const params = {
      place_id: trimmedPlaceId,
      key: process.env.GOOGLE_MAPS_API_KEY,
      fields: fields?.trim() || 'geometry,formatted_address,name'
    };

    // Add sessiontoken if provided
    if (sessiontoken) params.sessiontoken = sessiontoken.trim();

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      { params }
    );

    // Filter response to only return essential fields
    const filteredResponse = {
      status: response.data.status,
      result: response.data.result ? {
        formatted_address: response.data.result.formatted_address,
        geometry: response.data.result.geometry,
        name: response.data.result.name
      } : null
    };

    res.json(filteredResponse);
  } catch (error) {
    console.error('Place Details Error:', error.message);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Directions API
app.post('/api/directions', async (req, res) => {
  try {
    const { origin, destination, mode, waypoints, alternatives, avoid } = req.body;
    
    // Trim and validate required parameters
    const trimmedOrigin = origin?.trim();
    const trimmedDestination = destination?.trim();
    
    if (!trimmedOrigin || !trimmedDestination) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    const params = {
      origin: trimmedOrigin,
      destination: trimmedDestination,
      key: process.env.GOOGLE_MAPS_API_KEY,
      mode: mode?.trim() || 'driving',
      departure_time: 'now',
      traffic_model: 'best_guess'
    };

    // Add optional parameters with trimming
    if (waypoints) params.waypoints = waypoints.trim();
    if (alternatives) params.alternatives = alternatives;
    if (avoid) params.avoid = avoid.trim();

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/directions/json',
      { params }
    );

    // Filter response to only return essential fields
    const filteredResponse = {
      status: response.data.status
    };

    if (response.data.routes && response.data.routes.length > 0) {
      const firstRoute = response.data.routes[0];
      if (firstRoute.legs && firstRoute.legs.length > 0) {
        const firstLeg = firstRoute.legs[0];
        filteredResponse.route = {
          distance: firstLeg.distance,
          duration: firstLeg.duration,
          duration_in_traffic: firstLeg.duration_in_traffic,
          overview_polyline: firstRoute.overview_polyline
        };
      }
    }

    res.json(filteredResponse);
  } catch (error) {
    console.error('Directions Error:', error.message);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Geocoding API (bonus endpoint for address to coordinates)
app.get('/api/geocoding', async (req, res) => {
  try {
    const { address, latlng, components } = req.query;
    
    // Trim inputs
    const trimmedAddress = address?.trim();
    const trimmedLatlng = latlng?.trim();
    
    if (!trimmedAddress && !trimmedLatlng) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    const params = {
      key: process.env.GOOGLE_MAPS_API_KEY
    };

    if (trimmedAddress) params.address = trimmedAddress;
    if (trimmedLatlng) params.latlng = trimmedLatlng;
    if (components) params.components = components.trim();

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      { params }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Geocoding Error:', error.message);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Google Maps Script Proxy
app.options('/api/maps-script', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  });
  res.sendStatus(200);
});

app.get('/api/maps-script', async (req, res) => {
  try {
    const mapsUrl = 'https://maps.googleapis.com/maps/api/js';
    const params = new URLSearchParams({
      key: process.env.GOOGLE_MAPS_API_KEY,
      v: 'weekly',
      libraries: 'places',
      callback: 'initGoogleMaps'
    });
    
    const response = await axios.get(`${mapsUrl}?${params}`, {
      responseType: 'text'
    });
    
    // Set comprehensive headers for script loading
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff'
    });
    
    res.send(response.data);
  } catch (error) {
    console.error('Maps script error:', error.message);
    res.status(500).set('Content-Type', 'application/javascript').send('// Error loading Google Maps');
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong!'
  });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'API endpoint not found',
    status: 'ERROR'
  });
});

// 404 handler for other routes
app.use('*', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, '../indexMVP.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Airport Booking Server with Maps Proxy running on port ${PORT}`);
  console.log(`� Main App: http://localhost:${PORT}/`);
  console.log(`🎫 Passenger App: http://localhost:${PORT}/passenger`);
  console.log(`� Driver App: http://localhost:${PORT}/driver`);
  console.log(`📍 Tracking App: http://localhost:${PORT}/tracking`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
  console.log(`🗺️  Maps API: http://localhost:${PORT}/api/places/autocomplete`);
  console.log(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
