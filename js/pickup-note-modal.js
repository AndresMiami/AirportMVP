/**
 * Pickup Note Modal Controller
 * Handles pickup notes, chauffeur instructions, and reference codes
 */

class PickupNoteModal {
    constructor() {
        this.pickupData = {
            chauffeurNotes: '',
            pickupSign: '',
            referenceCode: ''
        };
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
        if (document.getElementById('pickup-note-modal-styles')) return;
        
        const styles = `
            <style id="pickup-note-modal-styles">
                /* Dark Theme Modal Base for Pickup Notes */
                .pickup-full-modal {
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

                .pickup-full-modal.active {
                    display: flex !important;
                    animation: pickupFadeIn 0.3s ease-out;
                }

                .pickup-modal-panel {
                    width: 100%;
                    max-width: 576px;
                    min-height: 200px;
                    background: #2C2C2E;
                    display: flex;
                    flex-direction: column;
                    animation: pickupSlideUp 0.3s ease-out;
                    border-radius: 20px 20px 0 0;
                }

                @keyframes pickupSlideUp {
                    from { transform: translateY(100%); }
                    to { transform: translateY(0); }
                }

                @keyframes pickupFadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }

                /* Modal Header */
                .pickup-modal-header {
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

                .pickup-modal-back-btn {
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

                .pickup-modal-back-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .pickup-modal-header h2 {
                    font-size: 20px;
                    font-weight: 600;
                    color: #FFFFFF;
                    margin: 0;
                    flex: 1;
                    text-align: center;
                }

                /* Content Section */
                .pickup-modal-scrollable-content {
                    flex: 1;
                    padding: 24px;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                }

                .pickup-modal-subtitle {
                    font-size: 15px;
                    color: #8E8E93;
                    line-height: 1.4;
                    margin-bottom: 24px;
                }

                /* Form Elements */
                .pickup-form-group {
                    margin-bottom: 24px;
                }

                .pickup-form-group label {
                    display: block;
                    font-size: 13px;
                    font-weight: 600;
                    color: #8E8E93;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 8px;
                }

                .pickup-form-input,
                .pickup-form-textarea {
                    width: 100%;
                    padding: 14px 16px;
                    background: #3A3A3C;
                    border: 1px solid #48484A;
                    border-radius: 10px;
                    font-size: 16px;
                    color: #FFFFFF;
                    transition: all 0.2s;
                    font-family: inherit;
                    resize: vertical;
                }

                .pickup-form-textarea {
                    min-height: 100px;
                    line-height: 1.4;
                }

                .pickup-form-input::placeholder,
                .pickup-form-textarea::placeholder {
                    color: #6D6D70;
                }

                .pickup-form-input:focus,
                .pickup-form-textarea:focus {
                    outline: none;
                    border-color: #FF9500;
                    background: #48484A;
                }

                /* Character Counter */
                .pickup-char-counter {
                    text-align: right;
                    font-size: 12px;
                    color: #8E8E93;
                    margin-top: 4px;
                }

                .pickup-char-counter.warning {
                    color: #FF9500;
                }

                .pickup-char-counter.error {
                    color: #FF453A;
                }

                /* Action Button */
                .pickup-modal-action-btn {
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

                .pickup-modal-action-btn:hover {
                    background: #FF8C00;
                }

                .pickup-modal-action-btn:active {
                    transform: scale(0.98);
                }

                .pickup-modal-action-btn:disabled {
                    background: #48484A;
                    color: #8E8E93;
                    cursor: not-allowed;
                    transform: none;
                }

                /* Success Indicator */
                .pickup-success-toast {
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

                .pickup-success-toast.show {
                    transform: translateX(-50%) translateY(0);
                    opacity: 1;
                }

                /* Mobile Optimizations */
                @media (max-width: 480px) {
                    .pickup-modal-panel {
                        border-radius: 0;
                        max-width: 100%;
                        height: 100vh;
                    }

                    .pickup-modal-header {
                        padding: 16px 20px;
                        border-radius: 0;
                    }

                    .pickup-modal-scrollable-content {
                        padding: 20px;
                    }
                }

                /* Desktop adjustments */
                @media (min-width: 768px) {
                    .pickup-modal-panel {
                        height: auto;
                        max-height: 90vh;
                        margin: 20px;
                        border-radius: 20px;
                    }

                    .pickup-modal-header {
                        border-radius: 20px 20px 0 0;
                    }

                    .pickup-full-modal {
                        align-items: center;
                    }
                }
            </style>
        `;
        
        document.head.insertAdjacentHTML('beforeend', styles);
    }

