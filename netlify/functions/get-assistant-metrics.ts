// GET ?id=<assistantId>&period=all|month|week (default week; the detail page always
// passes one explicitly, and defaults to 'all' — see _fetchAndRenderAssistantMetrics)
// Returns per-platform post counts (created / scheduled / published) for a single assistant,
// plus hours saved and GBP saved based on the user's configured hourly rate.

import { Handler } from '@netlify/functions';
import { and, eq, ne, gte, sql, count, type SQL } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, scheduledPosts, taskRuns, userProfiles, leads } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import type { PostStatus } from '../../src/config/post-status';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { parseRoiPeriod, roiPeriodStart } from '../../src/utils/roi-period';
import { withLambda } from '@netlify/aws-lambda-compat';

// ── What the Created / Scheduled / Published tiles actually mean ─────────────────────────────────
// These lists are the headline card's vocabulary, and they are NOT the same question as
// src/config/post-status.ts's SCHEDULE_ACTIVE_STATUSES (which answers "does this belong on the
// calendar" and therefore includes 'published' and 'failed' — both wrong for a "Scheduled" tile).
//
// The previous version put 'pending_approval' and 'in_review' in SCHEDULED, so every draft waiting
// in the Review Queue was reported to the user as booked to go out. On a real assistant that made
// the Scheduled tile read 49 while the Scheduled tab listed 9 — the tile was counting work the user
// had not yet approved, and counting it per-platform on top (see the grouping note below).
const DISCARDED_STATUSES = ['rejected', 'cancelled', 'admin_test'] as const satisfies readonly PostStatus[];
/** Committed to go out and not yet out. Excludes 'published' (already gone) and 'failed' (won't go without help). */
const BOOKED_STATUSES = ['approved', 'scheduled', 'publishing', 'paused', 'paused_credits'] as const satisfies readonly PostStatus[];
/** Waiting on a human. Reported separately so it can never be mistaken for a booked slot again. */
const AWAITING_REVIEW_STATUSES = ['pending_approval', 'in_review'] as const satisfies readonly PostStatus[];
/** Tried and stopped. Surfaced so a failed post is a number somewhere instead of nowhere. */
const ATTENTION_STATUSES = ['failed'] as const satisfies readonly PostStatus[];

const quoted = (xs: readonly string[]) => sql.raw(xs.map(s => `'${s}'`).join(', '));

/**
 * `count(distinct <post key>) filter (where <predicate>)`, aliased and cast.
 *
 * Two things here are load-bearing and both were wrong when written inline:
 *   • the cast is PARENTHESISED. `count(…) filter (where …)::int` leans on precedence between the
 *     FILTER clause and `::`; wrapping it removes the question entirely.
 *   • the column is ALIASED. drizzle does not alias raw sql select fields, so five bare `count(…)`
 *     expressions all come back named "count" and the driver collapses them into one — every tile
 *     would have silently reported the same number.
 */
