// system-review-background.ts — System Map Phase 3 (docs/system-map-plan.md): runs queued "better
// options" checks (src/utils/system-review.ts). Started by admin-system-map.ts ("Check now"), the
// Systems chat's card, or system-review-monthly.ts, always with the CRON_TRIGGER_SECRET bearer.
//   POST { reviewIds: number[] }
// Two at a time; no new check starts after 12 minutes (background functions stop at 15). A check
// left unstarted stays 'queued' and reads as stalled after 20 minutes, so "Check now" can retry it.

import { and, eq, inArray } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { systemReviews } from '../../db/schema';
import { loadSystemMap } from '../../src/utils/system-map-data';
import { reviewContextFor, runSystemReview } from '../../src/utils/system-review';

const CONCURRENCY = 2;
const STOP_STARTING_AFTER_MS = 12 * 60_000;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) return { statusCode: 503, body: JSON.stringify({ error: 'Trigger not configured.' }) };
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let body: { reviewIds?: unknown } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* validated below */ }
    const ids = (Array.isArray(body.reviewIds) ? body.reviewIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
    if (!ids.length) return { statusCode: 400, body: JSON.stringify({ error: 'reviewIds required.' }) };

    const db = getDb();
    const started = Date.now();
    const queued = await db.select({ id: systemReviews.id, systemKey: systemReviews.systemKey }).from(systemReviews)
        .where(and(inArray(systemReviews.id, ids), eq(systemReviews.status, 'queued')));
    if (!queued.length) return { statusCode: 200, body: JSON.stringify({ ran: 0 }) };

    // One map for every check: what each system is for, costs, models, bills, decisions, last summary.
    const map = await loadSystemMap(db, process.env.BASE_URL ? new URL(process.env.BASE_URL).host : null);
    let next = 0;
    const results: Record<string, number> = { done: 0, failed: 0 };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queued.length) }, async () => {
        while (next < queued.length && Date.now() - started < STOP_STARTING_AFTER_MS) {
            const row = queued[next++];
            const s = map.systems.find((x) => x.key === row.systemKey);
            if (!s) {
                await db.update(systemReviews).set({ status: 'failed', error: 'That system is no longer on the map.', finishedAt: new Date() }).where(eq(systemReviews.id, row.id));
                results.failed++;
                continue;
            }
            results[await runSystemReview(db, row.id, reviewContextFor(s, map.roleNames))]++;
        }
    }));
    console.log(`[system-review] ${results.done} done, ${results.failed} failed, ${queued.length - next} left queued`);
    return { statusCode: 200, body: JSON.stringify({ ...results, leftQueued: queued.length - next }) };
});
