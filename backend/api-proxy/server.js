const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const axios = require('axios');
const path = require('path');
const {
  isValidPlaceId,
  MAX_PLACE_ID_LEN
} = require('../functions/lib/place-identity');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const defaultMapsGet = axios.get.bind(axios);
let mapsGet = defaultMapsGet;
let accessLogSink = (line) => process.stdout.write(line);
let diagnosticLogSink = (line) => console.error(line);

// ============================================
// API USAGE TRACKING
// ============================================

const apiUsageStats = {
  autocomplete: { acceptedRouteRequests: 0, providerAttempts: 0 },
  placeDetails: { acceptedRouteRequests: 0, providerAttempts: 0 },
  directions: { acceptedRouteRequests: 0, providerAttempts: 0 },
  geocoding: { acceptedRouteRequests: 0, providerAttempts: 0 },
  mapsScript: { acceptedRouteRequests: 0, providerAttempts: 0 }
};

function resetApiUsageStats() {
  Object.keys(apiUsageStats).forEach((key) => {
    apiUsageStats[key] = { acceptedRouteRequests: 0, providerAttempts: 0 };
  });
}

// Reset stats daily
const usageResetTimer = setInterval(() => {
  const date = new Date().toISOString().split('T')[0];
  console.log(`📊 API Usage for ${date}:`, apiUsageStats);
  resetApiUsageStats();
}, 24 * 60 * 60 * 1000);
usageResetTimer.unref?.();

// Usage tracking middleware
const trackApiUsage = (apiType) => {
  return (req, res, next) => {
    // This middleware runs only after CORS, parsing and rate limiting. Name
    // the metric for that precise boundary instead of overclaiming that it
    // counts every socket-level request Railway received.
    apiUsageStats[apiType].acceptedRouteRequests++;
    next();
  };
};

function recordProviderAttempt(apiType) {
  apiUsageStats[apiType].providerAttempts++;
}

function sanitizedProviderStatus(error) {
  const status = Number(error?.response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? String(status)
    : 'unavailable';
}

function logProviderFailure(apiType, error) {
  diagnosticLogSink(`maps_provider_failure endpoint=${apiType} status=${sanitizedProviderStatus(error)}`);
}

function boundedString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

const SESSION_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LAT_LNG_RE = /^-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?$/;
const SAFE_ACCESS_PATHS = new Set([
  '/', '/health', '/passenger', '/driver',
  '/api/usage-stats', '/api/places/autocomplete', '/api/places/details',
  '/api/directions', '/api/geocoding', '/api/maps-script'
]);

function isValidLatLng(value) {
  if (!LAT_LNG_RE.test(value)) return false;
  const [lat, lng] = value.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function safeAccessPath(originalUrl) {
  // Morgan evaluates tokens when the response finishes. Express may have
  // stripped a mounted catch-all from req.url/req.path by then, while
  // originalUrl remains the immutable request target. Remove its query before
  // classification and return only a fixed allowlisted label.
  const raw = typeof originalUrl === 'string' ? originalUrl : '';
  const queryAt = raw.indexOf('?');
  const reqPath = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (SAFE_ACCESS_PATHS.has(reqPath)) return reqPath;
  if (reqPath.startsWith('/tracking/')) return '/tracking/:tripId';
  if (reqPath.startsWith('/api/')) return '/api/:unmatched';
  return '/other';
}

function valueOnly(providerValue) {
  const value = Number(providerValue?.value);
  return Number.isFinite(value) && value >= 0 ? { value } : undefined;
}

function filteredGeocodingResponse(providerData) {
  if (providerData?.status === 'ZERO_RESULTS') {
    return { ok: true, body: { status: 'ZERO_RESULTS', results: [] } };
  }
  if (providerData?.status !== 'OK' || !Array.isArray(providerData.results)) {
    return { ok: false, body: null };
  }
  return {
    ok: true,
    body: {
      status: 'OK',
      results: providerData.results.map((result) => {
        const location = result?.geometry?.location;
        return {
          formatted_address: result?.formatted_address,
          place_id: result?.place_id,
          geometry: location ? { location: { lat: location.lat, lng: location.lng } } : undefined
        };
      })
    }
  };
}

function optionalSessionToken(value) {
  if (value === undefined) return { ok: true, value: null };
  const token = boundedString(value, 64);
  return token && SESSION_TOKEN_RE.test(token)
    ? { ok: true, value: token }
    : { ok: false, value: null };
}

// ============================================
// MIDDLEWARE SETUP
// ============================================

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false
}));

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    // Allow localhost for development
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }
    
    // Check against allowed origins from environment
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
    if (allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed))) {
      return callback(null, true);
    }
    
    // Reject all other origins to prevent infinite loops
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});
app.use('/api/', limiter);

