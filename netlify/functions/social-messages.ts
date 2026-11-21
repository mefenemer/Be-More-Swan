// netlify/functions/social-messages.ts
// The Social Media assistant's Messages tab API (Facebook Page + Instagram messages) — the tab's
// buttons and the chat's message card both call this, so the GUI and chat share one path
// (src/utils/social-messages.ts does the work).
//
//   POST { action: 'list',       assistantId }                     → { conversations[], counts, connection }
//   POST { action: 'draft',      assistantId, id, instruction? }   → { conversation }
//   POST { action: 'save_draft', assistantId, id, draft }          → { conversation }
//   POST { action: 'send',       assistantId, id, text? }          → { conversation }   — sends AS the Page /
//        Instagram account, only inside Meta's 24-hour window (checked server-side, right before the call)
//   POST { action: 'set_status', assistantId, id, status }         → { conversation }   (new | dismissed)
//   POST { action: 'delete',     assistantId, id }                 → { deleted: true }  — owners / admins:
//        removes our copy of the conversation and its messages (an erasure request); Meta keeps theirs

import { and, eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isMissingTable } from '../../src/utils/meta-messaging';
import { deleteConversation, draftReply, listConversations, saveDraft, sendReply, setConversationStatus } from '../../src/utils/social-messages';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    let body: { action?: string; assistantId?: number; id?: number; status?: string; draft?: string; text?: string; instruction?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || 'list');

    // A send acts as the business in public-facing channels: refused while impersonating, like every
    // other write that reaches outside the app.
    const ctx = await requireTenant(event, db, { mutates: action !== 'list' });
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId) || assistantId <= 0) return json(400, { error: 'assistantId required.' });

    // IDOR guard — the assistant must belong to the caller's org. Every query below is also org-scoped.
    const [assistant] = await db.select({ id: aiAssistants.id }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const id = Number(body.id);
    if (['draft', 'save_draft', 'send', 'set_status', 'delete'].includes(action) && (!Number.isInteger(id) || id <= 0)) {
        return json(400, { error: 'id required.' });
    }

    try {
        if (action === 'list') return json(200, { ...(await listConversations(db, orgId, assistantId)), canDelete: ctx.role === 'owner' || ctx.role === 'admin' });
        if (action === 'draft') {
            const r = await draftReply(db, orgId, assistantId, id, typeof body.instruction === 'string' && body.instruction.trim() ? body.instruction : null);
            return r.ok ? json(200, { conversation: r.conversation }) : json(r.status, { error: r.error, code: r.code });
        }
        if (action === 'save_draft') {
            const c = typeof body.draft === 'string' ? await saveDraft(db, orgId, assistantId, id, body.draft) : null;
            return c ? json(200, { conversation: c }) : json(400, { error: 'The reply can’t be empty.' });
        }
        if (action === 'send') {
            const r = await sendReply(db, orgId, assistantId, id, typeof body.text === 'string' ? body.text : null, userId ?? null);
            return r.ok ? json(200, { conversation: r.conversation }) : json(r.status, { error: r.error, code: r.code });
        }
        if (action === 'delete') {
            // Erasing data is a workspace decision: owners and admins, the people who accept the DPA.
            if (ctx.role !== 'owner' && ctx.role !== 'admin') return json(403, { error: 'Only the workspace owner or an admin can delete a conversation.' });
            return (await deleteConversation(db, orgId, assistantId, id))
                ? json(200, { deleted: true })
                : json(404, { error: 'That conversation isn’t on this assistant’s Messages tab.' });
        }
        if (action === 'set_status') {
            const status = body.status === 'new' || body.status === 'dismissed' ? body.status : null;
            if (!status) return json(400, { error: 'status must be new or dismissed.' });
            const c = await setConversationStatus(db, orgId, assistantId, id, status, userId ?? null);
            return c ? json(200, { conversation: c }) : json(404, { error: 'That conversation isn’t on this assistant’s Messages tab.' });
        }
        return json(400, { error: `Unknown action "${action}".` });
    } catch (err) {
        if (isMissingTable(err) || (err as { cause?: { code?: string } })?.cause?.code === '42703') {
            console.error('[social-messages] not set up (missing table or column)', { action, assistantId, err: err instanceof Error ? err.message : err });
            return json(503, { error: 'Messages aren’t set up on this server yet.', code: 'not_set_up' });
        }
        console.error('[social-messages] failed', { action, assistantId, err });
        return json(500, { error: 'Something went wrong — please try again.' });
    }
});
