// netlify/functions/assistant-nudges.ts
// What pops up when you open an assistant's page (owner, 2026-10-27) — src/components/assistant-bubbles.js.
//
//   POST { assistantId, nudges: [{ key, text, tab?, label? }] }
//     → 200 { nudges: [{ key, text, tab?, label?, from: { id, name } }] }
//
// The page sends what it already knows (work waiting for you, being paused). This adds the Business
// Mentor's open suggestions ABOUT this assistant, and posts every nudge to Team Chat as a message
// from the assistant (or the Mentor) to you — at most once a day per message — so a bubble that
// fades after five seconds is never the only place it was said.
//
// ⚠️ Nothing here is written by a model. Every line is a fact the page or the database already holds,
// which keeps it inside src/utils/team-messages.ts's rule for the feed: messages are written from
// state, never composed. Mentor suggestions are quoted by their stored title.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, mentorProposals, teamMessages } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { postTeamMessage } from '../../src/utils/team-messages';
import { withLambda } from '@netlify/aws-lambda-compat';

const MAX_NUDGES = 4;
const MAX_TEXT = 300;
const MENTOR_SUGGESTIONS = 2;
const ONCE_PER_MS = 24 * 60 * 60 * 1000;

type Nudge = { key: string; text: string; tab?: string; label?: string; from: { id: number; name: string } };

const clean = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null;

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId } = ctx;

    let body: any;
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }
    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId)) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };

    const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
        .limit(1);
    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    const nudges: Nudge[] = [];
    for (const n of Array.isArray(body.nudges) ? body.nudges.slice(0, MAX_NUDGES) : []) {
        const key = clean(n?.key, 60);
        const text = clean(n?.text, MAX_TEXT);
        if (!key || !text) continue;
        nudges.push({ key, text, tab: clean(n?.tab, 40) ?? undefined, label: clean(n?.label, 40) ?? undefined, from: { id: assistant.id, name: assistant.name } });
    }

    // The Business Mentor's open suggestions about THIS assistant. Best-effort: the table is a
    // manual apply (db/z-business-mentor.sql) and an environment without it simply has none.
    try {
        const rows = await db.select({ id: mentorProposals.id, title: mentorProposals.title, mentorId: mentorProposals.aiAssistantId })
            .from(mentorProposals)
            .where(and(
                eq(mentorProposals.organisationId, organisationId),
                eq(mentorProposals.targetAssistantId, assistant.id),
                eq(mentorProposals.status, 'shown'),
                or(isNull(mentorProposals.snoozedUntil), lt(mentorProposals.snoozedUntil, new Date())),
            ))
            .orderBy(desc(mentorProposals.shownAt))
            .limit(MENTOR_SUGGESTIONS);
        const mentorIds = [...new Set(rows.map((r) => r.mentorId).filter((x): x is number => typeof x === 'number'))];
        const names = mentorIds.length
            ? new Map((await db.select({ id: aiAssistants.id, name: aiAssistants.name }).from(aiAssistants)
                .where(and(inArray(aiAssistants.id, mentorIds), eq(aiAssistants.organisationId, organisationId))))
                .map((r) => [r.id, r.name]))
            : new Map<number, string>();
        for (const r of rows) {
            if (!r.mentorId || !names.has(r.mentorId)) continue;
            nudges.push({
                key: `mentor:${r.id}`,
                text: `A suggestion for ${assistant.name}: ${r.title}`.slice(0, MAX_TEXT),
                label: 'Talk it through',
                from: { id: r.mentorId, name: names.get(r.mentorId)! },
            });
        }
    } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
        if (code !== '42P01' && code !== '42703') console.error('[assistant-nudges] mentor suggestions unreadable (non-fatal)', err);
    }

    // Team Chat: once a day per sender and wording. Never fails the response.
    const since = new Date(Date.now() - ONCE_PER_MS);
    for (const n of nudges) {
        try {
            const [seen] = await db.select({ id: teamMessages.id }).from(teamMessages).where(and(
                eq(teamMessages.organisationId, organisationId),
                eq(teamMessages.fromAssistantId, n.from.id),
                eq(teamMessages.body, n.text),
                gt(teamMessages.createdAt, since),
            )).limit(1);
            if (seen) continue;
            await postTeamMessage(db, {
                organisationId, fromAssistantId: n.from.id, toUser: true, kind: 'message', body: n.text,
                link: n.from.id === assistant.id
                    ? { assistantId: assistant.id, ...(n.tab ? { tab: n.tab } : {}), label: n.label || `Open ${assistant.name}` }
                    : { assistantId: n.from.id, chat: true, label: n.label || 'Talk it through' },
            });
        } catch (err) {
            console.error('[assistant-nudges] team chat copy failed (non-fatal)', err);
        }
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nudges }) };
});
