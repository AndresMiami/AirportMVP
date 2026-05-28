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

// ============================================
// CACHING IMPLEMENTATION
// ============================================

// Simple in-memory cache (use Redis in production)
const routeCache = new Map();
const placeCache = new Map();
const ROUTE_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours for routes
const PLACE_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days for places
const MAX_CACHE_SIZE = 1000; // Prevent memory issues

// Popular places cache (airports, hotels, landmarks)
const popularPlaces = new Map([
  // Pre-cache airport data
  ['ChIJQ2DP_4u02YgRPNlKgMr9gBE', { // MIA
    formatted_address: 'Miami International Airport (MIA), 2100 NW 42nd Ave, Miami, FL 33142',
    geometry: { location: { lat: 25.7931, lng: -80.2906 } },
    name: 'Miami International Airport'
  }],
  ['ChIJ9frI5Hq42YgR4bCqA7w1_Ww', { // FLL
    formatted_address: 'Fort Lauderdale-Hollywood International Airport (FLL), 100 Terminal Dr, Fort Lauderdale, FL 33315',
    geometry: { location: { lat: 26.0742, lng: -80.1506 } },
    name: 'Fort Lauderdale-Hollywood International Airport'
  }],
  ['ChIJd_cFKRUu2YgR6Me7ie5YMO0', { // PBI
    formatted_address: 'Palm Beach International Airport (PBI), 1000 James L Turnage Blvd, West Palm Beach, FL 33415',
    geometry: { location: { lat: 26.6832, lng: -80.0956 } },
    name: 'Palm Beach International Airport'
  }]
]);

// Cache helper functions
function getCacheKey(origin, destination) {
  return `route:${origin}:${destination}`.toLowerCase().replace(/\s+/g, '');
}

function cleanCache(cache, maxSize = MAX_CACHE_SIZE) {
  if (cache.size > maxSize) {
    const entriesToRemove = cache.size - maxSize + 100;
    const keys = Array.from(cache.keys()).slice(0, entriesToRemove);
    keys.forEach(key => cache.delete(key));
  }
}

// ============================================
// BOOKING STORE (In-Memory with TTL)
// ============================================

const bookingStore = new Map();
const BOOKING_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Store a booking with auto-cleanup
function storeBooking(tripId, data) {
  const booking = {
    ...data,
    tripId,
    storedAt: Date.now(),
    status: 'pending',
    passengerChatId: null,
    driverChatId: null
  };
  bookingStore.set(tripId, booking);
  console.log(`📦 Booking stored: ${tripId}`);

  // Auto-cleanup after TTL
  setTimeout(() => {
    if (bookingStore.has(tripId)) {
      bookingStore.delete(tripId);
      console.log(`🗑️ Booking expired: ${tripId}`);
    }
  }, BOOKING_TTL);

  return booking;
}

function getBooking(tripId) {
  return bookingStore.get(tripId);
}

function updateBooking(tripId, updates) {
  const booking = bookingStore.get(tripId);
  if (booking) {
    const updated = { ...booking, ...updates };
    bookingStore.set(tripId, updated);
    return updated;
  }
  return null;
}

// ============================================
// TELEGRAM BOT HELPERS
// ============================================

const TELEGRAM_API = process.env.TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  : null;

async function sendTelegramMessage(chatId, text, options = {}) {
  if (!TELEGRAM_API) {
    console.warn('⚠️ Telegram not configured');
    return null;
  }

  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
    return response.data;
  } catch (error) {
    console.error('❌ Telegram send error:', error.response?.data || error.message);
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  if (!TELEGRAM_API) return null;

  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text
    });
  } catch (error) {
    console.error('❌ Callback answer error:', error.message);
  }
}

// ============================================
// API USAGE TRACKING
// ============================================

const apiUsageStats = {
  autocomplete: { count: 0, cached: 0 },
  placeDetails: { count: 0, cached: 0 },
  directions: { count: 0, cached: 0 },
  geocoding: { count: 0, cached: 0 }
};

