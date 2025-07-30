/**
 * ============================================
 * AIRPORT BOOKING MVP - PRICING MODULE
 * ============================================
 * 
 * Handles all vehicle pricing calculations, configurations,
 * real-time updates, and capacity validations.
 */

export class PricingService {
    constructor() {
        // Vehicle pricing configuration
        this.vehicleConfig = {
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
        
        // Additional fees configuration
        this.additionalFees = {
            nightSurcharge: { start: 22, end: 6, rate: 1.15 }, // 15% after 10pm
            weekendSurcharge: { days: [0, 6], rate: 1.10 }, // 10% on weekends
            holidaySurcharge: { rate: 1.25 }, // 25% on holidays
            waitTime: { freeMinutes: 15, ratePerMinute: 2 },
            peakHours: { start: 7, end: 9, rate: 1.20 }, // 20% during rush hour
            cancellationFee: 25,
            childSeatFee: 15
        };

        // Holiday dates (can be extended)
        this.holidays = [
            '2025-01-01', // New Year's Day
            '2025-07-04', // Independence Day
            '2025-12-25', // Christmas Day
            '2025-11-28', // Thanksgiving
        ];

        // Real-time pricing update interval
        this.priceUpdateInterval = null;
        this.priceFluctuationRange = 5; // ±$2.50
    }

    /**
     * Main pricing calculation method
     * @param {string} vehicleType - Type of vehicle (tesla, escalade, sprinter)
     * @param {number} distance - Distance in miles
     * @param {number} duration - Duration in minutes
     * @param {Object} options - Additional options (dateTime, passengers, etc.)
     * @returns {Object|null} Pricing breakdown or null if invalid
     */
    calculateVehiclePrice(vehicleType, distance, duration, options = {}) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) {
            console.warn(`Invalid vehicle type: ${vehicleType}`);
            return null;
        }

        // Basic price calculations
        const perMilePrice = (distance * vehicle.pricePerMile) + vehicle.airportFee;
        const durationHours = duration / 60; // Convert minutes to hours
        const hourlyPrice = durationHours * vehicle.hourlyProtection;

        // Use higher of the two (hybrid protection model)
        let basePrice = Math.max(perMilePrice, hourlyPrice);
        
        // Apply surcharges if dateTime is provided
        let finalPrice = basePrice;
        let appliedSurcharges = [];

        if (options.dateTime) {
            const surchargeResult = this.applySurcharges(basePrice, options.dateTime);
            finalPrice = surchargeResult.finalPrice;
            appliedSurcharges = surchargeResult.appliedSurcharges;
        }

        // Add additional fees
        if (options.childSeats && options.childSeats > 0) {
            finalPrice += (options.childSeats * this.additionalFees.childSeatFee);
            appliedSurcharges.push({
                type: 'childSeats',
                description: `Child seats (${options.childSeats})`,
                amount: options.childSeats * this.additionalFees.childSeatFee
            });
        }

