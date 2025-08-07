/**
 * ============================================
 * CUSTOM AUTOCOMPLETE MODULE
 * ============================================
 * 
 * Google Maps Places Autocomplete wrapper with:
 * - Session token management for cost optimization
 * - Result caching to minimize API calls
 * - Keyboard navigation support
 * - Custom styling and validation
 * 
 * CSS styles are in maps-autocomplete.css
 */

export class CustomAutocomplete {
    constructor(inputId, suggestionsId, onSelect) {
        this.input = typeof inputId === 'string' ? document.getElementById(inputId) : inputId;
        this.suggestionsContainer = typeof suggestionsId === 'string' ? document.getElementById(suggestionsId) : suggestionsId;
        this.onSelect = onSelect;
        
        // Validate required elements exist
        if (!this.input) {
            console.warn('CustomAutocomplete: Input element not found:', inputId);
            return;
        }
        if (!this.suggestionsContainer) {
            console.warn('CustomAutocomplete: Suggestions container not found:', suggestionsId);
            return;
        }
        
        // Session management
        this.sessionToken = null;
        this.sessionStartTime = null;
        this.sessionRequestCount = 0;
        this.maxSessionRequests = 10;
        this.sessionDuration = 3 * 60 * 1000; // 3 minutes
        
        // Caching
        this.suggestionCache = new Map();
        this.cacheTTL = 5 * 60 * 1000; // 5 minutes
        
        // State
        this.predictions = [];
        this.selectedIndex = -1;
        this.debounceTimer = null;
        this.selectedPlace = null;
        this.isValidated = false;
        this.lastInput = '';
        
        this.init();
    }

    init() {
        if (!this.input) {
            console.warn('CustomAutocomplete: Cannot initialize - input element missing');
            return;
        }
        console.log('✅ CustomAutocomplete initialized successfully');
        this.input.addEventListener('input', (e) => this.handleInput(e));
        this.input.addEventListener('keydown', (e) => this.handleKeydown(e));
        this.input.addEventListener('blur', () => this.handleBlur());
    }

    // Session token management
    generateSessionToken() {
        this.sessionToken = 'sess_' + Math.random().toString(36).substr(2, 9);
        this.sessionStartTime = Date.now();
        this.sessionRequestCount = 0;
        console.log('Generated new session token:', this.sessionToken);
    }

    shouldGenerateNewSession() {
        if (!this.sessionToken || !this.sessionStartTime) return true;
        
        const elapsed = Date.now() - this.sessionStartTime;
        const sessionExpired = elapsed > this.sessionDuration;
        const maxRequestsReached = this.sessionRequestCount >= this.maxSessionRequests;
        
        return sessionExpired || maxRequestsReached;
    }

    clearSession() {
        console.log('Clearing session token:', this.sessionToken);
        this.sessionToken = null;
        this.sessionStartTime = null;
        this.sessionRequestCount = 0;
    }

    // Cache management
    getCacheKey(input) {
        return `autocomplete_${input.toLowerCase()}`;
    }

    getCachedSuggestions(input) {
        const cacheKey = this.getCacheKey(input);
        const cached = this.suggestionCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
            console.log('Cache hit for:', input);
            return cached.data;
        }
        
