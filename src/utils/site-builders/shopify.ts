// src/utils/site-builders/shopify.ts — Website import adapter for Shopify.
// Findings, what is covered and what is not: docs/site-import-platforms/shopify.md
// Tests: tests/site-platform-shopify.test.ts (fixtures in tests/fixtures/site-platforms/shopify/).
//
// Shopify themes (Dawn and the other Online Store 2.0 themes, and the older "vintage" ones such as
// Debut) are drawn on Shopify's servers from Liquid, so the words are in the HTML. What gets in the
// way is the shop's furniture: a cart drawer, search and country pickers, a phone menu that repeats
// the desktop one, product cards with prices, badges, hover pictures and "Choose options" buttons,
// slider arrows, review-app badges and the Inbox chat. This file takes that away and asks Shopify's
// picture CDN for a sensible full-size copy of each picture.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/**
 * Shopify's own markers. A bare cdn.shopify.com address is not enough — hand-made and WordPress pages
 * hot-link pictures from Shopify's Files — so it needs the storefront's own script, sections or assets.
 */
const SHOPIFY_MARK = /\bShopify\.(?:theme|shop)\s*=|shopify-section|name=["']shopify-(?:checkout-api-token|digital-wallet)|cdn\.shopify\.com\/(?:shopifycloud|s\/files\/[^"'\s]*\/t\/\d+\/assets)\/|\/cdn\/shop\/t\/\d+\/assets\//;

/** The shop's furniture: never the owner's words. */
const FURNITURE = [
    // Cart, search, account, country and language pickers.
    'cart-drawer', '#CartDrawer', 'cart-notification', '.cart-notification-wrapper', '#CartPopup', '.cart-popup-wrapper',
    'details-modal', 'predictive-search', '.search-modal', 'localization-form', '.disclosure',
    '.header__icons', '.site-header__icons', '.menu-drawer__utility-links',
    // Product cards: prices, badges, quick add, hover copies.
    '.price', '[data-price]', '.unit-price', '.badge', '.card__badge', '.quick-add', 'quick-add-modal', 'modal-opener',
    'product-form', '.product-form', '.card__inner .card__content', '.media--hover-effect img ~ img',
    '.grid-view-item__link ~ .grid-view-item__title[aria-hidden="true"]',
    // Slider and slideshow controls, collection counts, sorting and paging.
    '.slider-buttons', '.slider-counter', '.slideshow__controls', '.slideshow__autoplay',
    '.product-count', 'facet-filters-form', '.facets', '.pagination', '.pagination-wrapper',
    // Apps: review badges and widgets (Judge.me, Loox, Yotpo, Okendo, Stamped), Inbox chat, privacy banner.
    '[class*="jdgm-"]', '.loox-rating', '#looxReviews', '.yotpo', '[data-oke-widget]', '.okeReviews', '[class*="stamped-"]',
    '#shopify-chat', 'inbox-online-store-chat', '#shopify-pc__banner',
    // Forms that are not an enquiry form: search, cart, country picker, newsletter sign-up (form_type=customer).
    'form[action$="/search"]', 'form[action*="/cart"]', 'form[action$="/localization"]', 'form.newsletter-form',
    'form:has(input[name="form_type"][value="customer"])', 'form:has(input[name="form_type"][value="localization"])',
].join(', ');

/** Expand what Dawn keeps in <template> (a YouTube or Vimeo player behind a poster button) so the import sees the video. */
function expandDeferredVideos($: cheerio.CheerioAPI): void {
    $('deferred-media').each((_, el) => {
        const $el = $(el);
        const tpl = $el.children('template').first();
        const inner = tpl.length ? (tpl.html() ?? '') : '';
        if (/<iframe\b[^>]*(?:youtube(?:-nocookie)?\.com\/embed|youtu\.be|player\.vimeo\.com)/i.test(inner)) {
            $el.replaceWith(inner);   // the video's own thumbnail and a "Watch the video" button replace the poster
            return;
        }
        // A video Shopify hosts (or anything else): keep the poster picture, drop the "Load video" button.
        const poster = $el.find('img').first();
        if (poster.length) {
            poster.attr('alt', (poster.attr('alt') ?? '').replace(/^load video:\s*/i, ''));
            $el.replaceWith(poster);
        } else $el.remove();
    });
}

/**
 * Dawn draws the menu twice: a phone drawer, then the desktop menu with its drop-downs. The drawer
 * comes first and hides each drop-down's name from the import, so it goes when the desktop menu is
 * there; otherwise it is unwrapped so its drop-downs still read under their names.
 */
function oneMenu($: cheerio.CheerioAPI): void {
    const desktop = $('.header__inline-menu a[href], header-menu a[href]').length > 0;
    if (desktop) { $('header-drawer, #menu-drawer').remove(); return; }
    $('.menu-drawer__close-button').remove();
    $('.menu-drawer__inner-submenu').each((_, el) => { $(el).replaceWith($(el).contents()); });
}

/** Debut-style drop-downs (li > button + div.site-nav__dropdown > ul): unwrapped so the list sits in its item. */
function vintageDropdowns($: cheerio.CheerioAPI): void {
    $('.site-nav__dropdown, .site-nav__childlist').each((_, el) => {
        const $el = $(el);
        if ($el.children('ul').length) $el.replaceWith($el.children('ul'));
    });
}

/** Text only screen readers hear ("Regular price", "Collection:", "Load video"), except a link's only name. */
function dropScreenReaderText($: cheerio.CheerioAPI): void {
    $('.visually-hidden, .icon__fallback-text').each((_, el) => {
        const $el = $(el);
        const link = $el.closest('a');
        if (link.length && link.text().trim() === $el.text().trim()) return;
        $el.remove();
    });
}

/** Shopify's resized-copy suffixes (_300x, _x600, _600x600_crop_center@2x, _grande, the lazy-load {width}x). */
const SIZE_SUFFIX = /_(?:\{width\}x|\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande|original|master)(?:_crop_[a-z]+)?(?:@\d+x)?(\.(?:jpe?g|png|webp|gif|avif|heic))$/i;
/** The size Shopify's CDN is asked for: big enough for a full-width banner, never the camera's original. */
const FULL_WIDTH = '2000';

export function shopifyFullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    const own = /^\/cdn\/shop\/(?:files|products|collections|articles)\//.test(u.pathname);
    const cdn = u.hostname === 'cdn.shopify.com' && /^\/s\/files\//.test(u.pathname);
    if (!own && !cdn) return null;
    const path = decodeURIComponent(u.pathname);
    if (!/\.(?:jpe?g|png|webp|gif|avif|heic)$/i.test(path)) return null;
    u.pathname = path.replace(SIZE_SUFFIX, '$1');
    for (const k of ['width', 'height', 'crop', 'pad_color', 'format']) u.searchParams.delete(k);
    u.searchParams.set('width', FULL_WIDTH);
    return u.toString();
}

