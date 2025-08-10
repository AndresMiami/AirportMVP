/**
 * Passenger Modal Controller
 * Handles passenger selection and guest information
 */

class PassengerModal {
    constructor() {
        this.selectedType = 'myself';
        this.guestData = null;
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
        if (document.getElementById('passenger-modal-styles')) return;
        
        const styles = `
            <style id="passenger-modal-styles">
                /* Dark Theme Modal Base */
                .passenger-full-modal {
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

                .passenger-full-modal.active {
                    display: flex !important;
                    animation: fadeIn 0.3s ease-out;
                }

                .passenger-modal-panel {
                    width: 100%;
                    max-width: 576px;
                    min-height: 200px;
                    background: #2C2C2E;
                    display: flex;
                    flex-direction: column;
                    animation: slideUp 0.3s ease-out;
                    border-radius: 20px 20px 0 0;
                }

                @keyframes slideUp {
                    from { transform: translateY(100%); }
                    to { transform: translateY(0); }
                }

                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }

                /* Modal Header */
                .passenger-modal-header {
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

                .passenger-modal-back-btn {
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

                .passenger-modal-back-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .passenger-modal-header h2 {
                    font-size: 20px;
                    font-weight: 600;
                    color: #FFFFFF;
                    margin: 0;
                    flex: 1;
                    text-align: center;
                }

                /* Map Section - Compact and Clean */
                .passenger-modal-map-section {
                    position: relative;
                    height: 80px;
                    background: linear-gradient(135deg, #2C2C2E 0%, #1C1C1E 100%);
                    overflow: hidden;
                    border-bottom: 1px solid #3A3A3C;
                }

                .passenger-modal-map {
                    width: 100%;
                    height: 100%;
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                /* Subtle map icon */
                .passenger-modal-map::after {
                    content: '📍';
                    font-size: 32px;
                    opacity: 0.2;
                }

                /* Content Section */
                .passenger-modal-content-section {
                    flex: 1;
                    padding: 20px;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                }

                .passenger-booking-option-card {
                    background: #3A3A3C;
                    border-radius: 12px;
                    padding: 16px;
                    margin-bottom: 20px;
                    display: flex;
                    gap: 12px;
                }

                .passenger-option-icon {
                    width: 48px;
                    height: 48px;
                    background: #FF9500;
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                }

                .passenger-option-icon img {
                    width: 28px;
                    height: 28px;
                }

                .passenger-option-content h3 {
                    font-size: 17px;
                    font-weight: 600;
                    color: #FFFFFF;
                    margin: 0 0 8px 0;
                }

                .passenger-option-content p {
                    font-size: 14px;
                    color: #8E8E93;
                    line-height: 1.4;
                    margin: 0 0 12px 0;
                }

                .passenger-learn-more-link {
                    color: #FF9500;
                    text-decoration: none;
                    font-size: 14px;
                    font-weight: 500;
                }

                /* Booking Options */
                .passenger-booking-options {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }

                .passenger-booking-option-btn {
                    display: flex;
                    align-items: center;
                    padding: 16px;
                    background: #3A3A3C;
                    border: 2px solid #48484A;
                    border-radius: 12px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .passenger-booking-option-btn:hover {
                    background: #48484A;
                    border-color: #5A5A5C;
                }

                .passenger-booking-option-btn.active {
                    border-color: #FF9500;
                    background: rgba(255, 149, 0, 0.1);
                }

                .passenger-option-radio {
                    width: 20px;
                    height: 20px;
                    border: 2px solid #48484A;
                    border-radius: 50%;
                    margin-right: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: transparent;
                    transition: all 0.2s;
                }

                .passenger-booking-option-btn.active .passenger-option-radio {
                    border-color: #FF9500;
                    background: #FF9500;
                    color: #2C2C2E;
                }

                .passenger-option-icon-plus {
                    width: 20px;
                    height: 20px;
                    background: #FF9500;
                    color: #2C2C2E;
                    border-radius: 50%;
                    margin-right: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 18px;
                    font-weight: bold;
                }

                .passenger-option-text {
                    flex: 1;
                    font-size: 17px;
                    color: #FFFFFF;
                }

                .passenger-option-arrow {
                    font-size: 20px;
                    color: #8E8E93;
                }

                /* Guest Form */
                .passenger-modal-scrollable-content {
                    flex: 1;
                    padding: 24px;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                }

                .passenger-form-group {
                    margin-bottom: 24px;
                }

                .passenger-form-group label {
                    display: block;
                    font-size: 13px;
                    font-weight: 600;
                    color: #8E8E93;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 8px;
                }

                .passenger-form-input,
                .passenger-form-select {
                    width: 100%;
                    padding: 14px 16px;
                    background: #3A3A3C;
                    border: 1px solid #48484A;
                    border-radius: 10px;
                    font-size: 16px;
                    color: #FFFFFF;
                    transition: all 0.2s;
                }

                .passenger-form-input::placeholder {
                    color: #6D6D70;
                }

                .passenger-form-input:focus,
                .passenger-form-select:focus {
                    outline: none;
                    border-color: #FF9500;
                    background: #48484A;
                }

                .passenger-form-row {
                    display: flex;
                    gap: 12px;
                }

                .passenger-info-notes {
                    margin: 24px 0;
                    padding: 16px;
                    background: rgba(255, 149, 0, 0.1);
                    border: 1px solid rgba(255, 149, 0, 0.2);
                    border-radius: 12px;
                }

                .passenger-info-note {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 8px;
                }

                .passenger-info-note:last-child {
                    margin-bottom: 0;
                }

                .passenger-info-icon {
                    flex-shrink: 0;
                    font-size: 16px;
                }

                .passenger-info-note p {
                    font-size: 14px;
                    color: #FFFFFF;
                    line-height: 1.4;
                    margin: 0;
                }

                .passenger-modal-action-btn {
                    width: 100%;
                    padding: 16px;
                    background: #FF9500;
                    color: #FFFFFF;
                    border: none;
                    border-radius: 12px;
                    font-size: 17px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    margin-top: 24px;
                }

                .passenger-modal-action-btn:hover {
                    background: #FF8C00;
                }

                .passenger-modal-action-btn:active {
                    transform: scale(0.98);
                }

                /* Mobile optimizations */
                @media (max-width: 480px) {
                    .passenger-modal-panel {
                        border-radius: 0;
                        max-width: 100%;
                        height: 100vh;
                    }

                    .passenger-modal-header {
                        padding: 16px 20px;
                        border-radius: 0;
                    }

                    .passenger-modal-scrollable-content {
                        padding: 20px;
                    }
                }
            </style>
        `;
        
        document.head.insertAdjacentHTML('beforeend', styles);
    }

