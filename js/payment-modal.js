/**
 * Payment Modal Controller
 * Complete dark theme payment modal with card management
 * Extracted from payment-modal-complete.html
 */

class PaymentModal {
    constructor() {
        this.selectedPaymentMethod = null;
        this.savedCards = [];
        this.isEditMode = false;
        this.isInitialized = false;
    }

    init() {
        if (this.isInitialized) return;
        
        this.injectStyles();
        this.createModal();
        this.attachEventListeners();
        this.loadSavedCards();
        this.checkApplePayAvailability();
        this.isInitialized = true;
    }

    injectStyles() {
        if (document.getElementById('payment-modal-styles')) return;
        
        const styles = `
            <style id="payment-modal-styles">
                /* Full Modal - Dark Theme */
                .payment-full-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    z-index: 9999;
                    display: none;
                    justify-content: center;
                    align-items: flex-end;
                }

                .payment-full-modal.active {
                    display: flex;
                    animation: paymentFadeIn 0.3s ease-out;
                }

                .payment-modal-panel {
                    width: 100%;
                    max-width: 576px;
                    height: 100vh;
                    background: #2C2C2E;
                    display: flex;
                    flex-direction: column;
                    animation: paymentSlideUp 0.3s ease-out;
                    border-radius: 20px 20px 0 0;
                }

                @keyframes paymentSlideUp {
                    from { transform: translateY(100%); }
                    to { transform: translateY(0); }
                }

                @keyframes paymentFadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }

                /* Modal Header - Dark Theme */
                .payment-modal-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 20px;
                    border-bottom: 1px solid #3A3A3C;
                    background: #2C2C2E;
                    position: sticky;
                    top: 0;
                    z-index: 10;
                    border-radius: 20px 20px 0 0;
                }

                .payment-modal-back-btn {
                    width: 40px;
                    height: 40px;
                    border: none;
                    background: none;
                    font-size: 24px;
                    color: #FFFFFF;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 50%;
                    transition: background 0.2s;
                }

                .payment-modal-back-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .payment-modal-header h2 {
                    font-size: 20px;
                    font-weight: 600;
                    color: #FFFFFF;
                    margin: 0;
                    flex: 1;
                    text-align: center;
                }

                .payment-modal-header-actions {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .payment-modal-edit-btn {
                    width: 36px;
                    height: 36px;
                    border: none;
                    background: none;
                    font-size: 20px;
                    color: #FF9500;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 50%;
                    transition: background 0.2s;
                }

                .payment-modal-edit-btn:hover {
                    background: rgba(255, 149, 0, 0.1);
                }

                /* Content Section */
                .payment-modal-content {
                    flex: 1;
                    overflow-y: auto;
                    padding: 24px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }

                /* Empty State */
                .payment-empty-state {
                    display: none;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 60px 24px;
                    text-align: center;
                    flex: 1;
                }

                .payment-empty-state.visible {
                    display: flex;
                }

                .payment-empty-icon {
                    width: 80px;
                    height: 50px;
                    background: #48484A;
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-bottom: 32px;
                    position: relative;
                }

                .payment-empty-icon::before {
                    content: '';
                    position: absolute;
                    bottom: 12px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 24px;
                    height: 2px;
                    background: #6D6D70;
                    border-radius: 1px;
                }

                .payment-empty-icon::after {
                    content: '';
                    position: absolute;
                    top: 12px;
                    right: 8px;
                    width: 12px;
                    height: 8px;
                    background: #6D6D70;
                    border-radius: 2px;
                }

                .payment-empty-text {
                    font-size: 17px;
                    color: #8E8E93;
                    line-height: 1.4;
                    margin-bottom: 40px;
                    max-width: 280px;
                }

                .payment-add-btn-large {
                    width: 100%;
                    max-width: 320px;
                    padding: 16px 24px;
                    background: #FF9500;
                    color: #FFFFFF;
                    border: 2px solid #FF9500;
                    border-radius: 12px;
                    font-size: 17px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .payment-add-btn-large:hover {
                    background: #FF8C00;
                    border-color: #FF8C00;
                }

                .payment-add-btn-large:active {
                    transform: scale(0.98);
                }

                /* Cards List Container */
                .payment-cards-container {
                    display: none;
                    flex-direction: column;
                    width: 100%;
                }

                .payment-cards-container.visible {
                    display: flex;
                }

                .payment-section-title {
                    font-size: 13px;
                    font-weight: 600;
                    color: #8E8E93;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 16px;
                }

                /* Payment Method Row */
                .payment-method-row {
                    display: flex;
                    align-items: center;
                    padding: 16px;
                    background: #3A3A3C;
                    border: 2px solid #48484A;
                    border-radius: 12px;
                    margin-bottom: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                    position: relative;
                }

                .payment-method-row:hover {
                    background: #48484A;
                    border-color: #5A5A5C;
                }

                .payment-method-row.selected {
                    border-color: #FF9500;
                    background: rgba(255, 149, 0, 0.1);
                }

                .payment-method-icon {
                    width: 40px;
                    height: 26px;
                    margin-right: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                /* Card Icons */
                .payment-card-icon {
                    width: 40px;
                    height: 26px;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 10px;
                    font-weight: 700;
                    color: white;
                }

                .payment-card-icon.visa {
                    background: #1A1F71;
                }

                .payment-card-icon.mastercard {
                    background: linear-gradient(to right, #EB001B 50%, #F79E1B 50%);
                }

                .payment-card-icon.amex {
                    background: #006FCF;
                }

                .payment-card-icon.discover {
                    background: #FF6600;
                }

                .payment-card-icon.apple-pay {
                    background: #000000;
                    font-size: 11px;
                }

                .payment-method-text {
                    flex: 1;
                    font-size: 17px;
                    color: #FFFFFF;
                }

                .payment-method-check {
                    width: 24px;
                    height: 24px;
                    border-radius: 50%;
                    border: 2px solid #48484A;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                }

                .payment-method-row.selected .payment-method-check {
                    border-color: #FF9500;
                    background: #FF9500;
                }

                .payment-method-check::after {
                    content: '✓';
                    font-size: 14px;
                    font-weight: bold;
                    color: #2C2C2E;
                    opacity: 0;
                    transition: opacity 0.2s;
                }

                .payment-method-row.selected .payment-method-check::after {
                    opacity: 1;
                }

                /* Edit Mode */
                .payment-full-modal.edit-mode .payment-method-check {
                    display: none;
                }

                .payment-method-delete {
                    width: 32px;
                    height: 32px;
                    border: none;
                    background: rgba(255, 69, 58, 0.2);
                    border-radius: 50%;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .payment-full-modal.edit-mode .payment-method-delete {
                    display: flex;
                }

                .payment-method-delete:hover {
                    background: rgba(255, 69, 58, 0.3);
                    transform: scale(1.1);
                }

                /* Continue Button */
                .payment-continue-btn {
                    width: 100%;
                    padding: 16px;
                    background: #48484A;
                    color: #8E8E93;
                    border: none;
                    border-radius: 12px;
                    font-size: 17px;
                    font-weight: 600;
                    cursor: not-allowed;
                    transition: all 0.2s;
                    margin-top: 24px;
                }

                .payment-continue-btn.enabled {
                    background: #FF9500;
                    color: #FFFFFF;
                    cursor: pointer;
                }

                .payment-continue-btn.enabled:hover {
                    background: #FF8C00;
                }

                .payment-continue-btn.enabled:active {
                    transform: scale(0.98);
                }

                /* Add Payment Modal */
                .payment-add-modal .payment-modal-panel {
                    height: auto;
                    max-height: 70vh;
                }

                .payment-add-title {
                    font-size: 20px;
                    font-weight: 600;
                    color: #FFFFFF;
                    margin-bottom: 24px;
                    text-align: center;
                }

                .payment-option {
                    display: flex;
                    align-items: center;
                    padding: 16px;
                    background: #3A3A3C;
                    border: 1px solid #48484A;
                    border-radius: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                    margin-bottom: 12px;
                }

                .payment-option:hover {
                    background: #48484A;
                    border-color: #5A5A5C;
                }

                .payment-option-icon {
                    font-size: 24px;
                    margin-right: 16px;
                }

                .payment-option-text {
                    flex: 1;
                    font-size: 17px;
                    color: #FFFFFF;
                    font-weight: 500;
                }

                .payment-option-arrow {
                    font-size: 20px;
                    color: #8E8E93;
                }

                /* Card Input Form */
                .payment-form-group {
                    margin-bottom: 24px;
                }

                .payment-form-group label {
                    display: block;
                    font-size: 13px;
                    font-weight: 600;
                    color: #8E8E93;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 8px;
                }

                .payment-form-input {
                    width: 100%;
                    padding: 14px 16px;
                    background: #3A3A3C;
                    border: 1px solid #48484A;
                    border-radius: 10px;
                    font-size: 16px;
                    color: #FFFFFF;
                    transition: all 0.2s;
                }

                .payment-form-input::placeholder {
                    color: #6D6D70;
                }

                .payment-form-input:focus {
                    outline: none;
                    border-color: #FF9500;
                    background: #48484A;
                }

                .payment-form-input.error {
                    border-color: #FF453A;
                    background: rgba(255, 69, 58, 0.1);
                }

                .payment-error-message {
                    color: #FF453A;
                    font-size: 12px;
                    margin-top: 4px;
                    display: none;
                }

                .payment-error-message.visible {
                    display: block;
                }

                .payment-card-input-wrapper {
                    position: relative;
                }

                .payment-card-type-indicator {
                    position: absolute;
                    right: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 32px;
                    height: 20px;
                }

                .payment-card-type-indicator .payment-card-icon {
                    width: 32px;
                    height: 20px;
                    font-size: 8px;
                }

                /* Info Notes */
                .payment-info-notes {
                    margin: 24px 0;
                    padding: 16px;
                    background: rgba(255, 149, 0, 0.1);
                    border: 1px solid rgba(255, 149, 0, 0.2);
                    border-radius: 12px;
                }

                .payment-info-note {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 8px;
                }

                .payment-info-note:last-child {
                    margin-bottom: 0;
                }

                .payment-info-icon {
                    flex-shrink: 0;
                    font-size: 16px;
                }

                .payment-info-note p {
                    font-size: 14px;
                    color: #FFFFFF;
                    line-height: 1.4;
                    margin: 0;
                }

                /* Success Message */
                .payment-success-message {
                    position: fixed;
                    top: 50px;
                    left: 50%;
                    transform: translateX(-50%) translateY(-100px);
                    background: #32D74B;
                    color: white;
                    padding: 12px 24px;
                    border-radius: 12px;
                    font-size: 15px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    z-index: 10000;
                    opacity: 0;
                    transition: all 0.3s ease;
                    box-shadow: 0 4px 12px rgba(50, 215, 75, 0.3);
                }

                .payment-success-message.show {
                    transform: translateX(-50%) translateY(0);
                    opacity: 1;
                }

                /* Mobile Optimizations */
                @media (max-width: 480px) {
                    .payment-modal-panel {
                        border-radius: 0;
                        max-width: 100%;
                    }

                    .payment-modal-header {
                        padding: 16px 20px;
                        border-radius: 0;
                    }

                    .payment-modal-content {
                        padding: 20px;
                    }
                }

                /* Desktop adjustments */
                @media (min-width: 768px) {
                    .payment-modal-panel {
                        height: auto;
                        max-height: 90vh;
                        margin: 20px;
                        border-radius: 20px;
                    }

                    .payment-full-modal {
                        align-items: center;
                    }
                }
            </style>
        `;
        
        document.head.insertAdjacentHTML('beforeend', styles);
    }

