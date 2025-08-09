// Stripe Payment Intent Creation Function
// Securely creates payment intents without exposing Stripe secret key

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Check if Stripe key exists
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    console.error('❌ Stripe secret key not configured');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment system not configured' })
    };
  }

  try {
    // Parse request
    const { amount, bookingId, customerEmail, description, metadata } = JSON.parse(event.body);

    // Validate amount
    if (!amount || amount < 50) { // Stripe minimum is $0.50
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid payment amount (minimum $50)' })
      };
    }

    // Initialize Stripe
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    
    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert dollars to cents
      currency: 'usd',
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        bookingId: bookingId || 'N/A',
        source: 'i-love-miami-booking',
        ...metadata // Allow additional metadata
      },
      description: description || 'Airport Transfer Booking - I Love Miami',
      receipt_email: customerEmail || undefined,
      // Optional: Add statement descriptor
      statement_descriptor_suffix: 'I LOVE MIA'
    });

    console.log(`💳 Payment intent created: ${paymentIntent.id} for $${amount}`);

    // Return client secret for frontend
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount / 100,
        status: paymentIntent.status
      })
    };

  } catch (error) {
    console.error('❌ Stripe error:', error);
    
    // Handle specific Stripe errors
    if (error.type === 'StripeCardError') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Card error',
          message: error.message 
        })
      };
    }

    if (error.type === 'StripeInvalidRequestError') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Invalid request',
          message: 'Please check your payment details' 
        })
      };
    }

    // Generic error
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Payment processing failed',
        message: 'Please try again or contact support'
      })
    };
  }
};