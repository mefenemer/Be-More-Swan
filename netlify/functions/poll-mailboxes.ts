// netlify/functions/poll-mailboxes.ts — every 10 minutes, wake a read for each mailbox that is due
// (docs/email-assistant-plan.md §4.2–4.3). With push on (Phase 3b, mailbox-push.ts) new mail arrives by
// push and this is the safety net (a watched mailbox is read every 30 minutes); it also starts and
// renews the watches.
//
// ⚠️ Netlify runs scheduled functions on PRODUCTION only, and answers a direct URL call to one with a
// bare 403 before this handler runs. Staging is poked through run-poll-mailboxes.ts instead.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { mailboxesDueForSync, triggerMailboxSync } from '../../src/utils/mailbox-sync';
import { pruneOldActions } from '../../src/utils/mailbox-actions';
import { mayRunScheduled } from '../../src/utils/scheduled-run-auth';
import { sendMorningDigest } from '../../src/utils/mailbox-notify';
import { ensureWatches } from '../../src/utils/mailbox-push';
import { mailboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';

export const config = { schedule: '*/10 * * * *' };

/** Who may run this (src/utils/scheduled-run-auth.ts): the cron secret or Netlify's scheduler. */
export const mayPoll = mayRunScheduled;

/** Wake a read for every mailbox that is due. Shared with run-poll-mailboxes.ts (staging's trigger). */
export async function pollDueMailboxes(): Promise<{ due: number; dispatched: number }> {
    const due = await mailboxesDueForSync(getDb()).catch((err) => {
        // The table may not exist yet (z-mailboxes.sql not applied): nothing to do, not an outage.
        console.error('[poll-mailboxes] could not list mailboxes', err instanceof Error ? err.message : err);
        return [] as number[];
    });
    // Most urgent first, so a run that hits its time limit loses the least: reads, then push, then the rest.
    // Reads are dispatched 10 at a time (each waits up to 5 s for the background function to accept).
    let dispatched = 0;
    for (let i = 0; i < due.length; i += 10) {
        dispatched += (await Promise.all(due.slice(i, i + 10).map((id) => triggerMailboxSync(id)))).filter(Boolean).length;
    }
    // Push (Phase 3b): start a watch for mailboxes without one, renew any ending within a day — within a
    // time budget; anything left is first in line next run, and the log shows it as `deferred`.
    const watches = await ensureWatches(getDb());
    // Drafted replies and clean-up records are kept 30 days after they were acted on, then deleted.
    const pruned = await pruneOldActions(getDb()).catch(() => 0);
    // The Email Assistant's morning note, once a day per mailbox (07:00–11:59 local; latched in its settings).
    let digests = 0;
    const active = await getDb().select().from(mailboxes).where(eq(mailboxes.status, 'active')).catch(() => []);
    for (const box of active) if (await sendMorningDigest(getDb(), box)) digests++;
    console.log('[poll-mailboxes]', { due: due.length, dispatched, pruned, digests, watches });
    return { due: due.length, dispatched };
}

export default withLambda(async (event) => {
    if (!mayPoll(event)) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    const result = await pollDueMailboxes();
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
});
