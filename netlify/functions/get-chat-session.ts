// netlify/functions/get-chat-session.ts
// Transcript hydration for the Digital Assistant chat (assistant-chat.html?sessionId=…).
//
//  GET ?chatSessionId=<id>
//   → { session: { id, status, aiAssistantId, assistantName, assistantRole, createdAt, updatedAt },
//       messages: [{ id, role, content, uiElement, createdAt }, …] }   // ordered oldest → newest
//
// Ownership: requireTenant + an org-scoped session lookup, so a session id from another
// tenant 404s exactly like a missing one (no existence oracle). 'system' rows are audit
// entries, never part of the visible transcript — they are filtered out server-side.
// uiElement carries chatMessages.uiElementJson so Disruptive UI cards (Lead Scoring Card,
// Aging Invoices table, …) re-hydrate exactly as first rendered.

import { Handler } from '@netlify/functions';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, chatMessages, chatSessions } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const chatSessionId = Number(event.queryStringParameters?.chatSessionId);
    if (!Number.isInteger(chatSessionId) || chatSessionId <= 0) {
        return json(400, { error: 'chatSessionId is required.' });
    }

    const [session] = await db
        .select({
            id: chatSessions.id,
            status: chatSessions.status,
            aiAssistantId: chatSessions.aiAssistantId,
            createdAt: chatSessions.createdAt,
            updatedAt: chatSessions.updatedAt,
            assistantName: aiAssistants.name,
            assistantRole: aiAssistants.aiAssistantJobRole,
        })
        .from(chatSessions)
        .innerJoin(aiAssistants, eq(chatSessions.aiAssistantId, aiAssistants.id))
        .where(and(eq(chatSessions.id, chatSessionId), eq(chatSessions.organisationId, orgId)))
        .limit(1);
    if (!session) return json(404, { error: 'Chat session not found.' });

    const messages = await db
        .select({
            id: chatMessages.id,
            role: chatMessages.role,
            content: chatMessages.content,
            uiElement: chatMessages.uiElementJson,
            createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(and(
            eq(chatMessages.chatSessionId, session.id),
            inArray(chatMessages.role, ['user', 'assistant']),
        ))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

    return json(200, {
        session: {
            id: session.id,
            status: session.status,
            aiAssistantId: session.aiAssistantId,
            assistantName: session.assistantName,
            assistantRole: session.assistantRole,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        },
        messages,
    });
};
