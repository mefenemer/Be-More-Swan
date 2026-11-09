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

/** Shopify's /products.json → products (cheapest variant's price, first picture, its page). */
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
        return [{
            name: name.slice(0, 120),
            price: priced && prices.length > 1 && Math.max(...prices) > (low ?? 0) ? `From ${priced}` : priced,
            href: handle ? `${origin}/products/${encodeURIComponent(handle)}` : null,
            image: typeof images[0]?.src === 'string' ? (images[0].src as string) : null,
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
