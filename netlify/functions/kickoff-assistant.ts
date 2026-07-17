// kickoff-assistant.ts — US3 (Digital Assistant Lifecycle): the "Confirm & Start Working" action.
// POST ?id=<assistantId>
//
// Moves an assistant ready_for_work → working (or paused → working for the US4 resume-via-kick-off
// path) through the canonical transition helper, enforcing the same required readiness server-side
// that the Kick Off Meeting checklist shows. system_paused is blocked here (US5 routes those through
// a "fix the issue" CTA instead). On success the assistant becomes active (isActive=true), which
// re-enables its background jobs / connectors / webhook receivers.

import { Handler } from '@netlify/functions';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, systemConnections } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { requireTenant } from '../../src/utils/tenant';
import { transitionAssistantStatus, provisioningBlockInfo } from '../../src/utils/assistant-lifecycle';
import { withLambda } from '@netlify/aws-lambda-compat';

const CONN_LABELS: Record<string, string> = { x: 'X (Twitter)', instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const idParam = event.queryStringParameters?.id;
    const assistantId = idParam ? parseInt(idParam, 10) : NaN;
    if (!assistantId || Number.isNaN(assistantId)) return json(400, { error: 'id parameter is required.' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    // IDOR guard + readiness checks under RLS.
    const gate = await withTenant(orgId, async (tx) => {
        const [a] = await tx.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            role: aiAssistants.aiAssistantJobRole,
            lifecycleStatus: aiAssistants.lifecycleStatus,
            provisioningStatus: aiAssistants.provisioningStatus,
            provisioningBlockedReason: aiAssistants.provisioningBlockedReason,
            disclosureText: aiAssistants.disclosureText,
        }).from(aiAssistants)
          .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
          .limit(1);
        if (!a) return null;

        // A *healthy* connection (status='active', not expired/failed/token_refresh_failed) is
        // required — this is what lets a connection-type system_paused recover after reconnect.
        const [conn] = await tx.select({ id: systemConnections.id }).from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, orgId),
                eq(systemConnections.isActive, true),
                eq(systemConnections.status, 'active'),
            ))
            .limit(1);
        // Same active-connection list the Kick Off Meeting summary panel shows (US3 AC3.1) — kept
        // so the notification below carries identical detail rather than a bare "it's working" ping.
        const connRows = await tx.select({ serviceName: systemConnections.serviceName }).from(systemConnections)
            .where(and(eq(systemConnections.organisationId, orgId), eq(systemConnections.isActive, true)));
        const connections = connRows.map(r => r.serviceName).filter(Boolean) as string[];
        return { a, hasConnection: !!conn, connections };
    });

    if (!gate) return json(404, { error: 'Assistant not found.' });
    const { a, hasConnection, connections } = gate;
    const state = a.lifecycleStatus as string;

    // ── State guards ──────────────────────────────────────────────────────────
    if (state === 'working') return json(200, { ok: true, alreadyWorking: true, lifecycleStatus: 'working' });
    if (state === 'provisioning') {
        // A gate blocked provisioning (missing disclosure / ToS / DPA / ack / conformity). Tell the
        // user exactly what to fix instead of the misleading "still being set up" — and once they
        // fix it the auto-retry hooks / retry-provision-assistant re-fire provisioning.
        if (a.provisioningStatus === 'blocked') {
            const info = provisioningBlockInfo(a.provisioningBlockedReason);
            return json(409, { error: info.message, code: 'PROVISIONING_BLOCKED', reason: a.provisioningBlockedReason });
        }
        return json(409, { error: "This assistant is still being set up. Please wait for setup to finish.", code: 'PROVISIONING' });
    }
    if (state === 'archived') {
        return json(409, { error: 'This assistant has been archived and cannot be started.', code: 'ARCHIVED' });
    }
    // US5: a billing/limit system_pause can't be cleared by a kick-off — the user must resolve it
    // in billing first. A connection-type system_pause CAN recover here once a healthy connection
    // exists again (the readiness check below enforces that), so it's allowed to fall through.
    if (state === 'system_paused' && (a.provisioningStatus === 'paused_payment' || a.provisioningStatus === 'paused_limit')) {
        return json(409, { error: 'Resolve the billing issue on this workspace before starting this assistant.', code: 'SYSTEM_PAUSED_BILLING' });
    }

    // ── Required readiness (mirrors get-assistant-readiness required items) ─────
    if (!a.disclosureText?.trim()) {
        return json(422, { error: 'AI disclosure text is required before this assistant can start (EU AI Act Art. 52).', code: 'DISCLOSURE_MISSING' });
    }
    // Connections are no longer required to start: users can draft posts immediately and are
    // asked to connect a platform at the point they approve a post for it (approve-post gates
    // per-platform). The one exception is recovering a connection-type system_pause — that state
    // exists because every connection broke, so restarting without a healthy one would just
    // re-pause immediately.
    if (state === 'system_paused' && !hasConnection) {
        return json(422, { error: 'Reconnect an account before restarting your assistant.', code: 'NO_CONNECTION' });
    }

    // ── Transition (ready_for_work | paused) → working ──────────────────────────
    const result = await transitionAssistantStatus(db, assistantId, 'working', { reason: 'kick_off', actorUserId: userId });
    if (!result.ok) return json(409, { error: result.error, code: 'ILLEGAL_TRANSITION' });

    // Issue #115: the Kick Off Meeting summary (primary directive + active connections) was only
    // ever shown on this page and lost the moment the user navigated away. Send it as a
    // notification with the same detail instead of leaving it stranded in the Notebook.
    const directive = a.role || 'Digital Assistant';
    const connLabels = connections.map(c => CONN_LABELS[c] || (c.charAt(0).toUpperCase() + c.slice(1)));
    const connSentence = connLabels.length ? `Connected accounts: ${connLabels.join(', ')}.` : 'No connected accounts yet.';
    await createNotification(db, 'assistant_kickoff_complete', {
        userId,
        context: { assistant: { name: a.name, directive, connection_sentence: connSentence } },
        metadata: { assistantId, directive, connections },
    });

    return json(200, { ok: true, from: result.from, lifecycleStatus: 'working' });
});
