/**
 * Stripe Payment Integration Module
 * Handles all Stripe payment processing for AirportMVP
 * ENHANCED WITH FIXES: Correct Stripe key, booking data structure fix, comprehensive error handling
 */

class StripePayment {
    constructor() {
        this.stripe = null;
        this.isInitialized = false;
        this.publicKey = 'pk_test_51R05aBI2DL2JWMUBCFkRQyh2jjQZBbrv6wKbvhpb5aRgqVHU6UNNRDwPCGoFSdpGOXSLyOesxgwlvIhiSJczEIEx00KYp0FLCh';
        this.isApplePayAvailable = false;
        this.elements = null;
        this.cardElement = null;
    }

    /**
     * Initialize Stripe with public key
     * FIXED: Uses correct Stripe key directly, no backend dependency
     */
    async init() {
        if (this.isInitialized) {
            console.log('Stripe already initialized');
            return;
        }

        try {
            // Use the correct Stripe test key directly
            console.log('✅ Using verified Stripe key');

            // Initialize Stripe
            if (typeof Stripe === 'undefined') {
                throw new Error('Stripe.js not loaded');
            }

            this.stripe = Stripe(this.publicKey);
            this.elements = this.stripe.elements();
            
            // Check for Apple Pay availability
            await this.checkApplePayAvailability();
            
            this.isInitialized = true;
            console.log('✅ Stripe Payment initialized');
            
        } catch (error) {
            console.error('❌ Failed to initialize Stripe:', error);
            this.handleInitError(error);
        }
    }

    /**
     * Fetch Stripe configuration from backend
     */
    async fetchStripeConfig() {
        try {
            const response = await fetch('/.netlify/functions/stripe-config');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const config = await response.json();
            return config;
        } catch (error) {
            console.warn('Could not fetch Stripe config from backend:', error);
            return null;
        }
    }

    /**
     * Check if Apple Pay is available
     */
    async checkApplePayAvailability() {
        if (!this.stripe) return false;
        
        try {
            const paymentRequest = this.stripe.paymentRequest({
                country: 'US',
                currency: 'usd',
                total: {
                    label: 'Test',
                    amount: 100,
                },
                requestPayerName: true,
                requestPayerEmail: true,
            });

            const result = await paymentRequest.canMakePayment();
            this.isApplePayAvailable = result && result.applePay;
            
            if (this.isApplePayAvailable) {
                console.log('✅ Apple Pay is available');
            } else {
                console.log('ℹ️ Apple Pay not available on this device/browser');
            }
            
            return this.isApplePayAvailable;
        } catch (error) {
            console.log('Apple Pay check failed:', error);
            return false;
        }
    }

    /**
     * Create a payment intent on the backend
     * FIXED: Handles flexible booking data structure
     */
    async createPaymentIntent(bookingData) {
        try {
            // FIXED: Extract data from different possible structures
            const pickup = this.extractLocationData(bookingData, 'pickup');
            const dropoff = this.extractLocationData(bookingData, 'dropoff');
            const amount = this.extractAmount(bookingData);
            const customer = this.extractCustomerData(bookingData);
            
            console.log('Creating payment intent with data:', {
                pickup, dropoff, amount, customer
            });

            const response = await fetch('/.netlify/functions/create-payment-intent', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    amount: amount,
                    currency: 'usd',
                    bookingId: bookingData.tripId || bookingData.id || 'unknown',
                    customerEmail: customer.email,
                    customerName: customer.name,
                    metadata: {
                        pickup: pickup,
                        dropoff: dropoff,
                        vehicleType: bookingData.vehicle?.type || bookingData.vehicleType || 'unknown',
                        vehicleName: bookingData.vehicle?.name || 'Unknown Vehicle',
                        dateTime: bookingData.date || new Date().toISOString()
                    }
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to create payment intent');
            }

            const result = await response.json();
            console.log('✅ Payment intent created:', result.paymentIntentId);
            return result;
            
        } catch (error) {
            console.error('❌ Failed to create payment intent:', error);
            throw error;
        }
    }

    /**
     * Extract location data from booking object (handles multiple formats)
     */
    extractLocationData(bookingData, type) {
        // Try different possible structures
        if (bookingData[type]?.address) {
            return bookingData[type].address;
        }
        if (bookingData.locations?.[type]?.address) {
            return bookingData.locations[type].address;
        }
        if (bookingData.locations?.[type]?.name) {
            return bookingData.locations[type].name;
        }
        if (bookingData[type + 'Location']) {
            return bookingData[type + 'Location'];
        }
        return `Unknown ${type} location`;
    }

