// src/utils/site-builders/woocommerce.ts — Website import adapter for WooCommerce (the shop plugin for
// WordPress): classic themes (Storefront, Astra, Neve… — `ul.products > li.product` cards) and block
// themes (Product Collection block — `li.wc-block-product`, Mini-Cart block).
// Findings, what is covered and what is not: docs/site-import-platforms/woocommerce.md
// Tests: tests/site-platform-woocommerce.test.ts (fixtures in tests/fixtures/site-platforms/woocommerce/).
//
// A WooCommerce shop is a WordPress site, so everything the WordPress adapter does is done first (its
// prepare, noise and picture sizes), then the shop's own furniture is tidied.
import type * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { BuilderAdapter, ImportedProduct } from './types';
import { adapter as wordpress } from './wordpress';

/**
 * Markup only WooCommerce writes. Never the bare word: a WordPress blog post ABOUT WooCommerce says it too.
 * Its generator tag (second, after WordPress's — `gen` is only the first), its plugin's assets, the body
 * classes it adds to every page of the site (woocommerce-no-js, swapped to -js by its inline script), its
 * script settings, and its blocks.
 */
const WOO = /<meta[^>]+content=["']WooCommerce\b|\/wp-content\/plugins\/woocommerce\/|\bwoocommerce-(?:no-js|js|page|active|uses-block-theme)\b|\bwc_add_to_cart_params\b|\bwoocommerce_params\b|\bwp-block-woocommerce-[a-z]|\bwc-block-(?:components|product|mini-cart)/;

/** Cart, checkout and account pages, and add-to-basket links: shop machinery, never a page. */
const MACHINERY = /\/(?:cart|basket|checkout|my-account|wishlist)(?:\/|$)|[?&](?:add-to-cart|add_to_wishlist|remove_item)=/i;

/** The shop's furniture outside product cards: mini-carts, account links, notices, breadcrumbs, catalogue tools, shop widgets. */
const FURNITURE = [
    // Header: mini-cart (classic + block), account block, product search, Storefront's phone footer bar.
    '.site-header-cart', '.widget_shopping_cart', '.widget_shopping_cart_content', '.cart-contents', '.wc-block-mini-cart', '.wp-block-woocommerce-mini-cart',
    '.wp-block-woocommerce-customer-account', '.woocommerce-product-search', '.widget_product_search', '.wp-block-woocommerce-product-search', '.storefront-handheld-footer-bar',
    // Notices ("… has been added to your basket"), the store notice's Dismiss link, breadcrumbs.
    '.woocommerce-notices-wrapper', '.wc-block-store-notices', '.wp-block-woocommerce-store-notices', '.woocommerce-message', '.woocommerce-info', '.woocommerce-error',
    '.woocommerce-store-notice__dismiss-link', '.woocommerce-breadcrumb', '.wp-block-woocommerce-breadcrumbs', '.storefront-breadcrumb',
    // Catalogue tools: sorting, result counts, pagination, filters, the shop sidebar's widgets.
    '.woocommerce-ordering', '.woocommerce-result-count', '.woocommerce-pagination', '.wp-block-woocommerce-catalog-sorting', '.wp-block-woocommerce-product-results-count',
    '.wp-block-query-pagination', '.widget_product_categories', '.widget_price_filter', '.widget_layered_nav', '.widget_layered_nav_filters', '.widget_rating_filter',
    '.widget_products', '.widget_recently_viewed_products', '.widget_top_rated_products', '.widget_recent_reviews', '.widget_product_tag_cloud', '.wp-block-woocommerce-product-filters',
    // Other products on a product page (they have pages of their own).
    'section.related', 'section.up-sells', '.cross-sells', '.wp-block-woocommerce-related-products', '.wp-block-woocommerce-product-collection[data-collection*="related" i]',
].join(', ');

/** Product cards: classic loop items and Product Collection block items (not category tiles). */
const CARD = 'li.product:not(.product-category), li.wc-block-product';

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The price as the card or page states it: the current price of a sale, a range as "£12.00 – £24.00". */
function priceText($: cheerio.CheerioAPI, el: cheerio.Cheerio<AnyNode>): string {
    const p = el.find('.price, .wc-block-components-product-price, .wp-block-woocommerce-product-price').first().clone();
    if (!p.length) return '';
    p.find('del, .screen-reader-text').remove();
    return clean(p.text());
}

/** The picture a card or gallery shows, at its largest: WooCommerce's own large-image address, else the biggest in srcset. */
function pictureOf(img: cheerio.Cheerio<AnyNode>): string {
    const large = img.attr('data-large_image') ?? img.closest('.woocommerce-product-gallery__image').find('a[href]').first().attr('href');
    if (large) return large;
    let best = '', w = -1;
    for (const part of (img.attr('srcset') ?? img.attr('data-srcset') ?? '').split(',')) {
        const [u, size] = part.trim().split(/\s+/);
        const n = size ? parseFloat(size) : 0;
        if (u && n > w) { best = u; w = n; }
    }
    return best || img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src') || '';
}

interface Card { el: AnyNode; name: string; href: string; img: cheerio.Cheerio<AnyNode>; price: string }

function readCards($: cheerio.CheerioAPI): Card[] {
    return $(CARD).toArray().flatMap((el) => {
        const card = $(el);
        const title = card.find('.woocommerce-loop-product__title, .wp-block-post-title, .wc-block-components-product-name, .wc-block-grid__product-title, h2, h3').first();
        const name = clean(title.text());
        if (!name) return [];
        const href = title.find('a[href]').attr('href') ?? title.closest('a[href]').attr('href') ?? card.find('a.woocommerce-LoopProduct-link, a[href*="/product/"]').first().attr('href') ?? '';
        const img = card.find('img.attachment-woocommerce_thumbnail, img.wp-post-image, .wc-block-components-product-image img, img').first();
        return [{ el, name, href, img, price: priceText($, card) }];
    });
}

/** A card → one list item: its picture and its name, linked to its page on their shop. Price, badges, ratings and buttons go. */
function tidyCards($: cheerio.CheerioAPI): void {
    for (const { el, name, href, img } of readCards($)) {
        const li = $('<li></li>');
        if (img.length) {
            const src = pictureOf(img);
            if (src && !/woocommerce-placeholder/i.test(src)) li.append($('<img/>').attr('src', src).attr('alt', clean(img.attr('alt')) || name));
        }
        li.append(href ? $('<a></a>').attr('href', href).text(name) : $('<span></span>').text(name));
        $(el).replaceWith(li);
    }
    // Category tiles: the picture and the category's name, without its "(6)" product count.
    $('li.product-category').each((_, el) => {
        const tile = $(el);
        tile.find('mark.count, .count').remove();
        const name = clean(tile.find('h2, h3, .woocommerce-loop-category__title').first().text());
        const href = tile.find('a[href]').first().attr('href') ?? '';
        const img = tile.find('img').first();
        const li = $('<li></li>');
        if (img.length) { const src = pictureOf(img); if (src) li.append($('<img/>').attr('src', src).attr('alt', clean(img.attr('alt')) || name)); }
        if (name) li.append(href ? $('<a></a>').attr('href', href).text(name) : $('<span></span>').text(name));
        tile.replaceWith(li);
    });
}

/** A single product page: the gallery at full size, the description; prices, stock, basket form, SKU, tabs' labels go. Reviews become quotes. */
function tidyProductPage($: cheerio.CheerioAPI): void {
    $('.woocommerce-product-gallery img').each((_, el) => {
        const img = $(el);
        const src = pictureOf(img);
        if (src) img.attr('src', src).removeAttr('srcset').removeAttr('data-src').removeAttr('data-srcset');
    });
    $('.summary .price, .wp-block-woocommerce-product-price, .woocommerce-product-rating, .wp-block-woocommerce-product-rating, p.stock, .wc-block-components-product-stock-indicator, .product_meta, .wp-block-woocommerce-product-meta, form.cart, .wp-block-woocommerce-add-to-cart-form, .onsale, .wc-block-components-product-sale-badge').remove();
    // Tab labels ("Description", "Additional information", "Reviews (2)") and WooCommerce's own panel headings.
    $('.woocommerce-tabs ul.tabs, .wc-tabs').remove();
    $('.woocommerce-Tabs-panel > h2:first-child').filter((_, h) => /^(description|additional information|reviews?)$/i.test(clean($(h).text()))).remove();
    // Weight and dimensions are product facts for Business Information, not the page's words.
    $('#tab-additional_information, .woocommerce-Tabs-panel--additional_information').remove();
    // Customer reviews: what the customer wrote, and their name. The rest (stars, dates, the review form) goes.
    $('.woocommerce-Reviews ol.commentlist > li, .wc-block-components-review-list-item__item').each((_, el) => {
        const r = $(el);
        const words = clean(r.find('.description, .wc-block-components-review-list-item__text').first().text());
        const who = clean(r.find('.woocommerce-review__author, .wc-block-components-review-list-item__author').first().text());
        r.replaceWith(words ? `<blockquote><p>${escapeAttr(words).replace(/</g, '&lt;')}</p>${who ? `<cite>${escapeAttr(who).replace(/</g, '&lt;')}</cite>` : ''}</blockquote>` : '');
    });
    $('.woocommerce-Reviews ol.commentlist').each((_, el) => { $(el).replaceWith($(el).contents()); });
    $('.woocommerce-Reviews-title, #review_form_wrapper, .woocommerce-noreviews, .woocommerce-verification-required').remove();
}

/** The shop's products on this page, as it arrived (before prepare): cards, and the product of a product page. */
export function readWooProducts($: cheerio.CheerioAPI, url: URL | null): ImportedProduct[] {
    const abs = (h: string) => { try { return h ? new URL(h, url ?? undefined).toString() : null; } catch { return null; } };
    const out: ImportedProduct[] = readCards($).map((c) => ({ name: c.name, price: c.price || null, href: abs(c.href), image: c.img.length ? abs(pictureOf(c.img)) : null }));
    // A product page: its title, price and first gallery picture (its schema.org Product is read too; this fills its page and picture).
    const title = clean($('.product_title, main .wp-block-post-title').first().text());
    if ($('body').hasClass('single-product') && title) {
        const img = $('.woocommerce-product-gallery img').first();
        const summary = $('.summary').first();
        const price = summary.length ? priceText($, summary) : clean($('.wp-block-woocommerce-product-price').first().clone().find('del, .screen-reader-text').remove().end().text());
        out.unshift({ name: title, price: price || null, href: url ? url.toString() : null, image: img.length ? abs(pictureOf(img)) : null });
    }
    return out.filter((p) => !/woocommerce-placeholder/i.test(p.image ?? ''));
}

/** Tidy a WooCommerce page. Exported so an adapter that wins first on a shop (Elementor) can call it too. */
export function prepareWoo($: cheerio.CheerioAPI): void {
    // Cart, checkout, account and add-to-basket links: in the menu they used up places ("£0.00 0 items", "My account").
    $('a[href]').filter((_, a) => MACHINERY.test($(a).attr('href') ?? '')).filter((_, a) => !$(a).closest(CARD).length).remove();
    tidyCards($);
    tidyProductPage($);
    $(FURNITURE).remove();
    // Add-to-basket buttons outside cards (shortcodes, blocks) and the "View basket" link that follows them.
    $('.add_to_cart_button, .added_to_cart, .wc-block-components-product-button, .single_add_to_cart_button').remove();
    // Screen-reader copies of prices and labels ("Original price was: £22.00.") are said twice.
    $('.screen-reader-text').filter((_, el) => !$(el).closest('h1, h2, h3, h4, h5, h6').length).remove();
}

/** Lines WooCommerce writes, not the owner. */
const WOO_NOISE = /^(sale!?|product on sale|add to (basket|cart)|select options|view (basket|cart)|view your shopping (basket|cart)|proceed to checkout|checkout|my account|showing (all )?\d+(\s*[–-]\s*\d+ of \d+)? results?|showing the single result|default sorting|sort by .*|no products in the (basket|cart)\.?|your (basket|cart) is currently empty\.?|return to shop|no products were found matching your selection\.?|rated \d+(\.\d+)? out of 5.*|\(?\d+ customer reviews?\)?|\d+ in stock|(in|out of) stock|available on backorder|sku: .*|categor(y|ies): .*|tags?: .*|add a review|be the first to review .*|there are no reviews yet\.?|only logged in customers who have purchased this product may leave a review\.?|this is a demo store for testing purposes — no orders shall be fulfilled\.?|dismiss|built with woocommerce\.?)$/i;

/** WordPress-sized copies (-324x324), Jetpack's image CDN (i0.wp.com …?resize=) and Optimole's (…/w:324/…/https://site/…) → the original. */
export function wooFullSizeImage(src: string): string | null {
    try {
        const u = new URL(src);
        // Optimole: the original address is carried whole at the end of the path.
        const opt = /(^|\.)i\.optimole\.com$/.test(u.hostname) ? src.match(/\/(https?:\/\/.+)$/)?.[1] : null;
        if (opt) return wooFullSizeImage(opt) ?? opt;
        if (/^i[0-3]\.wp\.com$/.test(u.hostname)) {
            const q = [...u.searchParams.keys()];
            if (!q.some((k) => ['resize', 'fit', 'w', 'h', 'crop', 'zoom', 'quality'].includes(k))) return null;
            return `${u.protocol}//${u.hostname}${u.pathname}`;
        }
        if (!/\/wp-content\/uploads\//.test(u.pathname)) return null;
        const path = u.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp|gif|avif)$)/i, '');
        if (path === u.pathname) return null;
        u.pathname = path;
        return u.toString();
    } catch { return null; }
}

