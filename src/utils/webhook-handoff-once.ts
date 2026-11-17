// Custom webhook recipes (Zapier / Make / the customer's own endpoint) POST ONCE per hand-off, however many
// times the scenario job is retried (PR #695 review, 2026-11-17).
//
// process-scenario-jobs.ts retries the WHOLE job when any one recipe fails — a Slack 5xx, "another run is
// sending it", a Jira error. The follow-up email, Slack summary and Notion page are already once per
// meeting (meeting-handoff-once.ts), but the Tier 2 webhook had no guard, so every retry POSTed the same
// meeting or lead to the customer's Zap again: duplicate rows, duplicate tasks, duplicate emails on their side.
//
// Two ledgers, one rule (claim → POST → finish):
//   meeting records   data.handoffs['webhook:<scenarioKey>'] on the meeting, through claimMeetingHandoff /
//                     finishMeetingHandoff — so a re-approval does not POST again either, exactly like the
//                     follow-up email, Slack and Notion.
//   anything else     (lead hand-offs: universal_webhook_handoff) the job's own subject.webhooksSent list —
//                     a retry of THIS job skips a webhook that already went; a new approval is a new job
//                     and POSTs as it does today.
// A webhook that itself fails (non-2xx or a network error) releases its claim and is reported as an error,
// so the job retries it as before.

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { claimMeetingHandoff, finishMeetingHandoff, type HandoffClaim } from './meeting-handoff-once';

type Db = ReturnType<typeof getDb>;

export interface WebhookLedger {
    claim(): Promise<HandoffClaim>;
    finish(ok: boolean): Promise<void>;
}

/** The data.handoffs key a webhook recipe is stamped under on a meeting. Pure. */
export function webhookHandoffKey(scenarioKey: string): string {
    return `webhook:${scenarioKey}`;
}

/** Webhook recipes this job has already POSTed successfully (subject.webhooksSent). Pure. */
export function webhooksSentOnJob(subject: unknown): string[] {
    const list = subject && typeof subject === 'object' ? (subject as { webhooksSent?: unknown }).webhooksSent : undefined;
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
}

function isMeetingRecord(subject: { recordType?: unknown; recordId?: unknown }): boolean {
    return subject.recordType === 'meeting' && Number.isInteger(Number(subject.recordId)) && Number(subject.recordId) > 0;
}

/** Pick the ledger for this webhook recipe on this job. */
export function webhookLedger(
    db: Db,
    job: { id: number; organisationId: number; subject: unknown },
    scenarioKey: string,
): WebhookLedger {
    const subject = (job.subject && typeof job.subject === 'object' ? job.subject : {}) as { recordType?: unknown; recordId?: unknown };
    const key = webhookHandoffKey(scenarioKey);

    if (isMeetingRecord(subject)) {
        const recordId = Number(subject.recordId);
        return {
            claim: () => claimMeetingHandoff(db, job.organisationId, recordId, key),
            finish: (ok) => finishMeetingHandoff(db, job.organisationId, recordId, key, ok),
        };
    }

    // Only one runner holds a job at a time (the drain's atomic queued → processing claim), so the job's
    // own list needs no claim of its own: already listed = done, otherwise run it.
    return {
        claim: async () => (webhooksSentOnJob(job.subject).includes(scenarioKey) ? 'done' : 'claimed'),
        finish: async (ok) => {
            if (!ok) return;
            try {
                await db.execute(sql`
                    UPDATE scenario_jobs
                       SET subject = jsonb_set(subject, '{webhooksSent}',
                               COALESCE(subject->'webhooksSent', '[]'::jsonb) || to_jsonb(${scenarioKey}::text))
                     WHERE id = ${job.id}
                       AND NOT COALESCE(subject->'webhooksSent', '[]'::jsonb) ? ${scenarioKey}::text`);
            } catch (err) {
                // A missed record means a retry of this job could POST again; logged loudly for that reason.
                console.error(`[webhook-handoff-once] could not record ${scenarioKey} as sent on job ${job.id}`, err);
            }
        },
    };
}

export type WebhookOutcome =
    | { outcome: 'sent'; status: number }
    | { outcome: 'already_sent' }
    | { outcome: 'busy' }
    | { outcome: 'failed'; status: number }
    | { outcome: 'error'; error: Error };

/**
 * Claim, POST, finish. Never throws. 'already_sent' is a success the caller skips quietly; 'busy', 'failed'
 * and 'error' are errors the caller reports so the job retries.
 */
export async function sendWebhookOnce(
    ledger: WebhookLedger,
    post: () => Promise<{ ok: boolean; status: number }>,
): Promise<WebhookOutcome> {
    const claim = await ledger.claim();
    if (claim === 'done') return { outcome: 'already_sent' };
    if (claim === 'busy') return { outcome: 'busy' };
    let res: { ok: boolean; status: number };
    try {
        res = await post();
    } catch (err) {
        await ledger.finish(false);
        return { outcome: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
    await ledger.finish(res.ok);
    return res.ok ? { outcome: 'sent', status: res.status } : { outcome: 'failed', status: res.status };
}
