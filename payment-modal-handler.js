/**
 * iOS-Style Payment Modal Handler
 * Matches the passenger selector behavior and styling
 */

class PaymentModalHandler {
    constructor() {
        this.stripe = null;
        this.selectedMethod = null;
        this.savedCards = [];
        this.applePayAvailable = false;
        this.paymentRequest = null;
        this.isOpen = false;
    }

    async init() {
        try {
            // Load Stripe
            if (!window.Stripe) {
                await this.loadStripeScript();
            }

            // Initialize with your Stripe public key
            this.stripe = window.Stripe('pk_test_YOUR_STRIPE_PUBLIC_KEY');
            
            // Check Apple Pay availability
            await this.checkApplePayAvailability();
            
            // Load saved cards
            this.loadSavedCards();
            
            console.log('Payment modal handler initialized');
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
            this.paymentRequest = this.stripe.paymentRequest({
                country: 'US',
                currency: 'usd',
                total: {
                    label: 'LuxeRide Airport Transfer',
                    amount: 0,
                },
                requestPayerName: true,
                requestPayerEmail: true,
                requestPayerPhone: true,
            });

            const result = await this.paymentRequest.canMakePayment();
            this.applePayAvailable = !!(result && result.applePay);
            
            return this.applePayAvailable;
        } catch (error) {
            console.error('Apple Pay check error:', error);
            return false;
        }
    }

    loadSavedCards() {
        const saved = localStorage.getItem('savedCards');
        if (saved) {
            this.savedCards = JSON.parse(saved);
        } else {
            // Default demo cards
            this.savedCards = [
                { id: '1', brand: 'visa', last4: '1187', isDefault: true }
            ];
        }
    }

