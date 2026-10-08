// netlify/functions/generate-brief-options-background.ts
// The Brand Designer's worker: makes one round of options for a brief (src/utils/visual-briefs.ts,
// runRound). Woken by brand-briefs.ts through triggerBriefRound the moment the user clicks.
//
// A background function, because a round is an art-direction call, up to four FLUX images copied
// into R2, a stock search and two rendered cards — comfortably past the 26 s a synchronous function
// gets, and the platform's kill at 26 s returns NO body, so the user would see an unexplained failure
// with their credit held.
//
// runRound never throws and always ends the round (credit settled once). If this worker is never
// reached at all, the timeout sweep in brand-briefs.ts `list` ends the round and refunds it.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runRound } from '../../src/utils/visual-briefs';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend a tenant's AI credits.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[generate-brief-options-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let briefId = 0;
    let userId: number | null = null;
    try {
        const b = JSON.parse(event.body || '{}');
        briefId = Number(b.briefId);
        userId = Number.isInteger(Number(b.userId)) && Number(b.userId) > 0 ? Number(b.userId) : null;
    } catch { /* handled below */ }
    if (!Number.isInteger(briefId) || briefId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'briefId required.' }) };
    }

    await runRound(getDb(), briefId, userId);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
