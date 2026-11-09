// src/utils/site-builders/joomla.ts — Website import adapter for Joomla.
// Findings, what is covered and what is not: docs/site-import-platforms/joomla.md
// Tests: tests/site-platform-joomla.test.ts (fixtures in tests/fixtures/site-platforms/joomla/).
//
// Joomla pages are server-rendered. Two things make them read badly without help:
//  1. <main> wraps only the component (the article or blog); the template's module positions —
//     Cassiopeia's banner / top-a / bottom-a, Helix's sp-section-*, sp-bottom — sit outside it,
//     and that is where most small sites put their hero and selling points. So when the owner's
//     own modules sit outside <main>, the page is read from <body> instead (header, footer and
//     menus still go), once Joomla's furniture modules (login, search, latest articles…) are out.
//  2. Joomla adds its own lines to articles ("Written by", "Hits", tags, previous/next) and
//     hides e-mail addresses behind a script; both are tidied here.
import type * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { BuilderAdapter } from './types';
import { tokenColour } from '../site-import-theme';

/** Core and template modules that are site furniture, never the owner's page content. */
const FURNITURE = [
    // core modules (Joomla 3 class names alongside 4/5)
    '.mod-breadcrumbs', '.mod-breadcrumbs__wrapper', 'ul.breadcrumb', 'ol.breadcrumb', '.uk-breadcrumb',
    '.mod-login', '#login-form', '.login-greeting', '.mod-finder', '.mod-search', '.finder', 'div.search',
    '.mod-articleslatest', '.latestnews', '.mod-articlespopular', '.mostread', '.mod-articlesarchive', '.archive-module',
    '.mod-tagspopular', '.tagspopular', '.mod-relateditems', '.relateditems', '.mod-syndicate', '.syndicate-module',
    '.mod-languages', '.mod-whosonline', '.mod-stats',
    // article furniture: author/date/hits, print/email icons, tags, previous/next, page counters
    '.article-info', '.article-details', '.article-ratings', '.article-social-share', '.article-author-information',
    '.uk-article-meta', '.com-content-article__info', '.item-page .icons', '.blog-item .icons', 'ul.tags', '.item-page .tags', '.pagenavigation', 'ul.pager', '.pagenav',
    '.com-content-category-blog__navigation', '.com-content-article__pagination', '.pagination .counter', '.com-content-category-blog__counter',
    '#system-message-container', '.visually-hidden', '.element-invisible', '.sr-only',
    // template furniture: to-top links, pre-loaders, off-canvas menus, the top bar's contact strip
    '#back-top', '.back-to-top-link', '.sp-scroll-up', '[uk-totop]', '.sp-pre-loader',
    '.offcanvas-menu', '.offcanvas-overlay', '[uk-offcanvas]',
].join(', ');
/**
 * A template's contact strip and social icons (Helix's top bar): not page content, but the import
 * reads the phone number and social profiles from them — so they move into a footer, which is
 * read for those and then dropped with the rest of the footer.
 */
const CONTACT_STRIP = '.sp-contact-info, .social-icons';

/** A module's chrome (Cassiopeia card, Joomla 3 moduletable/well, Helix sp-module, UIkit panel). */
const MODULE_WRAP = '.card, .moduletable, [class*="moduletable"], .sp-module, .well, .module, .uk-card, .uk-panel';
const MODULE_TITLE = 'h1, h2, h3, h4, .card-header, .card-title, .sp-module-title, .module-title, .page-header, .uk-card-title';
/** The owner's own modules (custom HTML) — the sign that a page's content goes beyond <main>. */
const OWN_MODULE = '.mod-custom, .custom, .moduletable, .site-grid .card, .sp-module, .sppb-section';

const text = ($: cheerio.CheerioAPI, el: AnyNode | cheerio.Cheerio<AnyNode>) => ($(el as AnyNode).text() || '').replace(/\s+/g, ' ').trim();

function decodeEntities(s: string): string {
    return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}
const fromBase64 = (s: string | undefined) => { try { return Buffer.from(s ?? '', 'base64').toString('utf8'); } catch { return ''; } };
const looksLikeEmail = (s: string) => /^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i.test(s);

