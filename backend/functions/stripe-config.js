// Stripe Configuration Endpoint
// Provides public Stripe configuration to the frontend

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Return Stripe public key
  // This should be stored in environment variables
  const publicKey = process.env.STRIPE_PUBLIC_KEY || 'pk_test_YOUR_STRIPE_PUBLIC_KEY';

  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      publicKey: publicKey,
      features: {
        applePay: true,
        googlePay: true,
        saveCards: true
      }
    })
  };
};