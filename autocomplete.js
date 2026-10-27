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
 * - LinkMia's curated cruise terminals rendered ABOVE Google's predictions
 *   (js/curated-places.js + data/curated-places.json; see renderDropdown)
 * 
 * CSS styles are in maps-autocomplete.css
 */

// LinkMia's own cruise terminals (data/curated-places.json) are requested
// with this EXACT URL; service-worker.js precaches the same literal.
const CURATED_REGISTRY_URL = '/data/curated-places.json?v=1';

// Presentation only: plain initials, not cruise-line logo artwork. Terminal
// assignments, addresses and selection identity still come from the registry.
const CURATED_BRANDS = Object.freeze({
    virgin: { name: 'Virgin Voyages', short: 'Virgin Voyages', initials: 'VV' },
    carnival: { name: 'Carnival', short: 'Carnival', initials: 'C' },
    'royal-caribbean': { name: 'Royal Caribbean', short: 'Royal Caribbean', initials: 'RC' },
    norwegian: { name: 'Norwegian', short: 'Norwegian', initials: 'NCL' },
    celebrity: { name: 'Celebrity', short: 'Celebrity', initials: 'CC' },
    msc: { name: 'MSC Cruises', short: 'MSC Cruises', initials: 'MSC' },
    disney: { name: 'Disney Cruise Line', short: 'Disney', initials: 'D' }
});

