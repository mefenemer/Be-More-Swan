// netlify/functions/mailbox-sync-background.ts — read and sort one mailbox (src/utils/mailbox-sync.ts).
// Woken by mailbox-oauth.ts right after a mailbox connects, by a push (mailbox-push.ts recordPush) and by
// poll-mailboxes.ts.
//
// A background function (15-minute limit): a first sort reads 14 days of inbox and sorts up to a few
// hundred emails, far past the 26 s a synchronous function gets. runMailboxSync never throws and always
// releases the mailbox's lease.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { eq } from 'drizzle-orm';
import { mailboxes } from '../../db/schema';
import { runMailboxSync, triggerMailboxSync } from '../../src/utils/mailbox-sync';

/** A push arrived after this run started, so the run may have missed it: read again. Pure. */
export function pushedDuringRun(startedAt: Date, lastPushAt: Date | null | undefined): boolean {
    return !!lastPushAt && lastPushAt.getTime() > startedAt.getTime();
}

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

    const startedAt = new Date();
    const outcome = await runMailboxSync(getDb(), mailboxId);
    // Counts only: never a subject, sender or address in the logs.
    console.log('[mailbox-sync-background]', { mailboxId, ...outcome });
    // A push that arrived mid-run wasn't dispatched (recordPush skips a mailbox being read): read once more.
    // Only after a run that actually ran and worked, so an error never loops.
    if (outcome.ran && !outcome.error) {
        const [row] = await getDb().select({ lastPushAt: mailboxes.lastPushAt }).from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1).catch(() => []);
        if (pushedDuringRun(startedAt, row?.lastPushAt)) await triggerMailboxSync(mailboxId);
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
