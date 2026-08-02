// Secure Booking Creation with Supabase Persistence + Telegram doorbell ping
// IMPORTANT: Supabase insert happens FIRST, the doorbell only fires on success.
// All dispatch actions (accept/decline/status) happen on the driver page.

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
    // Category stored in vehicle_type; exact display name goes to vehicle_name.
    // All Escalade variants categorize as 'suv' per Andres's preference.
    const vehicleTypeMap = {
      'Sedan': 'sedan',
      'sedan': 'sedan',
      'Tesla Model Y': 'sedan',
      'SUV': 'suv',
      'suv': 'suv',
      'Escalade': 'suv',
      'escalade': 'suv',
      'Black Escalade': 'suv',
      'Cadillac Escalade': 'suv',
      'Sprinter': 'sprinter',
      'sprinter': 'sprinter',
      'Mercedes Sprinter': 'sprinter'
    };
    const vehicleType = vehicleTypeMap[booking.vehicle] || 'sedan';

    // Booker info is stored only when someone books on behalf of another
    // passenger — customer_* is always the person the driver picks up.
    const isBookerDifferent = booking.bookerName &&
      booking.bookerName !== booking.customerName;

    // Build the database record
    const bookingRecord = {
      customer_name: booking.customerName,
      customer_phone: booking.phone,
      customer_email: booking.email || null,
      booker_name: isBookerDifferent ? booking.bookerName : null,
      booker_phone: isBookerDifferent ? (booking.bookerPhone || null) : null,
      pickup_location: booking.pickup,
      dropoff_location: booking.dropoff,
      pickup_datetime: pickupDatetime,
      passengers: parseInt(booking.passengers) || 1,
      bags: parseInt(booking.bags) || 0,
      vehicle_type: vehicleType,
      vehicle_name: booking.vehicle || null,
      price: parseFloat(booking.price) || 0,
      status: 'pending',
      payment_method: booking.paymentMethod || 'cash',
      payment_status: 'unpaid',
      flight_number: booking.flightNumber || null,
      trip_id: booking.tripId || null,
      notes: booking.notes || null,
      pickup_sign: booking.pickupSign || null,
      promo_code: booking.promoCode || null,
      booking_mode: booking.mode || null,
      duration_minutes: parseInt(booking.durationMinutes) || null,
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

    // Plain-text "doorbell" ping — all dispatch actions happen on the driver page
    const siteUrl = process.env.URL || 'https://i-love-miami.netlify.app';
    const doorbell = `🆕 New ride ${tripId} — ${isToday ? 'TODAY' : formattedDate} at ${formattedTime}${isUrgent ? ' (URGENT <2h)' : ''}
${booking.pickup} → ${booking.dropoff}
$${booking.price} | ${booking.vehicle} | ${booking.passengers || 1} pax
Open driver page: ${siteUrl}/driver`;

    let telegramSent = false;
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.ADMIN_TELEGRAM_CHAT_ID) {
      try {
        const telegramResponse = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.ADMIN_TELEGRAM_CHAT_ID,
            text: doorbell
          })
        });

        if (telegramResponse.ok) {
          console.log(`📱 Doorbell sent for booking #${tripId}`);
          telegramSent = true;
        } else {
          const errorData = await telegramResponse.json();
          console.error('⚠️ Doorbell failed:', errorData);
          // Continue - database save was successful
        }
      } catch (telegramError) {
        console.error('⚠️ Doorbell error:', telegramError.message);
        // Continue - database save was successful
      }
    } else {
      console.warn('⚠️ Telegram not configured - skipping doorbell');
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
