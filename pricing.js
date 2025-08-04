/**
 * ============================================
 * AIRPORT BOOKING MVP - PRICING MODULE
 * ============================================
 * 
 * Handles all vehicle pricing calculations, configurations,
 * real-time updates, and capacity validations.
 * 
 * ENHANCED WITH TIERED PRICING SYSTEM (INTERNAL)
 * - Distance-based pricing tiers work behind the scenes
 * - Dynamic airport fees adjust automatically
 * - Popular route flat rates applied when applicable
 * - All existing surcharges and dynamic pricing maintained
 */

export class PricingService {
    constructor() {
        // Psychological pricing configuration
        this.psychologicalPricing = {
            enabled: true, // Can toggle for A/B testing
            strategy: 'auto', // 'auto', 'always9', 'always5', or 'disabled'
            threshold: 10 // Don't apply to prices under $10
        };
        
        // Vehicle pricing configuration with TIERED PRICING
        // The tiers work internally - customers just see final price
        this.vehicleConfig = {
            tesla: {
                name: 'Tesla Model Y',
                // Internal tiered structure - not shown to customers
                priceTiers: [
                    { minMiles: 0, maxMiles: 15, rate: 3.25 },    // Local trips
                    { minMiles: 16, maxMiles: 50, rate: 2.85 },   // Medium distance
                    { minMiles: 51, maxMiles: 100, rate: 2.45 },  // Long distance
                    { minMiles: 101, maxMiles: Infinity, rate: 2.15 } // Very long distance
                ],
                airportFee: 10,
                hourlyProtection: 100,
                capacity: { passengers: 4, bags: 4 }
            },
            escalade: {
                name: 'Cadillac Escalade',
                priceTiers: [
                    { minMiles: 0, maxMiles: 15, rate: 4.50 },
                    { minMiles: 16, maxMiles: 50, rate: 3.95 },
                    { minMiles: 51, maxMiles: 100, rate: 3.45 },
                    { minMiles: 101, maxMiles: Infinity, rate: 2.95 }
                ],
                airportFee: 15,
                hourlyProtection: 125,
                capacity: { passengers: 7, bags: 8 }
            },
            sprinter: {
                name: 'Mercedes Sprinter',
                priceTiers: [
                    { minMiles: 0, maxMiles: 15, rate: 6.25 },
                    { minMiles: 16, maxMiles: 50, rate: 5.50 },
                    { minMiles: 51, maxMiles: 100, rate: 4.85 },
                    { minMiles: 101, maxMiles: Infinity, rate: 4.25 }
                ],
                airportFee: 25,
                hourlyProtection: 150,
                capacity: { passengers: 12, bags: 15 }
            }
        };

        // Popular routes with competitive flat rates (applied automatically)
        this.popularRoutes = {
            'MIA-MCO': { 
                distance: 240, 
                flatRates: { tesla: 450, escalade: 650, sprinter: 850 },
                description: 'Miami to Orlando'
            },
            'MCO-MIA': { 
                distance: 240, 
                flatRates: { tesla: 450, escalade: 650, sprinter: 850 },
                description: 'Orlando to Miami'
            },
            'MIA-TPA': { 
                distance: 280, 
                flatRates: { tesla: 520, escalade: 750, sprinter: 950 },
                description: 'Miami to Tampa'
            },
            'TPA-MIA': { 
                distance: 280, 
                flatRates: { tesla: 520, escalade: 750, sprinter: 950 },
                description: 'Tampa to Miami'
            },
            'FLL-PBI': { 
                distance: 45, 
                flatRates: { tesla: 120, escalade: 165, sprinter: 220 },
                description: 'Fort Lauderdale to West Palm Beach'
            },
            'PBI-FLL': { 
                distance: 45, 
                flatRates: { tesla: 120, escalade: 165, sprinter: 220 },
                description: 'West Palm Beach to Fort Lauderdale'
            }
        };
        
        // Additional fees configuration - ALL MAINTAINED
        this.additionalFees = {
            nightSurcharge: { start: 22, end: 6, rate: 1.15 }, // 15% after 10pm
            weekendSurcharge: { days: [0, 6], rate: 1.10 }, // 10% on weekends
            holidaySurcharge: { rate: 1.25 }, // 25% on holidays
            peakHours: { start: 7, end: 9, rate: 1.20 }, // 20% during rush hour
            cancellationFee: 25
        };

        // Holiday dates (can be extended)
        this.holidays = [
            '2025-01-01', // New Year's Day
            '2025-07-04', // Independence Day
            '2025-12-25', // Christmas Day
            '2025-11-28', // Thanksgiving
        ];
    }

