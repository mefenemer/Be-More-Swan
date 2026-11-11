// src/utils/site-builders/replit.ts — Website import adapter for Replit (Replit Agent apps, published
// on *.replit.app, a custom domain, or a *.replit.dev development preview).
// Findings, what is covered and what is not: docs/site-import-platforms/replit.md
// Tests: tests/site-platform-replit.test.ts (fixtures in tests/fixtures/site-platforms/replit/).
//
// What Replit Agent usually makes: a React + Vite single-page app served by Express (an empty
// <div id="root"> until the browser runs it — the headless browser reads it), sometimes a Flask app
// drawn on the server with Replit's own Bootstrap theme. Either way the page carries a few Replit
// fingerprints, and Replit answers for an app that is private, unpublished or stopped with a page of
// its own — never the owner's words, so it is never imported as if it were.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/**
 * Replit's fingerprints in a page's HTML: the dev banner script Agent puts in client/index.html (kept
 * in the production build), the Flask template's Bootstrap theme on cdn.replit.com, the old "Built
 * with Replit" badge, Replit's own interstitial pages (/__replco/ assets), the dev build's
 * cartographer attributes, and a canonical or og:url on a Replit host. A plain link to replit.com in
 * someone's words is NOT one (a portfolio linking to its repl was made somewhere else).
 */
const FINGERPRINT = /replit-dev-banner|cdn\.replit\.com\/agent\/|replit-badge|id=["']?replitBadge|\/__replco\/|data-replit-metadata|@replit\/vite-plugin|href=["']\/__repl\?/i;
const REPLIT_HOST = /^(?:[\w-]+\.)*(?:replit\.app|replit\.dev|repl\.co)$/i;

/** Replit's own site (a sign-in redirect lands there) — not an app published on it. */
const isReplitOwnHost = (host: string) => /^(?:[\w-]+\.)?replit\.com$/i.test(host);

/** The app's address as the page states it (canonical link or og:url) is on a Replit host. */
function statesReplitHost($: cheerio.CheerioAPI): boolean {
    for (const raw of [$('link[rel="canonical"]').attr('href'), $('meta[property="og:url"]').attr('content')]) {
        try { if (raw && REPLIT_HOST.test(new URL(raw).hostname)) return true; } catch { /* not an address */ }
    }
    return false;
}

/**
 * A page Replit shows instead of the app: "This app isn't live yet", "This project isn't available
 * right now" (a stopped development preview), the sign-in page of a private app, the password page.
 * Replit's interstitials load their fonts from /__replco/ and have no app root; its own site names
 * itself in og:site_name.
 */
function isReplitsOwnPage($: cheerio.CheerioAPI, url: URL | null): boolean {
    if (url && isReplitOwnHost(url.hostname)) return true;
    if (($('meta[property="og:site_name"]').attr('content') ?? '').trim().toLowerCase() === 'replit') return true;
    const usesReplco = $('link[href*="/__replco/"], script[src*="/__replco/"]').length > 0
        || $('style').toArray().some((el) => /\/__replco\//.test($(el).text()));
    return usesReplco && $('#root, #app, #__next, main').length === 0;
}

/** The Agent template's catch-all page (client/src/pages/not-found.tsx): a menu link to a page never built. */
const TEMPLATE_NOT_FOUND = /did you forget to add the page to the router\?/i;

export const adapter: BuilderAdapter = {
    key: 'replit',
    label: 'Replit',
    detect: (html, gen, $) => FINGERPRINT.test(html) || gen.includes('replit') || statesReplitHost($)
        || ($('meta[property="og:site_name"]').attr('content') ?? '').trim().toLowerCase() === 'replit',
    prepare($, url) {
        // Replit's page, not theirs: read as empty, so the import says it couldn't read the site
        // rather than building a draft from Replit's sign-in or "not live" words.
        if (isReplitsOwnPage($, url)) {
            $('title, meta[name="description"], meta[property^="og:"]').remove();
            $('body').empty();
            return;
        }
        // A menu link to a route the app never had: the template's 404 card, not a page of theirs.
        if (TEMPLATE_NOT_FOUND.test($('body').text())) {
            const root = $('#root').first();
            (root.length ? root : $('body')).empty();
            return;
        }
        // Replit's furniture: the development-preview banner (replit.dev), the old badge, and the
        // empty toast region shadcn/ui leaves in every page.
        $('#replit-dev-banner, #replitBadge, img[src*="replit.com/badge"], a[href^="/__repl"]').remove();
        $('[role="region"][aria-label^="Notifications"]').remove();
        // Agent draws the site's top bar as a bare <nav> holding the logo, with no <header>, so the
        // logo was never found (the import looks for it in the header). The bar that comes before
        // the page's content becomes the header it is.
        if ($('header').length === 0) {
            const nav = $('body nav').filter((_, el) => $(el).closest('main, footer, article').length === 0).first();
            if (nav.length && nav.find('img').length) nav.wrap('<header></header>');
        }
    },
    noise: /^(?:made|built) (?:with|on) replit$|^open (?:in|on) replit$|^this is a temporary development preview\b/i,
    /**
     * Agent fills pages with Unsplash photos asked for at card size (w=600–800). The same address
     * gives any width: ask for 1600 wide, keeping the crop's shape when it has a height.
     */
    fullSizeImage(src) {
        let u: URL;
        try { u = new URL(src); } catch { return null; }
        if (u.hostname !== 'images.unsplash.com') return null;
        const w = Number(u.searchParams.get('w'));
        if (!w || w >= 1600) return null;
        const h = Number(u.searchParams.get('h'));
        u.searchParams.set('w', '1600');
        if (h) u.searchParams.set('h', String(Math.round((h * 1600) / w)));
        return u.toString();
    },
    rendersWithJs: true,
};