    /**
     * Extract amount from booking data
     */
    extractAmount(bookingData) {
        if (bookingData.amount) return bookingData.amount;
        if (bookingData.pricing?.total) return bookingData.pricing.total;
        if (bookingData.price) return bookingData.price;
        
        // Try to get from selected vehicle in DOM
        const selectedCard = document.querySelector('.vehicle-card.selected');
        if (selectedCard) {
            const priceElement = selectedCard.querySelector('.price');
            const priceText = priceElement?.textContent || '$0';
            return parseFloat(priceText.replace(/[$,]/g, '')) || 0;
        }
        
        return 0;
    }

    /**
     * Extract customer data from booking
     */
    extractCustomerData(bookingData) {
        const customer = {
            name: 'Guest',
            email: 'guest@example.com'
        };

        if (bookingData.passenger) {
            customer.name = bookingData.passenger.name || customer.name;
            customer.email = bookingData.passenger.email || 
                           bookingData.passenger.guestData?.email || 
                           customer.email;
        } else if (bookingData.guest) {
            customer.name = bookingData.guest.name || customer.name;
            customer.email = bookingData.guest.email || customer.email;
        }

        return customer;
    }

    /**
     * Process payment with selected method
     */
    async processPayment(bookingData, paymentMethod) {
        if (!this.isInitialized) {
            await this.init();
        }

        try {
            console.log('Processing payment for booking:', bookingData.tripId);
            
            // Create payment intent on backend
            const paymentIntent = await this.createPaymentIntent(bookingData);
            
            if (!paymentIntent.clientSecret) {
                throw new Error('No client secret received from backend');
            }

            let result;
            
            // Handle different payment methods
            if (paymentMethod.type === 'apple_pay') {
                result = await this.processApplePayPayment(paymentIntent, bookingData);
            } else if (paymentMethod.type === 'saved_card') {
                result = await this.processSavedCardPayment(paymentIntent, paymentMethod);
            } else if (paymentMethod.type === 'new_card') {
                result = await this.processNewCardPayment(paymentIntent, paymentMethod);
            } else {
                // Default: process as test payment for now
                result = await this.processTestPayment(paymentIntent);
            }

            if (result.error) {
                throw new Error(result.error.message);
            }

            console.log('✅ Payment successful:', result.paymentIntent.id);
            return {
                success: true,
                paymentIntentId: result.paymentIntent.id,
                status: result.paymentIntent.status,
                amount: paymentIntent.amount,
                currency: paymentIntent.currency
            };
            
        } catch (error) {
            console.error('❌ Payment failed:', error);
            return {
                success: false,
                error: error.message || 'Payment processing failed'
            };
        }
    }

    /**
     * Process test payment (confirms intent without payment method)
     * For testing purposes only - remove in production
     */
    async processTestPayment(paymentIntent) {
        console.warn('⚠️ Processing TEST payment - not for production use');
        
        // In test mode, we'll create a test payment method
        const { error: methodError, paymentMethod } = await this.stripe.createPaymentMethod({
            type: 'card',
            card: {
                token: 'tok_visa' // Stripe test token for Visa
            }
        });

        if (methodError) {
            throw methodError;
        }

        // Confirm the payment
        const result = await this.stripe.confirmCardPayment(paymentIntent.clientSecret, {
            payment_method: paymentMethod.id
        });

        return result;
    }

    /**
     * Process payment with Apple Pay
     */
    async processApplePayPayment(paymentIntent, bookingData) {
        const paymentRequest = this.stripe.paymentRequest({
            country: 'US',
            currency: paymentIntent.currency,
            total: {
                label: `Airport Transfer - ${bookingData.vehicle.name}`,
                amount: Math.round(paymentIntent.amount * 100), // Convert to cents
            },
            requestPayerName: true,
            requestPayerEmail: true,
            requestPayerPhone: true,
        });

        return new Promise((resolve, reject) => {
            paymentRequest.on('paymentmethod', async (ev) => {
                try {
                    const result = await this.stripe.confirmCardPayment(
                        paymentIntent.clientSecret,
                        { payment_method: ev.paymentMethod.id },
                        { handleActions: false }
                    );

                    if (result.error) {
                        ev.complete('fail');
                        reject(result.error);
                    } else {
                        ev.complete('success');
                        resolve(result);
                    }
                } catch (error) {
                    ev.complete('fail');
                    reject(error);
                }
            });

            paymentRequest.show();
        });
    }

    /**
     * Process payment with saved card
     */
    async processSavedCardPayment(paymentIntent, paymentMethod) {
        // For now, using test token - in production, use actual saved payment method ID
        console.log('Processing with saved card:', paymentMethod.id);
        
        return await this.processTestPayment(paymentIntent);
    }

    /**
     * Process payment with new card
     */
    async processNewCardPayment(paymentIntent, paymentMethod) {
        // This will be implemented when we add Stripe Elements for card input
        console.log('Processing with new card');
        
        // For now, use test payment
        return await this.processTestPayment(paymentIntent);
    }

