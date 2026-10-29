// netlify/functions/run-discussion-scan-background.ts
// The Discussions tab's worker: one scan of one watch (src/utils/discussions.ts runScan). Woken by
// discussions.ts `scan_now` the moment the user asks, and by the daily dispatch.
//
// A background function, because a scan runs up to twenty searches, reads up to twenty thread pages
// and makes up to four model calls — past the 26 s a synchronous function gets. runScan never throws
// and always releases the watch; if this worker is never reached, a claim older than SCAN_STALE_MS
// is treated as dead and the next "Scan now" takes it.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runScan } from '../../src/utils/discussions';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend a tenant's tasks.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-discussion-scan-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let watchId = 0;
    try { watchId = Number(JSON.parse(event.body || '{}').watchId); } catch { /* handled below */ }
    if (!Number.isInteger(watchId) || watchId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'watchId required.' }) };
    }

    await runScan(getDb(), watchId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
