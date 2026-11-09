// src/utils/site-builders/squarespace.ts — Website import adapter for Squarespace (7.0 and 7.1).
// Findings, what is covered and what is not: docs/site-import-platforms/squarespace.md
// Tests: tests/site-platform-squarespace.test.ts (fixtures in tests/fixtures/site-platforms/squarespace/).
//
// Squarespace pages are drawn on Squarespace's servers: the words, menu and pictures are in the HTML.
// What isn't: form blocks (fields in a JSON script, drawn by JavaScript), map blocks (a JSON
// attribute), video blocks (the player's HTML in an attribute). prepare() turns those into ordinary
// elements, splits the blocks Squarespace draws as one list item or caption (list sections, accordions,
// image cards) so each heading, paragraph and button is read on its own, and removes the shop's
// controls, the cart, account links and the phone copy of the menu.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';
import { fontKeyFor, type ImportedLook } from '../site-import-theme';

/** Squarespace's own marks: the comment every page carries, its page context, its site assets and blocks. */
const MARKS = /<!--\s*This is Squarespace\.\s*-->|Static\.SQUARESPACE_CONTEXT|static1\.squarespace\.com\/static\/(?:versioned-site-css|sitecss|vta)\/|assets\.squarespace\.com\/universal\/|class=["'][^"']*\bsqs-(?:block|layout)\b/i;

/** Squarespace's picture hosts: any size of the original is one address with ?format=<n>w. */
const IMAGE_HOST = /^(?:images\.squarespace-cdn\.com|static\d*\.squarespace\.com)$/i;

/** Shop, cart and account furniture: controls, not the owner's words. Prices stay (the import lists them for Business Information). */
const SHOP_CONTROLS = [
    '.product-purchase-controls-wrapper', '.product-quantity-input-wrapper', '.product-quantity-input',
    '.sqs-add-to-cart-button-wrapper', '.sqs-add-to-cart-button', '.product-variants', '.product-add-ons',
    '.product-scarcity', '.product-mark', '.ProductItem-quantity-add-to-cart',
    '.sqs-custom-cart', '.Cart', '.header-actions-action--cart', '.sqs-cart-dropzone',
    '.user-accounts-link', '.customerAccountLoginDesktop', '.customerAccountLoginMobile',
].join(', ');

/** The phone copy of the menu (7.1 overlay, Brine family's mobile bar, older templates' #mobileNav). */
const MOBILE_COPIES = '.header-menu, .Mobile, #mobileNav, #mobileMenuLink, .header-menu-controls';

function readJson(raw: string | undefined): Record<string, unknown> | null {
    if (!raw) return null;
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The menu's drop-downs: the folder's title is not a page (7.1 folders have no address of their own). */
function tidyMenu($: cheerio.CheerioAPI): void {
    $(MOBILE_COPIES).remove();
    $('a.header-nav-folder-title, a.Header-nav-folder-title').each((_, el) => {
        $(el).replaceWith(`<span class="header-nav-folder-title">${esc($(el).text().trim())}</span>`);
    });
    // 7.0 drop-down boxes, named so the shared menu reader sees the group (site-extract.ts SUBMENU_CLASS).
    $('.Header-nav-folder, .folder > .subnav').addClass('header-nav-folder-content');
}

/** Blocks Squarespace draws as one <li> or one <figcaption>, split so each part is read on its own. */
function splitBlocks($: cheerio.CheerioAPI): void {
    // 7.1 list sections (cards, team, services): title, description and button in one <li>.
    $('.user-items-list li, li.list-item').each((_, el) => { (el as { name: string }).name = 'div'; });
    // Accordion blocks: the question is a <button> inside the heading; the answer sits beside it.
    $('.accordion-icon-container').remove();
    $('.accordion-item__click-target').each((_, el) => { $(el).replaceWith(`<span>${esc($(el).text().trim())}</span>`); });
    $('li.accordion-item').each((_, el) => { (el as { name: string }).name = 'div'; });
    // Image blocks laid out as card / poster / overlap: title, subtitle and button share a <figcaption>.
    $('.image-title').each((_, el) => { const t = $(el).text().trim(); if (t) $(el).replaceWith(`<h3>${esc(t)}</h3>`); });
    $('figcaption.image-card-wrapper').each((_, el) => { (el as { name: string }).name = 'div'; });
}

/** Form blocks: 7.1 keeps the fields in a JSON script and draws the form with JavaScript. */
function expandForms($: cheerio.CheerioAPI): void {
    $('script.sqs-form-block-context').each((_, el) => {
        const ctx = readJson($(el).text());
        const fields = Array.isArray(ctx?.formFields) ? ctx!.formFields as Array<Record<string, unknown>> : [];
        if (!fields.length) return;
        const parts: string[] = [];
        fields.forEach((f, i) => {
            const type = str(f.type).toLowerCase();
            const title = str(f.title);
            if (!title || type === 'hidden' || type === 'section') return;
            const id = `sqs-${esc(str(f.id) || `field-${i}`)}`;
            const ph = str(f.placeholder) ? ` placeholder="${esc(str(f.placeholder))}"` : '';
            const control = type === 'textarea' ? `<textarea id="${id}" name="${id}"${ph}></textarea>`
                : type === 'select' ? `<select id="${id}" name="${id}"></select>`
                : `<input id="${id}" name="${id}" type="${type === 'email' ? 'email' : type === 'phone' ? 'tel' : type === 'checkbox' ? 'checkbox' : 'text'}"${ph}>`;
            parts.push(`<label for="${id}">${esc(title)}</label>${control}`);
        });
        if (parts.length) $(el).after(`<form data-squarespace-form="${esc(str(ctx?.formId))}">${parts.join('')}</form>`);
    });
    // The button that opens a form in a pop-up: there is no pop-up on the new site.
    $('.form-block .lightbox-handle-wrapper, .sqs-block-form .lightbox-handle-wrapper').remove();
}

/** A YouTube or Vimeo address → its player address, which the shared reader turns into a thumbnail and a button. */
function embedFor(url: string): string | null {
    const yt = url.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,20})/i)?.[1];
    if (yt) return `https://www.youtube.com/embed/${yt}`;
    const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d{4,12})/i)?.[1];
    return vimeo ? `https://player.vimeo.com/video/${vimeo}` : null;
}

