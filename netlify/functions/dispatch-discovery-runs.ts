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
            await db.insert(discoveryJobs).values({
                jobId: randomUUID(),
                organisationId: s.organisationId,
                campaignId: s.campaignId,
                triggerType: 'scheduled',
            });
            enqueued += 1;
        }

        const nextRunAt = computeNextRun(s.cadence, s.runAtHourUtc, daysOfWeek, now);
        await db.update(discoverySchedules)
            .set({ lastRunAt: now, nextRunAt, isEnabled: s.cadence === 'one_off' ? false : true, updatedAt: now })
            .where(eq(discoverySchedules.id, s.scheduleId));
    }

    return enqueued;
}

export default withLambda(async () => {
    const enqueued = await dispatchDueRuns();
    return { statusCode: 200, body: enqueued ? `enqueued ${enqueued} discovery runs` : 'nothing due' };
});
