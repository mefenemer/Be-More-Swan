// src/utils/trigger-site-rebuild.ts
// Rebuild the public site after a change to something the build bakes into it.
//
// scripts/build-seo-html.mjs writes plan prices, plan names and limits into pricing.html, the home
// page and llms.txt at build time, so crawlers and AI assistants can read them without running
// JavaScript. The browser still fetches live prices, but a crawler reads the baked copy — so after
// a plan edit that copy is stale until the next deploy. This fires a Netlify build hook to make
// "the next deploy" a few minutes away instead of the next release.
//
// ⚠️ SITE_REBUILD_HOOK must be scoped to the PRODUCTION deploy context only. Staging is a branch
// deploy of the same Netlify site, so an all-contexts value reaches staging's functions too — and
// the build reads its data from bemoreswan.com whichever deploy runs it, so a staging plan edit
// changes nothing the build reads. NETLIFY_PROD_BUILD_HOOK is deliberately not reused: it is set
// where the issue pipeline runs (staging) and would rebuild production on every staging plan edit.

/** How long to wait for Netlify to ACCEPT the build (it answers as soon as it queues it). */
const DISPATCH_TIMEOUT_MS = 5_000;

/**
 * Best-effort by construction: the change it follows is already saved, so a failure here only means
 * the baked copy waits for the next deploy. Never throws. Awaited on purpose — an un-awaited fetch
 * can be frozen with the lambda before the request leaves.
 */
export async function triggerSiteRebuild(reason: string): Promise<void> {
    const hook = process.env.SITE_REBUILD_HOOK;
    if (!hook) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        // trigger_title shows in the Netlify deploy list, so a rebuild can be traced to its cause.
        const url = `${hook}${hook.includes('?') ? '&' : '?'}trigger_title=${encodeURIComponent(`Site rebuild: ${reason}`)}`;
        const res = await fetch(url, { method: 'POST', signal: controller.signal });
        if (!res.ok) console.error(`[trigger-site-rebuild] build hook returned ${res.status} (${reason})`);
    } catch (err) {
        console.warn('[trigger-site-rebuild] build hook unreachable — baked prices wait for the next deploy:',
            err instanceof Error ? err.message : err);
    } finally {
        clearTimeout(timer);
    }
}
