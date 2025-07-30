// Secure Google Maps API Proxy
// This keeps your API key hidden from clients

exports.handler = async (event, context) => {
  // CORS headers for your domain
  const headers = {
    'Access-Control-Allow-Origin': '*', // In production, change to your domain
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only allow GET requests for Maps API
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Get API key from environment variable
  const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
  
  if (!GOOGLE_MAPS_API_KEY) {
    console.error('❌ Google Maps API key not configured in environment variables');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error' })
    };
  }

  // Extract parameters
  const { action, ...params } = event.queryStringParameters || {};

  // Define allowed endpoints
  const endpoints = {
    autocomplete: 'https://maps.googleapis.com/maps/api/place/autocomplete/json',
    directions: 'https://maps.googleapis.com/maps/api/directions/json',
    geocode: 'https://maps.googleapis.com/maps/api/geocode/json',
    placedetails: 'https://maps.googleapis.com/maps/api/place/details/json'
  };

  // Validate action
  if (!action || !endpoints[action]) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid action. Use: autocomplete, directions, geocode, or placedetails' })
    };
  }

  try {
    // Build Google Maps URL
    const url = new URL(endpoints[action]);
    
    // Add all client parameters
    Object.keys(params).forEach(key => {
      if (params[key]) {
        url.searchParams.append(key, params[key]);
      }
    });
    
    // Add API key
    url.searchParams.append('key', GOOGLE_MAPS_API_KEY);

    console.log(`📍 Proxying ${action} request...`);

    // Make request to Google Maps
    const response = await fetch(url.toString());
    const data = await response.json();

    // Check for Google Maps API errors
    if (data.status === 'REQUEST_DENIED') {
      console.error('🚨 Google Maps API error:', data.error_message);
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ 
          error: 'API request denied. Check API key configuration.',
          details: data.error_message 
        })
      };
    }

    // Return successful response
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      },
      body: JSON.stringify(data)
    };

  } catch (error) {
    console.error('❌ Error calling Google Maps API:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to fetch data from Google Maps',
        message: error.message 
      })
    };
  }
};