// Google's unmodified official logo, rendered after Google's rows only.
const GOOGLE_ATTRIBUTION_HTML =
    '<div class="google-maps-attribution">' +
        '<img src="/images/google-maps-attribution-dark-gray.svg" ' +
             'alt="Google Maps" width="98" height="18">' +
    '</div>';

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
        // The passenger's typed text as it stood at the moment of selection —
        // captured before applySelection overwrites the input with Google's
        // address. Page memory only: nothing reads or transmits it yet.
        this.rawQuery = null;
        this.isValidated = false;
        // Curated cruise terminals: the validated registry (null until the
        // JSON loads), the rows for the CURRENT text, the Google section's
        // state ('idle' | 'loading' | 'results' | 'error'), and whether
        // Escape/blur dismissed the dropdown since the last keystroke.
        this.curatedRegistry = null;
        this.curatedRows = [];
        this.curatedLoad = null;
        this.curatedLoadAttempts = 0;
        this.googleState = 'idle';
        this.curatedSuppressed = false;
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
        // Fetch the curated registry at boot so the first keystroke already
        // has it; a failure leaves the dropdown exactly as today.
        this.loadCuratedRegistry();
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
        // The text no longer describes a selected place.
        this.rawQuery = null;
        
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

        // Curated terminals render NOW, from the text alone — Google's
        // predictions arrive later and slot in below. A keystroke also
        // lifts the Escape/blur suppression for a registry that is still
        // loading.
        this.curatedSuppressed = false;
        this.loadCuratedRegistry();
        // New text, new list: nothing is highlighted until the passenger
        // moves again, and the list starts at the top — a scroll position
        // left over from the previous query must not hide the first rows.
        this.selectedIndex = -1;
        this.highlightItem();
        if (this.suggestionsContainer) this.suggestionsContainer.scrollTop = 0;
        if (this.matchCurated(value).length > 0 || this.curatedList().length > 0) {
            const state = this.googleState || 'idle';
            this.renderDropdown(state === 'results' ? this.predictions : [], state);
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
        this.renderDropdown(suggestions, 'results');
    }

    // ---- Curated cruise terminals (LinkMia's own list, above Google) ----
    //
    // The registry (data/curated-places.json) is validated and matched by the
    // shared js/curated-places.js module, loaded as a classic script before
    // this one (global CuratedPlaces). Until it has loaded — or if it never
    // does — every path below degrades to exactly today's dropdown.

    curatedList() {
        return Array.isArray(this.curatedRows) ? this.curatedRows : [];
    }

    matchCurated(query) {
        const core = typeof globalThis !== 'undefined' ? globalThis.CuratedPlaces : undefined;
        if (!core || !this.curatedRegistry) return [];
        return core.matchCurated(query, this.curatedRegistry);
    }

    // ONE ordered list for clicks, Enter and data-index: curated rows first,
    // then Google's predictions.
    visibleItems() {
        const predictions = Array.isArray(this.predictions) ? this.predictions : [];
        return [
            ...this.curatedList().map((row) => ({ source: 'curated', row })),
            ...predictions.map((prediction) => ({ source: 'google', prediction }))
        ];
    }

    // Stable identity of a visible item, so a keyboard highlight can be
    // re-found after the list re-renders (Codex seq:0264 #2).
    itemIdentity(item) {
        if (!item) return null;
        if (item.source === 'curated') return `curated:${item.row.terminalId}`;
        const prediction = item.prediction || {};
        return `google:${prediction.place_id || prediction.description || ''}`;
    }

    highlightedIdentity() {
        const index = this.selectedIndex;
        if (!Number.isInteger(index) || index < 0) return null;
        return this.itemIdentity(this.visibleItems()[index]);
    }

    loadCuratedRegistry() {
        if (this.curatedRegistry || this.curatedLoad) return;
        const core = typeof globalThis !== 'undefined' ? globalThis.CuratedPlaces : undefined;
        if (!core || typeof fetch !== 'function') return;
        if ((this.curatedLoadAttempts || 0) >= 2) return;
        this.curatedLoadAttempts = (this.curatedLoadAttempts || 0) + 1;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { if (controller) controller.abort(); }, 8000);
        this.curatedLoad = fetch(CURATED_REGISTRY_URL, controller ? { signal: controller.signal } : {})
            .then((response) => (response.ok ? response.json() : null))
            .then((raw) => {
                // A non-OK response is transient: the one retry stays
                // available. An INVALID file is a deploy mistake that a
                // second fetch cannot fix — give up for this page load.
                if (raw === null) return;
                const validation = core.validateRegistry(raw);
                if (!validation.ok) {
                    this.curatedLoadAttempts = 2;
                    console.warn('Curated places registry invalid — curated suggestions off');
                    return;
                }
                this.curatedRegistry = validation.registry;
                this.refreshCurated();
            })
            .catch(() => {
                // Registry unavailable: the dropdown stays exactly as today.
            })
            .then(() => {
                clearTimeout(timer);
                this.curatedLoad = null;
            });
    }

    // The registry arrived after the passenger started typing: re-render the
    // current text with the same Google state — unless Escape/blur dismissed
    // the dropdown since the last keystroke.
    refreshCurated() {
        if (!this.input || this.curatedSuppressed) return;
        const value = (this.input.value || '').trim();
        if (value.length < 3) return;
        const state = this.googleState || 'idle';
        if (state === 'idle' && this.matchCurated(value).length === 0) return;
        this.renderDropdown(state === 'results' ? this.predictions : [], state);
    }

    curatedPresentation(row) {
        const registry = this.curatedRegistry;
        const terminal = registry.byPlaceId[row.placeId];
        const keys = row.companyKey ? [row.companyKey] : terminal.companies;
        const brands = keys.map((key) => {
            if (Object.prototype.hasOwnProperty.call(CURATED_BRANDS, key)) return CURATED_BRANDS[key];
            const name = registry.companyByKey[key].name;
            return {
                name,
                short: name,
                initials: name.trim().split(/\s+/).slice(0, 3).map((word) => word.charAt(0)).join('').toUpperCase().slice(0, 3)
            };
        });
        const shared = keys.length > 1;
        return {
            // Only an explicitly listed key can become a CSS class.
            theme: !shared && Object.prototype.hasOwnProperty.call(CURATED_BRANDS, keys[0]) ? keys[0] : 'shared',
            name: brands.map((brand) => shared ? brand.short : brand.name).join(' · '),
            initials: brands.map((brand) => brand.initials).join('/'),
            port: registry.port.name,
            terminal: terminal.name.startsWith(registry.port.name + ' ')
                ? terminal.name.slice(registry.port.name.length + 1)
                : terminal.name
        };
    }

    // THE one renderer. `state` describes the Google section: 'idle' (no
    // request yet), 'loading', 'results' or 'error'. Curated rows come from
    // the CURRENT input text, synchronously, so they never wait for Google
    // and a slow, empty or failed Google answer never erases them. Google's
    // logo travels with Google's rows only: a curated-only list shows no
    // Google content and therefore no Google attribution.
    renderDropdown(google, state) {
        // A keyboard highlight survives background updates of the SAME text
        // (Google loading / results / error, a late registry): remember it
        // by item identity, re-find it in the new list, drop it only when
        // that item is gone. A new query resets it in handleInput.
        const keep = this.highlightedIdentity();
        const rows = this.matchCurated(this.input ? this.input.value : '');
        this.curatedRows = rows;
        this.googleState = state;
        // Curated rows ARE valid choices: a Google failure that flagged the
        // field before they existed (a registry arriving late) must not keep
        // marking an available destination invalid (Codex seq:0266 #1).
        // Display only — validation state and any selection stay untouched.
        if (rows.length > 0) this.clearAddressErrorDisplay();
        // Google's list stays intact beneath ours: a terminal may appear
        // again further down in Google's own words, and the preferred row is
        // still first (Google terms gate; Codex recommendation 2026-10-27).
        const predictions = Array.isArray(google) ? google : [];
        this.predictions = predictions;
        this.selectedIndex = keep === null
            ? -1
            : this.visibleItems().findIndex((item) => this.itemIdentity(item) === keep);

        // A small caption says which rows are LinkMia's own; Google's rows
        // keep Google's look and attribution. Not a row: never focusable,
        // never counted by the keyboard.
        const curatedLabel = rows.length > 0
            ? '<div class="suggestion-group-label">LinkMia terminals</div>'
            : '';
        const curatedHtml = curatedLabel + rows.map((row, index) => {
            const display = this.curatedPresentation(row);
            return `
                <div class="suggestion-item suggestion-item--curated curated-brand--${display.theme}" data-index="${index}" data-terminal="${this.escapeHtml(row.terminalId)}">
                    <div class="curated-initials" aria-hidden="true">${this.escapeHtml(display.initials)}</div>
                    <div class="suggestion-text">
                        <div class="suggestion-main">${this.escapeHtml(display.name)}</div>
                        <div class="suggestion-secondary">${this.escapeHtml(display.port)}</div>
                    </div>
                    <span class="suggestion-terminal">${this.escapeHtml(display.terminal)}</span>
                </div>
            `;
        }).join('');
        const googleLabel = rows.length > 0 && predictions.length > 0
            ? '<div class="suggestion-group-label suggestion-group-label--google">Google suggestions</div>'
            : '';
        const googleHtml = googleLabel + this.googleRowsHtml(predictions, rows.length);
        const attribution = predictions.length > 0 ? GOOGLE_ATTRIBUTION_HTML : '';

        let notice = '';
        if (state === 'loading') {
            notice = '<div class="loading-results">Loading...</div>';
        } else if (state === 'error') {
            notice = rows.length > 0
                ? '<div class="no-results">More results unavailable right now</div>'
                : '<div class="no-results">Error loading suggestions</div>';
        } else if (state === 'results' && predictions.length === 0 && rows.length === 0) {
            notice = '<div class="no-results">No results found</div>';
        }

        if (!curatedHtml && !googleHtml && !notice) {
            this.selectedIndex = -1;
            this.suggestionsContainer.innerHTML = '';
            this.hideSuggestions();
            return;
        }
        this.suggestionsContainer.innerHTML = curatedHtml + googleHtml + attribution + notice;
        this.showSuggestions();
        this.bindRowClicks();
        if (this.selectedIndex >= 0) this.highlightItem();
    }

    // Google rows: one per prediction, numbered AFTER the curated rows so a
    // click or Enter resolves against the same visible list.
    googleRowsHtml(suggestions, offset) {
        if (!suggestions || suggestions.length === 0) return '';
        
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
                <div class="suggestion-item" data-index="${offset + index}">
                    <div class="suggestion-icon">📍</div>
                    <div class="suggestion-text">
                        <div class="suggestion-main">${this.escapeHtml(mainText)}</div>
                        ${secondaryText ? `<div class="suggestion-secondary">${this.escapeHtml(secondaryText)}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
        
        return html;
    }

    bindRowClicks() {
        
        this.suggestionsContainer.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                const index = parseInt(item.dataset.index);
                this.selectSuggestion(index);
            });
        });
    }

    async selectSuggestion(index) {
        const item = this.visibleItems()[index];
        if (!item) return;
        // Selection ends the prediction cycle: the queued debounce and any
        // in-flight request are invalidated NOW, so a late response cannot
        // reopen the list and a late failure cannot flag the chosen address
        // (Codex seq:0264 #1). Same boundary as Escape/blur.
        this.cancelPendingSuggestions();
        // A curated terminal row carries LinkMia's own label and the registry
        // place ID; a Google row carries the prediction.
        const curated = item.source === 'curated' ? item.row : null;
        const suggestion = curated ? null : item.prediction;

        const selectionSequence = ++this.selectionSequence;
        const placeId = curated ? curated.placeId : suggestion.place_id;
        // Snapshot the typed text SYNCHRONOUSLY: after the Details await,
        // applySelection will have replaced the input's value with Google's
        // address, and the original is unrecoverable. The snapshot is bound
        // to THIS selection and published only on its winning paths below —
        // a selection that loses the sequence race, or fails without a
        // usable prediction, never publishes its text.
        const rawQueryAtSelection = this.input.value.trim();
        // A new selection ends the previous snapshot's life immediately: if
        // this selection fails completely, the OLD text must not survive
        // attached to a context it never described.
        this.rawQuery = null;
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
                place_id: placeId,
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
            // Google's contract requires displaying EVERY returned
            // third-party attribution. The proxy already fails closed on
            // unrepresentable sets; this re-validation is the browser's own
            // boundary — if any entry is invalid here, the Details result
            // is treated as failed and the prediction-description fallback
            // (which shows no Details content) takes over.
            const attributions = this.validAttributionEntries(data.attributions);
            if (attributions === null) {
                throw new Error('Attribution unrepresentable');
            }
            // A curated terminal keeps LinkMia's own unambiguous label (the
            // Details call supplied the coordinates and attributions); a
            // Google prediction shows Google's formatted address as before.
            const label = curated ? curated.label : data.result.formatted_address;
            const place = {
                id: placeId,
                formattedAddress: label,
                displayName: { text: label },
                location: {
                    lat: data.result.geometry.location.lat,
                    lng: data.result.geometry.location.lng
                },
                attributions
            };
            this.rawQuery = rawQueryAtSelection;
            this.applySelection(place);
        } catch (error) {
            if (selectionSequence !== this.selectionSequence) return;
            // A transient Details failure must not strand a passenger after a
            // deliberate live prediction selection. Preserve the Google
            // prediction's ID and visible description, but never manufacture
            // coordinates (the former 0,0 fallback silently routed to the
            // wrong continent). The authoritative quote service will resolve
            // the Place ID again before it can price an enabled booking.
            const description = curated
                ? curated.label
                : (typeof suggestion.description === 'string' ? suggestion.description.trim() : '');
            if (!description || typeof placeId !== 'string') {
                console.error('Place details unavailable');
                this.showError();
                return;
            }
            console.error('Place details unavailable; using selected prediction');
            this.rawQuery = rawQueryAtSelection;
            this.applySelection({
                id: placeId,
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

    // Browser-side attribution boundary. Entries arrive as ordered SEGMENT
    // lists ({text, href} with href null for unlinked text) so Google's
    // published format — unlinked prefixes around a linked name — survives
    // structurally. Returns the validated entries, or NULL when the set is
    // unrepresentable, and the caller fails the Details result closed
    // rather than display Google content with partial or altered credit.
    // The attributions field itself is REQUIRED (legacy Place Details
    // always returns the array, even empty): a missing field fails closed
    // too. Every segment must carry an OWN href property that is exactly
    // null or a valid https URL — never undefined, never http.
    validAttributionEntries(list) {
        if (!Array.isArray(list) || list.length > 16) return null;
        const out = [];
        for (const entry of list) {
            if (!entry || typeof entry !== 'object' ||
                !Array.isArray(entry.segments) ||
                entry.segments.length === 0 || entry.segments.length > 8) return null;
            const segments = [];
            let visible = '';
            for (const segment of entry.segments) {
                if (!segment || typeof segment !== 'object' ||
                    !Object.prototype.hasOwnProperty.call(segment, 'href')) return null;
                const text = typeof segment.text === 'string' ? segment.text : null;
                if (text === null || text.length > 1000) return null;
                let href = segment.href;
                if (href !== null) {
                    if (typeof href !== 'string' || href.length > 1000) return null;
                    let parsed;
                    try { parsed = new URL(href); } catch (_) { return null; }
                    if (parsed.protocol !== 'https:') return null;
                    href = parsed.href;
                    if (!text.trim()) return null;   // a link needs a visible label
                }
                visible += text;
                segments.push({ text, href });
            }
            if (!visible.trim()) return null;
            out.push({ segments });
        }
        return out;
    }

    // Third-party attributions (Google policy): render EVERY validated
    // {text, href} entry beside the Google Maps attribution. The host
    // element begins with the text "Google Maps", so every entry — the
    // first included — is preceded by an explicit ' · ' separator. DOM is
    // built with textContent and validated https hrefs only — provider
    // strings are never interpreted as HTML here, whatever the server sends.
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
        for (const entry of attributions) {
            if (!Array.isArray(entry?.segments)) continue;
            holder.appendChild(document.createTextNode(' · '));
            for (const segment of entry.segments) {
                const text = typeof segment?.text === 'string' ? segment.text : '';
                if (!text) continue;
                const href = typeof segment?.href === 'string' && /^https:\/\//i.test(segment.href)
                    ? segment.href : null;
                if (href) {
                    const node = document.createElement('a');
                    node.href = href;
                    node.target = '_blank';
                    node.rel = 'noopener noreferrer';
                    node.textContent = text;
                    holder.appendChild(node);
                } else {
                    holder.appendChild(document.createTextNode(text));
                }
            }
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
        // A registry that finishes loading now must not reopen the list.
        this.curatedSuppressed = true;
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
        this.curatedRows = [];
        this.googleState = 'idle';
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
        this.renderDropdown([], 'loading');
    }
    
    // Kill any in-flight selection and drop the published raw-query
    // snapshot WITHOUT touching visible form state. Reset and same-page
    // edit entry are hard boundaries for the snapshot even while a Details
    // request is still racing: advancing the sequence makes the in-flight
    // response lose its guard, so it can neither republish the snapshot nor
    // restore the cancelled address.
    invalidateRawCapture() {
        ++this.selectionSequence;
        this.rawQuery = null;
    }

    clearValidation() {
        this.invalidateRawCapture();
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

    // The field's error styling and the "select a valid address" notice —
    // never isValidated or selectedPlace (clearValidation owns those).
    clearAddressErrorDisplay() {
        this.input.classList.remove('error');
        if (document.getElementById('addressError')) {
            document.getElementById('addressError').classList.remove('visible');
        }
    }

    showError() {
        this.renderDropdown([], 'error');
        // With curated rows on screen the passenger still has valid choices;
        // only an EMPTY list is an address error.
        if (this.curatedList().length > 0) return;
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
