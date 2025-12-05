/**
 * Service Worker for LinkMia PWA
 * Handles caching, offline functionality, and performance optimization
 */

const CACHE_NAME = 'linkmia-v1.0.0';
const RUNTIME_CACHE = 'linkmia-runtime';

// Files to cache immediately on install
const STATIC_CACHE_URLS = [
  '/indexMVP.html',
  '/offline.html',
  '/css/style.css',
  '/css/maps-autocomplete.css',
  '/debug.js',
  '/error-handler.js',
  '/config.js',
  '/api-config.js',
  '/datetime-utils.js',
  '/pricing.js',
  '/supabase.js',
  '/vehicle-carousel-standalone.html',
  '/images/luxury-sedan.jpg',
  '/images/premium-suv-escalade.jpg',
  '/images/vip-sprinter.jpg'
];

// Cache strategies
const CACHE_STRATEGIES = {
  cacheFirst: [
    /\.(?:css|js)$/,
    /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
    /fonts\.googleapis\.com/,
    /fonts\.gstatic\.com/
  ],
  networkFirst: [
    /api\//,
    /\.json$/,
    /maps\.googleapis\.com/
  ],
  networkOnly: [
    /\/api\/booking/,
    /\/api\/payment/,
    /stripe\.com/
  ]
};

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching static assets');
        // Cache files one by one to handle failures gracefully
        return Promise.allSettled(
          STATIC_CACHE_URLS.map(url => 
            cache.add(url).catch(err => 
              console.warn(`[Service Worker] Failed to cache ${url}:`, err)
            )
          )
        );
      })
      .then(() => {
        console.log('[Service Worker] Static assets cached');
        // Skip waiting to activate immediately
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => {
              return (cacheName.startsWith('linkmia-') || cacheName.startsWith('luxeride-')) && cacheName !== CACHE_NAME;
            })
            .map((cacheName) => {
              console.log('[Service Worker] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            })
        );
      })
      .then(() => {
        console.log('[Service Worker] Activated');
        // Take control of all clients immediately
        return self.clients.claim();
      })
  );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-HTTP(S) requests
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Skip cross-origin requests (except allowed ones)
  const allowedOrigins = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'maps.googleapis.com',
    'reliable-warmth-production-d382.up.railway.app'
  ];
  
  if (url.origin !== self.location.origin && !allowedOrigins.some(origin => url.hostname.includes(origin))) {
    return;
  }

  // Determine caching strategy
  const strategy = getStrategy(request);
  
  event.respondWith(
    handleRequest(request, strategy)
      .catch(() => {
        // If all else fails, return offline page for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/offline.html');
        }
        // Return a basic error response for other requests
        return new Response('Network error', {
          status: 408,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});

// Determine caching strategy based on request
function getStrategy(request) {
  const url = request.url;
  
  // Check network-only patterns
  for (const pattern of CACHE_STRATEGIES.networkOnly) {
    if (pattern.test(url)) {
      return 'network-only';
    }
  }
  
  // Check network-first patterns
  for (const pattern of CACHE_STRATEGIES.networkFirst) {
    if (pattern.test(url)) {
      return 'network-first';
    }
  }
  
  // Check cache-first patterns
  for (const pattern of CACHE_STRATEGIES.cacheFirst) {
    if (pattern.test(url)) {
      return 'cache-first';
    }
  }
  
  // Default to network-first
  return 'network-first';
}

// Handle request based on strategy
async function handleRequest(request, strategy) {
  switch (strategy) {
    case 'cache-first':
      return cacheFirst(request);
    case 'network-first':
      return networkFirst(request);
    case 'network-only':
      return networkOnly(request);
    default:
      return networkFirst(request);
  }
}

// Cache-first strategy
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    throw error;
  }
}

// Network-first strategy
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Only cache GET requests that are successful
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

// Network-only strategy
async function networkOnly(request) {
  return fetch(request);
}

// Handle background sync for offline bookings
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-bookings') {
    event.waitUntil(syncOfflineBookings());
  }
});

// Sync offline bookings when connection is restored
async function syncOfflineBookings() {
  try {
    // Get pending bookings from IndexedDB (implement if needed)
    console.log('[Service Worker] Syncing offline bookings...');
    // Implementation would go here
  } catch (error) {
    console.error('[Service Worker] Sync failed:', error);
  }
}

// Handle push notifications
self.addEventListener('push', (event) => {
  const options = {
    body: event.data ? event.data.text() : 'Your ride is arriving!',
    icon: '/images/icon-192x192.png',
    badge: '/images/badge-72x72.png',
    vibrate: [200, 100, 200],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '1'
    },
    actions: [
      {
        action: 'track',
        title: 'Track Driver',
        icon: '/images/track-icon.png'
      },
      {
        action: 'close',
        title: 'Close',
        icon: '/images/close-icon.png'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('LinkMia', options)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'track') {
    // Open tracking page
    event.waitUntil(
      clients.openWindow('/indexMVP.html?action=track')
    );
  } else {
    // Open main app
    event.waitUntil(
      clients.openWindow('/indexMVP.html')
    );
  }
});

// Listen for skip waiting message
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('[Service Worker] Loaded');