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

type Db = ReturnType<typeof getDb>;

/** Advance a schedule to its next fire time. one_off disables itself after running. */
function computeNextRun(cadence: string, runAtHourUtc: number, from: Date): Date | null {
    if (cadence === 'one_off') return null;
    const next = new Date(from);
    next.setUTCHours(runAtHourUtc, 0, 0, 0);
    if (cadence === 'daily') {
        if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
        return next;
    }
    // weekly
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
}

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

        const nextRunAt = computeNextRun(s.cadence, s.runAtHourUtc, now);
        await db.update(discoverySchedules)
            .set({ lastRunAt: now, nextRunAt, isEnabled: s.cadence === 'one_off' ? false : true, updatedAt: now })
            .where(eq(discoverySchedules.id, s.scheduleId));
    }

    return enqueued;
}

export const handler: Handler = async () => {
    const enqueued = await dispatchDueRuns();
    return { statusCode: 200, body: enqueued ? `enqueued ${enqueued} discovery runs` : 'nothing due' };
};