    openPaymentModal() {
        if (this.isOpen) return;
        
        // Check if modal already exists
        let modal = document.getElementById('paymentSelectorModal');
        if (modal) {
            modal.remove();
        }

        // Create modal HTML with iOS-style design
        modal = document.createElement('div');
        modal.id = 'paymentSelectorModal';
        modal.className = 'ios-modal';
        modal.innerHTML = `
            <div class="ios-modal-overlay" onclick="window.paymentModalHandler.closeModal()"></div>
            <div class="ios-modal-sheet">
                <div class="ios-modal-header">
                    <button class="ios-modal-close" onclick="window.paymentModalHandler.closeModal()">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M19 12H5M12 19l-7-7 7-7"/>
                        </svg>
                    </button>
                    <h2 class="ios-modal-title">Payment</h2>
                    <button class="ios-modal-add" onclick="window.paymentModalHandler.showAddCard()">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                </div>
                
                <div class="ios-modal-body">
                    <div class="payment-section-title">Personal payment methods</div>
                    
                    <div class="payment-methods-list">
                        ${this.savedCards.map(card => `
                            <div class="payment-method-item" data-method="card-${card.id}" onclick="window.paymentModalHandler.selectMethod(this)">
                                <div class="payment-method-icon">
                                    ${this.getCardIcon(card.brand)}
                                </div>
                                <div class="payment-method-details">
                                    <span class="payment-method-name">${this.formatCardBrand(card.brand)}, •••• ${card.last4}</span>
                                </div>
                                <div class="payment-method-check ${card.isDefault ? 'selected' : ''}">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                        <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                </div>
                            </div>
                        `).join('')}
                        
                        ${this.applePayAvailable ? `
                            <div class="payment-method-item" data-method="apple-pay" onclick="window.paymentModalHandler.selectMethod(this)">
                                <div class="payment-method-icon">
                                    <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iYmxhY2siLz4KPHBhdGggZD0iTTE2LjUgMjJDMTYuNSAyMiAxNi41IDI0LjUgMTguNSAyNC41QzIwLjUgMjQuNSAyMC41IDIyIDIwLjUgMjJWMThDMjAuNSAxOCAyMC41IDE1LjUgMTguNSAxNS41QzE2LjUgMTUuNSAxNi41IDE4IDE2LjUgMThWMjJaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4=" alt="Apple Pay">
                                </div>
                                <div class="payment-method-details">
                                    <span class="payment-method-name">Apple Pay</span>
                                </div>
                                <div class="payment-method-check">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                                        <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                </div>
                            </div>
                        ` : ''}
                    </div>
                </div>
                
                <div class="ios-modal-footer">
                    <button class="ios-continue-btn" onclick="window.paymentModalHandler.confirmSelection()">
                        Continue
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Add slide-up animation
        requestAnimationFrame(() => {
            modal.classList.add('show');
            this.isOpen = true;
        });

        // Set default selection
        if (this.selectedMethod) {
            const selectedItem = modal.querySelector(`[data-method="${this.selectedMethod}"]`);
            if (selectedItem) {
                this.selectMethod(selectedItem);
            }
        } else if (this.savedCards.length > 0) {
            const defaultCard = this.savedCards.find(c => c.isDefault);
            if (defaultCard) {
                const defaultItem = modal.querySelector(`[data-method="card-${defaultCard.id}"]`);
                if (defaultItem) {
                    this.selectMethod(defaultItem);
                }
            }
        }
    }

    selectMethod(element) {
        // Remove previous selection
        document.querySelectorAll('.payment-method-check').forEach(check => {
            check.classList.remove('selected');
        });

        // Add selection to clicked item
        element.querySelector('.payment-method-check').classList.add('selected');
        this.selectedMethod = element.dataset.method;
    }

    async confirmSelection() {
        if (!this.selectedMethod) return;

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
            paymentDetails.textContent = 'Apple Pay';
            if (cardIcon) {
                cardIcon.innerHTML = `<img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyUzYuNDggMjIgMTIgMjJTMjIgMTcuNTIgMjIgMTJTMTcuNTIgMiAxMiAyWiIgZmlsbD0iYmxhY2siLz4KPC9zdmc+" style="width: 24px; height: 24px;">`;
            }
        } else if (this.selectedMethod.startsWith('card-')) {
            const cardId = this.selectedMethod.replace('card-', '');
            const card = this.savedCards.find(c => c.id === cardId);
            if (card) {
                paymentDetails.textContent = `${this.formatCardBrand(card.brand)}, •••• ${card.last4}`;
                if (cardIcon) cardIcon.textContent = card.brand.toUpperCase();
            }
        }
    }

    showAddCard() {
        // Implementation for adding new card
        alert('Add new card functionality coming soon');
    }

    closeModal() {
        const modal = document.getElementById('paymentSelectorModal');
        if (modal && this.isOpen) {
            modal.classList.remove('show');
            this.isOpen = false;
            setTimeout(() => modal.remove(), 300);
        }
    }

    getCardIcon(brand) {
        const icons = {
            'visa': `<div class="card-brand-icon visa">VISA</div>`,
            'mastercard': `<div class="card-brand-icon mastercard">MC</div>`,
            'amex': `<div class="card-brand-icon amex">AMEX</div>`,
            'discover': `<div class="card-brand-icon discover">DISC</div>`
        };
        return icons[brand] || `<div class="card-brand-icon">${brand.toUpperCase()}</div>`;
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
        // Apple Pay processing logic
        this.paymentRequest.update({
            total: {
                label: `LuxeRide - ${bookingData.vehicle.name}`,
                amount: Math.round(amount * 100),
            },
        });

        return new Promise((resolve, reject) => {
            this.paymentRequest.on('paymentmethod', async (ev) => {
                try {
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
window.paymentModalHandler = new PaymentModalHandler();

// Update the selectPaymentMethod function
window.selectPaymentMethod = function() {
    if (!window.paymentModalHandler) {
        window.paymentModalHandler = new PaymentModalHandler();
    }
    window.paymentModalHandler.openPaymentModal();
};