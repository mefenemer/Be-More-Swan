// src/utils/shop-page.ts — a shop page for a business with no Be More Swan website (online shop Phase 1, last
// slice; feature request #35, docs/online-shop-review-plan.md §6, owner 2026-11-15). tests/shop-page.test.ts.
//
// The page is an ordinary hosted site owned by the SHOPKEEPER (sites.ai_assistant_id = the Shopkeeper; a site
// belongs to one assistant), drawn by the same renderer as every website — no second template. So it already
// has the product pages (/shop/<id>-<name>), the basket, Stripe checkout, the Delivery & returns page with the
// trader's details, the sitemap and its bemoreswan.site address. This module only writes its one page: the
// business's name and brand colours, then every product that can be bought online, in products sections of up
// to 12, and how to reach them about an order.
//
// Offered only while the workspace has no OTHER published site (a website already sells the products); one that
// is live keeps working if a website is published later. Published, updated and taken offline by a click on the
// Shop tab (owner/admin) — like a website, never a chat card (site-store.ts: "Publish is a click only"). The
// chat reads where it stands and hands out the product links.

import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, organisations, orgProducts, sites, siteVersions } from '../../db/schema';
import { normalizeBrandKit } from './brand-kit';
import { LIMITS, normaliseSiteDefinition, type SiteDefinition } from './site-definition';
import { themeFromBrandKit } from './site-draft';
import { siteOrigin, sitesDomain, suggestSiteSlug } from './site-hosting';
import { productPagePath } from './site-product-page';

type Db = ReturnType<typeof getDb>;

/**
 * ORDER BY this (with sites joined to ai_assistants) so a Website Assistant's site wins over a Shopkeeper's shop
 * page: a shop page published first stays live when a website follows, and "the business's site" (the site
 * directory, the booking link, the Stripe notice) must then mean the website (review #884).
 */
export const websiteSiteFirst = sql`CASE WHEN (${aiAssistants.configuration} ->> 'type') = 'website_assistant' THEN 0 ELSE 1 END`;

/** Products shown on the page: four products sections of 12. */
export const SHOP_PAGE_MAX_PRODUCTS = LIMITS.products * 4;

export interface ShopPageProduct { id: number; name: string }

/** The page, from the business's details. Pure. Ends in normaliseSiteDefinition, like every site write. */
export function shopPageDefinition(b: {
    name: string; description: string | null; contactEmail: string | null; brandKit: unknown; products: ShopPageProduct[];
}): SiteDefinition {
    const ids = b.products.slice(0, SHOP_PAGE_MAX_PRODUCTS).map((p) => p.id);
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += LIMITS.products) chunks.push(ids.slice(i, i + LIMITS.products));
    const sub = (b.description || '').trim();
    return normaliseSiteDefinition({
        theme: themeFromBrandKit(normalizeBrandKit(b.brandKit)),
        settings: { siteName: b.name, description: sub ? sub.slice(0, LIMITS.description) : `Shop online with ${b.name}.`, businessType: 'Store', email: b.contactEmail },
        structure: 'pages',
        pages: [{
            title: 'Shop', slug: '', sections: [
                { type: 'hero', props: { layout: 'centered', headline: b.name, subheadline: sub ? sub.slice(0, LIMITS.subheadline) : 'Order online — delivered to your door.', primaryCta: null } },
                ...chunks.map((c, i) => ({ type: 'products', props: { heading: i === 0 ? 'Shop' : null, intro: null, productIds: c, items: [], collectAddress: true, buyLabel: 'Buy now' } })),
                ...(b.contactEmail ? [{ type: 'text', props: { heading: 'Questions about an order?', body: `Email us at ${b.contactEmail} and we'll get back to you.` } }] : []),
            ],
        }],
    }).definition;
}