// Reset stats daily
setInterval(() => {
  const date = new Date().toISOString().split('T')[0];
  console.log(`📊 API Usage for ${date}:`, apiUsageStats);
  
  // Reset counters
  Object.keys(apiUsageStats).forEach(key => {
    apiUsageStats[key] = { count: 0, cached: 0 };
  });
}, 24 * 60 * 60 * 1000);

// Usage tracking middleware
const trackApiUsage = (apiType) => {
  return (req, res, next) => {
    apiUsageStats[apiType].count++;
    
    // Add tracking header to response
    res.on('finish', () => {
      const cacheHit = res.getHeader('X-Cache-Hit') === 'true';
      if (cacheHit) {
        apiUsageStats[apiType].cached++;
      }
    });
    
    next();
  };
};

// Middleware for caching directions
const directionsCache = (req, res, next) => {
  const { origin, destination } = req.body;
  const cacheKey = getCacheKey(origin, destination);
  
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ROUTE_CACHE_DURATION) {
    console.log('🎯 Cache hit for route:', cacheKey);
    res.setHeader('X-Cache-Hit', 'true');
    return res.json(cached.data);
  }
  
  // Store original json method
  const originalJson = res.json;
  res.json = function(data) {
    // Only cache successful responses
    if (data.status === 'OK') {
      routeCache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
      });
      cleanCache(routeCache);
      console.log('💾 Cached route:', cacheKey);
    }
    return originalJson.call(this, data);
  };
  
  next();
};

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

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
    service: 'Airport Booking Server with Google Maps Proxy',
    cacheStats: {
      routes: routeCache.size,
      places: placeCache.size
    }
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

// Serve monitoring dashboard
app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard.html'));
});

// API Usage Stats Endpoint
app.get('/api/usage-stats', (req, res) => {
  const totalRequests = Object.values(apiUsageStats)
    .reduce((sum, stat) => sum + stat.count, 0);
  
  const totalCached = Object.values(apiUsageStats)
    .reduce((sum, stat) => sum + stat.cached, 0);
  
  const cacheHitRate = totalRequests > 0 
    ? ((totalCached / totalRequests) * 100).toFixed(2) 
    : 0;
  
  res.json({
    stats: apiUsageStats,
    summary: {
      totalRequests,
      totalCached,
      cacheHitRate: `${cacheHitRate}%`,
      estimatedMonthlyCost: calculateEstimatedCost(apiUsageStats)
    }
  });
});

function calculateEstimatedCost(stats) {
  const dailyMultiplier = 30;
  
  const costs = {
    autocomplete: (stats.autocomplete.count - stats.autocomplete.cached) * dailyMultiplier * 0.00283,
    placeDetails: (stats.placeDetails.count - stats.placeDetails.cached) * dailyMultiplier * 0.017,
    directions: (stats.directions.count - stats.directions.cached) * dailyMultiplier * 0.005,
    geocoding: (stats.geocoding.count - stats.geocoding.cached) * dailyMultiplier * 0.005
  };
  
  const total = Object.values(costs).reduce((sum, cost) => sum + cost, 0);
  const afterCredit = Math.max(0, total - 200);
  
  return {
    breakdown: costs,
    totalBeforeCredit: total.toFixed(2),
    monthlyCredit: 200,
    estimatedCharge: afterCredit.toFixed(2)
  };
}

// ============================================
// GOOGLE MAPS API PROXY ROUTES
// ============================================