    createModal() {
        if (document.getElementById('paymentModal')) return;

        const modalHTML = `
            <!-- Payment Selection Modal -->
            <div id="paymentModal" class="payment-full-modal">
                <div class="payment-modal-panel">
                    <div class="payment-modal-header">
                        <button class="payment-modal-back-btn" onclick="PaymentModal.getInstance().close()">←</button>
                        <h2>Payment</h2>
                        <div class="payment-modal-header-actions">
                            <button class="payment-modal-edit-btn" id="editCardsBtn" onclick="PaymentModal.getInstance().toggleEditMode()" style="display: none;">✏️</button>
                            <button class="payment-modal-back-btn" onclick="PaymentModal.getInstance().openAddPaymentModal()">+</button>
                        </div>
                    </div>
                    
                    <div class="payment-modal-content">
                        <!-- Empty State -->
                        <div id="emptyState" class="payment-empty-state">
                            <div class="payment-empty-icon"></div>
                            <p class="payment-empty-text">No payment methods saved yet. Add a card to get started.</p>
                            <button class="payment-add-btn-large" onclick="PaymentModal.getInstance().openAddPaymentModal()">
                                Add payment method
                            </button>
                        </div>
                        
                        <!-- Cards List -->
                        <div id="cardsListContainer" class="payment-cards-container">
                            <div class="payment-section-title">Personal payment methods</div>
                            <div id="paymentMethodsList"></div>
                            <button class="payment-continue-btn" id="continueBtnList" onclick="PaymentModal.getInstance().confirmPayment()">
                                Continue
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Add Payment Method Modal -->
            <div id="addPaymentModal" class="payment-full-modal">
                <div class="payment-modal-panel payment-add-modal">
                    <div class="payment-modal-header">
                        <button class="payment-modal-back-btn" onclick="PaymentModal.getInstance().closeAddPaymentModal()">←</button>
                        <h2>Add Payment Method</h2>
                        <button class="payment-modal-back-btn" onclick="PaymentModal.getInstance().closeAddPaymentModal()">✕</button>
                    </div>
                    
                    <div class="payment-modal-content">
                        <div class="payment-add-title">How would you like to pay?</div>
                        
                        <div class="payment-option" onclick="PaymentModal.getInstance().openCardInputModal()">
                            <div class="payment-option-icon">💳</div>
                            <div class="payment-option-text">Credit or debit card</div>
                            <div class="payment-option-arrow">›</div>
                        </div>
                        
                        <div id="applePayOptionSlide" class="payment-option" style="display: none;" onclick="PaymentModal.getInstance().selectApplePay()">
                            <div class="payment-option-icon">🍎</div>
                            <div class="payment-option-text">Apple Pay</div>
                            <div class="payment-option-arrow">›</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Card Input Modal -->
            <div id="cardInputModal" class="payment-full-modal">
                <div class="payment-modal-panel">
                    <div class="payment-modal-header">
                        <button class="payment-modal-back-btn" onclick="PaymentModal.getInstance().closeCardInputModal()">←</button>
                        <h2>Credit or debit card</h2>
                        <button class="payment-modal-back-btn" onclick="PaymentModal.getInstance().closeCardInputModal()">✕</button>
                    </div>
                    
                    <div class="payment-modal-content">
                        <form id="cardForm" onsubmit="PaymentModal.getInstance().saveCard(event)">
                            <div class="payment-form-group">
                                <label for="cardholderName">Cardholder Name</label>
                                <input type="text" id="cardholderName" class="payment-form-input" placeholder="Name on card" required>
                                <div class="payment-error-message" id="nameError">Please enter the cardholder's name</div>
                            </div>
                            
                            <div class="payment-form-group">
                                <label for="cardNumber">Card Number</label>
                                <div class="payment-card-input-wrapper">
                                    <input type="text" id="cardNumber" class="payment-form-input" placeholder="•••• •••• •••• ••••" maxlength="19" required>
                                    <div class="payment-card-type-indicator" id="cardTypeIcon"></div>
                                </div>
                                <div class="payment-error-message" id="numberError">Invalid card number</div>
                            </div>
                            
                            <div class="payment-form-group">
                                <label for="expiryDate">Expiration Date</label>
                                <input type="text" id="expiryDate" class="payment-form-input" placeholder="MM/YY" maxlength="5" required>
                                <div class="payment-error-message" id="expiryError">Invalid expiry date</div>
                            </div>
                            
                            <div class="payment-form-group">
                                <label for="cvv">CVV</label>
                                <input type="text" id="cvv" class="payment-form-input" placeholder="•••" maxlength="4" required>
                                <div class="payment-error-message" id="cvvError">Invalid CVV</div>
                            </div>
                            
                            <div class="payment-info-notes">
                                <div class="payment-info-note">
                                    <span class="payment-info-icon">ℹ️</span>
                                    <p>Your card is only charged after the ride. Funds are temporarily reserved with a pre-authorization.</p>
                                </div>
                            </div>
                            
                            <button type="submit" class="payment-continue-btn enabled">
                                Add credit or debit card
                            </button>
                        </form>
                    </div>
                </div>
            </div>

            <!-- Success Message -->
            <div id="successMessage" class="payment-success-message">
                <span>✓</span>
                <span id="successText">Card added successfully</span>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // Load saved cards from localStorage
    loadSavedCards() {
        const saved = localStorage.getItem('savedPaymentMethods');
        if (saved) {
            this.savedCards = JSON.parse(saved);
        }
        this.updatePaymentDisplay();
    }

    // Save cards to localStorage
    saveCardsToStorage() {
        const safeCards = this.savedCards.map(card => ({
            id: card.id,
            brand: card.brand,
            last4: card.last4,
            expiry: card.expiry
        }));
        localStorage.setItem('savedPaymentMethods', JSON.stringify(safeCards));
    }

    // Check Apple Pay availability
    checkApplePayAvailability() {
        const isProduction = window.location.protocol === 'https:' && 
                           !window.location.hostname.includes('localhost') && 
                           !window.location.hostname.includes('127.0.0.1');
        
        if (isProduction) {
            try {
                if (window.ApplePaySession && typeof ApplePaySession.canMakePayments === 'function') {
                    if (ApplePaySession.canMakePayments()) {
                        const applePayOption = document.getElementById('applePayOptionSlide');
                        if (applePayOption) {
                            applePayOption.style.display = 'flex';
                        }
                    }
                }
            } catch (e) {
                console.log('Apple Pay check failed:', e.message);
            }
        }
    }

    // Update payment display
    updatePaymentDisplay() {
        const emptyState = document.getElementById('emptyState');
        const cardsContainer = document.getElementById('cardsListContainer');
        const editBtn = document.getElementById('editCardsBtn');
        const continueBtnList = document.getElementById('continueBtnList');
        const paymentList = document.getElementById('paymentMethodsList');

        if (!emptyState || !cardsContainer) return;

        if (this.savedCards.length === 0) {
            emptyState.classList.add('visible');
            cardsContainer.classList.remove('visible');
            if (editBtn) editBtn.style.display = 'none';
            if (continueBtnList) continueBtnList.style.display = 'none';
        } else {
            emptyState.classList.remove('visible');
            cardsContainer.classList.add('visible');
            if (editBtn) editBtn.style.display = 'flex';
            if (continueBtnList) continueBtnList.style.display = 'block';
            
            // Clear and rebuild list
            if (paymentList) {
                paymentList.innerHTML = '';
                
                // Add Apple Pay if available
                const applePayOption = document.getElementById('applePayOptionSlide');
                if (applePayOption && applePayOption.style.display === 'flex') {
                    const applePayRow = this.createPaymentRow({
                        id: 'apple-pay',
                        brand: 'Apple Pay',
                        icon: '🍎 Pay',
                        text: 'Apple Pay'
                    });
                    paymentList.appendChild(applePayRow);
                }
                
                // Add saved cards
                this.savedCards.forEach(card => {
                    const cardRow = this.createPaymentRow(card);
                    paymentList.appendChild(cardRow);
                });
                
                // Enable continue button if payment selected
                if (continueBtnList) {
                    if (this.selectedPaymentMethod) {
                        continueBtnList.classList.add('enabled');
                    } else {
                        continueBtnList.classList.remove('enabled');
                    }
                }
            }
        }
    }

    // Create payment row
    createPaymentRow(card) {
        const row = document.createElement('div');
        row.className = 'payment-method-row';
        row.dataset.method = card.id;
        
        if (this.selectedPaymentMethod === card.id) {
            row.classList.add('selected');
        }
        
        let iconHtml = '';
        let textContent = '';
        
        if (card.id === 'apple-pay') {
            iconHtml = '<div class="payment-card-icon apple-pay">🍎 Pay</div>';
            textContent = 'Apple Pay';
        } else {
            const brandClass = card.brand.toLowerCase();
            iconHtml = `<div class="payment-card-icon ${brandClass}">${card.brand.toUpperCase()}</div>`;
            textContent = `${card.brand}, •••• ${card.last4}`;
        }
        
        row.innerHTML = `
            <div class="payment-method-icon">${iconHtml}</div>
            <div class="payment-method-text">${textContent}</div>
            <div class="payment-method-check"></div>
            <button class="payment-method-delete" onclick="event.stopPropagation(); PaymentModal.getInstance().removeCard('${card.id}')">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FF453A" stroke-width="2">
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6"/>
                </svg>
            </button>
        `;
        
        // Add click handler for selection
        row.addEventListener('click', (e) => {
            if (!this.isEditMode && !e.target.closest('.payment-method-delete')) {
                this.selectPayment(row);
            }
        });
        
        return row;
    }

    // Open payment modal
    open() {
        this.init();
        const modal = document.getElementById('paymentModal');
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
            this.updatePaymentDisplay();
        }
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
                document.getElementById('cardForm')?.reset();
                this.clearAllErrors();
            }, 300);
        }
    }

    // Select payment method
    selectPayment(element) {
        if (this.isEditMode) return;
        
        document.querySelectorAll('.payment-method-row').forEach(row => {
            row.classList.remove('selected');
        });
        
        element.classList.add('selected');
        this.selectedPaymentMethod = element.dataset.method;
        
        const continueBtnList = document.getElementById('continueBtnList');
        if (continueBtnList) {
            continueBtnList.classList.add('enabled');
        }
    }

    // Toggle edit mode
    toggleEditMode() {
        const modal = document.getElementById('paymentModal');
        const editBtn = document.getElementById('editCardsBtn');
        
        this.isEditMode = !this.isEditMode;
        
        if (this.isEditMode) {
            modal.classList.add('edit-mode');
            if (editBtn) editBtn.textContent = 'Done';
        } else {
            modal.classList.remove('edit-mode');
            if (editBtn) editBtn.innerHTML = '✏️';
        }
    }

    // Remove card
    removeCard(cardId) {
        if (cardId === 'apple-pay') {
            this.showSuccessMessage('Apple Pay cannot be removed');
            return;
        }
        
        const cardToRemove = this.savedCards.find(card => card.id === cardId);
        if (!cardToRemove) return;
        
        const confirmMessage = `Remove ${cardToRemove.brand} •••• ${cardToRemove.last4}?`;
        if (!confirm(confirmMessage)) return;
        
        // Remove from array
        this.savedCards = this.savedCards.filter(card => card.id !== cardId);
        
        // Save to storage
        this.saveCardsToStorage();
        
        // Clear selection if removing selected card
        if (this.selectedPaymentMethod === cardId) {
            this.selectedPaymentMethod = null;
        }
        
        // Show success message
        this.showSuccessMessage(`${cardToRemove.brand} •••• ${cardToRemove.last4} removed`);
        
        // Update display
        this.updatePaymentDisplay();
        
        // Exit edit mode if no cards left
        if (this.savedCards.length === 0 && this.isEditMode) {
            this.toggleEditMode();
        }
    }

    // Confirm payment selection
    confirmPayment() {
        if (!this.selectedPaymentMethod) {
            alert('Please select a payment method');
            return;
        }
        
        const selected = document.querySelector('.payment-method-row.selected');
        if (selected) {
            const paymentText = selected.querySelector('.payment-method-text').textContent;
            console.log('Selected payment:', paymentText);
            
            // Update main UI payment button if exists
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

    // Save card
    saveCard(event) {
        event.preventDefault();
        
        const cardNumber = document.getElementById('cardNumber').value.replace(/\s/g, '');
        const expiryDate = document.getElementById('expiryDate').value;
        const cvv = document.getElementById('cvv').value;
        const cardholderName = document.getElementById('cardholderName').value;
        
        // Basic validation
        if (!this.validateCardNumber(cardNumber)) {
            this.showError('cardNumber', 'numberError');
            return;
        }
        
        if (!this.validateExpiryDate(expiryDate)) {
            this.showError('expiryDate', 'expiryError');
            return;
        }
        
        if (!this.validateCVV(cvv)) {
            this.showError('cvv', 'cvvError');
            return;
        }
        
        // Detect card brand
        const brand = this.detectCardBrand(cardNumber);
        const last4 = cardNumber.slice(-4);
        
        // Create new card object
        const newCard = {
            id: `${brand.toLowerCase()}-${last4}-${Date.now()}`,
            brand: brand,
            last4: last4,
            expiry: expiryDate
        };
        
        // Add to saved cards
        this.savedCards.push(newCard);
        this.saveCardsToStorage();
        
        // Show success message
        this.showSuccessMessage('Card added successfully');
        
        // Close modal and update display
        this.closeCardInputModal();
        this.updatePaymentDisplay();
        
        // Select the new card
        setTimeout(() => {
            const newRow = document.querySelector(`[data-method="${newCard.id}"]`);
            if (newRow) {
                this.selectPayment(newRow);
            }
        }, 100);
    }

    // Card validation methods
    validateCardNumber(number) {
        // Simple Luhn algorithm check
        if (number.length < 13 || number.length > 19) return false;
        
        let sum = 0;
        let isEven = false;
        
        for (let i = number.length - 1; i >= 0; i--) {
            let digit = parseInt(number[i], 10);
            
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

    validateExpiryDate(expiry) {
        const parts = expiry.split('/');
        if (parts.length !== 2) return false;
        
        const month = parseInt(parts[0], 10);
        const year = parseInt('20' + parts[1], 10);
        
        if (month < 1 || month > 12) return false;
        
        const now = new Date();
        const expiryDate = new Date(year, month - 1);
        
        return expiryDate >= now;
    }

    validateCVV(cvv) {
        return cvv.length === 3 || cvv.length === 4;
    }

    detectCardBrand(number) {
        if (/^4/.test(number)) return 'Visa';
        if (/^5[1-5]/.test(number)) return 'Mastercard';
        if (/^3[47]/.test(number)) return 'Amex';
        if (/^6(?:011|5)/.test(number)) return 'Discover';
        return 'Card';
    }

    // Show error
    showError(inputId, errorId) {
        document.getElementById(inputId)?.classList.add('error');
        document.getElementById(errorId)?.classList.add('visible');
    }

    // Clear all errors
    clearAllErrors() {
        document.querySelectorAll('.payment-form-input').forEach(input => {
            input.classList.remove('error');
        });
        document.querySelectorAll('.payment-error-message').forEach(error => {
            error.classList.remove('visible');
        });
    }

    // Show success message
    showSuccessMessage(text) {
        const message = document.getElementById('successMessage');
        const textEl = document.getElementById('successText');
        
        if (message && textEl) {
            textEl.textContent = text;
            message.classList.add('show');
            
            setTimeout(() => {
                message.classList.remove('show');
            }, 3000);
        }
    }

    // Select Apple Pay
    selectApplePay() {
        // Create temporary Apple Pay card
        const applePayCard = {
            id: 'apple-pay',
            brand: 'Apple Pay',
            last4: 'Apple',
            expiry: 'N/A'
        };
        
        // Select it
        this.selectedPaymentMethod = 'apple-pay';
        
        // Close add payment modal
        this.closeAddPaymentModal();
        
        // Update display
        this.updatePaymentDisplay();
        
        // Show success
        this.showSuccessMessage('Apple Pay selected');
    }

    // Attach event listeners
    attachEventListeners() {
        // Card number formatting
        document.addEventListener('input', (e) => {
            if (e.target.id === 'cardNumber') {
                let value = e.target.value.replace(/\s/g, '');
                let formatted = value.match(/.{1,4}/g)?.join(' ') || value;
                e.target.value = formatted;
                
                // Update card type icon
                const brand = this.detectCardBrand(value);
                const icon = document.getElementById('cardTypeIcon');
                if (icon) {
                    icon.innerHTML = brand !== 'Card' ? 
                        `<div class="payment-card-icon ${brand.toLowerCase()}">${brand.toUpperCase()}</div>` : '';
                }
            }
            
            // Expiry date formatting
            if (e.target.id === 'expiryDate') {
                let value = e.target.value.replace(/\D/g, '');
                if (value.length >= 2) {
                    value = value.slice(0, 2) + (value.length > 2 ? '/' + value.slice(2, 4) : '');
                }
                e.target.value = value;
            }
            
            // CVV numbers only
            if (e.target.id === 'cvv') {
                e.target.value = e.target.value.replace(/\D/g, '');
            }
        });

        // Close modals on overlay click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('payment-full-modal') && e.target.classList.contains('active')) {
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

    // Get selected payment method
    getSelectedPayment() {
        return this.selectedPaymentMethod;
    }

    // Singleton pattern
    static instance = null;
    
    static getInstance() {
        if (!this.instance) {
            this.instance = new PaymentModal();
        }
        return this.instance;
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    PaymentModal.getInstance().init();
});

// Expose for global access
window.PaymentModal = PaymentModal;