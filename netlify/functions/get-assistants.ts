import { Handler } from '@netlify/functions';
import { and, eq, gte, sql, count, inArray } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, contentGenerationJobs, goals, masterAssistants, scheduledPosts, taskRuns, userProfiles, leads } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { parseRoiPeriod, roiPeriodStart } from '../../src/utils/roi-period';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
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
            // The user's chosen name for THEIR assistant (e.g. "Sam") — stable, never follows a rename.
            name: aiAssistants.name,
            // The ROLE label (e.g. "The Social Media Manager"). master_assistants.name is the live
            // source and is admin-editable; ai_assistants.ai_assistant_job_role is only a snapshot
            // copied at hire time, so on its own it goes stale the moment an admin renames the role.
            // Legacy rows with no masterAssistantId keep the snapshot as a fallback.
            role: sql<string | null>`coalesce(${masterAssistants.name}, ${aiAssistants.aiAssistantJobRole})`,
            // roleKey drives the connection-relevance map (connection-map.js).
            // Stored in configuration.type at creation (onboarding.ts).
            roleKey: sql<string | null>`(${aiAssistants.configuration} ->> 'type')`,
            status: aiAssistants.provisioningStatus,
            isActive: aiAssistants.isActive,
            // Canonical lifecycle state machine (assistant-lifecycle-epic).
            lifecycleStatus: aiAssistants.lifecycleStatus,
        }).from(aiAssistants)
            .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
            .where(eq(aiAssistants.organisationId, orgId)));

        const assistantIds = assistants.map(a => a.id);

        // Issue #110: the "~Xh saved / £Y ROI" figures on these cards must match the
        // assistant detail page's Impact & ROI tab (get-assistant-metrics.ts) — same
        // period window, same formula (posts + completed task runs + org leads when this
        // is the org's sole assistant), not the old all-time posts-only estimate.
        const period = parseRoiPeriod(event.queryStringParameters?.period);
        const periodStart = roiPeriodStart(period);
        // Org leads (which have no assistantId) are only attributable to a card when the org
        // has a single assistant — but count only ACTIVE (non-archived) assistants here, so
        // that an org with one active assistant plus retired ones still attributes leads, and
        // stays consistent with the dashboard ROI hero (roi-stats.ts), which likewise scopes
        // its aggregate to active assistants. 'active' == not archived.
        const activeAssistantCount = assistants.filter(a => a.lifecycleStatus !== 'archived').length;
        const isOnlyAssistantInOrg = activeAssistantCount === 1;

        // Run goals + post metrics + hourly rate in parallel
        const [goalRows, postRows, activeJobRows, profileRow, mult, postsInPeriodRows, taskRunsInPeriodRows, [{ leadsInPeriod }]] = await Promise.all([
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

            // Operational signal (Epic 1 AC1.1.2): mid-flight generation jobs per assistant, same
            // "active" statuses the detail page's Recent Activity loader uses (get-assistant-activity.ts)
            // to drive the "Executing Task" sub-state. Mirrored here so the list card matches.
            assistantIds.length > 0
                ? db.select({ assistantId: contentGenerationJobs.assistantId, c: sql<number>`count(*)::int` })
                    .from(contentGenerationJobs)
                    .where(and(
                        eq(contentGenerationJobs.organisationId, orgId),
                        inArray(contentGenerationJobs.assistantId, assistantIds),
                        inArray(contentGenerationJobs.status, ['processing', 'queued', 'pending']),
                    ))
                    .groupBy(contentGenerationJobs.assistantId)
                : Promise.resolve([] as { assistantId: number | null; c: number }[]),

            // Hourly rate from the requesting user's profile preferences
            db.select({ preferences: userProfiles.preferences })
                .from(userProfiles)
                .where(eq(userProfiles.userId, userId))
                .limit(1),

            getTimeMultipliers(),

            // Posts drafted in the period, per assistant — same window as get-assistant-metrics.ts.
            assistantIds.length > 0
                ? db.select({ assistantId: scheduledPosts.assistantId, c: sql<number>`count(*)::int` })
                    .from(scheduledPosts)
                    .where(and(
                        eq(scheduledPosts.organisationId, orgId),
                        inArray(scheduledPosts.assistantId, assistantIds),
                        gte(scheduledPosts.createdAt, periodStart),
                    ))
                    .groupBy(scheduledPosts.assistantId)
                : Promise.resolve([] as { assistantId: number | null; c: number }[]),

            // Completed task runs in the period, per assistant — windowed on
            // COALESCE(completed_at, created_at), same as get-assistant-metrics.ts.
            assistantIds.length > 0
                ? db.select({ assistantId: taskRuns.assistantId, c: sql<number>`count(*)::int` })
                    .from(taskRuns)
                    .where(and(
                        eq(taskRuns.organisationId, orgId),
                        inArray(taskRuns.assistantId, assistantIds),
                        eq(taskRuns.status, 'completed'),
                        gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, periodStart.toISOString()),
                    ))
                    .groupBy(taskRuns.assistantId)
                : Promise.resolve([] as { assistantId: number | null; c: number }[]),

            // Org-wide leads in the period — `leads` has no assistantId, so this is only
            // folded into a card's total when the org has exactly one assistant (see
            // isOnlyAssistantInOrg above and get-assistant-metrics.ts for the same rule).
            db.select({ leadsInPeriod: count() })
                .from(leads)
                .where(and(
                    eq(leads.organisationId, orgId),
                    gte(leads.createdAt, periodStart),
                )),
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

        // Operational signal: drafts awaiting the user (same status the detail page's
        // "Awaiting Human Review" sub-state reads via get-social-drafts?status=pending_approval).
        const pendingReviewCount = new Map<number, number>();

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
            if (r.status === 'pending_approval') {
                pendingReviewCount.set(aId, (pendingReviewCount.get(aId) || 0) + r.c);
            }
        }

        const activeJobCount = new Map<number, number>();
        for (const r of activeJobRows) {
            if (r.assistantId == null) continue;
            activeJobCount.set(r.assistantId, r.c);
        }

        const postsInPeriod = new Map<number, number>();
        for (const r of postsInPeriodRows) {
            if (r.assistantId == null) continue;
            postsInPeriod.set(r.assistantId, r.c);
        }
        const taskRunsInPeriod = new Map<number, number>();
        for (const r of taskRunsInPeriodRows) {
            if (r.assistantId == null) continue;
            taskRunsInPeriod.set(r.assistantId, r.c);
        }

        // --- Hourly rate & ROI ---
        const prefs = (profileRow[0]?.preferences as Record<string, any>) || {};
        const hourlyRateGbp = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        // Assemble final response
        const withMetrics = assistants.map(a => {
            const pm = postMetrics.get(a.id) || { totalCreated: 0, totalScheduled: 0, totalPublished: 0, byPlatform: {} };

            // Same formula/window as get-assistant-metrics.ts (posts + completed task runs +
            // org leads when this is the org's sole assistant) so the dashboard/My Assistants
            // cards always agree with the assistant detail page's Impact & ROI tab.
            const totalMinutesInPeriod = (postsInPeriod.get(a.id) || 0) * mult.content_drafted
                + (taskRunsInPeriod.get(a.id) || 0) * mult.tasks_completed
                + (isOnlyAssistantInOrg ? Number(leadsInPeriod) * mult.leads_generated : 0);
            const hoursSaved = parseFloat((totalMinutesInPeriod / 60).toFixed(1));
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
                // Feeds the same "working" sub-state refinement (Executing Task / Awaiting
                // Human Review / Idle) the assistant-detail pill uses, so the list card matches.
                opSignals: {
                    activeJobCount: activeJobCount.get(a.id) || 0,
                    pendingReview: pendingReviewCount.get(a.id) || 0,
                },
            };
        });

        return { statusCode: 200, body: JSON.stringify({ assistants: withMetrics }) };
    } catch (e) {
        console.error("Fetch Assistants Error:", e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Database error' }) };
    }
});