// Google Places Autocomplete
app.get('/api/places/autocomplete', trackApiUsage('autocomplete'), async (req, res) => {
  try {
    const { input, types, location, radius, components, sessiontoken } = req.query;
    
    const trimmedInput = input?.trim();
    
    if (!trimmedInput) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    if (trimmedInput.length > 100) {
      return res.status(400).json({ 
        error: 'Input too long',
        status: 'ERROR'
      });
    }

    const params = {
      input: trimmedInput,
      key: process.env.GOOGLE_MAPS_API_KEY,
      components: 'country:us' // Restrict to US for airport app
    };

    if (types) params.types = types.trim();
    if (location) params.location = location.trim();
    if (radius) params.radius = radius;
    if (sessiontoken) params.sessiontoken = sessiontoken.trim();

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/autocomplete/json',
      { params }
    );

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

// Place Details with Caching
app.get('/api/places/details', trackApiUsage('placeDetails'), async (req, res) => {
  try {
    const { place_id, fields, sessiontoken } = req.query;
    
    if (!place_id?.trim()) {
      return res.status(400).json({ 
        error: 'Bad Request',
        status: 'ERROR'
      });
    }

    // Check popular places first (instant, no API call)
    const popularPlace = popularPlaces.get(place_id);
    if (popularPlace) {
      console.log('⭐ Popular place cache hit:', place_id);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json({
        status: 'OK',
        result: popularPlace
      });
    }

    // Check regular cache
    const cached = placeCache.get(place_id);
    if (cached && Date.now() - cached.timestamp < PLACE_CACHE_DURATION) {
      console.log('🎯 Place cache hit:', place_id);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached.data);
    }

    // Make API call
    const params = {
      place_id: place_id.trim(),
      key: process.env.GOOGLE_MAPS_API_KEY,
      fields: fields?.trim() || 'geometry,formatted_address,name'
    };

    if (sessiontoken) params.sessiontoken = sessiontoken.trim();

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      { params }
    );

    const filteredResponse = {
      status: response.data.status,
      result: response.data.result ? {
        formatted_address: response.data.result.formatted_address,
        geometry: response.data.result.geometry,
        name: response.data.result.name
      } : null
    };

    // Cache successful responses
    if (response.data.status === 'OK') {
      placeCache.set(place_id, {
        data: filteredResponse,
        timestamp: Date.now()
      });
      cleanCache(placeCache, 5000);
    }

    res.json(filteredResponse);
  } catch (error) {
    console.error('Place Details Error:', error.message);
    res.status(500).json({ 
      error: 'Internal Server Error',
      status: 'ERROR'
    });
  }
});

