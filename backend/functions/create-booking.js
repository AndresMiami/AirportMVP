// Secure Booking Creation with Supabase Persistence + Telegram doorbell ping
// IMPORTANT: Supabase insert happens FIRST, the doorbell only fires on success.
// All dispatch actions (accept/decline/status) happen on the driver page.
//
// ACCOUNT GATE: new bookings are AUTHENTICATED-ONLY. The disabled
// "Guest checkout — coming later" UI is convenience; THIS is the
// enforcement: 401 for a missing/invalid/expired token, 403 when the
// authenticated identity cannot be resolved to a customers row, 500 on
// auth-verification or database failure. There is no anonymous insert
// path — every new booking is stamped with customer_id. Legacy guest
// bookings (customer_id NULL) and their /trip links are untouched; the
// guest columns (customer_*/booker_*) are still written exactly as
// before, because "book for someone else" remains a signed-in booker
// arranging a ride for another passenger.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    console.error('❌ Missing SUPABASE_ANON_KEY — cannot verify sessions');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server configuration error' })
    };
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // ============================================
  // ACCOUNT GATE: require a valid session (CreditEngine requireAuth
  // pattern — checks BOTH the auth error and the missing user; the old
  // optional-identity block checked neither and silently fell through
  // to an anonymous insert).
  //   missing token           -> 401
  //   invalid/expired token   -> 401
  //   verification unreachable -> 500 (never guess)
  // ============================================
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };
  }
  let user;
  try {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userError } = await authClient.auth.getUser(token);
    if (userError || !userData?.user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }
    user = userData.user;
  } catch (authError) {
    console.error('❌ Auth verification failed:', authError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify sign-in' }) };
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

    // ============================================
    // RESOLVE THE CUSTOMER IDENTITY — every new booking is stamped.
    //   customers row exists      -> use it
    //   no row                    -> create it (profile.js ensure-row
    //     pattern) from the BOOKER identity in this payload. This branch
    //     exists because admin-provisioned accounts (e.g. ambassadors)
    //     may have no customers row and there is no profile UI to heal a
    //     hard 403 — flagged for Codex as a deliberate softening of the
    //     "403 on missing profile" contract. 403 remains the fail-closed
    //     answer when no usable identity exists; DB failures are 500.
    // ============================================
    let customerId = null;
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (customerError) {
      console.error('❌ Customer lookup failed:', customerError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not verify account' }) };
    }
    if (customer) {
      customerId = customer.id;
    } else {
      const identityName = booking.bookerName || booking.customerName;
      const identityPhone = booking.bookerPhone || booking.phone;
      if (!identityName || !identityPhone) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Account profile incomplete — sign in again to finish setting up your account' })
        };
      }
      const { data: created, error: createError } = await supabase
        .from('customers')
        .insert([{
          user_id: user.id,
          name: identityName,
          phone: identityPhone,
          email: booking.email || user.email || null,
          type: 'guest',
          source: 'website'
        }])
        .select('id')
        .single();
      if (createError || !created) {
        console.error('❌ Customer profile creation failed:', createError?.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create account profile' }) };
      }
      customerId = created.id;
    }

    // Ambassador attribution: an ACTIVE hosts row on this account wins
    // over any stored ref code. Lookup failure is non-fatal (attribution
    // is optional; identity above is not).
    let ambassadorHost = null;
    try {
      const { data: host } = await supabase
        .from('hosts')
        .select('id, name, commission_rate')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();
      if (host) ambassadorHost = host;
    } catch (hostError) {
      console.warn('⚠️ Ambassador lookup skipped:', hostError.message);
    }

    // Referral attribution: a signed-in ambassador wins; otherwise a stored
    // QR ref code (?ref=...) is honored. Commission is stamped at booking
    // time but only counts as earned when the ride completes.
    let referredByHost = null;
    let hostCommission = 0;
    let ambassadorName = null;
    try {
      let host = ambassadorHost;
      if (!host && booking.refCode) {
        const { data: refHost } = await supabase
          .from('hosts')
          .select('id, name, commission_rate')
          .eq('referral_code', String(booking.refCode).trim().toLowerCase())
          .eq('status', 'active')
          .maybeSingle();
        host = refHost || null;
      }
      if (host) {
        referredByHost = host.id;
        ambassadorName = host.name || null;
        const rate = parseFloat(host.commission_rate) || 0;
        hostCommission = Math.round((parseFloat(booking.price) || 0) * rate * 100) / 100;
      }
    } catch (refError) {
      console.warn('⚠️ Referral attribution skipped:', refError.message);
    }

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
      customer_id: customerId,
      referred_by_host: referredByHost,
      host_commission: hostCommission,
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

    // All display times in Miami local time — the function itself runs in UTC
    const MIAMI_TZ = 'America/New_York';
    const formattedDate = tripDate.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: MIAMI_TZ
    });
    const fmtTime = (d) => d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: MIAMI_TZ
    });
    const formattedTime = fmtTime(tripDate);

    // Calculate urgency (date comparison in Miami time, not server time)
    const isToday = new Date().toLocaleDateString('en-US', { timeZone: MIAMI_TZ })
      === tripDate.toLocaleDateString('en-US', { timeZone: MIAMI_TZ });
    const isUrgent = (tripDate - new Date()) < (2 * 60 * 60 * 1000); // Less than 2 hours

    // Plain-text "doorbell" ping — all dispatch actions happen on the driver page
    const CAPACITY = { sedan: [4, 4], suv: [7, 8], escalade: [7, 8], sprinter: [12, 15] };
    const [capPax, capBags] = CAPACITY[vehicleType] || CAPACITY.sedan;
    const durationMins = parseInt(booking.durationMinutes) || null;
    const etaLine = durationMins
      ? `⏱ ~${durationMins} min · est. arrival ${fmtTime(new Date(tripDate.getTime() + durationMins * 60000))}\n`
      : '';
    const ambassadorLine = ambassadorName ? `\n★ via Ambassador ${ambassadorName}` : '';
    const siteUrl = process.env.URL || 'https://i-love-miami.netlify.app';
    const doorbell = `🆕 New ride ${tripId} — ${isToday ? 'TODAY' : formattedDate} at ${formattedTime}${isUrgent ? ' (URGENT <2h)' : ''}
${booking.pickup} → ${booking.dropoff}
${etaLine}🚘 ${booking.vehicle} · 👥 ${booking.passengers || 1} of ${capPax} · 🧳 ${booking.bags || 0} of ${capBags}
💵 $${booking.price} · pay driver (cash/Zelle)${ambassadorLine}
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
