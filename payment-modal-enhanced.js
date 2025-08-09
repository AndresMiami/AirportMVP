/**
 * Enhanced Payment Modal Controller
 * Complete credit card validation and management
 */

class PaymentModalEnhanced {
    constructor() {
        this.selectedPaymentMethod = 'visa-1187';
        this.savedCards = [];
        this.isInitialized = false;
    }

    init() {
        if (this.isInitialized) return;
        
        this.loadSavedCards();
        this.attachEventListeners();
        this.isInitialized = true;
    }

    // Load saved cards from localStorage
    loadSavedCards() {
        const saved = localStorage.getItem('savedPaymentMethods');
        if (saved) {
            this.savedCards = JSON.parse(saved);
            this.updatePaymentMethodsList();
        }
    }

    // Save cards to localStorage
    saveCardsToStorage() {
        localStorage.setItem('savedPaymentMethods', JSON.stringify(this.savedCards));
    }

    // Update payment methods list in DOM
    updatePaymentMethodsList() {
        const list = document.getElementById('paymentMethodsList');
        if (!list) return;
        
        // Add saved cards to the list
        this.savedCards.forEach(card => {
            if (!document.querySelector(`[data-method="${card.id}"]`)) {
                const cardRow = this.createCardRow(card);
                list.appendChild(cardRow);
            }
        });
    }

    // Create card row element
    createCardRow(card) {
        const row = document.createElement('div');
        row.className = 'payment-method-row';
        row.dataset.method = card.id;
        row.onclick = () => this.selectPayment(row);
        
        let iconClass = 'card-icon';
        let iconContent = card.brand.toUpperCase();
        
        if (card.brand === 'Visa') {
            iconClass += ' visa';
            iconContent = '<span>VISA</span>';
        } else if (card.brand === 'Mastercard') {
            iconClass += ' mastercard';
            iconContent = '';
        } else if (card.brand === 'Amex') {
            iconClass += ' amex';
            iconContent = 'AMEX';
        } else if (card.brand === 'Discover') {
            iconClass += ' discover';
            iconContent = 'DISC';
        }
        
        row.innerHTML = `
            <div class="payment-method-icon">
                <div class="${iconClass}">${iconContent}</div>
            </div>
            <div class="payment-method-text">${card.brand}, •••• ${card.last4}</div>
            <div class="payment-method-check"></div>
        `;
        
        return row;
    }