// Directions API with Caching
app.post('/api/directions', trackApiUsage('directions'), directionsCache, async (req, res) => {
  try {
    const { origin, destination, mode, waypoints, alternatives, avoid } = req.body;
    
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

    if (waypoints) params.waypoints = waypoints.trim();
    if (alternatives) params.alternatives = alternatives;
    if (avoid) params.avoid = avoid.trim();

    const response = await axios.get(
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

// Geocoding API
app.get('/api/geocoding', trackApiUsage('geocoding'), async (req, res) => {
  try {
    const { address, latlng, components } = req.query;
    
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
// Note: CORS is handled by the global middleware above
app.get('/api/maps-script', async (req, res) => {
  try {
    const mapsUrl = 'https://maps.googleapis.com/maps/api/js';
    const params = new URLSearchParams({
      key: process.env.GOOGLE_MAPS_API_KEY,
      v: 'weekly',
      libraries: 'places',
      callback: 'initGoogleMaps',
      loading: 'async'  // Fix Google Maps async loading warning
    });
    
    const response = await axios.get(`${mapsUrl}?${params}`, {
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
    console.error('Maps script error:', error.message);
    res.status(500).set('Content-Type', 'application/javascript').send('// Error loading Google Maps');
  }
});

// ============================================
// BOOKING STORAGE API
// ============================================

// Store booking from frontend
app.post('/api/store-booking', (req, res) => {
  try {
    const { tripId, ...bookingData } = req.body;

    if (!tripId) {
      return res.status(400).json({ error: 'tripId is required' });
    }

    const booking = storeBooking(tripId, bookingData);

    // Send notification to admin
    if (process.env.ADMIN_TELEGRAM_CHAT_ID) {
      const adminMessage = formatAdminNotification(booking);
      sendTelegramMessage(process.env.ADMIN_TELEGRAM_CHAT_ID, adminMessage, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Accept Ride', callback_data: `accept_${tripId}` },
              { text: '❌ Decline', callback_data: `decline_${tripId}` }
            ],
            [
              { text: '📞 Call Customer', url: `tel:${bookingData.phone || ''}` }
            ]
          ]
        }
      });
    }

    res.json({ success: true, tripId, message: 'Booking stored' });
  } catch (error) {
    console.error('Store booking error:', error);
    res.status(500).json({ error: 'Failed to store booking' });
  }
});

// Get booking by tripId
app.get('/api/booking/:tripId', (req, res) => {
  const booking = getBooking(req.params.tripId);
  if (booking) {
    res.json(booking);
  } else {
    res.status(404).json({ error: 'Booking not found' });
  }
});

// Format admin notification message
function formatAdminNotification(booking) {
  const isUrgent = booking.pickupDateTime &&
    (new Date(booking.pickupDateTime) - new Date()) < (2 * 60 * 60 * 1000);

  return `🆕 NEW RIDE REQUEST #${booking.tripId}
━━━━━━━━━━━━━━━━━━━
👤 ${booking.customerName || 'Guest'}
📱 ${booking.phone || 'No phone'}

📍 From: ${booking.pickup || 'N/A'}
✈️ To: ${booking.dropoff || 'N/A'}
🕐 When: ${booking.pickupDateTime || 'ASAP'}
${isUrgent ? '⚡ URGENT - Less than 2 hours!' : ''}

💵 Price: $${booking.price || '0'}
🚘 Vehicle: ${booking.vehicle || 'Standard'}
👥 Passengers: ${booking.passengers || 1}

${booking.notes ? `📝 Notes: ${booking.notes}` : ''}`;
}

// ============================================
// TELEGRAM WEBHOOK
// ============================================

app.post('/webhook/telegram', async (req, res) => {
  try {
    const update = req.body;
    console.log('📨 Telegram update received:', JSON.stringify(update, null, 2));

    // Handle /start command
    if (update.message?.text?.startsWith('/start')) {
      await handleStartCommand(update.message);
    }
    // Handle button clicks (callback queries)
    else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
    // Handle regular messages (for driver-passenger chat)
    else if (update.message?.text) {
      await handleRegularMessage(update.message);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.json({ ok: true }); // Always return 200 to Telegram
  }
});

// Handle /start command from passengers
async function handleStartCommand(message) {
  const chatId = message.chat.id;
  const text = message.text;
  const firstName = message.from?.first_name || 'there';

  // Check if it's a booking deep link: /start booking_LM-XXXX
  const bookingMatch = text.match(/\/start\s+booking_(.+)/);

  if (bookingMatch) {
    const tripId = bookingMatch[1];
    const booking = getBooking(tripId);

    if (booking) {
      // Link passenger's chat to this booking
      updateBooking(tripId, { passengerChatId: chatId });

      // Send confirmation to passenger
      await sendTelegramMessage(chatId, `👋 Hi ${firstName}!

✅ <b>Booking Confirmed!</b>

📋 <b>Trip #${tripId}</b>
📍 From: ${booking.pickup || 'N/A'}
✈️ To: ${booking.dropoff || 'N/A'}
🕐 When: ${booking.pickupDateTime || 'ASAP'}
💵 Price: $${booking.price || '0'}
🚘 Vehicle: ${booking.vehicle || 'Standard'}

⏳ <b>Finding your driver...</b>
I'll notify you as soon as a driver accepts your ride!

💬 You can send me a message anytime if you need to update your pickup details.`);

      console.log(`✅ Passenger ${chatId} linked to booking ${tripId}`);
    } else {
      // Booking not found
      await sendTelegramMessage(chatId, `👋 Hi ${firstName}!

❌ Sorry, I couldn't find booking #${tripId}.

It may have expired or there was an error. Please try booking again:
🔗 https://i-love-miami.netlify.app`);
    }
  } else {
    // Generic /start without booking
    await sendTelegramMessage(chatId, `👋 Welcome to LinkMia, ${firstName}!

🚗 Premium Miami Airport Transfers

To book a ride, visit:
🔗 https://i-love-miami.netlify.app

Or send me a message with your pickup details and I'll help you book!`);
  }
}

// Handle callback queries (button clicks)
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const callbackQueryId = callbackQuery.id;

  console.log(`🔘 Button clicked: ${data} by chat ${chatId}`);

  // Parse callback data: accept_LM-XXXX or decline_LM-XXXX
  const [action, tripId] = data.split('_');

  if (!tripId) {
    await answerCallbackQuery(callbackQueryId, 'Invalid action');
    return;
  }

  const booking = getBooking(tripId);
  if (!booking) {
    await answerCallbackQuery(callbackQueryId, 'Booking not found or expired');
    return;
  }

  if (action === 'accept') {
    // Driver accepts the ride
    updateBooking(tripId, {
      status: 'accepted',
      driverChatId: chatId,
      acceptedAt: new Date().toISOString()
    });

    await answerCallbackQuery(callbackQueryId, '✅ Ride accepted!');

    // Notify admin/driver
    await sendTelegramMessage(chatId, `✅ <b>Ride Accepted!</b>

📋 Trip #${tripId}
📍 Pickup: ${booking.pickup}
✈️ Dropoff: ${booking.dropoff}
🕐 Time: ${booking.pickupDateTime || 'ASAP'}
👤 Passenger: ${booking.customerName || 'Guest'}
📱 Phone: ${booking.phone || 'N/A'}

Use buttons below to update status:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🚗 On My Way', callback_data: `otw_${tripId}` },
            { text: '📍 Arrived', callback_data: `arrived_${tripId}` }
          ],
          [
            { text: '✅ Trip Complete', callback_data: `complete_${tripId}` }
          ],
          [
            { text: '💬 Message Passenger', callback_data: `msg_${tripId}` }
          ]
        ]
      }
    });

    // Notify passenger if they're connected
    if (booking.passengerChatId) {
      await sendTelegramMessage(booking.passengerChatId, `🎉 <b>Driver Confirmed!</b>

Your driver has accepted your ride request.

📋 Trip #${tripId}
🚗 Driver: Andres
📱 Contact: Available through this chat

Your driver will notify you when they're on the way.
Feel free to send any messages here - they'll be forwarded to your driver!`);
    }
  }
  else if (action === 'decline') {
    updateBooking(tripId, { status: 'declined' });
    await answerCallbackQuery(callbackQueryId, '❌ Ride declined');

    // Notify passenger
    if (booking.passengerChatId) {
      await sendTelegramMessage(booking.passengerChatId, `😔 Sorry, no drivers are currently available for your ride.

Please try again later or contact us for assistance.

🔗 Book again: https://i-love-miami.netlify.app`);
    }
  }
  else if (action === 'otw') {
    updateBooking(tripId, { status: 'on_the_way' });
    await answerCallbackQuery(callbackQueryId, '🚗 Status updated!');

    if (booking.passengerChatId) {
      await sendTelegramMessage(booking.passengerChatId, `🚗 <b>Driver On The Way!</b>

Your driver Andres is heading to your pickup location.

📍 Pickup: ${booking.pickup}
⏱️ ETA: Check your confirmation for estimated time

💬 Send a message here if you need to communicate with your driver.`);
    }
  }
  else if (action === 'arrived') {
    updateBooking(tripId, { status: 'arrived' });
    await answerCallbackQuery(callbackQueryId, '📍 Passenger notified!');

    if (booking.passengerChatId) {
      await sendTelegramMessage(booking.passengerChatId, `📍 <b>Driver Has Arrived!</b>

Your driver Andres is at the pickup location.

🚗 Look for: Black Vehicle
📍 Location: ${booking.pickup}

Please head to the pickup point!`);
    }
  }
  else if (action === 'complete') {
    updateBooking(tripId, { status: 'completed', completedAt: new Date().toISOString() });
    await answerCallbackQuery(callbackQueryId, '✅ Trip completed!');

    if (booking.passengerChatId) {
      await sendTelegramMessage(booking.passengerChatId, `✅ <b>Trip Complete!</b>

Thank you for riding with LinkMia! 🙏

📋 Trip #${tripId}
💵 Total: $${booking.price || '0'}

⭐ How was your ride?`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '⭐⭐⭐⭐⭐ Excellent', callback_data: `rate_5_${tripId}` }
            ],
            [
              { text: '⭐⭐⭐⭐ Good', callback_data: `rate_4_${tripId}` }
            ],
            [
              { text: '⭐⭐⭐ OK', callback_data: `rate_3_${tripId}` }
            ],
            [
              { text: '🔗 Book Another Ride', url: 'https://i-love-miami.netlify.app' }
            ]
          ]
        }
      });
    }

    // Notify driver
    await sendTelegramMessage(chatId, `✅ Trip #${tripId} marked as complete!

💵 Fare: $${booking.price || '0'}

Ready for the next ride? 🚗`);
  }
  else if (action === 'msg') {
    // Driver wants to message passenger
    updateBooking(tripId, { awaitingDriverMessage: true, driverChatId: chatId });
    await answerCallbackQuery(callbackQueryId, 'Send your message now');
    await sendTelegramMessage(chatId, `💬 Send your message to the passenger now. I'll forward it to them.`);
  }
  else if (action.startsWith('rate_')) {
    const rating = action.split('_')[1];
    updateBooking(tripId, { rating: parseInt(rating) });
    await answerCallbackQuery(callbackQueryId, 'Thank you for your feedback!');
    await sendTelegramMessage(chatId, `Thank you for rating your ride! ⭐

We appreciate your feedback and look forward to serving you again.

🔗 Book your next ride: https://i-love-miami.netlify.app`);
  }
}

