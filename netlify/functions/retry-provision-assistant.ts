// retry-provision-assistant.ts — manual re-trigger for a gate-blocked (or failed) assistant.
// POST ?id=<assistantId>
//
// The dashboard "Retry setup" CTA on an Action-Required card calls this after the user has fixed
// the precondition (added disclosure, accepted ToS/DPA, etc.). It resets the assistant back to
// 'pending' and re-fires provision-assistant-background, which re-evaluates every gate from
// scratch — advancing to ready_for_work, or re-blocking with whatever is still missing.
//
// Tenant-guarded (IDOR): the assistant must belong to the caller's active organisation.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { retryBlockedAssistants } from '../../src/utils/retry-provisioning';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const idParam = event.queryStringParameters?.id;
    const assistantId = idParam ? parseInt(idParam, 10) : NaN;
    if (!assistantId || Number.isNaN(assistantId)) return json(400, { error: 'id parameter is required.' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    // IDOR guard + only blocked/failed assistants are retriable.
    const target = await withTenant(orgId, async (tx) => {
        const [a] = await tx.select({ id: aiAssistants.id, provisioningStatus: aiAssistants.provisioningStatus })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        return a || null;
    });

    if (!target) return json(404, { error: 'Assistant not found.' });
    if (target.provisioningStatus !== 'blocked' && target.provisioningStatus !== 'failed') {
        return json(409, { error: 'This assistant is not awaiting a retry.', code: 'NOT_RETRIABLE' });
    }

    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return json(500, { error: 'Server misconfigured.' });

    const count = await retryBlockedAssistants(db, {
        baseUrl,
        assistantId,
        organisationId: orgId,
        statuses: ['blocked', 'failed'],
    });

    return json(202, { ok: true, retried: count });
};
