class TripSyncManager {
    constructor(tripId, userType) {
        this.tripId = tripId;
        this.userType = userType; // 'driver' or 'passenger'
        this.callbacks = {};
        this.isOnline = navigator.onLine;
        this.init();
    }
    
    init() {
        // For MVP: Use localStorage with polling
        // In production: Replace with WebSocket
        this.startLocalStorageSync();
        this.setupOnlineDetection();
        console.log(`🔄 Sync Manager initialized for ${this.userType} on trip ${this.tripId}`);
    }
    
    // Send updates to other connected clients
    broadcast(updateType, data) {
        const message = {
            tripId: this.tripId,
            type: updateType,
            data: data,
            timestamp: Date.now(),
            from: this.userType,
            id: this.generateMessageId()
        };
        
        this.updateLocalStorage(message);
        console.log(`📤 Broadcasting ${updateType}:`, data);
    }
    
    // Subscribe to updates
    on(event, callback) {
        if (!this.callbacks[event]) {
            this.callbacks[event] = [];
        }
        this.callbacks[event].push(callback);
    }
    
    trigger(event, data) {
        if (this.callbacks[event]) {
            this.callbacks[event].forEach(callback => callback(data));
        }
    }
    
    // MVP Implementation: localStorage polling
    startLocalStorageSync() {
        this.lastProcessedId = this.getLastProcessedId();
        
        setInterval(() => {
            this.checkForUpdates();
        }, 1000); // Check every second
    }
    
    checkForUpdates() {
        const updates = this.getStoredUpdates();
        const newUpdates = updates.filter(msg => 
            msg.from !== this.userType && 
            msg.id > this.lastProcessedId
        );
        
        newUpdates.forEach(message => {
            this.handleUpdate(message);
            this.lastProcessedId = Math.max(this.lastProcessedId, message.id);
        });
        
        if (newUpdates.length > 0) {
            this.saveLastProcessedId();
        }
    }
    
    handleUpdate(message) {
        const { type, data } = message;
        console.log(`📥 Received ${type}:`, data);
        
        switch(type) {
            case 'location_update':
                this.trigger('locationChanged', data);
                break;
            case 'status_update':
                this.trigger('statusChanged', data);
                break;
            case 'eta_update':
                this.trigger('etaChanged', data);
                break;
            case 'route_update':
                this.trigger('routeChanged', data);
                break;
            case 'message':
                this.trigger('messageReceived', data);
                break;
        }
    }
    
    updateLocalStorage(message) {
        const key = `trip_${this.tripId}_updates`;
        const existing = this.getStoredUpdates();
        existing.push(message);
        
        // Keep only last 100 messages
        if (existing.length > 100) {
            existing.splice(0, existing.length - 100);
        }
        
        localStorage.setItem(key, JSON.stringify(existing));
    }
    
    getStoredUpdates() {
        const key = `trip_${this.tripId}_updates`;
        return JSON.parse(localStorage.getItem(key) || '[]');
    }
    
    generateMessageId() {
        return Date.now() + Math.random();
    }
    
    getLastProcessedId() {
        return parseFloat(localStorage.getItem(`${this.userType}_last_processed_${this.tripId}`) || '0');
    }
    
    saveLastProcessedId() {
        localStorage.setItem(`${this.userType}_last_processed_${this.tripId}`, this.lastProcessedId.toString());
    }
    
    setupOnlineDetection() {
        window.addEventListener('online', () => {
            this.isOnline = true;
            console.log('🌐 Back online - sync resumed');
        });
        
        window.addEventListener('offline', () => {
            this.isOnline = false;
            console.log('📴 Offline - using localStorage sync');
        });
    }
    
    // Get current trip data
    getTripData() {
        return JSON.parse(localStorage.getItem(`trip_${this.tripId}`) || '{}');
    }
    
    // Update trip data
    updateTripData(updates) {
        const current = this.getTripData();
        const updated = { ...current, ...updates };
        localStorage.setItem(`trip_${this.tripId}`, JSON.stringify(updated));
    }
}