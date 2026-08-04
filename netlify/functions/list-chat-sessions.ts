// netlify/functions/list-chat-sessions.ts
// Conversation history index for the Digital Assistant chat.
//
//  GET ?aiAssistantId=<id>&status=active|archived|all&limit=<n>
//   → { sessions: [{ id, aiAssistantId, assistantName, assistantRole, status,
//                    createdAt, updatedAt, lastMessageAt, messageCount, preview }, …] }
//
// Ordered newest-activity first (chat_sessions.updated_at, bumped by the orchestrator on
// every assistant reply). `preview` is the thread's FIRST user turn — it reads as a title,
// the way a mail client shows a subject — truncated server-side so a long transcript never
// ships its whole body into a list payload.
//
// Why this exists: chat_sessions/chat_messages have been written since the orchestrator
// shipped, but get-chat-session.ts requires a chatSessionId the UI had no way to obtain, so
// every chat opened a brand-new thread and the old ones became unreachable. This is the
// missing read side; the callers resume the newest session instead of always creating one.
//
// Ownership: requireTenant, then scoped to org AND the calling user — get-chat-session is
// org-scoped (any member may open a known id), but "my conversations" is deliberately
// narrower: one member's transcripts are not listed to another. Matches the covering index
// chat_sessions_org_user_status_idx (organisation_id, user_id, status). No DDL required.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, chatMessages, chatSessions, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

// Enough to recognise a thread in a list; short enough that 50 rows stay a small payload.
const PREVIEW_MAX_CHARS = 160;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    const q = event.queryStringParameters || {};

    // Optional assistant filter. Present-but-unparseable is a client bug, not "show me
    // everything" — rejecting beats silently widening the result set.
    let aiAssistantId: number | null = null;
    if (q.aiAssistantId !== undefined && q.aiAssistantId !== '') {
        aiAssistantId = Number(q.aiAssistantId);
        if (!Number.isInteger(aiAssistantId) || aiAssistantId <= 0) {
            return json(400, { error: 'aiAssistantId must be a positive integer.' });
        }
    }

    const status = q.status || 'active';
    if (!['active', 'archived', 'all'].includes(status)) {
        return json(400, { error: "status must be 'active', 'archived' or 'all'." });
    }

    const limit = Math.min(
        Math.max(Number.isFinite(Number(q.limit)) ? Number(q.limit) : DEFAULT_LIMIT, 1),
        MAX_LIMIT,
    );

    try {
        const filters = [eq(chatSessions.organisationId, orgId), eq(chatSessions.userId, userId)];
        if (status !== 'all') filters.push(eq(chatSessions.status, status));
        if (aiAssistantId !== null) filters.push(eq(chatSessions.aiAssistantId, aiAssistantId));

        const sessions = await db
            .select({
                id: chatSessions.id,
                aiAssistantId: chatSessions.aiAssistantId,
                status: chatSessions.status,
                createdAt: chatSessions.createdAt,
                updatedAt: chatSessions.updatedAt,
                assistantName: aiAssistants.name,
                // Live role label from master_assistants; ai_assistant_job_role is a hire-time
                // snapshot that goes stale on an admin rename (mirrors get-chat-session.ts).
                assistantRole: sql<string | null>`coalesce(${masterAssistants.name}, ${aiAssistants.aiAssistantJobRole})`,
            })
            .from(chatSessions)
            .innerJoin(aiAssistants, eq(chatSessions.aiAssistantId, aiAssistants.id))
            .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
            .where(and(...filters))
            .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
            .limit(limit);

        if (sessions.length === 0) return json(200, { sessions: [] });

        // Counts + preview for the page of sessions we're actually returning. 'system' rows are
        // audit entries and never visible, so they are excluded from both — a thread whose only
        // rows are system notices must read as empty, exactly as get-chat-session renders it.
        // left() before array_agg bounds the aggregate's memory on very long transcripts.
        const stats = await db
            .select({
                chatSessionId: chatMessages.chatSessionId,
                messageCount: sql<number>`count(*)::int`,
                lastMessageAt: sql<Date | null>`max(${chatMessages.createdAt})`,
                // ::int is explicit rather than inferred — the bind param is the only argument
                // Postgres would have to type from left()'s signature alone.
                preview: sql<string | null>`(
                    array_agg(left(${chatMessages.content}, ${PREVIEW_MAX_CHARS}::int)
                              ORDER BY ${chatMessages.createdAt} ASC, ${chatMessages.id} ASC)
                    FILTER (WHERE ${chatMessages.role} = 'user')
                )[1]`,
            })
            .from(chatMessages)
            .where(and(
                inArray(chatMessages.chatSessionId, sessions.map((s) => s.id)),
                inArray(chatMessages.role, ['user', 'assistant']),
            ))
            .groupBy(chatMessages.chatSessionId);

        const statsBySession = new Map(stats.map((s) => [s.chatSessionId, s]));

        return json(200, {
            sessions: sessions.map((s) => {
                // A session with no rows is real: the orchestrator creates the session before it
                // persists the user's turn, so a failure in between leaves an empty thread.
                const st = statsBySession.get(s.id);
                return {
                    id: s.id,
                    aiAssistantId: s.aiAssistantId,
                    assistantName: s.assistantName,
                    assistantRole: s.assistantRole,
                    status: s.status,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                    lastMessageAt: st?.lastMessageAt ?? null,
                    messageCount: st?.messageCount ?? 0,
                    preview: st?.preview ?? null,
                };
            }),
        });
    } catch (err) {
        console.error(`[list-chat-sessions] org=${orgId} user=${userId}`, err);
        return json(500, { error: 'Failed to load your conversations.' });
    }
});
