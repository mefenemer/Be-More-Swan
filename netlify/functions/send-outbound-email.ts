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
import { getDb } from '../../db/client';
import { taskRuns, aiAssistants, integrationAuthorizations, agentRunEvents, organisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { logServiceCost } from '../../src/utils/ai-usage';
import { injectAiFooter, FOOTER_VERSION } from '../../src/utils/ai-email-footer';
import { getSession } from '../../src/utils/session';
import { resolveActiveOrg } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';
import { checkImpersonationBlock } from '../../src/utils/impersonation';
import { sendBusinessEmail } from '../../src/utils/business-email';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    // US-ADM-1.2.1: never during an admin impersonation session (src/utils/impersonation.ts).
    const impersonationBlock = checkImpersonationBlock(event, 'outbound_email_send');
    if (impersonationBlock) return impersonationBlock;

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

    // The workspace's own AI-notice wording, which decides whether the assistant is named.
    const [orgRow] = await db.select({ text: organisations.aiDisclosureFooterText, name: organisations.name })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const workspaceText = orgRow?.text ?? null;

    // ── 6. Inject footer (mandatory — no bypass) ───────────────────────────────
    const finalText = injectAiFooter(bodyText, assistant.name, customDisclosureText, false, workspaceText);
    const finalHtml = bodyHtml
        ? injectAiFooter(bodyHtml, assistant.name, customDisclosureText, true, workspaceText)
        : undefined;

    // ── 7. Send email ──────────────────────────────────────────────────────────
    const sentAt = new Date();

    // From the workspace's OWN address only — its verified sending domain, else its connected Gmail/Outlook
    // (business-email.ts; owner 2026-11-27) — never "via Be More Swan". With neither, nothing is sent.
    // Plain text stays plain (review #919): an HTML part only when the assistant wrote one. An empty html makes the
    // Gmail/Outlook send plain text and Resend send the text part.
    const html = finalHtml ?? '';
    let emailId: string | null = null;
    const sent = await sendBusinessEmail(db, orgId, { business: orgRow?.name || assistant.name, to: String(to), subject: String(subject), html, text: finalText }, {
        // One Resend email (the workspace's own domain), caused by this workspace: logged against it (docs/cost-logging-audit.md).
        // A Gmail/Outlook send costs us nothing, so nothing is logged for it.
        onSent: async (provider, id) => {
            emailId = id;
            if (provider === 'resend') await logServiceCost('resend-email', 1, { workspaceId: orgId, userId, assistantId, taskRunId, sessionId: 'outbound-email' });
        },
    });
    if (sent === 'no_route') return { statusCode: 409, body: JSON.stringify({ error: 'Nothing was sent: emails go only from your own address. Verify a sending domain or connect your Gmail or Outlook in Email Studio ▸ Sending.', code: 'NO_SENDING_ADDRESS' }) };
    if (sent === 'failed') return { statusCode: 502, body: JSON.stringify({ error: 'Your email account refused the email. Please try again.' }) };
    // 'slow': it may still go; the audit row below records the attempt (no provider id over a mailbox).

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
    await createNotification(db, 'outbound_email_sent', {
        userId,
        context: { assistant: { name: assistant.name }, email: { to, subject, footer_version: FOOTER_VERSION } },
        metadata: { emailId, assistantId, footerVersion: FOOTER_VERSION, taskRunId },
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, emailId, footerVersion: FOOTER_VERSION }),
    };
});
