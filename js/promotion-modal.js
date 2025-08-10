/**
 * Promotion Modal Controller
 * Handles promotion codes, discounts, and special offers
 */

class PromotionModal {
    constructor() {
        this.promoCode = null;
        this.discount = null;
        this.isValidating = false;
        this.isInitialized = false;
    }

    init() {
        if (this.isInitialized) return;
        
        this.injectStyles();
        this.createModal();
        this.attachEventListeners();
        this.isInitialized = true;
    }

    injectStyles() {
        if (document.getElementById('promotion-modal-styles')) return;
        
        const styles = `
            <style id="promotion-modal-styles">
                /* Dark Theme Modal Base for Promotions */
                .promo-full-modal {
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

                .promo-full-modal.active {
                    display: flex !important;
                    animation: promoFadeIn 0.3s ease-out;
                }

                .promo-modal-panel {
                    width: 100%;
                    max-width: 576px;
                    min-height: 200px;
                    background: #2C2C2E;
                    display: flex;
                    flex-direction: column;
                    animation: promoSlideUp 0.3s ease-out;
                    border-radius: 20px 20px 0 0;
                }

                @keyframes promoSlideUp {
                    from { transform: translateY(100%); }
                    to { transform: translateY(0); }
                }

                @keyframes promoFadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }

                /* Modal Header */
                .promo-modal-header {
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

                .promo-modal-back-btn {
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

                .promo-modal-back-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .promo-modal-header h2 {
                    font-size: 20px;
                    font-weight: 600;
                    color: #FFFFFF;
                    margin: 0;
                    flex: 1;
                    text-align: center;
                }

                /* Content Section */
                .promo-modal-scrollable-content {
                    flex: 1;
                    padding: 24px;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                }

                .promo-modal-subtitle {
                    font-size: 15px;
                    color: #8E8E93;
                    line-height: 1.4;
                    margin-bottom: 24px;
                }

                /* Promo Code Input Group */
                .promo-input-group {
                    position: relative;
                    margin-bottom: 24px;
                }

                .promo-form-group {
                    margin-bottom: 24px;
                }

                .promo-form-group label {
                    display: block;
                    font-size: 13px;
                    font-weight: 600;
                    color: #8E8E93;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 8px;
                }

                .promo-input-wrapper {
                    position: relative;
                    display: flex;
                    gap: 12px;
                }

                .promo-form-input {
                    flex: 1;
                    padding: 14px 16px;
                    background: #3A3A3C;
                    border: 1px solid #48484A;
                    border-radius: 10px;
                    font-size: 16px;
                    color: #FFFFFF;
                    transition: all 0.2s;
                    text-transform: uppercase;
                }

                .promo-form-input::placeholder {
                    color: #6D6D70;
                    text-transform: none;
                }

                .promo-form-input:focus {
                    outline: none;
                    border-color: #FF9500;
                    background: #48484A;
                }

                .promo-form-input.valid {
                    border-color: #32D74B;
                }

                .promo-form-input.invalid {
                    border-color: #FF453A;
                }

                /* Apply Button */
                .promo-apply-btn {
                    padding: 14px 24px;
                    background: #FF9500;
                    color: #FFFFFF;
                    border: none;
                    border-radius: 10px;
                    font-size: 16px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    white-space: nowrap;
                }

                .promo-apply-btn:hover:not(:disabled) {
                    background: #FF8C00;
                }

                .promo-apply-btn:active:not(:disabled) {
                    transform: scale(0.98);
                }

                .promo-apply-btn:disabled {
                    background: #48484A;
                    color: #8E8E93;
                    cursor: not-allowed;
                }

                .promo-apply-btn.loading {
                    position: relative;
                    color: transparent;
                }

                .promo-apply-btn.loading::after {
                    content: '';
                    position: absolute;
                    width: 16px;
                    height: 16px;
                    top: 50%;
                    left: 50%;
                    margin-left: -8px;
                    margin-top: -8px;
                    border: 2px solid #FFFFFF;
                    border-radius: 50%;
                    border-top-color: transparent;
                    animation: promoSpin 0.8s linear infinite;
                }

                @keyframes promoSpin {
                    to { transform: rotate(360deg); }
                }

                /* Status Messages */
                .promo-status-message {
                    display: none;
                    padding: 12px 16px;
                    border-radius: 8px;
                    margin-top: 12px;
                    font-size: 14px;
                    align-items: center;
                    gap: 8px;
                }

                .promo-status-message.show {
                    display: flex;
                }

                .promo-status-message.success {
                    background: rgba(50, 215, 75, 0.1);
                    border: 1px solid rgba(50, 215, 75, 0.3);
                    color: #32D74B;
                }

                .promo-status-message.error {
                    background: rgba(255, 69, 58, 0.1);
                    border: 1px solid rgba(255, 69, 58, 0.3);
                    color: #FF453A;
                }

                /* Applied Promo Display */
                .promo-applied-card {
                    display: none;
                    background: rgba(50, 215, 75, 0.1);
                    border: 1px solid rgba(50, 215, 75, 0.3);
                    border-radius: 12px;
                    padding: 16px;
                    margin-bottom: 24px;
                }

                .promo-applied-card.show {
                    display: block;
                }

                .promo-applied-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                }

                .promo-applied-code {
                    font-size: 18px;
                    font-weight: 600;
                    color: #FFFFFF;
                }

                .promo-remove-btn {
                    background: none;
                    border: none;
                    color: #FF453A;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 500;
                    padding: 4px 8px;
                    border-radius: 4px;
                    transition: background 0.2s;
                }

                .promo-remove-btn:hover {
                    background: rgba(255, 69, 58, 0.1);
                }

                .promo-discount-amount {
                    font-size: 24px;
                    font-weight: 700;
                    color: #32D74B;
                    margin-bottom: 4px;
                }

                .promo-discount-description {
                    font-size: 14px;
                    color: #8E8E93;
                }

                /* Available Promotions */
                .promo-available-section {
                    margin-top: 32px;
                    padding-top: 24px;
                    border-top: 1px solid #3A3A3C;
                }

                .promo-available-title {
                    font-size: 13px;
                    font-weight: 600;
                    color: #8E8E93;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 16px;
                }

                .promo-available-list {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }

                .promo-available-item {
                    background: #3A3A3C;
                    border: 1px solid #48484A;
                    border-radius: 10px;
                    padding: 12px 16px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .promo-available-item:hover {
                    background: #48484A;
                    border-color: #FF9500;
                }

                .promo-available-code {
                    font-size: 14px;
                    font-weight: 600;
                    color: #FF9500;
                    margin-bottom: 4px;
                }

                .promo-available-desc {
                    font-size: 12px;
                    color: #8E8E93;
                }

                /* Mobile Optimizations */
                @media (max-width: 480px) {
                    .promo-modal-panel {
                        border-radius: 0;
                        max-width: 100%;
                        height: 100vh;
                    }

                    .promo-modal-header {
                        padding: 16px 20px;
                        border-radius: 0;
                    }

                    .promo-modal-scrollable-content {
                        padding: 20px;
                    }

                    .promo-input-wrapper {
                        flex-direction: column;
                    }

                    .promo-apply-btn {
                        width: 100%;
                    }
                }

                /* Desktop adjustments */
                @media (min-width: 768px) {
                    .promo-modal-panel {
                        height: auto;
                        max-height: 90vh;
                        margin: 20px;
                        border-radius: 20px;
                    }

                    .promo-modal-header {
                        border-radius: 20px 20px 0 0;
                    }

                    .promo-full-modal {
                        align-items: center;
                    }
                }
            </style>
        `;
        
        document.head.insertAdjacentHTML('beforeend', styles);
    }

