// admin-email-templates.ts — US-COMMS-1 (Feature 1: Email Template Management)
// Admin-only API for the "Manage Emails" section.
//
//   GET  ?resource=list                 → all triggers (catalog ∪ DB overrides) + status
//   GET  ?resource=get&key=<triggerKey> → one template's editable fields + variable catalog
//   POST ?resource=save                 → upsert an admin edit (governance-checked, audited)
//   POST ?resource=preview              → render { subject, html } with dummy data (no send)
//   POST ?resource=test                 → send a test copy to the logged-in admin (AC1.3.2)
//
// Auth: cookie aura_session → JWT → users.role must be an admin role. The brand shell and
// merge engine are shared with the live send path (src/utils/email.ts renderTemplate), so
// the preview is byte-for-byte what subscribers receive.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { users, emailTemplates } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { renderTemplate, sendEmail } from '../../src/utils/email';
import { EMAIL_VARIABLES, sampleContext, sanitiseBodyHtml } from '../../src/utils/email-template';
import { TEMPLATE_DEFAULTS, getTemplateDefault } from '../../src/utils/email-templates-catalog';

const jwtSecret = process.env.JWT_SECRET;

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
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
    if (!admin || !isAdminRole(admin.role)) return json(403, { error: 'Admin role required.' });

    const qs = event.queryStringParameters || {};
    const resource = qs.resource || '';

    try {
        // ── GET list ────────────────────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'list') {
            const rows = await db
                .select({
                    triggerKey: emailTemplates.triggerKey,
                    subject: emailTemplates.subject,
                    isActive: emailTemplates.isActive,
                    updatedAt: emailTemplates.updatedAt,
                })
                .from(emailTemplates);
            const overrides = new Map(rows.map((r) => [r.triggerKey, r]));

            // The catalog defines the canonical, code-owned set of triggers (AC3.2.1).
            const list = TEMPLATE_DEFAULTS.map((d) => {
                const ov = overrides.get(d.triggerKey);
                return {
                    triggerKey: d.triggerKey,
                    name: d.name,
                    category: d.category,
                    subject: ov?.subject ?? d.subject,
                    locked: !!d.locked,
                    transactional: !!d.transactional,
                    isActive: ov ? ov.isActive : true,
                    edited: !!ov,
                    updatedAt: ov?.updatedAt ?? null,
                };
            });
            return json(200, { templates: list, variables: EMAIL_VARIABLES });
        }

        // ── GET get ───────────────────────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'get') {
            const key = qs.key || '';
            const def = getTemplateDefault(key);
            if (!def) return json(404, { error: 'Unknown template trigger.' });

            const [ov] = await db.select().from(emailTemplates).where(eq(emailTemplates.triggerKey, key)).limit(1);
            return json(200, {
                template: {
                    triggerKey: def.triggerKey,
                    name: def.name,
                    category: def.category,
                    locked: !!def.locked,
                    transactional: !!def.transactional,
                    // Admin-editable fields: DB override falls back to the catalog default.
                    subject: ov?.subject ?? def.subject,
                    bodyHtml: ov?.bodyHtml ?? def.bodyHtml,
                    preheader: ov?.preheader ?? def.preheader ?? '',
                    isActive: ov ? ov.isActive : true,
                    edited: !!ov,
                },
                defaults: { subject: def.subject, bodyHtml: def.bodyHtml, preheader: def.preheader ?? '' },
                variables: EMAIL_VARIABLES,
            });
        }

        // ── POST save ─────────────────────────────────────────────────────────────
        if (event.httpMethod === 'POST' && resource === 'save') {
            const body = JSON.parse(event.body || '{}');
            const { triggerKey, subject, bodyHtml, preheader } = body;
            let isActive = body.isActive;

            const def = getTemplateDefault(triggerKey);
            if (!def) return json(400, { error: 'Unknown or non-editable trigger.' }); // AC3.2.1: can't invent triggers
            if (!subject?.trim() || !bodyHtml?.trim()) {
                return json(400, { error: 'Subject and body are both required.' });
            }
            // AC3.2.2: critical (locked) templates can never be deactivated.
            if (def.locked) isActive = true;
            if (typeof isActive !== 'boolean') isActive = true;

            const [prev] = await db.select().from(emailTemplates).where(eq(emailTemplates.triggerKey, triggerKey)).limit(1);

            const values = {
                triggerKey,
                name: def.name,
                category: def.category,
                subject: subject.trim(),
                bodyHtml: sanitiseBodyHtml(bodyHtml),
                preheader: preheader?.trim() || null,
                isActive,
                locked: !!def.locked,
                transactional: !!def.transactional,
                updatedByAdminId: adminId,
            };

            await db.insert(emailTemplates)
                .values(values)
                .onConflictDoUpdate({
                    target: emailTemplates.triggerKey,
                    set: withUpdatedAt({
                        subject: values.subject,
                        bodyHtml: values.bodyHtml,
                        preheader: values.preheader,
                        isActive: values.isActive,
                        updatedByAdminId: adminId,
                    }),
                });

            // Audit the edit — previous payload archived for traceability (foundation for
            // Feature 3 version history; the full template_versions table lands there).
            await insertAdminAuditLog({
                adminId,
                action: 'email_template_edit',
                targetType: 'email_template',
                targetId: triggerKey,
                previousState: prev ? { subject: prev.subject, bodyHtml: prev.bodyHtml, preheader: prev.preheader, isActive: prev.isActive } : undefined,
                newState: { subject: values.subject, bodyHtml: values.bodyHtml, preheader: values.preheader, isActive: values.isActive },
                ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
                userAgent: event.headers['user-agent'],
            });

            return json(200, { ok: true });
        }

        // ── POST preview / test ─────────────────────────────────────────────────
        if (event.httpMethod === 'POST' && (resource === 'preview' || resource === 'test')) {
            const body = JSON.parse(event.body || '{}');
            const { triggerKey, subject, bodyHtml, preheader } = body;
            const def = getTemplateDefault(triggerKey);
            if (!def) return json(400, { error: 'Unknown trigger.' });

            // Render with dummy data so merge tags resolve visibly (AC1.3.2). Uses the same
            // engine as production — overrides let admins preview unsaved edits.
            const rendered = await renderTemplate(triggerKey, sampleContext(), {
                overrideSubject: subject,
                overrideBody: bodyHtml,
                transactional: !!def.transactional,
            });
            if (!rendered) return json(500, { error: 'Failed to render template.' });
            // preheader override is cosmetic for preview; the saved row drives production.
            void preheader;

            if (resource === 'preview') {
                return json(200, { subject: rendered.subject, html: rendered.html });
            }

            // test → deliver to the logged-in admin's own inbox.
            if (!admin.email) return json(400, { error: 'Your admin account has no email address on file.' });
            await sendEmail({ to: admin.email, subject: `[TEST] ${rendered.subject}`, html: rendered.html });
            return json(200, { ok: true, sentTo: admin.email });
        }

        return json(404, { error: 'Unknown resource.' });
    } catch (err: any) {
        console.error('[admin-email-templates]', err);
        return json(500, { error: 'Internal error.' });
    }
};
