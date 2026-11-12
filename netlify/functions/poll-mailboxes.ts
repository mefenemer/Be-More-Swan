// netlify/functions/poll-mailboxes.ts — every 10 minutes, wake a read for each mailbox that is due
// (docs/email-assistant-plan.md §4.3, the Phase 1 mechanism; push notifications come in Phase 3 and
// this stays as the safety net).
//
// ⚠️ Netlify runs scheduled functions on PRODUCTION only. Staging is poked by
// .github/workflows/staging-crons.yml with CRON_TRIGGER_SECRET, which this accepts as well.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { mailboxesDueForSync, triggerMailboxSync } from '../../src/utils/mailbox-sync';

export const config = { schedule: '*/10 * * * *' };

/**
 * Who may run this: the cron secret, or Netlify's scheduler (a POST whose body carries `next_run`, or
 * an empty body). Same rule as content-retention.ts mayRun. The marker can be typed by hand, so the
 * real limit is what a run CAN do: wake reads of mailboxes already due, nothing a caller can choose.
 */
export function mayPoll(event: { body?: string | null; headers?: Record<string, string | undefined> }): boolean {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const token = String(event.headers?.['authorization'] ?? event.headers?.['Authorization'] ?? '').replace(/^Bearer\s+/i, '').trim();
    if (token) return Boolean(secret) && token === secret;
    const raw = event.body;
    if (raw == null || raw === '') return true;
    try { return typeof JSON.parse(String(raw))?.next_run === 'string'; } catch { return false; }
}

export default withLambda(async (event) => {
    if (!mayPoll(event)) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    const due = await mailboxesDueForSync(getDb()).catch((err) => {
        // The table may not exist yet (z-mailboxes.sql not applied): nothing to do, not an outage.
        console.error('[poll-mailboxes] could not list mailboxes', err instanceof Error ? err.message : err);
        return [] as number[];
    });
    let dispatched = 0;
    for (const id of due) if (await triggerMailboxSync(id)) dispatched++;
    console.log('[poll-mailboxes]', { due: due.length, dispatched });
    return { statusCode: 200, body: JSON.stringify({ ok: true, due: due.length, dispatched }) };
});
