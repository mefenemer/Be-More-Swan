// admin-broadcast.ts — send a reviewed notice to every customer, once each (Comms → Broadcast).
//
//   GET  ?resource=list                     → each notice in BROADCASTS: its in-app and email copy,
//                                              how many are waiting for it, how many have it, and
//                                              whether emails reach customers from this deploy
//   POST ?resource=test   { key }           → the notice to YOU only (in-app + email), to check it
//   POST ?resource=send   { key, expected } → hands the send to admin-broadcast-background
//
// `expected` must equal the waiting count the admin was shown: a stale page, or a second admin
// sending at the same time, gets a 409 instead of a send nobody looked at. The rules for who gets
// it, once-each and production-only email are in src/utils/broadcast.ts.
//
// Auth mirrors admin-send-notification.ts: aura_session → JWT → 'manage_comms_templates'
// (super_admin), never during impersonation. Live database only — a broadcast to sandbox users
// would test nothing and a toggle left on would make the real send silently go nowhere.

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { requirePermission, hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { createNotification } from '../../src/utils/notify';
import { renderTemplate, sendTemplatedEmail } from '../../src/utils/email';
import { NOTIFICATION_DEFAULTS } from '../../src/utils/notification-templates-catalog';
import { resolveEnvironment } from '../../src/utils/env-context';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { BROADCASTS, broadcastDef, pendingRecipients, alreadySentCount, emailsGoToCustomers } from '../../src/utils/broadcast';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });

    // ── Auth ──────────────────────────────────────────────────────────────────
    const cookieMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!cookieMatch) return json(401, { error: 'Not authenticated.' });
    let adminId: number;
    try {
        const tok = jwt.verify(cookieMatch[1], jwtSecret) as any;
        if (tok.scope === 'impersonate') return json(403, { error: 'Action blocked during impersonation session.' });
        adminId = tok.userId;
    } catch {
        return json(401, { error: 'Invalid session.' });
    }
    const db = getDb();
    const [admin] = await db.select({ role: users.role, email: users.email, firstName: users.firstName })
        .from(users).where(eq(users.id, adminId)).limit(1);
    if (!admin) return json(401, { error: 'Account not found.' });
    const denied = requirePermission(admin.role, 'manage_comms_templates');
    if (denied) return json(denied.statusCode, JSON.parse(denied.body));
    if (resolveEnvironment(event.headers, { allowSandbox: hasPermission(admin.role, 'sandbox_access') }) !== 'live') {
        return json(400, { error: 'Turn the Sandbox toggle off — a broadcast only goes to the live workspace list.' });
    }

    const resource = event.queryStringParameters?.resource;

    if (event.httpMethod === 'GET' && resource === 'list') {
        const out = [];
        for (const b of BROADCASTS) {
            const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === b.key);
            const email = await renderTemplate(b.key, { user: { first_name: admin.firstName || 'there' } });
            out.push({
                ...b,
                inApp: tpl ? { title: tpl.title, message: tpl.message } : null,
                email: email ? { subject: email.subject, html: email.html } : null,
                waiting: (await pendingRecipients(db, b.key)).length,
                alreadySent: await alreadySentCount(db, b.key),
            });
        }
        return json(200, { broadcasts: out, emailsGoToCustomers: emailsGoToCustomers(), you: admin.email });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    let body: { key?: string; expected?: number };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body.' }); }
    const def = broadcastDef(body.key);
    if (!def) return json(400, { error: 'That notice is not one that can be broadcast.' });
    const audit = (action: 'broadcast_test' | 'broadcast_started', newState: Record<string, unknown>) => insertAdminAuditLog({
        adminId, action, targetType: 'broadcast', targetId: def.key, newState: { key: def.key, ...newState },
        ipAddress: getAdminIp(event.headers as Record<string, string | undefined>), userAgent: event.headers['user-agent'],
    });

    if (resource === 'test') {
        // The admin's own copy. It counts as theirs (once each), which is what a real send would do.
        const inApp = await createNotification(db, def.key, { userId: adminId, metadata: { broadcast: def.key, test: true } });
        let emailed = false;
        try { emailed = !!(await sendTemplatedEmail({ triggerKey: def.key, to: admin.email, vars: { user: { first_name: admin.firstName || 'there' } } })); }
        catch (err) { console.error('[admin-broadcast] test email failed:', err); }
        await audit('broadcast_test', { inApp, emailed, to: admin.email });
        return json(200, { inApp, emailed, to: admin.email });
    }

    if (resource === 'send') {
        const waiting = (await pendingRecipients(db, def.key)).length;
        if (!Number.isInteger(body.expected) || body.expected !== waiting) {
            return json(409, { error: `The number waiting has changed to ${waiting}. Check it again before sending.`, waiting });
        }
        if (waiting === 0) return json(400, { error: 'Everyone already has this notice.' });
        const secret = process.env.CRON_TRIGGER_SECRET;
        const base = resolveBaseUrl(event.headers);
        if (!secret || !base) return json(503, { error: !secret ? 'CRON_TRIGGER_SECRET is not set on this site.' : 'Could not work out this site\'s address.' });
        await audit('broadcast_started', { waiting, emailsGoToCustomers: emailsGoToCustomers() });
        try {
            const res = await fetch(`${base}/.netlify/functions/admin-broadcast-background`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
                body: JSON.stringify({ key: def.key, adminId }),
                signal: AbortSignal.timeout(8_000),
            });
            if (!(res.status === 202 || res.ok)) return json(502, { error: `The sender refused to start (HTTP ${res.status}).` });
        } catch (err) {
            return json(502, { error: `The sender could not be reached: ${err instanceof Error ? err.message : String(err)}` });
        }
        return json(202, { started: true, waiting, emailsGoToCustomers: emailsGoToCustomers() });
    }

    return json(400, { error: 'Unknown resource.' });
});
