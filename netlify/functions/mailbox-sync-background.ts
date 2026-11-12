// netlify/functions/mailbox-sync-background.ts — read and sort one mailbox (src/utils/mailbox-sync.ts).
// Woken by mailbox-oauth.ts right after a mailbox connects and by poll-mailboxes.ts every 10 minutes.
//
// A background function (15-minute limit): a first sort reads 14 days of inbox and sorts up to a few
// hundred emails, far past the 26 s a synchronous function gets. runMailboxSync never throws and always
// releases the mailbox's lease.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runMailboxSync } from '../../src/utils/mailbox-sync';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone make us read mailboxes and spend AI calls.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[mailbox-sync-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let mailboxId = 0;
    try { mailboxId = Number(JSON.parse(event.body || '{}').mailboxId); } catch { /* handled below */ }
    if (!Number.isInteger(mailboxId) || mailboxId <= 0) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'mailboxId required.' }) };

    const outcome = await runMailboxSync(getDb(), mailboxId);
    // Counts only: never a subject, sender or address in the logs.
    console.log('[mailbox-sync-background]', { mailboxId, ...outcome });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
