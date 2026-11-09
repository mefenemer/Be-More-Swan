// src/utils/site-builders/bigcommerce.ts — Website import adapter for BigCommerce.
// Findings, what is covered and what is not: docs/site-import-platforms/bigcommerce.md
// Tests: tests/site-platform-bigcommerce.test.ts (fixtures in tests/fixtures/site-platforms/bigcommerce/).
//
// BigCommerce storefronts are server-rendered Stencil themes (Cornerstone and the themes built on it):
// the page's own content sits in #main-content, pictures come from cdn11.bigcommerce.com/s-{store}/
// images/stencil/{size}/…, and the header is full of shop machinery (cart, currency, sign in, compare,
// gift certificates, search). The adapter takes that machinery out so the menu holds the owner's pages,
// keeps product NAMES and pictures on category pages (never prices — those belong in Business
// Information), and asks the CDN for full-size pictures.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/** A BigCommerce CDN host (cdn11.bigcommerce.com, cdn.bigcommerce.com…). */
const CDN_HOST = /^cdn\d*\.bigcommerce\.com$/i;
/** The width asked for when a picture is resized on the CDN (it serves any width on request). */
const FULL_WIDTH = '1600w';

/** Shop machinery anywhere on the page: never the owner's words. */
const FURNITURE = [
    // header: account, cart, compare, currency, search, phone-menu toggle
    '.navUser', '.navPages-list--user', '.navPages-quickSearch', '.dropdown--quickSearch', '[data-quick-search-form]',
    '.quickSearchResults', '.mobileMenu-toggle', '.skip-to-main-link', '#cart-preview-dropdown', '[data-cart-preview]',
    // category and search pages: breadcrumbs, filters, sorting, page numbers
    '.breadcrumbs', '.page-sidebar', '#faceted-search-container', '.actionBar', '.pagination',
    // pop-ups and screen-reader-only labels ("The item has been added", "Footer Start")
    '[data-play-pause-button]', '.modal', '#modal', '#alert-modal', '.loadingOverlay', '.aria-description--hidden', '.is-srOnly', '.footer-title-sr-only',
    // product cards and product pages: buttons, prices, brand, ratings, sale flags, add-to-cart form
    '.card-figcaption', '[data-test-info-type="price"]', '[data-test-info-type="brandName"]', '[data-test-info-type="productRating"]',
    '.price-section', '.card-text--sale', '.productView-price', '.productView-options', '.productView-info', '.productView-reviewLink',
    'form[data-cart-item-add]', '.form-increment',
    // the footer's newsletter sign-up (the new site has its own), not an enquiry form
    '[data-section-type="newsletterSubscription"]', 'form[action*="subscribe.php"]',
].join(', ');

/** Shop links that themes put straight into the menu. */
const SHOP_LINK = 'a[href*="cart.php"], a[href*="login.php"], a[href*="account.php"], a[href*="wishlist.php"], a[href*="giftcertificates.php"], a[href*="setCurrencyId="], a[href$="/compare"], a[href$="/compare/"], a[href*="/compare?"]';

