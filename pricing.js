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
        this.vehicleConfig = {
            tesla: {
                name: 'Tesla Model Y',
                priceTiers: [
                    { minMiles: 0, maxMiles: 15, rate: 3.25 },
                    { minMiles: 16, maxMiles: 50, rate: 2.85 },
                    { minMiles: 51, maxMiles: 100, rate: 2.45 },
                    { minMiles: 101, maxMiles: 280, rate: 2.15 }  // Service limit at 280 miles
                ],
                airportFee: 10,
                hourlyProtection: 100,
                capacity: { passengers: 4, bags: 4 },
                maxDistance: 280  // Service area limit
            },
            escalade: {
                name: 'Cadillac Escalade',
                priceTiers: [
                    { minMiles: 0, maxMiles: 15, rate: 4.50 },
                    { minMiles: 16, maxMiles: 50, rate: 3.95 },
                    { minMiles: 51, maxMiles: 100, rate: 3.45 },
                    { minMiles: 101, maxMiles: 280, rate: 2.95 }  // Service limit at 280 miles
                ],
                airportFee: 15,
                hourlyProtection: 125,
                capacity: { passengers: 7, bags: 8 },
                maxDistance: 280  // Service area limit
            },
            sprinter: {
                name: 'Mercedes Sprinter',
                priceTiers: [
                    { minMiles: 0, maxMiles: 15, rate: 6.25 },
                    { minMiles: 16, maxMiles: 50, rate: 5.50 },
                    { minMiles: 51, maxMiles: 100, rate: 4.85 },
                    { minMiles: 101, maxMiles: 280, rate: 4.25 }  // Service limit at 280 miles
                ],
                airportFee: 25,
                hourlyProtection: 150,
                capacity: { passengers: 12, bags: 15 },
                maxDistance: 280  // Service area limit
            }
        };

        // Popular routes with competitive flat rates
        this.popularRoutes = {
            'MIA-MCO': { distance: 240, flatRates: { tesla: 450, escalade: 650, sprinter: 850 }, description: 'Miami to Orlando' },
            'MCO-MIA': { distance: 240, flatRates: { tesla: 450, escalade: 650, sprinter: 850 }, description: 'Orlando to Miami' },
            'MIA-TPA': { distance: 280, flatRates: { tesla: 520, escalade: 750, sprinter: 950 }, description: 'Miami to Tampa' },
            'TPA-MIA': { distance: 280, flatRates: { tesla: 520, escalade: 750, sprinter: 950 }, description: 'Tampa to Miami' },
            'FLL-PBI': { distance: 45, flatRates: { tesla: 120, escalade: 165, sprinter: 220 }, description: 'Fort Lauderdale to West Palm Beach' },
            'PBI-FLL': { distance: 45, flatRates: { tesla: 120, escalade: 165, sprinter: 220 }, description: 'West Palm Beach to Fort Lauderdale' }
        };
        
        // Additional fees configuration
        this.additionalFees = {
            nightSurcharge: { start: 22, end: 6, rate: 1.15, description: 'Night service (10pm-6am)' },
            weekendSurcharge: { days: [0, 6], rate: 1.10, description: 'Weekend service' },
            holidaySurcharge: { rate: 1.25, description: 'Holiday service' },
            peakHours: { start: 7, end: 9, rate: 1.20, description: 'Peak hours (7am-9am)' },
            cancellationFee: 15
        };

        // Holiday dates
        this.holidays = [
            '2025-01-01', // New Year's Day
            '2025-07-04', // Independence Day
            '2025-12-25', // Christmas Day
            '2025-11-28', // Thanksgiving
        ];
    }

    /**
     * Utility function for rounding to 2 decimals
     */
    roundToTwoDec(value) {
        return Math.round(value * 100) / 100;
    }

    /**
     * Apply psychological pricing (end in 5 or 9)
     */
    applyPsychologicalPricing(price, strategy = null) {
        if (!this.psychologicalPricing.enabled || price < this.psychologicalPricing.threshold) {
            return this.roundToTwoDec(price);
        }
        
        const useStrategy = strategy || this.psychologicalPricing.strategy;
        const roundedPrice = Math.round(price);
        
        switch (useStrategy) {
            case 'always9':
                if (roundedPrice % 10 === 0) return roundedPrice - 1;
                if (roundedPrice % 10 <= 4) return Math.floor(roundedPrice / 10) * 10 - 1;
                if (roundedPrice % 10 >= 6) return Math.ceil(roundedPrice / 10) * 10 - 1;
                return roundedPrice;
            
            case 'always5':
                if (roundedPrice % 10 === 0) return roundedPrice - 5;
                if (roundedPrice % 10 < 5) return Math.floor(roundedPrice / 10) * 10 + 5;
                if (roundedPrice % 10 > 5) return Math.floor(roundedPrice / 10) * 10 + 5;
                return roundedPrice;
            
            case 'auto':
                if (price < 50) {
                    if (roundedPrice % 10 === 0) return roundedPrice - 1;
                    if (roundedPrice % 10 <= 5) return Math.floor(roundedPrice / 10) * 10 - 1;
                    return Math.ceil(roundedPrice / 10) * 10 - 1;
                } else if (price < 150) {
                    if (roundedPrice % 10 < 3) return Math.floor(roundedPrice / 10) * 10 - 5;
                    if (roundedPrice % 10 < 8) return Math.floor(roundedPrice / 10) * 10 + 5;
                    return Math.ceil(roundedPrice / 10) * 10 + 5;
                } else if (price < 500) {
                    if (roundedPrice % 10 === 0) return roundedPrice - 1;
                    if (roundedPrice % 10 <= 5) return Math.floor(roundedPrice / 10) * 10 - 1;
                    return Math.ceil(roundedPrice / 10) * 10 - 1;
                } else {
                    const lastTwo = roundedPrice % 100;
                    return lastTwo < 50 ? 
                        Math.floor(roundedPrice / 100) * 100 + 45 : 
                        Math.floor(roundedPrice / 100) * 100 + 95;
                }
            
            default:
                return this.roundToTwoDec(price);
        }
    }

    /**
     * Calculate price using tiered distance rates
     */
    calculateTieredPrice(vehicleType, distance) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return null;

        let totalPrice = 0;
        let tierBreakdown = [];
        let remainingMiles = distance;

        for (const tier of vehicle.priceTiers) {
            if (remainingMiles <= 0) break;

            const milesInTier = Math.min(
                remainingMiles,
                tier.maxMiles - tier.minMiles + 1
            );

            if (milesInTier > 0) {
                const tierCost = milesInTier * tier.rate;
                totalPrice += tierCost;
                
                tierBreakdown.push({
                    tier: tierBreakdown.length + 1,
                    miles: milesInTier,
                    rate: tier.rate,
                    subtotal: this.roundToTwoDec(tierCost)
                });

                remainingMiles -= milesInTier;
            }
        }

        return {
            total: this.roundToTwoDec(totalPrice),
            tierBreakdown: tierBreakdown
        };
    }

    /**
     * Calculate dynamic airport fee based on distance
     */
    calculateDynamicAirportFee(vehicleType, distance) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return 0;

        const baseFee = vehicle.airportFee;
        const multiplier = distance <= 10 ? 1 : 
                          distance <= 30 ? 0.75 : 
                          distance <= 60 ? 0.50 : 0.25;
        
        return this.roundToTwoDec(baseFee * multiplier);
    }

    /**
     * Check if route has special flat rate pricing
     */
    checkPopularRoute(origin, destination) {
        if (!origin || !destination) return null;
        const routeKey = `${origin.toUpperCase()}-${destination.toUpperCase()}`;
        return this.popularRoutes[routeKey] || null;
    }

    /**
     * Main pricing calculation method
     */
    calculateVehiclePrice(vehicleType, distance, duration, options = {}) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) {
            console.warn(`Invalid vehicle type: ${vehicleType}`);
            return null;
        }

        // Check if distance exceeds service area (280 miles max)
        if (distance > 280) {
            console.warn(`Distance ${distance} miles exceeds service area (max 280 miles)`);
            return {
                error: true,
                message: 'Trip exceeds service area. Maximum distance is 280 miles.',
                maxDistance: 280
            };
        }

        // Check for popular route flat rates
        let popularRoute = null;
        let tieredTotal = 0;
        let tierBreakdown = null;
        
        if (options.origin && options.destination) {
            popularRoute = this.checkPopularRoute(options.origin, options.destination);
            if (popularRoute && popularRoute.flatRates[vehicleType]) {
                tieredTotal = popularRoute.flatRates[vehicleType];
            }
        }
        
        // If no popular route, calculate tiered pricing
        if (!popularRoute) {
            const tieredResult = this.calculateTieredPrice(vehicleType, distance);
            if (!tieredResult) return null;
            
            tieredTotal = tieredResult.total;
            tierBreakdown = tieredResult.tierBreakdown;
        }
        
        // Add dynamic airport fee
        const dynamicAirportFee = this.calculateDynamicAirportFee(vehicleType, distance);
        const tieredWithFee = tieredTotal + dynamicAirportFee;
        
        // Calculate hourly protection price
        const durationHours = duration / 60;
        const hourlyPrice = durationHours * vehicle.hourlyProtection;
        
        // Use higher of the two
        let basePrice = Math.max(tieredWithFee, hourlyPrice);
        const protectionApplied = hourlyPrice > tieredWithFee ? 'hourly' : 'tiered';
        
        // Apply time-based surcharges
        let finalPrice = basePrice;
        let appliedSurcharges = [];

        if (options.dateTime) {
            const surchargeResult = this.applySurcharges(basePrice, options.dateTime);
            finalPrice = surchargeResult.finalPrice;
            appliedSurcharges = surchargeResult.appliedSurcharges;
        }
        
        // Apply psychological pricing
        const psychologicalPrice = this.applyPsychologicalPricing(finalPrice);

        return {
            vehicleType,
            vehicleName: vehicle.name,
            distance,
            duration,
            basePrice: this.roundToTwoDec(basePrice),
            finalPrice: psychologicalPrice,
            protectionApplied,
            breakdown: {
                tierBreakdown,
                tieredTotal,
                dynamicAirportFee,
                hourlyPrice: this.roundToTwoDec(hourlyPrice),
                appliedSurcharges,
                popularRoute: popularRoute ? {
                    description: popularRoute.description,
                    flatRate: popularRoute.flatRates[vehicleType]
                } : null
            }
        };
    }

    /**
     * Apply a single surcharge
     */
    applySingleSurcharge(basePrice, surchargeConfig, type) {
        const surchargeAmount = basePrice * (surchargeConfig.rate - 1);
        return {
            type: type,
            description: surchargeConfig.description,
            rate: surchargeConfig.rate,
            amount: this.roundToTwoDec(surchargeAmount)
        };
    }

    /**
     * Apply time-based surcharges
     */
    applySurcharges(basePrice, dateTime) {
        let finalPrice = basePrice;
        let appliedSurcharges = [];
        const hour = dateTime.getHours();
        const dayOfWeek = dateTime.getDay();
        const dateString = dateTime.toISOString().split('T')[0];

        // Night surcharge
        if (hour >= this.additionalFees.nightSurcharge.start || hour < this.additionalFees.nightSurcharge.end) {
            const surcharge = this.applySingleSurcharge(basePrice, this.additionalFees.nightSurcharge, 'night');
            finalPrice *= this.additionalFees.nightSurcharge.rate;
            appliedSurcharges.push(surcharge);
        }

        // Weekend surcharge
        if (this.additionalFees.weekendSurcharge.days.includes(dayOfWeek)) {
            const surcharge = this.applySingleSurcharge(basePrice, this.additionalFees.weekendSurcharge, 'weekend');
            finalPrice *= this.additionalFees.weekendSurcharge.rate;
            appliedSurcharges.push(surcharge);
        }

        // Peak hours surcharge
        if (hour >= this.additionalFees.peakHours.start && hour < this.additionalFees.peakHours.end) {
            const surcharge = this.applySingleSurcharge(basePrice, this.additionalFees.peakHours, 'peak');
            finalPrice *= this.additionalFees.peakHours.rate;
            appliedSurcharges.push(surcharge);
        }

        // Holiday surcharge
        if (this.holidays.includes(dateString)) {
            const surcharge = this.applySingleSurcharge(basePrice, this.additionalFees.holidaySurcharge, 'holiday');
            finalPrice *= this.additionalFees.holidaySurcharge.rate;
            appliedSurcharges.push(surcharge);
        }

        return { finalPrice, appliedSurcharges };
    }

    /**
     * Get vehicle configuration
     */
    getVehicleConfig(vehicleType) {
        return this.vehicleConfig[vehicleType] || null;
    }

    /**
     * Get all available vehicles
     */
    getAllVehicles() {
        return Object.keys(this.vehicleConfig);
    }

    /**
     * Get all vehicle configurations
     */
    getAllVehicleConfigs() {
        return { ...this.vehicleConfig };
    }

    /**
     * Check if vehicle can accommodate passenger count
     */
    checkCapacity(vehicleType, passengerCount) {
        const config = this.getVehicleConfig(vehicleType);
        return config && passengerCount <= config.capacity.passengers;
    }

    /**
     * Get vehicles that can accommodate passenger count
     */
    getVehiclesForCapacity(passengerCount) {
        return this.getAllVehicles().filter(vehicleType => 
            this.checkCapacity(vehicleType, passengerCount)
        );
    }

    /**
     * Format price for display
     */
    formatPrice(amount, showCents = false) {
        const isWholeNumber = amount % 1 === 0;
        
        if (isWholeNumber && !showCents) {
            return `${amount}`;
        }
        return `${amount.toFixed(2)}`;
    }

    /**
     * Calculate price comparison between vehicles
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
     * Get pricing estimate for route planning
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
     * Get pricing summary for display
     */
    getPricingSummary(pricingResult) {
        if (!pricingResult) return null;

        const surcharges = pricingResult.breakdown.appliedSurcharges;
        
        return {
            vehicle: pricingResult.vehicleName,
            finalPrice: this.formatPrice(pricingResult.finalPrice),
            basePrice: this.formatPrice(pricingResult.basePrice),
            surcharges: surcharges.length > 0 ? 
                surcharges.map(s => ({
                    description: s.description,
                    amount: this.formatPrice(s.amount)
                })) : null,
            totalSurcharges: surcharges.length > 0 ?
                this.formatPrice(surcharges.reduce((sum, s) => sum + s.amount, 0)) : null
        };
    }

    /**
     * Update vehicle configuration
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
     */
    addHoliday(dateString) {
        if (!this.holidays.includes(dateString)) {
            this.holidays.push(dateString);
            console.log(`➕ Added holiday: ${dateString}`);
        }
    }

    /**
     * Remove holiday date
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
     */
    getCancellationFee() {
        return this.additionalFees.cancellationFee;
    }

    /**
     * Check if datetime falls within surge period
     */
    checkSurgePeriod(dateTime) {
        const hour = dateTime.getHours();
        const dayOfWeek = dateTime.getDay();
        const dateString = dateTime.toISOString().split('T')[0];
        
        const surges = [];
        
        if (hour >= this.additionalFees.nightSurcharge.start || hour < this.additionalFees.nightSurcharge.end) {
            surges.push({
                type: 'night',
                rate: this.additionalFees.nightSurcharge.rate,
                description: this.additionalFees.nightSurcharge.description
            });
        }
        
        if (this.additionalFees.weekendSurcharge.days.includes(dayOfWeek)) {
            surges.push({
                type: 'weekend',
                rate: this.additionalFees.weekendSurcharge.rate,
                description: this.additionalFees.weekendSurcharge.description
            });
        }
        
        if (hour >= this.additionalFees.peakHours.start && hour < this.additionalFees.peakHours.end) {
            surges.push({
                type: 'peak',
                rate: this.additionalFees.peakHours.rate,
                description: this.additionalFees.peakHours.description
            });
        }
        
        if (this.holidays.includes(dateString)) {
            surges.push({
                type: 'holiday',
                rate: this.additionalFees.holidaySurcharge.rate,
                description: this.additionalFees.holidaySurcharge.description
            });
        }
        
        return {
            hasSurge: surges.length > 0,
            surges: surges,
            totalMultiplier: surges.reduce((mult, surge) => mult * surge.rate, 1)
        };
    }

    /**
     * Quick price estimate
     */
    getQuickEstimate(vehicleType, distance) {
        const vehicle = this.vehicleConfig[vehicleType];
        if (!vehicle) return null;
        
        const tieredResult = this.calculateTieredPrice(vehicleType, distance);
        const airportFee = this.calculateDynamicAirportFee(vehicleType, distance);
        const rawPrice = tieredResult.total + airportFee;
        
        return this.applyPsychologicalPricing(rawPrice);
    }

    /**
     * Toggle psychological pricing
     */
    setPsychologicalPricing(enabled, strategy = 'auto') {
        this.psychologicalPricing.enabled = enabled;
        this.psychologicalPricing.strategy = strategy;
        console.log(`💰 Psychological pricing ${enabled ? 'enabled' : 'disabled'} with strategy: ${strategy}`);
    }

    /**
     * Validate pricing configuration
     */
    validateConfiguration() {
        const issues = [];
        const warnings = [];
        
        for (const [vehicleType, config] of Object.entries(this.vehicleConfig)) {
            let lastMax = -1;
            for (let i = 0; i < config.priceTiers.length; i++) {
                const tier = config.priceTiers[i];
                if (tier.minMiles !== lastMax + 1 && i > 0) {
                    issues.push(`${vehicleType}: Gap in tier coverage between miles ${lastMax} and ${tier.minMiles}`);
                }
                lastMax = tier.maxMiles === Infinity ? lastMax : tier.maxMiles;
                
                if (i > 0 && tier.rate >= config.priceTiers[i-1].rate) {
                    warnings.push(`${vehicleType}: Tier ${i+1} rate not lower than tier ${i}`);
                }
            }
            
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

    /**
     * Calculate fallback price when pricing service fails
     */
    calculateFallbackPrice(vehicleType, distance, duration) {
        console.log('⚠️ Using fallback pricing for', vehicleType);
        
        const fallbackConfig = this.getFallbackVehicleConfig();
        const vehicleConfig = fallbackConfig[vehicleType];
        
        if (!vehicleConfig) {
            console.error('Unknown vehicle type for fallback:', vehicleType);
            return null;
        }
        
        const basePrice = distance * 2.5 + 45;
        const psychologicalPrice = this.applyPsychologicalPricing(basePrice);
        
        return {
            vehicleType,
            vehicleName: vehicleConfig.name,
            basePrice: this.roundToTwoDec(basePrice),
            finalPrice: psychologicalPrice,
            protectionApplied: 'fallback',
            breakdown: {
                perMilePrice: this.roundToTwoDec(distance * 2.5),
                airportFee: 45,
                appliedSurcharges: []
            }
        };
    }

    /**
     * Get fallback vehicle configuration
     */
    getFallbackVehicleConfig() {
        return {
            tesla: { 
                name: 'Tesla Model Y',
                basePrice: 125,
                capacity: { passengers: 4, bags: 4 } 
            },
            escalade: { 
                name: 'Cadillac Escalade',
                basePrice: 169,
                capacity: { passengers: 7, bags: 8 } 
            },
            sprinter: { 
                name: 'Mercedes Sprinter',
                basePrice: 219,
                capacity: { passengers: 12, bags: 15 } 
            }
        };
    }

    /**
     * Calculate estimated savings (for internal analytics)
     * Compares tiered pricing vs old linear pricing
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
            newTieredTotal: this.roundToTwoDec(tieredTotal),
            oldLinearTotal: this.roundToTwoDec(oldTotal),
            hourlyTotal: this.roundToTwoDec(hourlyTotal),
            chosenModel: hourlyTotal > tieredTotal ? 'hourly' : 'tiered',
            savingsVsOld: this.roundToTwoDec(oldTotal - tieredTotal),
            savingsPercent: Math.round((oldTotal - tieredTotal) / oldTotal * 100)
        };
    }

    /**
     * Compare prices with and without psychological pricing
     * Useful for understanding the psychological pricing impact
     */
    comparePsychologicalImpact(vehicleType, distance, duration) {
        // Calculate with psychological pricing
        const originalEnabled = this.psychologicalPricing.enabled;
        this.psychologicalPricing.enabled = true;
        const withPsych = this.calculateVehiclePrice(vehicleType, distance, duration);
        
        // Calculate without psychological pricing
        this.psychologicalPricing.enabled = false;
        const withoutPsych = this.calculateVehiclePrice(vehicleType, distance, duration);
        
        // Restore original setting
        this.psychologicalPricing.enabled = originalEnabled;
        
        if (!withPsych || !withoutPsych || withPsych.error || withoutPsych.error) {
            return null;
        }
        
        return {
            originalPrice: withoutPsych.finalPrice,
            psychologicalPrice: withPsych.finalPrice,
            difference: Math.abs(withPsych.finalPrice - withoutPsych.finalPrice),
            perceivedSavings: withoutPsych.finalPrice > withPsych.finalPrice ? 
                `Customer feels they saved $${(withoutPsych.finalPrice - withPsych.finalPrice).toFixed(2)}` :
                `Price increased by $${(withPsych.finalPrice - withoutPsych.finalPrice).toFixed(2)} for better perception`,
            recommendation: withPsych.finalPrice < 50 ? 
                'Price ends in 9 - creates bargain perception' :
                withPsych.finalPrice < 150 ? 
                'Price ends in 5 - professional feel' :
                'Price ends in 9 - maximizes perceived value'
        };
    }

    /**
     * Test psychological pricing with various examples
     */
    testPsychologicalPricing() {
        console.log('🧠 Testing Psychological Pricing\n');
        console.log('Strategy: AUTO (smart selection based on price range)\n');
        
        const testPrices = [23, 47, 73, 127, 247, 523, 1250];
        
        console.log('Original -> Optimized:');
        testPrices.forEach(price => {
            const optimized = this.applyPsychologicalPricing(price);
            const savings = price - optimized;
            console.log(`$${price} -> $${optimized} (${savings > 0 ? 'saves' : 'adds'} $${Math.abs(savings.toFixed(2))})`);
        });
        
        console.log('\n📊 Impact Analysis:');
        console.log('• Prices under $50: End in 9 (bargain perception)');
        console.log('• Prices $50-150: End in 5 (professional)');
        console.log('• Prices $150-500: End in 9 (maximize perceived savings)');
        console.log('• Prices $500+: End in 45/95 (premium positioning)');
    }
}

// Export singleton instance
export const pricingService = new PricingService();

// Export for CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PricingService, pricingService };
}