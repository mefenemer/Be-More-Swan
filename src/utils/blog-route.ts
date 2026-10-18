// src/utils/blog-route.ts
// Pure request-path → (widget key, slug) resolution for the server-rendered blog permalink.
//
// blog-page.ts answers TWO routes, and they differ only in where the widget key comes from:
//   · /b/:key/:slug  — the tenant-neutral permalink. The key is IN the URL, so any workspace's
//                      published post is reachable without auth (the key is unguessable).
//   · /blog/:slug    — Be More Swan's own blog on our marketing domain. There is no key in the URL;
//                      it is implied by the domain, so it comes from SITE_BLOG_WIDGET_KEY.
//
// Split out of the function module so it is testable without a DB client import — the parsing is
// where the trap lives (see the anchoring note below), not the querying.

import { SITE_BLOG_WIDGET_KEY } from '../config/site-blog';

export interface BlogRoute {
    /** widget_configs.public_key this request resolves to. */
    publicKey: string;
    /** The post slug, percent-decoded. */
    slug: string;
    /**
     * The path the page is being SERVED at, re-encoded — this becomes og:url, and it is NOT the
     * canonical. A post reachable at /blog/x and /b/<key>/x has two page URLs and one canonical;
     * conflating them is how og:url starts advertising a URL the visitor did not open.
     */
    pathname: string;
}

// A slug arriving from the wire can be malformed percent-encoding ("/blog/%E0%A4%A"), which makes
// decodeURIComponent THROW. On a public, crawler-facing route that is a 500 where a 404 belongs.
function safeDecode(v: string): string | null {
    try { return decodeURIComponent(v); } catch { return null; }
}

/**
 * Resolve a request pathname to the post it addresses, or null when it addresses none.
 *
 * ⚠️ Both patterns are ANCHORED at the start of the path. The /b/ match used to be unanchored, so
 * it would happily find "/b/<key>/<slug>" in the middle of some other path. Netlify's rewrite means
 * the prefix is always where we expect it, and an anchored match keeps the two routes from ever
 * overlapping as more paths get added.
 */
export function parseBlogRoute(path: string): BlogRoute | null {
    const tenant = path.match(/^\/b\/([^/]+)\/([^/?#]+)/);
    if (tenant) {
        const publicKey = safeDecode(tenant[1]);
        const slug = safeDecode(tenant[2]);
        if (!publicKey || !slug) return null;
        return {
            publicKey,
            slug,
            pathname: `/b/${encodeURIComponent(publicKey)}/${encodeURIComponent(slug)}`,
        };
    }

    // Exactly one segment after /blog. A second segment is not a post — it must fall through to a
    // 404 rather than being silently truncated to its first component.
    const own = path.match(/^\/blog\/([^/?#]+)\/?$/);
    if (own) {
        const slug = safeDecode(own[1]);
        // A slug that is only a file extension away from a real asset ("/blog/style.css") is not a
        // post; the DB lookup will miss and 404 on its own, so no special-casing here.
        if (!slug) return null;
        return {
            publicKey: SITE_BLOG_WIDGET_KEY,
            slug,
            pathname: `/blog/${encodeURIComponent(slug)}`,
        };
    }

    return null;
}

export interface BlogIndexRoute {
    /** widget_configs.public_key this request resolves to. */
    publicKey: string;
    /** The path the index is served at, re-encoded, with no trailing slash — og:url and canonical. */
    pathname: string;
}

/**
 * Resolve /b/:key (optionally with a trailing slash) to the hosted blog INDEX for that widget.
 *
 * WHY this exists: on Wix the widget can only live inside an "Embed HTML" box, which is a fixed-size
 * iframe — the list is as tall as the box, however many posts there are. A full page we host needs
 * no box at all: the site owner points their "Blog" menu item at this URL.
 *
 * Checked BEFORE parseBlogRoute by the caller. The two cannot overlap — this pattern allows nothing
 * after the key but one optional slash, and parseBlogRoute needs a non-empty second segment — but
 * keeping them separate functions keeps BlogRoute.slug non-nullable for every post-page caller.
 */
export function parseBlogIndexRoute(path: string): BlogIndexRoute | null {
    const m = path.match(/^\/b\/([^/?#]+)\/?$/);
    if (!m) return null;
    const publicKey = safeDecode(m[1]);
    if (!publicKey) return null;
    return { publicKey, pathname: `/b/${encodeURIComponent(publicKey)}` };
}
