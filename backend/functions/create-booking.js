// Secure Booking Creation with Telegram Notification
// Handles bookings and sends formatted Telegram alerts to admin

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

    // Generate booking ID
    const bookingId = `B${Date.now().toString().slice(-4)}`;
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    
    // Format date and time
    const tripDate = new Date(booking.dateTime);
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

    // Calculate trip timing
    const isToday = new Date().toDateString() === tripDate.toDateString();
    const isUrgent = (tripDate - new Date()) < (2 * 60 * 60 * 1000); // Less than 2 hours

    // Format Telegram message for admin review
    const telegramMessage = `🆕 BOOKING RECEIVED #${bookingId}
━━━━━━━━━━━━━━━━━━━
👤 Name: ${booking.customerName}
📱 Phone: ${booking.phone}
${booking.email ? `✉️ Email: ${booking.email}` : ''}

🚗 TYPE: ${booking.mode === 'dropoff' ? 'To Airport' : 'From Airport'}
📍 From: ${booking.pickup}
✈️ To: ${booking.dropoff}
🕐 When: ${isToday ? 'Today' : formattedDate} ${formattedTime}
${isUrgent ? '⚡ URGENT - Less than 2 hours!' : ''}

💵 Quote: $${booking.price}
🚘 Vehicle: ${booking.vehicle}
👥 Pax: ${booking.passengers || 1}${booking.childSeats ? ` + ${booking.childSeats} child seat(s)` : ''}
${booking.flightNumber ? `✈️ Flight: ${booking.flightNumber}` : ''}

${booking.notes ? `✍️ Notes: "${booking.notes}"` : ''}
💳 Payment: ${booking.paymentMethod || 'Card'}`;

    // Send Telegram notification to admin with inline keyboard
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.ADMIN_TELEGRAM_CHAT_ID) {
      const telegramApiUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

      // Inline keyboard for quick approve/reject
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve_${bookingId}` },
            { text: '❌ Reject', callback_data: `reject_${bookingId}` }
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
          console.log(`📱 Telegram notification sent for booking #${bookingId}`);
        } else {
          const errorData = await telegramResponse.json();
          console.error('❌ Telegram error:', errorData);
        }
      } catch (telegramError) {
        console.error('❌ Telegram error:', telegramError);
        // Continue processing even if Telegram fails
      }
    }

    // Store booking data (you can add Supabase integration here)
    const bookingRecord = {
      id: bookingId,
      ...booking,
      status: 'pending_review',
      createdAt: timestamp,
      isUrgent
    };

    console.log(`✅ Booking #${bookingId} created successfully`);

    // Return success response
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        bookingId: bookingId,
        message: 'Booking received and sent for review',
        urgent: isUrgent,
        reviewRequired: true
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