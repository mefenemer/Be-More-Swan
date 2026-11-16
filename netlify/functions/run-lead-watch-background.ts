// netlify/functions/run-lead-watch-background.ts
// Buying triggers Phase 2 (docs/buying-triggers-plan.md §5): the Watch list's daily run.
//   1. syncWatchList   — leads with a Companies House match, customers (won) and manual additions;
//   2. checkDueWatches — filing history (+ status every 4th check) for each company due, paced;
//   2b. syncSiteWatch + checkDueSiteWatches — the lead's team page, careers page / job board and, for US
//       leads, SEC Form D (Why now Phase 2, src/utils/lead-site-watch.ts);
//   3. rollUpSignals   — one note per assistant with new news.
// Background function: 15 minutes, of which the checks use at most 12.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when unset.

import { withLambda } from '@netlify/aws-lambda-compat';
import { sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { checkDueWatches, isLeadWatchEnabled, isMissingTable, rollUpSignals, syncWatchList, WATCH_SOURCE } from '../../src/utils/lead-watch';
import { notifyRollUp } from '../../src/utils/lead-watch-effects';
import { checkDueSiteWatches, syncSiteWatch } from '../../src/utils/lead-site-watch';

const RUN_MS = 12 * 60_000;
const CH_MS = 7 * 60_000;

export default withLambda(async (event) => {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (!secret || auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        console.warn('[run-lead-watch-background] refused: ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'bad secret'));
        return { statusCode: 401, body: 'Unauthorized' };
    }
    if (!isLeadWatchEnabled()) {
        console.log('[run-lead-watch-background] skipped: LEAD_WATCH_ENABLED=off');
        return { statusCode: 200, body: '' };
    }
    const db = getDb();
    const started = Date.now();
    const result: Record<string, unknown> = { ok: false };
    try {
        result.sync = await syncWatchList(db);
        // Companies House first, with up to 7 of the 12 minutes; then the lead's own site and SEC Form D
        // (Why now Phase 2, src/utils/lead-site-watch.ts) with what is left. Both feed the one daily note.
        result.check = await checkDueWatches(db, { deadline: started + CH_MS });
        result.siteSync = await syncSiteWatch(db);
        result.siteCheck = await checkDueSiteWatches(db, { deadline: started + RUN_MS });
        result.notesSent = await rollUpSignals(db, (g) => notifyRollUp(db, g));
        result.ok = true;
    } catch (err) {
        if (isMissingTable(err)) {
            console.log('[run-lead-watch-background] skipped: db/z-lead-watch.sql not applied yet');
            return { statusCode: 200, body: '' };
        }
        result.error = err instanceof Error ? err.message : String(err);
        console.error('[run-lead-watch-background] failed', err);
    }
    result.durationMs = Date.now() - started;
    console.log('[run-lead-watch-background]', JSON.stringify(result));
    try {
        await db.execute(sql`
            INSERT INTO trigger_sources (source, last_run_at, last_ok_at, last_result)
            VALUES (${WATCH_SOURCE}, now(), ${result.ok ? sql`now()` : sql`NULL`}, ${JSON.stringify(result)}::jsonb)
            ON CONFLICT (source) DO UPDATE SET last_run_at = now(),
                last_ok_at = ${result.ok ? sql`now()` : sql`trigger_sources.last_ok_at`},
                last_result = EXCLUDED.last_result, updated_at = now()`);
    } catch (err) {
        console.warn('[run-lead-watch-background] could not save the run result', err);
    }
    return { statusCode: 200, body: '' };
});