// Path-only access telemetry. Never log query strings: Maps proxy queries
// contain typed addresses, place IDs and billing session tokens.
morgan.token('safe-path', (req) => safeAccessPath(req.originalUrl));
app.use(morgan(':method :safe-path :status :response-time ms', {
  stream: { write: (line) => accessLogSink(line) }
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Google response content must not be cached by this proxy, browsers or
// intermediary CDNs. The Maps JavaScript loader has its own separate policy
// and route below; do not apply this middleware to /api/maps-script.
const mapsDataNoStore = (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
};

// Serve static files
app.use(express.static(path.join(__dirname, '..')));
app.use('/passenger-app', express.static(path.join(__dirname, '../passenger-app')));
app.use('/driver-app', express.static(path.join(__dirname, '../driver-app')));
app.use('/tracking-app', express.static(path.join(__dirname, '../tracking-app')));
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// Main app route - serve indexMVP.html at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'indexMVP.html'));
});

// ============================================
// ROUTES
// ============================================

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
  res.sendFile(path.join(__dirname, '..', '..', 'indexMVP.html'));
});

app.get('/passenger', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'indexMVP.html'));
});

app.get('/driver', (req, res) => {
  res.sendFile(path.join(__dirname, '../driver-app/index.html'));
});

app.get('/tracking/:tripId?', (req, res) => {
  res.sendFile(path.join(__dirname, '../tracking-app/index.html'));
});

// API Usage Stats Endpoint
app.get('/api/usage-stats', (req, res) => {
  const acceptedRouteRequests = Object.values(apiUsageStats)
    .reduce((sum, stat) => sum + stat.acceptedRouteRequests, 0);
  const providerAttempts = Object.values(apiUsageStats)
    .reduce((sum, stat) => sum + stat.providerAttempts, 0);

  res.json({
    stats: apiUsageStats,
    summary: {
      acceptedRouteRequests,
      providerAttempts
    }
  });
});

// ============================================
// GOOGLE MAPS API PROXY ROUTES
// ============================================

