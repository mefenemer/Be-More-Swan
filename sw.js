// sw.js — Be More Swan Service Worker
//
// MUST be served from the site ROOT. A service worker's scope is capped by its own URL's directory,
// so /assets/sw.js could only ever control /assets/* — it would register without complaint and then
// never receive a push for any real page. This file existing at / is load-bearing.
//
// Deliberately NOT a caching/offline worker. Its only job is Web Push: receiving the push event,
// raising the OS notification, and routing the click. Adding a fetch handler here would put a cache
// in front of an app that is entirely dynamic and authenticated, which is a much bigger change than
// notifications and would break in ways that look like stale data rather than like a broken worker.

const DEFAULT_URL = '/workspace.html';

// ── Receiving a push ────────────────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
    // The payload is written by src/utils/web-push.ts. Parse defensively: a push with no data, or
    // with data we cannot read, must still raise SOMETHING. A browser that wakes the worker for a
    // push and gets no notification out of it may revoke the site's push permission — several do,
    // and that is unrecoverable from inside the page.
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (_) {
        try { data = { body: event.data ? event.data.text() : '' }; } catch (_) { data = {}; }
    }

    const title = data.title || 'Be More Swan';
    const options = {
        body: data.body || 'You have a new notification.',
        // Real files — favicon/manifest.json references a set of android-icon-*.png that are NOT
        // in the repo, so anything copied from there 404s and the notification renders iconless.
        icon: '/favicon/web-app-manifest-192x192.png',
        badge: '/favicon/favicon-96x96.png',
        // Two alerts sharing a tag replace each other rather than stacking — right for a
        // superseding count ("3 posts awaiting approval"), wrong for unrelated alerts, so the
        // server only sets it where superseding is what it means.
        tag: data.tag || undefined,
        // Without renotify, a replaced notification updates silently. With it, a genuinely new
        // count buzzes again. Only meaningful alongside a tag.
        renotify: !!data.tag,
        data: {
            url: data.url || DEFAULT_URL,
            notificationId: data.notificationId || null,
        },
        timestamp: Date.now(),
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// ── Clicking one ────────────────────────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || DEFAULT_URL;

    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

        // Focus an existing tab rather than opening a duplicate. Matching on ORIGIN, not on the
        // full URL: the user almost always has the workspace open on some other view, and opening
        // a second tab of the same app is worse than navigating the one they have.
        for (const client of all) {
            try {
                if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
                    await client.focus();
                    if ('navigate' in client) await client.navigate(target);
                    return;
                }
            } catch (_) { /* a client we cannot parse or focus — try the next */ }
        }
        if (self.clients.openWindow) await self.clients.openWindow(target);
    })());
});

// ── Subscription rotation ───────────────────────────────────────────────────────────────────────
// A browser may replace a push subscription on its own. Without this, the old endpoint keeps being
// used, every send 410s, the row is retired, and the user silently stops receiving alerts with no
// error anywhere. Re-registering here closes that hole for a session that is still open; the
// client's subscribe-on-every-load closes it for one that is not.
self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
        try {
            const oldSub = event.oldSubscription || null;
            const newSub = event.newSubscription || await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: oldSub ? oldSub.options.applicationServerKey : undefined,
            });
            if (!newSub) return;
            if (oldSub) {
                await fetch('/.netlify/functions/push-subscribe', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint: oldSub.endpoint }),
                }).catch(() => {});
            }
            await fetch('/.netlify/functions/push-subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newSub.toJSON()),
            });
        } catch (err) {
            // Nothing useful to show a user here — the worker has no UI. The client-side
            // re-subscribe on next load is the backstop.
        }
    })());
});

// Take over from a previous worker version immediately, so a shipped fix to the push handler
// applies on the next page load instead of whenever every tab happens to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