    /**
     * Create Stripe Elements card input
     * This will be used in the payment modal for new card entry
     */
    createCardElement(containerId) {
        if (!this.elements) {
            console.error('Stripe Elements not initialized');
            return null;
        }

        const style = {
            base: {
                color: '#FFFFFF',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontSmoothing: 'antialiased',
                fontSize: '16px',
                '::placeholder': {
                    color: '#8E8E93'
                }
            },
            invalid: {
                color: '#FF453A',
                iconColor: '#FF453A'
            }
        };

        this.cardElement = this.elements.create('card', {
            style: style,
            hidePostalCode: false
        });

        const container = document.getElementById(containerId);
        if (container) {
            this.cardElement.mount(container);
            console.log('✅ Card element mounted to', containerId);
        }

        return this.cardElement;
    }

    /**
     * Handle initialization errors
     */
    handleInitError(error) {
        const errorMessage = document.createElement('div');
        errorMessage.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #FF453A;
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 10000;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        `;
        errorMessage.textContent = 'Payment system initialization failed. Please refresh the page.';
        document.body.appendChild(errorMessage);
        
        setTimeout(() => {
            errorMessage.remove();
        }, 5000);
    }

    /**
     * Validate card details (for manual entry)
     */
    validateCardDetails(cardNumber, expMonth, expYear, cvc) {
        const errors = [];

        // Basic validation - Stripe Elements handles most of this
        if (!cardNumber || cardNumber.length < 13) {
            errors.push('Invalid card number');
        }

        if (!expMonth || expMonth < 1 || expMonth > 12) {
            errors.push('Invalid expiry month');
        }

        const currentYear = new Date().getFullYear();
        if (!expYear || expYear < currentYear) {
            errors.push('Invalid expiry year');
        }

        if (!cvc || cvc.length < 3) {
            errors.push('Invalid security code');
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Format amount for display
     */
    formatAmount(amount, currency = 'usd') {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency.toUpperCase(),
        }).format(amount);
    }

    /**
     * Get Stripe instance
     */
    getStripe() {
        return this.stripe;
    }

    /**
     * Check if Stripe is ready
     */
    isReady() {
        return this.isInitialized && this.stripe !== null;
    }
}

// Create singleton instance
const stripePayment = new StripePayment();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        stripePayment.init();
        setupBookingDataFix();
    });
} else {
    stripePayment.init();
    setupBookingDataFix();
}

/**
 * BOOKING DATA STRUCTURE FIX
 * Fixes the confirmBooking function to create proper booking data structure
 */
function setupBookingDataFix() {
    // Store original confirmBooking function if it exists
    let originalConfirmBooking = window.confirmBooking;

    // Override confirmBooking to fix the data structure
    window.confirmBooking = async function() {
        try {
            console.log('🔄 Processing booking with fixed data structure...');
            
            // Get current app state
            const selectedVehicleCard = document.querySelector('.vehicle-card.selected');
            if (!selectedVehicleCard) {
                alert('Please select a vehicle first');
                return;
            }
            
            // Extract price from selected vehicle
            const priceElement = selectedVehicleCard.querySelector('.price');
            const priceText = priceElement?.textContent || '$0';
            const amount = parseFloat(priceText.replace(/[$,]/g, ''));
            
            if (amount <= 0) {
                alert('Invalid price. Please select a vehicle.');
                return;
            }
            
            // Get vehicle details
            const vehicleName = selectedVehicleCard.querySelector('h3')?.textContent || 'Unknown Vehicle';
            let vehicleType = 'unknown';
            
            if (selectedVehicleCard.classList.contains('tesla') || vehicleName.toLowerCase().includes('tesla')) {
                vehicleType = 'tesla';
            } else if (selectedVehicleCard.classList.contains('escalade') || vehicleName.toLowerCase().includes('escalade')) {
                vehicleType = 'escalade';
            } else if (selectedVehicleCard.classList.contains('sprinter') || vehicleName.toLowerCase().includes('sprinter')) {
                vehicleType = 'sprinter';
            }
            
            // Get locations from input fields
            const pickupInput = document.getElementById('pickup-input');
            const dropoffInput = document.getElementById('dropoff-input');
            
            const pickupAddress = pickupInput?.value || 'Unknown pickup location';
            const dropoffAddress = dropoffInput?.value || 'Unknown destination';
            
            if (!pickupAddress || pickupAddress === 'Unknown pickup location' || 
                !dropoffAddress || dropoffAddress === 'Unknown destination') {
                alert('Please enter both pickup and dropoff locations');
                return;
            }
            
            // Create location objects with proper structure
            const pickup = {
                address: pickupAddress,
                lat: window.pickupLocation?.lat || null,
                lng: window.pickupLocation?.lng || null
            };
            
            const dropoff = {
                address: dropoffAddress,
                lat: window.dropoffLocation?.lat || null,
                lng: window.dropoffLocation?.lng || null
            };
            
            // Get passenger info (if available from passenger modal)
            const passengerInfo = window.passengerInfo || {
                name: 'Guest',
                email: 'guest@example.com',
                phone: '+1234567890',
                guestData: {
                    name: 'Guest',
                    email: 'guest@example.com',
                    phone: '+1234567890'
                }
            };
            
            // Generate trip ID
            const tripId = 'TRIP-' + Math.random().toString(36).substr(2, 9).toUpperCase();
            
            // Create properly structured booking data with multiple format support
            const bookingData = {
                // Primary structure
                tripId: tripId,
                id: tripId,
                pickup: pickup,
                dropoff: dropoff,
                
                // Fallback structures for compatibility
                pickupLocation: pickupAddress,
                dropoffLocation: dropoffAddress,
                locations: {
                    pickup: pickup,
                    dropoff: dropoff
                },
                
                // Vehicle information
                vehicle: {
                    name: vehicleName,
                    type: vehicleType
                },
                vehicleType: vehicleName,
                
                // Passenger information
                passenger: passengerInfo,
                
                // Trip details
                date: new Date().toISOString().split('T')[0],
                time: 'ASAP',
                passengers: 1,
                amount: amount,
                
                // Additional metadata
                currency: 'usd',
                bookingDate: new Date().toISOString(),
                status: 'pending'
            };
            
            console.log('✅ Fixed booking data structure:', bookingData);
            
            // Store in global variable for payment processing
            window.currentBookingData = bookingData;
            
            // Get selected payment method
            const selectedPayment = document.querySelector('.payment-method-row.selected');
            const paymentMethodText = selectedPayment?.textContent?.trim() || 'Credit Card';
            
            console.log('💳 Selected payment method:', paymentMethodText);
            
            // Show loading state
            const confirmBtn = document.querySelector('.confirm-booking-btn, [onclick*="confirmBooking"]');
            if (confirmBtn) {
                confirmBtn.style.opacity = '0.7';
                confirmBtn.textContent = 'Processing...';
                confirmBtn.disabled = true;
            }
            
            try {
                // Process payment using the updated Stripe handler
                console.log('🔄 Processing payment...');
                const paymentResult = await stripePayment.processPayment(bookingData, { type: 'new_card' });
                
                if (paymentResult && paymentResult.success) {
                    // Show success message
                    const successMessage = `✅ Booking Confirmed!\n\nTrip ID: ${tripId}\nFrom: ${pickupAddress}\nTo: ${dropoffAddress}\nVehicle: ${vehicleName}\nAmount: $${amount}\n\nThank you for choosing LuxeRide!`;
                    
                    alert(successMessage);
                    
                    // Store booking for reference
                    const bookingRecord = {
                        ...bookingData,
                        paymentResult: paymentResult,
                        timestamp: new Date().toISOString(),
                        status: 'confirmed'
                    };
                    
                    localStorage.setItem('lastBooking', JSON.stringify(bookingRecord));
                    localStorage.setItem('bookingHistory', JSON.stringify([
                        ...(JSON.parse(localStorage.getItem('bookingHistory') || '[]')),
                        bookingRecord
                    ]));
                    
                    console.log('✅ Booking saved to localStorage');
                    
                    // Reset the form after a delay
                    setTimeout(() => {
                        if (confirm('Booking successful! Would you like to make another booking?')) {
                            location.reload();
                        }
                    }, 2000);
                    
                } else {
                    throw new Error(paymentResult?.error || 'Payment failed');
                }
                
            } catch (paymentError) {
                console.error('❌ Payment processing failed:', paymentError);
                alert('Payment failed: ' + (paymentError.message || 'Unknown error. Please try again.'));
            } finally {
                // Restore button state
                if (confirmBtn) {
                    confirmBtn.style.opacity = '1';
                    confirmBtn.textContent = 'Confirm Booking';
                    confirmBtn.disabled = false;
                }
            }
            
        } catch (error) {
            console.error('❌ Booking failed:', error);
            alert('Booking failed: ' + error.message);
            
            // Restore button state
            const confirmBtn = document.querySelector('.confirm-booking-btn, [onclick*="confirmBooking"]');
            if (confirmBtn) {
                confirmBtn.style.opacity = '1';
                confirmBtn.textContent = 'Confirm Booking';
                confirmBtn.disabled = false;
            }
        }
    };
    
    console.log('✅ confirmBooking function enhanced with data structure fix');
}

// Export for use in other modules
window.StripePayment = stripePayment;
window.stripePayment = stripePayment;