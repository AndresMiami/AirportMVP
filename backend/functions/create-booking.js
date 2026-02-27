// Secure Booking Creation with Supabase Persistence + Telegram Notification
// IMPORTANT: Supabase insert happens FIRST, Telegram only fires on success

const { createClient } = require('@supabase/supabase-js');

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

  // ============================================
  // INITIALIZE SUPABASE CLIENT
  // ============================================
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Missing Supabase configuration');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error - missing database credentials' })
    };
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const booking = JSON.parse(event.body);

    // Validate required fields
    const requiredFields = [
      'customerName', 'phone', 'pickup', 'dropoff',
      'dateTime', 'vehicle', 'price', 'mode'
    ];

    const missingFields = requiredFields.filter(field => !booking[field]);
    if (missingFields.length > 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields',
          missing: missingFields
        })
      };
    }

    // Parse and format datetime
    const tripDate = new Date(booking.dateTime);
    const pickupDatetime = tripDate.toISOString();

    // Map vehicle name to database enum
    const vehicleTypeMap = {
      'Sedan': 'sedan',
      'sedan': 'sedan',
      'SUV': 'suv',
      'suv': 'suv',
      'Escalade': 'escalade',
      'escalade': 'escalade',
      'Black Escalade': 'escalade',
      'Sprinter': 'sprinter',
      'sprinter': 'sprinter',
      'Mercedes Sprinter': 'sprinter'
    };
    const vehicleType = vehicleTypeMap[booking.vehicle] || 'sedan';

    // Build the database record
    const bookingRecord = {
      customer_name: booking.customerName,
      customer_phone: booking.phone,
      pickup_location: booking.pickup,
      dropoff_location: booking.dropoff,
      pickup_datetime: pickupDatetime,
      passengers: parseInt(booking.passengers) || 1,
      bags: parseInt(booking.bags) || 0,
      vehicle_type: vehicleType,
      price: parseFloat(booking.price) || 0,
      status: 'pending',
      payment_method: booking.paymentMethod || 'telegram',
      payment_status: 'unpaid',
      flight_number: booking.flightNumber || null,
      notes: booking.tripId
        ? `Website booking ${booking.tripId}. ${booking.notes || ''}`
        : (booking.notes || null),
      source: 'website'
    };

    // ============================================
    // STEP 1: INSERT TO SUPABASE (MUST SUCCEED)
    // ============================================
    const { data: insertedBooking, error: insertError } = await supabase
      .from('bookings')
      .insert([bookingRecord])
      .select()
      .single();

    if (insertError) {
      console.error('❌ Supabase insert failed:', insertError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Failed to save booking to database',
          details: insertError.message,
          code: insertError.code
        })
      };
    }

    console.log(`✅ Booking saved to Supabase: ${insertedBooking.id}`);

    // ============================================
    // STEP 2: SEND TELEGRAM (ONLY AFTER SUCCESS)
    // ============================================
    const tripId = booking.tripId || `B${Date.now().toString().slice(-4)}`;
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    // Format date and time for display
    const formattedDate = tripDate.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
    const formattedTime = tripDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    // Calculate urgency
    const isToday = new Date().toDateString() === tripDate.toDateString();
    const isUrgent = (tripDate - new Date()) < (2 * 60 * 60 * 1000); // Less than 2 hours

    // Format Telegram message for admin review
    const telegramMessage = `🆕 NEW BOOKING #${tripId}
━━━━━━━━━━━━━━━━━━━
👤 Name: ${booking.customerName}
📱 Phone: ${booking.phone}
${booking.email ? `✉️ Email: ${booking.email}` : ''}

🚗 TYPE: ${booking.mode === 'dropoff' ? 'To Airport ✈️' : 'From Airport 🛬'}
📍 From: ${booking.pickup}
✈️ To: ${booking.dropoff}
🕐 When: ${isToday ? '📅 TODAY' : formattedDate} at ${formattedTime}
${isUrgent ? '⚡ URGENT - Less than 2 hours!' : ''}

💵 Price: $${booking.price}
🚘 Vehicle: ${booking.vehicle}
👥 Passengers: ${booking.passengers || 1}
${booking.flightNumber ? `✈️ Flight: ${booking.flightNumber}` : ''}

${booking.notes ? `📝 Notes: "${booking.notes}"` : ''}
💳 Payment: ${booking.paymentMethod || 'Telegram'}

📊 Database ID: ${insertedBooking.id}
🕐 Received: ${timestamp}`;

    // Send Telegram notification to admin
    let telegramSent = false;
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.ADMIN_TELEGRAM_CHAT_ID) {
      const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

      // Inline keyboard for quick actions
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve_${insertedBooking.id}` },
            { text: '❌ Reject', callback_data: `reject_${insertedBooking.id}` }
          ],
          [
            { text: '📞 Call Customer', url: `tel:${booking.phone}` }
          ]
        ]
      };

      try {
        const telegramResponse = await fetch(telegramApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.ADMIN_TELEGRAM_CHAT_ID,
            text: telegramMessage,
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard
          })
        });

        if (telegramResponse.ok) {
          console.log(`📱 Telegram notification sent for booking #${tripId}`);
          telegramSent = true;
        } else {
          const errorData = await telegramResponse.json();
          console.error('⚠️ Telegram notification failed:', errorData);
          // Continue - database save was successful
        }
      } catch (telegramError) {
        console.error('⚠️ Telegram error:', telegramError.message);
        // Continue - database save was successful
      }
    } else {
      console.warn('⚠️ Telegram not configured - skipping notification');
    }

    // Return success response with database ID
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        bookingId: insertedBooking.id,  // Supabase UUID
        tripId: tripId,                  // Display ID (LM-XXXX)
        message: 'Booking saved successfully',
        telegramSent: telegramSent,
        urgent: isUrgent
      })
    };

  } catch (error) {
    console.error('❌ Booking error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to create booking',
        message: error.message
      })
    };
  }
};
