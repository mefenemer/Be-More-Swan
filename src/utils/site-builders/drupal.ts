// src/utils/site-builders/drupal.ts — Website import adapter for Drupal (8–11: Olivero, Bartik, Claro-era
// custom themes; Drupal 7 where its markup differs).
// Findings, what is covered and what is not: docs/site-import-platforms/drupal.md
// Tests: tests/site-platform-drupal.test.ts (fixtures in tests/fixtures/site-platforms/drupal/).
//
// Drupal draws its pages on the server, so the words are all in the HTML. What gets in the way is Drupal's
// own furniture around them: status messages, admin tabs, breadcrumbs and pagers (each a <nav>, so they
// used to land in the menu), "Submitted by … on …", comment links and comments, visually hidden labels
// ("Hero image", "Main navigation"), sidebars. Drupal 7 themes (Bartik, Zen) use <div id="header">,
// <div id="main-menu"> and <div id="content"> where newer themes use <header>, <nav> and <main>.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Drupal's own furniture: never the owner's words. Removed before anything is read. */
const FURNITURE = [
    // Admin toolbar, contextual edit links, local task tabs (View / Edit), action links.
    '#toolbar-administration', '#toolbar-bar', '.toolbar-tray', '.contextual', '[data-contextual-id]',
    '.block-local-tasks-block', '.tabs-wrapper', 'ul.tabs.primary', 'ul.tabs.secondary', 'ul.tabs--primary', 'ul.tabs--secondary', '.action-links',
    // Status messages ("Your message has been sent").
    '[data-drupal-messages]', '[data-drupal-messages-fallback]', '.messages-list', '.messages', '#messages',
    // Breadcrumbs, pagers, RSS icons.
    '.region--breadcrumb', '.region-breadcrumb', '#breadcrumb', '.block-system-breadcrumb-block', 'nav.breadcrumb', 'div.breadcrumb',
    'nav.pager', '.pager', '.feed-icon', '.block-node-syndicate-block',
    // Node meta and links: "Submitted by admin on …", "Log in to post comments", "152 views"; comments are visitors' words.
    '.node__meta', '.node__submitted', '.submitted', '.comment-forbidden', '.comment_forbidden', '.comment-add', '.statistics-counter',
    'section.comments', '#comments', '.comment-wrapper', '.comment-section',
    // Taxonomy tags under a page ("Tags: Stoneware").
    '.field--name-field-tags', '.field-name-field-tags',
    // Visitor account and search blocks; "Powered by Drupal".
    '.menu--account', '[id$="-account-menu"]', '#secondary-menu', '.block-user-login-block', '#block-user-login', '.block-search', '.search-block-form',
    '.block-system-powered-by-block', '#block-system-powered-by',
    // Words only screen readers hear, and RDF metadata spans (Drupal 7).
    '.visually-hidden', '.element-invisible', '.element-hidden', '.rdf-meta', '#skip-link', '.skip-link',
].join(', ');

/** Sidebars: blocks beside the page (a contact block, recent news), not the page itself. */
const SIDEBARS = '.region--sidebar, .region-sidebar-first, .region-sidebar-second, .layout-sidebar-first, .layout-sidebar-second, #sidebar-first, #sidebar-second';

/** Drupal 7's footer, drawn as plain <div>s. */
const D7_FOOTER = '#footer, #footer-wrapper, .region-footer';

/** Drupal 7's main menu, drawn as plain <div>s (newer themes use <nav>). */
const D7_MENU = '#main-menu, #navigation, .region-navigation, #block-system-main-menu, #block-superfish-1, #block-menu-block-1';

/** Marks the page's content area on Drupal 7 pages that have no <main>. */
const CONTENT_MARK = 'data-drupal-content';

