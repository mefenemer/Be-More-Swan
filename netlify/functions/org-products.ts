// netlify/functions/org-products.ts
// Business Information ▸ Products & Services. Org-wide: every assistant reads these
// (src/utils/org-products.ts), so they belong to the workspace, not to any one assistant.
//
// GET                         → { products: [...], offer: { offers, answered } }   every row, active first,
//                                                      in the business's order; offer = which kinds of field
//                                                      the tab shows (src/utils/offer-profile.ts)
// POST   { action: 'split_notes', text } → { items: [{ name, price, kind }] }   a PREVIEW of the old
//                                                      free-text notes as rows (offerings-import.ts) —
//                                                      nothing is saved; each accepted row is a normal POST
// PATCH  { offer: [kinds] }    → { offer }             the owner's answer to "What does your business offer?"
// PATCH  { introOffer: {...} } → { introOffer }        "Do you offer a free trial or introductory offer?"
//                                                      (src/utils/intro-offer.ts; GET returns it too, null =
//                                                      not answered). The tab's form and the chat card.
//
// Prices are STRUCTURED (db/z-product-pricing.sql, src/utils/product-price.ts): priceType + priceAmount
// (pence) + priceUnit, or the owner's own words (priceType 'text' + price). `price` is then written by
// the server as the displayed wording, which every assistant's prompt reads. A body that sends only
// `price` (an older client) is read with priceFromText. Also: durationMinutes (services, for bookings)
// and imageAssetId (a picture from this workspace's library — checked).
// POST   { kind, name, ... }  → { product }           add one (appended to the end of the list)
// PATCH  { id, ...fields }    → { product }           edit, archive / restore (status), or reorder (sortOrder)
// DELETE ?id=N                → { ok: true }          remove for good — the tab confirms first;
//                                                      "Archive" is the reversible way to stop using one
//
// Tenant-scoped on every statement: an id from the client only ever resolves to this org's row.

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { orgProducts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { PRODUCT_LIMITS } from '../../src/utils/org-products';
import { cleanDeposit, cleanPrice, priceFromText } from '../../src/utils/product-price';
import { cleanAllergens, cleanDietary } from '../../src/utils/product-dietary';
import { siteAssetUrl } from '../../src/utils/site-hosting';
import { cleanOffers, loadOfferProfile, saveOfferProfile } from '../../src/utils/offer-profile';
import { cleanIntroOffer, loadIntroOffer, saveIntroOffer } from '../../src/utils/intro-offer';
import { splitOfferingNotes } from '../../src/utils/offerings-import';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { contentAssets } from '../../db/schema';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Most products a workspace can hold. Prompts carry the first PRODUCT_PROMPT_MAX active ones. */
const MAX_PRODUCTS = 200;

const clip = (v: unknown, max: number): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
};

/** A link a model may copy into a customer's post must at least be a web address. */
export function cleanProductUrl(v: unknown): string | null | 'invalid' {
    const s = clip(v, PRODUCT_LIMITS.url);
    if (!s) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
    try {
        const u = new URL(withScheme);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : 'invalid';
    } catch { return 'invalid'; }
}

