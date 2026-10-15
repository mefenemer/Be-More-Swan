// netlify/functions/org-reviews.ts
// Business Information ▸ Reviews. The business's real reviews, word for word (src/utils/reviews.ts).
//
//   GET                              → { reviews, summary, pending, settings, asked }
//   PUT    { ...settings }           → { settings }    asking customers for reviews (review-requests.ts)
//   PATCH  { id, decision }          → { review }      a customer-sent review: approve | decline
//   POST   { ...review }             → { review }      add one
//   POST   { reviews: [ ... ] }      → { reviews }     add several at once (the chat's reviews_add card)
//   PATCH  { id, ... }               → { review }      edit; show / hide (status)
//   DELETE ?id=N                     → { ok: true }    remove for good
//
// Tenant-scoped on every statement. Hiding keeps a review in the average; only deleting removes it.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { orgReviews, reviewRequests } from '../../db/schema';
import { cleanReviewRequestSettings, reviewSettingsFor, saveReviewRequestSettings } from '../../src/utils/review-requests';
import { requireTenant } from '../../src/utils/tenant';
import { cleanReview, COUNTED_STATUSES, REVIEW_LIMITS, reviewSummary } from '../../src/utils/reviews';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default withLambda(async (event) => {
    const method = event.httpMethod || '';
    if (!['GET', 'PUT', 'POST', 'PATCH', 'DELETE'].includes(method)) return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    const userId = ctx.userId ?? null;

    try {
        if (method === 'GET') {
            const reviews = await db.select().from(orgReviews)
                .where(and(eq(orgReviews.organisationId, orgId), inArray(orgReviews.status, [...COUNTED_STATUSES])))
                .orderBy(desc(orgReviews.reviewedOn), desc(orgReviews.id));
            const pending = await db.select().from(orgReviews)
                .where(and(eq(orgReviews.organisationId, orgId), eq(orgReviews.status, 'pending'))).orderBy(desc(orgReviews.createdAt));
            const since = new Date(Date.now() - 30 * 86_400_000);
            const [asked] = await db.select({ sent: sql<number>`count(*) filter (where ${reviewRequests.sentAt} is not null)::int`, answered: sql<number>`count(*) filter (where ${reviewRequests.respondedAt} is not null)::int` })
                .from(reviewRequests).where(and(eq(reviewRequests.organisationId, orgId), gte(reviewRequests.createdAt, since)));
            return json(200, { reviews, summary: reviewSummary(reviews), pending, settings: await reviewSettingsFor(db, orgId), asked: { sent: Number(asked?.sent ?? 0), answered: Number(asked?.answered ?? 0) } });
        }

        if (method === 'DELETE') {
            const id = Number(event.queryStringParameters?.id);
            if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
            const gone = await db.delete(orgReviews).where(and(eq(orgReviews.id, id), eq(orgReviews.organisationId, orgId))).returning({ id: orgReviews.id });
            return gone.length ? json(200, { ok: true }) : json(404, { error: 'Not found.' });
        }

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Invalid body.' });

        if (method === 'PUT') {
            const r = cleanReviewRequestSettings(body);
            if (!r.ok) return json(400, { error: r.error });
            return json(200, { settings: await saveReviewRequestSettings(db, orgId, r.value) });
        }

        if (method === 'POST') {
            const list = Array.isArray(body.reviews) ? body.reviews as unknown[] : [body];
            if (!list.length) return json(400, { error: 'Nothing to add.' });
            if (list.length > REVIEW_LIMITS.batch) return json(400, { error: `Up to ${REVIEW_LIMITS.batch} reviews at a time.` });
            const values: Array<Record<string, unknown>> = [];
            for (const [i, raw] of list.entries()) {
                const r = cleanReview((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, false);
                if (!r.ok) return json(400, { error: list.length > 1 ? `Review ${i + 1}: ${r.error}` : r.error });
                values.push({ ...r.value, organisationId: orgId, createdBy: userId, status: 'published' });
            }
            const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(orgReviews).where(eq(orgReviews.organisationId, orgId));
            if (Number(n) + values.length > REVIEW_LIMITS.perWorkspace) return json(409, { error: `Up to ${REVIEW_LIMITS.perWorkspace} reviews can be kept.` });
            const rows = await db.insert(orgReviews).values(values as Array<typeof orgReviews.$inferInsert>).returning();
            return json(201, Array.isArray(body.reviews) ? { reviews: rows } : { review: rows[0] });
        }

        // PATCH
        const id = Number(body.id);
        if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
        if (body.decision !== undefined) {
            // A customer-sent review. Approve = shown (they agreed to that); decline = never shown and
            // not counted — for one that isn't genuine, is offensive or isn't about this business.
            if (body.decision !== 'approve' && body.decision !== 'decline') return json(400, { error: 'Approve or decline.' });
            const [review] = await db.update(orgReviews).set({ status: body.decision === 'approve' ? 'published' : 'declined', updatedAt: new Date() })
                .where(and(eq(orgReviews.id, id), eq(orgReviews.organisationId, orgId), eq(orgReviews.status, 'pending'))).returning();
            return review ? json(200, { review }) : json(404, { error: 'That review has already been dealt with.' });
        }
        const r = cleanReview(body, true);
        if (!r.ok) return json(400, { error: r.error });
        if (!Object.keys(r.value).length) return json(400, { error: 'Nothing to change.' });
        const [review] = await db.update(orgReviews).set({ ...r.value, updatedAt: new Date() })
            .where(and(eq(orgReviews.id, id), eq(orgReviews.organisationId, orgId), inArray(orgReviews.status, [...COUNTED_STATUSES]))).returning();
        return review ? json(200, { review }) : json(404, { error: 'Not found.' });
    } catch (err) {
        console.error('[org-reviews]', method, err);
        return json(500, { error: 'Something went wrong. Please try again.' });
    }
});
