/**
 * Payment Modal Controller
 * Matches passenger modal style and behavior with credit card validation
 */

class PaymentModalController {
    constructor() {
        this.selectedPayment = null;
        this.savedCards = [];
        this.applePayAvailable = false;
        this.stripe = null;
        this.isInitialized = false;
        
        // Credit card validation patterns
        this.cardPatterns = {
            visa: /^4[0-9]{12}(?:[0-9]{3})?$/,
            mastercard: /^5[1-5][0-9]{14}$/,
            amex: /^3[47][0-9]{13}$/,
            discover: /^6(?:011|5[0-9]{2})[0-9]{12}$/,
            diners: /^3(?:0[0-5]|[68][0-9])[0-9]{11}$/,
            jcb: /^(?:2131|1800|35\d{3})\d{11}$/
        };
        
        // Luhn algorithm for card validation
        this.luhnCheck = (cardNumber) => {
            const digits = cardNumber.replace(/\D/g, '');
            let sum = 0;
            let isEven = false;
            
            for (let i = digits.length - 1; i >= 0; i--) {
                let digit = parseInt(digits[i], 10);
                
                if (isEven) {
                    digit *= 2;
                    if (digit > 9) {
                        digit -= 9;
                    }
                }
                
                sum += digit;
                isEven = !isEven;
            }
            
            return sum % 10 === 0;
        };
    }

    async init() {
        if (this.isInitialized) return true;
        
        try {
            // Load saved cards
            this.loadSavedCards();
            
            // Check Apple Pay availability
            await this.checkApplePayAvailability();
            
            // Initialize Stripe if available
            if (window.Stripe) {
                this.stripe = window.Stripe('pk_test_YOUR_STRIPE_PUBLIC_KEY');
            }
            
            this.isInitialized = true;
            console.log('Payment modal controller initialized');
            return true;
        } catch (error) {
            console.error('Payment initialization error:', error);
            return false;
        }
    }

    loadSavedCards() {
        const saved = localStorage.getItem('savedPaymentMethods');
        if (saved) {
            this.savedCards = JSON.parse(saved);
        } else {
            // Default demo card
            this.savedCards = [
                { 
                    id: '1', 
                    brand: 'visa', 
                    last4: '1187', 
                    isDefault: true,
                    expiryMonth: '12',
                    expiryYear: '25'
                }
            ];
        }
    }

    async checkApplePayAvailability() {
        // Check if running in Safari and Apple Pay is available
        if (window.ApplePaySession && ApplePaySession.canMakePayments()) {
            this.applePayAvailable = true;
        }
        
        // Also check via Stripe if available
        if (this.stripe && this.stripe.paymentRequest) {
            try {
                const pr = this.stripe.paymentRequest({
                    country: 'US',
                    currency: 'usd',
                    total: { label: 'Test', amount: 100 },
                    requestPayerName: true,
                    requestPayerEmail: true,
                });
                
                const result = await pr.canMakePayment();
                if (result && result.applePay) {
                    this.applePayAvailable = true;
                }
            } catch (e) {
                console.log('Apple Pay check via Stripe failed:', e);
            }
        }
    }

    open() {
        if (!this.isInitialized) {
            this.init().then(() => this.showModal());
        } else {
            this.showModal();
        }
    }