        return {
            vehicleType,
            vehicleName: vehicle.name,
            distance,
            duration,
            basePrice: Math.round(basePrice),
            finalPrice: Math.round(finalPrice),
            protectionApplied: hourlyPrice > perMilePrice ? 'hourly' : 'per-mile',
            breakdown: {
                perMilePrice: Math.round(perMilePrice),
                hourlyPrice: Math.round(hourlyPrice),
                airportFee: vehicle.airportFee,
                appliedSurcharges
            },
            savings: perMilePrice < hourlyPrice ? Math.round(hourlyPrice - perMilePrice) : 0
        };
    }

    /**
     * Apply time-based surcharges
     * @param {number} basePrice - Base price before surcharges
     * @param {Date} dateTime - Date and time of the trip
     * @returns {Object} Final price with applied surcharges
     */
    applySurcharges(basePrice, dateTime) {
        let finalPrice = basePrice;
        let appliedSurcharges = [];
        const hour = dateTime.getHours();
        const dayOfWeek = dateTime.getDay();
        const dateString = dateTime.toISOString().split('T')[0];

        // Night surcharge (10pm - 6am)
        if (hour >= this.additionalFees.nightSurcharge.start || hour < this.additionalFees.nightSurcharge.end) {
            const surchargeAmount = basePrice * (this.additionalFees.nightSurcharge.rate - 1);
            finalPrice *= this.additionalFees.nightSurcharge.rate;
            appliedSurcharges.push({
                type: 'night',
                description: 'Night service (10pm-6am)',
                rate: this.additionalFees.nightSurcharge.rate,
                amount: Math.round(surchargeAmount)
            });
        }

        // Weekend surcharge (Saturday & Sunday)
        if (this.additionalFees.weekendSurcharge.days.includes(dayOfWeek)) {
            const surchargeAmount = basePrice * (this.additionalFees.weekendSurcharge.rate - 1);
            finalPrice *= this.additionalFees.weekendSurcharge.rate;
            appliedSurcharges.push({
                type: 'weekend',
                description: 'Weekend service',
                rate: this.additionalFees.weekendSurcharge.rate,
                amount: Math.round(surchargeAmount)
            });
        }

        // Peak hours surcharge (7am - 9am)
        if (hour >= this.additionalFees.peakHours.start && hour < this.additionalFees.peakHours.end) {
            const surchargeAmount = basePrice * (this.additionalFees.peakHours.rate - 1);
            finalPrice *= this.additionalFees.peakHours.rate;
            appliedSurcharges.push({
                type: 'peak',
                description: 'Peak hours (7am-9am)',
                rate: this.additionalFees.peakHours.rate,
                amount: Math.round(surchargeAmount)
            });
        }

        // Holiday surcharge
        if (this.holidays.includes(dateString)) {
            const surchargeAmount = basePrice * (this.additionalFees.holidaySurcharge.rate - 1);
            finalPrice *= this.additionalFees.holidaySurcharge.rate;
            appliedSurcharges.push({
                type: 'holiday',
                description: 'Holiday service',
                rate: this.additionalFees.holidaySurcharge.rate,
                amount: Math.round(surchargeAmount)
            });
        }

        return {
            finalPrice,
            appliedSurcharges
        };
    }

    /**
     * Get vehicle configuration
     * @param {string} vehicleType - Type of vehicle
     * @returns {Object|null} Vehicle configuration or null
     */
    getVehicleConfig(vehicleType) {
        return this.vehicleConfig[vehicleType] || null;
    }

    /**
     * Get all available vehicles
     * @returns {Array} Array of vehicle type keys
     */
    getAllVehicles() {
        return Object.keys(this.vehicleConfig);
    }

    /**
     * Get all vehicle configurations
     * @returns {Object} Complete vehicle configuration object
     */
    getAllVehicleConfigs() {
        return { ...this.vehicleConfig };
    }

    /**
     * Check if vehicle can accommodate passenger count
     * @param {string} vehicleType - Type of vehicle
     * @param {number} passengerCount - Number of passengers
     * @returns {boolean} True if vehicle can accommodate passengers
     */
    checkCapacity(vehicleType, passengerCount) {
        const config = this.getVehicleConfig(vehicleType);
        return config && passengerCount <= config.capacity.passengers;
    }

    /**
     * Get vehicles that can accommodate passenger count
     * @param {number} passengerCount - Number of passengers
     * @returns {Array} Array of suitable vehicle types
     */
    getVehiclesForCapacity(passengerCount) {
        return this.getAllVehicles().filter(vehicleType => 
            this.checkCapacity(vehicleType, passengerCount)
        );
    }

    /**
     * Format price for display
     * @param {number} amount - Price amount
     * @param {boolean} showCents - Whether to show cents
     * @returns {string} Formatted price string
     */
    formatPrice(amount, showCents = false) {
        if (showCents) {
            return `$${amount.toFixed(2)}`;
        }
        return `$${Math.round(amount)}`;
    }

    /**
     * Calculate price comparison between vehicles
     * @param {string} baseVehicle - Base vehicle for comparison
     * @param {number} distance - Distance in miles
     * @param {number} duration - Duration in minutes
     * @param {Object} options - Additional options
     * @returns {Object} Price comparison data
     */
    compareVehiclePrices(baseVehicle, distance, duration, options = {}) {
        const allVehicles = this.getAllVehicles();
        const basePricing = this.calculateVehiclePrice(baseVehicle, distance, duration, options);
        
        if (!basePricing) return null;

        const comparison = allVehicles.map(vehicleType => {
            const pricing = this.calculateVehiclePrice(vehicleType, distance, duration, options);
            if (!pricing) return null;

            const difference = pricing.finalPrice - basePricing.finalPrice;
            const percentDifference = (difference / basePricing.finalPrice) * 100;

            return {
                vehicleType,
                vehicleName: pricing.vehicleName,
                price: pricing.finalPrice,
                difference,
                percentDifference: Math.round(percentDifference),
                isBase: vehicleType === baseVehicle,
                capacity: this.getVehicleConfig(vehicleType).capacity
            };
        }).filter(Boolean);

        return {
            baseVehicle,
            basePrice: basePricing.finalPrice,
            comparison: comparison.sort((a, b) => a.price - b.price)
        };
    }

    /**
     * Start real-time price updates
     * @param {Function} updateCallback - Callback function to handle price updates
     * @param {number} interval - Update interval in milliseconds (default: 15000)
     */
    startPriceUpdates(updateCallback, interval = 15000) {
        if (this.priceUpdateInterval) {
            clearInterval(this.priceUpdateInterval);
        }

        this.priceUpdateInterval = setInterval(() => {
            const vehicles = this.getAllVehicles();
            const priceUpdates = {};

            vehicles.forEach(vehicleType => {
                const config = this.getVehicleConfig(vehicleType);
                // Small random price fluctuation
                const fluctuation = (Math.random() - 0.5) * this.priceFluctuationRange;
                const newPrice = config.basePrice + fluctuation;
                
                priceUpdates[vehicleType] = {
                    vehicleType,
                    vehicleName: config.name,
                    newPrice: Math.max(newPrice, config.basePrice * 0.9), // Min 10% discount
                    originalPrice: config.basePrice,
                    fluctuation: Math.round(fluctuation * 100) / 100
                };
            });

            if (updateCallback && typeof updateCallback === 'function') {
                updateCallback(priceUpdates);
            }
        }, interval);

        console.log(`🔄 Real-time pricing updates started (every ${interval/1000}s)`);
    }

    /**
     * Stop real-time price updates
     */
    stopPriceUpdates() {
        if (this.priceUpdateInterval) {
            clearInterval(this.priceUpdateInterval);
            this.priceUpdateInterval = null;
            console.log('⏹️ Real-time pricing updates stopped');
        }
    }

    /**
     * Calculate estimated savings with different protection models
     * @param {string} vehicleType - Type of vehicle
     * @param {number} distance - Distance in miles
     * @param {number} duration - Duration in minutes
     * @returns {Object} Savings analysis
     */
    calculateSavings(vehicleType, distance, duration) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return null;

        const perMileTotal = (distance * vehicle.pricePerMile) + vehicle.airportFee;
        const hourlyTotal = (duration / 60) * vehicle.hourlyProtection;
        
        return {
            vehicleType,
            perMileModel: {
                total: Math.round(perMileTotal),
                breakdown: `${distance} miles × $${vehicle.pricePerMile} + $${vehicle.airportFee} airport fee`
            },
            hourlyModel: {
                total: Math.round(hourlyTotal),
                breakdown: `${Math.round(duration/60 * 10)/10} hours × $${vehicle.hourlyProtection}/hour`
            },
            chosenModel: hourlyTotal > perMileTotal ? 'hourly' : 'per-mile',
            savings: Math.abs(Math.round(hourlyTotal - perMileTotal)),
            savingsPercent: Math.round(Math.abs(hourlyTotal - perMileTotal) / Math.max(hourlyTotal, perMileTotal) * 100)
        };
    }

    /**
     * Get pricing estimate for route planning
     * @param {Array} routes - Array of route options with distance/duration
     * @param {string} vehicleType - Type of vehicle
     * @param {Object} options - Additional options
     * @returns {Array} Array of route estimates with pricing
     */
    estimateRoutes(routes, vehicleType, options = {}) {
        return routes.map((route, index) => {
            const pricing = this.calculateVehiclePrice(vehicleType, route.distance, route.duration, options);
            
            return {
                routeIndex: index,
                routeName: route.name || `Route ${index + 1}`,
                distance: route.distance,
                duration: route.duration,
                price: pricing ? pricing.finalPrice : null,
                pricing,
                estimatedArrival: options.departureTime ? 
                    new Date(options.departureTime.getTime() + route.duration * 60000) : null
            };
        }).sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
    }

    /**
     * Update vehicle configuration (for admin/testing purposes)
     * @param {string} vehicleType - Type of vehicle
     * @param {Object} updates - Configuration updates
     * @returns {boolean} Success status
     */
    updateVehicleConfig(vehicleType, updates) {
        if (!this.vehicleConfig[vehicleType]) {
            console.warn(`Vehicle type ${vehicleType} not found`);
            return false;
        }

        this.vehicleConfig[vehicleType] = {
            ...this.vehicleConfig[vehicleType],
            ...updates
        };

        console.log(`✅ Updated ${vehicleType} configuration:`, updates);
        return true;
    }

    /**
     * Add holiday date
     * @param {string} dateString - Date in YYYY-MM-DD format
     */
    addHoliday(dateString) {
        if (!this.holidays.includes(dateString)) {
            this.holidays.push(dateString);
            console.log(`➕ Added holiday: ${dateString}`);
        }
    }

    /**
     * Remove holiday date
     * @param {string} dateString - Date in YYYY-MM-DD format
     */
    removeHoliday(dateString) {
        const index = this.holidays.indexOf(dateString);
        if (index > -1) {
            this.holidays.splice(index, 1);
            console.log(`➖ Removed holiday: ${dateString}`);
        }
    }

    /**
     * Get pricing summary for display
     * @param {Object} pricingResult - Result from calculateVehiclePrice
     * @returns {Object} Formatted summary for UI
     */
    getPricingSummary(pricingResult) {
        if (!pricingResult) return null;

        return {
            vehicle: pricingResult.vehicleName,
            finalPrice: this.formatPrice(pricingResult.finalPrice),
            basePrice: this.formatPrice(pricingResult.basePrice),
            protectionModel: pricingResult.protectionApplied === 'hourly' ? 'Hourly Protection' : 'Per-Mile Rate',
            surcharges: pricingResult.breakdown.appliedSurcharges.map(surcharge => ({
                description: surcharge.description,
                amount: this.formatPrice(surcharge.amount)
            })),
            totalSurcharges: this.formatPrice(
                pricingResult.breakdown.appliedSurcharges.reduce((sum, s) => sum + s.amount, 0)
            ),
            savings: pricingResult.savings > 0 ? this.formatPrice(pricingResult.savings) : null
        };
    }
}

// Export singleton instance for easy use
export const pricingService = new PricingService();

// Export for CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PricingService, pricingService };
}
