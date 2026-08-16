// push-client.js
// Registers the Service Worker and manages this browser's Web Push subscription.
//
// Vanilla IIFE exposing window.SwanPush, matching the rest of the frontend — there is no build step
// or module system on these pages.
//
//   SwanPush.status()      → { supported, reason, permission, subscribed }
//   SwanPush.enable()      → prompts for permission and subscribes. Returns the same status shape.
//   SwanPush.disable()     → unsubscribes this browser.
//   SwanPush.init()        → registers the worker and re-syncs an existing subscription. Idempotent.
//
// ── The iOS trap this file exists to make visible ───────────────────────────────────────────────
// iOS supports Web Push from 16.4, but ONLY for a PWA the user has added to the Home Screen. In a
// normal Safari tab, `Notification` is undefined and PushManager is unavailable — so the honest
// answer is "add this to your Home Screen first", not "your browser doesn't support notifications",
// and definitely not a button that appears to work and never delivers anything. status() reports
// that case as its own reason so the UI can say the right thing.

(function () {
    'use strict';

    var SW_URL = '/sw.js';
    var API = '/.netlify/functions/push-subscribe';
    var registration = null;

    /** iOS/iPadOS, including iPadOS 13+ which reports itself as a Mac with a touchscreen. */
    function isIos() {
        var ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/.test(ua) ||
            (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
    }

    /** True when running as an installed PWA rather than in a browser tab. */
    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }

    /**
     * Why push can't run here, or null when it can. Ordered most-specific first: an iPhone user in
     * Safari needs "add to Home Screen", which is actionable, rather than "unsupported", which is
     * both unhelpful and — once they install it — wrong.
     */
    function unsupportedReason() {
        if (!('serviceWorker' in navigator)) return 'no_service_worker';
        if (isIos() && !isStandalone()) return 'ios_needs_install';
        if (!('PushManager' in window)) return 'no_push_manager';
        if (!('Notification' in window)) return 'no_notification_api';
        return null;
    }

    /** VAPID keys travel as base64url; PushManager wants raw bytes. */
    function urlBase64ToUint8Array(base64String) {
        var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        var raw = window.atob(base64);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    async function serverConfig() {
        try {
            var res = await fetch(API, { credentials: 'same-origin' });
            if (!res.ok) return { supported: false, publicKey: null };
            return await res.json();
        } catch (_) {
            return { supported: false, publicKey: null };
        }
    }

    async function register() {
        if (registration) return registration;
        if (unsupportedReason()) return null;
        try {
            // Explicit root scope. The default is the worker's own directory, which is already '/'
            // here — stating it means moving the file later fails loudly instead of silently
            // narrowing what the worker can control.
            registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
            await navigator.serviceWorker.ready;
            return registration;
        } catch (err) {
            console.warn('[push] service worker registration failed', err);
            return null;
        }
    }

    async function currentSubscription() {
        var reg = await register();
        if (!reg) return null;
        try { return await reg.pushManager.getSubscription(); } catch (_) { return null; }
    }

    async function status() {
        var reason = unsupportedReason();
        if (reason) return { supported: false, reason: reason, permission: 'default', subscribed: false };
        var cfg = await serverConfig();
        if (!cfg.supported || !cfg.publicKey) {
            return { supported: false, reason: 'not_configured', permission: Notification.permission, subscribed: false };
        }
        var sub = await currentSubscription();
        return {
            supported: true,
            reason: null,
            permission: Notification.permission,
            subscribed: !!sub,
        };
    }

    async function enable() {
        var reason = unsupportedReason();
        if (reason) return { supported: false, reason: reason, permission: 'default', subscribed: false };

        var cfg = await serverConfig();
        if (!cfg.supported || !cfg.publicKey) {
            return { supported: false, reason: 'not_configured', permission: Notification.permission, subscribed: false };
        }

        // MUST be called from a user gesture — browsers reject a permission prompt that was not
        // triggered by a click, and some now permanently deny the site for asking unprompted.
        var permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            return { supported: true, reason: permission === 'denied' ? 'denied' : 'dismissed', permission: permission, subscribed: false };
        }

        var reg = await register();
        if (!reg) return { supported: false, reason: 'no_service_worker', permission: permission, subscribed: false };

        try {
            var sub = await reg.pushManager.getSubscription();
            if (!sub) {
                sub = await reg.pushManager.subscribe({
                    // Required to be true by every browser: a push must always produce a visible
                    // notification. Silent pushes are not available to the web.
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
                });
            }
            var res = await fetch(API, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sub.toJSON()),
            });
            if (!res.ok) {
                // The browser now holds a subscription the server does not know about. Drop it, so
                // the UI does not show "on" against a channel that will never deliver.
                try { await sub.unsubscribe(); } catch (_) {}
                return { supported: true, reason: 'save_failed', permission: permission, subscribed: false };
            }
            return { supported: true, reason: null, permission: permission, subscribed: true };
        } catch (err) {
            console.warn('[push] subscribe failed', err);
            return { supported: true, reason: 'subscribe_failed', permission: permission, subscribed: false };
        }
    }

    async function disable() {
        var sub = await currentSubscription();
        if (!sub) return { supported: true, reason: null, permission: (window.Notification || {}).permission || 'default', subscribed: false };
        var endpoint = sub.endpoint;
        try { await sub.unsubscribe(); } catch (_) {}
        try {
            await fetch(API, {
                method: 'DELETE',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: endpoint }),
            });
        } catch (_) { /* the local unsubscribe already stopped delivery to this device */ }
        return { supported: true, reason: null, permission: Notification.permission, subscribed: false };
    }

    /**
     * Register the worker on load, and re-POST an existing subscription.
     *
     * The re-POST is not redundant: a browser can rotate a subscription without telling the page,
     * and the pushsubscriptionchange handler in sw.js only fires while a worker is alive to hear
     * it. Re-syncing on every load is what stops a rotated endpoint quietly ending someone's
     * notifications. Cheap — one upsert keyed on the endpoint.
     */
    async function init() {
        if (unsupportedReason()) return;
        var reg = await register();
        if (!reg) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        var sub = await currentSubscription();
        if (!sub) return;
        try {
            await fetch(API, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sub.toJSON()),
            });
        } catch (_) { /* non-fatal — the next load tries again */ }
    }

    window.SwanPush = {
        status: status,
        enable: enable,
        disable: disable,
        init: init,
        isStandalone: isStandalone,
        isIos: isIos,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
        init();
    }
})();
