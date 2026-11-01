// admin-broadcast-background.ts — the slow part of a broadcast (15-minute ceiling).
//
//   POST { key, adminId }   Bearer CRON_TRIGGER_SECRET — started only by admin-broadcast.ts
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

    let body: { key?: string; adminId?: number } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* validated below */ }
    const def = broadcastDef(body.key);
    const adminId = Number(body.adminId);
    if (!def || !Number.isInteger(adminId)) return { statusCode: 400, body: 'key and adminId required.' };

    const db = getDb();
    const startedAt = Date.now();
    const live = emailsGoToCustomers();
    const recipients = await pendingRecipients(db, def.key);
    let inApp = 0, emailed = 0, emailFailed = 0, left = 0;

    for (let i = 0; i < recipients.length; i++) {
        if (Date.now() - startedAt > STOP_STARTING_AFTER_MS) { left = recipients.length - i; break; }
        const r = recipients[i];
        const ok = await createNotification(db, def.key, { userId: r.id, metadata: { broadcast: def.key, emailed: live } });
        if (!ok) continue;   // no "sent" mark → no email, and the next run tries this person again
        inApp++;
        if (!live) continue;
        try {
            if (await sendTemplatedEmail({ triggerKey: def.key, to: r.email, vars: { user: { first_name: r.firstName || 'there' } } })) emailed++;
            else emailFailed++;
        } catch (err) {
            emailFailed++;
            console.error(`[admin-broadcast] ${def.key}: email to user ${r.id} failed:`, err instanceof Error ? err.message : err);
        }
        await sleep(EMAIL_GAP_MS);
    }

    const result = { key: def.key, recipients: recipients.length, inApp, emailed, emailFailed, left, emailsGoToCustomers: live };
    console.log('[admin-broadcast] finished', result);
    await insertAdminAuditLog({ adminId, action: 'broadcast_finished', targetType: 'broadcast', targetId: def.key, newState: result });
    return { statusCode: 200, body: JSON.stringify(result) };
});