        if (cached) {
            this.suggestionCache.delete(cacheKey);
        }
        return null;
    }

    setCachedSuggestions(input, data) {
        const cacheKey = this.getCacheKey(input);
        this.suggestionCache.set(cacheKey, {
            data: data,
            timestamp: Date.now()
        });
        
        // Cleanup old cache entries
        if (this.suggestionCache.size > 50) {
            const oldestKey = this.suggestionCache.keys().next().value;
            this.suggestionCache.delete(oldestKey);
        }
    }

    // Check if input change is minor (for local filtering)
    isMinorChange(newInput, oldInput) {
        if (!oldInput || oldInput.length === 0) return false;
        if (newInput.length < oldInput.length) return false; // User is deleting
        
        const similarity = this.calculateSimilarity(newInput.toLowerCase(), oldInput.toLowerCase());
        return similarity > 0.8 && newInput.toLowerCase().startsWith(oldInput.toLowerCase());
    }

    calculateSimilarity(str1, str2) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const distance = this.levenshteinDistance(longer, shorter);
        return (longer.length - distance) / longer.length;
    }

    levenshteinDistance(str1, str2) {
        const matrix = [];
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        return matrix[str2.length][str1.length];
    }

    // Filter existing predictions for minor changes
    filterPredictions(input, predictions) {
        if (!predictions || predictions.length === 0) return [];
        
        const lowerInput = input.toLowerCase();
        return predictions.filter(prediction => {
            const description = prediction.description || '';
            const mainText = prediction.structured_formatting?.main_text || '';
            const secondaryText = prediction.structured_formatting?.secondary_text || '';
            
            return description.toLowerCase().includes(lowerInput) ||
                   mainText.toLowerCase().includes(lowerInput) ||
                   secondaryText.toLowerCase().includes(lowerInput);
        });
    }

    async handleInput(e) {
        const value = e.target.value.trim();
        
        if (this.isValidated) {
            this.clearValidation();
            this.input.dispatchEvent(new CustomEvent('validation-cleared'));
        }
        
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        // Minimum 3 characters
        if (value.length < 3) {
            this.hideSuggestions();
            this.lastInput = value;
            return;
        }
        
        // Increased debounce to 500ms for cost optimization
        this.debounceTimer = setTimeout(() => {
            this.fetchSuggestions(value);
        }, 500);
    }

    async fetchSuggestions(input) {
        try {
            // Check cache first
            const cached = this.getCachedSuggestions(input);
            if (cached) {
                this.predictions = cached;
                this.renderSuggestions(this.predictions);
                this.lastInput = input;
                return;
            }
            
            // Check if this is a minor change and we can filter existing results
            if (this.isMinorChange(input, this.lastInput) && this.predictions.length > 0) {
                console.log('Filtering existing predictions for minor change');
                const filtered = this.filterPredictions(input, this.predictions);
                if (filtered.length > 0) {
                    this.predictions = filtered;
                    this.renderSuggestions(this.predictions);
                    this.lastInput = input;
                    return;
                }
            }
            
            this.showLoading();
            
            // Session management
            if (this.shouldGenerateNewSession()) {
                this.generateSessionToken();
            }
            
            this.sessionRequestCount++;
            
            const params = new URLSearchParams({
                input: input,
                sessiontoken: this.sessionToken,
                location: `${25.7617},${-80.1918}`,
                radius: '30000'
            });
            
            console.log('Making API request for:', input, 'Session:', this.sessionToken, 'Count:', this.sessionRequestCount);
            
            // Use Railway proxy for autocomplete
            const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            const apiBase = isLocal ? 'http://localhost:3001' : 'https://reliable-warmth-production-d382.up.railway.app';
            const response = await fetch(`${apiBase}/api/places/autocomplete?${params}`);

            if (!response.ok) {
                throw new Error('Failed to fetch suggestions');
            }

            const data = await response.json();
            this.predictions = data.predictions || [];
            
            // Cache the results
            this.setCachedSuggestions(input, this.predictions);
            
            this.renderSuggestions(this.predictions);
            this.lastInput = input;
            
        } catch (error) {
            console.error('Autocomplete error:', error);
            this.showError();
        }
    }

    renderSuggestions(suggestions) {
        if (!suggestions || suggestions.length === 0) {
            this.suggestionsContainer.innerHTML = '<div class="no-results">No results found</div>';
            this.showSuggestions();
            return;
        }
        
        const html = suggestions.map((suggestion, index) => {
            const prediction = suggestion;
            
            let mainText = '';
            if (prediction.structured_formatting && prediction.structured_formatting.main_text) {
                mainText = prediction.structured_formatting.main_text;
            } else if (prediction.description) {
                mainText = prediction.description;
            }
            
            let secondaryText = '';
            if (prediction.structured_formatting && prediction.structured_formatting.secondary_text) {
                secondaryText = prediction.structured_formatting.secondary_text;
            }
            
            return `
                <div class="suggestion-item" data-index="${index}">
                    <div class="suggestion-icon">📍</div>
                    <div class="suggestion-text">
                        <div class="suggestion-main">${this.escapeHtml(mainText)}</div>
                        ${secondaryText ? `<div class="suggestion-secondary">${this.escapeHtml(secondaryText)}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
        
        this.suggestionsContainer.innerHTML = html;
        this.showSuggestions();
        
        this.suggestionsContainer.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                this.selectSuggestion(index);
            });
        });
    }

    async selectSuggestion(index) {
        const suggestion = this.predictions[index];
        if (!suggestion) return;
        
        try {
            const prediction = suggestion;
            let place;
            
            try {
                // Ensure we have a session token for place details
                if (!this.sessionToken) {
                    this.generateSessionToken();
                }
                
                this.sessionRequestCount++;
                
                // Use proxy endpoint for place details
                const params = new URLSearchParams({
                    place_id: prediction.place_id,
                    fields: 'name,formatted_address,geometry',
                    sessiontoken: this.sessionToken
                });
                
                console.log('Fetching place details with session:', this.sessionToken);
                
                // Use Railway proxy for place details
                const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
                const apiBase = isLocal ? 'http://localhost:3001' : 'https://reliable-warmth-production-d382.up.railway.app';
                const response = await fetch(`${apiBase}/api/places/details?${params}`);

                if (response.ok) {
                    const data = await response.json();
                    place = {
                        id: prediction.place_id,
                        formattedAddress: data.result.formatted_address,
                        displayName: { text: data.result.name || data.result.formatted_address },
                        location: {
                            lat: data.result.geometry.location.lat,
                            lng: data.result.geometry.location.lng
                        }
                    };
                } else {
                    throw new Error('Failed to fetch place details');
                }
            } catch (placeError) {
                console.error('Place details error:', placeError);
                place = {
                    id: prediction.place_id,
                    formattedAddress: prediction.description,
                    displayName: { text: prediction.description },
                    location: { lat: 0, lng: 0 }
                };
            }
            
            const address = place.formattedAddress || place.displayName?.text || '';
            this.input.value = address;
            
            this.selectedPlace = {
                place_id: place.id,
                description: address
            };
            this.isValidated = true;
            this.input.classList.add('validated');
            this.input.classList.remove('error');
            
            if (document.getElementById('addressError')) {
                document.getElementById('addressError').classList.remove('visible');
            }
            
            if (this.onSelect) {
                this.onSelect({
                    address: address,
                    coordinates: place.location ? {
                        lat: typeof place.location.lat === 'function' ? place.location.lat() : place.location.lat,
                        lng: typeof place.location.lng === 'function' ? place.location.lng() : place.location.lng
                    } : null,
                    place: place
                });
            }
            
            this.input.dispatchEvent(new CustomEvent('place-selected', { 
                detail: { 
                    placeId: place.id, 
                    description: address
                } 
            }));
            
            this.input.dispatchEvent(new CustomEvent('place-coordinates', {
                detail: {
                    lat: typeof place.location.lat === 'function' ? place.location.lat() : place.location.lat,
                    lng: typeof place.location.lng === 'function' ? place.location.lng() : place.location.lng,
                    address: address
                }
            }));
            
            // Clear session after successful place selection
            this.clearSession();
            this.hideSuggestions();
            this.selectedIndex = -1;
            
        } catch (error) {
            console.error('Selection error:', error);
        }
    }

    handleKeydown(e) {
        const items = this.suggestionsContainer.querySelectorAll('.suggestion-item');
        
        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.selectedIndex = Math.min(this.selectedIndex + 1, items.length - 1);
                this.highlightItem();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.selectedIndex = Math.max(this.selectedIndex - 1, -1);
                this.highlightItem();
                break;
            case 'Enter':
                e.preventDefault();
                if (this.selectedIndex >= 0) {
                    this.selectSuggestion(this.selectedIndex);
                }
                break;
            case 'Escape':
                this.hideSuggestions();
                break;
        }
    }

    highlightItem() {
        const items = this.suggestionsContainer.querySelectorAll('.suggestion-item');
        items.forEach((item, index) => {
            if (index === this.selectedIndex) {
                item.classList.add('highlighted');
            } else {
                item.classList.remove('highlighted');
            }
        });
    }

    handleBlur() {
        setTimeout(() => {
            this.hideSuggestions();
        }, 200);
    }

    showSuggestions() {
        this.suggestionsContainer.classList.add('visible');
    }

    hideSuggestions() {
        this.suggestionsContainer.classList.remove('visible');
    }

    showLoading() {
        this.suggestionsContainer.innerHTML = '<div class="loading-results">Loading...</div>';
        this.showSuggestions();
    }
    
    clearValidation() {
        this.isValidated = false;
        this.selectedPlace = null;
        this.input.classList.remove('validated');
        this.input.classList.remove('error');
        if (document.getElementById('addressError')) {
            document.getElementById('addressError').classList.remove('visible');
        }
    }

    showError() {
        this.suggestionsContainer.innerHTML = '<div class="no-results">Error loading suggestions</div>';
        this.showSuggestions();
        if (document.getElementById('addressError')) {
            document.getElementById('addressError').classList.add('visible');
        }
        this.input.classList.add('error');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Export for CommonJS compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CustomAutocomplete };
}