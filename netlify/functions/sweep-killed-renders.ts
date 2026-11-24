// netlify/functions/sweep-killed-renders.ts
// Hourly (netlify.toml). Runs the two killed-render sweeps on a clock, so a render whose worker was killed (a deploy, a
// platform fault) is failed and its Remotion cost logged even when nobody renders again or opens their videos in time.
// Before this, both sweeps ran only inline: the post sweep after the next post render (any workspace), the Video Producer
// sweep when that workspace's videos were next read. Each only logs a render cut off in the last 3 days, so a quiet spell
// lost the cost for good, and partner commission (docs/partner-actual-costs-plan.md) never saw it. docs/cost-logging-audit.md.
//
// Netlify's scheduled functions stop at 30 s. Each Remotion cost read is capped at 5 s (render-cost.ts), so this does a
// small batch and stops starting new work after BUDGET_MS. Whatever is left waits for the next hour, inside the 3-day window.
// The inline sweeps stay as they are. Both sweeps claim each row with an UPDATE, so a cron run and an inline run can't
// both log one render.
//
// ⚠️ Netlify runs scheduled functions on PRODUCTION only. On staging the inline sweeps still run.

import { and, inArray, lt } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { videoProjects } from '../../db/schema';
import { STUCK_AFTER_MS, sweepStuckProjects } from '../../src/utils/video-producer';
import { sweepKilledPostRenders } from './render-post-video-background';

type Db = ReturnType<typeof getDb>;

/** Stop starting new work after this long. The worst single step (two 5 s Remotion reads) still ends inside 30 s. */
export const BUDGET_MS = 12_000;
/** Post render jobs per run. Each can take one 5 s Remotion read. */
export const POST_JOBS_PER_RUN = 2;
/** Workspaces with stuck Video Producer projects per run. Each sweep logs at most 2 killed renders. */
export const VIDEO_ORGS_PER_RUN = 5;

export interface SweepDeps {
    sweepPosts: (db: Db, now: Date, limit: number) => Promise<number>;
    sweepProjects: (db: Db, orgId: number, now: Date) => Promise<number>;
    stuckVideoOrgs: (db: Db, now: Date, limit: number) => Promise<number[]>;
    clock: () => number;
}

/** Workspaces with a Video Producer project stuck mid-step for longer than STUCK_AFTER_MS (the same test sweepStuckProjects uses). */
export async function stuckVideoOrgs(db: Db, now: Date, limit: number): Promise<number[]> {
    const rows = await db.selectDistinct({ orgId: videoProjects.organisationId }).from(videoProjects)
        .where(and(
            inArray(videoProjects.status, ['rendering', 'reviewing', 'planning', 'building']),
            lt(videoProjects.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
        ))
        .limit(limit);
    return rows.map((r) => r.orgId);
}

const realDeps: SweepDeps = {
    sweepPosts: (db, now, limit) => sweepKilledPostRenders(db, now, limit),
    sweepProjects: (db, orgId, now) => sweepStuckProjects(db, orgId, now),
    stuckVideoOrgs,
    clock: () => Date.now(),
};

export async function sweepKilledRenders(db: Db, now: Date = new Date(), deps: SweepDeps = realDeps) {
    const startedAt = deps.clock();
    const overBudget = () => deps.clock() - startedAt >= BUDGET_MS;
    const posts = await deps.sweepPosts(db, now, POST_JOBS_PER_RUN);   // never throws
    let videoOrgs = 0, videoOrgsLeft = 0;
    let orgs: number[] = [];
    try { orgs = await deps.stuckVideoOrgs(db, now, VIDEO_ORGS_PER_RUN); }
    catch (err) { console.error('[sweep-killed-renders] stuck video lookup failed:', err instanceof Error ? err.message : err); }
    for (const orgId of orgs) {
        if (overBudget()) { videoOrgsLeft++; continue; }
        try { await deps.sweepProjects(db, orgId, now); videoOrgs++; }
        catch (err) { console.error(`[sweep-killed-renders] video sweep failed for workspace ${orgId}:`, err instanceof Error ? err.message : err); }
    }
    return { posts, videoOrgs, videoOrgsLeft };
}

export default withLambda(async () => {
    const result = await sweepKilledRenders(getDb());
    console.log('[sweep-killed-renders]', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
});
