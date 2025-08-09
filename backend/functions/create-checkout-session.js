// Stripe Checkout Session Creation
// Creates a checkout session for redirecting to Stripe's hosted payment page

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
      metadata = {},
      successUrl,
      cancelUrl
    } = JSON.parse(event.body);

    // Validate amount
    if (!amount || amount < 0.50) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Invalid amount',
          message: 'Amount must be at least $0.50' 
        })
      };
    }

    // Create line items for the session
    const lineItems = [{
      price_data: {
        currency: currency,
        product_data: {
          name: 'LuxeRide Airport Transfer',
          description: `Booking ID: ${bookingId}`,
          metadata: {
            bookingId: bookingId
          }
        },
        unit_amount: Math.round(amount * 100), // Convert to cents
      },
      quantity: 1,
    }];

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'apple_pay', 'google_pay'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl || `${process.env.URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.URL}/cancel`,
      customer_email: customerEmail,
      metadata: {
        bookingId: bookingId || 'N/A',
        customerName: customerName || 'Guest',
        ...metadata
      },
      payment_intent_data: {
        metadata: {
          bookingId: bookingId || 'N/A',
          customerName: customerName || 'Guest',
          ...metadata
        }
      },
      // Enable Apple Pay and Google Pay
      payment_method_options: {
        card: {
          request_three_d_secure: 'automatic'
        }
      },
      // Customer information collection
      billing_address_collection: 'auto',
      shipping_address_collection: {
        allowed_countries: ['US']
      }
    });

    console.log(`💳 Checkout session created: ${session.id} for $${amount}`);

    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        sessionId: session.id,
        url: session.url
      })
    };

  } catch (error) {
    console.error('❌ Stripe error:', error);
    
    let errorMessage = 'Payment session creation failed';
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