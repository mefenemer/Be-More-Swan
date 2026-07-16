// admin-notification-templates.ts — US-COMMS-2 (in-app Notification Template Management)
// Super-Admin-only API for the "Notification Templates" section.
//
//   GET  ?resource=list                    → all in-app templates (catalog ∪ DB overrides) + status
//   GET  ?resource=get&key=<templateKey>   → one template's editable fields + variable catalog
//   POST ?resource=save                    → upsert an admin edit (merge-var validated, audited)
//   POST ?resource=preview                 → render { title, message } with dummy data (no insert)
//   POST ?resource=restore                 → delete the admin override so the catalog default wins
//
// The list mirrors admin-email-templates.ts exactly, but for in-app copy: the code catalog
// (NOTIFICATION_DEFAULTS) is the canonical set, DB rows are lazily-created overrides, and the
// render engine (renderMergeVars) is shared with the live insert path (src/utils/notify.ts) so
// the preview is what the feed shows.
//
// Auth: cookie aura_session → JWT → users.role must clear 'manage_comms_templates' (super_admin).

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { users, notificationTemplates } from '../../db/schema';
import { requirePermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { renderMergeVars, validateMergeVars, sanitiseBodyHtml } from '../../src/utils/email-template';
import {
    NOTIFICATION_DEFAULTS,
    getNotificationDefault,
    sampleNotificationContext,
} from '../../src/utils/notification-templates-catalog';
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
    const [admin] = await db
        .select({ role: users.role, email: users.email })
        .from(users).where(eq(users.id, adminId)).limit(1);
    if (!admin) return json(401, { error: 'Account not found.' });
    // AC1: Super Admin only — non-super-admins can't see or reach this section.
    const denied = requirePermission(admin.role, 'manage_comms_templates');
    if (denied) return json(denied.statusCode, JSON.parse(denied.body));

    const qs = event.queryStringParameters || {};
    const resource = qs.resource || '';

    try {
        // ── GET list ────────────────────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'list') {
            const rows = await db
                .select({
                    templateKey: notificationTemplates.templateKey,
                    title: notificationTemplates.title,
                    isActive: notificationTemplates.isActive,
                    updatedAt: notificationTemplates.updatedAt,
                })
                .from(notificationTemplates);
            const overrides = new Map(rows.map((r) => [r.templateKey, r]));

            // The catalog defines the canonical, code-owned set (AC2).
            const list = NOTIFICATION_DEFAULTS.map((d) => {
                const ov = overrides.get(d.templateKey);
                return {
                    templateKey: d.templateKey,
                    name: d.name,
                    category: d.category,
                    channel: 'In-App' as const,   // AC2: surface the delivery channel
                    title: ov?.title ?? d.title,
                    isActive: ov ? ov.isActive : true,
                    edited: !!ov,
                    updatedAt: ov?.updatedAt ?? null,
                };
            });
            return json(200, { templates: list });
        }

        // ── GET get ───────────────────────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'get') {
            const key = qs.key || '';
            const def = getNotificationDefault(key);
            if (!def) return json(404, { error: 'Unknown notification template.' });

            const [ov] = await db.select().from(notificationTemplates)
                .where(eq(notificationTemplates.templateKey, key)).limit(1);
            return json(200, {
                template: {
                    templateKey: def.templateKey,
                    name: def.name,
                    category: def.category,
                    channel: 'In-App',
                    // Admin-editable fields: DB override falls back to the catalog default.
                    title: ov?.title ?? def.title,
                    message: ov?.message ?? def.message,
                    isActive: ov ? ov.isActive : true,
                    edited: !!ov,
                },
                defaults: { title: def.title, message: def.message },
                // AC4: only the variables this notification's call site actually supplies.
                variables: def.variables,
            });
        }

        // ── POST save ─────────────────────────────────────────────────────────────
        if (event.httpMethod === 'POST' && resource === 'save') {
            const body = JSON.parse(event.body || '{}');
            const { templateKey, title, message } = body;
            let isActive = body.isActive;

            const def = getNotificationDefault(templateKey);
            if (!def) return json(400, { error: 'Unknown notification template.' }); // AC2: can't invent keys
            if (!title?.trim()) return json(400, { error: 'Title is required.' });
            if (typeof isActive !== 'boolean') isActive = true;

            // AC5: reject copy that references merge variables the call site never supplies,
            // or malformed {{...}} spans that would ship to users verbatim.
            const allowed = def.variables.map((v) => v.key);
            const titleCheck = validateMergeVars(title, allowed);
            const messageCheck = validateMergeVars(message ?? '', allowed);
            const unknown = [...new Set([...titleCheck.unknown, ...messageCheck.unknown])];
            const malformed = [...new Set([...titleCheck.malformed, ...messageCheck.malformed])];
            if (unknown.length || malformed.length) {
                return json(422, {
                    error: 'Template contains variables that will not render.',
                    unknown, malformed,
                });
            }

            const [prev] = await db.select().from(notificationTemplates)
                .where(eq(notificationTemplates.templateKey, templateKey)).limit(1);

            const cleanMessage = message?.trim() ? sanitiseBodyHtml(message) : null;
            const values = {
                templateKey,
                title: title.trim(),
                message: cleanMessage,
                isActive,
                updatedByAdminId: adminId,
            };

            await db.insert(notificationTemplates)
                .values(values)
                .onConflictDoUpdate({
                    target: notificationTemplates.templateKey,
                    set: withUpdatedAt({
                        title: values.title,
                        message: values.message,
                        isActive: values.isActive,
                        updatedByAdminId: adminId,
                    }),
                });

            await insertAdminAuditLog({
                adminId,
                action: 'notification_template_edit',
                targetType: 'notification_template',
                targetId: templateKey,
                previousState: prev ? { title: prev.title, message: prev.message, isActive: prev.isActive } : undefined,
                newState: { title: values.title, message: values.message, isActive: values.isActive },
                ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
                userAgent: event.headers['user-agent'],
            });

            return json(200, { ok: true });
        }

        // ── POST restore (AC7) ────────────────────────────────────────────────────
        // Delete the override row; the catalog default takes over on the next render.
        if (event.httpMethod === 'POST' && resource === 'restore') {
            const body = JSON.parse(event.body || '{}');
            const { templateKey } = body;
            const def = getNotificationDefault(templateKey);
            if (!def) return json(400, { error: 'Unknown notification template.' });

            const [prev] = await db.select().from(notificationTemplates)
                .where(eq(notificationTemplates.templateKey, templateKey)).limit(1);
            if (prev) {
                await db.delete(notificationTemplates).where(eq(notificationTemplates.templateKey, templateKey));
                await insertAdminAuditLog({
                    adminId,
                    action: 'notification_template_restore',
                    targetType: 'notification_template',
                    targetId: templateKey,
                    previousState: { title: prev.title, message: prev.message, isActive: prev.isActive },
                    newState: { title: def.title, message: def.message, isActive: true },
                    ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
                    userAgent: event.headers['user-agent'],
                });
            }
            return json(200, {
                ok: true,
                template: { title: def.title, message: def.message, isActive: true, edited: false },
            });
        }

        // ── POST preview (AC6) ──────────────────────────────────────────────────
        // Render the (possibly unsaved) title/message with dummy data. Uses the same
        // escape-values / trust-template contract as the live insert path.
        if (event.httpMethod === 'POST' && resource === 'preview') {
            const body = JSON.parse(event.body || '{}');
            const { templateKey, title, message } = body;
            const def = getNotificationDefault(templateKey);
            if (!def) return json(400, { error: 'Unknown notification template.' });

            const ctx = sampleNotificationContext(templateKey);
            return json(200, {
                title: renderMergeVars(title ?? def.title, ctx),
                message: renderMergeVars(sanitiseBodyHtml(message ?? def.message ?? ''), ctx),
            });
        }

        return json(404, { error: 'Unknown resource.' });
    } catch (err: any) {
        console.error('[admin-notification-templates]', err);
        return json(500, { error: 'Internal error.' });
    }
});
