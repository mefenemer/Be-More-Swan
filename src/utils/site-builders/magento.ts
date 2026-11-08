// src/utils/site-builders/magento.ts — Website import adapter for Adobe Commerce (Magento 2): Luma-style
// themes, Hyvä (Tailwind + Alpine.js) and PWA Studio (Venia, a React shell).
// Findings, what is covered and what is not: docs/site-import-platforms/magento.md
// Tests: tests/site-platform-magento.test.ts (fixtures in tests/fixtures/site-platforms/magento/).
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';

/**
 * Tell-tale markup. Never a bare `mage/`: it sits inside every `image/png` and once claimed plain pages.
 * Luma/Hyvä: x-magento-init scripts, data-mage-init, Magento_Module/ asset paths, /static/version…/frontend/,
 * catalogue pictures under /media/catalog/. PWA Studio: data-media-backend, INLINED_PAGE_TYPE, RootCmp_ bundles.
 */
const MAGENTO = /text\/x-magento-init|\bdata-mage-init=|\bMagento_[A-Z][A-Za-z]+\/|\/static\/(?:version\d+\/)?(?:frontend|_cache\/merged)\/|\/media\/catalog\/(?:product|category)\/|\bdata-media-backend=|\bINLINED_PAGE_TYPE\b|\/RootCmp_[A-Z_]+/;

/** Shop machinery, never a page to copy: accounts, cart, search, guest orders, the sample privacy page. */
const MACHINERY = /\/(?:customer|checkout|wishlist|catalogsearch|sales\/guest|search\/term|newsletter|review\/customer|catalog\/product_compare|downloadable|vault|paypal|multishipping)(?:\/|$)|\/privacy-policy-cookie-restriction-mode\/?$/i;

/** The store's furniture, Luma and Hyvä class names. Removed outright. */
const FURNITURE = [
    // Header: welcome line, sign-in links, mini-cart, search, compare link, nav tabs and switchers.
    '.panel.header', '.header.links', '.authorization-link', '.minicart-wrapper', '[data-block="minicart"]', '.block-search',
    '#search-content', '#cart-drawer', '[x-data*="initCartDrawer"]', '.compare.wrapper', '.nav-sections-item-title',
    '#store\\.links', '#store\\.settings', '.switcher', '[x-data*="initStoreSwitcher"]', 'nav[aria-label*="mobile" i]',
    'nav[aria-label="My Account"]', '[x-data*="initMobileMenu"]', '.action.skip', '.action.nav-toggle',
    // Messages, breadcrumbs.
    '.page.messages', '.messages', '.message.global', '.breadcrumbs',
    // Catalogue listing machinery: toolbars, filters, compare and wish-list side blocks, recently viewed.
    '.toolbar', '.toolbar-products', '.block.filter', '#layered-filter-block', '.filter-options', '[x-data*="initLayeredNavigation"]',
    '.block-compare', '.block-wishlist', '.block-reorder', '.block-viewed-products-grid', '.block-compared-products-grid',
    // Newsletter sign-up (our site has its own).
    '.block.newsletter', 'form[action*="/newsletter/"]',
    // Carousel controls.
    '.glider-prev', '.glider-next', '.glider-dots', '[aria-label="Previous slide"]', '[aria-label="Next slide"]',
].join(', ');

/** Product card parts that are not the owner's words or picture. */
const CARD_FURNITURE = '.price-box, .price-container, .product-item-actions, .actions-primary, .actions-secondary, .product-reviews-summary, .rating-summary, [class*="swatch-opt"], .stock, button, form, input';

/** "url" inside Page Builder's data-background-images ({\"desktop_image\":\"…\"}), escaped or not. */
function pbImage(raw: string | undefined, key: 'desktop_image' | 'mobile_image'): string | null {
    if (!raw) return null;
    const src = raw.match(new RegExp(`${key}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`))?.[1] ?? '';
    return /^(https?:\/\/|\/)/.test(src) ? src : null;
}

/** The price a card shows (final price first), for the import report's price list only. */
function cardPrice($: cheerio.CheerioAPI, card: cheerio.Cheerio<any>): string {
    const pick = card.find('[data-price-type="finalPrice"] .price, .special-price .price, .final-price .price, .price').first();
    return pick.text().replace(/\s+/g, ' ').trim();
}