/** The editable fields of a request body, validated. `partial` = only what was sent (PATCH). */
export function productFields(body: Record<string, unknown>, partial: boolean, currentPrice?: { priceType: string | null; priceAmount: number | null }): { error: string } | { values: Record<string, unknown> } {
    const values: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    if (!partial || has('name')) {
        const name = clip(body.name, PRODUCT_LIMITS.name);
        if (!name) return { error: 'Give the product or service a name.' };
        values.name = name;
    }
    if (!partial || has('kind')) {
        const kind = body.kind ?? 'product';
        if (kind !== 'product' && kind !== 'service') return { error: 'Kind must be product or service.' };
        values.kind = kind;
    }
    for (const k of ['description', 'benefits', 'audience'] as const) {
        if (!partial || has(k)) values[k] = clip(body[k], PRODUCT_LIMITS[k]);
    }
    // The price: structured when priceType is sent; an older body with only `price` is read from its text.
    if (has('priceType') || (!partial && !has('price'))) {
        const pr = cleanPrice({ priceType: body.priceType, priceAmount: body.priceAmount, priceUnit: body.priceUnit, price: body.price });
        if ('error' in pr) return pr;
        Object.assign(values, pr);
    } else if (has('price')) {
        const t = priceFromText(clip(body.price, PRODUCT_LIMITS.price));
        const pr = cleanPrice({ priceType: t.priceType, priceAmount: t.priceAmount != null ? t.priceAmount / 100 : null, priceUnit: t.priceUnit, price: t.priceText ?? null });
        if ('error' in pr) return pr;
        Object.assign(values, pr);
    }
    // The deposit is checked against the price being saved (or, for an edit that leaves the price
    // alone, the stored one — the handler passes it as `currentPrice`).
    if (has('depositType')) {
        const price = { priceType: (values.priceType as string | null | undefined) ?? currentPrice?.priceType ?? null, priceAmount: (values.priceAmount as number | null | undefined) ?? currentPrice?.priceAmount ?? null };
        const dep = cleanDeposit({ depositType: body.depositType, depositAmount: body.depositAmount }, price);
        if ('error' in dep) return dep;
        Object.assign(values, dep);
    }
    // Dietary markers (a closed set) and the owner's allergen words — for menus (product-dietary.ts).
    if (!partial || has('dietary')) values.dietary = cleanDietary(body.dietary);
    if (!partial || has('allergens')) values.allergens = cleanAllergens(body.allergens);
    if (!partial || has('durationMinutes')) {
        const d = body.durationMinutes === null || body.durationMinutes === '' || body.durationMinutes === undefined ? null : Number(body.durationMinutes);
        if (d !== null && (!Number.isInteger(d) || d <= 0 || d > 1440)) return { error: 'The length must be in whole minutes, up to 24 hours.' };
        values.durationMinutes = d;
    }
    if (!partial || has('imageAssetId')) {
        const a = body.imageAssetId === null || body.imageAssetId === '' || body.imageAssetId === undefined ? null : Number(body.imageAssetId);
        if (a !== null && (!Number.isInteger(a) || a <= 0)) return { error: 'That picture isn\'t valid.' };
        values.imageAssetId = a;   // ownership checked by the handler (needs the database)
    }
    if (!partial || has('url')) {
        const url = cleanProductUrl(body.url);
        if (url === 'invalid') return { error: 'The link must be a web address (https://…).' };
        values.url = url;
    }
    if (has('status')) {
        if (body.status !== 'active' && body.status !== 'archived') return { error: 'Status must be active or archived.' };
        values.status = body.status;
    }
    if (has('sortOrder')) {
        const n = Number(body.sortOrder);
        if (!Number.isInteger(n) || n < 0 || n > 100_000) return { error: 'Invalid order.' };
        values.sortOrder = n;
    }
    return { values };
}

const COLUMNS = {
    id: orgProducts.id, kind: orgProducts.kind, name: orgProducts.name, description: orgProducts.description,
    benefits: orgProducts.benefits, price: orgProducts.price, audience: orgProducts.audience, url: orgProducts.url,
    priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount, priceUnit: orgProducts.priceUnit,
    durationMinutes: orgProducts.durationMinutes, imageAssetId: orgProducts.imageAssetId,
    depositType: orgProducts.depositType, depositAmount: orgProducts.depositAmount,
    dietary: orgProducts.dietary, allergens: orgProducts.allergens,
    status: orgProducts.status, sortOrder: orgProducts.sortOrder, updatedAt: orgProducts.updatedAt,
};

/** A picture may be used only if it is this workspace's, a picture, and not refused by moderation. */
async function pictureIsOurs(db: ReturnType<typeof getDb>, orgId: number, assetId: number | null | undefined): Promise<boolean> {
    if (!assetId) return true;
    const [a] = await db.select({ assetType: contentAssets.assetType, status: contentAssets.status }).from(contentAssets)
        .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId))).limit(1);
    return !!a && a.assetType === 'image' && a.status !== 'rejected';
}