/** Video blocks: the player's HTML is in data-html (drawn by JavaScript), the address in data-block-json. */
function expandVideos($: cheerio.CheerioAPI): void {
    $('.sqs-block-video, .video-block').each((_, block) => {
        const $b = $(block);
        if ($b.find('iframe').length) return;
        const json = readJson($b.attr('data-block-json'));
        const fromHtml = (() => {
            const raw = $b.find('[data-html]').first().attr('data-html') ?? str(json?.html);
            return raw ? (raw.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i)?.[1] ?? null) : null;
        })();
        const src = (fromHtml && embedFor(fromHtml)) ?? embedFor(str(json?.url));
        if (!src) return;
        const title = str(json?.title);
        $b.find('.sqs-block-content').first().append(`<iframe src="${esc(src)}"${title ? ` title="${esc(title)}"` : ''}></iframe>`);
    });
}

/** Map blocks: the pin is a JSON attribute (data-context, or data-block-json on older blocks). */
function expandMaps($: cheerio.CheerioAPI): void {
    $('.sqs-block-map, .map-block').each((_, block) => {
        const $b = $(block);
        if ($b.find('iframe').length) return;
        const json = readJson($b.find('[data-context]').first().attr('data-context')) ?? readJson($b.attr('data-block-json'));
        const loc = (json?.location ?? null) as Record<string, unknown> | null;
        if (!loc) return;
        const lines = [str(loc.addressLine1), str(loc.addressLine2)].filter(Boolean);
        const lat = Number(loc.markerLat ?? loc.mapLat), lng = Number(loc.markerLng ?? loc.mapLng);
        const q = lines.length ? [str(loc.addressTitle), ...lines, str(loc.addressCountry)].filter(Boolean).join(', ')
            : Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? `${lat},${lng}` : '';
        if (!q) return;
        const $c = $b.find('.sqs-block-content').first();
        // Their address, as their map shows it, so the import's contact details find it.
        if (lines.length) $c.append(`<address>${lines.map(esc).join(', ')}</address>`);
        $c.append(`<iframe src="https://maps.google.com/maps/embed?q=${encodeURIComponent(q)}" title="Map"></iframe>`);
    });
}

