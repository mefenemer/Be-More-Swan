// netlify/functions/archive-chat-session.ts
// Archive / restore one chat conversation.
//
//  POST { chatSessionId: number, status: 'archived' | 'active' }
//   → { session: { id, status } }
//
// Both directions, deliberately: `status` has supported 'archived' since the table shipped but
// nothing ever wrote it, and a one-way archive is how you end up with a pile of threads a user
// can hide but never get back. Restore is the same call with status:'active'.
//
// What archiving means, concretely:
//   - list-chat-sessions defaults to status='active', so the thread leaves the history drawer's
//     default view AND stops being the target of auto-resume (assistant-chat-modal.js).
//   - chat-orchestrator.ts already 409s on a non-active session, so an archived thread is
//     read-only until it is restored. That check predates this endpoint — nothing to add there.
// Nothing is deleted. This is "put it away", not "destroy it".
//
// Ownership: requireTenant, then org AND user. Reads are org-scoped (get-chat-session lets any
// member open a known id), but changing the state of a conversation is the author's call only —
// a session belonging to someone else 404s exactly like a missing one.
//
// updated_at is intentionally NOT bumped: it means "last activity in this conversation" and is
// the sort key for the history list. Filing something away is not activity, and a restored
// thread should drop back into its real chronological place.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { chatSessions } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const ALLOWED_STATUS = ['active', 'archived'] as const;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { chatSessionId?: number; status?: string };
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'Invalid JSON body.' });
    }

    const chatSessionId = Number(body.chatSessionId);
    if (!Number.isInteger(chatSessionId) || chatSessionId <= 0) {
        return json(400, { error: 'chatSessionId is required.' });
    }

    const status = body.status as (typeof ALLOWED_STATUS)[number];
    if (!ALLOWED_STATUS.includes(status)) {
        return json(400, { error: "status must be 'archived' or 'active'." });
    }

    try {
        // Scoped UPDATE — the WHERE clause is the authorisation check, so there is no window
        // between reading the row and writing it.
        const [updated] = await db
            .update(chatSessions)
            .set({ status })
            .where(and(
                eq(chatSessions.id, chatSessionId),
                eq(chatSessions.organisationId, orgId),
                eq(chatSessions.userId, userId),
            ))
            .returning({ id: chatSessions.id, status: chatSessions.status });

        if (!updated) return json(404, { error: 'Chat session not found.' });

        return json(200, { session: updated });
    } catch (err) {
        console.error(`[archive-chat-session] org=${orgId} user=${userId} session=${chatSessionId}`, err);
        return json(500, { error: 'Failed to update this conversation.' });
    }
});
