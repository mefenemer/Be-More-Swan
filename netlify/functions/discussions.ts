// netlify/functions/discussions.ts
// The Lead Generator's Discussions tab API — the tab's buttons and the chat's discussion card both
// call this, so the GUI and chat share one path (src/utils/discussions.ts does the work).
//
//   POST { action: 'list',        assistantId }                          → { discussions[], counts, watch, sites }
//   POST { action: 'save_watch',  assistantId, topics?, sites?, enabled? } → { watch }
//   POST { action: 'scan_now',    assistantId }                          → { watch } | 4xx { error, code }
//   POST { action: 'set_status',  assistantId, id, status }              → { discussion }   (new | replied | dismissed)
//   POST { action: 'save_draft',  assistantId, id, draft }               → { discussion }
//   POST { action: 'redraft',     assistantId, id, instruction? }        → { discussion }
//
// Nothing here posts to any site. See src/config/discussion-sites.ts.

import { and, eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    listDiscussions, redraftDiscussion, saveDraft, saveWatch, setDiscussionStatus, startScan,
} from '../../src/utils/discussions';
import { DISCUSSION_SITES, DISCUSSION_SITE_KEYS, DISCUSSION_STATUSES, MAX_TOPICS, type DiscussionStatus } from '../../src/config/discussion-sites';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The tab's static vocabulary — sent with `list` so the client holds no second copy. */
const SITES = DISCUSSION_SITE_KEYS.map((k) => ({ key: k, label: DISCUSSION_SITES[k].label, promotionNote: DISCUSSION_SITES[k].promotionNote }));

/** A missing table (db/z-discussions.sql not applied yet) — the tab says "not set up yet". */
function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    return e?.code === '42P01' || e?.cause?.code === '42P01';
}

const SCAN_STATUS: Record<string, number> = {
    no_topics: 422, no_sites: 422, already_running: 409, no_capacity: 402, not_configured: 503, not_started: 502,
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { action?: string; assistantId?: number; id?: number; status?: string; draft?: string; instruction?: string; topics?: unknown; sites?: unknown; enabled?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const action = String(body.action || 'list');
    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId required.' });

    // IDOR guard — the assistant must belong to the caller's org. Every query below is also org-scoped.
    const [assistant] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const id = Number(body.id);
    const needsId = ['set_status', 'save_draft', 'redraft'].includes(action);
    if (needsId && (!Number.isInteger(id) || id <= 0)) return json(400, { error: 'id required.' });

    try {
        if (action === 'list') {
            return json(200, { ...(await listDiscussions(db, orgId, assistantId)), sites: SITES, maxTopics: MAX_TOPICS });
        }
        if (action === 'save_watch') {
            return json(200, { watch: await saveWatch(db, orgId, assistantId, { topics: body.topics, sites: body.sites, enabled: body.enabled }) });
        }
        if (action === 'scan_now') {
            const r = await startScan(db, orgId, assistantId);
            if (!r.ok) return json(SCAN_STATUS[r.code] ?? 400, { error: r.error, code: r.code });
            return json(200, { watch: r.watch });
        }
        if (action === 'set_status') {
            const status = DISCUSSION_STATUSES.find((s) => s === body.status) as DiscussionStatus | undefined;
            if (!status) return json(400, { error: 'status must be new, replied or dismissed.' });
            const d = await setDiscussionStatus(db, orgId, assistantId, id, status, userId);
            return d ? json(200, { discussion: d }) : json(404, { error: 'That thread isn’t in this assistant’s Discussions.' });
        }
        if (action === 'save_draft') {
            const d = typeof body.draft === 'string' ? await saveDraft(db, orgId, assistantId, id, body.draft) : null;
            return d ? json(200, { discussion: d }) : json(400, { error: 'The reply can’t be empty.' });
        }
        if (action === 'redraft') {
            const r = await redraftDiscussion(db, orgId, assistantId, id, typeof body.instruction === 'string' ? body.instruction : null);
            return r.ok ? json(200, { discussion: r.discussion }) : json(502, { error: r.error });
        }
        return json(400, { error: `Unknown action "${action}".` });
    } catch (err) {
        if (isMissingTable(err)) return json(503, { error: 'Discussions isn’t set up on this server yet.', code: 'not_set_up' });
        console.error('[discussions] failed', { action, assistantId, err });
        return json(500, { error: 'Something went wrong — please try again.' });
    }
});
