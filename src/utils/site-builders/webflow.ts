// src/utils/site-builders/webflow.ts — Website import adapter for Webflow.
// Findings, what is covered and what is not: docs/site-import-platforms/webflow.md
// Tests: tests/site-platform-webflow.test.ts (fixtures in tests/fixtures/site-platforms/webflow/).
//
// Webflow publishes plain server-rendered HTML: every word, CMS list item and picture is in the page.
// Its own furniture is named with `w-` classes, which is what this adapter tidies:
//   · the menu is div.w-nav[role=banner] (no <header>), its logo a.w-nav-brand, drop-downs
//     .w-dropdown > .w-dropdown-toggle + nav.w-dropdown-list (a <nav> inside the <nav>);
//   · CMS lists leave "No items found." (.w-dyn-empty) and hidden-by-condition copies
//     (.w-condition-invisible, .w-dyn-bind-empty) in the HTML; forms leave their thank-you and
//     error messages (.w-form-done/.w-form-fail) beside the <form>;
//   · videos are embedly iframes with the YouTube/Vimeo address encoded in `src=`; maps are a
//     JavaScript widget (.w-widget-map, data-widget-latlng); lightboxes keep the full picture in a
//     JSON script; responsive copies are named <file>-p-500.jpg and so on.
// Interactions (IX2) only fade content in (inline opacity:0): the words are in the HTML, nothing to do.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** Webflow's picture hosts (current CDN, the older ones, and the CMS's own). */
const WF_HOST = /(^|\.)(website-files\.com|webflow\.com|webflow\.io)$|^uploads-ssl\.webflow\.com$|^assets(-global)?\.website-files\.com$/;

/** "<id>_name-p-800.jpg" → "<id>_name.jpg" — Webflow's responsive copies keep the original's extension. */
function fullSize(src: string): string | null {
    try {
        const u = new URL(src);
        if (!WF_HOST.test(u.hostname)) return null;
        const path = u.pathname.replace(/-p-\d{3,4}(\.[a-z0-9]{3,5})$/i, '$1');
        if (path === u.pathname) return null;
        u.pathname = path;
        return u.toString();
    } catch { return null; }
}

/** A footer drawn as a div: Webflow sites rarely use <footer>; class names are the designer's. */
const FOOTER_CLASS = /^(footer|site-footer|footer[-_](component|section|wrapper|wrap|container|main))$/i;

