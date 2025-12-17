# Spare Labs Integration Implementation Plan

> **Estimated Effort**: 2-3 weeks
> **Prerequisites**: Spare Labs contract signed, sandbox access granted

---

## Phase 1: Database Schema Changes (Day 1)

### Add Spare-Related Columns to Bookings Table

```sql
-- Run in Supabase SQL Editor
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS spare_trip_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS spare_status TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_lat DECIMAL(10,8);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_lng DECIMAL(11,8);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dropoff_lat DECIMAL(10,8);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dropoff_lng DECIMAL(11,8);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_phone TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_vehicle TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_eta TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_location JSONB;

-- Index for Spare webhook lookups
CREATE INDEX IF NOT EXISTS idx_bookings_spare_trip_id ON bookings(spare_trip_id);

-- Spare status values (for reference)
COMMENT ON COLUMN bookings.spare_status IS
  'Values: pending, driver_assigned, en_route, arrived, in_progress, completed, cancelled';
```

---

## Phase 2: Frontend Changes (Days 2-3)

### 2.1 Capture Coordinates at Booking

**File**: `indexMVP.html` (around line 410-440)

Current state object needs coordinates:

```javascript
// CURRENT (incomplete)
this.state = {
    locations: {
        address: null,
        airport: null
    },
    // ...
};

// REQUIRED (add coordinates)
this.state = {
    locations: {
        address: null,
        airport: null
    },
    coordinates: {
        pickup: { lat: null, lng: null },
        dropoff: { lat: null, lng: null }
    },
    // ...
};
```

### 2.2 Store Coordinates from Autocomplete

**File**: `autocomplete.js`

When a place is selected, store the coordinates:

```javascript
// After getting place details, store coordinates
const placeDetails = await getPlaceDetails(placeId);
if (placeDetails.geometry) {
    bookingApp.state.coordinates.pickup = {
        lat: placeDetails.geometry.location.lat,
        lng: placeDetails.geometry.location.lng
    };
}
```

### 2.3 Include Coordinates in Booking Submission

**File**: `indexMVP.html` (booking submission function)

```javascript
// When building booking payload, include coordinates
const bookingPayload = {
    customerName: this.state.guestData?.name || 'Guest',
    phone: this.state.guestData?.phone,
    email: this.state.guestData?.email,
    pickup: this.state.locations.address,
    dropoff: this.state.locations.airport,
    pickupCoords: this.state.coordinates.pickup,  // ADD
    dropoffCoords: this.state.coordinates.dropoff, // ADD
    dateTime: this.state.dateTime.date.toISOString(),
    vehicle: this.state.vehicle.selected,
    price: this.state.vehicle.pricing?.finalPrice,
    passengers: this.state.passengers,
    flightNumber: this.state.flight,
    mode: this.state.mode
};
```

---

## Phase 3: Backend Functions (Days 4-7)

### 3.1 Environment Variables

Add to Netlify environment:

```env
SPARE_API_KEY=your_spare_api_key_here
SPARE_API_URL=https://api.sparelabs.com/v1
SPARE_ORG_ID=your_organization_id
SPARE_WEBHOOK_SECRET=your_webhook_secret
```

### 3.2 Create Spare Dispatch Function

**File**: `backend/functions/spare-dispatch.js`

