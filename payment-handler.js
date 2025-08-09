/**
 * Payment Handler with Apple Pay Integration
 * Maintains existing UI while adding Stripe payment processing
 */

class PaymentHandler {
    constructor() {
        this.stripe = null;
        this.selectedMethod = null;
        this.savedCards = [];
        this.applePayAvailable = false;
        this.paymentRequest = null;
    }

    async init() {
        try {
            // Load Stripe
            if (!window.Stripe) {
                await this.loadStripeScript();
            }

            // Initialize with your Stripe public key
            // This should come from your environment config
            this.stripe = window.Stripe('pk_test_YOUR_STRIPE_PUBLIC_KEY');
            
            // Check Apple Pay availability
            await this.checkApplePayAvailability();
            
            // Load saved cards (from localStorage or backend)
            this.loadSavedCards();
            
            console.log('Payment handler initialized');
            return true;
        } catch (error) {
            console.error('Payment initialization error:', error);
            return false;
        }
    }

    loadStripeScript() {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://js.stripe.com/v3/';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    async checkApplePayAvailability() {
        if (!this.stripe) return false;

        try {
            // Create a payment request to check Apple Pay availability
            this.paymentRequest = this.stripe.paymentRequest({
                country: 'US',
                currency: 'usd',
                total: {
                    label: 'LuxeRide Airport Transfer',
                    amount: 0, // Will be updated when actual payment is made
                },
                requestPayerName: true,
                requestPayerEmail: true,
                requestPayerPhone: true,
            });

            const result = await this.paymentRequest.canMakePayment();
            this.applePayAvailable = !!(result && result.applePay);
            
            if (this.applePayAvailable) {
                console.log('Apple Pay is available');
            }
            
            return this.applePayAvailable;
        } catch (error) {
            console.error('Apple Pay check error:', error);
            return false;
        }
    }

    loadSavedCards() {
        // Load from localStorage or backend
        const saved = localStorage.getItem('savedCards');
        if (saved) {
            this.savedCards = JSON.parse(saved);
        } else {
            // Default demo cards
            this.savedCards = [
                { id: '1', brand: 'visa', last4: '1187', isDefault: true },
                { id: '2', brand: 'mastercard', last4: '2945', isDefault: false }
            ];
        }
    }

