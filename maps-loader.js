/**
 * LinkMia's single Maps JavaScript API loader.
 *
 * The loader response comes directly from maps.googleapis.com, as required by
 * Google Maps Platform Support. The dedicated browser key is deliberately
 * visible here at runtime and must be protected by GCP website + API
 * restrictions. Railway remains the private REST proxy for autocomplete and
 * route web-service calls; it never supplies this loader or this key.
 */
(function installLinkMiaMapsLoader(global) {
    'use strict';

    const GOOGLE_MAPS_JS_URL = 'https://maps.googleapis.com/maps/api/js';
    const CALLBACK_NAME = '__linkmiaGoogleMapsReady';
    const FAILURE_EVENT = 'linkmia:maps-error';
    const LOAD_TIMEOUT_MS = 15000;
    const BROWSER_KEY_RE = /^AIza[0-9A-Za-z_-]{20,200}$/;

    let loadPromise = null;
    let pendingReject = null;
    let timeoutId = null;
    let authFailureInstalled = false;

    function notifyFailure(reason) {
        global.dispatchEvent(new CustomEvent(FAILURE_EVENT, {
            detail: Object.freeze({ reason })
        }));
    }

    function configuredKey() {
        const value = global.LINKMIA_MAPS_CONFIG?.apiKey;
        return typeof value === 'string' && BROWSER_KEY_RE.test(value) ? value : null;
    }

    function rejectPending(reason) {
        notifyFailure(reason);
        if (pendingReject) pendingReject(new Error(`Google Maps unavailable (${reason})`));
    }

    function installAuthFailureBoundary() {
        if (authFailureInstalled) return;
        authFailureInstalled = true;
        global.gm_authFailure = function linkMiaGoogleMapsAuthFailure() {
            rejectPending('authorization');
        };
    }

    function load() {
        if (global.google?.maps) return Promise.resolve(global.google.maps);
        if (loadPromise) return loadPromise;

        const key = configuredKey();
        if (!key) {
            notifyFailure('configuration');
            return Promise.reject(new Error('Google Maps browser key is not configured'));
        }

        installAuthFailureBoundary();
        loadPromise = new Promise((resolve, reject) => {
            let settled = false;
            pendingReject = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                reject(error);
            };

            global[CALLBACK_NAME] = () => {
                if (settled) return;
                if (!global.google?.maps) {
                    pendingReject(new Error('Google Maps callback completed without the API'));
                    notifyFailure('incomplete');
                    return;
                }
                settled = true;
                clearTimeout(timeoutId);
                pendingReject = null;
                resolve(global.google.maps);
            };

            const url = new URL(GOOGLE_MAPS_JS_URL);
            url.searchParams.set('key', key);
            url.searchParams.set('v', 'weekly');
            url.searchParams.set('loading', 'async');
            url.searchParams.set('callback', CALLBACK_NAME);
            url.searchParams.set('auth_referrer_policy', 'origin');

            const script = document.createElement('script');
            script.src = url.href;
            script.async = true;
            script.referrerPolicy = 'strict-origin-when-cross-origin';
            script.onerror = () => rejectPending('network');
            document.head.appendChild(script);

            timeoutId = setTimeout(() => rejectPending('timeout'), LOAD_TIMEOUT_MS);
        });

        return loadPromise;
    }

    global.LinkMiaMapsLoader = Object.freeze({ load });
})(window);