```javascript
// Spare Labs Trip Creation
// Called after successful payment to dispatch ride

const fetch = require('node-fetch');

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
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Validate Spare API key is configured
    if (!process.env.SPARE_API_KEY) {
        console.error('SPARE_API_KEY not configured');
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Dispatch system not configured' })
        };
    }

    try {
        const booking = JSON.parse(event.body);

        // Map LinkMia vehicle types to Spare vehicle classes
        const vehicleTypeMap = {
            'Tesla Model Y': 'sedan',
            'Cadillac Escalade': 'suv',
            'Mercedes Sprinter': 'van',
            'tesla': 'sedan',
            'escalade': 'suv',
            'sprinter': 'van'
        };

        // Build Spare trip request
        const spareTripRequest = {
            // Rider information
            rider: {
                name: booking.customerName,
                phone: booking.phone,
                email: booking.email
            },

            // Origin (pickup)
            origin: {
                address: booking.pickup,
                latitude: booking.pickupCoords?.lat,
                longitude: booking.pickupCoords?.lng
            },

            // Destination (dropoff)
            destination: {
                address: booking.dropoff,
                latitude: booking.dropoffCoords?.lat,
                longitude: booking.dropoffCoords?.lng
            },

            // Scheduling
            requestedPickupTime: booking.dateTime,

            // Vehicle requirements
            vehicleType: vehicleTypeMap[booking.vehicle] || 'sedan',
            passengerCount: booking.passengers || 1,

            // Fare (pass our pre-calculated price)
            fareEstimate: {
                amount: booking.price,
                currency: 'USD'
            },

            // Notes for driver
            notes: [
                booking.flightNumber ? `Flight: ${booking.flightNumber}` : null,
                booking.pickupNotes || null,
                `Vehicle requested: ${booking.vehicle}`
            ].filter(Boolean).join(' | '),

            // Metadata for linking back to our system
            externalId: booking.bookingId,
            metadata: {
                source: 'linkmia',
                paymentMethod: booking.paymentMethod,
                stripePaymentId: booking.stripePaymentId
            }
        };

        console.log('📤 Sending trip to Spare:', JSON.stringify(spareTripRequest, null, 2));

        // Call Spare API
        const spareResponse = await fetch(`${process.env.SPARE_API_URL}/trips`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.SPARE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(spareTripRequest)
        });

        if (!spareResponse.ok) {
            const errorData = await spareResponse.json();
            console.error('❌ Spare API error:', errorData);
            throw new Error(errorData.message || 'Failed to create trip in Spare');
        }

        const spareTrip = await spareResponse.json();
        console.log('✅ Spare trip created:', spareTrip.id);

        // Update our database with Spare trip ID
        // (This should be done via Supabase)

        return {
            statusCode: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                spareTripId: spareTrip.id,
                status: spareTrip.status,
                estimatedPickup: spareTrip.estimatedPickupTime
            })
        };

    } catch (error) {
        console.error('❌ Spare dispatch error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to dispatch trip',
                message: error.message
            })
        };
    }
};
```

### 3.3 Create Spare Webhook Handler

**File**: `backend/functions/spare-webhook.js`

```javascript
// Spare Labs Webhook Handler
// Receives real-time status updates from Spare

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY // Use service key for admin access
);

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        // Verify webhook signature (if Spare provides one)
        const signature = event.headers['x-spare-signature'];
        if (process.env.SPARE_WEBHOOK_SECRET && signature) {
            // TODO: Implement signature verification
        }

        const payload = JSON.parse(event.body);
        console.log('📥 Spare webhook received:', payload.event, payload.tripId);

        const { event: eventType, tripId, data } = payload;

        // Map Spare events to our status updates
        const statusMap = {
            'trip.created': 'confirmed',
            'trip.driver_assigned': 'assigned',
            'trip.driver_en_route': 'driver_enroute',
            'trip.driver_arrived': 'driver_arrived',
            'trip.started': 'in_progress',
            'trip.completed': 'completed',
            'trip.cancelled': 'cancelled'
        };

        const newStatus = statusMap[eventType];
        if (!newStatus) {
            console.log('⏭️ Ignoring unhandled event type:', eventType);
            return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
        }

        // Build update object
        const updateData = {
            spare_status: newStatus,
            updated_at: new Date().toISOString()
        };

        // Add driver info if assigned
        if (eventType === 'trip.driver_assigned' && data.driver) {
            updateData.driver_name = data.driver.name;
            updateData.driver_phone = data.driver.phone;
            updateData.driver_vehicle = `${data.driver.vehicleMake} ${data.driver.vehicleModel} - ${data.driver.licensePlate}`;
        }

        // Add ETA if available
        if (data.estimatedArrival) {
            updateData.driver_eta = data.estimatedArrival;
        }

        // Add location if available
        if (data.driverLocation) {
            updateData.driver_location = {
                lat: data.driverLocation.latitude,
                lng: data.driverLocation.longitude,
                updatedAt: new Date().toISOString()
            };
        }

        // Update our database
        const { error } = await supabase
            .from('bookings')
            .update(updateData)
            .eq('spare_trip_id', tripId);

        if (error) {
            console.error('❌ Database update failed:', error);
            throw error;
        }

        console.log(`✅ Booking updated: spare_trip_id=${tripId}, status=${newStatus}`);

        // Trigger customer notification for key events
        if (['driver_assigned', 'driver_arrived', 'completed'].includes(newStatus)) {
            await sendCustomerNotification(tripId, newStatus, data);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, status: newStatus })
        };

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Webhook processing failed' })
        };
    }
};

// Send SMS/email notification to customer
async function sendCustomerNotification(tripId, status, data) {
    // TODO: Implement with Twilio
    const messages = {
        'driver_assigned': `Your driver ${data.driver?.name} is on the way in a ${data.driver?.vehicleModel}. ETA: ${data.estimatedArrival}`,
        'driver_arrived': `Your driver has arrived! Look for ${data.driver?.vehicleModel}, plate ${data.driver?.licensePlate}`,
        'completed': 'Thanks for riding with LinkMia! We hope to see you again soon.'
    };

    console.log(`📱 Would send notification: ${messages[status]}`);
}
```