/** Joomla hides e-mail addresses behind a script; put back the plain link a visitor sees. */
function uncloakEmails($: cheerio.CheerioAPI): void {
    // Joomla 4/5: <joomla-hidden-mail first="base64(name)" last="base64(domain)" text="base64(link words)">
    $('joomla-hidden-mail').each((_, el) => {
        const $el = $(el);
        const addr = `${fromBase64($el.attr('first'))}@${fromBase64($el.attr('last'))}`;
        if (!looksLikeEmail(addr)) { $el.remove(); return; }
        const words = decodeEntities(fromBase64($el.attr('text')).replace(/<[^>]*>/g, '')).trim() || addr;
        const $out = $el.attr('is-link') === '0' ? $('<span></span>').text(words) : $('<a></a>').attr('href', `mailto:${addr}`).text(words);
        $el.replaceWith($out);
    });
    // Joomla 3: <span id="cloakXXXX">…protected…</span><script>var addyXXXX = 'name' + '&#64;'; addyXXXX = addyXXXX + 'domain' + '&#46;' + 'tld'; …</script>
    $('span[id^="cloak"]').each((_, el) => {
        const $el = $(el);
        const id = ($el.attr('id') ?? '').slice(5);
        if (!/^\w+$/.test(id)) return;
        const script = $el.nextAll('script').first();
        const js = script.html() ?? '';
        const lits = (expr: string | undefined) => (expr ?? '').match(/'((?:[^'\\]|\\.)*)'/g)?.map((q) => q.slice(1, -1)).join('') ?? '';
        // A run of quoted pieces joined by "+" (a piece may hold "&#64;", so never split on ";").
        const EXPR = String.raw`((?:\s*\+?\s*'(?:[^'\\]|\\.)*')+)`;
        const first = js.match(new RegExp(String.raw`var addy${id}\s*=` + EXPR))?.[1];
        const rest = js.match(new RegExp(String.raw`addy${id}\s*=\s*addy${id}\s*` + EXPR))?.[1];
        const addr = decodeEntities(lits(first) + lits(rest));
        if (!looksLikeEmail(addr)) return;
        const shown = decodeEntities(lits(js.match(new RegExp(String.raw`var addy_text${id}\s*=` + EXPR))?.[1])).replace(/<[^>]*>/g, '').trim();
        $el.replaceWith($('<a></a>').attr('href', `mailto:${addr}`).text(shown || addr));
        script.remove();
    });
}

/** The site's root path ("/" or "/sub/"): Joomla's own script options, else the part before index.php. */
function siteRoot($: cheerio.CheerioAPI, url: URL | null): string {
    try {
        const opts = JSON.parse($('script.joomla-script-options').first().html() ?? '{}') as { 'system.paths'?: { root?: string } };
        const r = opts['system.paths']?.root;
        if (typeof r === 'string' && /^(\/[\w.~-]+)*$/.test(r)) return `${r}/`;
    } catch { /* not there */ }
    const p = url?.pathname ?? '/';
    const at = p.indexOf('/index.php');
    return at >= 0 ? p.slice(0, at + 1) : '/';
}

/**
 * Pictures put in with Joomla's editor keep a relative src ("images/x.jpg"); on a page under
 * /index.php/about it would read as /index.php/images/x.jpg. Joomla keeps every picture under the
 * site root's images/ (and media/), so anchor them there. The media field's "#joomlaImage://…" note goes too.
 */
function fixPicturePaths($: cheerio.CheerioAPI, url: URL | null): void {
    const root = siteRoot($, url);
    const fix = (v: string) => v.trim().replace(/#joomlaImage:\/\/[^\s"')]*/g, '').replace(/^(?:\.\/)?((?:images|media)\/)/, `${root}$1`);
    $('img, source, [style*="url("], [data-src]').each((_, el) => {
        const $el = $(el);
        for (const attr of ['src', 'data-src']) { const v = $el.attr(attr); if (v) $el.attr(attr, fix(v)); }
        for (const attr of ['srcset', 'data-srcset']) {
            const v = $el.attr(attr);
            if (v) $el.attr(attr, v.split(',').map((part) => { const [u, ...size] = part.trim().split(/\s+/); return [fix(u), ...size].join(' '); }).join(', '));
        }
        const style = $el.attr('style');
        if (style && /url\(/.test(style)) $el.attr('style', style.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_, q, u) => `url(${q}${fix(u)}${q})`));
    });
}