    showPaymentModal() {
        // Check if modal already exists
        let modal = document.getElementById('paymentModal');
        if (modal) {
            modal.remove();
        }

        // Create modal HTML
        modal = document.createElement('div');
        modal.id = 'paymentModal';
        modal.className = 'payment-modal';
        modal.innerHTML = `
            <div class="payment-modal-overlay" onclick="window.paymentHandler.closeModal()"></div>
            <div class="payment-modal-content">
                <div class="payment-modal-header">
                    <h3>Payment Method</h3>
                    <button class="close-btn" onclick="window.paymentHandler.closeModal()">✕</button>
                </div>
                <div class="payment-modal-body">
                    <div class="payment-options">
                        ${this.applePayAvailable ? `
                            <div class="payment-option apple-pay-option" data-method="apple-pay">
                                <span class="payment-icon">🍎</span>
                                <span class="payment-label">Apple Pay</span>
                                <span class="recommended-badge">Recommended</span>
                                <span class="payment-check">✓</span>
                            </div>
                        ` : ''}
                        
                        ${this.savedCards.map(card => `
                            <div class="payment-option" data-method="card-${card.id}">
                                <span class="payment-icon">💳</span>
                                <span class="payment-label">${this.formatCardBrand(card.brand)} •••• ${card.last4}</span>
                                ${card.isDefault ? '<span class="default-badge">Default</span>' : ''}
                                <span class="payment-check">✓</span>
                            </div>
                        `).join('')}
                        
                        <div class="payment-option add-card-option" data-method="add-card">
                            <span class="payment-icon">➕</span>
                            <span class="payment-label">Add New Card</span>
                            <span class="payment-check">✓</span>
                        </div>
                    </div>
                </div>
                <div class="payment-modal-footer">
                    <button class="select-payment-btn" onclick="window.paymentHandler.confirmSelection()">
                        Select Payment Method
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Add event listeners
        const options = modal.querySelectorAll('.payment-option');
        options.forEach(option => {
            option.addEventListener('click', () => this.selectPaymentOption(option));
        });

        // Show modal with animation
        requestAnimationFrame(() => {
            modal.classList.add('show');
        });
    }

    selectPaymentOption(option) {
        // Remove previous selection
        document.querySelectorAll('.payment-option').forEach(opt => {
            opt.classList.remove('selected');
        });

        // Add selection to clicked option
        option.classList.add('selected');
        this.selectedMethod = option.dataset.method;

        // Enable confirm button
        document.querySelector('.select-payment-btn').disabled = false;
    }

    async confirmSelection() {
        if (!this.selectedMethod) return;

        if (this.selectedMethod === 'add-card') {
            this.showAddCardForm();
            return;
        }

        // Update the payment display in the main UI
        this.updatePaymentDisplay();
        
        // Close modal
        this.closeModal();
    }

    updatePaymentDisplay() {
        const paymentDetails = document.querySelector('.payment-details');
        const cardIcon = document.querySelector('.card-icon');
        
        if (!paymentDetails) return;

        if (this.selectedMethod === 'apple-pay') {
            paymentDetails.textContent = '🍎 Apple Pay';
            if (cardIcon) cardIcon.textContent = '🍎';
        } else if (this.selectedMethod.startsWith('card-')) {
            const cardId = this.selectedMethod.replace('card-', '');
            const card = this.savedCards.find(c => c.id === cardId);
            if (card) {
                paymentDetails.textContent = `${this.formatCardBrand(card.brand)}, •••• ${card.last4}`;
                if (cardIcon) cardIcon.textContent = card.brand.toUpperCase();
            }
        }
    }

    showAddCardForm() {
        const modalBody = document.querySelector('.payment-modal-body');
        modalBody.innerHTML = `
            <div class="add-card-form">
                <div id="card-element"></div>
                <div class="card-errors" id="card-errors"></div>
                <button class="save-card-btn" onclick="window.paymentHandler.saveNewCard()">
                    Save Card
                </button>
                <button class="payment-back-btn" onclick="window.paymentHandler.showPaymentModal()">
                    ← Back
                </button>
            </div>
        `;

        // Mount Stripe card element
        const elements = this.stripe.elements({
            appearance: {
                theme: 'night',
                variables: {
                    colorPrimary: '#000000',
                    colorBackground: '#ffffff',
                    colorText: '#000000',
                    borderRadius: '8px',
                }
            }
        });

        const cardElement = elements.create('card', {
            style: {
                base: {
                    fontSize: '16px',
                    color: '#000000',
                    '::placeholder': {
                        color: '#aab7c4',
                    },
                },
            },
        });

        cardElement.mount('#card-element');
        this.cardElement = cardElement;

        // Handle errors
        cardElement.on('change', (event) => {
            const displayError = document.getElementById('card-errors');
            if (event.error) {
                displayError.textContent = event.error.message;
            } else {
                displayError.textContent = '';
            }
        });
    }

    async saveNewCard() {
        // Create payment method with Stripe
        const {paymentMethod, error} = await this.stripe.createPaymentMethod({
            type: 'card',
            card: this.cardElement,
        });

        if (error) {
            document.getElementById('card-errors').textContent = error.message;
            return;
        }

        // Save to backend or localStorage
        const newCard = {
            id: paymentMethod.id,
            brand: paymentMethod.card.brand,
            last4: paymentMethod.card.last4,
            isDefault: this.savedCards.length === 0
        };

        this.savedCards.push(newCard);
        localStorage.setItem('savedCards', JSON.stringify(this.savedCards));

        // Select the new card
        this.selectedMethod = `card-${newCard.id}`;
        this.updatePaymentDisplay();
        this.closeModal();
    }

    closeModal() {
        const modal = document.getElementById('paymentModal');
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => modal.remove(), 300);
        }
    }

    formatCardBrand(brand) {
        const brands = {
            'visa': 'Visa',
            'mastercard': 'Mastercard',
            'amex': 'American Express',
            'discover': 'Discover'
        };
        return brands[brand] || brand;
    }

    async processPayment(amount, bookingData) {
        if (!this.selectedMethod) {
            throw new Error('No payment method selected');
        }

        if (this.selectedMethod === 'apple-pay') {
            return await this.processApplePay(amount, bookingData);
        } else {
            return await this.processCardPayment(amount, bookingData);
        }
    }

    async processApplePay(amount, bookingData) {
        // Update payment request with actual amount
        this.paymentRequest.update({
            total: {
                label: `LuxeRide - ${bookingData.vehicle.name}`,
                amount: Math.round(amount * 100), // Convert to cents
            },
        });

        return new Promise((resolve, reject) => {
            this.paymentRequest.on('paymentmethod', async (ev) => {
                try {
                    // Create payment intent on backend
                    const response = await fetch('/.netlify/functions/create-payment-intent', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            amount: amount,
                            paymentMethodId: ev.paymentMethod.id,
                            bookingId: bookingData.tripId,
                            customerEmail: ev.payerEmail,
                            customerName: ev.payerName,
                        }),
                    });

                    const result = await response.json();

                    if (result.success) {
                        ev.complete('success');
                        resolve(result);
                    } else {
                        ev.complete('fail');
                        reject(new Error(result.error));
                    }
                } catch (error) {
                    ev.complete('fail');
                    reject(error);
                }
            });

            this.paymentRequest.show();
        });
    }

    async processCardPayment(amount, bookingData) {
        const cardId = this.selectedMethod.replace('card-', '');
        
        // Create payment intent on backend
        const response = await fetch('/.netlify/functions/create-payment-intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                amount: amount,
                paymentMethodId: cardId,
                bookingId: bookingData.tripId,
                customerEmail: bookingData.passenger.guestData?.email,
                customerName: bookingData.passenger.name,
            }),
        });

        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.error || 'Payment failed');
        }

        return result;
    }
}

// Initialize and expose globally
window.paymentHandler = new PaymentHandler();

// Update the selectPaymentMethod function
window.selectPaymentMethod = function() {
    if (!window.paymentHandler) {
        window.paymentHandler = new PaymentHandler();
    }
    window.paymentHandler.showPaymentModal();
};