/** Products (not services) that can be bought online — a fixed price — in Business Information order. */
export async function shopPageProducts(db: Db, orgId: number): Promise<ShopPageProduct[]> {
    return db.select({ id: orgProducts.id, name: orgProducts.name }).from(orgProducts)
        .where(and(eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active'), eq(orgProducts.kind, 'product'), eq(orgProducts.priceType, 'fixed'), isNotNull(orgProducts.priceAmount)))
        .orderBy(asc(orgProducts.sortOrder), asc(orgProducts.id)).limit(SHOP_PAGE_MAX_PRODUCTS);
}

export interface ShopPageState {
    /** 'website' — another site of theirs is live (it sells the products); 'none' — no page yet; 'offline' — made, not live; 'live'. */
    state: 'website' | 'none' | 'offline' | 'live';
    url: string | null;
    websiteUrl: string | null;
    slug: string | null;
    suggestedSlug: string;
    /** The free addresses' domain ("bemoreswan.site"), shown after the address box. */
    domain: string;
    publishedAt: Date | null;
    /** Each product's own page, for posts and an Instagram bio (live only; only products on the published page). */
    productLinks: Array<{ id: number; name: string; url: string }>;
    /** Products for sale now that aren't on the published page yet ("Update shop page" adds them). */
    notYetOn: number;
}

/** The product ids the published version's products sections offer. */
async function publishedProductIds(db: Db, siteId: number, version: number): Promise<Set<number>> {
    const [v] = await db.select({ definition: siteVersions.definition }).from(siteVersions)
        .where(and(eq(siteVersions.siteId, siteId), eq(siteVersions.version, version))).limit(1);
    const pages = ((v?.definition as SiteDefinition | undefined)?.pages ?? []);
    return new Set(pages.flatMap((p) => p.sections).flatMap((x) => (x.type === 'products' ? (x.props as { productIds: number[] }).productIds : [])));
}

/** Where the shop page stands, for the Shop tab and the chat. */
export async function shopPageState(db: Db, orgId: number, assistantId: number): Promise<ShopPageState> {
    const [own] = await db.select().from(sites).where(and(eq(sites.organisationId, orgId), eq(sites.aiAssistantId, assistantId))).limit(1);
    const [other] = await db.select({ slug: sites.slug }).from(sites)
        .where(and(eq(sites.organisationId, orgId), ne(sites.aiAssistantId, assistantId), eq(sites.status, 'published'), isNotNull(sites.slug))).limit(1);
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const live = own?.status === 'published' && !!own.slug;
    // Links only to products ON the published page (site-serve serves /shop/<id>-<name> only for those), still
    // for sale; ones added since are counted so the owner knows to press "Update shop page" (review #884).
    const now = live ? await shopPageProducts(db, orgId) : [];
    const onPage = live && own!.publishedVersion != null ? await publishedProductIds(db, own!.id, own!.publishedVersion) : new Set<number>();
    const products = now.filter((p) => onPage.has(p.id));
    const notYetOn = now.length - products.length;
    const url = own?.slug ? siteOrigin(own.slug) : null;
    return {
        state: live ? 'live' : other ? 'website' : own?.publishedVersion != null ? 'offline' : 'none',
        url, websiteUrl: other?.slug ? siteOrigin(other.slug) : null, slug: own?.slug ?? null,
        suggestedSlug: own?.slug || suggestSiteSlug(org?.name || ''),
        domain: sitesDomain(),
        publishedAt: own?.publishedAt ?? null,
        productLinks: live && url ? products.map((p) => ({ id: p.id, name: p.name, url: `${url}${productPagePath(p)}` })) : [],
        notYetOn: live ? notYetOn : 0,
    };
}

/** For the chat snapshot. Pure. */
export function shopPageSnapshotLines(s: ShopPageState | null | undefined): string[] {
    if (!s) return [];
    if (s.state === 'website') return ['', `SHOP PAGE: not needed — their website ${s.websiteUrl} already sells the products.`];
    if (s.state === 'none') return ['', 'SHOP PAGE: none yet. With no Be More Swan website, they can publish a shop page of their own from the Shop tab ("Publish shop page", owner or admin).'];
    if (s.state === 'offline') return ['', `SHOP PAGE: made but offline (${s.url}). "Publish shop page" on the Shop tab puts it back.`];
    return ['', `SHOP PAGE: live at ${s.url}. Product links (for posts and an Instagram bio):`,
        ...s.productLinks.slice(0, 20).map((p) => `- ${p.name}: ${p.url}`),
        s.notYetOn ? `- ${s.notYetOn} product${s.notYetOn === 1 ? '' : 's'} for sale ${s.notYetOn === 1 ? 'is' : 'are'} NOT on the page yet and ${s.notYetOn === 1 ? 'has' : 'have'} no link until they press "Update shop page" on the Shop tab.` : '- Every product for sale is on the page. One added or changed later appears after "Update shop page".'];
}

export type ShopPagePublish = { ok: true; site: typeof sites.$inferSelect; oldSlug: string | null } | { ok: false; status: 400 | 409; error: string };

/**
 * Write the page from today's details and publish it at `slug` (also "Update shop page"). The caller checks who
 * may (owner/admin), that the shop can take orders, and runs the safety check on the words (`moderate`).
 */
export async function publishShopPage(db: Db, o: {
    orgId: number; assistantId: number; userId: number | null; slug: string; contactEmail: string | null;
    moderate: (def: SiteDefinition) => Promise<string | null>;
}): Promise<ShopPagePublish> {
    const [other] = await db.select({ id: sites.id }).from(sites)
        .where(and(eq(sites.organisationId, o.orgId), ne(sites.aiAssistantId, o.assistantId), eq(sites.status, 'published'))).limit(1);
    const [own0] = await db.select({ status: sites.status }).from(sites).where(and(eq(sites.organisationId, o.orgId), eq(sites.aiAssistantId, o.assistantId))).limit(1);
    if (other && own0?.status !== 'published') return { ok: false, status: 409, error: 'Your website already sells your products, so a separate shop page isn\'t needed.' };
    const products = await shopPageProducts(db, o.orgId);
    if (!products.length) return { ok: false, status: 400, error: 'Add at least one product with a fixed price in Business Information ▸ Products first.' };
    const [org] = await db.select({ name: organisations.name, description: organisations.businessDescription, brandKit: organisations.brandKit })
        .from(organisations).where(eq(organisations.id, o.orgId)).limit(1);
    const def = shopPageDefinition({ name: org?.name || 'Our shop', description: org?.description ?? null, contactEmail: o.contactEmail, brandKit: org?.brandKit ?? null, products });
    const blocked = await o.moderate(def);
    if (blocked) return { ok: false, status: 400, error: blocked };
    const { loadOrCreateSite, publishSite, setSiteAddress } = await import('./site-store');
    let site = await loadOrCreateSite(db, { orgId: o.orgId, assistantId: o.assistantId, userId: o.userId });
    const oldSlug = site.slug;
    const addr = await setSiteAddress(db, site, o.slug);
    if (!addr.ok) return { ok: false, status: 400, error: addr.error };
    [site] = await db.update(sites).set({ draft: def, updatedAt: new Date() }).where(eq(sites.id, site.id)).returning();
    const r = await publishSite(db, site, o.userId, 1);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    return { ok: true, site: r.site, oldSlug: oldSlug && oldSlug !== r.site.slug ? oldSlug : null };
}

/** Take the shop page offline (kept; "Publish shop page" puts it back). Returns its address, or null if none. */
export async function shopPageOffline(db: Db, orgId: number, assistantId: number): Promise<string | null> {
    const [own] = await db.select().from(sites).where(and(eq(sites.organisationId, orgId), eq(sites.aiAssistantId, assistantId))).limit(1);
    if (!own) return null;
    const { unpublishSite } = await import('./site-store');
    await unpublishSite(db, own);
    return own.slug;
}
