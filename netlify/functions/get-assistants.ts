import { Handler } from '@netlify/functions';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, goals, scheduledPosts, userProfiles } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

// Minutes of human time saved per post created by the assistant (industry average for drafting
// a social post including research, copy, and scheduling). Admin-configurable in future.
const MINUTES_SAVED_PER_POST = 30;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // Assistants are org-owned & member-shared — list everything in the active organisation.
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    try {
        // RLS-enforced: tenant-data queries run under withTenant (app_user + app.current_org).
        const assistants = await withTenant(orgId, (tx) => tx.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            role: aiAssistants.aiAssistantJobRole,
            // roleKey drives the connection-relevance map (connection-map.js).
            // Stored in configuration.type at creation (onboarding.ts).
            roleKey: sql<string | null>`(${aiAssistants.configuration} ->> 'type')`,
            status: aiAssistants.provisioningStatus,
            isActive: aiAssistants.isActive,
            // Canonical lifecycle state machine (assistant-lifecycle-epic).
            lifecycleStatus: aiAssistants.lifecycleStatus,
        }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)));

        const assistantIds = assistants.map(a => a.id);

        // Run goals + post metrics + hourly rate in parallel
        const [goalRows, postRows, profileRow] = await Promise.all([
            // SMART Goals AC2.1.1 — per-assistant goal status counts for dashboard card micro-summary.
            // goals has no RLS (owner-path, like content_rules), so query it on the owner connection.
            assistantIds.length > 0
                ? db.select({ assistantId: goals.assistantId, status: goals.status, c: sql<number>`count(*)::int` })
                    .from(goals)
                    .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true)))
                    .groupBy(goals.assistantId, goals.status)
                : Promise.resolve([] as { assistantId: number; status: string; c: number }[]),

            // Per-assistant post counts grouped by status (draft|scheduled|published|…)
            assistantIds.length > 0
                ? db.select({
                    assistantId: scheduledPosts.assistantId,
                    status: scheduledPosts.status,
                    platform: scheduledPosts.platform,
                    c: sql<number>`count(*)::int`,
                  })
                  .from(scheduledPosts)
                  .where(and(
                      eq(scheduledPosts.organisationId, orgId),
                      inArray(scheduledPosts.assistantId, assistantIds),
                  ))
                  .groupBy(scheduledPosts.assistantId, scheduledPosts.status, scheduledPosts.platform)
                : Promise.resolve([] as { assistantId: number | null; status: string; platform: string; c: number }[]),

            // Hourly rate from the requesting user's profile preferences
            db.select({ preferences: userProfiles.preferences })
                .from(userProfiles)
                .where(eq(userProfiles.userId, userId))
                .limit(1),
        ]);

        // --- Goals summary ---
        const goalSummary = new Map<number, { onTrack: number; offTrack: number; total: number }>();
        for (const r of goalRows) {
            const s = goalSummary.get(r.assistantId) || { onTrack: 0, offTrack: 0, total: 0 };
            s.total += r.c;
            if (r.status === 'on_track') s.onTrack += r.c;
            else if (r.status !== 'pending') s.offTrack += r.c;
            goalSummary.set(r.assistantId, s);
        }

        // --- Post metrics per assistant ---
        const PUBLISHED_STATUSES = new Set(['published']);
        const SCHEDULED_STATUSES = new Set(['scheduled', 'approved', 'pending_approval', 'in_review']);

        type PlatformMetric = { created: number; scheduled: number; published: number };
        const postMetrics = new Map<number, {
            totalCreated: number;
            totalScheduled: number;
            totalPublished: number;
            byPlatform: Record<string, PlatformMetric>;
        }>();

        for (const r of postRows) {
            if (r.assistantId == null) continue;
            const aId = r.assistantId;
            if (!postMetrics.has(aId)) {
                postMetrics.set(aId, { totalCreated: 0, totalScheduled: 0, totalPublished: 0, byPlatform: {} });
            }
            const m = postMetrics.get(aId)!;
            const p = r.platform || 'unknown';
            if (!m.byPlatform[p]) m.byPlatform[p] = { created: 0, scheduled: 0, published: 0 };

            // Every row counts as "created" (all statuses represent a post that was generated)
            m.totalCreated += r.c;
            m.byPlatform[p].created += r.c;

            if (SCHEDULED_STATUSES.has(r.status)) {
                m.totalScheduled += r.c;
                m.byPlatform[p].scheduled += r.c;
            }
            if (PUBLISHED_STATUSES.has(r.status)) {
                m.totalPublished += r.c;
                m.byPlatform[p].published += r.c;
            }
        }

        // --- Hourly rate & ROI ---
        const prefs = (profileRow[0]?.preferences as Record<string, any>) || {};
        const hourlyRateGbp = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        // Assemble final response
        const withMetrics = assistants.map(a => {
            const pm = postMetrics.get(a.id) || { totalCreated: 0, totalScheduled: 0, totalPublished: 0, byPlatform: {} };
            const hoursSaved = parseFloat(((pm.totalCreated * MINUTES_SAVED_PER_POST) / 60).toFixed(1));
            const gbpSaved = hourlyRateGbp ? parseFloat((hoursSaved * hourlyRateGbp).toFixed(2)) : null;
            return {
                ...a,
                goalSummary: goalSummary.get(a.id) || { onTrack: 0, offTrack: 0, total: 0 },
                postMetrics: {
                    ...pm,
                    hoursSaved,
                    gbpSaved,
                    hourlyRateSet: hourlyRateGbp !== null,
                },
            };
        });

        return { statusCode: 200, body: JSON.stringify({ assistants: withMetrics }) };
    } catch (e) {
        console.error("Fetch Assistants Error:", e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Database error' }) };
    }
};