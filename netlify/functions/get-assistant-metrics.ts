// GET ?id=<assistantId>
// Returns per-platform post counts (created / scheduled / published) for a single assistant,
// plus hours saved and GBP saved based on the user's configured hourly rate.

import { Handler } from '@netlify/functions';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, scheduledPosts, userProfiles } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const MINUTES_SAVED_PER_POST = 30;

const PUBLISHED_STATUSES = new Set(['published']);
const SCHEDULED_STATUSES = new Set(['scheduled', 'approved', 'pending_approval', 'in_review']);

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    const aId = parseInt(assistantId);

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    try {
        // IDOR guard
        const [assistant] = await withTenant(orgId, (tx) =>
            tx.select({ id: aiAssistants.id })
              .from(aiAssistants)
              .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
              .limit(1)
        );
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

        const [postRows, profileRow] = await Promise.all([
            db.select({
                status: scheduledPosts.status,
                platform: scheduledPosts.platform,
                c: sql<number>`count(*)::int`,
            })
            .from(scheduledPosts)
            .where(and(eq(scheduledPosts.assistantId, aId), eq(scheduledPosts.organisationId, orgId)))
            .groupBy(scheduledPosts.status, scheduledPosts.platform),

            db.select({ preferences: userProfiles.preferences })
              .from(userProfiles)
              .where(eq(userProfiles.userId, userId))
              .limit(1),
        ]);

        const prefs = (profileRow[0]?.preferences as Record<string, any>) || {};
        const hourlyRateGbp = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        // Aggregate by platform
        const byPlatform: Record<string, { created: number; scheduled: number; published: number }> = {};
        let totalCreated = 0, totalScheduled = 0, totalPublished = 0;

        for (const r of postRows) {
            const p = r.platform || 'unknown';
            if (!byPlatform[p]) byPlatform[p] = { created: 0, scheduled: 0, published: 0 };
            byPlatform[p].created += r.c;
            totalCreated += r.c;
            if (SCHEDULED_STATUSES.has(r.status)) { byPlatform[p].scheduled += r.c; totalScheduled += r.c; }
            if (PUBLISHED_STATUSES.has(r.status)) { byPlatform[p].published += r.c; totalPublished += r.c; }
        }

        const hoursSaved = parseFloat(((totalCreated * MINUTES_SAVED_PER_POST) / 60).toFixed(1));
        const gbpSaved = hourlyRateGbp ? parseFloat((hoursSaved * hourlyRateGbp).toFixed(2)) : null;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                totalCreated,
                totalScheduled,
                totalPublished,
                byPlatform,
                hoursSaved,
                gbpSaved,
                hourlyRateSet: hourlyRateGbp !== null,
                minutesPerPost: MINUTES_SAVED_PER_POST,
            }),
        };
    } catch (err) {
        console.error('[get-assistant-metrics]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load metrics.' }) };
    }
};
