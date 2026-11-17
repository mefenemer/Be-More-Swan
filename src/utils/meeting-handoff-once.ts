// Meeting hand-offs that reach people run ONCE per meeting (found in the Meeting Note Taker step 8
// real-account run, 2026-11-16): the follow-up email, the Slack summary and the Notion page.
//
// Every approval of a meeting queues its hand-offs (assistant-records.ts → scenario_jobs). A meeting
// sent back to review and approved again was queued twice, and both runs sent: the attendees got the
// follow-up email twice. A job with one failed hand-off is also retried whole, so a failed Slack post
// re-sent the email that had already gone. So each of these is stamped on the meeting itself —
// data.handoffs[actionType] = { claimedAt } while it runs, { sentAt } once it succeeded — and
// process-scenario-jobs.ts claims the stamp before running it:
//   'claimed'  nobody has sent it: run it, then finishMeetingHandoff(ok)
//   'done'     it already went: skip it, report success
//   'busy'     another run claimed it in the last CLAIM_TTL_MINUTES: retry the job later
// The claim is one UPDATE … WHERE not sent and not freshly claimed, so two runs at once cannot both win.
//
// NOT the Jira/Asana ticket recipes: they already keep a per-task ledger (action_items) and a
// re-approval is how the user retries skipped or failed tickets (materialiseActionItems), which a
// once-stamp would stop.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';

type Db = ReturnType<typeof getDb>;

export const ONCE_PER_MEETING_ACTIONS: ReadonlySet<string> = new Set([
    'email_meeting_followup',
    'slack_post_summary',
    'notion_create_page',
]);

/** A run that claimed a hand-off and then died leaves the claim; after this long another run may take it. */
export const CLAIM_TTL_MINUTES = 15;

/** The data keys the server owns on a meeting record — an Inbox edit that sends a stale `data` must keep them. */
export const SERVER_OWNED_MEETING_KEYS = ['handoffs', 'followupSentVia', 'followupSentAt', 'followupNotSent'] as const;

export type HandoffClaim = 'claimed' | 'done' | 'busy';

/** True when this hand-off must run at most once for this record. Pure. */
export function runsOncePerMeeting(recordType: unknown, actionType: unknown, recordId: unknown): boolean {
    return recordType === 'meeting' && typeof actionType === 'string' && ONCE_PER_MEETING_ACTIONS.has(actionType)
        && Number.isInteger(Number(recordId)) && Number(recordId) > 0;
}

/** Take the right to run `actionType` for this meeting. Never throws: a failed read is 'busy' (retry later). */
export async function claimMeetingHandoff(db: Db, organisationId: number, recordId: number, actionType: string): Promise<HandoffClaim> {
    try {
        const won = await db.execute(sql`
            UPDATE assistant_records
               SET data = jsonb_set(
                       data, '{handoffs}',
                       COALESCE(data->'handoffs', '{}'::jsonb) || jsonb_build_object(${actionType}::text, jsonb_build_object('claimedAt', now()))
                   )
             WHERE id = ${recordId} AND organisation_id = ${organisationId} AND record_type = 'meeting'
               AND data->'handoffs'->(${actionType}::text)->>'sentAt' IS NULL
               -- A follow-up sent before these stamps existed still carries followupSentAt (sync-action.ts).
               AND NOT (${actionType}::text = 'email_meeting_followup' AND data ? 'followupSentAt')
               AND (data->'handoffs'->(${actionType}::text)->>'claimedAt' IS NULL
                    OR (data->'handoffs'->(${actionType}::text)->>'claimedAt')::timestamptz < now() - make_interval(mins => ${CLAIM_TTL_MINUTES}))
            RETURNING id`) as unknown as Array<{ id: number }>;
        if (won.length) return 'claimed';
        const [row] = await db.execute(sql`
            SELECT COALESCE(data->'handoffs'->(${actionType}::text)->>'sentAt',
                            CASE WHEN ${actionType}::text = 'email_meeting_followup' THEN data->>'followupSentAt' END) AS "sentAt"
              FROM assistant_records WHERE id = ${recordId} AND organisation_id = ${organisationId}`) as unknown as Array<{ sentAt: string | null }>;
        // No such meeting any more: nothing to send it for.
        if (!row) return 'done';
        return row.sentAt ? 'done' : 'busy';
    } catch (err) {
        console.error('[meeting-handoff-once] claim failed; the job will retry', err);
        return 'busy';
    }
}

/** After the run: stamp sentAt on success, or drop the claim so a retry can try again. Never throws. */
export async function finishMeetingHandoff(db: Db, organisationId: number, recordId: number, actionType: string, ok: boolean): Promise<void> {
    try {
        await db.execute(ok
            ? sql`UPDATE assistant_records
                     SET data = jsonb_set(data, '{handoffs}',
                             COALESCE(data->'handoffs', '{}'::jsonb) || jsonb_build_object(${actionType}::text, jsonb_build_object('sentAt', now())))
                   WHERE id = ${recordId} AND organisation_id = ${organisationId}`
            : sql`UPDATE assistant_records
                     SET data = jsonb_set(data, '{handoffs}', COALESCE(data->'handoffs', '{}'::jsonb) - ${actionType}::text)
                   WHERE id = ${recordId} AND organisation_id = ${organisationId}
                     AND data->'handoffs'->(${actionType}::text)->>'sentAt' IS NULL`);
    } catch (err) {
        // A missed sentAt stamp means a later re-approval could send again; logged loudly for that reason.
        console.error(`[meeting-handoff-once] could not ${ok ? 'stamp' : 'release'} ${actionType} on meeting ${recordId}`, err);
    }
}

/**
 * An Inbox edit sends the whole `data` it loaded, which may predate a send. Keep the server-owned keys
 * from the stored row when the incoming data leaves them out, so an edit can never erase "already sent".
 * Pure.
 */
export function keepServerOwnedMeetingKeys(incoming: Record<string, unknown>, stored: unknown): Record<string, unknown> {
    const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    const out = { ...incoming };
    for (const k of SERVER_OWNED_MEETING_KEYS) {
        if (!(k in out) && k in base) out[k] = base[k];
    }
    return out;
}
