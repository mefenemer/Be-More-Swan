// netlify/functions/dispatch-discovery-runs.ts
// Cheap hourly dispatcher: finds discovery_schedules that are due and enqueues one
// discovery_jobs row per campaign, then advances next_run_at by the cadence. Does NO
// searching itself — the worker (process-discovery-jobs.ts) does the heavy lifting.
// Design: docs/lead-generator-discovery-plan.md §2.2.

import { Handler } from '@netlify/functions';
import { randomUUID } from 'crypto';
import { and, eq, lte, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { discoveryCampaigns, discoverySchedules, discoveryJobs } from '../../db/schema';
import { computeNextRun, normaliseDaysOfWeek } from '../../src/utils/discovery-schedule';
import { triggerDiscoveryDrain } from '../../src/utils/trigger-drain';
import { withLambda } from '@netlify/aws-lambda-compat';

type Db = ReturnType<typeof getDb>;

// The next-fire arithmetic lives in src/utils/discovery-schedule.ts. It was inline here and it
// ignored days_of_week entirely — "weekly" meant "seven days after it last fired", so a search the
// user asked to run on Mondays ran on whatever day it was first started, and the Schedule modal
// would have promised a day this function never honoured.

export async function dispatchDueRuns(): Promise<number> {
    const db: Db = getDb();
    const now = new Date();

    // Due = enabled, on an active campaign, next_run_at reached (or never set).
    const due = await db
        .select({
            scheduleId: discoverySchedules.id,
            campaignId: discoverySchedules.campaignId,
            organisationId: discoverySchedules.organisationId,
            cadence: discoverySchedules.cadence,
            runAtHourUtc: discoverySchedules.runAtHourUtc,
            daysOfWeek: discoverySchedules.daysOfWeek,
        })
        .from(discoverySchedules)
        .innerJoin(discoveryCampaigns, eq(discoverySchedules.campaignId, discoveryCampaigns.id))
        .where(and(
            eq(discoverySchedules.isEnabled, true),
            eq(discoveryCampaigns.status, 'active'),
            or(isNull(discoverySchedules.nextRunAt), lte(discoverySchedules.nextRunAt, now)),
        ));

    let enqueued = 0;
    /** First job enqueued this cycle — the poke below is per-QUEUE, so one id is all it needs. */
    let firstJobId: string | undefined;
    for (const s of due) {
        const daysOfWeek = normaliseDaysOfWeek(s.daysOfWeek);

        // A day-constrained schedule must not fire on a day the user did not choose. This only
        // bites rows whose next_run_at predates the day being honoured at all — createDiscoveryRun
        // seeds it to now() so the first run happens promptly, and a legacy weekly row carries
        // whatever day it was created on. Rather than firing on the wrong day, advance the row: the
        // computation below lands it on the next chosen day.
        if (daysOfWeek && !daysOfWeek.includes(now.getUTCDay())) {
            await db.update(discoverySchedules)
                .set({ nextRunAt: computeNextRun(s.cadence, s.runAtHourUtc, daysOfWeek, now), updatedAt: now })
                .where(eq(discoverySchedules.id, s.scheduleId));
            continue;
        }

        // Skip if this campaign already has an in-flight run — never stack runs.
        const [inflight] = await db
            .select({ id: discoveryJobs.id })
            .from(discoveryJobs)
            .where(and(
                eq(discoveryJobs.campaignId, s.campaignId),
                sql`${discoveryJobs.status} IN ('queued','processing')`,
            ))
            .limit(1);

        if (!inflight) {
            const jobId = randomUUID();
            await db.insert(discoveryJobs).values({
                jobId,
                organisationId: s.organisationId,
                campaignId: s.campaignId,
                triggerType: 'scheduled',
            });
            enqueued += 1;
            // Only the FIRST is kept: one poke drains the whole QUEUE, not one job (see below).
            firstJobId ??= jobId;
        }

        const nextRunAt = computeNextRun(s.cadence, s.runAtHourUtc, daysOfWeek, now);
        await db.update(discoverySchedules)
            .set({ lastRunAt: now, nextRunAt, isEnabled: s.cadence === 'one_off' ? false : true, updatedAt: now })
            .where(eq(discoverySchedules.id, s.scheduleId));
    }

    // ── Start the work now, exactly as a human-started search does ──────────────────────────────
    //
    // ⚠️ THE DEFECT THIS CLOSES. Every surface that starts a search by hand pokes the drain
    // (discovery-campaigns.ts create / approve_brief / run_now, lead-generation.ts). This
    // dispatcher did not: it INSERTed a queued row and returned, leaving the run to the
    // ten-minute cron. Because a run is sliced — one search query per invocation, five leads per
    // enrichment batch — that is ten minutes PER SLICE, so a fifteen-query run took hours where
    // the identical search started by hand took minutes.
    //
    // So the two paths produced the same search at wildly different speeds, and the slow one was
    // the unattended one nobody was watching to notice.
    //
    // ONE poke, not one per job: run-discovery-jobs-background loops drainDiscoveryJobs until the
    // queue is empty, and drainDiscoveryJobs claims up to five jobs per pass across ALL campaigns.
    // A poke per enqueued row would start N identical loops competing for the same rows — harmless
    // (the claim is a single atomic UPDATE ... RETURNING, so they take different rows or none) but
    // pure waste. The jobId is passed for the log line only.
    //
    // Best-effort by construction: every failure path inside `poke` leaves the rows exactly where
    // they are, to be picked up by the cron — i.e. the behaviour this replaces. It can only make
    // things faster, never break them.
    //
    // ⚠️ No request headers: this is a scheduled invocation, so `resolveBaseUrl` falls through to
    // BASE_URL (set on production AND staging, each pointing at its own deploy). If that ever
    // becomes unset the poke logs a warning and the cron carries the run, as before.
    if (firstJobId) {
        await triggerDiscoveryDrain(undefined, firstJobId, 'dispatch-discovery-runs');
    }

    return enqueued;
}

export default withLambda(async () => {
    const enqueued = await dispatchDueRuns();
    return { statusCode: 200, body: enqueued ? `enqueued ${enqueued} discovery runs` : 'nothing due' };
});
