/**
 * cached-fetch.js — a short-lived, write-invalidated cache for read-mostly GETs.
 *
 * The workspace swaps views without reloading, and several views (and the components they open)
 * each fetched the same list for themselves. Measured on prod 2026-10-07: seven tab switches made
 * eight get-assistants calls from six call sites, at up to ~1.3 s each.
 *
 *   window.bmsCachedFetch(url, { fresh, ttlMs })  →  Promise<Response>
 *   window.bmsCachedFetch.assistants({ fresh })    →  the shared get-assistants list
 *   window.bmsCachedFetch.invalidate()
 *
 * Every caller gets its own Response clone, so each can call .json() as it always did. Concurrent
 * callers share one request. A failed or non-2xx response is not kept.
 *
 * ⚠️ Freshness rules — the reason this is safe to use for state the user can change:
 *   - ANY non-GET request to a function (/.netlify/functions/*, /api/*) clears the whole cache, so
 *     whatever the user just did (hire, pause, archive, rename, switch organisation) is never
 *     answered from a copy taken before it.
 *   - Nothing is kept for longer than ttlMs (30 s by default), which bounds how stale a change made
 *     by a background job (provisioning finishing, a worker moving an assistant's status) can be.
 *   - A caller that must see the server's current answer — a poll — passes { fresh: true }, which
 *     fetches and replaces the cached copy.
 */
(function () {
    if (window.bmsCachedFetch) return;

    const DEFAULT_TTL_MS = 30000;
    const cache = new Map(); // url → { at, promise: Promise<Response> }
    const nativeFetch = window.fetch.bind(window);

    function cachedFetch(url, opts) {
        const o = opts || {};
        const ttl = o.ttlMs != null ? o.ttlMs : DEFAULT_TTL_MS;
        const hit = cache.get(url);
        if (!o.fresh && hit && Date.now() - hit.at < ttl) return hit.promise.then(r => r.clone());

        const entry = { at: Date.now(), promise: null };
        entry.promise = nativeFetch(url, { credentials: 'same-origin' }).then(
            (res) => { if (!res.ok && cache.get(url) === entry) cache.delete(url); return res; },
            (err) => { if (cache.get(url) === entry) cache.delete(url); throw err; },
        );
        cache.set(url, entry);
        return entry.promise.then(r => r.clone());
    }

    cachedFetch.invalidate = function () { cache.clear(); };

    // The one assistants list every surface shares. `period=all` because the grids show all-time
    // ROI on their cards; every other caller reads only names, roles and status, which the period
    // does not touch — so they all share a single entry instead of one per spelling.
    cachedFetch.ASSISTANTS_URL = '/.netlify/functions/get-assistants?period=all';
    cachedFetch.assistants = function (opts) { return cachedFetch(cachedFetch.ASSISTANTS_URL, opts); };

    // Write ⇒ invalidate. Wrapping fetch is what makes this hold for every write path in the app,
    // including ones added later, without each of them having to remember to call invalidate().
    window.fetch = function (input, init) {
        try {
            const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') {
                const url = typeof input === 'string' ? input : (input && input.url) || String(input);
                if (url.includes('/.netlify/functions/') || url.includes('/api/')) cache.clear();
            }
        } catch (_) { /* never let the cache get in the way of a request */ }
        return nativeFetch(input, init);
    };

    window.bmsCachedFetch = cachedFetch;
})();