/** <nav> → <div>, keeping what is inside: a sidebar's menu is not the site's menu. */
function unNav($: cheerio.CheerioAPI, scope: cheerio.Cheerio<any>): void {
    scope.find('nav, [role="navigation"]').each((_, el) => {
        const $el = $(el);
        $el.removeAttr('role');
        if ((el as { name?: string }).name === 'nav') $el.replaceWith($('<div></div>').append($el.contents()));
    });
}

/** A resized Drupal picture (image style derivative) → the original the owner uploaded, or null. */
export function drupalFullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    let path = u.pathname;
    // Drupal 8+ and 7: /sites/<site>/files/styles/<style>/public/<file>, /system/files/styles/<style>/private/<file>,
    // s3fs: /s3/files/styles/<style>/s3/<file>.
    const styled = path.match(/^(.*?\/files)\/styles\/[^/]+\/(public|private|s3)\/(.+)$/);
    // Drupal 6's ImageCache: /sites/<site>/files/imagecache/<preset>/<file>.
    const cached = path.match(/^(.*?\/files)\/imagecache\/[^/]+\/(.+)$/);
    if (styled) path = styled[2] === 'private' ? `/system/files/${styled[3]}` : `${styled[1]}/${styled[3]}`;
    else if (cached) path = `${cached[1]}/${cached[2]}`;
    else return null;
    // A style that converts the format appends the new extension: photo.jpg.webp is a copy of photo.jpg.
    path = path.replace(/(\.(?:jpe?g|png|gif|tiff?|bmp|webp|avif))\.(?:webp|avif|jpe?g|png)$/i, '$1');
    // ?itok= signs the derivative only; the original needs no query.
    return `${u.origin}${path}`;
}

export const adapter: BuilderAdapter = {
    key: 'drupal',
    label: 'Drupal',
    detect: (html, gen) => gen.includes('drupal') ||
        /drupal-settings-json|data-drupal-(?:selector|link-system-path|messages)|Drupal\.settings|\/core\/misc\/drupal(?:\.init)?\.js|\/misc\/drupal\.js|\/sites\/[\w.-]+\/files\/(?:styles|css|js|inline-images)\/|\/sites\/default\/files\//.test(html),
    prepare($) {
        $(FURNITURE).remove();
        // Sidebars and Drupal 7 footers: read for their phone, email and social links, then dropped with the
        // site's footer (role contentinfo is removed after contact details are read). Their menus aren't the site's.
        const aside = $(SIDEBARS);
        unNav($, aside);
        aside.attr('role', 'contentinfo');
        const d7Footer = $(D7_FOOTER).filter((_, el) => $(el).closest('main, article, [role="main"]').length === 0);
        unNav($, d7Footer);
        d7Footer.attr('role', 'contentinfo');
        // Drupal 7: the header is a <div id="header"> and its menu a <div id="main-menu">.
        if (!$('header, [role="banner"]').length) $('#header, .region-header').first().attr('role', 'banner');
        if (!$('nav, [role="navigation"]').length) $(D7_MENU).first().attr('role', 'navigation');
        // Drupal 7: no <main>. The content column is the parent of the "Skip to main content" target
        // (<a id="main-content">), else #content / .region-content.
        if (!$('main, [role="main"]').length) {
            const anchorParent = $('a#main-content').first().parent();
            const pick = [anchorParent, $('#content').first(), $('.region-content').first()]
                .find((c) => c.length && !c.is('body, html') && c.text().trim().length > 0);
            pick?.attr(CONTENT_MARK, '');
        }
    },
    contentRoot: `[${CONTENT_MARK}]`,
    // Lines Drupal adds that slip past the furniture list on custom themes.
    noise: /^(submitted by .+ on .+|log in (or register )?to post comments|add new comment|\d[\d,]* (reads?|views?|comments?)|you are here|main (navigation|menu)|primary tabs|secondary tabs|status message|error message|warning message|breadcrumb|pagination|subscribe to .+ rss|user login|powered by drupal|\(active tab\))$/i,
    fullSizeImage: drupalFullSize,
    rendersWithJs: false,
};
