// src/utils/site-shop-feeds.ts — every product a shop sells, from the shop's own public feed (2026-11-09,
// the platform reports' "products from shop data"). A page shows only some products; Shopify's
// /products.json and WooCommerce's Store API (/wp-json/wc/store/v1/products) list them all, with no key.
// They fill the import's opt-in product list (report.products → "Add ticked products to Business
// Information"); prices go there, never onto the site. Read through the same robots + SSRF fetcher.
import type { ImportedProduct } from './site-builders/types';

/** Business Information holds at most this many products and services (org-products.ts). */
export const SHOP_FEED_MAX = 200;

/** A price in the form product-price.ts priceFromText reads ("£28.00", "US$12.50"), or the amount and code as text. */
export function priceWithCurrency(amount: string | number | null | undefined, currency: string | null | undefined): string | null {
    if (amount === null || amount === undefined || amount === '') return null;
    const n = Number(amount);
    if (!isFinite(n) || n <= 0) return null;
    const v = n.toFixed(2);
    const sym: Record<string, string> = { GBP: '£', EUR: '€', USD: 'US$', AUD: 'A$', CAD: 'C$' };
    const code = (currency || '').toUpperCase();
    return sym[code] ? `${sym[code]}${v}` : code ? `${v} ${code}` : v;
}

/** The shop's currency as Shopify prints it on its pages (Shopify.currency = {"active":"GBP",…}). */
export function shopifyCurrency(html: string): string | null {
    return html.match(/Shopify\.currency\s*=\s*\{\s*"active"\s*:\s*"([A-Z]{3})"/)?.[1] ?? html.match(/"currency(?:Code)?"\s*:\s*"([A-Z]{3})"/)?.[1] ?? null;
}

/** At most this many of a product's variants become options (shop-options.ts MAX_OPTIONS); more keeps "From £x". */
export const FEED_MAX_OPTIONS = 20;

/** Shopify's body_html as plain text, at most `max` characters. Pure. */
export function plainDescription(html: unknown, max = 1200): string | null {
    const t = String(html ?? '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (!t) return null;
    return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/**
 * A Shopify product's variants as our options (online shop slice 9): one group named after its option names
 * ("Size", "Size / Colour"), each variant's title as the label, its own price when it differs from the cheapest,
 * sold out when Shopify marks it unavailable. Null for a single "Default Title" variant, more than FEED_MAX_OPTIONS, or
 * any variant without a price above 0. Pure.
 */
export function shopifyOptions(p: Record<string, unknown>): ImportedProduct['options'] {
    const variants = Array.isArray(p.variants) ? (p.variants as Array<Record<string, unknown>>) : [];
    if (variants.length < 2 || variants.length > FEED_MAX_OPTIONS) return null;
    const names = (Array.isArray(p.options) ? (p.options as Array<Record<string, unknown>>) : [])
        .map((o) => String(o?.name ?? '').trim()).filter((n) => n && n.toLowerCase() !== 'title');
    const group = (names.join(' / ') || 'Option').slice(0, 40);
    const prices = variants.map((v) => Number(v.price));
    // A free or unpriced variant (review #911): never sold at another variant's price — keep "From £x" instead.
    if (prices.some((x) => !isFinite(x) || x <= 0)) return null;
    const low = Math.min(...prices);
    const seen = new Set<string>();
    const options: NonNullable<ImportedProduct['options']>['options'] = [];
    for (const v of variants) {
        const label = String(v.title ?? [v.option1, v.option2, v.option3].filter(Boolean).join(' / ')).replace(/\s+/g, ' ').trim().slice(0, 60);
        const key = label.toLowerCase();
        if (!label || key === 'default title' || seen.has(key)) continue;
        seen.add(key);
        const price = Number(v.price);
        options.push({ label, price: isFinite(price) && price > 0 && Math.abs(price - low) > 0.0001 ? Math.round(price * 100) / 100 : null, soldOut: v.available === false });
    }
    return options.length >= 2 ? { group, options } : null;
}

/** Shopify's /products.json → products (cheapest variant's price, first picture, its page; slice 9: description and options). */
export function readShopifyFeed(json: string, origin: string, currency: string | null): ImportedProduct[] {
    let data: { products?: Array<Record<string, unknown>> };
    try { data = JSON.parse(json); } catch { return []; }
    return (data.products ?? []).flatMap((p) => {
        const name = String(p.title ?? '').trim();
        if (!name) return [];
        const variants = Array.isArray(p.variants) ? (p.variants as Array<Record<string, unknown>>) : [];
        const prices = variants.map((v) => Number(v.price)).filter((x) => isFinite(x) && x > 0);
        const low = prices.length ? Math.min(...prices) : null;
        const priced = priceWithCurrency(low, currency);
        const images = Array.isArray(p.images) ? (p.images as Array<Record<string, unknown>>) : [];
        const handle = typeof p.handle === 'string' ? p.handle : null;
        const options = shopifyOptions(p);
        return [{
            name: name.slice(0, 120),
            // With options each carries its own price, so the product is priced at the cheapest and can be bought;
            // without (too many variants), the old "From £x" text, as before.
            price: priced && !options && prices.length > 1 && Math.max(...prices) > (low ?? 0) ? `From ${priced}` : priced,
            href: handle ? `${origin}/products/${encodeURIComponent(handle)}` : null,
            image: typeof images[0]?.src === 'string' ? (images[0].src as string) : null,
            description: plainDescription(p.body_html),
            options,
        }];
    });
}

/** WooCommerce's Store API → products (prices come in minor units with their currency). */
export function readWooFeed(json: string): ImportedProduct[] {
    let data: unknown;
    try { data = JSON.parse(json); } catch { return []; }
    if (!Array.isArray(data)) return [];
    return (data as Array<Record<string, unknown>>).flatMap((p) => {
        const name = String(p.name ?? '').replace(/<[^>]+>/g, '').trim();
        if (!name) return [];
        const pr = (p.prices ?? {}) as Record<string, unknown>;
        const minor = Number(pr.currency_minor_unit ?? 2);
        const raw = pr.price ?? null;
        const amount = raw === null || raw === '' ? null : Number(raw) / 10 ** (isFinite(minor) ? minor : 2);
        const images = Array.isArray(p.images) ? (p.images as Array<Record<string, unknown>>) : [];
        const range = (pr.price_range ?? null) as Record<string, unknown> | null;
        const priced = priceWithCurrency(range?.min_amount != null ? Number(range.min_amount) / 10 ** minor : amount, String(pr.currency_code ?? ''));
        return [{
            name: name.slice(0, 120),
            price: priced && range ? `From ${priced}` : priced,
            href: typeof p.permalink === 'string' ? p.permalink : null,
            image: typeof images[0]?.src === 'string' ? (images[0].src as string) : null,
        }];
    });
}

/** The feed to read for a shop platform, or null. */
export function shopFeedUrl(platform: string | null | undefined, origin: string): string | null {
    if (platform === 'shopify') return `${origin}/products.json?limit=250`;
    if (platform === 'woocommerce' || platform === 'elementor') return `${origin}/wp-json/wc/store/v1/products?per_page=100`;
    return null;
}
