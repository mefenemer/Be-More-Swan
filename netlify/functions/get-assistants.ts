import { Handler } from '@netlify/functions';
import { and, eq, gte, sql, count, inArray } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, contentGenerationJobs, goals, masterAssistants, scheduledPosts, userProfiles } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { countRoiActivityByAssistant } from '../../src/utils/roi-activity';
import { parseRoiPeriod, roiPeriodStart } from '../../src/utils/roi-period';
import { summariseGoals, pickHeadlineGoal, type GoalSummary } from '../../src/utils/goal-summary';
import { getGoalMetric } from '../../src/config/goal-metrics';
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
            // The ROLE label (e.g. "Social Media Assistant"). master_assistants.name is the live
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

        // Issue #110: the "~Xh saved / £Y ROI" figures on these cards must match the assistant
        // detail page's Impact & ROI tab (get-assistant-metrics.ts) and the dashboard hero
        // (roi-stats.ts). All three now count through src/utils/roi-activity.ts, so they agree by
        // construction rather than by three copies of one formula being kept in step — which they
        // were not: each priced only posts + task runs, plus an org-wide `leads` count (Be More
        // Swan's own sales pipeline, not the tenant's) folded in when the org had a single
        // assistant. Every assistant filing its work to assistant_records scored zero.
        const period = parseRoiPeriod(event.queryStringParameters?.period);
        const periodStart = roiPeriodStart(period);

        // Run goals + post metrics + hourly rate in parallel
        const [goalRows, postRows, activeJobRows, profileRow, mult, roiByAssistant] = await Promise.all([
            // SMART Goals AC2.1.1 — the goal block on the dashboard / My Assistants card.
            //
            // Selects the ROWS rather than a GROUP BY tally. The card shows one headline goal with a
            // real progress bar ("12,000 / 20,000 followers"), which counts alone can never supply,
            // and the summary is then derived from the same rows in JS — so this stays ONE query, not
            // two. Bounded by the org's own goals, which is a handful per assistant.
            //
            // goals has no RLS (owner-path, like content_rules), so query it on the owner connection.
            assistantIds.length > 0
                ? db.select({
                    id: goals.id,
                    assistantId: goals.assistantId,
                    metricKey: goals.metricKey,
                    title: goals.title,
                    targetValue: goals.targetValue,
                    latestValue: goals.latestValue,
                    status: goals.status,
                    isPrimary: goals.isPrimary,
                    createdAt: goals.createdAt,
                  })
                    .from(goals)
                    .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true)))
                : Promise.resolve([] as any[]),

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

            // Every activity source, grouped per assistant, in four queries regardless of how
            // many assistants this org has. Includes archived ones: a card is rendered for them
            // and should still show the work they did before retirement — it is the org-level
            // AGGREGATE (roi-stats.ts) that excludes archived assistants, not the individual card.
            countRoiActivityByAssistant(db, {
                organisationId: orgId,
                assistantIds,
                windowStart: periodStart,
            }),
        ]);

        // --- Goals summary + headline goal ---
        //
        // ⚠️ The previous version read `else if (r.status !== 'pending') s.offTrack++`, which swept
        // every non-pending, non-on_track status into the RED bucket. That was already wrong for
        // `data_disconnected` (a lapsed token rendered as a failing goal) and would have been worse
        // for `awaiting_update` — a revenue goal merely waiting on this month's figure showing as
        // "1 Off Track". Both are measurement gaps, not verdicts; summariseGoals keeps them apart.
        const goalsByAssistant = new Map<number, typeof goalRows>();
        for (const r of goalRows) {
            const list = goalsByAssistant.get(r.assistantId) ?? [];
            list.push(r);
            goalsByAssistant.set(r.assistantId, list);
        }

        const goalBlock = new Map<number, { summary: GoalSummary; headline: any | null }>();
        for (const [assistantId, rows] of goalsByAssistant) {
            const head = pickHeadlineGoal(rows);
            const metric = head ? getGoalMetric(head.metricKey) : undefined;
            goalBlock.set(assistantId, {
                summary: summariseGoals(rows),
                // Everything the card needs to draw one bar, resolved here so the client never has to
                // look a metric up — its catalog copy is only ever the metrics you may pick TODAY.
                headline: head ? {
                    id: head.id,
                    metricKey: head.metricKey,
                    title: head.title,
                    metricLabel: metric?.label ?? head.metricKey,
                    unit: metric?.unit ?? '',
                    targetValue: head.targetValue,
                    latestValue: head.latestValue,
                    status: head.status,
                    isPrimary: head.isPrimary,
                    isManual: metric?.source === 'manual',
                } : null,
            });
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

        // --- Hourly rate & ROI ---
        const prefs = (profileRow[0]?.preferences as Record<string, any>) || {};
        const hourlyRateGbp = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        // Assemble final response
        const withMetrics = assistants.map(a => {
            const pm = postMetrics.get(a.id) || { totalCreated: 0, totalScheduled: 0, totalPublished: 0, byPlatform: {} };

            // Same module, same window as get-assistant-metrics.ts and roi-stats.ts, so this card
            // agrees with the assistant detail page's Impact & ROI tab and sums into the hero.
            const hoursSaved = roiByAssistant.get(a.id)?.hoursSaved ?? 0;
            const gbpSaved = hourlyRateGbp ? parseFloat((hoursSaved * hourlyRateGbp).toFixed(2)) : null;
            return {
                ...a,
                goalSummary: goalBlock.get(a.id)?.summary ?? summariseGoals([]),
                headlineGoal: goalBlock.get(a.id)?.headline ?? null,
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