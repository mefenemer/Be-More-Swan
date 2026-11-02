// netlify/functions/redraft-upcoming-posts.ts
// "Redraft upcoming posts" — after a change to what a Social Media assistant posts about (src/utils/
// redraft-upcoming.ts). The ONE server path for both surfaces: the offer after saving the profile or a
// set-up answer card (src/components/redraft-upcoming.js), and the Social Media chat's redraft_upcoming
// card. Chat proposes; only the user's click on "Redraft" spends.
//
// POST { action: 'preview', assistantId } → { slots, tasks, first, last, tasksLeft, kept }
// POST { action: 'apply', assistantId }   → { cancelled, queued }   (1 task per slot, charged as each lands)

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { applyRedraft, previewRedraft } from '../../src/utils/redraft-upcoming';
import { triggerContentDrain } from '../../src/utils/trigger-drain';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId is required.' });

    if (body.action === 'preview') {
        const r = await previewRedraft(db, ctx.organisationId, assistantId);
        return r.ok ? json(200, r) : json(r.status, { error: r.error });
    }
    if (body.action === 'apply') {
        const r = await applyRedraft(db, ctx.organisationId, assistantId);
        if (!r.ok) return json(r.status, { error: r.error });
        // The owner is waiting to see the new drafts; without this they sit until the next cron tick.
        if (r.queued) await triggerContentDrain(event.headers as Record<string, string | undefined>, `redraft-${assistantId}`, 'redraft-upcoming-posts');
        return json(200, r);
    }
    return json(400, { error: 'action must be preview or apply.' });
});