    // Open payment modal
    open() {
        this.init();
        this.loadSavedCards();
        
        // Check if modal exists, if not create it
        let modal = document.getElementById('paymentModal');
        if (!modal) {
            this.createPaymentModal();
            modal = document.getElementById('paymentModal');
        }
        
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
        } else {
            console.error('Failed to create payment modal');
        }
    }

    // Create payment modal HTML
    createPaymentModal() {
        // Smart Apple Pay detection - only on production HTTPS
        let showApplePay = false;
        
        // Check if we're in production (Netlify or other HTTPS deployment)
        const isProduction = window.location.protocol === 'https:' && 
                           !window.location.hostname.includes('localhost') && 
                           !window.location.hostname.includes('127.0.0.1');
        
        // Only attempt Apple Pay on production to avoid localhost errors
        if (isProduction) {
            try {
                // Check if Safari and Apple Pay is available
                if (window.ApplePaySession && typeof ApplePaySession.canMakePayments === 'function') {
                    showApplePay = ApplePaySession.canMakePayments();
                    if (showApplePay) {
                        console.log('✅ Apple Pay is available on this device');
                    }
                }
            } catch (e) {
                // Silently fail if Apple Pay check fails
                console.log('Apple Pay check failed:', e.message);
                showApplePay = false;
            }
        } else {
            console.log('💳 Payment modal: Development mode - Apple Pay disabled');
        }
        
        const modalHTML = `
            <!-- Payment Selection Modal -->
            <div class="full-modal" id="paymentModal" style="display: none;">
                <div class="modal-panel payment-modal-panel">
                    <div class="modal-header">
                        <button class="modal-back-btn" onclick="PaymentModalEnhanced.getInstance().close()">←</button>
                        <h2>Payment</h2>
                        <button class="modal-back-btn" onclick="PaymentModalEnhanced.getInstance().openAddPaymentModal()">+</button>
                    </div>
                    
                    <div class="modal-scrollable-content">
                        <div class="payment-section-title">Personal payment methods</div>
                        
                        <div id="paymentMethodsList">
                            <!-- Default Visa Card -->
                            <div class="payment-method-row selected" onclick="PaymentModalEnhanced.getInstance().selectPayment(this)" data-method="visa-1187">
                                <div class="payment-method-icon">
                                    <div class="card-icon visa"><span>VISA</span></div>
                                </div>
                                <div class="payment-method-text">Visa, •••• 1187</div>
                                <div class="payment-method-check"></div>
                            </div>
                            
                            ${showApplePay ? `
                            <!-- Apple Pay -->
                            <div class="payment-method-row" onclick="PaymentModalEnhanced.getInstance().selectPayment(this)" data-method="apple-pay">
                                <div class="payment-method-icon">
                                    <div class="card-icon apple-pay">🍎 Pay</div>
                                </div>
                                <div class="payment-method-text">Apple Pay</div>
                                <div class="payment-method-check"></div>
                            </div>
                            ` : ''}
                        </div>
                        
                        <button class="modal-action-btn" onclick="PaymentModalEnhanced.getInstance().confirmPayment()">Continue</button>
                    </div>
                </div>
            </div>

            <!-- Add Payment Method Modal -->
            <div class="full-modal" id="addPaymentModal" style="display: none;">
                <div class="modal-panel add-payment-modal">
                    <div class="modal-scrollable-content">
                        <div class="add-payment-title">How would you like to pay?</div>
                        
                        <div class="payment-option" onclick="PaymentModalEnhanced.getInstance().openCardInputModal()">
                            <div class="payment-option-icon">💳</div>
                            <div class="payment-option-text">Credit or debit card</div>
                            <div class="payment-option-arrow">›</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Card Input Modal -->
            <div class="full-modal" id="cardInputModal" style="display: none;">
                <div class="modal-panel card-input-panel">
                    <div class="modal-header">
                        <button class="modal-back-btn" onclick="PaymentModalEnhanced.getInstance().closeCardInputModal()">←</button>
                        <h2>Credit or debit card</h2>
                        <button class="modal-back-btn" onclick="PaymentModalEnhanced.getInstance().closeCardInputModal()">✕</button>
                    </div>
                    
                    <div class="modal-scrollable-content">
                        <form id="cardForm" onsubmit="PaymentModalEnhanced.getInstance().saveCard(event)">
                            <!-- Cardholder Name -->
                            <div class="form-group">
                                <label for="cardholderName">Full Name</label>
                                <input type="text" 
                                       id="cardholderName" 
                                       class="form-input" 
                                       placeholder="Cardholder"
                                       autocomplete="cc-name"
                                       required>
                                <div class="error-message" id="nameError">Please enter the cardholder's name</div>
                            </div>
                            
                            <!-- Card Number -->
                            <div class="form-group">
                                <label for="cardNumber">Card Number</label>
                                <div class="card-input-wrapper">
                                    <input type="text" 
                                           id="cardNumber" 
                                           class="form-input" 
                                           placeholder="•••• •••• •••• ••••"
                                           autocomplete="cc-number"
                                           maxlength="19"
                                           inputmode="numeric"
                                           required>
                                    <div class="card-type-indicator" id="cardTypeIcon"></div>
                                </div>
                                <div class="error-message" id="numberError">Invalid card number</div>
                            </div>
                            
                            <!-- Expiration Date -->
                            <div class="form-group">
                                <label for="expiryDate">Expiration Date</label>
                                <input type="text" 
                                       id="expiryDate" 
                                       class="form-input" 
                                       placeholder="MM/YY"
                                       autocomplete="cc-exp"
                                       maxlength="5"
                                       inputmode="numeric"
                                       required>
                                <div class="error-message" id="expiryError">Invalid expiry date</div>
                            </div>
                            
                            <!-- CVV -->
                            <div class="form-group">
                                <label for="cvv">CVV</label>
                                <input type="text" 
                                       id="cvv" 
                                       class="form-input" 
                                       placeholder="•••"
                                       autocomplete="cc-csc"
                                       maxlength="4"
                                       inputmode="numeric"
                                       required>
                                <div class="error-message" id="cvvError">Invalid CVV</div>
                            </div>
                            
                            <!-- Info Message -->
                            <div class="info-notes">
                                <div class="info-note">
                                    <span class="info-icon">ℹ️</span>
                                    <p>Your credit or debit card is only charged after the ride. Funds are temporarily reserved with a pre-authorization.</p>
                                </div>
                            </div>
                            
                            <!-- Card Brands -->
                            <div class="card-brands">
                                <svg class="card-brand-img" viewBox="0 0 60 40">
                                    <rect width="60" height="40" rx="4" fill="white" stroke="#e0e0e0"/>
                                    <rect y="30" width="60" height="10" fill="#F7B600"/>
                                    <rect y="0" width="60" height="10" fill="#1A1F71"/>
                                    <text x="50%" y="50%" text-anchor="middle" dy=".1em" fill="#1A1F71" font-size="14" font-weight="800">VISA</text>
                                </svg>
                                <svg class="card-brand-img" viewBox="0 0 60 40">
                                    <rect width="60" height="40" rx="4" fill="white" stroke="#e0e0e0"/>
                                    <circle cx="23" cy="20" r="12" fill="#EB001B"/>
                                    <circle cx="37" cy="20" r="12" fill="#F79E1B"/>
                                </svg>
                                <svg class="card-brand-img" viewBox="0 0 60 40">
                                    <rect width="60" height="40" rx="4" fill="white" stroke="#e0e0e0"/>
                                    <text x="50%" y="50%" text-anchor="middle" dy=".1em" fill="#FF6600" font-size="9" font-weight="700">DISCOVER</text>
                                </svg>
                                <svg class="card-brand-img" viewBox="0 0 60 40">
                                    <rect width="60" height="40" rx="4" fill="#006FCF"/>
                                    <text x="50%" y="45%" text-anchor="middle" dy=".1em" fill="white" font-size="7" font-weight="700">AMERICAN</text>
                                    <text x="50%" y="65%" text-anchor="middle" dy=".1em" fill="white" font-size="7" font-weight="700">EXPRESS</text>
                                </svg>
                            </div>
                            
                            <!-- Add Card Button -->
                            <button type="submit" class="modal-action-btn" id="addCardBtn" disabled>
                                Add credit or debit card
                            </button>
                        </form>
                    </div>
                </div>
            </div>
        `;
        
        // Add to body
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // Close payment modal
    close() {
        const modal = document.getElementById('paymentModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }
    }

    // Select payment method
    selectPayment(element) {
        // Remove previous selection
        document.querySelectorAll('.payment-method-row').forEach(row => {
            row.classList.remove('selected');
        });
        
        // Add new selection
        element.classList.add('selected');
        this.selectedPaymentMethod = element.dataset.method;
    }

    // Confirm payment selection
    confirmPayment() {
        const selected = document.querySelector('.payment-method-row.selected');
        if (selected) {
            const paymentText = selected.querySelector('.payment-method-text').textContent;
            console.log('Selected payment:', paymentText);
            
            // Update main UI payment button
            this.updateMainPaymentDisplay(paymentText);
            
            this.close();
        }
    }

    // Update main UI payment display
    updateMainPaymentDisplay(paymentText) {
        const paymentBtn = document.querySelector('.payment-method-mobile');
        if (paymentBtn) {
            const paymentDetails = paymentBtn.querySelector('.payment-details');
            if (paymentDetails) {
                paymentDetails.textContent = paymentText;
            }
        }
    }

    // Open add payment modal
    openAddPaymentModal() {
        const modal = document.getElementById('addPaymentModal');
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
        }
    }

    // Close add payment modal
    closeAddPaymentModal() {
        const modal = document.getElementById('addPaymentModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }
    }

    // Open card input modal
    openCardInputModal() {
        this.closeAddPaymentModal();
        const modal = document.getElementById('cardInputModal');
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => {
                modal.classList.add('active');
                document.getElementById('cardholderName')?.focus();
            }, 10);
        }
    }

    // Close card input modal
    closeCardInputModal() {
        const modal = document.getElementById('cardInputModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
                // Clear form
                document.getElementById('cardForm')?.reset();
                document.getElementById('addCardBtn').disabled = true;
                document.getElementById('addCardBtn').classList.remove('active-orange');
                this.clearAllErrors();
            }, 300);
        }
    }

    // Clear all error messages
    clearAllErrors() {
        document.querySelectorAll('.form-input').forEach(input => {
            input.classList.remove('error');
        });
        document.querySelectorAll('.error-message').forEach(error => {
            error.classList.remove('visible');
        });
    }

    // Show error message
    showError(inputId, errorId) {
        document.getElementById(inputId)?.classList.add('error');
        document.getElementById(errorId)?.classList.add('visible');
    }

    // Hide error message
    hideError(inputId, errorId) {
        document.getElementById(inputId)?.classList.remove('error');
        document.getElementById(errorId)?.classList.remove('visible');
    }

    // Luhn algorithm for card validation
    luhnCheck(cardNumber) {
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
    }

    // Detect card type
    detectCardType(cardNumber) {
        const number = cardNumber.replace(/\D/g, '');
        
        if (/^4/.test(number)) return 'Visa';
        if (/^5[1-5]/.test(number) || /^2[2-7]/.test(number)) return 'Mastercard';
        if (/^3[47]/.test(number)) return 'Amex';
        if (/^6(?:011|5)/.test(number)) return 'Discover';
        
        return null;
    }

    // Update card type icon
    updateCardTypeIcon(cardType) {
        const icon = document.getElementById('cardTypeIcon');
        if (!icon) return;
        
        if (cardType === 'Visa') {
            icon.innerHTML = '<div class="card-icon visa"><span>VISA</span></div>';
        } else if (cardType === 'Mastercard') {
            icon.innerHTML = '<div class="card-icon mastercard"></div>';
        } else if (cardType === 'Amex') {
            icon.innerHTML = '<div class="card-icon amex">AMEX</div>';
        } else if (cardType === 'Discover') {
            icon.innerHTML = '<div class="card-icon discover">DISC</div>';
        } else {
            icon.innerHTML = '';
        }
    }

    // Format card number
    formatCardNumber(value) {
        const number = value.replace(/\s/g, '');
        const cardType = this.detectCardType(number);
        
        if (cardType === 'Amex') {
            // Amex format: 4-6-5
            const parts = number.match(/(\d{1,4})(\d{1,6})?(\d{1,5})?/);
            if (parts) {
                return parts.slice(1).filter(Boolean).join(' ');
            }
        } else {
            // Other cards: 4-4-4-4
            const parts = number.match(/(\d{1,4})/g);
            if (parts) {
                return parts.join(' ');
            }
        }
        
        return value;
    }

    // Validate card number
    validateCardNumber(value) {
        const number = value.replace(/\D/g, '');
        const cardType = this.detectCardType(number);
        
        if (!cardType) return false;
        
        // Check length based on card type
        if (cardType === 'Amex' && number.length !== 15) return false;
        if (cardType !== 'Amex' && number.length !== 16) return false;
        
        // Luhn check
        return this.luhnCheck(number);
    }

    // Validate expiry date
    validateExpiryDate(value) {
        const parts = value.split('/');
        if (parts.length !== 2) return false;
        
        const month = parseInt(parts[0], 10);
        const year = parseInt('20' + parts[1], 10);
        
        if (month < 1 || month > 12) return false;
        
        const now = new Date();
        const expiry = new Date(year, month - 1);
        
        return expiry >= now;
    }

    // Validate CVV
    validateCVV(value, cardType) {
        const cvv = value.replace(/\D/g, '');
        
        if (cardType === 'Amex') {
            return cvv.length === 4;
        } else {
            return cvv.length === 3;
        }
    }

    // Validate entire form
    validateCardForm() {
        const name = document.getElementById('cardholderName')?.value.trim() || '';
        const number = document.getElementById('cardNumber')?.value || '';
        const expiry = document.getElementById('expiryDate')?.value || '';
        const cvv = document.getElementById('cvv')?.value || '';
        const button = document.getElementById('addCardBtn');
        
        const cardType = this.detectCardType(number);
        
        const isNameValid = name.length > 2;
        const isNumberValid = this.validateCardNumber(number);
        const isExpiryValid = this.validateExpiryDate(expiry);
        const isCVVValid = this.validateCVV(cvv, cardType);
        
        if (button) {
            if (isNameValid && isNumberValid && isExpiryValid && isCVVValid) {
                button.disabled = false;
                button.classList.add('active-orange');
            } else {
                button.disabled = true;
                button.classList.remove('active-orange');
            }
        }
        
        return {
            name: isNameValid,
            number: isNumberValid,
            expiry: isExpiryValid,
            cvv: isCVVValid
        };
    }

    // Save card
    saveCard(event) {
        event.preventDefault();
        
        const validation = this.validateCardForm();
        
        // Show specific errors
        if (!validation.name) {
            this.showError('cardholderName', 'nameError');
            return;
        }
        if (!validation.number) {
            this.showError('cardNumber', 'numberError');
            return;
        }
        if (!validation.expiry) {
            this.showError('expiryDate', 'expiryError');
            return;
        }
        if (!validation.cvv) {
            this.showError('cvv', 'cvvError');
            return;
        }
        
        // All valid - save the card
        const cardNumber = document.getElementById('cardNumber').value.replace(/\D/g, '');
        const last4 = cardNumber.slice(-4);
        const cardType = this.detectCardType(cardNumber);
        
        const newCard = {
            id: `${cardType.toLowerCase()}-${last4}`,
            brand: cardType,
            last4: last4,
            name: document.getElementById('cardholderName').value,
            expiry: document.getElementById('expiryDate').value
        };
        
        // Add to saved cards
        this.savedCards.push(newCard);
        this.saveCardsToStorage();
        
        // Add to UI
        const list = document.getElementById('paymentMethodsList');
        const cardRow = this.createCardRow(newCard);
        list.appendChild(cardRow);
        
        // Select the new card
        this.selectPayment(cardRow);
        
        // Close modal
        this.closeCardInputModal();
        
        alert('Card added successfully!');
    }

    // Check if Apple Pay is available
    isApplePayAvailable() {
        // Skip Apple Pay entirely in development/insecure environment
        if (window.location.protocol !== 'https:') {
            return false;
        }
        
        // Skip on localhost/127.0.0.1
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            return false;
        }
        
        try {
            // Only check if ApplePaySession exists and we're in a secure context
            if (window.ApplePaySession && typeof ApplePaySession.canMakePayments === 'function') {
                return ApplePaySession.canMakePayments();
            }
            return false;
        } catch (error) {
            // Silently fail if Apple Pay check throws an error
            return false;
        }
    }

    // Attach event listeners
    attachEventListeners() {
        // Card number input
        document.addEventListener('input', (e) => {
            if (e.target.id === 'cardNumber') {
                const value = e.target.value.replace(/\s/g, '');
                e.target.value = this.formatCardNumber(value);
                
                const cardType = this.detectCardType(value);
                this.updateCardTypeIcon(cardType);
                
                // Update CVV max length based on card type
                const cvvInput = document.getElementById('cvv');
                if (cvvInput) {
                    cvvInput.maxLength = cardType === 'Amex' ? 4 : 3;
                }
                
                // Hide error if valid
                if (this.validateCardNumber(e.target.value)) {
                    this.hideError('cardNumber', 'numberError');
                }
                
                this.validateCardForm();
            }
            
            // Expiry date input
            if (e.target.id === 'expiryDate') {
                let value = e.target.value.replace(/\D/g, '');
                
                if (value.length >= 2) {
                    const month = value.slice(0, 2);
                    const year = value.slice(2, 4);
                    value = month + (year ? '/' + year : '');
                }
                
                e.target.value = value;
                
                if (value.length === 5 && this.validateExpiryDate(value)) {
                    this.hideError('expiryDate', 'expiryError');
                }
                
                this.validateCardForm();
            }
            
            // CVV input
            if (e.target.id === 'cvv') {
                e.target.value = e.target.value.replace(/\D/g, '');
                
                const cardNumber = document.getElementById('cardNumber')?.value || '';
                const cardType = this.detectCardType(cardNumber);
                
                if (this.validateCVV(e.target.value, cardType)) {
                    this.hideError('cvv', 'cvvError');
                }
                
                this.validateCardForm();
            }
            
            // Cardholder name input
            if (e.target.id === 'cardholderName') {
                if (e.target.value.trim().length > 2) {
                    this.hideError('cardholderName', 'nameError');
                }
                this.validateCardForm();
            }
        });

        // Blur events for validation
        document.addEventListener('blur', (e) => {
            if (e.target.id === 'cardNumber' && e.target.value) {
                if (!this.validateCardNumber(e.target.value)) {
                    this.showError('cardNumber', 'numberError');
                }
            }
            
            if (e.target.id === 'expiryDate' && e.target.value) {
                if (!this.validateExpiryDate(e.target.value)) {
                    this.showError('expiryDate', 'expiryError');
                }
            }
            
            if (e.target.id === 'cvv' && e.target.value) {
                const cardNumber = document.getElementById('cardNumber')?.value || '';
                const cardType = this.detectCardType(cardNumber);
                if (!this.validateCVV(e.target.value, cardType)) {
                    this.showError('cvv', 'cvvError');
                }
            }
            
            if (e.target.id === 'cardholderName' && e.target.value) {
                if (e.target.value.trim().length <= 2) {
                    this.showError('cardholderName', 'nameError');
                }
            }
        }, true);

        // Close modals on overlay click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('full-modal') && e.target.classList.contains('active')) {
                if (e.target.id === 'paymentModal') {
                    this.close();
                } else if (e.target.id === 'addPaymentModal') {
                    this.closeAddPaymentModal();
                } else if (e.target.id === 'cardInputModal') {
                    this.closeCardInputModal();
                }
            }
        });

        // Escape key to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const cardInputModal = document.getElementById('cardInputModal');
                const addPaymentModal = document.getElementById('addPaymentModal');
                const paymentModal = document.getElementById('paymentModal');
                
                if (cardInputModal?.classList.contains('active')) {
                    this.closeCardInputModal();
                } else if (addPaymentModal?.classList.contains('active')) {
                    this.closeAddPaymentModal();
                } else if (paymentModal?.classList.contains('active')) {
                    this.close();
                }
            }
        });
    }

    // Get selected payment method for booking
    getSelectedPayment() {
        return this.selectedPaymentMethod;
    }

    // Singleton pattern
    static instance = null;
    
    static getInstance() {
        if (!this.instance) {
            this.instance = new PaymentModalEnhanced();
        }
        return this.instance;
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    PaymentModalEnhanced.getInstance().init();
});

// Expose for global access
window.PaymentModalEnhanced = PaymentModalEnhanced;