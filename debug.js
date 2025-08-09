/**
 * Debug Wrapper for Production-Safe Logging
 * 
 * This utility controls console output based on environment.
 * In production, all debug logs are silenced to keep console clean.
 * Errors are always shown but formatted nicely.
 */

class DebugManager {
    constructor() {
        // Determine if we're in debug mode
        this.isDebug = this.checkDebugMode();
        
        // Store original console methods
        this.originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
            info: console.info,
            table: console.table,
            time: console.time,
            timeEnd: console.timeEnd
        };
        
        // Log groups for filtering
        this.enabledGroups = new Set(['error', 'critical']);
        
        // Initialize
        this.init();
    }
    
    checkDebugMode() {
        // Debug mode is ON if:
        // 1. Running on localhost
        // 2. URL has ?debug=true
        // 3. localStorage has debug_mode=true
        // 4. Window has DEBUG flag
        
        const isLocalhost = window.location.hostname === 'localhost' || 
                          window.location.hostname === '127.0.0.1';
        const hasDebugParam = new URLSearchParams(window.location.search).get('debug') === 'true';
        const hasDebugStorage = localStorage.getItem('debug_mode') === 'true';
        const hasDebugFlag = window.DEBUG === true;
        
        return isLocalhost || hasDebugParam || hasDebugStorage || hasDebugFlag;
    }
    
    init() {
        if (!this.isDebug) {
            // In production, show initial message then silence debug logs
            this.originalConsole.info(
                '%c🔒 Debug mode disabled. Add ?debug=true to URL to enable.',
                'color: #888; font-style: italic;'
            );
        } else {
            // In debug mode, show status
            this.originalConsole.info(
                '%c🔧 Debug mode enabled',
                'color: #4CAF50; font-weight: bold;'
            );
        }
    }
    
    // Main logging method
    log(...args) {
        if (this.isDebug) {
            this.originalConsole.log(...args);
        }
    }
    
    // Grouped logging with labels
    group(groupName, ...args) {
        if (this.isDebug || this.enabledGroups.has(groupName)) {
            const emoji = this.getGroupEmoji(groupName);
            const color = this.getGroupColor(groupName);
            this.originalConsole.log(
                `%c${emoji} [${groupName.toUpperCase()}]`,
                `color: ${color}; font-weight: bold;`,
                ...args
            );
        }
    }
    
    // Warning - shown in debug mode only
    warn(...args) {
        if (this.isDebug) {
            this.originalConsole.warn('⚠️', ...args);
        }
    }
    
    // Error - always shown but formatted nicely
    error(message, error = null) {
        const errorInfo = {
            message,
            timestamp: new Date().toISOString(),
            url: window.location.href,
            userAgent: navigator.userAgent
        };
        
        if (error) {
            errorInfo.error = {
                message: error.message,
                stack: this.isDebug ? error.stack : undefined
            };
        }
        
        if (this.isDebug) {
            // Full error details in debug mode
            this.originalConsole.error('❌ ERROR:', errorInfo);
            if (error) this.originalConsole.error(error);
        } else {
            // Simple error message in production
            this.originalConsole.error(`❌ ${message}`);
        }
        
        // Could also send to error tracking service here
        this.sendToErrorTracking(errorInfo);
    }
    
    // Info logging
    info(...args) {
        if (this.isDebug) {
            this.originalConsole.info('ℹ️', ...args);
        }
    }
    
    // Table display for data
    table(data, columns) {
        if (this.isDebug) {
            this.originalConsole.table(data, columns);
        }
    }
    
    // Performance timing
    time(label) {
        if (this.isDebug) {
            this.originalConsole.time(label);
        }
    }
    
    timeEnd(label) {
        if (this.isDebug) {
            this.originalConsole.timeEnd(label);
        }
    }
    
    // Network request logging
    network(method, url, data = null) {
        if (this.isDebug) {
            const logData = {
                method,
                url,
                timestamp: new Date().toISOString()
            };
            if (data) logData.data = data;
            
            this.originalConsole.log(
                `%c🌐 ${method}`,
                'color: #2196F3; font-weight: bold;',
                url,
                data || ''
            );
        }
    }
    
    // Success logging
    success(message, data = null) {
        if (this.isDebug) {
            this.originalConsole.log(
                '%c✅ SUCCESS:',
                'color: #4CAF50; font-weight: bold;',
                message,
                data || ''
            );
        }
    }
    
    // Helper to get emoji for group
    getGroupEmoji(group) {
        const emojis = {
            api: '🌐',
            autocomplete: '📍',
            pricing: '💰',
            booking: '📅',
            payment: '💳',
            error: '❌',
            critical: '🚨',
            performance: '⚡',
            user: '👤'
        };
        return emojis[group] || '📝';
    }
    
    // Helper to get color for group
    getGroupColor(group) {
        const colors = {
            api: '#2196F3',
            autocomplete: '#9C27B0',
            pricing: '#FF9800',
            booking: '#4CAF50',
            payment: '#F44336',
            error: '#F44336',
            critical: '#D32F2F',
            performance: '#00BCD4',
            user: '#3F51B5'
        };
        return colors[group] || '#666';
    }
    
    // Send errors to tracking service (placeholder)
    sendToErrorTracking(errorInfo) {
        // In production, you would send to Sentry, LogRocket, etc.
        // For now, just store in sessionStorage for debugging
        if (!this.isDebug) {
            try {
                const errors = JSON.parse(sessionStorage.getItem('app_errors') || '[]');
                errors.push(errorInfo);
                // Keep only last 10 errors
                if (errors.length > 10) errors.shift();
                sessionStorage.setItem('app_errors', JSON.stringify(errors));
            } catch (e) {
                // Silently fail if storage is full
            }
        }
    }
    
    // Enable debug mode temporarily
    enableDebug(duration = 300000) { // 5 minutes default
        localStorage.setItem('debug_mode', 'true');
        setTimeout(() => {
            localStorage.removeItem('debug_mode');
            this.isDebug = this.checkDebugMode();
            this.originalConsole.info('Debug mode expired');
        }, duration);
        this.isDebug = true;
        this.originalConsole.info(`Debug mode enabled for ${duration/1000} seconds`);
    }
    
    // Get stored errors (for support)
    getStoredErrors() {
        try {
            return JSON.parse(sessionStorage.getItem('app_errors') || '[]');
        } catch (e) {
            return [];
        }
    }
}