/** A furniture module goes with its chrome (its "Latest Articles" title) when the chrome holds nothing else. */
function removeWithChrome($: cheerio.CheerioAPI, el: Element): void {
    const $el = $(el);
    const wrap = $el.parents(MODULE_WRAP).first();
    if (wrap.length) {
        const rest = text($, wrap).replace(text($, $el), '').replace(text($, wrap.find(MODULE_TITLE).first()), '').trim();
        if (!rest) { wrap.remove(); return; }
    }
    $el.remove();
}

export const adapter: BuilderAdapter = {
    key: 'joomla',
    // Cassiopeia's colours: its links and buttons (--cassiopeia-color-link) and its header band (--cassiopeia-color-primary) (main session, 2026-11-09).
    look: ({ html, css }) => {
        const all = `${[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')}\n${css}`;
        const v = (n: string) => all.match(new RegExp(`--${n}\\s*:\\s*([^;}]+)`, 'i'))?.[1]?.trim() ?? null;
        return { primaryColor: tokenColour(v('cassiopeia-color-link') ?? '') ?? tokenColour(v('cassiopeia-color-primary') ?? ''), headerColor: tokenColour(v('cassiopeia-color-primary') ?? '') };
    },
    label: 'Joomla',
    detect: (html, gen) => gen.includes('joomla')
        || /\/media\/jui\/|\/components\/com_|\/media\/system\/js\/|\/media\/templates\/site\/|class="joomla-script-options|<joomla-[a-z-]+|<body[^>]*\bcom_[a-z]+\b[^>]*\bview-/.test(html),
    prepare($, url) {
        uncloakEmails($);
        fixPicturePaths($, url);

        // Menus: the logo's link is "Home", not a menu entry called "Dale End Bakery" / "Back to home".
        $('a.brand-logo, #sp-logo a, .logo a, a.uk-logo, a.navbar-brand').removeAttr('href');
        // Helix and UIkit drop-downs wrap the sub-menu list in a box: put the list straight in its
        // item, so the drop-down's heading is read as its label.
        $('nav li > div, header li > div').filter((_, d) => /dropdown/i.test($(d).attr('class') ?? '')).each((_, d) => {
            const $d = $(d);
            const lists = $d.find('ul').filter((__, u) => $(u).parentsUntil($d, 'ul').length === 0);
            if (lists.length) $d.replaceWith(lists);
        });

        const strip = $(CONTACT_STRIP).filter((_, el) => $(el).closest('footer').length === 0);
        if (strip.length) $('body').append($('<footer></footer>').append(strip));
        // Joomla's furniture, with its module chrome.
        $(FURNITURE).toArray().forEach((el) => { if (el.parent) removeWithChrome($, el as Element); });

        // "Read more: Our story" / "Read more …" → "Read more" (Joomla's words, not the owner's).
        $('.readmore a, a.readmore, p.readmore a').each((_, a) => {
            const $a = $(a);
            if (/^read more\b/i.test(text($, $a))) { $a.find('span').remove(); $a.text('Read more'); }
        });

        // YOOtheme draws section backgrounds lazily (data-src + uk-img on a box): make it a CSS background.
        $('[uk-img][data-src]').not('img').each((_, el) => {
            const $el = $(el);
            const src = $el.attr('data-src');
            if (src && !/url\(/.test($el.attr('style') ?? '')) $el.attr('style', `${$el.attr('style') ?? ''};background-image:url('${src}')`.replace(/^;/, ''));
        });

        // The owner's modules outside <main>: read the whole page, not just the component.
        const outside = $(OWN_MODULE).filter((_, el) => $(el).closest('main, header, footer, nav').length === 0 && !!text($, el));
        if (outside.length) $('main').each((_, m) => { (m as Element).name = 'div'; });
    },
    // Noise applies to buttons too (site-extract.ts), so a bare "Read more" — the button prepare makes — is not noise.
    noise: /^(details|written by:? .+|created by:? .+|category: .+|parent category: .+|published: .+|created: .+|last updated: .+|hits: ?\d+|register to read more.*|read more(?: …|\s*\.\.\.)|read more: .+|you are here:?.*|page \d+ of \d+|this email address is being protected from spambots\..*|joomla! is free software.*)$/i,
    fullSizeImage(src) {
        // The media field's "#joomlaImage://local-images/…?width=…" note is not part of the address.
        const at = src.indexOf('#joomlaImage');
        return at >= 0 ? src.slice(0, at) : null;
    },
};
