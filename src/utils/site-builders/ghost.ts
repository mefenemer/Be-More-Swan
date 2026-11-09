// src/utils/site-builders/ghost.ts — Website import adapter for Ghost.
// Findings, what is covered and what is not: docs/site-import-platforms/ghost.md
// Tests: tests/site-platform-ghost.test.ts (fixtures in tests/fixtures/site-platforms/ghost/).
//
// Ghost pages are server-rendered by a Handlebars theme (Casper, Source and the other official themes
// share the same class names): the words are in the HTML, a post's or page's body is
// `section.gh-content` built from Koenig editor cards (`.kg-card`), the menu is `ul.nav` in the theme's
// header, pictures are under /content/images/ with resized copies at /content/images/size/w600/…, and
// the accent colour is `--ghost-accent-color` in a <style> Ghost writes into every head.
// What the adapter removes is Ghost's own furniture: the members "Portal" (Sign in / Subscribe), the
// search button, bylines, reading times, tags, share buttons and media player controls.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Ghost's members, search and sharing furniture: the new site has no members, search or Portal. */
const FURNITURE = [
    '[data-portal]', 'a[href^="#/portal"]', 'a[href^="#/share"]', '.gh-button-share', '[data-ghost-search]', '.gh-search', '.gh-burger',
    '.gh-head-members', '.gh-navigation-members', '[data-members-form]',
    // Members-only cuts and sign-up boxes: "This post is for subscribers only", "Sign up for more like this."
    '.gh-post-upgrade-cta', '.post-upgrade-cta', '.kg-signup-card', '.footer-cta', '.gh-footer-signup', '.gh-cta',
    // Bylines, dates, reading times and tags on posts and feed cards.
    '.article-byline', '.gh-article-meta', '.gh-meta-share', '.author-list', '.author-profile-image', '.byline-meta-content',
    '.post-card-meta', '.gh-card-meta', '.post-card-tags', '.gh-card-tag', '.article-tag', '.gh-article-tag', '.post-card-access', '.post-card-featured',
    // Paging through the feed ("Page 1 of 2", "Older Posts →", "See all"): the menu reader would take it for a page.
    '.pagination', '.gh-more', '.load-more', '.gh-loadmore',
    // Koenig media players draw buttons and times ("Play audio", "0:00", "1×"); the toggle card draws an icon button.
    '.kg-video-overlay', '.kg-video-player-container', '.kg-audio-player', '.kg-audio-thumbnail', '.kg-toggle-card-icon',
    '.gh-powered-by',
].join(', ');

/** A Ghost picture's resized copy (`/content/images/size/w600/format/webp/…`) → the uploaded original. */
const RESIZED = /\/content\/images\/(?:size\/w\d+(?:h\d+)?\/)?(?:format\/[a-z0-9]+\/)?(?=\d{4}\/)/i;

function fullSizeImage(src: string): string | null {
    try {
        const u = new URL(src);
        if (!RESIZED.test(u.pathname)) return null;
        const path = u.pathname.replace(RESIZED, '/content/images/');
        return path === u.pathname ? null : `${u.origin}${path}${u.search}`;
    } catch { return null; }
}

/** A Koenig card that only links somewhere: one link carrying its own title, nothing else. */
function asLink($: cheerio.CheerioAPI, card: cheerio.Cheerio<any>, href: string | undefined, title: string): void {
    const t = title.replace(/\s+/g, ' ').trim();
    if (!href || !t) { card.remove(); return; }
    const p = $('<p></p>');
    p.append($('<a></a>').attr('href', href).text(t));
    card.replaceWith(p);
}

function prepare($: cheerio.CheerioAPI): void {
    // A sentence that only exists to send people to Ghost's Portal ("Become a member to get…") goes
    // whole, before its link does — else half a sentence is left behind.
    $('p, li').filter((_, el) => /href=["']#\/portal/.test($(el).html() ?? '')).remove();
    $(FURNITURE).remove();
    // A logo drawn as the site's name in words is a link home, not a menu page called "Brightwater Bookkeeping".
    $('.gh-head-logo, .gh-navigation-logo').filter((_, el) => $(el).find('img').length === 0).remove();

    // A bookmark card is a preview of SOMEONE ELSE's page (its title, description, publisher, icon and
    // thumbnail are theirs): kept as the link the owner chose, under the page's title.
    $('.kg-bookmark-card').each((_, el) => {
        const $c = $(el);
        asLink($, $c, $c.find('a.kg-bookmark-container').attr('href'), $c.find('.kg-bookmark-title').first().text());
    });
    // A file card: the download link, under the title the owner gave it (not the file name and size).
    $('.kg-file-card').each((_, el) => {
        const $c = $(el);
        const title = $c.find('.kg-file-card-title').first().text() || $c.find('.kg-file-card-filename').first().text();
        asLink($, $c, $c.find('a.kg-file-card-container').attr('href'), title);
    });

    // The theme draws the home page's own heading, line and cover picture ABOVE <main> (Casper's
    // .site-header-content, Source's .gh-header), so the reader — which starts at <main> — never saw
    // them. They go to the top of <main>. Source's highlight/magazine headers are featured posts, also fine.
    const main = $('main').first();
    if (main.length) {
        const hero = $('.site-header-content, .gh-header').filter((_, el) => $(el).closest('main').length === 0 && $(el).closest('header#gh-head, header#gh-navigation').length === 0).first();
        if (hero.length) main.prepend(hero);
    }

    // A post or page's own title area is a <header> inside the article. The logo reader looks at every
    // header picture, so a feature image there was taken for the logo: it is a plain block here.
    $('main header, article header').each((_, el) => { (el as { name: string }).name = 'div'; });
}

export const adapter: BuilderAdapter = {
    key: 'ghost',
    label: 'Ghost',
    detect: (html, gen) => gen.startsWith('ghost') || /ghost-(?:portal|sdk)|\/ghost\/api\/|--ghost-accent-color|data-ghost-search|cdn\.jsdelivr\.net\/ghost\//.test(html),
    prepare,
    // Ghost's lines that are not the owner's words: reading times and Portal messages.
    noise: /^(?:[—–-]\s*)?\d+\s+min(?:ute)?s?\s+read$|^(?:subscribe(?: now)?|sign up(?: now)?|become a member|already have an account\?.*|email sent!.*|check your inbox.*|you've successfully subscribed.*|great! .*|success! .*|featured|paid-members only|members only)$/i,
    fullSizeImage,
};
