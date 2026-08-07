// admin-send-notification.ts — ad-hoc admin → user in-app message ("Send a Message").
//
//   POST ?resource=send   { userId, title, message }  → insert ONE notification, audited
//
// The gap this fills: every other notification in the product is an event-driven side effect
// (a ticket reply, a failed payment, a draft going live). There was no way for an admin to
// simply tell one user something. The Comms → Notification Templates section next door edits
// the COPY of automated notifications and deliberately never inserts — its `preview` renders
// against dummy data.
//
// Auth mirrors admin-notification-templates.ts exactly: cookie aura_session → JWT → role must
// clear 'manage_comms_templates' (super_admin). Starting super-admin-only is deliberate; this
// is a new outward-facing capability, and loosening the permission later is a one-word change
// here plus one in the admin.html nav entry.
//
// ⚠️ Environment routing is not optional here (see the block below the auth section).

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { requirePermission, hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { createAdminMessage } from '../../src/utils/notify';
import { resolveEnvironment, runWithEnvironment } from '../../src/utils/env-context';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

// Long enough for a real message, short enough that the card stays a notification rather than
// becoming an email nobody reads in a 4-line clamp. The client enforces the same numbers.
const TITLE_MAX = 120;
const MESSAGE_MAX = 2000;

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    // ── Auth ──────────────────────────────────────────────────────────────────
    const cookieMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!cookieMatch) return json(401, { error: 'Not authenticated.' });
    let adminId: number;
    try {
        const tok = jwt.verify(cookieMatch[1], jwtSecret) as any;
        // A message signed "Be More Swan" sent from inside someone else's session would be
        // attributable to the wrong person in the audit trail.
        if (tok.scope === 'impersonate') return json(403, { error: 'Action blocked during impersonation session.' });
        adminId = tok.userId;
    } catch {
        return json(401, { error: 'Invalid session.' });
    }

    // Auth/role resolution always reads live, matching admin-api.ts — admin accounts are not
    // duplicated into sandbox.
    const authDb = getDb();
    const [admin] = await authDb
        .select({ role: users.role })
        .from(users).where(eq(users.id, adminId)).limit(1);
    if (!admin) return json(401, { error: 'Account not found.' });
    const denied = requirePermission(admin.role, 'manage_comms_templates');
    if (denied) return json(denied.statusCode, JSON.parse(denied.body));

    // ── Environment ───────────────────────────────────────────────────────────
    // ⚠️ This has to match the picker or the feature messages the wrong human. The recipient
    // list comes from admin-api?resource=users, which runs env-routed (admin-api.ts:130). With
    // the portal's Sandbox toggle on, that returns SANDBOX user ids — and sandbox user #42 and
    // live user #42 are different people. Resolving the same way keeps the id the admin clicked
    // and the row we write in the same database.
    const env = resolveEnvironment(event.headers, { allowSandbox: hasPermission(admin.role, 'sandbox_access') });

    return runWithEnvironment(env, async () => {
        const db = getDb();

        // ── Validate ──────────────────────────────────────────────────────────
        let body: any;
        try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON body.' }); }

        const userId = Number(body.userId);
        const title = String(body.title ?? '').trim();
        const message = String(body.message ?? '').trim();

        if (!Number.isInteger(userId) || userId <= 0) return json(400, { error: 'A recipient is required.' });
        if (!title) return json(400, { error: 'A title is required.' });
        if (title.length > TITLE_MAX) return json(400, { error: `Title must be ${TITLE_MAX} characters or fewer.` });
        if (!message) return json(400, { error: 'A message is required.' });
        if (message.length > MESSAGE_MAX) return json(400, { error: `Message must be ${MESSAGE_MAX} characters or fewer.` });

        // Re-read the recipient rather than trusting the id the client posted, so the success
        // response can name who was ACTUALLY messaged. There is no delivery receipt in this
        // system; echoing the resolved identity back is the only confirmation the admin gets.
        const [recipient] = await db
            .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
            .from(users).where(eq(users.id, userId)).limit(1);
        if (!recipient) return json(404, { error: 'That user no longer exists.' });

        // ── Send ──────────────────────────────────────────────────────────────
        // createAdminMessage is best-effort like the rest of notify.ts and returns false rather
        // than throwing. Every other call site can ignore that because a dropped notification is
        // a side effect of some other successful action; here it IS the action, and a human is
        // waiting, so a false must not be reported as a send.
        const sent = await createAdminMessage(db, { userId: recipient.id, title, message });
        if (!sent) return json(500, { error: 'The message could not be delivered. Nothing was sent.' });

        await insertAdminAuditLog({
            adminId,
            action: 'notification_sent',
            targetType: 'user',
            targetId: recipient.id,
            newState: { title, message, environment: env },
            ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
            userAgent: event.headers['user-agent'],
        });

        const name = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ').trim();
        return json(200, {
            sent: true,
            recipient: { id: recipient.id, name: name || null, email: recipient.email },
        });
    });
});