/** Both noise lists as one: WordPress's (when its adapter has one) and WooCommerce's. */
function noise(): RegExp {
    const wp = wordpress.noise;
    return wp ? new RegExp(`(?:${WOO_NOISE.source})|(?:${wp.source})`, 'i') : WOO_NOISE;
}

export const adapter: BuilderAdapter = {
    key: 'woocommerce',
    label: 'WooCommerce',
    detect: (html) => WOO.test(html),
    products: readWooProducts,
    // Shop category pages in the menu (Shop ▸ Candles) are catalogue listings: read after their own pages.
    catalogueLink: (href, el) => el.closest('li.menu-item-object-product_cat, li.menu-item-object-product, li.menu-item-type-post_type_archive').length > 0 || /\/(product-category|product-tag|product)\//i.test(href),
    prepare($, url) {
        try { wordpress.prepare?.($, url); } catch { /* the WordPress tidy never stops a shop's */ }
        prepareWoo($);
    },
    get contentRoot() { return wordpress.contentRoot; },
    get noise() { return noise(); },
    fullSizeImage(src) {
        let wp: string | null | undefined = null;
        try { wp = wordpress.fullSizeImage?.(src); } catch { wp = null; }
        return wooFullSizeImage(wp ?? src) ?? wp ?? null;
    },
    // Classic and Product Collection pages arrive with their words; only the cart and checkout blocks
    // (never read) and the old "All Products" block draw with JavaScript.
    rendersWithJs: false,
};
