// netlify/functions/mail-push-graph.ts — Microsoft Graph's change notifications for a connected Outlook inbox
// (docs/email-assistant-plan.md §4.3, Phase 3b). Also the subscription's lifecycle URL.
//
//   ?validationToken=…  Graph checking the URL when a subscription is created: echo it back as
//                       text/plain within 10 seconds.
//   POST { value: [...] } each notification names its subscription and carries our clientState
//                       (graphClientState, derived from GRAPH_NOTIFY_SECRET). Wrong or missing clientState
//                       → ignored. A new email → recordPush → the background reader runs the delta query.
//   lifecycleEvent      reauthorizationRequired → renew now; subscriptionRemoved → forget it (the next
//                       poll run makes a new one); missed → read the mailbox now.
//
// Always 202 with a body for a well-formed POST: Graph retries and eventually drops a URL that fails.
// Notifications carry ids only (no resource data), and only mailbox ids are logged.

import { withLambda } from '@netlify/aws-lambda-compat';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { mailboxes } from '../../db/schema';
import { isFeatureEnabled } from '../../src/utils/feature-flags';
import { EMAIL_ASSISTANT_FLAG } from '../../src/utils/mailboxes';
import {
    clearWatch, clientStateMatches, ensureWatch, mailboxForSubscription, parseGraphNotifications, pushConfigured, recordPush,
} from '../../src/utils/mailbox-push';

const accepted = { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };

/** Graph's validation token, echoed only if it looks like one (plain text, bounded). Pure. */
export function validationReply(token: string): { statusCode: number; headers: Record<string, string>; body: string } {
    const safe = token.length <= 1024 && !/[<>]/.test(token);
    return safe
        ? { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: token }
        : { statusCode: 400, headers: { 'Content-Type': 'text/plain' }, body: 'Bad token' };
}

export default withLambda(async (event) => {
    const validationToken = event.queryStringParameters?.validationToken;
    if (typeof validationToken === 'string' && validationToken) return validationReply(validationToken);
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!pushConfigured('outlook')) return accepted;

    let body: unknown = null;
    try { body = JSON.parse(event.body || 'null'); } catch { /* ignored below */ }
    const notes = parseGraphNotifications(body);
    if (!notes.length) return accepted;

    try {
        const db = getDb();
        const toRead: number[] = [];
        for (const n of notes) {
            const box = await mailboxForSubscription(db, n.subscriptionId);
            if (!box || !clientStateMatches(box.id, n.clientState)) continue; // not ours, or forged
            if (n.lifecycleEvent === 'subscriptionRemoved') { await clearWatch(db, box.id); toRead.push(box.id); continue; }
            if (n.lifecycleEvent === 'reauthorizationRequired') {
                const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).limit(1);
                if (row && await isFeatureEnabled(row.organisationId, EMAIL_ASSISTANT_FLAG).catch(() => false)) await ensureWatch(db, row);
                continue;
            }
            toRead.push(box.id); // a new email, or 'missed'
        }
        const r = await recordPush(db, toRead);
        console.log('[mail-push-graph]', { notifications: notes.length, mailboxIds: [...new Set(toRead)], ...r });
        return accepted;
    } catch (err) {
        console.error('[mail-push-graph]', err instanceof Error ? err.message : err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