export const adapter: BuilderAdapter = {
    key: 'squarespace',
    label: 'Squarespace',
    detect: (html, gen) => gen.includes('squarespace') || MARKS.test(html),
    prepare($) {
        tidyMenu($);
        $(SHOP_CONTROLS).remove();
        splitBlocks($);
        expandForms($);
        expandVideos($);
        expandMaps($);
    },
    // Lines Squarespace adds itself: menu and shop labels, blog paging.
    noise: /^(back|open menu|close menu|quick view|sold out|sale|add to (cart|bag)|(de|in)crease quantity by 1|quantity:?|newer( posts?)?|older( posts?)?|load more|view fullsize|unavailable)$/i,
    fullSizeImage(src) {
        let u: URL;
        try { u = new URL(src); } catch { return null; }
        if (!IMAGE_HOST.test(u.hostname) || /\.(svg|gif)$/i.test(u.pathname)) return null;
        // One address per picture whatever size the page asked for (gallery thumbnails are the same picture).
        u.search = '';
        u.searchParams.set('format', '1500w');
        return u.toString();
    },
    rendersWithJs: false,
};

// ── The look (for site-import-theme.ts; not wired in yet — see the report's "Can be done") ─────────

/**
 * The site's own stylesheet: 7.1's versioned-site-css/…/site.css, 7.0's sitecss/…/site.css. The page
 * lists Squarespace's shared stylesheets first, so "the first four stylesheets" never reaches it.
 */
export function squarespaceSiteCssUrl(html: string, baseUrl: string): string | null {
    const href = html.match(/<link\b[^>]*href=["']([^"']*static\d*\.squarespace\.com\/static\/(?:versioned-site-css|sitecss)\/[^"']+)["']/i)?.[1];
    if (!href) return null;
    try { return new URL(href.replace(/&amp;/g, '&'), baseUrl).toString(); } catch { return null; }
}

/** "16,55.5%,47%" (Squarespace's --*-hsl triple) → "#b75a35". */
export function hslTripleToHex(triple: string): string | null {
    const m = triple.match(/^\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*$/);
    if (!m) return null;
    const h = Number(m[1]) / 360, s = Number(m[2]) / 100, l = Number(m[3]) / 100;
    const f = (n: number) => {
        const k = (n + h * 12) % 12;
        const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * 7.1's site styles: the palette is HSL triples on :root (--accent-hsl, --white-hsl = lightest,
 * --black-hsl = darkest) and the fonts sit behind --heading-font-font-family, which the shared reader
 * can't follow. Null for a 7.0 stylesheet (plain colours, which the shared reader already reads).
 */
export function readSquarespaceLook(css: string): Partial<ImportedLook> | null {
    const v = (name: string) => css.match(new RegExp(`--${name}\\s*:\\s*([^;}]+)`))?.[1]?.trim() ?? null;
    const accent = v('accent-hsl');
    if (!accent) return null;
    const font = (name: string) => v(`${name}-font-font-family`)?.split(',')[0].replace(/^['"]|['"]$/g, '').trim() || null;
    const headingFont = font('heading');
    return {
        primaryColor: hslTripleToHex(accent),
        textColor: hslTripleToHex(v('black-hsl') ?? ''),
        backgroundColor: hslTripleToHex(v('white-hsl') ?? ''),
        headingFont,
        font: fontKeyFor(headingFont, font('body')),
    };
}
