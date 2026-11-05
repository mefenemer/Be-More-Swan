// netlify/functions/site-listings.ts
// The Website Assistant's Listings tab (docs/website-types-plan.md §4): the workspace's own events and
// entries shown on its website (src/utils/site-listings.ts). The chat's listings_add and
// listing_decisions cards call the same actions.
//
//   GET                               → { listings, pending, categories }
//   POST   { ...listing }             → { listing }       add one (published)
//   POST   { listings: [ ... ] }      → { listings }      add several (the chat's listings_add card)
//   PATCH  { id, decision }           → { listing }       a visitor's entry: approve | decline
//   PATCH  { id, ...fields, status? } → { listing }       edit; show / hide (status published | hidden)
//   DELETE ?id=N                      → { ok: true }      remove for good
//
// Tenant-scoped on every statement. A listing's address (slug) is set once and never changes, so a
// link someone shared keeps working after an edit.

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { siteListings } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { checkWhole, cleanListing, freeSlug, LISTING_LIMITS, ownsAsset, type ListingRow } from '../../src/utils/site-listings';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** What the Listings tab and the chat card see — everything but who sent a visitor's entry is plain. */
const view = (r: ListingRow) => ({
    id: r.id, kind: r.kind, title: r.title, slug: r.slug, category: r.category, summary: r.summary, body: r.body,
    startsOn: r.startsOn, startTime: r.startTime, endsOn: r.endsOn, endTime: r.endTime, location: r.location,
    imageAssetId: r.imageAssetId, imageAlt: r.imageAlt, linkUrl: r.linkUrl, linkLabel: r.linkLabel,
    status: r.status, source: r.source, submitterName: r.submitterName, submitterEmail: r.submitterEmail,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export default withLambda(async (event) => {
    const method = event.httpMethod || '';
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    const userId = ctx.userId ?? null;

    try {
        if (method === 'GET') {
            const rows = await db.select().from(siteListings)
                .where(and(eq(siteListings.organisationId, orgId), ne(siteListings.status, 'declined')))
                .orderBy(desc(siteListings.startsOn), desc(siteListings.id)).limit(LISTING_LIMITS.perWorkspace);
            const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
            return json(200, { listings: rows.map(view), pending: rows.filter((r) => r.status === 'pending').length, categories });
        }

        if (method === 'DELETE') {
            const id = Number(event.queryStringParameters?.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
            const gone = await db.delete(siteListings).where(and(eq(siteListings.id, id), eq(siteListings.organisationId, orgId))).returning({ id: siteListings.id });
            return gone.length ? json(200, { ok: true }) : json(404, { error: 'Not found.' });
        }

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid body.' });

        if (method === 'POST') {
            const list = Array.isArray(body.listings) ? body.listings as unknown[] : [body];
            if (!list.length) return json(400, { error: 'Nothing to add.' });
            if (list.length > LISTING_LIMITS.batch) return json(400, { error: `Up to ${LISTING_LIMITS.batch} at a time.` });
            const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(siteListings).where(eq(siteListings.organisationId, orgId));
            if (Number(n) + list.length > LISTING_LIMITS.perWorkspace) return json(409, { error: `Up to ${LISTING_LIMITS.perWorkspace} listings can be kept — remove some old ones first.` });
            const values: Array<typeof siteListings.$inferInsert> = [];
            const slugs = new Set<string>();
            for (const [i, raw] of list.entries()) {
                const at = list.length > 1 ? `${i + 1}: ` : '';
                const r = cleanListing((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, false);
                if (!r.ok) return json(400, { error: `${at}${r.error}` });
                const v = r.value as Record<string, unknown>;
                const whole = checkWhole({ kind: String(v.kind), startsOn: (v.startsOn as string) ?? null, endsOn: (v.endsOn as string) ?? null, startTime: (v.startTime as string) ?? null, endTime: (v.endTime as string) ?? null, imageAssetId: (v.imageAssetId as number) ?? null, imageAlt: (v.imageAlt as string) ?? null });
                if (whole) return json(400, { error: `${at}${whole}` });
                if (v.imageAssetId && !(await ownsAsset(db, orgId, Number(v.imageAssetId)))) return json(400, { error: `${at}That picture isn't in your library.` });
                // Two in this batch with the same name: the second takes the next free number.
                const first = await freeSlug(db, orgId, String(v.title));
                let slug = first;
                for (let k = 2; slugs.has(slug); k++) slug = `${first}-${k}`;
                slugs.add(slug);
                values.push({ ...(v as object), organisationId: orgId, slug, status: 'published', source: 'owner', createdBy: userId } as typeof siteListings.$inferInsert);
            }
            const rows = await db.insert(siteListings).values(values).returning();
            return json(201, Array.isArray(body.listings) ? { listings: rows.map(view) } : { listing: view(rows[0]) });
        }

        // PATCH
        const id = Number(body.id);
        if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
        if (body.decision !== undefined) {
            // A visitor's entry: approve = shown; decline = never shown (kept out of the list).
            if (body.decision !== 'approve' && body.decision !== 'decline') return json(400, { error: 'Approve or decline.' });
            const [row] = await db.update(siteListings).set({ status: body.decision === 'approve' ? 'published' : 'declined', updatedAt: new Date() })
                .where(and(eq(siteListings.id, id), eq(siteListings.organisationId, orgId), eq(siteListings.status, 'pending'))).returning();
            return row ? json(200, { listing: view(row) }) : json(404, { error: 'That one has already been dealt with.' });
        }
        const [current] = await db.select().from(siteListings).where(and(eq(siteListings.id, id), eq(siteListings.organisationId, orgId))).limit(1);
        if (!current || current.status === 'declined') return json(404, { error: 'Not found.' });
        const r = cleanListing(body, true);
        if (!r.ok) return json(400, { error: r.error });
        const change: Record<string, unknown> = { ...r.value };
        if (body.status !== undefined) {
            if (body.status !== 'published' && body.status !== 'hidden') return json(400, { error: 'Show or hide.' });
            if (current.status === 'pending') return json(400, { error: 'Approve or decline it first.' });
            change.status = body.status;
        }
        if (!Object.keys(change).length) return json(400, { error: 'Nothing to change.' });
        const merged = { ...current, ...change } as ListingRow;
        const whole = checkWhole(merged);
        if (whole) return json(400, { error: whole });
        if (change.imageAssetId && !(await ownsAsset(db, orgId, Number(change.imageAssetId)))) return json(400, { error: 'That picture isn\'t in your library.' });
        const [row] = await db.update(siteListings).set({ ...change, updatedAt: new Date() })
            .where(and(eq(siteListings.id, id), eq(siteListings.organisationId, orgId), inArray(siteListings.status, ['published', 'hidden', 'pending']))).returning();
        return row ? json(200, { listing: view(row) }) : json(404, { error: 'Not found.' });
    } catch (err) {
        console.error('[site-listings]', method, err);
        return json(500, { error: 'Something went wrong. Please try again.' });
    }
});
