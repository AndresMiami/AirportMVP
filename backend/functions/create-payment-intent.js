// Stripe Payment Intent Creation
// Secure server-side payment processing

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Check if Stripe is configured
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Stripe secret key not configured');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Payment system not configured',
        message: 'Please configure Stripe in environment variables' 
      })
    };
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    const { 
      amount, 
      currency = 'usd',
      bookingId,
      customerEmail,
      customerName,
      metadata = {}
    } = JSON.parse(event.body);

    // Validate amount
    if (!amount || amount < 50) { // Stripe minimum is $0.50
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Invalid amount',
          message: 'Amount must be at least $0.50' 
        })
      };
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        bookingId: bookingId || 'N/A',
        customerName: customerName || 'Guest',
        customerEmail: customerEmail || 'N/A',
        ...metadata
      },
      description: `Airport transfer booking ${bookingId || ''}`,
      receipt_email: customerEmail
    });

    console.log(`💳 Payment intent created: ${paymentIntent.id} for $${amount}`);

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
        amount: amount,
        currency: currency
      })
    };

  } catch (error) {
    console.error('❌ Stripe error:', error);
    
    // Handle specific Stripe errors
    let errorMessage = 'Payment processing failed';
    if (error.type === 'StripeCardError') {
      errorMessage = error.message;
    } else if (error.type === 'StripeInvalidRequestError') {
      errorMessage = 'Invalid payment request';
    }

    return {
      statusCode: error.statusCode || 500,
      headers,
      body: JSON.stringify({ 
        error: errorMessage,
        type: error.type,
        message: error.message 
      })
    };
  }
};