function tidyCards($: cheerio.CheerioAPI): void {
    const cards = $('.product-item').filter((_, el) => $(el).parents('.product-item').length === 0);
    cards.each((_, el) => {
        const card = $(el);
        const link = card.find('a.product-item-link').first();
        const name = (link.text() || card.find('.product-item-name').first().text()).replace(/\s+/g, ' ').trim();
        if (!name) return;
        const href = link.attr('href') ?? card.find('a.product-item-photo').attr('href') ?? '';
        const img = card.find('img.product-image-photo').first().length ? card.find('img.product-image-photo').first() : card.find('img').first();
        const price = cardPrice($, card);
        card.find(CARD_FURNITURE).remove();
        // One list item: the picture and the product's name, linked to its page on their shop.
        const li = $('<li></li>');
        if (img.length && !/\/placeholder\//i.test(img.attr('src') ?? '')) {
            const pic = $('<img/>');
            for (const a of ['src', 'srcset', 'data-src', 'width', 'height']) { const v = img.attr(a); if (v) pic.attr(a, v); }
            pic.attr('alt', (img.attr('alt') ?? '').trim() || name);
            li.append(pic);
        }
        const a = $('<a></a>').text(name);
        if (href) a.attr('href', href);
        li.append(a);
        // Its price, as its own line beside it: the import lists prices for Business Information and
        // never puts them on the site (numberBlocks drops any block that states one).
        const out = price ? [li, $('<p></p>').text(`${name}: ${price}`)] : [li];
        card.replaceWith(out.map((x) => $.html(x)).join(''));
    });
}

/** Page Builder: hidden elements, phone-only copies, background pictures, banner buttons, maps. */
function tidyPageBuilder($: cheerio.CheerioAPI): void {
    // "Hide" in Page Builder writes display:none on the element itself.
    $('[data-content-type]').filter((_, el) => /display\s*:\s*none/i.test($(el).attr('style') ?? '')).remove();
    // Each picture is drawn twice: desktop and phone. Keep the desktop one.
    $('img.pagebuilder-mobile-only').remove();
    // Backgrounds live in a JSON attribute, not in CSS: hand the desktop one to the reader as data-bg.
    $('[data-background-images]').each((_, el) => {
        const src = pbImage($(el).attr('data-background-images'), 'desktop_image') ?? pbImage($(el).attr('data-background-images'), 'mobile_image');
        if (src && !$(el).attr('data-bg')) $(el).attr('data-bg', src);
    });
    // A banner or slide is one link with a <button> inside: the button is where that link goes.
    $('button.pagebuilder-banner-button, button.pagebuilder-slide-button').each((_, el) => {
        const href = $(el).closest('a[href]').attr('href');
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!text) { $(el).remove(); return; }
        $(el).replaceWith(href ? $('<a></a>').attr('href', href).attr('class', 'pagebuilder-button-primary').text(text) : $('<p></p>').text(text));
    });
    // Luma's promo tiles (<a class="block-promo"> around a picture, words and a "Shop …" label): the
    // label is where the tile goes.
    $('a.block-promo[href]').each((_, el) => {
        const href = $(el).attr('href')!;
        $(el).find('.action.more, .more.button').each((__, m) => { const t = $(m).text().replace(/\s+/g, ' ').trim(); $(m).replaceWith(t ? $('<a></a>').attr('href', href).attr('class', 'action more').text(t) : ''); });
        $(el).replaceWith($('<div class="block-promo"></div>').append($(el).contents()));
    });
    // The outer link then wraps headings and text, never a button itself: unwrap it.
    $('[data-content-type="banner"] > a[data-element="link"], [data-content-type="slide"] > a[data-element="link"]').each((_, el) => { $(el).replaceWith($(el).contents()); });
    // A map is drawn by Google's script from data-locations: its place becomes a link the reader turns
    // into "See us on the map", and its address the page's address.
    $('[data-content-type="map"][data-locations]').each((_, el) => {
        let locs: Array<Record<string, unknown>> = [];
        try { locs = JSON.parse($(el).attr('data-locations') ?? '[]'); } catch { locs = []; }
        const parts: string[] = [];
        for (const l of locs.slice(0, 3)) {
            const pos = l.position as { latitude?: number; longitude?: number } | undefined;
            const s = (k: string) => (typeof l[k] === 'string' ? (l[k] as string).trim() : '');
            if (s('location_name')) parts.push(`<p>${escapeHtml(s('location_name'))}</p>`);
            const addr = [s('address'), s('city'), s('state'), s('zipcode')].filter(Boolean).join(', ');
            if (addr) parts.push(`<address>${escapeHtml(addr)}</address>`);
            if (s('comment')) parts.push(`<p>${escapeHtml(s('comment'))}</p>`);
            if (s('phone')) parts.push(`<p><a href="tel:${escapeHtml(s('phone').replace(/[^\d+]/g, ''))}">${escapeHtml(s('phone'))}</a></p>`);
            if (typeof pos?.latitude === 'number' && typeof pos?.longitude === 'number') parts.push(`<iframe src="https://maps.google.com/maps/embed?q=${pos.latitude},${pos.longitude}" title="${escapeHtml(s('location_name'))}"></iframe>`);
        }
        $(el).replaceWith(parts.join(''));
    });
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The menu, in the order pages are worth reading: top-level categories, then the footer's own pages
 * (About us, Delivery, Contact — Luma keeps them only in the footer), then the sub-categories as
 * drop-downs. A shop's category tree would otherwise use up the page cap before About us.
 */
