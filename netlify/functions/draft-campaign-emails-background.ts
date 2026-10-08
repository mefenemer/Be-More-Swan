// netlify/functions/draft-campaign-emails-background.ts
// Draft the email campaign one Campaign Assistant order commissioned. Plan §9.7.
//
// Background because the Email Studio's generator makes one model call per email, and the order
// is placed inside a plan approval that already has posts, articles and searches to place in the
// same ~26s request. Woken by triggerCampaignEmailDraft (on issue) and by the hourly reconciler
// (for a wake-up that was lost). The body is just { orderId }: the order row is the job, and
// draftEmailCampaignForOrder's atomic claim makes a second wake-up for the same order a no-op.
//
// It NEVER sends: a form follow-up is saved switched off, a send-it-yourself campaign as drafts.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { draftEmailCampaignForOrder } from '../../src/utils/campaign-email-order';
import { settleOrderAsFailed } from '../../src/utils/campaign-reconciler';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone spend a tenant's model budget drafting emails.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[draft-campaign-emails-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let orderId = 0;
    try { orderId = Number(JSON.parse(event.body || '{}').orderId); } catch { /* handled below */ }
    if (!Number.isInteger(orderId) || orderId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'orderId required.' }) };
    }

    const db = getDb();
    try {
        const outcome = await draftEmailCampaignForOrder(db, orderId);
        if (!outcome.ok && outcome.settle) {
            // Cancel + refund + mirror through the reconciler's own settlement, so a failed draft is
            // recorded exactly like any other order that produced nothing.
            await settleOrderAsFailed(db, orderId, outcome.message);
        }
        console.log('[draft-campaign-emails-background]', JSON.stringify(outcome));
        return { statusCode: 200, body: JSON.stringify(outcome) };
    } catch (err) {
        // Left claimed; the claim goes stale and the reconciler re-sends it. Never settled here —
        // an unexpected error is not evidence the work cannot be done.
        console.error('[draft-campaign-emails-background] failed', { orderId, err });
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