function prepare($: cheerio.CheerioAPI): void {
    // Hidden on the live site: a CMS condition, an empty bound field, the empty-list message, the
    // form's after-sending messages, the "Made in Webflow" badge, the phone menu's empty overlay.
    $('.w-condition-invisible, .w-dyn-bind-empty, .w-dyn-empty, .w-form-done, .w-form-fail, .w-webflow-badge, .w-nav-overlay, .w-nav-button').remove();
    // Webflow's old "hide on desktop" copies are the phone layout's duplicates of desktop words.
    $('.w-hidden-main').remove();

    // The logo: the menu's brand link. The menu is a div, not <header>, so say which picture it is.
    $('.w-nav').each((_, nav) => {
        const $n = $(nav);
        if (!$n.attr('id')) $n.attr('id', 'wf-header');
    });
    $('.w-nav-brand img').first().each((_, img) => { $(img).addClass('logo'); });

    // Drop-downs: the list is a <nav> inside the menu's <nav>, so the menu reader can't see which
    // drop-down a link sits in. Rewrite as <details><summary>label</summary>links</details>.
    $('.w-dropdown').each((_, dd) => {
        const $dd = $(dd);
        // The toggle's own words, piece by piece (a designer's toggle can hold a phone label and an icon
        // in separate boxes; .text() would run them together as "ProductBrowse").
        const pieces: string[] = [];
        $dd.children('.w-dropdown-toggle').first().find('*').addBack().contents().each((_, n) => {
            if (n.type !== 'text') return;
            const t = $(n).text().replace(/\s+/g, ' ').trim();
            if (t && !pieces.includes(t)) pieces.push(t);
        });
        const label = pieces.join(' ');
        const $list = $dd.children('.w-dropdown-list').first();
        if (!label || !$list.length) return;
        const links = $list.find('a[href]').toArray().map((a) => $.html(a)).join('');
        $dd.replaceWith(`<details class="w-dropdown"><summary>${$('<i>').text(label).html()}</summary>${links}</details>`);
    });

    // Tabs: each pane's label sits apart in a tab bar of "#" links. Put the label above its pane as a
    // heading (their own words) and drop the bar.
    $('.w-tabs').each((_, tabs) => {
        const $t = $(tabs);
        $t.find('.w-tab-link').each((_, link) => {
            const key = $(link).attr('data-w-tab');
            const label = $(link).text().replace(/\s+/g, ' ').trim();
            if (!key || !label) return;
            const pane = $t.find('.w-tab-pane').filter((_, p) => $(p).attr('data-w-tab') === key).first();
            if (pane.length) pane.prepend(`<h3>${$('<i>').text(label).html()}</h3>`);
        });
        $t.find('.w-tab-menu').remove();
    });

    // Videos: Webflow's video element is an embedly iframe — the real player address is in `src=`.
    $('iframe.embedly-embed, iframe[src*="embedly.com"]').each((_, f) => {
        const raw = $(f).attr('src') ?? '';
        try {
            const inner = new URL(raw, 'https://cdn.embedly.com').searchParams.get('src');
            if (inner && /^https:\/\/(www\.)?(youtube(-nocookie)?\.com|player\.vimeo\.com)\//i.test(inner)) $(f).attr('src', inner);
        } catch { /* leave it */ }
    });

    // Maps: a JavaScript widget with only a latitude/longitude. Shown as a link to the place on
    // Google Maps (the shared reader turns a maps embed into "See us on the map").
    $('.w-widget-map').each((_, m) => {
        const ll = ($(m).attr('data-widget-latlng') ?? '').match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
        if (!ll) { $(m).remove(); return; }
        $(m).replaceWith(`<iframe src="https://www.google.com/maps/embed?q=${ll[1]},${ll[2]}"></iframe>`);
    });

    // Lightboxes: the thumbnail is a resized copy; the full picture is in the lightbox's JSON.
    $('.w-lightbox').each((_, lb) => {
        const $lb = $(lb);
        try {
            const data = JSON.parse($lb.find('script.w-json').first().text() || '{}') as { items?: Array<{ url?: unknown; type?: unknown }> };
            const url = data.items?.find((i) => typeof i.url === 'string' && (i.type ?? 'image') === 'image')?.url as string | undefined;
            const img = $lb.find('img').first();
            if (url && /^https:\/\//.test(url) && img.length) { img.attr('src', url); img.removeAttr('srcset'); }
        } catch { /* leave the thumbnail */ }
    });

    // The site's footer when it is a div (a <footer> is already left out): links, copyright, repeat logo.
    // Marked as the page's footer, not removed, so their email, phone and social links are still read
    // from it first (the shared reader drops [role=contentinfo] only after that).
    $('body div, body section').filter((_, el) => {
        const classes = ($(el).attr('class') ?? '').split(/\s+/);
        return classes.some((c) => FOOTER_CLASS.test(c)) && $(el).find('h1').length === 0 && $(el).closest('main, article').length === 0;
    }).attr('role', 'contentinfo');
}

export const adapter: BuilderAdapter = {
    key: 'webflow',
    label: 'Webflow',
    detect: (html, gen) => gen.includes('webflow') || /webflow\.(js|css)|data-wf-page|data-wf-site|\.webflow\.[\w.]*\.(css|js)\b/.test(html),
    prepare,
    noise: /^(made in webflow|no items found\.?|thank you! your submission has been received!?|oops! something went wrong while submitting the form\.?)$/i,
    fullSizeImage: fullSize,
    rendersWithJs: false,
};
