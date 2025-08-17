// supabase-config.js
// Browser-compatible Supabase configuration

// Get configuration from window.APP_CONFIG or use defaults
const getSupabaseConfig = () => {
    // Try to use centralized config first
    if (window.APP_CONFIG) {
        return {
            url: window.APP_CONFIG.SUPABASE_URL || 'https://hncpybxwblpkyxvskoxd.supabase.co',
            anonKey: window.APP_CONFIG.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuY3B5Ynh3Ymxwa3l4dnNrb3hkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNDE5MDIsImV4cCI6MjA3MDcxNzkwMn0.aXmiOWS1FVxBaQMXoenoTdUlbOFYuYTLVc-tD3FnheA'
        };
    }
    
    // Fallback to direct values
    return {
        url: 'https://hncpybxwblpkyxvskoxd.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuY3B5Ynh3Ymxwa3l4dnNrb3hkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxNDE5MDIsImV4cCI6MjA3MDcxNzkwMn0.aXmiOWS1FVxBaQMXoenoTdUlbOFYuYTLVc-tD3FnheA'
    };
};

const config = getSupabaseConfig();

// Check if credentials are configured
if (config.url.includes('YOUR_PROJECT_ID') || config.anonKey === 'your-anon-key-here') {
    console.warn('⚠️ Supabase credentials not configured. Database features will not work.')
    console.warn('Please set SUPABASE_URL and SUPABASE_ANON_KEY in your environment.')
}

// Create a single supabase client for interacting with your database
// Using the global window.supabase from the CDN
if (typeof window !== 'undefined' && window.supabase) {
    window.supabaseClient = window.supabase.createClient(config.url, config.anonKey);
}

// Auth helper functions
window.auth = {
  // Get current user
  getUser: async () => {
    const { data: { user } } = await window.supabaseClient.auth.getUser()
    return user
  },

  // Get current session
  getSession: async () => {
    const { data: { session } } = await window.supabaseClient.auth.getSession()
    return session
  },

  // Sign out
  signOut: async () => {
    const { error } = await window.supabaseClient.auth.signOut()
    if (error) throw error
    window.location.href = '/dev/templates/LandingLOGIN.html' // Redirect to landing page
  },

  // Listen to auth changes
  onAuthStateChange: (callback) => {
    return window.supabaseClient.auth.onAuthStateChange(callback)
  }
}

// Database helper functions
window.db = {
  // Create a new trip
  createTrip: async (tripData) => {
    const user = await auth.getUser()
    if (!user) throw new Error('User not authenticated')

    const { data, error } = await window.supabaseClient
      .from('trips')
      .insert([{
        user_id: user.id,
        pickup_address: tripData.pickup_address,
        pickup_coordinates: tripData.pickup_coordinates,
        dropoff_airport: tripData.dropoff_airport,
        vehicle_type: tripData.vehicle_type,
        scheduled_time: tripData.scheduled_time,
        price: tripData.price,
        price_breakdown: tripData.price_breakdown,
        passenger_count: tripData.passenger_count,
        pickup_notes: tripData.pickup_notes,
        flight_number: tripData.flight_number,
        status: 'scheduled'
      }])
      .select()
      .single()

    if (error) throw error
    return data
  },

  // Get user's trips
  getUserTrips: async (limit = 10) => {
    const user = await auth.getUser()
    if (!user) throw new Error('User not authenticated')

    const { data, error } = await window.supabaseClient
      .from('trips')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error
    return data
  },

  // Get single trip
  getTrip: async (tripId) => {
    const { data, error } = await window.supabaseClient
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single()

    if (error) throw error
    return data
  },

  // Update trip status
  updateTripStatus: async (tripId, status) => {
    const { data, error } = await window.supabaseClient
      .from('trips')
      .update({ status })
      .eq('id', tripId)
      .select()
      .single()

    if (error) throw error
    return data
  },

  // Subscribe to trip updates
  subscribeToTrip: (tripId, callback) => {
    return window.supabaseClient
      .channel(`trip-${tripId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trips',
          filter: `id=eq.${tripId}`
        },
        (payload) => callback(payload)
      )
      .subscribe()
  }
}

// Real-time helper functions
window.realtime = {
  // Subscribe to driver location
  subscribeToDriverLocation: (tripId, callback) => {
    return window.supabaseClient
      .channel(`driver-location-${tripId}`)
      .on('broadcast', { event: 'location' }, ({ payload }) => {
        callback(payload)
      })
      .subscribe()
  },

  // Broadcast driver location (for driver app)
  broadcastDriverLocation: async (tripId, location) => {
    const channel = window.supabaseClient.channel(`driver-location-${tripId}`)
    await channel.send({
      type: 'broadcast',
      event: 'location',
      payload: location
    })
  }
}