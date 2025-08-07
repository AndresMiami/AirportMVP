/**
 * API Configuration for Hybrid Architecture
 * 
 * This module determines the correct endpoints based on environment:
 * - Google Maps: Uses proxy server (custom autocomplete)
 * - Other APIs: Uses Netlify Functions (serverless)
 */

export const API_CONFIG = {
  // Determine environment
  isProduction: window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1',
  isNetlifyDev: window.location.port === '8888',
  
  // Get Maps Proxy URL (for custom autocomplete)
  getMapsProxyUrl() {
    // Production: Your deployed proxy server
    if (this.isProduction) {
      // Update this when you deploy your proxy to Railway/Render/Heroku
      return 'https://your-proxy-server.railway.app';
    }
    // Local development
    return 'http://localhost:3001';
  },

  // Get API endpoints
  endpoints: {
    // Google Maps (via proxy for custom autocomplete)
    maps: {
      autocomplete: () => `${API_CONFIG.getMapsProxyUrl()}/api/places/autocomplete`,
      directions: () => `${API_CONFIG.getMapsProxyUrl()}/api/directions`,
      mapsScript: () => `${API_CONFIG.getMapsProxyUrl()}/api/maps-script`
    },
    
    // Netlify Functions (serverless)
    booking: {
      calculatePrice: '/api/calculate-price',
      createBooking: '/api/create-booking',
      createPaymentIntent: '/api/create-payment-intent',
      confirmPayment: '/api/confirm-payment',
      trackFlight: '/api/track-flight'
    }
  },

  // Helper function to make API calls
  async apiCall(endpoint, options = {}) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `API call failed: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`API call failed to ${endpoint}:`, error);
      throw error;
    }
  },

  // Specific API methods
  async calculatePrice(tripData) {
    return this.apiCall(this.endpoints.booking.calculatePrice, {
      method: 'POST',
      body: JSON.stringify(tripData)
    });
  },

  async createBooking(bookingData) {
    return this.apiCall(this.endpoints.booking.createBooking, {
      method: 'POST',
      body: JSON.stringify(bookingData)
    });
  },

  async createPaymentIntent(paymentData) {
    return this.apiCall(this.endpoints.booking.createPaymentIntent, {
      method: 'POST',
      body: JSON.stringify(paymentData)
    });
  },

  async getDirections(origin, destination) {
    return this.apiCall(this.endpoints.maps.directions(), {
      method: 'POST',
      body: JSON.stringify({ origin, destination })
    });
  }
};

// Export for use in other modules
window.API_CONFIG = API_CONFIG;