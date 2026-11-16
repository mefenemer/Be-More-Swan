// netlify/functions/run-ch-stream-background.ts
// Buying triggers Phase 2: reads the Companies House streams from the saved timepoints and records news
// on watched companies (src/utils/lead-watch.ts runChStream). Filings for up to 8 minutes, then the
// companies stream (status changes) for up to 4. Started every 30 minutes by dispatch-ch-stream.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when unset.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { isLeadWatchEnabled, isMissingTable, isStreamConfigured, runChStream } from '../../src/utils/lead-watch';
import '../../src/utils/lead-watch-effects';

export default withLambda(async (event) => {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (!secret || auth.replace(/^Bearer\s+/i, '').trim() !== secret) return { statusCode: 401, body: 'Unauthorized' };
    if (!isStreamConfigured() || !isLeadWatchEnabled()) return { statusCode: 200, body: '' };
    const db = getDb();
    try {
        const filings = await runChStream(db, 'filings', { deadline: Date.now() + 8 * 60_000 });
        const companies = await runChStream(db, 'companies', { deadline: Date.now() + 4 * 60_000 });
        console.log('[run-ch-stream-background]', JSON.stringify({ filings, companies }));
    } catch (err) {
        if (isMissingTable(err)) console.log('[run-ch-stream-background] skipped: db/z-lead-watch.sql not applied yet');
        else console.error('[run-ch-stream-background] failed', err);
    }
    return { statusCode: 200, body: '' };
});