    /**
     * Apply psychological pricing (end in 5 or 9)
     * Why: Prices ending in 9 or 5 are perceived as significantly cheaper
     * @param {number} price - Original calculated price
     * @param {string} strategy - Pricing strategy to use
     * @returns {number} Psychologically optimized price
     */
    applyPsychologicalPricing(price, strategy = null) {
        // Skip if disabled or price too low
        if (!this.psychologicalPricing.enabled || price < this.psychologicalPricing.threshold) {
            return Math.round(price * 100) / 100;
        }
        
        const useStrategy = strategy || this.psychologicalPricing.strategy;
        
        // Round to nearest dollar first
        const roundedPrice = Math.round(price);
        
        switch (useStrategy) {
            case 'always9':
                // Always end in 9 (e.g., 247 -> 249, 243 -> 239)
                if (roundedPrice % 10 === 0) {
                    return roundedPrice - 1; // 250 -> 249
                } else if (roundedPrice % 10 <= 4) {
                    return Math.floor(roundedPrice / 10) * 10 - 1; // 243 -> 239
                } else if (roundedPrice % 10 >= 6) {
                    return Math.ceil(roundedPrice / 10) * 10 - 1; // 247 -> 249
                } else {
                    return roundedPrice; // 245 stays 245 (already ends in 5)
                }
            
            case 'always5':
                // Always end in 5 (e.g., 247 -> 245, 243 -> 245)
                if (roundedPrice % 10 === 0) {
                    return roundedPrice - 5; // 250 -> 245
                } else if (roundedPrice % 10 < 5) {
                    return Math.floor(roundedPrice / 10) * 10 + 5; // 243 -> 245
                } else if (roundedPrice % 10 > 5) {
                    return Math.floor(roundedPrice / 10) * 10 + 5; // 247 -> 245
                } else {
                    return roundedPrice; // Already ends in 5
                }
            
            case 'auto':
                // Smart selection based on price range
                // Under $50: end in 9 (seems like a deal)
                // $50-150: end in 5 (clean, professional)
                // $150-500: end in 9 (maximize perceived discount)
                // Over $500: end in 5 (premium feel)
                
                if (price < 50) {
                    // Small purchases: 9 creates urgency/deal perception
                    if (roundedPrice % 10 === 0) {
                        return roundedPrice - 1; // 30 -> 29
                    } else if (roundedPrice % 10 <= 5) {
                        return Math.floor(roundedPrice / 10) * 10 - 1; // 33 -> 29
                    } else {
                        return Math.ceil(roundedPrice / 10) * 10 - 1; // 37 -> 39
                    }
                } else if (price >= 50 && price < 150) {
                    // Mid-range: 5 feels professional
                    if (roundedPrice % 10 < 3) {
                        return Math.floor(roundedPrice / 10) * 10 - 5; // 71 -> 65
                    } else if (roundedPrice % 10 < 8) {
                        return Math.floor(roundedPrice / 10) * 10 + 5; // 74 -> 75
                    } else {
                        return Math.ceil(roundedPrice / 10) * 10 + 5; // 79 -> 85
                    }
                } else if (price >= 150 && price < 500) {
                    // Higher prices: 9 maximizes perceived savings
                    if (roundedPrice % 10 === 0) {
                        return roundedPrice - 1; // 250 -> 249
                    } else if (roundedPrice % 10 <= 5) {
                        return Math.floor(roundedPrice / 10) * 10 - 1; // 243 -> 239
                    } else {
                        return Math.ceil(roundedPrice / 10) * 10 - 1; // 247 -> 249
                    }
                } else {
                    // Premium pricing: end in 5 or 95 for luxury feel
                    const lastTwo = roundedPrice % 100;
                    if (lastTwo < 50) {
                        return Math.floor(roundedPrice / 100) * 100 + 45; // 520 -> 545
                    } else {
                        return Math.floor(roundedPrice / 100) * 100 + 95; // 580 -> 595
                    }
                }
            
            default:
                // No psychological pricing
                return Math.round(price * 100) / 100;
        }
    }

