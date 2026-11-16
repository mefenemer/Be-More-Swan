// netlify/functions/lead-watch.ts
// The Lead Generator's Watch list (buying triggers Phase 2, docs/buying-triggers-plan.md §5). Serves the
// Watch list tab (src/components/assistant-watch-list.js) AND the chat card's button (chat-session.js
// onWatchAction): one endpoint, so the GUI and chat do exactly the same thing.
//
// POST { action, assistantId, … }
//   list                         → the switch, counts, watched companies, last 90 days of news
//   search   { query }           → up to 10 Companies House matches for the "add a company" picker
//   add      { number }          → watch a company by its Companies House number
//   remove   { id }              → stop watching (a hand-added company is removed)
//   resume   { id }              → start watching a lead or customer again
//   set_enabled { enabled }      → the assistant's Watch list switch
//
// Auth: the signed-in user's workspace (requireTenant); the assistant must belong to it (IDOR guard).

import { and, eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isMissingTable } from '../../src/utils/lead-watch';
import { addManualWatch, listWatch, removeWatch, resumeWatch, searchForWatch, setWatchEnabled } from '../../src/utils/lead-watch-list';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const WATCH_ACTIONS = ['list', 'search', 'add', 'remove', 'resume', 'set_enabled'] as const;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { action?: string; assistantId?: number; id?: number; number?: string; query?: string; enabled?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || 'list');
    if (!(WATCH_ACTIONS as readonly string[]).includes(action)) return json(400, { error: 'Unknown action.' });
    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId required.' });

    // IDOR guard, and only a Lead Generator has a Watch list.
    const [assistant] = await db.select({ id: aiAssistants.id, roleKey: masterAssistants.roleKey }).from(aiAssistants)
        .leftJoin(masterAssistants, eq(masterAssistants.id, aiAssistants.masterAssistantId))
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });
    if (assistant.roleKey !== 'lead_qualifier') return json(400, { error: 'Only a Lead Generator has a Watch list.' });

    const id = Number(body.id);
    if ((action === 'remove' || action === 'resume') && (!Number.isInteger(id) || id <= 0)) return json(400, { error: 'id required.' });

    try {
        if (action === 'list') return json(200, await listWatch(db, orgId, assistantId));
        if (action === 'search') {
            const r = await searchForWatch(String(body.query ?? ''));
            return r.ok ? json(200, r) : json(r.status, { error: r.error });
        }
        const r = action === 'add' ? await addManualWatch(db, orgId, assistantId, body.number, userId ?? null)
            : action === 'remove' ? await removeWatch(db, orgId, assistantId, id)
            : action === 'resume' ? await resumeWatch(db, orgId, assistantId, id)
            : await setWatchEnabled(db, orgId, assistantId, body.enabled === true, userId ?? null);
        return r.ok ? json(200, r) : json(r.status, { error: r.error });
    } catch (err) {
        if (isMissingTable(err)) return json(200, { setUp: false });
        console.error('[lead-watch] failed', action, err);
        return json(500, { error: 'Something went wrong. Try again.' });
    }
});