export default withLambda(async (event) => {
    const method = event.httpMethod || '';
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    try {
        if (method === 'GET') {
            const products = await db.select(COLUMNS).from(orgProducts)
                .where(eq(orgProducts.organisationId, orgId))
                // Active first, then the business's own order.
                .orderBy(desc(sql`${orgProducts.status} = 'active'`), asc(orgProducts.sortOrder), asc(orgProducts.id));
            // The picture's link, for the editor's thumbnail (the same signed link sites and emails use).
            const base = resolveBaseUrl(event.headers as Record<string, string | undefined>) || 'https://bemoreswan.com';
            const [offer, introOffer] = await Promise.all([loadOfferProfile(db, orgId), loadIntroOffer(db, orgId)]);
            return json(200, { products: products.map((p) => ({ ...p, imageUrl: p.imageAssetId ? siteAssetUrl(base, p.imageAssetId) : null })), offer, introOffer });
        }

        let body: Record<string, unknown> = {};
        if (method !== 'DELETE') {
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid body.' });
        }

        if (method === 'POST' && body.action === 'split_notes') {
            return json(200, { items: splitOfferingNotes(body.text) });
        }

        if (method === 'POST') {
            const parsed = productFields(body, false);
            if ('error' in parsed) return json(400, parsed);
            if (!(await pictureIsOurs(db, orgId, parsed.values.imageAssetId as number | null))) return json(400, { error: 'Only pictures from your own library can be used.' });
            const [{ n, maxOrder }] = await db.select({
                n: sql<number>`count(*)::int`, maxOrder: sql<number>`coalesce(max(${orgProducts.sortOrder}), -1)::int`,
            }).from(orgProducts).where(eq(orgProducts.organisationId, orgId));
            if (n >= MAX_PRODUCTS) return json(409, { error: `A workspace can hold up to ${MAX_PRODUCTS} products and services. Archive or remove one first.` });
            const [product] = await db.insert(orgProducts).values({
                ...(parsed.values as { name: string }),
                organisationId: orgId, createdBy: ctx.userId ?? null, status: 'active', sortOrder: maxOrder + 1,
            }).returning(COLUMNS);
            return json(201, { product });
        }

        if (method === 'PATCH' && Object.prototype.hasOwnProperty.call(body, 'offer')) {
            const offers = cleanOffers(body.offer);
            if (!offers) return json(400, { error: 'offer must be a list.' });
            try {
                return json(200, { offer: await saveOfferProfile(db, orgId, offers, ctx.userId ?? null) });
            } catch (err) {
                console.error('[org-products] offer save failed — is db/z-org-offer-profile.sql applied?', err);
                return json(503, { error: 'That choice could not be saved just yet. Please try again later.' });
            }
        }

        if (method === 'PATCH' && Object.prototype.hasOwnProperty.call(body, 'introOffer')) {
            const parsed = cleanIntroOffer(body.introOffer);
            if ('error' in parsed) return json(400, parsed);
            try {
                return json(200, { introOffer: await saveIntroOffer(db, orgId, parsed.offer, ctx.userId ?? null) });
            } catch (err) {
                console.error('[org-products] intro offer save failed — is db/z-org-intro-offer.sql applied?', err);
                return json(503, { error: 'Your offer could not be saved just yet. Please try again later.' });
            }
        }

        if (method === 'PATCH') {
            const id = Number(body.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
            // A deposit is checked against the price — the stored one, when this edit leaves it alone.
            const [current] = Object.prototype.hasOwnProperty.call(body, 'depositType')
                ? await db.select({ priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount }).from(orgProducts).where(and(eq(orgProducts.id, id), eq(orgProducts.organisationId, orgId))).limit(1)
                : [];
            const parsed = productFields(body, true, current);
            if ('error' in parsed) return json(400, parsed);
            if (!Object.keys(parsed.values).length) return json(400, { error: 'Nothing to change.' });
            if (!(await pictureIsOurs(db, orgId, parsed.values.imageAssetId as number | null))) return json(400, { error: 'Only pictures from your own library can be used.' });
            const [product] = await db.update(orgProducts)
                .set({ ...parsed.values, updatedAt: new Date() })
                .where(and(eq(orgProducts.id, id), eq(orgProducts.organisationId, orgId)))
                .returning(COLUMNS);
            return product ? json(200, { product }) : json(404, { error: 'Product not found.' });
        }

        // DELETE
        const id = Number(event.queryStringParameters?.id);
        if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
        const gone = await db.delete(orgProducts)
            .where(and(eq(orgProducts.id, id), eq(orgProducts.organisationId, orgId)))
            .returning({ id: orgProducts.id });
        return gone.length ? json(200, { ok: true }) : json(404, { error: 'Product not found.' });
    } catch (err) {
        console.error('[org-products]', method, err);
        return json(500, { error: 'Products could not be saved right now. Please try again.' });
    }
});