// Create global debug instance
const debug = new DebugManager();

// Export for module usage if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = debug;
}

// Also attach to window for global access
window.debug = debug;

// Convenience shortcuts
window.log = (...args) => debug.log(...args);
window.logError = (msg, err) => debug.error(msg, err);
window.logNetwork = (method, url, data) => debug.network(method, url, data);
window.logSuccess = (msg, data) => debug.success(msg, data);

// Help function for developers
window.debugHelp = () => {
    console.log(`
🔧 Debug Utility Help
====================

Enable Debug Mode:
- Add ?debug=true to URL
- Run: debug.enableDebug()
- Set localStorage: debug_mode=true

Available Methods:
- debug.log(...) - General logging
- debug.error(message, error) - Error logging
- debug.warn(...) - Warnings
- debug.info(...) - Information
- debug.network(method, url, data) - API calls
- debug.success(message, data) - Success messages
- debug.group(name, ...) - Grouped logging
- debug.table(data) - Table display
- debug.time/timeEnd(label) - Performance timing

Groups: api, autocomplete, pricing, booking, payment, error, critical

Shortcuts:
- log(...) - Quick logging
- logError(msg, err) - Quick error
- logNetwork(method, url, data) - Quick network log
- logSuccess(msg, data) - Quick success

View Stored Errors:
- debug.getStoredErrors()
    `);
};