    /**
     * Calculate price using tiered distance rates (INTERNAL USE)
     * @param {string} vehicleType - Type of vehicle
     * @param {number} distance - Total distance in miles
     * @returns {Object} Tiered pricing calculation
     */
    calculateTieredPrice(vehicleType, distance) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return null;

        let totalPrice = 0;
        let tierBreakdown = [];
        let remainingMiles = distance;

        for (const tier of vehicle.priceTiers) {
            if (remainingMiles <= 0) break;

            let milesInTier;
            if (distance <= tier.maxMiles) {
                milesInTier = remainingMiles;
            } else if (distance > tier.minMiles) {
                milesInTier = Math.min(remainingMiles, tier.maxMiles - tier.minMiles + 1);
            } else {
                continue;
            }

            if (milesInTier > 0) {
                const tierCost = milesInTier * tier.rate;
                totalPrice += tierCost;
                
                tierBreakdown.push({
                    tier: tierBreakdown.length + 1,
                    miles: milesInTier,
                    rate: tier.rate,
                    subtotal: Math.round(tierCost * 100) / 100
                });

                remainingMiles -= milesInTier;
            }
        }

        return {
            total: Math.round(totalPrice * 100) / 100,
            tierBreakdown: tierBreakdown
        };
    }

    /**
     * Calculate dynamic airport fee based on distance (INTERNAL USE)
     * @param {string} vehicleType - Type of vehicle
     * @param {number} distance - Distance in miles
     * @returns {number} Adjusted airport fee
     */
    calculateDynamicAirportFee(vehicleType, distance) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return 0;

        const baseFee = vehicle.airportFee;
        
        if (distance <= 10) {
            return baseFee; // 100% for very short trips
        } else if (distance <= 30) {
            return Math.round(baseFee * 0.75 * 100) / 100; // 75% for short-medium trips
        } else if (distance <= 60) {
            return Math.round(baseFee * 0.50 * 100) / 100; // 50% for medium-long trips
        } else {
            return Math.round(baseFee * 0.25 * 100) / 100; // 25% for long trips
        }
    }

    /**
     * Check if route has special flat rate pricing (INTERNAL USE)
     * @param {string} origin - Origin airport code
     * @param {string} destination - Destination airport code
     * @returns {Object|null} Popular route info or null
     */
    checkPopularRoute(origin, destination) {
        if (!origin || !destination) return null;
        const routeKey = `${origin.toUpperCase()}-${destination.toUpperCase()}`;
        return this.popularRoutes[routeKey] || null;
    }

    /**
     * Main pricing calculation method - ENHANCED WITH TIERED PRICING
     * Returns simple, clean pricing for customer display
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

        // Step 1: Check for popular route flat rates (automatic)
        let popularRoute = null;
        let tieredTotal = 0;
        let tierBreakdown = null;
        
        if (options.origin && options.destination) {
            popularRoute = this.checkPopularRoute(options.origin, options.destination);
            if (popularRoute && popularRoute.flatRates[vehicleType]) {
                tieredTotal = popularRoute.flatRates[vehicleType];
            }
        }
        
        // Step 2: If no popular route, calculate tiered pricing internally
        if (!popularRoute) {
            const tieredResult = this.calculateTieredPrice(vehicleType, distance);
            if (!tieredResult) return null;
            
            tieredTotal = tieredResult.total;
            tierBreakdown = tieredResult.tierBreakdown;
        }
        
        // Step 3: Add dynamic airport fee (automatic adjustment)
        const dynamicAirportFee = this.calculateDynamicAirportFee(vehicleType, distance);
        const tieredWithFee = tieredTotal + dynamicAirportFee;
        
        // Step 4: Calculate hourly protection price
        const durationHours = duration / 60;
        const hourlyPrice = durationHours * vehicle.hourlyProtection;
        
        // Step 5: Use higher of the two (hybrid protection model)
        let basePrice = Math.max(tieredWithFee, hourlyPrice);
        const protectionApplied = hourlyPrice > tieredWithFee ? 'hourly' : 'tiered';
        
        // Step 6: Apply time-based surcharges if dateTime is provided
        let finalPrice = basePrice;
        let appliedSurcharges = [];

        if (options.dateTime) {
            const surchargeResult = this.applySurcharges(basePrice, options.dateTime);
            finalPrice = surchargeResult.finalPrice;
            appliedSurcharges = surchargeResult.appliedSurcharges;
        }
        
        // Step 7: Apply psychological pricing to final amount
        const psychologicalPrice = this.applyPsychologicalPricing(finalPrice);
        const psychologicalAdjustment = psychologicalPrice - finalPrice;

        // Return clean, simple pricing for display
        return {
            vehicleType,
            vehicleName: vehicle.name,
            distance,
            duration,
            basePrice: Math.round(basePrice * 100) / 100,
            finalPrice: psychologicalPrice, // Now with psychological pricing
            protectionApplied,
            // Simplified breakdown - only what customers need to see
            breakdown: {
                // Internal calculations (not for display)
                tierBreakdown,
                tieredTotal,
                dynamicAirportFee,
                hourlyPrice: Math.round(hourlyPrice * 100) / 100,
                // Customer-facing surcharges
                appliedSurcharges,
                // Internal tracking
                popularRoute: popularRoute ? {
                    description: popularRoute.description,
                    flatRate: popularRoute.flatRates[vehicleType]
                } : null
            }
        };
    }

    /**
     * Apply time-based surcharges - ALL EXISTING SURCHARGES MAINTAINED
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
                amount: Math.round(surchargeAmount * 100) / 100
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
                amount: Math.round(surchargeAmount * 100) / 100
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
                amount: Math.round(surchargeAmount * 100) / 100
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
                amount: Math.round(surchargeAmount * 100) / 100
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
     * Format price for display - SIMPLE AND CLEAN
     * @param {number} amount - Price amount
     * @param {boolean} showCents - Whether to show cents
     * @returns {string} Formatted price string
     */
    formatPrice(amount, showCents = false) {
        // With psychological pricing, most prices end in 5 or 9
        // So we handle display accordingly
        const isWholeNumber = amount % 1 === 0;
        
        if (isWholeNumber && !showCents) {
            return `${amount}`; // $249 not $249.00
        } else if (showCents || !isWholeNumber) {
            return `${amount.toFixed(2)}`;
        }
        return `${Math.round(amount)}`;
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
     * Calculate estimated savings (INTERNAL ANALYTICS)
     * @param {string} vehicleType - Type of vehicle
     * @param {number} distance - Distance in miles
     * @param {number} duration - Duration in minutes
     * @returns {Object} Savings analysis
     */
    calculateSavings(vehicleType, distance, duration) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return null;

        const tieredResult = this.calculateTieredPrice(vehicleType, distance);
        const dynamicFee = this.calculateDynamicAirportFee(vehicleType, distance);
        const tieredTotal = tieredResult.total + dynamicFee;
        
        // Calculate with old linear system (for internal comparison)
        const oldRate = vehicle.priceTiers[0].rate;
        const oldTotal = (distance * oldRate) + vehicle.airportFee;
        
        // Calculate hourly protection
        const hourlyTotal = (duration / 60) * vehicle.hourlyProtection;
        
        return {
            vehicleType,
            newTieredTotal: Math.round(tieredTotal * 100) / 100,
            oldLinearTotal: Math.round(oldTotal * 100) / 100,
            hourlyTotal: Math.round(hourlyTotal * 100) / 100,
            chosenModel: hourlyTotal > tieredTotal ? 'hourly' : 'tiered',
            savingsVsOld: Math.round((oldTotal - tieredTotal) * 100) / 100,
            savingsPercent: Math.round((oldTotal - tieredTotal) / oldTotal * 100)
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
            const routeOptions = {
                ...options,
                origin: route.origin,
                destination: route.destination
            };
            
            const pricing = this.calculateVehiclePrice(vehicleType, route.distance, route.duration, routeOptions);
            
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
     * Get pricing summary for SIMPLE DISPLAY
     * @param {Object} pricingResult - Result from calculateVehiclePrice
     * @returns {Object} Formatted summary for UI
     */
    getPricingSummary(pricingResult) {
        if (!pricingResult) return null;

        // Simple, clean summary for customer display
        return {
            vehicle: pricingResult.vehicleName,
            finalPrice: this.formatPrice(pricingResult.finalPrice),
            basePrice: this.formatPrice(pricingResult.basePrice),
            
            // Only show surcharges if they exist (keeps it simple)
            surcharges: pricingResult.breakdown.appliedSurcharges.length > 0 ? 
                pricingResult.breakdown.appliedSurcharges.map(surcharge => ({
                    description: surcharge.description,
                    amount: this.formatPrice(surcharge.amount)
                })) : null,
            
            totalSurcharges: pricingResult.breakdown.appliedSurcharges.length > 0 ?
                this.formatPrice(
                    pricingResult.breakdown.appliedSurcharges.reduce((sum, s) => sum + s.amount, 0)
                ) : null
        };
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
     * Get cancellation fee
     * @returns {number} Cancellation fee amount
     */
    getCancellationFee() {
        return this.additionalFees.cancellationFee;
    }

    /**
     * Check if datetime falls within surge period
     * @param {Date} dateTime - Date and time to check
     * @returns {Object} Surge period details
     */
    checkSurgePeriod(dateTime) {
        const hour = dateTime.getHours();
        const dayOfWeek = dateTime.getDay();
        const dateString = dateTime.toISOString().split('T')[0];
        
        const surges = [];
        
        // Check night surge
        if (hour >= this.additionalFees.nightSurcharge.start || hour < this.additionalFees.nightSurcharge.end) {
            surges.push({
                type: 'night',
                rate: this.additionalFees.nightSurcharge.rate,
                description: 'Night service (10pm-6am)'
            });
        }
        
        // Check weekend surge
        if (this.additionalFees.weekendSurcharge.days.includes(dayOfWeek)) {
            surges.push({
                type: 'weekend',
                rate: this.additionalFees.weekendSurcharge.rate,
                description: 'Weekend service'
            });
        }
        
        // Check peak hours
        if (hour >= this.additionalFees.peakHours.start && hour < this.additionalFees.peakHours.end) {
            surges.push({
                type: 'peak',
                rate: this.additionalFees.peakHours.rate,
                description: 'Peak hours (7am-9am)'
            });
        }
        
        // Check holiday
        if (this.holidays.includes(dateString)) {
            surges.push({
                type: 'holiday',
                rate: this.additionalFees.holidaySurcharge.rate,
                description: 'Holiday service'
            });
        }
        
        return {
            hasSurge: surges.length > 0,
            surges: surges,
            totalMultiplier: surges.reduce((mult, surge) => mult * surge.rate, 1)
        };
    }

    /**
     * Quick price estimate (without detailed breakdown)
     * For fast UI updates during user input
     * @param {string} vehicleType - Type of vehicle
     * @param {number} distance - Distance in miles
     * @returns {number|null} Estimated price
     */
    getQuickEstimate(vehicleType, distance) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return null;
        
        // Quick tiered calculation
        const tieredResult = this.calculateTieredPrice(vehicleType, distance);
        const airportFee = this.calculateDynamicAirportFee(vehicleType, distance);
        const rawPrice = tieredResult.total + airportFee;
        
        // Apply psychological pricing for display
        return this.applyPsychologicalPricing(rawPrice);
    }

    /**
     * Toggle psychological pricing for A/B testing
     * @param {boolean} enabled - Enable or disable
     * @param {string} strategy - Strategy to use when enabled
     */
    setPsychologicalPricing(enabled, strategy = 'auto') {
        this.psychologicalPricing.enabled = enabled;
        this.psychologicalPricing.strategy = strategy;
        console.log(`💰 Psychological pricing ${enabled ? 'enabled' : 'disabled'} with strategy: ${strategy}`);
    }

    /**
     * Compare prices with and without psychological pricing
     * Useful for understanding the impact
     * @param {string} vehicleType - Type of vehicle
     * @param {number} distance - Distance in miles
     * @param {number} duration - Duration in minutes
     * @returns {Object} Comparison data
     */
    comparePsychologicalImpact(vehicleType, distance, duration) {
        // Calculate with psychological pricing
        this.psychologicalPricing.enabled = true;
        const withPsych = this.calculateVehiclePrice(vehicleType, distance, duration);
        
        // Calculate without psychological pricing
        this.psychologicalPricing.enabled = false;
        const withoutPsych = this.calculateVehiclePrice(vehicleType, distance, duration);
        
        // Re-enable psychological pricing
        this.psychologicalPricing.enabled = true;
        
        return {
            originalPrice: withoutPsych.finalPrice,
            psychologicalPrice: withPsych.finalPrice,
            difference: Math.abs(withPsych.finalPrice - withoutPsych.finalPrice),
            perceivedSavings: withoutPsych.finalPrice > withPsych.finalPrice ? 
                `Customer feels they saved ${(withoutPsych.finalPrice - withPsych.finalPrice).toFixed(2)}` :
                `Price increased by ${(withPsych.finalPrice - withoutPsych.finalPrice).toFixed(2)} for better perception`,
            recommendation: withPsych.finalPrice < 50 ? 
                'Price ends in 9 - creates bargain perception' :
                withPsych.finalPrice < 150 ? 
                'Price ends in 5 - professional feel' :
                'Price ends in 9 - maximizes perceived value'
        };
    }

    /**
     * Test psychological pricing with various examples
     * Shows how different prices are optimized for psychological impact
     */
    testPsychologicalPricing() {
        console.log('🧠 Testing Psychological Pricing\n');
        console.log('Strategy: AUTO (smart selection based on price range)\n');
        
        const testPrices = [
            23,   // Small price -> 19 or 29
            47,   // Small price -> 49
            73,   // Mid-range -> 75
            127,  // Mid-range -> 125
            247,  // Higher -> 249
            523,  // Premium -> 545 or 525
            1250  // Very premium -> 1245 or 1295
        ];
        
        console.log('Original -> Optimized:');
        testPrices.forEach(price => {
            const optimized = this.applyPsychologicalPricing(price);
            const savings = price - optimized;
            console.log(`${price} -> ${optimized} (${savings > 0 ? 'saves' : 'adds'} ${Math.abs(savings.toFixed(2))})`);
        });
        
        console.log('\n📊 Impact Analysis:');
        console.log('• Prices under $50: End in 9 (bargain perception)');
        console.log('• Prices $50-150: End in 5 (professional)');
        console.log('• Prices $150-500: End in 9 (maximize perceived savings)');
        console.log('• Prices $500+: End in 45/95 (premium positioning)');
        
        console.log('\n💡 A/B Testing:');
        console.log('Toggle psychological pricing on/off to measure conversion impact:');
        console.log('pricingService.psychologicalPricing.enabled = false; // Disable');
        console.log('pricingService.psychologicalPricing.strategy = "always9"; // Always use 9');
    }

    /**
     * Validate pricing configuration
     * @returns {Object} Validation results
     */
    validateConfiguration() {
        const issues = [];
        const warnings = [];
        
        // Check each vehicle configuration
        for (const [vehicleType, config] of Object.entries(this.vehicleConfig)) {
            // Check tier continuity
            let lastMax = -1;
            for (let i = 0; i < config.priceTiers.length; i++) {
                const tier = config.priceTiers[i];
                if (tier.minMiles !== lastMax + 1 && i > 0) {
                    issues.push(`${vehicleType}: Gap in tier coverage between miles ${lastMax} and ${tier.minMiles}`);
                }
                lastMax = tier.maxMiles === Infinity ? lastMax : tier.maxMiles;
                
                // Check rate progression (should decrease)
                if (i > 0 && tier.rate >= config.priceTiers[i-1].rate) {
                    warnings.push(`${vehicleType}: Tier ${i+1} rate not lower than tier ${i}`);
                }
            }
            
            // Check required fields
            if (!config.hourlyProtection) {
                issues.push(`${vehicleType}: Missing hourly protection rate`);
            }
            if (!config.capacity) {
                issues.push(`${vehicleType}: Missing capacity configuration`);
            }
        }
        
        return {
            valid: issues.length === 0,
            issues,
            warnings
        };
    }
}

// Export singleton instance for easy use
export const pricingService = new PricingService();

// Export for CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PricingService, pricingService };
}
