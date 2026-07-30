// netlify/functions/refresh-follower-counts.ts
// Background refresh of every workspace's follower / subscriber counts (the Audience block on
// assistant-detail). Runs every 4 hours, matching CACHE_TTL_MS in src/utils/follower-counts.ts.
//
// WHY THIS EXISTS: the counts were previously refreshed lazily — get-follower-counts.ts only called
// the platform APIs when someone opened the page and the cache had expired. That made the first
// page load of the day slow, and meant the figures were only ever as fresh as the last visit, so a
// workspace nobody had opened for a fortnight showed fortnight-old numbers with no way for the UI to
// promise anything better. With this cron the cache is kept warm for everyone, so the page serves
// figures from cache and the UI can state a real refresh schedule.
//
// The actual fetching lives in src/utils/follower-counts.ts, shared with the read endpoint, so both
// agree on what each platform's count is and write the same cache keys.
//
// Note this does NOT touch manually-entered counts (LinkedIn) — there's no API to poll for those.
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, workspaceIntegrations } from '../../db/schema';
import { CACHE_TTL_MS, refreshOrgFollowerCounts } from '../../src/utils/follower-counts';
import { withLambda } from '@netlify/aws-lambda-compat';

// Organisations are swept a few at a time. Each one issues a handful of third-party calls in series,
// so this is about not opening hundreds of sockets at once rather than about raw throughput.
const CONCURRENCY = 5;

// How stale a cached figure must be before this cron re-fetches it. DELIBERATELY SHORTER than
// CACHE_TTL_MS: on a schedule that matches the TTL every run finds the previous run's figures a full
// TTL old and refreshes them, but a double-fire, a retry, or a manual trigger minutes later skips
// instead of re-fetching every connection. Using the full TTL here would make the sweep a coin-flip —
// a page load minutes before the cron would push that connection past the next run.
const MIN_AGE_MS = Math.round(CACHE_TTL_MS * 0.75);

// Ceiling on organisations per run. The run-follower-counts HTTP trigger (used on staging, where
// native schedules don't fire) is a SYNCHRONOUS function, so it's capped at Netlify's 26s maximum —
// an unbounded fan-out over every workspace's third-party APIs would eventually exceed that and the
// sweep would be cut off at an arbitrary point. Because orgs are processed STALEST FIRST, being cut
// short is harmless: whatever didn't fit is the freshest, and the next run picks up whatever
// is now oldest. Raise this only alongside evidence the run completes comfortably.
const MAX_ORGS_PER_RUN = 150;

/** Oldest `followerCountAt` across an org's connections; 0 (i.e. maximally stale) when never fetched. */
export function oldestCachedAt(metadatas: Array<Record<string, unknown> | null>): number {
    let oldest = Infinity;
    for (const meta of metadatas) {
        const at = meta && typeof meta.followerCountAt === 'string' ? Date.parse(meta.followerCountAt) : 0;
        oldest = Math.min(oldest, Number.isFinite(at) ? at : 0);
    }
    return oldest === Infinity ? 0 : oldest;
}

export type ConnMetaRow = { organisationId: number | null; metadata: Record<string, unknown> | null };

/**
 * Decide which organisations this run sweeps, and in what order — exported because it is the part of
 * this cron where a mistake is invisible in production: get it wrong and some workspace silently never
 * refreshes while the UI keeps promising regularly-refreshed figures. Pure, so tests/follower-refresh.test.ts can
 * pin the behaviour without a database.
 *
 * Rules: an org is due when its OLDEST figure is at least `minAgeMs` old (one stale platform makes the
 * org due — otherwise a workspace with one healthy and one broken connection would rest on the healthy
 * one's timestamp); orgs are ordered stalest-first so a truncated run always does the most good; and
 * never-fetched orgs sort first of all.
 */
export function selectOrgsToSweep(
    rows: ConnMetaRow[],
    now: number,
    { minAgeMs, max }: { minAgeMs: number; max: number },
): { organisations: number; due: number[]; batch: number[]; truncated: boolean } {
    const byOrg = new Map<number, Array<Record<string, unknown> | null>>();
    for (const r of rows) {
        if (r.organisationId == null) continue;
        const list = byOrg.get(r.organisationId) ?? [];
        list.push(r.metadata);
        byOrg.set(r.organisationId, list);
    }

    const due = [...byOrg.entries()]
        .map(([organisationId, metas]) => ({ organisationId, oldestAt: oldestCachedAt(metas) }))
        // Nothing to do for an org whose figures are all still fresh — skipping here avoids waking the
        // vault and the connection queries for it at all.
        .filter(o => now - o.oldestAt >= minAgeMs)
        .sort((a, b) => a.oldestAt - b.oldestAt)   // stalest first, so a truncated run still helps most
        .map(o => o.organisationId);

    return { organisations: byOrg.size, due, batch: due.slice(0, max), truncated: due.length > max };
}

export async function refreshAllFollowerCounts() {
    const db = getDb();

    // Every org with at least one active connection in either store, with the cache timestamps needed
    // to decide who is due. Orgs with no social connections have nothing to poll, so they're never
    // woken up.
    const [conns, wsInts] = await Promise.all([
        db.select({ organisationId: systemConnections.organisationId, metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(eq(systemConnections.status, 'active'), eq(systemConnections.isActive, true))),
        db.select({ organisationId: workspaceIntegrations.organisationId, metadata: workspaceIntegrations.metadata })
            .from(workspaceIntegrations)
            .where(eq(workspaceIntegrations.status, 'active')),
    ]);

    const { organisations, due, batch, truncated } = selectOrgsToSweep(
        [...conns, ...wsInts] as ConnMetaRow[],
        Date.now(),
        { minAgeMs: MIN_AGE_MS, max: MAX_ORGS_PER_RUN },
    );

    if (truncated) {
        console.warn(`[refresh-follower-counts] ${due.length} orgs due, capped at ${MAX_ORGS_PER_RUN} this run — the remainder are the freshest and will be picked up next run.`);
    }
    if (!batch.length) {
        console.log(`[refresh-follower-counts] orgs=${organisations} none due`);
        return { organisations, due: 0, refreshed: 0, cached: 0, failed: 0, truncated: false };
    }

    let refreshed = 0;
    let cached = 0;
    let failed = 0;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
        const chunk = batch.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
            chunk.map(orgId => refreshOrgFollowerCounts(db, orgId, { minAgeMs: MIN_AGE_MS })),
        );
        for (const r of results) {
            // One organisation's failure must never abort the sweep — the rest still get refreshed,
            // and a failed org simply keeps serving its previous cached figures.
            if (r.status === 'fulfilled') { refreshed += r.value.refreshed; cached += r.value.cached; }
            else { failed++; console.error('[refresh-follower-counts] org failed', r.reason); }
        }
    }

    console.log(`[refresh-follower-counts] orgs=${organisations} due=${due.length} swept=${batch.length} refreshed=${refreshed} cached=${cached} failed=${failed}`);
    return { organisations, due: due.length, refreshed, cached, failed, truncated };
}

export default withLambda(async () => {
    const result = await refreshAllFollowerCounts();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...result }) };
});
