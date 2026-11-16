// netlify/functions/set-trend-angles.ts
// "Timely angles from search trends" for a Social Media or Email Marketing assistant
// (docs/google-trends-plan.md Phase 3, src/utils/trend-angles.ts): never / occasionally / often.
// The page's control (Assistant Settings ▸ Notifications) and the chat's settings card both call this.
//
// PATCH { assistantId, frequency: 'never' | 'occasionally' | 'often' } → { ok, frequency }
//
// Viewers may not change it. A jsonb merge in SQL, so another configuration key saved at the same
// moment is never lost.

import { withLambda } from '@netlify/aws-lambda-compat';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isTrendAngleFrequency, trendAngleConfigPatch, TREND_ANGLE_ROLES } from '../../src/utils/trend-angles';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'PATCH') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    if (ctx.role === 'viewer') return json(403, { error: 'Viewers can see this setting but not change it.' });

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });
    if (!isTrendAngleFrequency(body.frequency)) return json(400, { error: 'frequency must be never, occasionally or often.' });
    if (ctx.assistantAccess && !ctx.assistantAccess.includes(assistantId)) return json(403, { error: 'You don’t have access to that assistant.' });

    try {
        const [a] = await db.select({ type: sql<string>`${aiAssistants.configuration} ->> 'type'` }).from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, ctx.organisationId))).limit(1);
        if (!a) return json(404, { error: 'Assistant not found.' });
        if (!TREND_ANGLE_ROLES.includes(a.type)) return json(400, { error: 'Only Social Media and Email Marketing assistants have timely angles.' });
        await db.update(aiAssistants)
            .set({ configuration: sql`COALESCE(${aiAssistants.configuration}, '{}'::jsonb) || ${trendAngleConfigPatch(body.frequency)}::jsonb` })
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, ctx.organisationId)));
        return json(200, { ok: true, frequency: body.frequency });
    } catch (err) {
        console.error('[set-trend-angles]', err);
        return json(500, { error: 'Could not save that setting. Try again.' });
    }
});