    createModal() {
        // Check if modal already exists
        if (document.getElementById('pickupNotesModal')) return;

        const modalHTML = `
            <!-- Pickup Notes Modal -->
            <div id="pickupNotesModal" class="pickup-full-modal">
                <div class="pickup-modal-panel">
                    <div class="pickup-modal-header">
                        <span style="width: 40px;"></span>
                        <h2>Pickup notes</h2>
                        <button class="pickup-modal-back-btn" onclick="PickupNoteModal.getInstance().close()">✕</button>
                    </div>
                    
                    <div class="pickup-modal-scrollable-content">
                        <p class="pickup-modal-subtitle">Provide additional info to customize your pickup and ensure a smooth experience.</p>
                        
                        <form id="notesForm" onsubmit="PickupNoteModal.getInstance().savePickupNotes(event)">
                            <div class="pickup-form-group">
                                <label for="chauffeurNotes">Notes for the chauffeur</label>
                                <textarea 
                                    id="chauffeurNotes" 
                                    class="pickup-form-textarea" 
                                    rows="4"
                                    maxlength="500"
                                    placeholder="Add special requests (please do not include confidential information)"
                                    oninput="PickupNoteModal.getInstance().updateCharCounter('chauffeurNotes')"
                                ></textarea>
                                <div class="pickup-char-counter" id="chauffeurNotesCounter">0 / 500</div>
                            </div>
                            
                            <div class="pickup-form-group">
                                <label for="pickupSign">Pickup sign</label>
                                <input 
                                    type="text" 
                                    id="pickupSign" 
                                    class="pickup-form-input" 
                                    maxlength="50"
                                    placeholder="Name or text on the pickup sign"
                                    oninput="PickupNoteModal.getInstance().updateCharCounter('pickupSign')"
                                >
                                <div class="pickup-char-counter" id="pickupSignCounter">0 / 50</div>
                            </div>
                            
                            <div class="pickup-form-group">
                                <label for="referenceCode">Reference code or cost center</label>
                                <input 
                                    type="text" 
                                    id="referenceCode" 
                                    class="pickup-form-input" 
                                    maxlength="30"
                                    placeholder="This reference appears on your invoice"
                                    oninput="PickupNoteModal.getInstance().updateCharCounter('referenceCode')"
                                >
                                <div class="pickup-char-counter" id="referenceCodeCounter">0 / 30</div>
                            </div>
                            
                            <button type="submit" class="pickup-modal-action-btn">Save notes</button>
                        </form>
                    </div>
                </div>
            </div>

            <!-- Success Toast -->
            <div id="pickupSuccessToast" class="pickup-success-toast">
                <span>✓</span>
                <span>Notes saved successfully</span>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // Open modal
    open() {
        this.init();
        const modal = document.getElementById('pickupNotesModal');
        if (modal) {
            // Load existing data
            this.loadExistingData();
            
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
        }
    }

    // Close modal
    close() {
        const modal = document.getElementById('pickupNotesModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }
    }

    // Load existing data into form
    loadExistingData() {
        const chauffeurNotes = document.getElementById('chauffeurNotes');
        const pickupSign = document.getElementById('pickupSign');
        const referenceCode = document.getElementById('referenceCode');
        
        if (chauffeurNotes) {
            chauffeurNotes.value = this.pickupData.chauffeurNotes || '';
            this.updateCharCounter('chauffeurNotes');
        }
        if (pickupSign) {
            pickupSign.value = this.pickupData.pickupSign || '';
            this.updateCharCounter('pickupSign');
        }
        if (referenceCode) {
            referenceCode.value = this.pickupData.referenceCode || '';
            this.updateCharCounter('referenceCode');
        }
    }

    // Update character counter
    updateCharCounter(fieldId) {
        const field = document.getElementById(fieldId);
        const counter = document.getElementById(fieldId + 'Counter');
        
        if (!field || !counter) return;
        
        const currentLength = field.value.length;
        const maxLength = field.maxLength;
        const percentage = (currentLength / maxLength) * 100;
        
        counter.textContent = `${currentLength} / ${maxLength}`;
        
        // Update counter color based on usage
        counter.classList.remove('warning', 'error');
        if (percentage >= 90) {
            counter.classList.add('error');
        } else if (percentage >= 75) {
            counter.classList.add('warning');
        }
    }

    // Save pickup notes
    savePickupNotes(event) {
        event.preventDefault();
        
        // Get form values
        const chauffeurNotes = document.getElementById('chauffeurNotes').value.trim();
        const pickupSign = document.getElementById('pickupSign').value.trim();
        const referenceCode = document.getElementById('referenceCode').value.trim();
        
        // Store data
        this.pickupData = {
            chauffeurNotes,
            pickupSign,
            referenceCode
        };
        
        // Update button indicator if notes exist
        this.updatePickupNotesButton();
        
        // Dispatch event for app state sync
        window.dispatchEvent(new CustomEvent('pickupNotesChanged'));
        
        // Show success toast
        this.showSuccessToast();
        
        // Close modal after short delay
        setTimeout(() => {
            this.close();
        }, 1500);
    }

    // Show success toast
    showSuccessToast() {
        const toast = document.getElementById('pickupSuccessToast');
        if (toast) {
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        }
    }

    // Update pickup notes button to show if notes exist
    updatePickupNotesButton() {
        const btn = document.querySelector('.pickup-notes-btn, [onclick*="addPickupNotes"]');
        if (!btn) return;
        
        const hasNotes = this.pickupData.chauffeurNotes || 
                        this.pickupData.pickupSign || 
                        this.pickupData.referenceCode;
        
        if (hasNotes) {
            // Add checkmark to indicate notes exist
            const icon = btn.querySelector('.control-icon');
            if (icon) {
                icon.textContent = '✅';
            }
            btn.classList.add('has-notes');
        } else {
            const icon = btn.querySelector('.control-icon');
            if (icon) {
                icon.textContent = '📝';
            }
            btn.classList.remove('has-notes');
        }
    }

    // Get pickup notes data
    getPickupNotesData() {
        return this.pickupData;
    }

    // Clear all notes
    clearNotes() {
        this.pickupData = {
            chauffeurNotes: '',
            pickupSign: '',
            referenceCode: ''
        };
        
        // Clear form if modal is open
        const form = document.getElementById('notesForm');
        if (form) {
            form.reset();
            // Update all counters
            this.updateCharCounter('chauffeurNotes');
            this.updateCharCounter('pickupSign');
            this.updateCharCounter('referenceCode');
        }
        
        this.updatePickupNotesButton();
    }

    // Attach event listeners
    attachEventListeners() {
        // Close modal on overlay click
        document.addEventListener('click', (e) => {
            if (e.target.id === 'pickupNotesModal' && e.target.classList.contains('active')) {
                this.close();
            }
        });

        // Escape key to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.getElementById('pickupNotesModal');
                if (modal?.classList.contains('active')) {
                    this.close();
                }
            }
        });
    }

    // Singleton pattern
    static instance = null;
    
    static getInstance() {
        if (!this.instance) {
            this.instance = new PickupNoteModal();
        }
        return this.instance;
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    PickupNoteModal.getInstance().init();
});

// Expose for global access
window.PickupNoteModal = PickupNoteModal;