const groupedCount = (predicate: SQL, alias: string) =>
    sql<number>`(count(distinct coalesce(${scheduledPosts.crosspostGroupId}::text, 'id:' || ${scheduledPosts.id})) filter (where ${predicate}))::int`.as(alias);

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId || Number.isNaN(parseInt(assistantId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
    }
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

        // Issue #110: the hero "hours/£ saved" figures must match the dashboard's
        // roi-stats widget. The dashboard has a This Week / This Month toggle, so
        // this endpoint takes the same ?period param and computes the window via
        // the shared roiPeriodStart helper — a hard-coded week here diverged from
        // the dashboard whenever it was on the month view (the calendar week can
        // reach into the previous month, so "this week" can exceed "this month").
        // The totals below (created/scheduled/published breakdown) stay all-time;
        // only the ROI hero uses this window.
        const period = parseRoiPeriod(event.queryStringParameters?.period);
        const periodStart = roiPeriodStart(period);

        // Issue #110 (follow-up): roi-stats.ts (dashboard) sums leads generated org-wide
        // into its hero figure, because the `leads` table has no assistantId to attribute
        // rows to a specific assistant. That's fine for the org total, but left this
        // per-assistant endpoint permanently short of the dashboard by however many leads
        // came in during the period — even for an org with a single assistant, where the
        // org total and this assistant's total should be identical. Since attribution is
        // only unambiguous when there's exactly one assistant in the org, count leads here
        // too, but only when that holds.
        // Count only ACTIVE (non-archived) assistants, so lead attribution here matches
        // get-assistants.ts (the cards) and roi-stats.ts (the dashboard ROI hero), which
        // all scope to active assistants. 'active' == not archived.
        const [assistantCountRow] = await withTenant(orgId, (tx) =>
            tx.select({ c: count() }).from(aiAssistants).where(and(
                eq(aiAssistants.organisationId, orgId),
                ne(aiAssistants.lifecycleStatus, 'archived'),
            ))
        );
        const isOnlyAssistantInOrg = Number(assistantCountRow?.c ?? 0) === 1;

        // ── Two different questions, deliberately two different queries ──────────────────────────
        // A cross-post is one scheduled_posts row PER PLATFORM sharing a crosspost_group_id.
        //
        //   TOTALS (the tiles)      count POSTS — a cross-post to four platforms is one post, which
        //                           is what the Review Queue, the calendar and the user all mean by
        //                           "a post". Counting rows here is why the tile read 49 against the
        //                           Scheduled tab's 9 for the same work.
        //   BREAKDOWN (per platform) counts ROWS — "Content by platform" exists precisely to split a
        //                           cross-post back into its per-platform sends. Grouping it would
        //                           erase the only thing it has to say.
        //
        // So the two genuinely disagree, and that is correct. The UI labels the breakdown as
        // per-platform sends so the difference reads as a breakdown rather than a contradiction.
        const postScope = and(eq(scheduledPosts.assistantId, aId), eq(scheduledPosts.organisationId, orgId));
        // One post = its crosspost group, or itself when it has none (inside groupedCount). Same rule
        // as the browser's _rqGroupKey and calendar.js's _groupKey, so all three agree on what "one
        // post" is.
        //
        // count(DISTINCT …) FILTER per tile rather than summing per-status counts: a cross-post whose
        // siblings sit in different statuses (2 published + 1 failed is real, and in prod today) must
        // count ONCE in Created, not once per status it touches.
        //
        // Plain db.select with an explicit organisationId predicate, matching the breakdown query
        // below — both are already tenant-scoped by `postScope`.
        const [totalsRow] = await db.select({
            created: groupedCount(sql`${scheduledPosts.status} not in (${quoted(DISCARDED_STATUSES)})`, 'created'),
            scheduled: groupedCount(sql`${scheduledPosts.status} in (${quoted(BOOKED_STATUSES)})`, 'scheduled'),
            published: groupedCount(sql`${scheduledPosts.status} = 'published'`, 'published'),
            // Aliases match their JS keys exactly (drizzle quotes them, so the case survives) —
            // there is then no question of which name the row is read back by.
            awaitingReview: groupedCount(sql`${scheduledPosts.status} in (${quoted(AWAITING_REVIEW_STATUSES)})`, 'awaitingReview'),
            needsAttention: groupedCount(sql`${scheduledPosts.status} in (${quoted(ATTENTION_STATUSES)})`, 'needsAttention'),
        }).from(scheduledPosts).where(postScope);

        const [postRows, profileRow, mult, [{ postsInPeriod }], [{ taskRunsInPeriod }], [{ leadsInPeriod }]] = await Promise.all([
            db.select({
                status: scheduledPosts.status,
                platform: scheduledPosts.platform,
                c: sql<number>`count(*)::int`,
            })
            .from(scheduledPosts)
            .where(postScope)
            .groupBy(scheduledPosts.status, scheduledPosts.platform),

            db.select({ preferences: userProfiles.preferences })
              .from(userProfiles)
              .where(eq(userProfiles.userId, userId))
              .limit(1),

            getTimeMultipliers(),

            db.select({ postsInPeriod: count() })
              .from(scheduledPosts)
              .where(and(
                  eq(scheduledPosts.assistantId, aId),
                  eq(scheduledPosts.organisationId, orgId),
                  gte(scheduledPosts.createdAt, periodStart)
              )),

            // Issue #110 (follow-up): window on COALESCE(completed_at, created_at) —
            // see roi-stats.ts for why filtering on created_at alone can zero this out.
            db.select({ taskRunsInPeriod: count() })
              .from(taskRuns)
              .where(and(
                  eq(taskRuns.assistantId, aId),
                  eq(taskRuns.organisationId, orgId),
                  eq(taskRuns.status, 'completed'),
                  gte(sql`coalesce(${taskRuns.completedAt}, ${taskRuns.createdAt})`, periodStart.toISOString())
              )),

            // Org-wide, since `leads` has no assistantId — only meaningful to fold in when
            // this is the org's sole assistant (see isOnlyAssistantInOrg above).
            db.select({ leadsInPeriod: count() })
              .from(leads)
              .where(and(
                  eq(leads.organisationId, orgId),
                  gte(leads.createdAt, periodStart)
              )),
        ]);

        const prefs = (profileRow[0]?.preferences as Record<string, any>) || {};
        const hourlyRateGbp = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        // Per-platform SENDS (rows). Uses the same vocabulary as the tiles so a platform's bar and
        // the headline can be reconciled, but stays row-level — see the note on the queries above.
        const DISCARDED = new Set<string>(DISCARDED_STATUSES);
        const BOOKED = new Set<string>(BOOKED_STATUSES);
        const byPlatform: Record<string, { created: number; scheduled: number; published: number }> = {};

        for (const r of postRows) {
            if (DISCARDED.has(r.status)) continue;   // a turned-down post is not content this assistant produced
            const p = r.platform || 'unknown';
            if (!byPlatform[p]) byPlatform[p] = { created: 0, scheduled: 0, published: 0 };
            byPlatform[p].created += r.c;
            if (BOOKED.has(r.status)) byPlatform[p].scheduled += r.c;
            if (r.status === 'published') byPlatform[p].published += r.c;
        }

        const totalCreated = Number(totalsRow?.created ?? 0);
        const totalScheduled = Number(totalsRow?.scheduled ?? 0);
        const totalPublished = Number(totalsRow?.published ?? 0);
        const totalAwaitingReview = Number(totalsRow?.awaitingReview ?? 0);
        const totalNeedsAttention = Number(totalsRow?.needsAttention ?? 0);

        // Same formula as roi-stats.ts (posts × content_drafted + completed task runs ×
        // tasks_completed + leads × leads_generated) so a single-assistant org sees
        // identical hero figures on both pages. Leads only count in when unambiguous.
        const totalMinutesInPeriod = Number(postsInPeriod) * mult.content_drafted
            + Number(taskRunsInPeriod) * mult.tasks_completed
            + (isOnlyAssistantInOrg ? Number(leadsInPeriod) * mult.leads_generated : 0);
        const hoursSaved = parseFloat((totalMinutesInPeriod / 60).toFixed(1));
        const gbpSaved = hourlyRateGbp ? parseFloat((hoursSaved * hourlyRateGbp).toFixed(2)) : null;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                totalCreated,
                totalScheduled,
                totalPublished,
                // New: the two figures the old shape had no room for, so they got folded into
                // totalScheduled (awaiting review) or went unreported entirely (failed).
                totalAwaitingReview,
                totalNeedsAttention,
                // Tiles count posts; byPlatform counts per-platform sends. Flagged in the payload so
                // a future caller cannot mistake one for the other by reading the JSON alone.
                countsAreGrouped: true,
                byPlatform,
                hoursSaved,
                gbpSaved,
                period,
                hourlyRateSet: hourlyRateGbp !== null,
                minutesPerPost: mult.content_drafted,
            }),
        };
    } catch (err) {
        // This card is a SUPPLEMENTARY panel on the assistant detail page — a failure here
        // (DB hiccup, RLS/connection issue, brand-new assistant, etc.) must never 500 the
        // whole page. Degrade to a safe "no data" shape and log the real cause server-side.
        console.error('[get-assistant-metrics] degraded to no-data after error:', err);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                totalCreated: 0,
                totalScheduled: 0,
                totalPublished: 0,
                totalAwaitingReview: 0,
                totalNeedsAttention: 0,
                countsAreGrouped: true,
                byPlatform: {},
                hoursSaved: 0,
                gbpSaved: null,
                period: parseRoiPeriod(event.queryStringParameters?.period),
                hourlyRateSet: false,
                minutesPerPost: null,
            }),
        };
    }
});
