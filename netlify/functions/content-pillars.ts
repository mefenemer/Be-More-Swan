// netlify/functions/content-pillars.ts
// A Social Media assistant's content pillars, one record each (src/utils/content-pillars-store.ts,
// db/z-content-pillars.sql). The ONE server path for the profile's pillar list (and, in phase 2, the
// chat's pillar cards). Each change rewrites the derived onboarding_context.content_pillars.
//
// GET  ?assistantId=N                                   → { pillars, maxActive, maxName, maxDescription }
// POST { action: 'add', assistantId, name, description?, isActive? }       → { pillars }
// POST { action: 'update', assistantId, pillarId, name?, description?, isActive? } → { pillars }
// POST { action: 'archive', assistantId, pillarId }                        → { pillars }
// POST { action: 'reorder', assistantId, ids: number[] }                   → { pillars }

import { withLambda } from '@netlify/aws-lambda-compat';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { SMM_ROLE_KEYS } from '../../src/constants/roles';
import {
    addPillar, archivePillar, ensurePillarRecords, reorderPillars, updatePillar,
    MAX_ACTIVE_PILLARS, MAX_PILLAR_DESCRIPTION, MAX_PILLAR_NAME, type Pillar, type PillarResult,
} from '../../src/utils/content-pillars-store';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const LIMITS = { maxActive: MAX_ACTIVE_PILLARS, maxName: MAX_PILLAR_NAME, maxDescription: MAX_PILLAR_DESCRIPTION };

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    let body: Record<string, unknown> = {};
    if (event.httpMethod === 'POST') {
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    }
    const assistantId = Number(event.httpMethod === 'GET' ? event.queryStringParameters?.assistantId : body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });

    const [asst] = await db.select({ onboardingContext: aiAssistants.onboardingContext, roleKey: masterAssistants.roleKey })
        .from(aiAssistants)
        .leftJoin(masterAssistants, eq(masterAssistants.id, aiAssistants.masterAssistantId))
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!asst) return json(404, { error: 'Assistant not found.' });
    if (!SMM_ROLE_KEYS.includes(asst.roleKey ?? '')) return json(400, { error: 'Only a Social Media assistant has content pillars.' });

    if (event.httpMethod === 'GET') {
        const pillars = await ensurePillarRecords(db, orgId, assistantId, asst.onboardingContext);
        // null = the SQL is not applied yet: the page shows the pillars from the old text, read-only.
        return json(200, { pillars, ...LIMITS });
    }

    const pillarId = Number(body.pillarId);
    let r: PillarResult<Pillar[]>;
    switch (body.action) {
        case 'add':
            r = await addPillar(db, orgId, assistantId, { name: body.name, description: body.description, isActive: body.isActive });
            break;
        case 'update':
            if (!Number.isInteger(pillarId) || pillarId <= 0) return json(400, { error: 'pillarId is required.' });
            r = await updatePillar(db, orgId, assistantId, pillarId, { name: body.name, description: body.description, isActive: body.isActive });
            break;
        case 'archive':
            if (!Number.isInteger(pillarId) || pillarId <= 0) return json(400, { error: 'pillarId is required.' });
            r = await archivePillar(db, orgId, assistantId, pillarId);
            break;
        case 'reorder':
            r = await reorderPillars(db, orgId, assistantId, body.ids);
            break;
        default:
            return json(400, { error: 'action must be add, update, archive or reorder.' });
    }
    return r.ok ? json(200, { pillars: r.value, ...LIMITS }) : json(r.status, { error: r.error });
});
