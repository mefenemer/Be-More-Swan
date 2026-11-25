// src/utils/site-product-page.ts — each product's own page on a hosted site: /shop/<id>-<name>
// (online shop Phase 1, feature request #35, docs/online-shop-review-plan.md §6). tests/site-product-page.test.ts.
//
// A product gets a page only while a products section on the PUBLISHED site offers it, so a page
// never sells something the owner took off the site. The address carries the id (the truth) and the
// name (for people and search engines); an old name 301s to the current one. The page's Buy form
// posts exactly what the section's card posts, naming the first section that offers the product, so
// checkout (site-shop.ts startCheckout) checks it the same way. Drawn by site-render.ts renderSiteProduct.
//
// Products in a menu section (food) don't get pages: a menu is read as a list.

import type { SiteDefinition } from './site-definition';

export const PRODUCT_PATH = '/shop';

/** "House Blend (250g)!" → "house-blend-250g". Never empty; at most 60 characters. */
export function productSlug(name: string): string {
    const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
    return s || 'item';
}

export const productPagePath = (p: { id: number; name: string }) => `${PRODUCT_PATH}/${p.id}-${productSlug(p.name)}`;

/** /shop/<id> or /shop/<id>-<name> → the id and the name part given; anything else → null. Any case
 *  and any URL-safe name is accepted: the id is the truth, and site-serve 301s to the current address. */
export function productRoute(path: string): { id: number; slug: string } | null {
    const m = /^\/shop\/(\d{1,9})(?:-([A-Za-z0-9._~%-]{1,160}))?\/?$/.exec((path || '').split(/[?#]/)[0]);
    if (!m) return null;
    const id = Number(m[1]);
    return id > 0 ? { id, slug: m[2] || '' } : null;
}

/** Each product a products section offers → the id of the FIRST section that offers it. */
export function productSections(def: Pick<SiteDefinition, 'pages'>): Map<number, string> {
    const out = new Map<number, string>();
    for (const page of def.pages) for (const s of page.sections) {
        if (s.type !== 'products') continue;
        for (const id of s.props.productIds) if (!out.has(id)) out.set(id, s.id);
    }
    return out;
}

/** The page whose products section first offers this product: the product page's "back" link. */
export function productHomePage(def: Pick<SiteDefinition, 'pages'>, productId: number): { path: string; title: string; id: string } | null {
    for (const page of def.pages) {
        if (page.sections.some((s) => s.type === 'products' && s.props.productIds.includes(productId))) {
            return { path: page.slug ? `/${page.slug}` : '/', title: page.title, id: page.id };
        }
    }
    return null;
}
