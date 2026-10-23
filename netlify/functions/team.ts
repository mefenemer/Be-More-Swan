// netlify/functions/team.ts
// The Team feed — docs/campaign-orchestrator-flow.md §4. One endpoint, tenant-scoped.
//
//   POST { action: 'list', campaignId?, assistantId?, mine?, openQuestions?, beforeId? } → messages (newest first), assistants, campaigns
//        openQuestions: only questions to the person still unanswered (Notifications → Needs you)
//   POST { action: 'unread' }                                     → { unread, questions } (the badge itself comes from notifications?action=count)
//   POST { action: 'mark_read', upToId }                          → the person has seen up to here
//   POST { action: 'send', assistantId, campaignId?, body }       → a note to an assistant (moderated)
//        + reply: 'model' → no fixed reply; the page then runs a chat turn for it (chat-orchestrator `teamMessageId`)
//   POST { action: 'answer', messageId, value }                   → answer an assistant's question; runs its handler
//
// Every write goes through src/utils/team-messages.ts. Assistant messages are never composed here:
// they are written where the work changes state, so the feed cannot claim work that is not happening.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, campaigns, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { refreshStoredCards } from '../../src/utils/chat-card-refresh';
import { answerQuestion, listTeamMessages, markRead, openQuestionCount, sendFromUser, unreadCount } from '../../src/utils/team-messages';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function posInt(v: unknown): number | undefined {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    if (action === 'unread') {
        return json(200, { unread: await unreadCount(db, orgId, userId), questions: await openQuestionCount(db, orgId) });
    }

    if (action === 'list') {
        const messages = await listTeamMessages(db, orgId, {
            campaignId: posInt(body.campaignId), assistantId: posInt(body.assistantId), mine: body.mine === true, openQuestions: body.openQuestions === true, beforeId: posInt(body.beforeId),
        });
        // Everyone who can be written to, and every campaign a thread can be about — so the page can
        // show an assistant with no messages yet, and name a campaign thread by its objective.
        const assistants = await db.select({
            id: aiAssistants.id, name: aiAssistants.name, roleKey: sql<string | null>`${aiAssistants.configuration} ->> 'type'`,
            // The assistant's chosen avatar (assistant-colors.js), so each message carries its face.
            avatarColor: sql<string | null>`${aiAssistants.configuration} ->> 'avatarColor'`,
            avatarLetter: sql<string | null>`${aiAssistants.configuration} ->> 'avatarLetter'`,
        }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)).orderBy(aiAssistants.id);
        const campaignIds = [...new Set(messages.map((m) => m.campaignId).filter((x): x is number => !!x))];
        const live = await db.select({ id: campaigns.id, objective: campaigns.objective, status: campaigns.status })
            .from(campaigns)
            .where(and(eq(campaigns.organisationId, orgId), sql`${campaigns.status} <> 'archived'`))
            .orderBy(desc(campaigns.createdAt)).limit(50);
        const extra = campaignIds.filter((id) => !live.some((c) => c.id === id));
        const older = extra.length
            ? await db.select({ id: campaigns.id, objective: campaigns.objective, status: campaigns.status })
                .from(campaigns).where(and(eq(campaigns.organisationId, orgId), inArray(campaigns.id, extra)))
            : [];
        // A model reply's card (team-messages.ts postTeamChatReply) is re-checked against its row, the
        // same chain a reopened chat runs (src/utils/chat-card-refresh.ts), so one already confirmed
        // here or in the chat says so rather than offering its button again.
        const withCards = messages.filter((m) => m.card && m.from.kind === 'assistant' && m.from.id);
        if (withCards.length) {
            const ids = [...new Set(withCards.map((m) => m.from.id as number))];
            const roles = await db.select({ id: aiAssistants.id, roleKey: masterAssistants.roleKey }).from(aiAssistants)
                .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
                .where(and(eq(aiAssistants.organisationId, orgId), inArray(aiAssistants.id, ids)));
            for (const id of ids) {
                const mine = withCards.filter((m) => m.from.id === id);
                const fresh = await refreshStoredCards(db, orgId, id, roles.find((r) => r.id === id)?.roleKey ?? null, mine.map((m) => ({ uiElement: m.card })));
                mine.forEach((m, i) => { m.card = fresh[i].uiElement; });
            }
        }
        return json(200, {
            messages,
            assistants,
            campaigns: [...live, ...older],
            unread: await unreadCount(db, orgId, userId),
        });
    }

    if (action === 'mark_read') {
        const upTo = posInt(body.upToId);
        if (!upTo) return json(400, { error: 'upToId is required.' });
        await markRead(db, orgId, userId, upTo);
        return json(200, { ok: true, unread: await unreadCount(db, orgId, userId) });
    }

    if (action === 'send') {
        const assistantId = posInt(body.assistantId);
        if (!assistantId) return json(400, { error: 'Choose who this is for.' });
        const text = typeof body.body === 'string' ? body.body : '';
        // A note to an assistant on a campaign reaches its drafting prompt, so it is moderated like
        // any other text that reaches a model.
        const blocked = await enforcePromptModeration({ text, userId, organisationId: orgId, source: 'team' });
        if (blocked) return blocked;
        const r = await sendFromUser(db, { orgId, userId, assistantId, campaignId: posInt(body.campaignId) ?? null, body: text, reply: body.reply === 'model' ? 'model' : 'fixed' });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, { ok: true, id: r.id });
    }

    if (action === 'answer') {
        const messageId = posInt(body.messageId);
        if (!messageId || typeof body.value !== 'string') return json(400, { error: 'messageId and value are required.' });
        const r = await answerQuestion(db, { orgId, userId, messageId, value: body.value });
        if (!r.ok) return json(r.status, { error: r.error });
        return json(200, { ok: true, said: r.said });
    }

    return json(400, { error: 'Unknown action.' });
});