function reorderMenu($: cheerio.CheerioAPI, url: URL | null): void {
    const main = $('nav.navigation, nav[aria-label="Main menu" i], nav[aria-label="Main navigation" i]').first();
    const later = main.length ? main.clone() : null;
    if (main.length) main.find('li > ul, li > div.submenu').remove();
    const footerLinks: string[] = [];
    $('footer a[href]').each((_, a) => {
        if ($(a).closest('nav').length) return;   // a footer <nav> (Hyvä) is already read in its place
        const href = $(a).attr('href') ?? '';
        const text = $(a).text().replace(/\s+/g, ' ').trim();
        if (!text || MACHINERY.test(href)) return;
        try { if (url && new URL(href, url).host.replace(/^www\./, '') !== url.host.replace(/^www\./, '')) return; } catch { return; }
        footerLinks.push(`<li><a href="${escapeHtml(href)}">${escapeHtml(text)}</a></li>`);
    });
    const body = $('body');
    if (footerLinks.length) body.append(`<nav data-bms-from="magento-footer"><ul>${footerLinks.join('')}</ul></nav>`);
    if (later && later.find('li > ul').length) body.append($('<nav data-bms-from="magento-submenus"></nav>').append(later.children()));
}

export const adapter: BuilderAdapter = {
    key: 'magento',
    label: 'Adobe Commerce (Magento)',
    detect: (html) => MAGENTO.test(html),
    prepare($, url) {
        // Links to accounts, cart, search and guest orders are never pages; in the menu they used up places.
        $('header a[href], nav a[href], footer a[href], .nav-sections a[href]').filter((_, a) => MACHINERY.test($(a).attr('href') ?? '')).remove();
        $(FURNITURE).remove();
        // Shop forms are not the owner's enquiry form: add-to-basket (Hyvä wraps each product card in
        // one, which the reader would drop with its words) and search. Cards are tidied first.
        tidyCards($);
        $('form[action*="/checkout/cart/add"], form[data-role="tocart-form"], form[action*="/catalogsearch/"], form[action*="/wishlist/"], form[action*="/customer/"], [x-data*="initAuthentication"]').remove();
        // The logo link says "store logo" / "Go to Home page", which became the home page's menu name.
        $('header a').filter((_, a) => !$(a).text().trim() && $(a).find('img').length > 0).removeAttr('aria-label').removeAttr('title');
        tidyPageBuilder($);
        // "Home Page" is Magento's default title for the home CMS page, not a heading the owner wrote.
        if ($('body').hasClass('cms-index-index')) $('.page-title-wrapper').filter((_, el) => /^home page$/i.test($(el).text().trim())).remove();
        // Hyvä screen-reader-only labels and jump links ("Press to skip carousel", "View more about …").
        $('.sr-only').filter((_, el) => !$(el).closest('h1, h2, h3, h4, h5, h6').length).remove();
        reorderMenu($, url);
    },
    // Luma keeps owner content in widget areas either side of <main> (.top-container, .page-bottom);
    // the page wrapper holds them all, and the header, footer and menus are removed before reading.
    contentRoot: '.page-wrapper:has(main)',
    noise: /^(default welcome msg!?|my (cart|wish ?list|account)|create an account|compare products|you have no items (to compare|in your (shopping cart|wish list))\.?|(your )?cart is empty\.?|add to (cart|basket|wish ?list|compare)\b.*|view more about .*|show submenu for .*|toggle (nav|search form|minicart)|press to skip carousel|(previous|next) slide|out of stock|in stock|shop by|shopping options|sort by|view as|show \d+ per page|you're currently reading page ?\d*|newsletter|subscribe|sign up for our newsletter:?|enter your email address|javascript seems to be disabled in your browser\.?|the store will not work correctly when cookies are disabled\.?|rating:? ?\d+%|\d+ reviews?|be the first to review this product)$/i,
    fullSizeImage(src) {
        try {
            const u = new URL(src);
            let path = u.pathname;
            // Resized catalogue copies: /media/catalog/product/cache/<hash>/a/b/file.jpg → /media/catalog/product/a/b/file.jpg
            // (Magento 1: /cache/1/small_image/240x300/<hash>/a/b/file.jpg).
            path = path.replace(/(\/media\/catalog\/(?:product|category))\/cache\/(?:[^/]+\/)*?([^/]\/[^/]\/[^/]+)$/, '$1/$2');
            // Media gallery thumbnails (2.4): /media/wysiwyg/.renditions/wysiwyg/x.jpg → /media/wysiwyg/x.jpg
            path = path.replace(/\/media\/(?:[^/]+\/)?\.renditions\/(.+)$/, '/media/$1');
            const resized = ['width', 'height', 'quality', 'fit', 'bg-color', 'auto', 'format', 'crop', 'dpr', 'optimize'].filter((k) => u.searchParams.has(k));
            if (path === u.pathname && !resized.length) return null;
            u.pathname = path;
            for (const k of resized) u.searchParams.delete(k);
            return u.toString();
        } catch { return null; }
    },
};
