/**
 * ============================================
 * CUSTOM AUTOCOMPLETE MODULE
 * ============================================
 * 
 * Google Maps Places Autocomplete wrapper with:
 * - Session token management for cost optimization
 * - Live results only (Google prediction content is never cached or reused)
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
            debug.warn('CustomAutocomplete: Input element not found:', inputId);
            return;
        }
        if (!this.suggestionsContainer) {
            debug.warn('CustomAutocomplete: Suggestions container not found:', suggestionsId);
            return;
        }
        
        // Session management
        this.sessionToken = null;
        this.sessionLastActivityTime = null;
        this.sessionRequestCount = 0;
        this.sessionDuration = 3 * 60 * 1000; // 3 minutes

        // State
        this.predictions = [];
        this.selectedIndex = -1;
        this.debounceTimer = null;
        this.requestSequence = 0;
        this.selectionSequence = 0;
        this.selectedPlace = null;
        this.isValidated = false;
        this.selectedAttribution = this.input.closest?.('.input-wrapper')
            ?.querySelector?.('.selected-place-attribution') || null;
        
        this.init();
    }

    init() {
        if (!this.input) {
            debug.warn('CustomAutocomplete: Cannot initialize - input element missing');
            return;
        }
        debug.success('CustomAutocomplete initialized');
        this.input.addEventListener('input', (e) => this.handleInput(e));
        this.input.addEventListener('keydown', (e) => this.handleKeydown(e));
        this.input.addEventListener('blur', () => this.handleBlur());
    }

    // Fetch with timeout for slow networks
    async fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            console.warn('⏱️ Request timed out after', timeoutMs, 'ms');
            if (window.showNetworkWarning) {
                window.showNetworkWarning('Request taking too long. Please check your connection.');
            }
        }, timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw error;
        }
    }

    // Session token management
    // Google bills Places Autocomplete by SESSION: the typed-prediction
    // requests and the Place Details call that ends them are linked by this
    // token. Google's documentation says "using a version 4 UUID is
    // recommended" for `sessiontoken`.
    //
    // This used to be 'sess_' + Math.random().toString(36) — not a UUID. The
    // token is forwarded to Google verbatim by the Railway proxy, so if a
    // non-UUID is not recognised as a session, every prediction request is
    // billed on its own instead of being grouped. Whether Google actually
    // rejects the old shape is undocumented; a real UUID costs nothing and
    // removes the question. Verify against the GCP billing report, not this
    // comment.
    newSessionUuid() {
        try {
            // Needs a secure context — true in production (HTTPS) and on
            // localhost, which is where this app ever runs.
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
            if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
                const bytes = crypto.getRandomValues(new Uint8Array(16));
                bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
                bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant 10xx
                const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
                return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
                       `${hex.slice(16, 20)}-${hex.slice(20)}`;
            }
        } catch (e) {
            // fall through to the last resort below
        }
        // Last resort: weaker randomness, but still a well-formed v4, which is
        // the part Google reads. Never worse than what this replaced.
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
        });
    }

    generateSessionToken() {
        this.sessionToken = this.newSessionUuid();
        this.sessionLastActivityTime = Date.now();
        this.sessionRequestCount = 0;
    }

    shouldGenerateNewSession() {
        if (!this.sessionToken || !this.sessionLastActivityTime) return true;
        
        const elapsed = Date.now() - this.sessionLastActivityTime;
        return elapsed > this.sessionDuration;
    }

    clearSession() {
        this.sessionToken = null;
        this.sessionLastActivityTime = null;
        this.sessionRequestCount = 0;
    }

    async handleInput(e) {
        const value = e.target.value.trim();
        const requestSequence = ++this.requestSequence;
        ++this.selectionSequence;
        
        if (this.isValidated) {
            this.clearValidation();
            this.input.dispatchEvent(new CustomEvent('validation-cleared'));
        }
        
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        // Minimum 3 characters
        if (value.length < 3) {
            this.clearSuggestions();
            return;
        }
        
        // Increased debounce to 500ms for cost optimization
        this.debounceTimer = setTimeout(() => {
            this.fetchSuggestions(value, requestSequence);
        }, 500);
    }

    async fetchSuggestions(input, requestSequence = ++this.requestSequence) {
        try {
            this.showLoading();
            
            // Session management
            if (this.shouldGenerateNewSession()) {
                this.generateSessionToken();
            }

            this.sessionLastActivityTime = Date.now();
            this.sessionRequestCount++;
            
            const params = new URLSearchParams({
                input: input,
                sessiontoken: this.sessionToken
            });
            
            // Use Railway proxy for autocomplete
            // For local testing, use production proxy (localhost:3001 requires running backend locally)
            const apiBase = 'https://reliable-warmth-production-d382.up.railway.app';
            const response = await this.fetchWithTimeout(`${apiBase}/api/places/autocomplete?${params}`, {}, 10000);

            if (!response.ok) {
                throw new Error('Failed to fetch suggestions');
            }

            const data = await response.json();
            if (requestSequence !== this.requestSequence || this.input.value.trim() !== input) {
                return;
            }
            this.predictions = data.predictions || [];
            this.renderSuggestions(this.predictions);
        } catch (error) {
            if (requestSequence !== this.requestSequence) return;
            console.error('Autocomplete request unavailable');
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
        
        this.suggestionsContainer.innerHTML = html +
            '<div class="google-maps-attribution">' +
                '<img src="/images/google-maps-attribution-dark-gray.svg" ' +
                     'alt="Google Maps" width="98" height="18">' +
            '</div>';
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

        const selectionSequence = ++this.selectionSequence;
        const prediction = suggestion;
        try {
            // Ensure we have a session token for place details.
            if (!this.sessionToken) {
                this.generateSessionToken();
            }

            this.sessionLastActivityTime = Date.now();
            this.sessionRequestCount++;

            // The Railway proxy owns the provider field mask. The browser may
            // identify the selected place but cannot expand Google content.
            const params = new URLSearchParams({
                place_id: prediction.place_id,
                sessiontoken: this.sessionToken
            });

            const apiBase = 'https://reliable-warmth-production-d382.up.railway.app';
            const response = await this.fetchWithTimeout(`${apiBase}/api/places/details?${params}`, {}, 10000);
            if (!response.ok) throw new Error('Place details unavailable');

            const data = await response.json();
            if (selectionSequence !== this.selectionSequence) return;
            if (!data.result?.formatted_address || !data.result?.geometry?.location) {
                throw new Error('Incomplete place details');
            }
            const place = {
                id: prediction.place_id,
                formattedAddress: data.result.formatted_address,
                displayName: { text: data.result.formatted_address },
                location: {
                    lat: data.result.geometry.location.lat,
                    lng: data.result.geometry.location.lng
                },
                // Sanitized {text, href} entries from the proxy — Google
                // policy requires displaying supplied third-party
                // attributions alongside the content.
                attributions: Array.isArray(data.attributions) ? data.attributions : []
            };
            this.applySelection(place);
        } catch (error) {
            if (selectionSequence !== this.selectionSequence) return;
            // A transient Details failure must not strand a passenger after a
            // deliberate live prediction selection. Preserve the Google
            // prediction's ID and visible description, but never manufacture
            // coordinates (the former 0,0 fallback silently routed to the
            // wrong continent). The authoritative quote service will resolve
            // the Place ID again before it can price an enabled booking.
            const description = typeof prediction.description === 'string'
                ? prediction.description.trim()
                : '';
            if (!description || typeof prediction.place_id !== 'string') {
                console.error('Place details unavailable');
                this.showError();
                return;
            }
            console.error('Place details unavailable; using selected prediction');
            this.applySelection({
                id: prediction.place_id,
                formattedAddress: description,
                displayName: { text: description },
                location: { lat: null, lng: null },
                attributions: []
            });
        }
    }

    applySelection(place) {
        const address = place.formattedAddress || place.displayName?.text || '';
        this.input.value = address;

        this.selectedPlace = { place_id: place.id, description: address };
        this.isValidated = true;
        this.input.classList.add('validated');
        this.input.classList.remove('error');
        this.setSelectedAttributionVisible(true);
        this.renderThirdPartyAttributions(place.attributions || []);

        if (document.getElementById('addressError')) {
            document.getElementById('addressError').classList.remove('visible');
        }

        const rawLat = typeof place.location?.lat === 'function' ? place.location.lat() : place.location?.lat;
        const rawLng = typeof place.location?.lng === 'function' ? place.location.lng() : place.location?.lng;
        const lat = Number.isFinite(rawLat) ? rawLat : null;
        const lng = Number.isFinite(rawLng) ? rawLng : null;
        if (this.onSelect) this.onSelect({ address, coordinates: { lat, lng }, place });

        this.input.dispatchEvent(new CustomEvent('place-selected', {
            detail: { placeId: place.id, description: address }
        }));
        this.input.dispatchEvent(new CustomEvent('place-coordinates', {
            detail: { lat, lng, address }
        }));

        this.clearSession();
        this.clearSuggestions();
    }

    setSelectedAttributionVisible(visible) {
        if (this.selectedAttribution) {
            this.selectedAttribution.classList.toggle('visible', visible);
        }
    }

    // Third-party attributions (Google policy): render the proxy's sanitized
    // {text, href} entries beside the Google Maps attribution. DOM is built
    // with textContent and validated hrefs only — provider strings are never
    // interpreted as HTML here, whatever the server sends.
    renderThirdPartyAttributions(attributions) {
        if (!this.selectedAttribution ||
            typeof this.selectedAttribution.querySelector !== 'function') return;
        let holder = this.selectedAttribution.querySelector('.third-party-attribution');
        if (!Array.isArray(attributions) || attributions.length === 0) {
            if (holder) holder.remove();
            return;
        }
        if (!holder) {
            holder = document.createElement('span');
            holder.className = 'third-party-attribution';
            this.selectedAttribution.appendChild(holder);
        }
        holder.textContent = '';
        for (const entry of attributions.slice(0, 4)) {
            const text = typeof entry?.text === 'string' ? entry.text.slice(0, 200) : '';
            if (!text) continue;
            const href = typeof entry?.href === 'string' && /^https?:\/\//i.test(entry.href)
                ? entry.href : null;
            let node;
            if (href) {
                node = document.createElement('a');
                node.href = href;
                node.target = '_blank';
                node.rel = 'noopener noreferrer';
                node.textContent = text;
            } else {
                node = document.createElement('span');
                node.textContent = text;
            }
            if (holder.childNodes.length) holder.appendChild(document.createTextNode(' · '));
            holder.appendChild(node);
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
                ++this.selectionSequence;
                this.cancelPendingSuggestions();
                this.clearSuggestions();
                break;
        }
    }

    // A dismissed dropdown must STAY dismissed: kill the queued debounce and
    // invalidate any in-flight prediction request, so a late response can
    // never re-render the private address list after Escape or blur.
    cancelPendingSuggestions() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        ++this.requestSequence;
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
        // Cancel pending work immediately; the 200ms delay below exists only
        // so a click on a suggestion can land before the list clears.
        this.cancelPendingSuggestions();
        setTimeout(() => {
            this.clearSuggestions();
        }, 200);
    }

    clearSuggestions() {
        this.predictions = [];
        this.selectedIndex = -1;
        this.suggestionsContainer.innerHTML = '';
        this.hideSuggestions();
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
        this.setSelectedAttributionVisible(false);
        this.renderThirdPartyAttributions([]);
        this.input.classList.remove('validated');
        this.input.classList.remove('error');
        if (document.getElementById('addressError')) {
            document.getElementById('addressError').classList.remove('visible');
        }
    }

    showError() {
        this.predictions = [];
        this.selectedIndex = -1;
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
