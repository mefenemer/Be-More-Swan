// src/utils/seo-rebuild.ts
// Ask Netlify to rebuild, because something baked AT BUILD TIME has stopped being true.
//
// ── What goes stale ────────────────────────────────────────────────────────────────────────────
// scripts/build-seo-html.mjs bakes a crawler-visible index of published posts into blog.html (Job
// 3). widget.js hides that copy behind a shadow root, so it is the ONLY version search engines and
// LLM scrapers read for /blog — and it is a snapshot taken at deploy time.
//
// Posts, however, publish on a */5 cron with no deploy anywhere near them. So the index drifts the
// moment the Blog Writing Assistant does its job: on 2026-09-09 the baked list held four posts
// while the live endpoint served five, and the fifth was reachable only from the sitemap. It is a
// silent drift — the page looks perfectly healthy, it is just describing an older site.
//
// ── Why a rebuild and not something cleverer ───────────────────────────────────────────────────
// The honest alternative is to stop baking and serve /blog from a function, so the list is built
// per request. That is a real change to a marketing page assembled from static partials, and it
// buys freshness for one list at the cost of making the whole page dynamic. Posts publish a few
// times a week; a build is minutes and costs nothing anyone notices. Rebuild on the event.
//
// ── Called once per invocation, never per post ─────────────────────────────────────────────────
// Deliberately NOT inside publishBlogPost(): the scheduled publisher can flip several posts in one
// tick, and one build per post would queue a pile of builds that supersede each other. The callers
// fire this once, after their work, when something actually changed.

/**
 * The environment variable holding the Netlify build hook URL.
 *
 * ⚠️ As of 2026-09-09 this is NOT set on production — only NETLIFY_STAGING_BUILD_HOOK is. An unset
 * hook makes this a no-op, which is the exact shape of a control that looks present and guards
 * nothing, so the miss is logged loudly rather than swallowed.
 */
const HOOK_VAR = 'NETLIFY_PROD_BUILD_HOOK';

export type RebuildResult = 'sent' | 'failed' | 'not-configured';

/**
 * Fire the build hook. Best-effort by contract: a publish must never fail because a rebuild could
 * not be requested — the post is live either way, and only the crawler index lags.
 *
 * ⚠️ AWAIT this. A Netlify Lambda freezes the moment its handler returns, so an un-awaited fetch is
 * cancelled in flight and the rebuild silently never happens — the same trap documented on
 * notifyEditorialDesk in blog-destinations/swanindex.ts.
 */
export async function requestSeoRebuild(reason: string): Promise<RebuildResult> {
    const hook = process.env[HOOK_VAR];
    if (!hook) {
        console.warn(
            `[seo-rebuild] ${HOOK_VAR} is not set — skipping the rebuild for "${reason}". The `
            + 'crawler-visible post index baked into /blog will stay stale until the next deploy.',
        );
        return 'not-configured';
    }
    try {
        const res = await fetch(hook, { method: 'POST' });
        if (!res.ok) {
            console.error(`[seo-rebuild] build hook returned ${res.status} for "${reason}"`);
            return 'failed';
        }
        console.log(`[seo-rebuild] rebuild requested: ${reason}`);
        return 'sent';
    } catch (e) {
        console.error(`[seo-rebuild] build hook unreachable for "${reason}":`, e instanceof Error ? e.message : e);
        return 'failed';
    }
}
