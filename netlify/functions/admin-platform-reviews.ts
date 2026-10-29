// netlify/functions/admin-platform-reviews.ts
// Admin → Customers → Reviews: what the people using Be More Swan say about it
// (src/utils/platform-reviews.ts).
//
//   GET                                                  → { setUp, reviews, stats, asks, destinations }
//   POST { action: 'decide', id, status: 'published' | 'hidden' | 'pending' }
//   POST { action: 'save_destinations', trustpilot?, g2? }   our own "write a review" links
//
// Publishing needs the author's consent — the server refuses otherwise. Hidden reviews stay in the
// average. Nothing here edits a reviewer's words. Gated on `platform_config`, an existing permission,
// so no role data has to change before it works. Asking a beta tester by email lives on the Beta
// testers page (admin-beta.ts, action 'review_request').

import jwt from 'jsonwebtoken';
import { desc, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { organisations, platformReviewAsks, platformReviews, users } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { CONFIG_KEYS, getPlatformConfig, setPlatformConfig } from '../../src/utils/platform-config';
import { cleanDestinations, isMissingTable, REVIEW_STATUSES, reviewStats, type ReviewStatus } from '../../src/utils/platform-reviews';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function requireAdmin(event: any): Promise<{ id: number } | { error: ReturnType<typeof json> }> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return { error: json(500, { error: 'Server misconfigured.' }) };
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { error: json(401, { error: 'Not authenticated.' }) };
    let tok: { userId: number; scope?: string };
    try { tok = jwt.verify(match[1], secret) as typeof tok; } catch { return { error: json(401, { error: 'Invalid session.' }) }; }
    if (tok.scope === 'impersonate') return { error: json(403, { error: 'Action blocked during impersonation session.' }) };
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, tok.userId)).limit(1);
    return hasPermission(row?.role, 'platform_config') ? { id: tok.userId } : { error: json(403, { error: 'Forbidden.' }) };
}

export default withLambda(async (event) => {
    const method = event.httpMethod || '';
    if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const admin = await requireAdmin(event);
    if ('error' in admin) return admin.error;
    const db = getDb();

    try {
        if (method === 'GET') {
            const rows = await db.select({
                r: platformReviews, email: users.email, firstName: users.firstName, lastName: users.lastName, orgName: organisations.name,
            }).from(platformReviews)
                .leftJoin(users, eq(users.id, platformReviews.userId))
                .leftJoin(organisations, eq(organisations.id, platformReviews.organisationId))
                .orderBy(desc(platformReviews.createdAt));
            const [asks] = await db.select({
                asked: sql<number>`count(*) filter (where ${platformReviewAsks.askCount} > 0)::int`,
                optedOut: sql<number>`count(*) filter (where ${platformReviewAsks.optedOutAt} is not null)::int`,
                requested: sql<number>`count(*) filter (where ${platformReviewAsks.requestedAt} is not null)::int`,
            }).from(platformReviewAsks);
            const dest = cleanDestinations(await getPlatformConfig(CONFIG_KEYS.REVIEW_DESTINATIONS).catch(() => null));
            const reviews = rows.map(({ r, email, firstName, lastName, orgName }) => ({
                ...r, authorEmail: email, authorName: [firstName, lastName].filter(Boolean).join(' ') || null, workspaceName: orgName,
            }));
            return json(200, {
                setUp: true, reviews, stats: reviewStats(reviews),
                asks: { asked: Number(asks?.asked ?? 0), optedOut: Number(asks?.optedOut ?? 0), requested: Number(asks?.requested ?? 0) },
                destinations: dest.ok ? dest.value : {},
            });
        }

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const action = String(body.action || '');
        const ip = getAdminIp(event.headers as Record<string, string | undefined>);
        const ua = event.headers['user-agent'] || undefined;

        if (action === 'save_destinations') {
            const d = cleanDestinations(body);
            if (!d.ok) return json(400, { error: d.error });
            const before = await getPlatformConfig(CONFIG_KEYS.REVIEW_DESTINATIONS).catch(() => null);
            await setPlatformConfig(CONFIG_KEYS.REVIEW_DESTINATIONS, d.value, admin.id, 'Admin → Reviews');
            await insertAdminAuditLog({
                adminId: admin.id, action: 'review_destinations_update', targetType: 'platform_config', targetId: 0,
                previousState: (before ?? undefined) as Record<string, unknown> | undefined, newState: d.value, ipAddress: ip, userAgent: ua,
            });
            return json(200, { destinations: d.value });
        }

        if (action !== 'decide') return json(400, { error: 'Unknown action.' });
        const id = Number(body.id);
        const status = String(body.status || '') as ReviewStatus;
        if (!Number.isInteger(id)) return json(400, { error: 'id is required.' });
        if (!REVIEW_STATUSES.includes(status)) return json(400, { error: 'Unknown status.' });
        const [r] = await db.select().from(platformReviews).where(eq(platformReviews.id, id)).limit(1);
        if (!r) return json(404, { error: 'Not found.' });
        if (status === 'published' && !r.consentToPublish) return json(409, { error: 'The author did not agree to this being quoted, so it cannot be published.' });
        const now = new Date();
        await db.update(platformReviews).set({ status, decidedBy: admin.id, decidedAt: now, updatedAt: now }).where(eq(platformReviews.id, id));
        await insertAdminAuditLog({
            adminId: admin.id, action: `platform_review_${status}` as const, targetType: 'platform_review', targetId: id,
            previousState: { status: r.status }, newState: { status }, ipAddress: ip, userAgent: ua,
        });
        return json(200, { ok: true });
    } catch (err) {
        if (isMissingTable(err)) return method === 'GET' ? json(200, { setUp: false, reviews: [], stats: null, asks: null, destinations: {} }) : json(503, { error: 'Apply db/z-platform-reviews.sql first.' });
        console.error('[admin-platform-reviews]', err);
        return json(500, { error: (err as Error).message || 'Something went wrong.' });
    }
});
