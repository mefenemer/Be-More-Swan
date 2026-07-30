// netlify/functions/get-follower-counts.ts
// Per-platform follower / subscriber counts for the workspace Audience block on assistant-detail.
//
// The per-platform API calls, the cache shape and the availability rules all live in
// src/utils/follower-counts.ts, shared with refresh-follower-counts.ts (the 4-hourly cron). This
// endpoint is the tenant-scoped read: it serves the cache, tops up anything older than the TTL, and
// folds in the manually-entered counts (LinkedIn) that no API can supply.
//
// Each row carries fetchedAt + nextRefreshAt so the UI can show how stale a figure is. Since the cron
// landed these are refreshed in the background every 4 hours, so nextRefreshAt is a genuine schedule rather
// than merely "eligible on the next page load" — the UI wording depends on that, so if the cron is
// ever removed, fix the wording in assistants.js (_fetchAndRenderFollowerCounts) too.
import { withLambda } from '@netlify/aws-lambda-compat';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { manualFollowerCounts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { CACHE_TTL_MS, refreshOrgFollowerCounts, type FollowerRow } from '../../src/utils/follower-counts';

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId } = ctx;
    if (!organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation.' }) };

    // Latest manually-entered count per platform (LinkedIn today). Newest row wins.
    const manualRows = await db
        .select({ platform: manualFollowerCounts.platform, count: manualFollowerCounts.count, recordedAt: manualFollowerCounts.recordedAt })
        .from(manualFollowerCounts)
        .where(eq(manualFollowerCounts.organisationId, organisationId))
        .orderBy(desc(manualFollowerCounts.recordedAt));
    const latestManual = new Map<string, { count: number; recordedAt: string }>();
    for (const m of manualRows) {
        if (!latestManual.has(m.platform)) latestManual.set(m.platform, { count: m.count, recordedAt: (m.recordedAt as Date).toISOString() });
    }

    // Serve from cache, re-fetching only what the cron hasn't already covered.
    const { rows, manualPlatforms } = await refreshOrgFollowerCounts(db, organisationId, { minAgeMs: CACHE_TTL_MS });

    // Manual-only platforms: show the latest entry with its date, and flag manualAllowed so the UI
    // offers the Add/Update input.
    const counts: FollowerRow[] = [...rows];
    for (const platform of manualPlatforms) {
        const m = latestManual.get(platform);
        counts.push(m
            ? { platform, count: m.count, available: true, source: 'manual', recordedAt: m.recordedAt, manualAllowed: true }
            : { platform, count: null, available: false, note: 'enter manually', manualAllowed: true });
    }

    // cacheTtlMinutes is sent so the UI can say how often these refresh without hardcoding the TTL —
    // change CACHE_TTL_MS in src/utils/follower-counts.ts and the wording on screen follows.
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counts, cacheTtlMinutes: Math.round(CACHE_TTL_MS / 60000), backgroundRefresh: true }),
    };
});