export const adapter: BuilderAdapter = {
    key: 'shopify',
    label: 'Shopify',
    detect: (html) => SHOPIFY_MARK.test(html),
    prepare($) {
        expandDeferredVideos($);
        oneMenu($);
        vintageDropdowns($);
        $(FURNITURE).remove();
        dropScreenReaderText($);
    },
    // Every Shopify theme we have seen marks its content area #MainContent (Dawn, Debut, Impulse…), on <main> or a <div>.
    contentRoot: '#MainContent',
    noise: /^(sold out|sale|on sale|new|from|regular price|sale price|unit price|per|of|choose options|add to cart|buy it now|more payment options|quick (add|view|shop)|view cart|check ?out|continue shopping|your cart is empty|item added to your cart|tax(es)? included\.?.*|shipping calculated at checkout\.?|\d+ (products?|results?|reviews?)|no reviews( yet)?|translation missing:.*|loading\.*|opens in a new window\.?|country\/region|language|update country\/region|payment methods|pickup (is )?available.*|couldn.t load pickup availability.*|slide \d+ of \d+|(pause|play) slideshow)$/i,
    fullSizeImage: shopifyFullSize,
    // Online Store themes are drawn on Shopify's servers. Headless Hydrogen shops are React, but they
    // carry none of the markers above, so they never reach this adapter.
    rendersWithJs: false,
};