    showModal() {
        // Check if modal already exists
        let modal = document.getElementById('paymentSelectionModal');
        if (modal) {
            modal.style.display = 'flex';
            return;
        }

        // Create modal HTML matching passenger modal structure
        modal = document.createElement('div');
        modal.id = 'paymentSelectionModal';
        modal.className = 'full-modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-panel payment-modal-panel">
                <div class="modal-header-section">
                    <button class="modal-back-btn" onclick="PaymentModalController.getInstance().close()">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M19 12H5M12 19l-7-7 7-7"/>
                        </svg>
                    </button>
                    <h2 class="modal-title">Payment</h2>
                    <button class="modal-add-btn" onclick="PaymentModalController.getInstance().openAddCard()">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                </div>
                
                <div class="modal-content-section">
                    <div class="payment-section-label">Personal payment methods</div>
                    
                    <div class="payment-methods-list">
                        ${this.savedCards.map(card => `
                            <div class="payment-method-row" data-payment-id="card-${card.id}" onclick="PaymentModalController.getInstance().selectPayment(this)">
                                <div class="payment-method-icon">
                                    ${this.getCardIcon(card.brand)}
                                </div>
                                <div class="payment-method-info">
                                    <span class="payment-method-name">${this.formatCardBrand(card.brand)}, •••• ${card.last4}</span>
                                    ${card.expiryMonth ? `<span class="payment-method-expiry">Expires ${card.expiryMonth}/${card.expiryYear}</span>` : ''}
                                </div>
                                <div class="payment-method-check ${card.isDefault ? 'selected' : ''}">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="3">
                                        <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                </div>
                            </div>
                        `).join('')}
                        
                        ${this.applePayAvailable ? `
                            <div class="payment-method-row" data-payment-id="apple-pay" onclick="PaymentModalController.getInstance().selectPayment(this)">
                                <div class="payment-method-icon">
                                    <div class="apple-pay-icon">🍎 Pay</div>
                                </div>
                                <div class="payment-method-info">
                                    <span class="payment-method-name">Apple Pay</span>
                                    <span class="payment-method-expiry">Quick and secure</span>
                                </div>
                                <div class="payment-method-check">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="3">
                                        <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                </div>
                            </div>
                        ` : ''}
                    </div>
                    
                    <div class="modal-action-section">
                        <button class="primary-action-btn" id="paymentContinueBtn" onclick="PaymentModalController.getInstance().confirmPayment()">
                            Continue
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        
        // Set default selection
        if (this.savedCards.length > 0) {
            const defaultCard = this.savedCards.find(c => c.isDefault);
            if (defaultCard) {
                const defaultRow = modal.querySelector(`[data-payment-id="card-${defaultCard.id}"]`);
                if (defaultRow) {
                    this.selectPayment(defaultRow);
                }
            }
        }
    }

    selectPayment(element) {
        // Remove all selections
        document.querySelectorAll('.payment-method-check').forEach(check => {
            check.classList.remove('selected');
        });
        
        // Add selection to clicked element
        element.querySelector('.payment-method-check').classList.add('selected');
        this.selectedPayment = element.dataset.paymentId;
        
        // Enable continue button
        const continueBtn = document.getElementById('paymentContinueBtn');
        if (continueBtn) {
            continueBtn.classList.add('active');
        }
    }

    confirmPayment() {
        if (!this.selectedPayment) return;
        
        // Update main UI
        this.updateMainPaymentDisplay();
        
        // Close modal
        this.close();
    }

    updateMainPaymentDisplay() {
        const paymentBtn = document.querySelector('.payment-method-mobile');
        if (!paymentBtn) return;
        
        const paymentDetails = paymentBtn.querySelector('.payment-details');
        const cardIcon = paymentBtn.querySelector('.card-icon');
        
        if (this.selectedPayment === 'apple-pay') {
            if (paymentDetails) paymentDetails.textContent = 'Apple Pay';
            if (cardIcon) cardIcon.innerHTML = '🍎';
        } else if (this.selectedPayment.startsWith('card-')) {
            const cardId = this.selectedPayment.replace('card-', '');
            const card = this.savedCards.find(c => c.id === cardId);
            if (card && paymentDetails) {
                paymentDetails.textContent = `${this.formatCardBrand(card.brand)}, •••• ${card.last4}`;
                if (cardIcon) cardIcon.textContent = card.brand.toUpperCase();
            }
        }
    }

