// netlify/functions/content-pillars.ts
// A Social Media assistant's content pillars, and a Blog or Email assistant's topics, one record each
// (src/utils/content-pillars-store.ts, db/z-content-pillars.sql, src/utils/pillar-profiles.ts). The ONE
// server path for the settings list and the chat's pillar card. Each change rewrites the role's derived
// onboarding_context key (content_pillars / blogTopics / newsletterTopics).
//
// GET  ?assistantId=N                                   → { pillars, archived, maxActive, maxName, maxDescription, noun, nounPlural }
// GET  ?assistantId=N&usage=1                           → { usage: [{ pillarId, name, isActive, archived, posts }], days }
// POST { action: 'add', assistantId, name, description?, isActive? }       → { pillars }
// POST { action: 'update', assistantId, pillarId, name?, description?, isActive? } → { pillars }
// POST { action: 'archive', assistantId, pillarId }                        → { pillars }
// POST { action: 'reorder', assistantId, ids: number[] }                   → { pillars }
// POST { action: 'restore', assistantId, pillarId }                        → { pillars, switchedOff }
// Every reply also carries `archived`: one row per archived name, for "Bring back".

import { withLambda } from '@netlify/aws-lambda-compat';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { pillarProfileFor, type PillarProfile } from '../../src/utils/pillar-profiles';
import {
    addPillar, archivePillar, ensurePillarRecords, listRestorablePillars, pillarUsage, PILLAR_USAGE_DAYS, reorderPillars, restorePillar, updatePillar,
    MAX_PILLAR_DESCRIPTION, MAX_PILLAR_NAME, type Pillar, type PillarResult,
} from '../../src/utils/content-pillars-store';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The limits and words the settings list shows, from the assistant's role. */
const limitsFor = (p: PillarProfile) => ({
    maxActive: p.maxActive, maxName: MAX_PILLAR_NAME, maxDescription: MAX_PILLAR_DESCRIPTION, noun: p.noun, nounPlural: p.nounPlural,
});

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
    const profile = pillarProfileFor(asst.roleKey);
    if (!profile) return json(400, { error: 'Only a Social Media, Blog Writing or Email Marketing assistant has pillars or topics.' });
    const LIMITS = limitsFor(profile);

    if (event.httpMethod === 'GET' && event.queryStringParameters?.usage === '1') {
        // The Results tab's "Posts by pillar" / "Posts by topic" / "Emails by topic"
        // (src/components/pillar-list.js renderUsage). Never seeds rows.
        const social = profile.contextKey === 'content_pillars';
        const label = social ? 'Posts by pillar' : profile.contextKey === 'blogTopics' ? 'Posts by topic' : 'Emails by topic';
        return json(200, {
            usage: await pillarUsage(db, orgId, assistantId),
            days: social ? PILLAR_USAGE_DAYS : profile.balanceDays,
            label, noun: profile.noun, item: profile.contextKey === 'newsletterTopics' ? 'email' : 'post',
        });
    }
    if (event.httpMethod === 'GET') {
        const pillars = await ensurePillarRecords(db, orgId, assistantId, asst.onboardingContext);
        // null = the SQL is not applied yet: the page shows the pillars from the old text, read-only.
        return json(200, { pillars, archived: await listRestorablePillars(db, orgId, assistantId), ...LIMITS });
    }

    const pillarId = Number(body.pillarId);
    let r: PillarResult<Pillar[]> & { switchedOff?: boolean };
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
        case 'restore':
            if (!Number.isInteger(pillarId) || pillarId <= 0) return json(400, { error: 'pillarId is required.' });
            r = await restorePillar(db, orgId, assistantId, pillarId);
            break;
        default:
            return json(400, { error: 'action must be add, update, archive, reorder or restore.' });
    }
    return r.ok
        ? json(200, { pillars: r.value, archived: await listRestorablePillars(db, orgId, assistantId), switchedOff: r.switchedOff === true, ...LIMITS })
        : json(r.status, { error: r.error });
});
