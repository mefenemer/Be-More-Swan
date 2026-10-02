// netlify/functions/assistant-enabled-platforms.ts
// GET ?assistantId=N → { enabled: SocialPlatform[] | null }
//
// The platforms this assistant is switched ON for (its Connections tab "Use for this assistant"),
// resolved by the SAME rule the drafting side uses — src/utils/assistant-platform-selection.ts, which
// has to read TWO fields and map connection ids to platforms server-side. The new-post picker asks
// this so it only offers what is enabled: Threads and YouTube were switched off for Marvin on prod and
// still appeared there (reported 2026-10-02).
//
// `enabled: null` = no selection has ever been recorded, which the rule reads as DO NOT FILTER — the
// picker then shows every platform, exactly as before, rather than an empty list for a workspace
// whose user simply never opened the Connections tab.

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveAssistantEnabledPlatforms } from '../../src/utils/assistant-platform-selection';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, obj: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
});

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const assistantId = Number(event.queryStringParameters?.assistantId || '');
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId required.' });

    const [assistant] = await db.select({
        onboardingContext: aiAssistants.onboardingContext,
        configuration: aiAssistants.configuration,
    }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, ctx.organisationId)))
        .limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const enabled = await resolveAssistantEnabledPlatforms(db, {
        organisationId: ctx.organisationId,
        onboardingContext: assistant.onboardingContext,
        configuration: assistant.configuration,
    });
    return json(200, { enabled: enabled ? [...enabled] : null });
});