    createModal() {
        // Check if modals already exist
        if (document.getElementById('passengerSelectionModal')) return;

        const modalHTML = `
            <!-- Passenger Selection Modal -->
            <div id="passengerSelectionModal" class="passenger-full-modal">
                <div class="passenger-modal-panel">
                    <div class="passenger-modal-map-section">
                        <div id="passengerModalMap" class="passenger-modal-map"></div>
                    </div>
                    
                    <div class="passenger-modal-content-section">
                        <div class="passenger-booking-option-card">
                            <div class="passenger-option-icon">
                                <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23FFFFFF' stroke-width='2'%3E%3Cpath d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'%3E%3C/path%3E%3Ccircle cx='12' cy='7' r='4'%3E%3C/circle%3E%3C/svg%3E" alt="Person icon">
                            </div>
                            <div class="passenger-option-content">
                                <h3>Booking a ride for someone else?</h3>
                                <p>Arrange their ride in a few taps, and we'll keep them informed every step of the way.</p>
                                <a href="#" class="passenger-learn-more-link" onclick="event.preventDefault()">Learn more</a>
                            </div>
                        </div>
                        
                        <div class="passenger-booking-options">
                            <button class="passenger-booking-option-btn active" onclick="PassengerModal.getInstance().selectBookingType('myself')">
                                <span class="passenger-option-radio">●</span>
                                <span class="passenger-option-text">Book for myself</span>
                            </button>
                            
                            <button class="passenger-booking-option-btn" onclick="PassengerModal.getInstance().openAddGuestModal()">
                                <span class="passenger-option-icon-plus">+</span>
                                <span class="passenger-option-text">Add guest</span>
                                <span class="passenger-option-arrow">›</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Add Guest Modal -->
            <div id="addGuestModal" class="passenger-full-modal">
                <div class="passenger-modal-panel">
                    <div class="passenger-modal-header">
                        <button class="passenger-modal-back-btn" onclick="PassengerModal.getInstance().backToPassengerSelection()">←</button>
                        <h2>Add guest</h2>
                        <button class="passenger-modal-back-btn" onclick="PassengerModal.getInstance().backToPassengerSelection()">✕</button>
                    </div>
                    
                    <div class="passenger-modal-scrollable-content">
                        <form id="guestForm" onsubmit="PassengerModal.getInstance().saveGuest(event)">
                            <div class="passenger-form-group">
                                <label for="guestTitle">Title</label>
                                <select id="guestTitle" class="passenger-form-select">
                                    <option value="Mx.">Mx.</option>
                                    <option value="Mr.">Mr.</option>
                                    <option value="Ms.">Ms.</option>
                                    <option value="Mrs.">Mrs.</option>
                                    <option value="Dr.">Dr.</option>
                                </select>
                            </div>
                            
                            <div class="passenger-form-group">
                                <label for="guestFirstName">First name</label>
                                <input type="text" id="guestFirstName" class="passenger-form-input" required>
                            </div>
                            
                            <div class="passenger-form-group">
                                <label for="guestLastName">Last name</label>
                                <input type="text" id="guestLastName" class="passenger-form-input" required>
                            </div>
                            
                            <div class="passenger-form-group">
                                <label for="guestEmail">Guest email</label>
                                <input type="email" id="guestEmail" class="passenger-form-input" placeholder="email@example.com">
                            </div>
                            
                            <div class="passenger-form-row">
                                <div class="passenger-form-group" style="flex: 0 0 120px;">
                                    <label for="countryCode">Country Code</label>
                                    <select id="countryCode" class="passenger-form-select">
                                        <option value="+1">US +1</option>
                                        <option value="+44">UK +44</option>
                                        <option value="+33">FR +33</option>
                                        <option value="+49">DE +49</option>
                                        <option value="+34">ES +34</option>
                                    </select>
                                </div>
                                <div class="passenger-form-group" style="flex: 1;">
                                    <label for="guestPhone">Mobile number</label>
                                    <input type="tel" id="guestPhone" class="passenger-form-input" placeholder="(305) 555-0123" required>
                                </div>
                            </div>
                            
                            <div class="passenger-info-notes">
                                <div class="passenger-info-note">
                                    <span class="passenger-info-icon">ℹ️</span>
                                    <p>The contact info entered will receive ride updates and booking confirmation.</p>
                                </div>
                                <div class="passenger-info-note">
                                    <span class="passenger-info-icon">ℹ️</span>
                                    <p>Invoices are sent only to the booker, not the guest.</p>
                                </div>
                            </div>
                            
                            <button type="submit" class="passenger-modal-action-btn">Add guest</button>
                        </form>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // Open passenger selection modal
    open() {
        this.init();
        const modal = document.getElementById('passengerSelectionModal');
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
            this.updateModalInfo();
        }
    }

    // Close passenger selection modal
    close() {
        const modal = document.getElementById('passengerSelectionModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }
    }

    // Select booking type
    selectBookingType(type) {
        this.selectedType = type;
        
        // Update button states
        const buttons = document.querySelectorAll('.passenger-booking-option-btn');
        buttons.forEach(btn => {
            btn.classList.remove('active');
        });
        
        if (type === 'myself') {
            buttons[0]?.classList.add('active');
            this.guestData = null;
            this.close();
            this.updatePassengerButton();
        }
    }

    // Open add guest modal
    openAddGuestModal() {
        document.getElementById('passengerSelectionModal').style.display = 'none';
        const modal = document.getElementById('addGuestModal');
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
        }
    }

    // Back to passenger selection
    backToPassengerSelection() {
        const addGuestModal = document.getElementById('addGuestModal');
        if (addGuestModal) {
            addGuestModal.classList.remove('active');
            setTimeout(() => {
                addGuestModal.style.display = 'none';
            }, 300);
        }
        
        const passengerModal = document.getElementById('passengerSelectionModal');
        if (passengerModal) {
            passengerModal.style.display = 'flex';
            setTimeout(() => passengerModal.classList.add('active'), 10);
        }
    }

    // Save guest information
    saveGuest(event) {
        event.preventDefault();
        
        const title = document.getElementById('guestTitle').value;
        const firstName = document.getElementById('guestFirstName').value;
        const lastName = document.getElementById('guestLastName').value;
        const email = document.getElementById('guestEmail').value;
        const countryCode = document.getElementById('countryCode').value;
        const phone = document.getElementById('guestPhone').value;
        
        this.guestData = {
            title,
            firstName,
            lastName,
            email,
            countryCode,
            phone,
            fullName: `${title} ${firstName} ${lastName}`
        };
        
        // Close modal
        const modal = document.getElementById('addGuestModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }
        
        // Update passenger button
        this.updatePassengerButton();
    }

    // Update passenger button display
    updatePassengerButton() {
        // Try to find the passenger button with different selectors
        const btn = document.querySelector('.passenger-select, .passenger-btn-mobile');
        if (!btn) return;
        
        const iconSpan = btn.querySelector('.control-icon');
        const textSpan = btn.querySelector('.control-text, .control-details');
        
        if (this.guestData) {
            if (iconSpan) iconSpan.textContent = '👥';
            if (textSpan) textSpan.textContent = this.guestData.fullName;
            btn.classList.add('guest-selected');
        } else {
            if (iconSpan) iconSpan.textContent = '👤';
            if (textSpan) textSpan.textContent = 'For myself';
            btn.classList.remove('guest-selected');
        }
        
        // Dispatch event for app state sync
        window.dispatchEvent(new CustomEvent('passengerDataChanged'));
    }

    // Update modal info (simplified - no longer showing times/location)
    updateModalInfo() {
        // This method is now simplified since we're not showing times/location
        // Could be used in the future if we want to add any dynamic content
    }

    // Get selected passenger data
    getPassengerData() {
        if (this.selectedType === 'myself') {
            return { type: 'myself' };
        } else if (this.guestData) {
            return { type: 'guest', data: this.guestData };
        }
        return null;
    }

    // Attach event listeners
    attachEventListeners() {
        // Close modal on overlay click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('passenger-full-modal') && e.target.classList.contains('active')) {
                if (e.target.id === 'passengerSelectionModal') {
                    this.close();
                } else if (e.target.id === 'addGuestModal') {
                    this.backToPassengerSelection();
                }
            }
        });

        // Escape key to close modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const addGuestModal = document.getElementById('addGuestModal');
                const passengerModal = document.getElementById('passengerSelectionModal');
                
                if (addGuestModal?.classList.contains('active')) {
                    this.backToPassengerSelection();
                } else if (passengerModal?.classList.contains('active')) {
                    this.close();
                }
            }
        });
    }

    // Singleton pattern
    static instance = null;
    
    static getInstance() {
        if (!this.instance) {
            this.instance = new PassengerModal();
        }
        return this.instance;
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    PassengerModal.getInstance().init();
});

// Expose for global access
window.PassengerModal = PassengerModal;