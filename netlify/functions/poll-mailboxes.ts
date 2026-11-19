// netlify/functions/poll-mailboxes.ts — every 10 minutes, wake a read for each mailbox that is due
// (docs/email-assistant-plan.md §4.3, the Phase 1 mechanism; push notifications come in Phase 3 and
// this stays as the safety net).
//
// ⚠️ Netlify runs scheduled functions on PRODUCTION only, and answers a direct URL call to one with a
// bare 403 before this handler runs. Staging is poked through run-poll-mailboxes.ts instead.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { mailboxesDueForSync, triggerMailboxSync } from '../../src/utils/mailbox-sync';
import { pruneOldActions } from '../../src/utils/mailbox-actions';
import { mayRunScheduled } from '../../src/utils/scheduled-run-auth';

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
    // Drafted replies and clean-up records are kept 30 days after they were acted on, then deleted.
    const pruned = await pruneOldActions(getDb()).catch(() => 0);
    let dispatched = 0;
    for (const id of due) if (await triggerMailboxSync(id)) dispatched++;
    console.log('[poll-mailboxes]', { due: due.length, dispatched, pruned });
    return { due: due.length, dispatched };
}

export default withLambda(async (event) => {
    if (!mayPoll(event)) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    const result = await pollDueMailboxes();
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
});
