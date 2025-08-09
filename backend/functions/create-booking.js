// Secure Booking Creation with WhatsApp Notification
// Handles bookings and sends formatted WhatsApp alerts

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

    // Format WhatsApp message for admin review
    const whatsappMessage = `🆕 BOOKING RECEIVED #${bookingId}
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
💳 Payment: ${booking.paymentMethod || 'Card'}

━━━━━━━━━━━━━━━━━━━
📋 TO APPROVE: Type "POST ${bookingId}"
❌ TO REJECT: Type "REJECT ${bookingId} [reason]"
🔍 TO VERIFY: Type "CHECK ${bookingId}"`;

    // Send WhatsApp notification (via Twilio or WhatsApp Business API)
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const client = require('twilio')(accountSid, authToken);

      try {
        await client.messages.create({
          body: whatsappMessage,
          from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
          to: `whatsapp:${process.env.ADMIN_WHATSAPP_NUMBER}`
        });
        console.log(`📱 WhatsApp notification sent for booking #${bookingId}`);
      } catch (twilioError) {
        console.error('❌ Twilio error:', twilioError);
        // Continue processing even if WhatsApp fails
      }
    }

    // Send email backup (using SendGrid or similar)
    if (process.env.SENDGRID_API_KEY) {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #FF5733;">New Booking #${bookingId}</h1>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Customer:</strong></td>
              <td style="padding: 10px; border-bottom: 1px solid #eee;">${booking.customerName}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Phone:</strong></td>
              <td style="padding: 10px; border-bottom: 1px solid #eee;">${booking.phone}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Route:</strong></td>
              <td style="padding: 10px; border-bottom: 1px solid #eee;">${booking.pickup} → ${booking.dropoff}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Time:</strong></td>
              <td style="padding: 10px; border-bottom: 1px solid #eee;">${formattedDate} ${formattedTime}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Price:</strong></td>
              <td style="padding: 10px; border-bottom: 1px solid #eee;">$${booking.price}</td>
            </tr>
          </table>
          <div style="margin-top: 20px; padding: 20px; background: #f5f5f5; border-radius: 8px;">
            <p><strong>WhatsApp Message:</strong></p>
            <pre style="white-space: pre-wrap; font-family: monospace; font-size: 12px;">${whatsappMessage}</pre>
          </div>
        </div>
      `;

      try {
        const sgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            personalizations: [{
              to: [{ email: process.env.ADMIN_EMAIL || 'admin@ilovemiami.com' }]
            }],
            from: { 
              email: 'bookings@ilovemiami.com',
              name: 'I Love Miami Bookings'
            },
            subject: `${isUrgent ? '🔴 URGENT' : '🆕 New'} Booking #${bookingId} - ${booking.customerName}`,
            content: [{
              type: 'text/html',
              value: emailHtml
            }]
          })
        });

        if (!sgResponse.ok) {
          console.error('SendGrid error:', await sgResponse.text());
        }
      } catch (emailError) {
        console.error('Email error:', emailError);
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