// Handle regular messages (forward between driver and passenger)
async function handleRegularMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;

  // Find any booking where this chat is passenger or driver
  let foundBooking = null;
  for (const [tripId, booking] of bookingStore) {
    if (booking.passengerChatId === chatId || booking.driverChatId === chatId) {
      if (booking.status === 'accepted' || booking.status === 'on_the_way' || booking.status === 'arrived') {
        foundBooking = booking;
        break;
      }
    }
  }

  if (foundBooking) {
    const isPassenger = foundBooking.passengerChatId === chatId;
    const targetChatId = isPassenger ? foundBooking.driverChatId : foundBooking.passengerChatId;

    if (targetChatId) {
      const sender = isPassenger ? '👤 Passenger' : '🚗 Driver';
      await sendTelegramMessage(targetChatId, `${sender}:\n${text}`);
      await sendTelegramMessage(chatId, `✅ Message sent!`);
    } else {
      await sendTelegramMessage(chatId, `⚠️ Cannot forward message - the other party hasn't connected yet.`);
    }
  } else {
    // No active booking - general message
    await sendTelegramMessage(chatId, `👋 Hi! I don't see an active ride for you.

To book a ride, visit:
🔗 https://i-love-miami.netlify.app

Or reply with your pickup address and destination, and I can help you get started!`);
  }
}

// ============================================
// ERROR HANDLING
// ============================================

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
  res.status(404).sendFile(path.join(__dirname, '..', '..', 'indexMVP.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Airport Booking Server with Maps Proxy running on port ${PORT}`);
  console.log(`🏠 Main App: http://localhost:${PORT}/`);
  console.log(`🎫 Passenger App: http://localhost:${PORT}/passenger`);
  console.log(`🚗 Driver App: http://localhost:${PORT}/driver`);
  console.log(`📍 Tracking App: http://localhost:${PORT}/tracking`);
  console.log(`📊 Cost Monitor: http://localhost:${PORT}/dashboard.html`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
  console.log(`🗺️  Maps API: http://localhost:${PORT}/api/places/autocomplete`);
  console.log(`📈 Usage Stats: http://localhost:${PORT}/api/usage-stats`);
  console.log(`🔒 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;