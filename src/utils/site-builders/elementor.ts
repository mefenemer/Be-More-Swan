// src/utils/site-builders/elementor.ts — Website import adapter for Elementor (the WordPress page builder).
// Findings, what is covered and what is not: docs/site-import-platforms/elementor.md
// Tests: tests/site-platform-elementor.test.ts (fixtures in tests/fixtures/site-platforms/elementor/).
//
// Elementor pages are server-rendered by WordPress (PHP): the words are in the HTML. What JavaScript
// adds afterwards is what this adapter puts back without running it — counters that start at "0",
// the YouTube player, slideshow and gallery pictures — and what it takes away is Elementor's own
// furniture: popups printed on every page, the copies of sections made for phones, carousel clones.
import type * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { BuilderAdapter } from './types';
import { fontKeyFor } from '../site-import-theme';
import type { FontKey } from '../site-definition';

/** WooCommerce's own pages (product, shop, basket, checkout): its adapter reads those better. */
const WOO_PAGE = /<body\b[^>]*class=["'][^"']*\b(?:single-product|woocommerce-shop|post-type-archive-product|tax-product_cat|woocommerce-cart|woocommerce-checkout)\b/i;

const MENU_WIDGETS = '.elementor-widget-nav-menu, .elementor-widget-n-menu, .elementor-widget-mega-menu, .elementor-widget-navigation-menu, .elementor-widget-hfe-nav-menu';

const attrUrl = (s: string | undefined) => (s && /^https?:\/\//i.test(s.trim()) ? s.trim() : null);

/** A JSON data-settings attribute, or {}. */
function settingsOf($el: cheerio.Cheerio<AnyNode>): Record<string, unknown> {
    try { const o = JSON.parse($el.attr('data-settings') ?? '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

function setBackground($el: cheerio.Cheerio<AnyNode>, url: string): void {
    if (/url\(/.test($el.attr('style') ?? '') || $el.attr('data-bg')) return;
    $el.attr('data-bg', url);
}

function prepare($: cheerio.CheerioAPI): void {
    // 1. Elementor's furniture: popups (printed hidden on every page), carousel clones and controls,
    //    the burger button. Sections hidden on desktop are the phone copies of a desktop section.
    $('[data-elementor-type="popup"], .elementor-location-popup, .elementor-popup-modal').remove();
    $('.elementor-hidden-desktop, .elementor-hidden-phone.elementor-hidden-tablet.elementor-hidden-desktop').remove();
    $('.swiper-slide-duplicate, .elementor-swiper-button, .swiper-pagination, .swiper-button-prev, .swiper-button-next, .elementor-menu-toggle, .elementor-share-buttons, .elementor-widget-share-buttons').remove();

    // 2. Lazy-loading plugins (WP Rocket, LiteSpeed, a3) keep the real address in data-lazy-*.
    $('img[data-lazy-src], img[data-lazy-srcset]').each((_, el) => {
        const $el = $(el);
        const src = attrUrl($el.attr('data-lazy-src'));
        if (src) $el.attr('src', src);
        const set = $el.attr('data-lazy-srcset');
        if (set) $el.attr('srcset', set);
    });
    $('iframe[data-lazy-src]').each((_, el) => { const u = attrUrl($(el).attr('data-lazy-src')); if (u) $(el).attr('src', u); });
    // WP Rocket swaps a YouTube iframe for a placeholder div until clicked.
    $('.rll-youtube-player[data-src]').each((_, el) => {
        const u = attrUrl($(el).attr('data-src'));
        if (u) $(el).replaceWith(`<iframe src="${u.replace(/"/g, '')}" title="${($(el).attr('data-alt') ?? '').replace(/"/g, '')}"></iframe>`);
    });

    // 3. Counters print "0" and count up to data-to-value with JavaScript.
    $('.elementor-counter-number[data-to-value]').each((_, el) => {
        const $el = $(el);
        const to = ($el.attr('data-to-value') ?? '').trim();
        if (!/^-?\d+(\.\d+)?$/.test(to)) return;
        const d = $el.attr('data-delimiter');
        const [whole, frac] = to.split('.');
        const shown = d ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, d) : whole;
        $el.text(frac ? `${shown}.${frac}` : shown);
    });
    // Glue prefix + number + suffix together ("1,200+"), and the title above it stays its own line.
    // Each part's own text as the owner typed it (a suffix " years" keeps its space), none of the gaps between.
    $('.elementor-counter-number-wrapper').each((_, el) => {
        const t = $(el).children().map((_, c) => $(c).text()).get().join('').replace(/\s+/g, ' ').trim();
        $(el).replaceWith(`<p>${t.replace(/</g, '&lt;')}</p>`);
    });

    // 4. Animated headline: only the first rotating word is on screen without JavaScript.
    $('.elementor-headline-dynamic-wrapper').each((_, el) => {
        const $el = $(el);
        const first = $el.find('.elementor-headline-text-active').first().text() || $el.find('.elementor-headline-dynamic-text').first().text();
        $el.text(first.trim());
    });

    // 5. A heading widget set to <div>/<span>/<p> is still drawn as a heading.
    $('div.elementor-heading-title, span.elementor-heading-title, p.elementor-heading-title').each((_, el) => {
        const $el = $(el);
        $el.replaceWith(`<h3>${$el.html() ?? ''}</h3>`);
    });

    // 6. Testimonials are quotes.
    $('.elementor-testimonial-content, .elementor-testimonial__text').each((_, el) => {
        const $el = $(el);
        $el.replaceWith(`<blockquote>${$el.html() ?? ''}</blockquote>`);
    });

    // 7. Video widget: the player is built by JavaScript from data-settings.
    $('.elementor-widget-video').each((_, el) => {
        const $el = $(el);
        if ($el.find('iframe, video').length) return;
        const s = settingsOf($el);
        const yt = String(s.youtube_url ?? '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{6,20})/)?.[1];
        const vimeo = String(s.vimeo_url ?? '').match(/vimeo\.com\/(?:video\/)?(\d{4,12})/)?.[1];
        const src = yt ? `https://www.youtube.com/embed/${yt}` : vimeo ? `https://player.vimeo.com/video/${vimeo}` : null;
        if (src) $el.find('.elementor-widget-container').first().append(`<iframe src="${src}"></iframe>`);
    });
    // Google Maps widget: maps.google.com/maps?q=…&output=embed → the /maps/embed form the import knows.
    $('.elementor-widget-google_maps iframe').each((_, el) => {
        try {
            const u = new URL(($(el).attr('src') ?? '').trim());
            const q = u.searchParams.get('q');
            if (q && /(^|\.)google\.[a-z.]+$/.test(u.hostname) && !u.pathname.startsWith('/maps/embed')) $(el).attr('src', `https://www.google.com/maps/embed?q=${encodeURIComponent(q)}`);
        } catch { /* leave it */ }
    });

    // 8. Pictures JavaScript draws: Pro gallery tiles (the link is the full-size picture), background
    //    slideshows, and section backgrounds set in the page's own <style> by element id.
    $('.e-gallery-image[data-thumbnail]').each((_, el) => {
        const $el = $(el);
        const href = attrUrl($el.closest('a').attr('href'));
        const full = href && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(href) ? href : attrUrl($el.attr('data-thumbnail'));
        if (!full) return;
        const alt = ($el.attr('aria-label') ?? '').replace(/"/g, '&quot;');
        $el.replaceWith(`<img src="${full.replace(/"/g, '')}" alt="${alt}">`);
    });
    $('[data-settings*="background_slideshow_gallery"]').each((_, el) => {
        const g = settingsOf($(el)).background_slideshow_gallery;
        const first = Array.isArray(g) ? attrUrl(String((g[0] as { url?: unknown })?.url ?? '')) : null;
        if (first) setBackground($(el), first);
    });
    const css = $('style').map((_, el) => $(el).text()).get().join('\n');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*background-image\s*:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)[^{}]*)\}/gi)) {
        const selector = m[1];
        if (/:hover|overlay|::?before|::?after/i.test(selector)) continue;
        const id = selector.match(/\.elementor-element-([0-9a-f]{7,8})\b/)?.[1];
        const url = attrUrl(m[3]);
        if (id && url) setBackground($(`.elementor-element-${id}`).first(), url);
    }

    // 9. Social icons: their profiles are read from the whole page before content is chosen; as
    //    content they would become "Instagram" buttons. role=contentinfo is removed with the footer.
    $('.elementor-widget-social-icons').attr('role', 'contentinfo');

    // 10. No theme header (Canvas template, free Elementor): the first top-level block holding a menu
    //     widget is the header, and a last block saying © is the footer.
    if (!$('header').length) {
        const doc = $('[data-elementor-type="wp-page"], [data-elementor-type="wp-post"]').first();
        const top = doc.children('.elementor-section, .e-con, .elementor-element').toArray();
        const head = top.slice(0, 2).find((el) => $(el).find(MENU_WIDGETS).length > 0);
        if (head) { const $h = $(head); $h.replaceWith(`<header>${$h.html() ?? ''}</header>`); }
        if (!$('footer').length) {
            const last = doc.children('.elementor-section, .e-con, .elementor-element').last();
            if (last.length && top.length > 2 && /©|copyright/i.test(last.text())) last.replaceWith(`<footer>${last.html() ?? ''}</footer>`);
        }
    }
}

export const adapter: BuilderAdapter = {
    key: 'elementor',
    label: 'Elementor',
    detect: (html, gen) => (gen.includes('elementor') || /elementor-(?:kit|section|element|widget)|\/plugins\/elementor\/|\/uploads\/elementor\//.test(html)) && !WOO_PAGE.test(html),
    prepare: ($) => prepare($),
    // Elementor's own lines: carousel and lightbox labels, screen-reader-only text.
    noise: /^((previous|next)( (slide|image|item))?|go to slide \d+|(toggle|close) (menu|navigation)|menu toggle|pause|play)$/i,
    fullSizeImage: elementorFullSize,
    rendersWithJs: false,
};

/**
 * A WordPress resized copy → the uploaded original: name-800x534.jpg → name.jpg. Jetpack's i0.wp.com
 * drops its resize query. Elementor's own crops (uploads/elementor/thumbs/name-<hash>.jpg) have no
 * way back to the original and are kept. null = no change.
 */
export function elementorFullSize(src: string): string | null {
    try {
        const u = new URL(src);
        if (/^i[0-3]\.wp\.com$/.test(u.hostname)) {
            let changed = false;
            for (const k of ['resize', 'fit', 'w', 'h', 'crop']) if (u.searchParams.has(k)) { u.searchParams.delete(k); changed = true; }
            return changed ? u.toString() : null;
        }
        if (!/\/wp-content\/uploads\//.test(u.pathname) || /\/uploads\/elementor\/thumbs\//.test(u.pathname)) return null;
        const m = u.pathname.match(/^(.*)-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp|gif|avif))$/i);
        if (!m) return null;
        u.pathname = `${m[1]}${m[2]}`;
        return u.toString();
    } catch { return null; }
}

// ── The look: the Elementor kit's global colours and fonts ─────────────────────────────────────
// Not yet called by the shared import (needs a hook in types.ts/site-import.ts — see the report).

/** Elementor's out-of-the-box kit: a site still showing these never chose them. */
const DEFAULT_COLOURS = new Set(['#6ec1e4', '#54595f', '#7a7a7a', '#61ce70']);
const DEFAULT_FONTS = new Set(['roboto', 'roboto slab']);

export interface ElementorKitLook {
    primaryColor: string | null;
    secondaryColor: string | null;
    textColor: string | null;
    accentColor: string | null;
    headingFont: string | null;
    bodyFont: string | null;
    font: FontKey | null;
    /** True when the kit was left at Elementor's defaults (no colour of theirs found). */
    defaults: boolean;
}

/** The kit's id from <body class="elementor-kit-6">. */
export function elementorKitId(html: string): string | null {
    return html.match(/<body\b[^>]*class=["'][^"']*\belementor-kit-(\d+)\b/i)?.[1] ?? null;
}

/** The kit's stylesheet (uploads/elementor/css/post-<kit>.css), which the look should read first. */
export function elementorKitStylesheet(html: string, baseUrl: string): string | null {
    const id = elementorKitId(html);
    if (!id) return null;
    const href = html.match(new RegExp(`<link\\b[^>]*id=["']elementor-post-${id}-css["'][^>]*href=["']([^"']+)["']`, 'i'))?.[1]
        ?? html.match(new RegExp(`<link\\b[^>]*href=["']([^"']*/uploads/elementor/css/post-${id}\\.css[^"']*)["']`, 'i'))?.[1];
    if (!href) return null;
    try { return new URL(href.replace(/&#0?38;|&amp;/g, '&'), baseUrl).toString(); } catch { return null; }
}

/** The kit's globals, from the page's inline <style> plus any fetched CSS. Defaults are ignored. */
export function readElementorKit(html: string, css = ''): ElementorKitLook {
    const all = `${[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')}\n${css}`;
    const v = (name: string) => all.match(new RegExp(`--e-global-${name}\\s*:\\s*([^;}]+)`, 'i'))?.[1]?.trim() ?? null;
    const colour = (k: string) => {
        const raw = v(`color-${k}`);
        const hex = raw && /^#(?:[0-9a-f]{3}){1,2}$/i.test(raw) ? (raw.length === 4 ? `#${[...raw.slice(1)].map((c) => c + c).join('')}` : raw).toLowerCase() : null;
        return hex && !DEFAULT_COLOURS.has(hex) ? hex : null;
    };
    const font = (k: string) => {
        const f = v(`typography-${k}-font-family`)?.split(',')[0].replace(/^['"]|['"]$/g, '').trim() ?? null;
        return f && !DEFAULT_FONTS.has(f.toLowerCase()) ? f : null;
    };
    const primaryColor = colour('primary'), secondaryColor = colour('secondary'), textColor = colour('text'), accentColor = colour('accent');
    const headingFont = font('primary'), bodyFont = font('text');
    return {
        primaryColor, secondaryColor, textColor, accentColor, headingFont, bodyFont,
        font: fontKeyFor(headingFont, bodyFont),
        defaults: /--e-global-color-primary/i.test(all) && !primaryColor && !secondaryColor && !accentColor,
    };
}