    createModal() {
        // Check if modal already exists
        if (document.getElementById('promotionModal')) return;

        const modalHTML = `
            <!-- Promotion Modal -->
            <div id="promotionModal" class="promo-full-modal">
                <div class="promo-modal-panel">
                    <div class="promo-modal-header">
                        <span style="width: 40px;"></span>
                        <h2>Add Promotion</h2>
                        <button class="promo-modal-back-btn" onclick="PromotionModal.getInstance().close()">✕</button>
                    </div>
                    
                    <div class="promo-modal-scrollable-content">
                        <p class="promo-modal-subtitle">Enter a promotion code to apply a discount to your booking.</p>
                        
                        <!-- Applied Promo Display -->
                        <div id="appliedPromoCard" class="promo-applied-card">
                            <div class="promo-applied-header">
                                <span class="promo-applied-code" id="appliedPromoCode"></span>
                                <button class="promo-remove-btn" onclick="PromotionModal.getInstance().removePromo()">Remove</button>
                            </div>
                            <div class="promo-discount-amount" id="promoDiscountAmount"></div>
                            <div class="promo-discount-description" id="promoDiscountDesc"></div>
                        </div>
                        
                        <!-- Promo Input -->
                        <div class="promo-form-group">
                            <label for="promoCodeInput">Promotion Code</label>
                            <div class="promo-input-wrapper">
                                <input 
                                    type="text" 
                                    id="promoCodeInput" 
                                    class="promo-form-input" 
                                    placeholder="Enter code"
                                    maxlength="20"
                                    oninput="PromotionModal.getInstance().handleInput()"
                                >
                                <button 
                                    type="button" 
                                    id="applyPromoBtn"
                                    class="promo-apply-btn"
                                    onclick="PromotionModal.getInstance().applyPromo()"
                                    disabled
                                >
                                    Apply
                                </button>
                            </div>
                            
                            <!-- Status Messages -->
                            <div id="promoStatusMessage" class="promo-status-message">
                                <span id="promoStatusIcon"></span>
                                <span id="promoStatusText"></span>
                            </div>
                        </div>
                        
                        <!-- Available Promotions (Optional) -->
                        <div class="promo-available-section">
                            <div class="promo-available-title">Available Promotions</div>
                            <div class="promo-available-list">
                                <div class="promo-available-item" onclick="PromotionModal.getInstance().applyQuickPromo('FIRST10')">
                                    <div class="promo-available-code">FIRST10</div>
                                    <div class="promo-available-desc">10% off your first ride</div>
                                </div>
                                <div class="promo-available-item" onclick="PromotionModal.getInstance().applyQuickPromo('AIRPORT20')">
                                    <div class="promo-available-code">AIRPORT20</div>
                                    <div class="promo-available-desc">$20 off airport transfers</div>
                                </div>
                                <div class="promo-available-item" onclick="PromotionModal.getInstance().applyQuickPromo('WEEKEND15')">
                                    <div class="promo-available-code">WEEKEND15</div>
                                    <div class="promo-available-desc">15% off weekend bookings</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // Open modal
    open() {
        this.init();
        const modal = document.getElementById('promotionModal');
        if (modal) {
            // Show applied promo if exists
            if (this.promoCode) {
                this.showAppliedPromo();
            }
            
            modal.style.display = 'flex';
            setTimeout(() => {
                modal.classList.add('active');
                document.getElementById('promoCodeInput')?.focus();
            }, 10);
        }
    }

    // Close modal
    close() {
        const modal = document.getElementById('promotionModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
                this.resetForm();
            }, 300);
        }
    }

    // Handle input changes
    handleInput() {
        const input = document.getElementById('promoCodeInput');
        const applyBtn = document.getElementById('applyPromoBtn');
        
        if (!input || !applyBtn) return;
        
        const value = input.value.trim();
        
        // Enable/disable apply button
        applyBtn.disabled = value.length < 3;
        
        // Clear any previous status
        this.hideStatusMessage();
        input.classList.remove('valid', 'invalid');
    }

    // Apply promo code
    async applyPromo() {
        const input = document.getElementById('promoCodeInput');
        const applyBtn = document.getElementById('applyPromoBtn');
        
        if (!input || !applyBtn) return;
        
        const code = input.value.trim().toUpperCase();
        
        if (code.length < 3) return;
        
        // Show loading state
        applyBtn.disabled = true;
        applyBtn.classList.add('loading');
        this.isValidating = true;
        
        try {
            // Simulate API call
            await this.validatePromoCode(code);
            
            // Success
            this.promoCode = code;
            this.discount = this.getDiscountForCode(code);
            
            input.classList.add('valid');
            this.showStatusMessage('Promotion applied successfully!', 'success');
            this.showAppliedPromo();
            this.updatePromotionButton();
            
            // Dispatch event for app state sync
            window.dispatchEvent(new CustomEvent('promotionChanged'));
            
            // Clear input
            setTimeout(() => {
                input.value = '';
                input.classList.remove('valid');
                this.hideStatusMessage();
            }, 2000);
            
        } catch (error) {
            // Error
            input.classList.add('invalid');
            this.showStatusMessage(error.message || 'Invalid promotion code', 'error');
        } finally {
            applyBtn.disabled = false;
            applyBtn.classList.remove('loading');
            this.isValidating = false;
        }
    }

    // Quick apply from available list
    applyQuickPromo(code) {
        const input = document.getElementById('promoCodeInput');
        if (input) {
            input.value = code;
            this.handleInput();
            this.applyPromo();
        }
    }

    // Validate promo code (simulated)
    async validatePromoCode(code) {
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Simulated validation
        const validCodes = {
            'FIRST10': { type: 'percentage', value: 10, description: '10% off your first ride' },
            'AIRPORT20': { type: 'fixed', value: 20, description: '$20 off airport transfers' },
            'WEEKEND15': { type: 'percentage', value: 15, description: '15% off weekend bookings' },
            'SAVE25': { type: 'fixed', value: 25, description: '$25 off your booking' },
            'VIP30': { type: 'percentage', value: 30, description: '30% VIP discount' }
        };
        
        if (!validCodes[code]) {
            throw new Error('Invalid or expired promotion code');
        }
        
        return validCodes[code];
    }

    // Get discount details for code
    getDiscountForCode(code) {
        const discounts = {
            'FIRST10': { type: 'percentage', value: 10, description: '10% off your first ride' },
            'AIRPORT20': { type: 'fixed', value: 20, description: '$20 off airport transfers' },
            'WEEKEND15': { type: 'percentage', value: 15, description: '15% off weekend bookings' },
            'SAVE25': { type: 'fixed', value: 25, description: '$25 off your booking' },
            'VIP30': { type: 'percentage', value: 30, description: '30% VIP discount' }
        };
        
        return discounts[code] || null;
    }

    // Show applied promo
    showAppliedPromo() {
        const card = document.getElementById('appliedPromoCard');
        const codeEl = document.getElementById('appliedPromoCode');
        const amountEl = document.getElementById('promoDiscountAmount');
        const descEl = document.getElementById('promoDiscountDesc');
        
        if (!card || !this.promoCode || !this.discount) return;
        
        codeEl.textContent = this.promoCode;
        
        if (this.discount.type === 'percentage') {
            amountEl.textContent = `-${this.discount.value}%`;
        } else {
            amountEl.textContent = `-$${this.discount.value}`;
        }
        
        descEl.textContent = this.discount.description;
        card.classList.add('show');
    }

    // Remove promo
    removePromo() {
        this.promoCode = null;
        this.discount = null;
        
        const card = document.getElementById('appliedPromoCard');
        if (card) {
            card.classList.remove('show');
        }
        
        this.updatePromotionButton();
        this.showStatusMessage('Promotion removed', 'success');
        
        // Dispatch event for app state sync
        window.dispatchEvent(new CustomEvent('promotionChanged'));
        
        setTimeout(() => {
            this.hideStatusMessage();
        }, 2000);
    }

    // Show status message
    showStatusMessage(message, type) {
        const container = document.getElementById('promoStatusMessage');
        const icon = document.getElementById('promoStatusIcon');
        const text = document.getElementById('promoStatusText');
        
        if (!container) return;
        
        icon.textContent = type === 'success' ? '✓' : '✕';
        text.textContent = message;
        
        container.className = `promo-status-message ${type} show`;
    }

    // Hide status message
    hideStatusMessage() {
        const container = document.getElementById('promoStatusMessage');
        if (container) {
            container.classList.remove('show');
        }
    }

    // Reset form
    resetForm() {
        const input = document.getElementById('promoCodeInput');
        if (input) {
            input.value = '';
            input.classList.remove('valid', 'invalid');
        }
        
        this.hideStatusMessage();
    }

    // Update promotion button in main UI
    updatePromotionButton() {
        const btn = document.querySelector('.promo-button-mobile, [onclick*="addPromotion"]');
        if (!btn) return;
        
        if (this.promoCode) {
            btn.innerHTML = `<span class="control-icon">✅</span><span>${this.promoCode}</span>`;
            btn.classList.add('has-promo');
        } else {
            btn.innerHTML = '<span class="control-icon">🎫</span><span>Add promotion</span>';
            btn.classList.remove('has-promo');
        }
    }

    // Get promo data
    getPromoData() {
        return {
            code: this.promoCode,
            discount: this.discount
        };
    }

    // Calculate discounted price
    calculateDiscountedPrice(originalPrice) {
        if (!this.discount) return originalPrice;
        
        if (this.discount.type === 'percentage') {
            return originalPrice * (1 - this.discount.value / 100);
        } else {
            return Math.max(0, originalPrice - this.discount.value);
        }
    }

    // Attach event listeners
    attachEventListeners() {
        // Close modal on overlay click
        document.addEventListener('click', (e) => {
            if (e.target.id === 'promotionModal' && e.target.classList.contains('active')) {
                this.close();
            }
        });

        // Escape key to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.getElementById('promotionModal');
                if (modal?.classList.contains('active')) {
                    this.close();
                }
            }
        });

        // Enter key to apply promo
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const modal = document.getElementById('promotionModal');
                const input = document.getElementById('promoCodeInput');
                if (modal?.classList.contains('active') && input === document.activeElement) {
                    e.preventDefault();
                    this.applyPromo();
                }
            }
        });
    }

    // Singleton pattern
    static instance = null;
    
    static getInstance() {
        if (!this.instance) {
            this.instance = new PromotionModal();
        }
        return this.instance;
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    PromotionModal.getInstance().init();
});

// Expose for global access
window.PromotionModal = PromotionModal;