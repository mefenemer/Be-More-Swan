// src/utils/swan-index/route.ts
// Pure request-path → page resolution for The Swan Index. Split from the function module so the
// parsing is testable without a DB client import — same reasoning as src/utils/blog-route.ts, and
// the same trap: this is where the bugs live, not in the querying.

export type SwanRoute =
    | { kind: 'home' }
    | { kind: 'latest' }
    | { kind: 'authors' }
    | { kind: 'section'; key: string }
    | { kind: 'author'; handle: string }
    | { kind: 'article'; handle: string; slug: string }
    | { kind: 'about' }
    | { kind: 'feed' }
    | { kind: 'feedStyle' }
    | { kind: 'sitemap' }
    | { kind: 'robots' };

/** Malformed percent-encoding makes decodeURIComponent throw; on a public route that is a 404. */
function safeDecode(v: string): string | null {
    try { return decodeURIComponent(v); } catch { return null; }
}

/**
 * Resolve a pathname to a page, or null when it addresses none.
 *
 * ⚠️ Every pattern is ANCHORED. An unanchored /@handle match would find an author inside some
 * unrelated path, which is how a route starts answering URLs nobody designed.
 *
 * The '@' prefix on profile URLs is doing real work beyond looking like Medium: it puts author
 * handles in a namespace that top-level pages can never collide with, so /latest and /about stay
 * available for ever no matter who signs up. RESERVED_HANDLES in profile.ts is belt-and-braces.
 */
export function parseSwanRoute(pathname: string): SwanRoute | null {
    // Strip the staging prefix before anything else. theswanindex.com serves the publication at the
    // root, but until that domain is attached the only way in is /index-preview/* on the app domain
    // (see netlify.toml). Normalising here rather than in the function keeps every route below
    // written once, in the form the real site uses — a preview that exercises a different code path
    // to production is worth very little.
    const stripped = pathname.replace(/^\/index-preview(?=\/|$)/, '') || '/';

    // Trailing slash tolerated everywhere except the root, which has no other form.
    const path = stripped.length > 1 ? stripped.replace(/\/+$/, '') : stripped;

    if (path === '' || path === '/') return { kind: 'home' };
    if (path === '/latest') return { kind: 'latest' };
    if (path === '/authors') return { kind: 'authors' };
    if (path === '/about') return { kind: 'about' };
    if (path === '/feed.xml' || path === '/rss.xml') return { kind: 'feed' };
    // The feed's own stylesheet. A browser that follows the <?xml-stylesheet?> instruction renders
    // the RSS as a readable page instead of a wall of tags; a feed reader ignores it entirely.
    if (path === '/feed.xsl') return { kind: 'feedStyle' };
    if (path === '/sitemap.xml') return { kind: 'sitemap' };
    // Served by the function, not the repo's robots.txt: the domain rewrite below is `force = true`,
    // so the static file never gets a look in — and the publication needs different rules anyway.
    if (path === '/robots.txt') return { kind: 'robots' };

    const section = path.match(/^\/section\/([^/?#]+)$/);
    if (section) {
        const key = safeDecode(section[1]);
        return key ? { kind: 'section', key: key.toLowerCase() } : null;
    }

    const article = path.match(/^\/@([^/?#]+)\/([^/?#]+)$/);
    if (article) {
        const handle = safeDecode(article[1]);
        const slug = safeDecode(article[2]);
        return handle && slug ? { kind: 'article', handle: handle.toLowerCase(), slug } : null;
    }

    const author = path.match(/^\/@([^/?#]+)$/);
    if (author) {
        const handle = safeDecode(author[1]);
        return handle ? { kind: 'author', handle: handle.toLowerCase() } : null;
    }

    return null;
}