// Google Places Autocomplete
app.get('/api/places/autocomplete', mapsDataNoStore, trackApiUsage('autocomplete'), async (req, res) => {
  try {
    const trimmedInput = boundedString(req.query.input, 100);
    if (!trimmedInput) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    const sessiontoken = req.query.sessiontoken;
    const session = optionalSessionToken(sessiontoken);
    if (!session.ok) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    const params = {
      input: trimmedInput,
      key: process.env.GOOGLE_MAPS_API_KEY,
      components: 'country:us',
      location: '25.7617,-80.1918',
      radius: '30000'
    };

    // `sessiontoken` was validated above; forwarding the trimmed original
    // preserves the one browser session across Autocomplete and Details.
    if (sessiontoken) params.sessiontoken = sessiontoken.trim();

    recordProviderAttempt('autocomplete');
    const response = await mapsGet(
      'https://maps.googleapis.com/maps/api/place/autocomplete/json',
      { params }
    );

    const filteredResponse = {
      status: response.data.status,
      predictions: response.data.predictions?.map(prediction => ({
        place_id: prediction.place_id,
        description: prediction.description,
        structured_formatting: prediction.structured_formatting ? {
          main_text: prediction.structured_formatting.main_text,
          secondary_text: prediction.structured_formatting.secondary_text
        } : undefined
      })) || []
    };

    res.json(filteredResponse);
  } catch (error) {
    logProviderFailure('autocomplete', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Place Details is deliberately live-only. The selected place ID may be
// retained by the booking flow; Google result content is not cached here.
app.get('/api/places/details', mapsDataNoStore, trackApiUsage('placeDetails'), async (req, res) => {
  try {
    const placeId = boundedString(req.query.place_id, MAX_PLACE_ID_LEN);
    const sessiontoken = req.query.sessiontoken;
    const session = optionalSessionToken(sessiontoken);

    if (!placeId || !isValidPlaceId(placeId) || !session.ok) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    // Make API call
    const params = {
      place_id: placeId,
      key: process.env.GOOGLE_MAPS_API_KEY,
      fields: 'geometry,formatted_address'
    };

    if (sessiontoken) params.sessiontoken = sessiontoken.trim();

    recordProviderAttempt('placeDetails');
    const response = await mapsGet(
      'https://maps.googleapis.com/maps/api/place/details/json',
      { params }
    );

    const location = response.data.result?.geometry?.location;

    const filteredResponse = {
      status: response.data.status,
      result: response.data.result ? {
        formatted_address: response.data.result.formatted_address,
        geometry: location ? { location: { lat: location.lat, lng: location.lng } } : undefined
      } : null
    };

    res.json(filteredResponse);
  } catch (error) {
    logProviderFailure('placeDetails', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Directions results are live-only. Departure-time traffic makes route-result
// reuse both policy-sensitive and functionally stale.
app.post('/api/directions', mapsDataNoStore, trackApiUsage('directions'), async (req, res) => {
  try {
    const trimmedOrigin = boundedString(req.body?.origin, 500);
    const trimmedDestination = boundedString(req.body?.destination, 500);
    
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
      mode: 'driving',
      departure_time: 'now',
      traffic_model: 'best_guess'
    };

    recordProviderAttempt('directions');
    const response = await mapsGet(
      'https://maps.googleapis.com/maps/api/directions/json',
      { params }
    );

    const filteredResponse = {
      status: response.data.status
    };

    if (response.data.routes && response.data.routes.length > 0) {
      const firstRoute = response.data.routes[0];
      if (firstRoute.legs && firstRoute.legs.length > 0) {
        const firstLeg = firstRoute.legs[0];
        filteredResponse.route = {
          distance: valueOnly(firstLeg.distance),
          duration: valueOnly(firstLeg.duration),
          duration_in_traffic: valueOnly(firstLeg.duration_in_traffic)
        };
      }
    }

    res.json(filteredResponse);
  } catch (error) {
    logProviderFailure('directions', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Geocoding API
app.get('/api/geocoding', mapsDataNoStore, trackApiUsage('geocoding'), async (req, res) => {
  try {
    const trimmedAddress = req.query.address === undefined
      ? null
      : boundedString(req.query.address, 500);
    const trimmedLatlng = req.query.latlng === undefined
      ? null
      : boundedString(req.query.latlng, 100);
    const components = req.query.components === undefined
      ? null
      : boundedString(req.query.components, 200);
    
    if ((!trimmedAddress && !trimmedLatlng) ||
        (req.query.latlng !== undefined && (!trimmedLatlng || !isValidLatLng(trimmedLatlng))) ||
        (req.query.address !== undefined && !trimmedAddress) ||
        (req.query.components !== undefined && !components)) {
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
    if (components) params.components = components;

    recordProviderAttempt('geocoding');
    const response = await mapsGet(
      'https://maps.googleapis.com/maps/api/geocode/json',
      { params }
    );

    const filtered = filteredGeocodingResponse(response.data);
    if (!filtered.ok) {
      diagnosticLogSink('maps_provider_failure endpoint=geocoding status=semantic_failure');
      return res.status(502).json({
        error: 'Provider request failed',
        status: 'ERROR'
      });
    }

    res.json(filtered.body);
  } catch (error) {
    logProviderFailure('geocoding', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Google Maps Script Proxy
// Note: CORS is handled by the global middleware above
app.get('/api/maps-script', trackApiUsage('mapsScript'), async (req, res) => {
  try {
    const mapsUrl = 'https://maps.googleapis.com/maps/api/js';
    const params = new URLSearchParams({
      key: process.env.GOOGLE_MAPS_API_KEY,
      v: 'weekly',
      libraries: 'places',
      callback: 'initGoogleMaps',
      loading: 'async'  // Fix Google Maps async loading warning
    });
    
    recordProviderAttempt('mapsScript');
    const response = await mapsGet(`${mapsUrl}?${params}`, {
      responseType: 'text'
    });
    
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
    logProviderFailure('mapsScript', error);
    res.status(500).set('Content-Type', 'application/javascript').send('// Error loading Google Maps');
  }
});


// ============================================
// ERROR HANDLING
// ============================================

// Error handling middleware
app.use((err, req, res, next) => {
  const status = Number(err?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  diagnosticLogSink(`maps_proxy_request_failure status=${safeStatus}`);
  res.status(safeStatus).json({
    error: safeStatus >= 500 ? 'Internal server error' : 'Bad Request',
    message: safeStatus >= 500 ? 'Something went wrong!' : 'Request could not be processed'
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
  res.status(404).sendFile(path.join(__dirname, '..', '..', 'indexMVP.html'));
});

function startServer(port = PORT, host) {
  const onListening = () => {
    console.log(`🚀 Airport Booking Server with Maps Proxy running on port ${port}`);
    console.log(`🏠 Main App: http://localhost:${port}/`);
    console.log(`🎫 Passenger App: http://localhost:${port}/passenger`);
    console.log(`🚗 Driver App: http://localhost:${port}/driver`);
    console.log(`📍 Tracking App: http://localhost:${port}/tracking`);
    console.log(`🔍 Health check: http://localhost:${port}/health`);
    console.log(`🗺️  Maps API: http://localhost:${port}/api/places/autocomplete`);
    console.log(`📈 Usage Stats: http://localhost:${port}/api/usage-stats`);
    console.log(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
  };
  return host ? app.listen(port, host, onListening) : app.listen(port, onListening);
}

const testSeam = Object.freeze({
  setMapsGet(fn) {
    if (typeof fn !== 'function') throw new TypeError('maps getter must be a function');
    mapsGet = fn;
  },
  resetMapsGet() {
    mapsGet = defaultMapsGet;
  },
  setAccessLogSink(fn) {
    if (typeof fn !== 'function') throw new TypeError('access log sink must be a function');
    accessLogSink = fn;
  },
  setDiagnosticLogSink(fn) {
    if (typeof fn !== 'function') throw new TypeError('diagnostic log sink must be a function');
    diagnosticLogSink = fn;
  },
  resetLogSinks() {
    accessLogSink = (line) => process.stdout.write(line);
    diagnosticLogSink = (line) => console.error(line);
  },
  resetApiUsageStats,
  getApiUsageStats() {
    return JSON.parse(JSON.stringify(apiUsageStats));
  },
  safeAccessPath
});

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, testSeam };
