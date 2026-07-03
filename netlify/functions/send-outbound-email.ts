// netlify/functions/send-outbound-email.ts
// US-GOV-3.1.2: Infrastructure-level endpoint for AI-drafted outbound emails.
// Injects the mandatory AI disclosure footer before sending — cannot be bypassed.
//
// POST /.netlify/functions/send-outbound-email
//   Auth: aura_session cookie (run owner)
//   Body: {
//     taskRunId:   number,
//     assistantId: number,
//     to:          string,
//     subject:     string,
//     bodyText:    string,   // plain-text version (required)
//     bodyHtml?:   string,   // HTML version (optional)
//     integrationAuthId?: number,  // to look up custom disclosure text
//   }
//
// Returns { success, emailId, footerVersion }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { getDb } from '../../db/client';
import { taskRuns, aiAssistants, integrationAuthorizations, agentRunEvents, notifications } from '../../db/schema';
import { injectAiFooter, FOOTER_VERSION } from '../../src/utils/ai-email-footer';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';

const jwtSecret = process.env.JWT_SECRET;
const resend    = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (null as unknown as Resend); // guarded: resend v6 throws at construction when key missing -> would crash module at import
const FROM_DOMAIN = process.env.OUTBOUND_EMAIL_DOMAIN || 'outbound.bemoreswan.com';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // ── 1. Auth ────────────────────────────────────────────────────────────────
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    // ── 2. Parse body ──────────────────────────────────────────────────────────
    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { taskRunId, assistantId, to, subject, bodyText, bodyHtml, integrationAuthId } = body;
    if (!taskRunId || !assistantId || !to || !subject || !bodyText) {
        return { statusCode: 400, body: JSON.stringify({ error: 'taskRunId, assistantId, to, subject, and bodyText are required.' }) };
    }

    const db = getDb();

    // Resolve the active organisation (member-shared assistant ownership; membership verified).
    const org = await resolveActiveOrg(db, userId, getSession(event)?.activeOrganisationId);
    if (!org) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation associated with this account.' }) };
    const orgId = org.organisationId;

    // ── 3. Verify run ownership ────────────────────────────────────────────────
    const [run] = await db.select({ id: taskRuns.id })
        .from(taskRuns)
        .where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.userId, userId)))
        .limit(1);
    if (!run) return { statusCode: 404, body: JSON.stringify({ error: 'Task run not found.' }) };

    // ── 4. Load assistant name (scoped to the active organisation) ─────────────
    const [assistant] = await db.select({ name: aiAssistants.name })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    // ── 5. Look up custom disclosure text ─────────────────────────────────────
    let customDisclosureText: string | null = null;
    if (integrationAuthId) {
        const [auth] = await db.select({ disclosureText: integrationAuthorizations.disclosureText })
            .from(integrationAuthorizations)
            .where(eq(integrationAuthorizations.id, integrationAuthId))
            .limit(1);
        customDisclosureText = auth?.disclosureText ?? null;
    }

    // ── 6. Inject footer (mandatory — no bypass) ───────────────────────────────
    const finalText = injectAiFooter(bodyText, assistant.name, customDisclosureText, false);
    const finalHtml = bodyHtml
        ? injectAiFooter(bodyHtml, assistant.name, customDisclosureText, true)
        : undefined;

    // ── 7. Send email ──────────────────────────────────────────────────────────
    const sentAt = new Date();
    let emailId: string | null = null;

    if (process.env.RESEND_API_KEY) {
        const result = await resend.emails.send({
            from: `${assistant.name} via Be More Swan <assistant@${FROM_DOMAIN}>`,
            to,
            subject,
            text: finalText,
            ...(finalHtml ? { html: finalHtml } : {}),
        });
        emailId = (result as any)?.data?.id ?? null;
    } else {
        // Dev mode — log instead of send
        console.log(`[DEV] Outbound email to ${to}: subject="${subject}", footerVersion=${FOOTER_VERSION}`);
        emailId = `dev_${Date.now()}`;
    }

    // ── 8. Audit log — footerVersion per email send ────────────────────────────
    const [lastEvent] = await db.select({ eventIndex: agentRunEvents.eventIndex })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.taskRunId, taskRunId))
        .orderBy(agentRunEvents.eventIndex)
        .limit(1);

    await db.insert(agentRunEvents).values({
        taskRunId,
        eventType: 'tool_call',
        toolName:  'send_email',
        eventIndex: (lastEvent?.eventIndex ?? 0) + 1,
        inputPayload:  { to, subject },
        outputPayload: {
            emailId,
            assistantId,
            footerVersion: FOOTER_VERSION,
            sentAt: sentAt.toISOString(),
            footerInjected: true,
        },
    });

    // In-app notification confirming send
    await db.insert(notifications).values({
        userId,
        type:    'system',
        title:   `Email sent by ${assistant.name}`,
        message: `An outbound email was sent to ${to} with subject "${subject}". AI disclosure footer v${FOOTER_VERSION} was appended.`,
        metadata: { emailId, assistantId, footerVersion: FOOTER_VERSION, taskRunId },
    }).catch(() => {});

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, emailId, footerVersion: FOOTER_VERSION }),
    };
};
