// netlify/functions/org-products.ts
// Business Information ▸ Products & Services. Org-wide: every assistant reads these
// (src/utils/org-products.ts), so they belong to the workspace, not to any one assistant.
//
// GET                         → { products: [...] }   every row, active first, in the business's order
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
export function productFields(body: Record<string, unknown>, partial: boolean): { error: string } | { values: Record<string, unknown> } {
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
    for (const k of ['description', 'benefits', 'price', 'audience'] as const) {
        if (!partial || has(k)) values[k] = clip(body[k], PRODUCT_LIMITS[k]);
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
    status: orgProducts.status, sortOrder: orgProducts.sortOrder, updatedAt: orgProducts.updatedAt,
};

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
            return json(200, { products });
        }

        let body: Record<string, unknown> = {};
        if (method !== 'DELETE') {
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid body.' });
        }

        if (method === 'POST') {
            const parsed = productFields(body, false);
            if ('error' in parsed) return json(400, parsed);
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

        if (method === 'PATCH') {
            const id = Number(body.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
            const parsed = productFields(body, true);
            if ('error' in parsed) return json(400, parsed);
            if (!Object.keys(parsed.values).length) return json(400, { error: 'Nothing to change.' });
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
