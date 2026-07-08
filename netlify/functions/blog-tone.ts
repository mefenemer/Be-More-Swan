// netlify/functions/blog-tone.ts
// Autonomous Content Engine — blog voice sourcing.
//
// A blog's tone comes from the chosen assistant's profile
// (aiAssistants.onboardingContext.tone_of_voice — the same field social-auto-responder reads).
// If that assistant hasn't got a tone yet, the author supplies one and may save it back to
// the profile so it's sourced automatically next time. Org-scoped via requireTenant.
//
// GET                         → { assistants: [{ id, name, tone }] } (active, org-scoped)
// POST { assistantId, tone }  → persist tone into the assistant's profile → { tone }

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

function toneOf(onboardingContext: unknown): string {
    const ctx = (onboardingContext as Record<string, unknown> | null) ?? {};
    return typeof ctx.tone_of_voice === 'string' ? ctx.tone_of_voice : '';
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    // ---- List active assistants + their profile voice ----
    if (event.httpMethod === 'GET') {
        const rows = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.organisationId, ctx.organisationId), eq(aiAssistants.isActive, true)));
        const assistants = rows.map((r) => ({ id: r.id, name: r.name, tone: toneOf(r.onboardingContext) }));
        return { statusCode: 200, body: JSON.stringify({ assistants }) };
    }

    // ---- Save an author-supplied tone back to the assistant's profile ----
    if (event.httpMethod === 'POST') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); }
        catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

        const assistantId = Number(body.assistantId);
        const tone = typeof body.tone === 'string' ? body.tone.trim().slice(0, 200) : '';
        if (!Number.isFinite(assistantId)) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
        if (!tone) return { statusCode: 400, body: JSON.stringify({ error: 'tone is required.' }) };

        const [assistant] = await db
            .select({ id: aiAssistants.id, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, ctx.organisationId)))
            .limit(1);
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

        const nextCtx = { ...((assistant.onboardingContext as Record<string, unknown> | null) ?? {}), tone_of_voice: tone };
        await db.update(aiAssistants)
            .set({ onboardingContext: nextCtx, updatedAt: new Date() })
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, ctx.organisationId)));
        return { statusCode: 200, body: JSON.stringify({ tone }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
});
