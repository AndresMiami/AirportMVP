/**
 * Error Handling Utility
 * Provides graceful error handling and user-friendly messages
 */

class ErrorHandler {
    constructor() {
        this.errorCount = 0;
        this.maxErrors = 10; // Prevent error flooding
        this.errorWindow = 60000; // Reset count after 1 minute
        this.lastReset = Date.now();
        
        // User-friendly error messages
        this.userMessages = {
            network: 'Connection issue. Please check your internet and try again.',
            autocomplete: 'Address search is temporarily unavailable. Please type your address manually.',
            pricing: 'Unable to calculate price. Please try again or contact support.',
            booking: 'Booking service is temporarily unavailable. Please try again later.',
            payment: 'Payment processing issue. Please verify your card details.',
            validation: 'Please check your input and try again.',
            permission: 'Permission denied. Please check your account settings.',
            timeout: 'Request timed out. Please try again.',
            general: 'Something went wrong. Please try again or contact support.'
        };
        
        // Initialize global error handling
        this.initGlobalHandler();
    }
    
    /**
     * Initialize global error handler
     */
    initGlobalHandler() {
        // Catch unhandled errors
        window.addEventListener('error', (event) => {
            this.handleError({
                message: event.message,
                source: event.filename,
                line: event.lineno,
                column: event.colno,
                error: event.error,
                type: 'uncaught'
            });
            event.preventDefault(); // Prevent default error handling
        });
        
        // Catch unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            this.handleError({
                message: event.reason?.message || event.reason,
                error: event.reason,
                type: 'unhandled_promise'
            });
            event.preventDefault();
        });
    }
    
    /**
     * Main error handling method
     */
    handleError(errorInfo) {
        // Reset counter if window expired
        if (Date.now() - this.lastReset > this.errorWindow) {
            this.errorCount = 0;
            this.lastReset = Date.now();
        }
        
        // Prevent error flooding
        this.errorCount++;
        if (this.errorCount > this.maxErrors) {
            return;
        }
        
        // Suppress Apple Pay errors in development environment
        const isApplePayError = errorInfo.message && (
            errorInfo.message.includes('Apple Pay') ||
            errorInfo.message.includes('insecure document') ||
            errorInfo.message.includes('InvalidAccessError')
        );
        
        const isDevelopment = window.location.hostname === 'localhost' || 
                            window.location.hostname === '127.0.0.1' ||
                            window.location.protocol !== 'https:';
        
        if (isApplePayError && isDevelopment) {
            // Don't log Apple Pay errors in development
            return;
        }
        
        // Suppress other expected errors in development
        if (this.shouldSuppressError(errorInfo)) {
            console.warn('🚫 Payment feature unavailable in development:', errorInfo.message);
            return;
        }
        
        // Log to debug system
        if (window.debug) {
            debug.error(errorInfo.message || 'Unknown error', errorInfo.error);
        }
        
        // Determine error category
        const category = this.categorizeError(errorInfo);
        
        // Get user-friendly message
        const userMessage = this.getUserMessage(category, errorInfo);
        
        // Show user notification (if not suppressed)
        if (!errorInfo.silent) {
            this.showUserNotification(userMessage, category);
        }
        
        // Track error for analytics
        this.trackError(errorInfo, category);
    }
    
    /**
     * Check if error should be suppressed in development environment
     */
    shouldSuppressError(errorInfo) {
        const isDevelopment = window.location.hostname === 'localhost' || 
                             window.location.hostname === '127.0.0.1';
        
        if (isDevelopment) {
            const message = (errorInfo.message || '').toLowerCase();
            const errorName = errorInfo.error?.name;
            
            // Suppress Apple Pay errors in development
            if (message.includes('apple pay') || message.includes('applepaysession')) {
                return true;
            }
            
            // Suppress secure context errors (like Apple Pay trying to start from insecure document)
            if (errorName === 'InvalidAccessError' && 
                message.includes('insecure document')) {
                return true;
            }
            
            // Suppress other payment-related secure context errors
            if (message.includes('secure context') && message.includes('payment')) {
                return true;
            }
        }
        
        return false;
    }
    
    /**
     * Categorize error type
     */
    categorizeError(errorInfo) {
        const message = (errorInfo.message || '').toLowerCase();
        const error = errorInfo.error;
        
        if (message.includes('network') || message.includes('fetch')) {
            return 'network';
        }
        if (message.includes('autocomplete') || message.includes('google')) {
            return 'autocomplete';
        }
        if (message.includes('price') || message.includes('pricing')) {
            return 'pricing';
        }
        if (message.includes('booking')) {
            return 'booking';
        }
        if (message.includes('payment') || message.includes('stripe')) {
            return 'payment';
        }
        if (message.includes('invalid') || message.includes('validation')) {
            return 'validation';
        }
        if (message.includes('permission') || message.includes('denied')) {
            return 'permission';
        }
        if (message.includes('timeout')) {
            return 'timeout';
        }
        
        return 'general';
    }
    
    /**
     * Get user-friendly error message
     */
    getUserMessage(category, errorInfo) {
        // Check for custom message
        if (errorInfo.userMessage) {
            return errorInfo.userMessage;
        }
        
        // Use category message
        return this.userMessages[category] || this.userMessages.general;
    }
    
    /**
     * Show notification to user
     */
    showUserNotification(message, category) {
        // Don't show multiple notifications
        if (document.querySelector('.error-notification')) {
            return;
        }
        
        // Create notification element
        const notification = document.createElement('div');
        notification.className = 'error-notification';
        notification.innerHTML = `
            <div class="error-notification-content">
                <span class="error-icon">⚠️</span>
                <span class="error-message">${message}</span>
                <button class="error-close" onclick="this.parentElement.parentElement.remove()">✕</button>
            </div>
        `;
        
        // Add styles if not already present
        if (!document.querySelector('#error-notification-styles')) {
            const styles = document.createElement('style');
            styles.id = 'error-notification-styles';
            styles.textContent = `
                .error-notification {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #fff;
                    border: 1px solid #f44336;
                    border-radius: 8px;
                    padding: 12px 16px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    z-index: 10000;
                    max-width: 400px;
                    animation: slideIn 0.3s ease-out;
                }
                
                @keyframes slideIn {
                    from {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
                
                .error-notification-content {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                
                .error-icon {
                    font-size: 20px;
                }
                
                .error-message {
                    flex: 1;
                    color: #333;
                    font-size: 14px;
                    line-height: 1.4;
                }
                
                .error-close {
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    color: #999;
                    padding: 0;
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                
                .error-close:hover {
                    color: #333;
                }
                
                @media (max-width: 768px) {
                    .error-notification {
                        right: 10px;
                        left: 10px;
                        max-width: none;
                    }
                }
            `;
            document.head.appendChild(styles);
        }
        
        // Add to page
        document.body.appendChild(notification);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }
    
    /**
     * Track error for analytics
     */
    trackError(errorInfo, category) {
        // Store in session for support
        try {
            const errors = JSON.parse(sessionStorage.getItem('app_errors') || '[]');
            errors.push({
                timestamp: new Date().toISOString(),
                category,
                message: errorInfo.message,
                url: window.location.href
            });
            
            // Keep only last 10 errors
            if (errors.length > 10) {
                errors.shift();
            }
            
            sessionStorage.setItem('app_errors', JSON.stringify(errors));
        } catch (e) {
            // Ignore storage errors
        }
        
        // Could send to analytics service here
        // if (window.gtag) {
        //     gtag('event', 'exception', {
        //         description: errorInfo.message,
        //         fatal: false
        //     });
        // }
    }
    
    /**
     * Wrap function with error handling
     */
    wrap(fn, context = 'general', userMessage = null) {
        return async (...args) => {
            try {
                return await fn.apply(this, args);
            } catch (error) {
                this.handleError({
                    message: error.message,
                    error,
                    context,
                    userMessage,
                    silent: false
                });
                
                // Re-throw if critical
                if (context === 'critical') {
                    throw error;
                }
            }
        };
    }
    
    /**
     * Safe wrapper for async operations
     */
    async safeAsync(fn, context = 'general', fallbackValue = null) {
        try {
            return await fn();
        } catch (error) {
            this.handleError({
                message: error.message,
                error,
                context,
                silent: true
            });
            return fallbackValue;
        }
    }
    
    /**
     * Retry mechanism for network operations
     */
    async retry(fn, maxRetries = 3, delay = 1000, context = 'network') {
        let lastError;
        
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                
                if (i < maxRetries - 1) {
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; // Exponential backoff
                }
            }
        }
        
        // All retries failed
        this.handleError({
            message: `Failed after ${maxRetries} retries: ${lastError.message}`,
            error: lastError,
            context,
            silent: false
        });
        
        throw lastError;
    }
}

// Create global instance
const errorHandler = new ErrorHandler();

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = errorHandler;
}

// Global access
window.errorHandler = errorHandler;

// Convenience methods
window.safeCall = (fn, context) => errorHandler.wrap(fn, context);
window.safeAsync = (fn, context, fallback) => errorHandler.safeAsync(fn, context, fallback);
window.retryOperation = (fn, retries, delay, context) => errorHandler.retry(fn, retries, delay, context);