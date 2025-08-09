// Secure Server-Side Pricing Calculation
// Prevents price manipulation by keeping logic hidden

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
    const { distance, duration, vehicleType, dateTime, passengers = 1 } = JSON.parse(event.body);

    // Validate inputs
    if (!distance || !duration || !vehicleType) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required parameters: distance, duration, vehicleType' })
      };
    }

    // Server-side vehicle configuration (NEVER expose to client!)
    const vehicleConfig = {
      tesla: {
        name: 'Tesla Model Y',
        pricePerMile: 3.25,
        airportFee: 10,
        hourlyProtection: 100,
        basePrice: 132,
        capacity: { passengers: 4, bags: 4 }
      },
      escalade: {
        name: 'Cadillac Escalade',
        pricePerMile: 4.50,
        airportFee: 15,
        hourlyProtection: 125,
        basePrice: 165,
        capacity: { passengers: 7, bags: 8 }
      },
      sprinter: {
        name: 'Mercedes Sprinter',
        pricePerMile: 6.25,
        airportFee: 25,
        hourlyProtection: 150,
        basePrice: 220,
        capacity: { passengers: 12, bags: 15 }
      }
    };

    const vehicle = vehicleConfig[vehicleType];
    if (!vehicle) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid vehicle type' })
      };
    }

    // Check capacity
    if (passengers > vehicle.capacity.passengers) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Vehicle capacity exceeded',
          maxCapacity: vehicle.capacity.passengers,
          requested: passengers
        })
      };
    }

    // Calculate base price
    const perMilePrice = (distance * vehicle.pricePerMile) + vehicle.airportFee;
    const durationHours = duration / 60;
    const hourlyPrice = durationHours * vehicle.hourlyProtection;
    
    // Use higher price (protection model)
    let basePrice = Math.max(perMilePrice, hourlyPrice);
    let finalPrice = basePrice;
    let appliedSurcharges = [];

    // Apply time-based surcharges
    if (dateTime) {
      const tripDate = new Date(dateTime);
      const hour = tripDate.getHours();
      const dayOfWeek = tripDate.getDay();

      // Night surcharge (10pm - 6am): 15%
      if (hour >= 22 || hour < 6) {
        const surcharge = basePrice * 0.15;
        finalPrice += surcharge;
        appliedSurcharges.push({
          type: 'night',
          description: 'Night service (10pm-6am)',
          rate: 1.15,
          amount: Math.round(surcharge)
        });
      }

      // Weekend surcharge (Sat & Sun): 10%
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        const surcharge = basePrice * 0.10;
        finalPrice += surcharge;
        appliedSurcharges.push({
          type: 'weekend',
          description: 'Weekend service',
          rate: 1.10,
          amount: Math.round(surcharge)
        });
      }

      // Rush hour surcharge (7-9am, 5-7pm): 20%
      if ((hour >= 7 && hour < 9) || (hour >= 17 && hour < 19)) {
        const surcharge = basePrice * 0.20;
        finalPrice += surcharge;
        appliedSurcharges.push({
          type: 'rush',
          description: hour < 12 ? 'Morning rush (7-9am)' : 'Evening rush (5-7pm)',
          rate: 1.20,
          amount: Math.round(surcharge)
        });
      }
    }

    // Round final price
    finalPrice = Math.round(finalPrice);

    console.log(`💰 Price calculated: $${finalPrice} for ${vehicleType} (${distance}mi, ${duration}min)`);

    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        vehicleType,
        vehicleName: vehicle.name,
        distance,
        duration,
        passengers,
        basePrice: Math.round(basePrice),
        finalPrice,
        breakdown: {
          perMileRate: vehicle.pricePerMile,
          perMileTotal: Math.round(perMilePrice),
          hourlyRate: vehicle.hourlyProtection,
          hourlyTotal: Math.round(hourlyPrice),
          airportFee: vehicle.airportFee,
          protectionUsed: hourlyPrice > perMilePrice ? 'hourly' : 'mileage',
          surcharges: appliedSurcharges
        },
        capacity: vehicle.capacity
      })
    };

  } catch (error) {
    console.error('❌ Pricing calculation error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to calculate price',
        message: error.message 
      })
    };
  }
};