    openAddCard() {
        const existingModal = document.getElementById('addCardModal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = document.createElement('div');
        modal.id = 'addCardModal';
        modal.className = 'full-modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-panel card-input-panel">
                <div class="modal-header-section">
                    <button class="modal-back-btn" onclick="PaymentModalController.getInstance().closeAddCard()">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M19 12H5M12 19l-7-7 7-7"/>
                        </svg>
                    </button>
                    <h2 class="modal-title">Add Card</h2>
                    <div style="width: 44px;"></div>
                </div>
                
                <div class="modal-content-section">
                    <form id="addCardForm" onsubmit="PaymentModalController.getInstance().saveCard(event)">
                        <div class="form-group">
                            <label class="form-label">Cardholder Name</label>
                            <input type="text" 
                                   id="cardholderName" 
                                   class="form-input" 
                                   placeholder="John Doe" 
                                   required
                                   pattern="[a-zA-Z\\s]{3,}"
                                   title="Please enter a valid name">
                        </div>
                        
                        <div class="form-group">
                            <label class="form-label">Card Number</label>
                            <div class="input-with-icon">
                                <input type="text" 
                                       id="cardNumber" 
                                       class="form-input" 
                                       placeholder="•••• •••• •••• ••••" 
                                       maxlength="19"
                                       required
                                       onkeyup="PaymentModalController.getInstance().handleCardInput(this)">
                                <div class="card-type-indicator" id="cardTypeIndicator"></div>
                            </div>
                            <div class="input-error" id="cardNumberError"></div>
                        </div>
                        
                        <div class="form-row">
                            <div class="form-group half">
                                <label class="form-label">Expiry Date</label>
                                <input type="text" 
                                       id="expiryDate" 
                                       class="form-input" 
                                       placeholder="MM/YY" 
                                       maxlength="5"
                                       required
                                       onkeyup="PaymentModalController.getInstance().handleExpiryInput(this)">
                                <div class="input-error" id="expiryError"></div>
                            </div>
                            
                            <div class="form-group half">
                                <label class="form-label">CVV</label>
                                <input type="text" 
                                       id="cvv" 
                                       class="form-input" 
                                       placeholder="•••" 
                                       maxlength="4"
                                       required
                                       pattern="[0-9]{3,4}"
                                       onkeyup="PaymentModalController.getInstance().handleCvvInput(this)">
                                <div class="input-error" id="cvvError"></div>
                            </div>
                        </div>
                        
                        <div class="card-security-info">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" stroke-width="2">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            </svg>
                            <span>Your card information is encrypted and secure</span>
                        </div>
                        
                        <button type="submit" class="primary-action-btn" id="saveCardBtn" disabled>
                            Add Card
                        </button>
                    </form>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        
        // Focus first input
        setTimeout(() => {
            document.getElementById('cardholderName').focus();
        }, 100);
    }

    handleCardInput(input) {
        let value = input.value.replace(/\s/g, '');
        
        // Format with spaces every 4 digits
        let formatted = value.match(/.{1,4}/g)?.join(' ') || value;
        input.value = formatted;
        
        // Detect card type
        const cardType = this.detectCardType(value);
        this.updateCardTypeIndicator(cardType);
        
        // Validate card number
        const isValid = this.validateCardNumber(value);
        const errorElement = document.getElementById('cardNumberError');
        
        if (value.length >= 13) {
            if (isValid) {
                errorElement.textContent = '';
                input.classList.remove('error');
            } else {
                errorElement.textContent = 'Invalid card number';
                input.classList.add('error');
            }
        } else {
            errorElement.textContent = '';
            input.classList.remove('error');
        }
        
        this.validateForm();
    }

    handleExpiryInput(input) {
        let value = input.value.replace(/\D/g, '');
        
        // Auto-format MM/YY
        if (value.length >= 2) {
            value = value.slice(0, 2) + '/' + value.slice(2, 4);
        }
        input.value = value;
        
        // Validate expiry
        const errorElement = document.getElementById('expiryError');
        if (value.length === 5) {
            const month = parseInt(value.slice(0, 2));
            const year = parseInt('20' + value.slice(3, 5));
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth() + 1;
            
            if (month < 1 || month > 12) {
                errorElement.textContent = 'Invalid month';
                input.classList.add('error');
            } else if (year < currentYear || (year === currentYear && month < currentMonth)) {
                errorElement.textContent = 'Card expired';
                input.classList.add('error');
            } else {
                errorElement.textContent = '';
                input.classList.remove('error');
            }
        } else {
            errorElement.textContent = '';
            input.classList.remove('error');
        }
        
        this.validateForm();
    }

    handleCvvInput(input) {
        input.value = input.value.replace(/\D/g, '');
        
        const errorElement = document.getElementById('cvvError');
        const cardNumber = document.getElementById('cardNumber').value.replace(/\s/g, '');
        const isAmex = cardNumber.startsWith('3');
        const requiredLength = isAmex ? 4 : 3;
        
        if (input.value.length === requiredLength) {
            errorElement.textContent = '';
            input.classList.remove('error');
        } else if (input.value.length > 0) {
            errorElement.textContent = `CVV must be ${requiredLength} digits`;
            input.classList.add('error');
        }
        
        this.validateForm();
    }

    detectCardType(cardNumber) {
        const patterns = {
            visa: /^4/,
            mastercard: /^5[1-5]/,
            amex: /^3[47]/,
            discover: /^6(?:011|5)/,
            diners: /^3(?:0[0-5]|[68])/,
            jcb: /^(?:2131|1800|35)/
        };
        
        for (const [type, pattern] of Object.entries(patterns)) {
            if (pattern.test(cardNumber)) {
                return type;
            }
        }
        
        return null;
    }

    updateCardTypeIndicator(cardType) {
        const indicator = document.getElementById('cardTypeIndicator');
        if (!indicator) return;
        
        const icons = {
            visa: '<span style="color: #1A1F71; font-weight: bold;">VISA</span>',
            mastercard: '<span style="color: #EB001B;">MC</span>',
            amex: '<span style="color: #006FCF;">AMEX</span>',
            discover: '<span style="color: #FF6600;">DISC</span>',
            diners: '<span style="color: #0079BE;">DC</span>',
            jcb: '<span style="color: #003A70;">JCB</span>'
        };
        
        indicator.innerHTML = icons[cardType] || '';
    }

    validateCardNumber(cardNumber) {
        // Remove spaces and validate length
        const cleaned = cardNumber.replace(/\s/g, '');
        if (cleaned.length < 13 || cleaned.length > 19) {
            return false;
        }
        
        // Check if it matches a known pattern
        let matchesPattern = false;
        for (const pattern of Object.values(this.cardPatterns)) {
            if (pattern.test(cleaned)) {
                matchesPattern = true;
                break;
            }
        }
        
        if (!matchesPattern) {
            return false;
        }
        
        // Luhn algorithm check
        return this.luhnCheck(cleaned);
    }

    validateForm() {
        const name = document.getElementById('cardholderName').value;
        const number = document.getElementById('cardNumber').value.replace(/\s/g, '');
        const expiry = document.getElementById('expiryDate').value;
        const cvv = document.getElementById('cvv').value;
        const saveBtn = document.getElementById('saveCardBtn');
        
        const isAmex = number.startsWith('3');
        const cvvLength = isAmex ? 4 : 3;
        
        const isValid = 
            name.length >= 3 &&
            this.validateCardNumber(number) &&
            expiry.length === 5 &&
            cvv.length === cvvLength &&
            !document.querySelector('.form-input.error');
        
        if (saveBtn) {
            saveBtn.disabled = !isValid;
        }
    }

    saveCard(event) {
        event.preventDefault();
        
        const name = document.getElementById('cardholderName').value;
        const number = document.getElementById('cardNumber').value;
        const expiry = document.getElementById('expiryDate').value;
        const last4 = number.slice(-4);
        const cardType = this.detectCardType(number.replace(/\s/g, ''));
        
        const newCard = {
            id: Date.now().toString(),
            brand: cardType || 'card',
            last4: last4,
            name: name,
            expiryMonth: expiry.slice(0, 2),
            expiryYear: expiry.slice(3, 5),
            isDefault: this.savedCards.length === 0
        };
        
        this.savedCards.push(newCard);
        localStorage.setItem('savedPaymentMethods', JSON.stringify(this.savedCards));
        
        // Close add card modal and refresh payment modal
        this.closeAddCard();
        this.close();
        setTimeout(() => this.open(), 100);
        
        // Select the new card
        setTimeout(() => {
            const newCardElement = document.querySelector(`[data-payment-id="card-${newCard.id}"]`);
            if (newCardElement) {
                this.selectPayment(newCardElement);
            }
        }, 200);
    }

    closeAddCard() {
        const modal = document.getElementById('addCardModal');
        if (modal) {
            modal.remove();
        }
    }

    close() {
        const modal = document.getElementById('paymentSelectionModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    getCardIcon(brand) {
        const icons = {
            visa: '<div class="card-brand-visa">VISA</div>',
            mastercard: '<div class="card-brand-mc">MC</div>',
            amex: '<div class="card-brand-amex">AMEX</div>',
            discover: '<div class="card-brand-discover">DISC</div>'
        };
        return icons[brand] || '<div class="card-brand-generic">CARD</div>';
    }

    formatCardBrand(brand) {
        const brands = {
            visa: 'Visa',
            mastercard: 'Mastercard',
            amex: 'American Express',
            discover: 'Discover',
            diners: 'Diners Club',
            jcb: 'JCB'
        };
        return brands[brand] || 'Card';
    }

    // Singleton pattern
    static instance = null;
    
    static getInstance() {
        if (!this.instance) {
            this.instance = new PaymentModalController();
        }
        return this.instance;
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    PaymentModalController.getInstance().init();
});

// Expose for onclick handlers
window.PaymentModalController = PaymentModalController;