### 3.4 Update Create Booking to Call Spare

**File**: `backend/functions/create-booking.js`

Add Spare dispatch after successful booking:

```javascript
// After saving booking to database, dispatch to Spare
if (process.env.SPARE_API_KEY) {
    try {
        const spareResult = await dispatchToSpare(bookingRecord);

        // Update booking with Spare trip ID
        await supabase
            .from('bookings')
            .update({ spare_trip_id: spareResult.spareTripId })
            .eq('id', bookingId);

        console.log(`🚗 Dispatched to Spare: ${spareResult.spareTripId}`);
    } catch (spareError) {
        console.error('⚠️ Spare dispatch failed, booking saved locally:', spareError);
        // Booking still exists, can retry dispatch manually
    }
}
```

---

## Phase 4: Netlify Configuration (Day 8)

### 4.1 Add Redirect for Webhook

**File**: `netlify.toml`

```toml
# Add Spare webhook endpoint
[[redirects]]
  from = "/api/spare-webhook"
  to = "/.netlify/functions/spare-webhook"
  status = 200

[[redirects]]
  from = "/api/spare-dispatch"
  to = "/.netlify/functions/spare-dispatch"
  status = 200
```

### 4.2 Configure Webhook URL in Spare Dashboard

Register this URL in Spare Admin Panel:
```
https://i-love-miami.netlify.app/api/spare-webhook
```

---

## Phase 5: Customer Tracking Page (Days 9-11)

### 5.1 Create Trip Tracking Page

**File**: `tracking.html` (new file)

Simple page where customers can:
- See current trip status
- View driver info (when assigned)
- See driver location on map (real-time)
- Get ETA updates

### 5.2 Real-time Updates via Supabase

```javascript
// Subscribe to trip updates
const subscription = supabase
    .channel(`booking-${bookingId}`)
    .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'bookings',
        filter: `id=eq.${bookingId}`
    }, (payload) => {
        updateTrackingUI(payload.new);
    })
    .subscribe();
```

---

## Phase 6: Testing Checklist (Days 12-14)

### Sandbox Testing
- [ ] Create trip via API
- [ ] Verify vehicle type mapping
- [ ] Test scheduled (future) pickups
- [ ] Test on-demand pickups
- [ ] Verify webhook events received
- [ ] Test driver assignment flow
- [ ] Test trip cancellation
- [ ] Verify fare passthrough

### Miami-Specific Testing
- [ ] MIA airport coordinates correct
- [ ] FLL airport coordinates correct
- [ ] PBI airport coordinates correct
- [ ] Terminal-specific geofences (if supported)
- [ ] Traffic-based ETA accuracy

### Edge Cases
- [ ] Driver no-show handling
- [ ] Customer cancellation
- [ ] Payment failure after dispatch
- [ ] Webhook endpoint down (retry behavior)
- [ ] All vehicles busy (Open Fleets fallback)

---

## File Summary

### New Files to Create
| File | Purpose |
|------|---------|
| `backend/functions/spare-dispatch.js` | Send trips to Spare API |
| `backend/functions/spare-webhook.js` | Receive status updates |
| `tracking.html` | Customer trip tracking page |

### Files to Modify
| File | Changes |
|------|---------|
| `indexMVP.html` | Add coordinates to state, include in booking |
| `autocomplete.js` | Store lat/lng when place selected |
| `backend/functions/create-booking.js` | Call Spare after booking created |
| `netlify.toml` | Add webhook redirect |
| `database/linkmia-schema.sql` | Add Spare columns |

### Environment Variables to Add
| Variable | Purpose |
|----------|---------|
| `SPARE_API_KEY` | Authentication with Spare |
| `SPARE_API_URL` | Spare API endpoint |
| `SPARE_ORG_ID` | Your Spare organization |
| `SPARE_WEBHOOK_SECRET` | Webhook signature verification |
| `SUPABASE_SERVICE_KEY` | Admin access for webhooks |

---

## Go-Live Checklist

- [ ] Spare contract signed
- [ ] Production API key obtained
- [ ] Webhook URL registered in Spare
- [ ] Open Fleets configured (Uber/taxi backup)
- [ ] Driver tablets procured and tested
- [ ] Miami airport geofences configured
- [ ] Customer notification templates approved
- [ ] Support escalation process defined
- [ ] Monitoring/alerting configured
