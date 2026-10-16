// netlify/functions/set-autonomous-media.ts
// Epic 2 US5: toggle a per-assistant autonomous media-suggestions setting + monthly credit cap.
//
// PATCH { assistantId, enabled?, monthlyCap? }   (a stale confirmOverage is accepted and ignored)
//   → { autonomousMediaEnabled, autonomousMediaMonthlyCap }
//   Auth: aura_session cookie; caller must belong to the assistant's organisation.
//
// The cap limits how much AI media this assistant makes on its own each month. It is never a
// licence to overspend: generation stops when the org's allowance runs out (issue #64 asked for an
// overage confirmation, but there is no overage — the plan allowance is a hard stop).

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { normalizeMediaSources } from '../../src/utils/media-sources';
import { withLambda } from '@netlify/aws-lambda-compat';

const MAX_CAP = 100000;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'PATCH') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: { assistantId?: number; enabled?: boolean; monthlyCap?: number; confirmOverage?: boolean; mediaSources?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId)) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId required.' }) };

    // Verify the assistant belongs to the caller's organisation.
    const [assistant] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, ctx.organisationId)))
        .limit(1);
    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.enabled === 'boolean') patch.autonomousMediaEnabled = body.enabled;
    if (body.monthlyCap != null) {
        const cap = Math.floor(Number(body.monthlyCap));
        if (!Number.isFinite(cap) || cap < 0 || cap > MAX_CAP) {
            return { statusCode: 400, body: JSON.stringify({ error: `monthlyCap must be between 0 and ${MAX_CAP}.` }) };
        }
        // No overage confirmation: there is no overage. Generation stops when the org's allowance
        // runs out (a hold needs capacity — ai-credits.ts), so a cap above the plan allowance only
        // means the allowance, not this cap, is what stops it. The old 409 + "extra usage will be
        // charged" dialog promised a bill nothing ever sent, contradicting "never billed".
        // Under the single task allowance the cap counts AI images/videos for this assistant.
        patch.autonomousMediaMonthlyCap = cap;
    }
    // Media Source Selection — store the normalized ordered list (position=priority, member=enabled).
    if (body.mediaSources !== undefined) {
        patch.mediaSources = normalizeMediaSources(body.mediaSources);
    }
    if (Object.keys(patch).length === 1) return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to update.' }) };

    const [updated] = await db.update(aiAssistants).set(patch).where(eq(aiAssistants.id, assistantId))
        .returning({
            enabled: aiAssistants.autonomousMediaEnabled,
            cap: aiAssistants.autonomousMediaMonthlyCap,
            mediaSources: aiAssistants.mediaSources,
        });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            autonomousMediaEnabled: updated.enabled,
            autonomousMediaMonthlyCap: updated.cap,
            mediaSources: normalizeMediaSources(updated.mediaSources),
        }),
    };
});
