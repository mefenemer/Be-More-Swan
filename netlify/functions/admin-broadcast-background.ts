// admin-broadcast-background.ts — the slow part of a broadcast (15-minute ceiling).
//
//   POST { key, adminId }   Bearer CRON_TRIGGER_SECRET — started only by admin-broadcast.ts
//   POST { taskCostChangeId, notice, adminId }            — started only by admin-task-costs.ts: one
//        template per notice, with each change's figures merged in and its own once-each `type`.
//
// For each user still waiting (src/utils/broadcast.ts pendingRecipients): the in-app notice, then
// the email — to the customer from production, nowhere else (emailsGoToCustomers). The in-app row
// IS the "sent" mark, written first, so a crash or a second run never sends anyone two emails; a
// failed email is counted and logged, not retried. Stops starting new sends at 13 minutes and
// says how many are left, so pressing Send again finishes the rest.
import type { HandlerEvent } from '@netlify/functions';
import { getDb } from '../../db/client';
import { createNotification } from '../../src/utils/notify';
import { sendTemplatedEmail } from '../../src/utils/email';
import { insertAdminAuditLog } from '../../src/utils/admin-audit';
import { broadcastDef, pendingRecipients, emailsGoToCustomers } from '../../src/utils/broadcast';
import { cancelledNoticeKey, cancelledRecipients, noticeContext, noticeKey, readChange } from '../../src/utils/task-cost-changes';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { withLambda } from '@netlify/aws-lambda-compat';

const STOP_STARTING_AFTER_MS = 13 * 60 * 1000;
/** Resend's default limit is a few requests a second; this keeps well under it. */
const EMAIL_GAP_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) return { statusCode: 503, body: 'Trigger not configured.' };
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) return { statusCode: 401, body: 'Unauthorized.' };

    let body: { key?: string; adminId?: number; taskCostChangeId?: number; notice?: string } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* validated below */ }
    const adminId = Number(body.adminId);
    if (!Number.isInteger(adminId)) return { statusCode: 400, body: 'adminId required.' };

    const db = getDb();
    const startedAt = Date.now();
    const live = emailsGoToCustomers();

    // What this run sends: the template, the once-each mark, what merges in, and who still needs it.
    let templateKey: string;
    let sentMark: string;
    let context: Record<string, any> = {};
    let metadata: Record<string, unknown> = {};
    let recipients: Awaited<ReturnType<typeof pendingRecipients>>;
    if (body.taskCostChangeId !== undefined) {
        const change = await readChange(db, Number(body.taskCostChangeId));
        const cancelled = body.notice === 'cancelled';
        // A change withdrawn while its notice was going out must stop going out.
        if (!change || change.status !== (cancelled ? 'cancelled' : 'announced')) return { statusCode: 409, body: 'That change is not in a state to send.' };
        templateKey = cancelled ? 'task_cost_change_cancelled' : 'task_cost_change';
        sentMark = cancelled ? cancelledNoticeKey(change.id) : noticeKey(change.id);
        context = noticeContext(change, resolveBaseUrl(event.headers) || 'https://bemoreswan.com');
        metadata = { taskCostChangeId: change.id };
        recipients = cancelled ? await cancelledRecipients(db, change.id) : await pendingRecipients(db, sentMark);
    } else {
        const def = broadcastDef(body.key);
        if (!def) return { statusCode: 400, body: 'key required.' };
        templateKey = def.key;
        sentMark = def.key;
        recipients = await pendingRecipients(db, def.key);
    }
    let inApp = 0, emailed = 0, emailFailed = 0, left = 0;

    for (let i = 0; i < recipients.length; i++) {
        if (Date.now() - startedAt > STOP_STARTING_AFTER_MS) { left = recipients.length - i; break; }
        const r = recipients[i];
        const ok = await createNotification(db, templateKey, { userId: r.id, typeOverride: sentMark === templateKey ? undefined : sentMark, context, metadata: { ...metadata, broadcast: sentMark, emailed: live } });
        if (!ok) continue;   // no "sent" mark → no email, and the next run tries this person again
        inApp++;
        if (!live) continue;
        try {
            if (await sendTemplatedEmail({ triggerKey: templateKey, to: r.email, vars: { ...context, user: { first_name: r.firstName || 'there' } } })) emailed++;
            else emailFailed++;
        } catch (err) {
            emailFailed++;
            console.error(`[admin-broadcast] ${sentMark}: email to user ${r.id} failed:`, err instanceof Error ? err.message : err);
        }
        await sleep(EMAIL_GAP_MS);
    }

    const result = { key: sentMark, recipients: recipients.length, inApp, emailed, emailFailed, left, emailsGoToCustomers: live };
    console.log('[admin-broadcast] finished', result);
    await insertAdminAuditLog({ adminId, action: 'broadcast_finished', targetType: 'broadcast', targetId: sentMark, newState: result });
    return { statusCode: 200, body: JSON.stringify(result) };
});
