// supabase-config.js
// Create this file in your project root

import { createClient } from '@supabase/supabase-js'

// Supabase configuration from environment or window variables
// In production, these should be injected by your build process or backend
const SUPABASE_URL = window.SUPABASE_URL || 'https://YOUR_PROJECT_ID.supabase.co'
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'your-anon-key-here'

// Check if credentials are configured
if (SUPABASE_URL.includes('YOUR_PROJECT_ID') || SUPABASE_ANON_KEY === 'your-anon-key-here') {
    console.warn('⚠️ Supabase credentials not configured. Database features will not work.')
    console.warn('Please set SUPABASE_URL and SUPABASE_ANON_KEY in your environment.')
}

// Create a single supabase client for interacting with your database
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Auth helper functions
export const auth = {
  // Get current user
  getUser: async () => {
    const { data: { user } } = await supabase.auth.getUser()
    return user
  },

  // Get current session
  getSession: async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session
  },

  // Sign out
  signOut: async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    window.location.href = '/index.html' // Redirect to landing page
  },

  // Listen to auth changes
  onAuthStateChange: (callback) => {
    return supabase.auth.onAuthStateChange(callback)
  }
}

// Database helper functions
export const db = {
  // Create a new trip
  createTrip: async (tripData) => {
    const user = await auth.getUser()
    if (!user) throw new Error('User not authenticated')

    const { data, error } = await supabase
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

    const { data, error } = await supabase
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
    const { data, error } = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single()

    if (error) throw error
    return data
  },

  // Update trip status
  updateTripStatus: async (tripId, status) => {
    const { data, error } = await supabase
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
    return supabase
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
export const realtime = {
  // Subscribe to driver location
  subscribeToDriverLocation: (tripId, callback) => {
    return supabase
      .channel(`driver-location-${tripId}`)
      .on('broadcast', { event: 'location' }, ({ payload }) => {
        callback(payload)
      })
      .subscribe()
  },

  // Broadcast driver location (for driver app)
  broadcastDriverLocation: async (tripId, location) => {
    const channel = supabase.channel(`driver-location-${tripId}`)
    await channel.send({
      type: 'broadcast',
      event: 'location',
      payload: location
    })
  }
}