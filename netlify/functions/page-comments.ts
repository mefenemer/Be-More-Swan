// netlify/functions/page-comments.ts
// The Social Media assistant's Comments tab API — the tab's buttons and the chat's comment card both
// call this, so the GUI and chat share one path (src/utils/page-comments.ts does the work).
//
//   POST { action: 'list',       assistantId }                       → { comments[], counts, hasPageConnection, maxReplyChars }
//   POST { action: 'sync',       assistantId }                       → { result, comments[], counts, hasPageConnection }
//   POST { action: 'draft',      assistantId, id, instruction? }     → { comment }
//   POST { action: 'save_draft', assistantId, id, draft }            → { comment }
//   POST { action: 'post_reply', assistantId, id, text? }            → { comment, warning }   — posts AS the Page;
//        warning set when LinkedIn never confirmed it (the comment stays under Replied so it can't post twice)
//   POST { action: 'set_status', assistantId, id, status }           → { comment }   (new | dismissed; new also
//        un-files a reply LinkedIn never confirmed)

import { and, eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    MAX_REPLY_CHARS, draftReply, isMissingTable, listComments, postReply, saveDraft, setCommentStatus, syncAssistantComments,
} from '../../src/utils/page-comments';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { action?: string; assistantId?: number; id?: number; status?: string; draft?: string; text?: string; instruction?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const action = String(body.action || 'list');
    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId required.' });

    // IDOR guard — the assistant must belong to the caller's org. Every query below is also org-scoped.
    const [assistant] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const id = Number(body.id);
    if (['draft', 'save_draft', 'post_reply', 'set_status'].includes(action) && (!Number.isInteger(id) || id <= 0)) {
        return json(400, { error: 'id required.' });
    }

    try {
        if (action === 'list') {
            return json(200, { ...(await listComments(db, orgId, assistantId)), maxReplyChars: MAX_REPLY_CHARS });
        }
        if (action === 'sync') {
            const r = await syncAssistantComments(db, orgId, assistantId);
            if (!r.ok) return json(r.status, { error: r.error, code: r.code });
            return json(200, { result: r.result, ...(await listComments(db, orgId, assistantId)), maxReplyChars: MAX_REPLY_CHARS });
        }
        if (action === 'draft') {
            const r = await draftReply(db, orgId, assistantId, id, typeof body.instruction === 'string' && body.instruction.trim() ? body.instruction : null);
            return r.ok ? json(200, { comment: r.comment }) : json(r.status, { error: r.error, code: r.code });
        }
        if (action === 'save_draft') {
            const c = typeof body.draft === 'string' ? await saveDraft(db, orgId, assistantId, id, body.draft) : null;
            return c ? json(200, { comment: c }) : json(400, { error: 'The reply can’t be empty.' });
        }
        if (action === 'post_reply') {
            const r = await postReply(db, orgId, assistantId, id, typeof body.text === 'string' ? body.text : null, userId ?? null);
            return r.ok ? json(200, { comment: r.comment, warning: r.warning ?? null }) : json(r.status, { error: r.error, code: r.code });
        }
        if (action === 'set_status') {
            const status = body.status === 'new' || body.status === 'dismissed' ? body.status : null;
            if (!status) return json(400, { error: 'status must be new or dismissed.' });
            const c = await setCommentStatus(db, orgId, assistantId, id, status, userId ?? null);
            return c ? json(200, { comment: c }) : json(404, { error: 'That comment isn’t on this assistant’s Comments tab, or it already has a reply.' });
        }
        return json(400, { error: `Unknown action "${action}".` });
    } catch (err) {
        if (isMissingTable(err)) return json(503, { error: 'Comments aren’t set up on this server yet.', code: 'not_set_up' });
        console.error('[page-comments] failed', { action, assistantId, err });
        return json(500, { error: 'Something went wrong — please try again.' });
    }
});