const PHONE = /\+?\(?\d[\d ()-]{7,}\d/;

/** The full-size address of a picture on BigCommerce's CDN, or null when it is not one. */
function fullSize(src: string): string | null {
    let u: URL;
    try { u = new URL(src); } catch { return null; }
    // A headless (Catalyst / Next.js) storefront hands CDN pictures through its own resizer.
    if (u.pathname === '/_next/image' && u.searchParams.get('url')) return fullSize(u.searchParams.get('url')!);
    if (!CDN_HOST.test(u.hostname)) return null;
    // Stencil: /s-{store}/images/stencil/{500x659 | 1280w | original}/…
    const stencil = u.pathname.match(/^(\/s-[a-z0-9]+\/images\/stencil\/)([^/]+)(\/.+)$/i);
    if (stencil) {
        if (stencil[2] === 'original' || stencil[2] === FULL_WIDTH) return u.toString();
        u.pathname = `${stencil[1]}${FULL_WIDTH}${stencil[3]}`;
        return u.toString();
    }
    // Older Blueprint themes: …/products/{id}/images/{img}/{name}.{stamp}.{w}.{h}.jpg — 1280 is the largest kept.
    const blueprint = u.pathname.match(/^(.*\/products\/\d+\/images\/\d+\/[^/]+?\.\d+)\.\d+\.\d+(\.[a-z]+)$/i);
    if (blueprint) { u.pathname = `${blueprint[1]}.1280.1280${blueprint[2]}`; return u.toString(); }
    return null;
}

/** The largest address in a srcset. */
function largest(srcset: string | undefined): string | null {
    let best: { url: string; w: number } | null = null;
    for (const part of (srcset ?? '').split(',')) {
        const [url, size] = part.trim().split(/\s+/);
        if (!url) continue;
        const w = size ? parseFloat(size) * (size.endsWith('x') ? 1000 : 1) : 0;
        if (!best || w > best.w) best = { url, w };
    }
    return best?.url ?? null;
}

function prepare($: cheerio.CheerioAPI): void {
    // Sub-menus: Cornerstone names each sub-menu ITEM "navPage-subMenu-item", which reads as a sub-menu
    // box of its own and labels the links by the item before them ("All Candles"). Only the panel
    // (div.navPage-subMenu) is the box; its heading is the category link before it. The first item
    // ("All Candles") is the category's own link again, so it is dropped as a duplicate.
    $('.navPage-subMenu-item, .navPage-subMenu-list, .navPage-childList, .navPage-childList-item').removeAttr('class');
    $('.navPage-subMenu').each((_, panel) => {
        const head = $(panel).prev('a').attr('href');
        if (head) $(panel).find('a').filter((_, a) => $(a).attr('href') === head).closest('li').remove();
    });
    $(SHOP_LINK).filter((_, a) => $(a).closest('header, nav, .navPages-container').length > 0).each((_, a) => {
        const li = $(a).closest('li');
        (li.length ? li : $(a)).remove();
    });

    // The home page's automatic product lists (featured, best sellers, newest) and the theme's own
    // heading for each: a changing list of products with prices, not the owner's page.
    // Cornerstone marks them data-product-type ("featured", "top_sellers") or draws them as a
    // .productCarousel ("New Products"); a category page's own grid is a plain ul.productGrid.
    const AUTO_LIST = '[data-product-type], .productCarousel';
    $(AUTO_LIST).each((_, list) => {
        const head = $(list).prevAll('.page-heading').first();
        if (head.length && head.nextAll(AUTO_LIST).first().is(list)) head.remove();
        $(list).remove();
    });

    $(FURNITURE).remove();
    $('form .form-label small').remove();   // "Required" after a form question

    // The hero carousel's slide titles are drawn as <p>: they are the slides' headings.
    $('.heroCarousel-title').each((_, el) => { (el as { name: string }).name = 'h2'; });

    // Pictures: the full-size one, whatever the theme asked the CDN for (srcset of 80w placeholders,
    // data-srcset that only lazy-loading reads, the logo's 250x100).
    $('img').each((_, img) => {
        const $img = $(img);
        const raw = largest($img.attr('data-srcset')) ?? largest($img.attr('srcset')) ?? $img.attr('data-src') ?? $img.attr('src') ?? '';
        const big = fullSize(raw);
        if (!big) return;
        $img.attr('src', big).removeAttr('srcset').removeAttr('data-srcset').removeAttr('data-src');
    });

    // Store details in the footer: lines of an address, and a phone number written without a link.
    $('address br').replaceWith(', ');
    $('[data-section-type="storeInfo"]').each((_, info) => {
        if ($(info).find('a[href^="tel:" i]').length) return;
        $(info).find('strong, p, span, div').each((_, el) => {
            const $el = $(el);
            if ($el.children().length) return;
            const m = $el.text().match(PHONE);
            if (m) { $el.empty().append($('<a>').attr('href', `tel:${encodeURIComponent(m[0].trim())}`).text($el.text())); return false; }
            return undefined;
        });
    });
}

export const adapter: BuilderAdapter = {
    key: 'bigcommerce',
    label: 'BigCommerce',
    // Stencil's <meta name="platform" content="bigcommerce.stencil">, a store's own CDN path
    // (cdn11.bigcommerce.com/s-{store}/ or /r-{theme}/), or Stencil's stylesheet marker — never the
    // word "bigcommerce" alone (an agency page about BigCommerce, a "Powered by" link elsewhere).
    detect: (html, _gen, $) =>
        /bigcommerce/i.test($('meta[name="platform"]').attr('content') ?? '')
        || /\bcdn\d*\.bigcommerce\.com\/[sr]-[a-z0-9]{5,}\//i.test(html)
        || /data-stencil-stylesheet|stencil-utils/.test(html),
    prepare: ($) => prepare($),
    contentRoot: '#main-content',
    noise: /^(quick view|add to (cart|wish ?list)|choose options|pre-?order now|out of stock|sold out|compare|gift certificates?|sale!?|sort by:?|view all|shop by price|footer start|toggle menu|write a review|or|register|select currency.*|\d+ reviews?)$/i,
    fullSizeImage: fullSize,
};
