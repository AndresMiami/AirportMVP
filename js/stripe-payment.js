/**
 * Stripe Payment Integration Module
 * Handles all Stripe payment processing for AirportMVP
 */

class StripePayment {
    constructor() {
        this.stripe = null;
        this.isInitialized = false;
        this.publicKey = null;
        this.isApplePayAvailable = false;
        this.elements = null;
        this.cardElement = null;
    }

    /**
     * Initialize Stripe with public key
     * Fetches key from backend or uses test key
     */
    async init() {
        if (this.isInitialized) {
            console.log('Stripe already initialized');
            return;
        }

        try {
            // Try to fetch public key from backend
            const config = await this.fetchStripeConfig();
            
            if (config && config.publicKey && !config.publicKey.includes('YOUR_STRIPE')) {
                this.publicKey = config.publicKey;
                console.log('✅ Using Stripe key from backend');
            } else {
                // Use your Stripe test key
                // This is safe to use in frontend code (it's a publishable key)
                this.publicKey = 'pk_test_51R05aBI2DL2JWMUBCFkRQyh2jjQZBbrv6wKbvhpb5aRgqVHU6UNNRDwPCGoFSdpGOXSLyOesxgwlvIhiSJczEIEx00KYp0FLCh';
                console.warn('⚠️ Using hardcoded test key - configure backend for production');
            }

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
     */
    async createPaymentIntent(bookingData) {
        try {
            const response = await fetch('/.netlify/functions/create-payment-intent', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    amount: bookingData.pricing.total,
                    currency: 'usd',
                    bookingId: bookingData.tripId,
                    customerEmail: bookingData.guest?.email || '',
                    customerName: bookingData.guest?.name || 'Guest',
                    metadata: {
                        pickup: bookingData.locations.pickup.address,
                        dropoff: bookingData.locations.dropoff.name,
                        vehicleType: bookingData.vehicle.type,
                        dateTime: bookingData.dateTime.display
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
    });
} else {
    stripePayment.init();
}

// Export for use in other modules
window.StripePayment = stripePayment;