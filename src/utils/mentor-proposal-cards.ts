// src/utils/mentor-proposal-cards.ts
// Re-check stored Business Mentor cards before a conversation is shown again (chat-card-refresh.ts — the
// ONE chain for every place a stored card reappears). docs/business-mentor-plan.md §2.4: a suggestion is
// one card shown in several places — the Mentor's chat (every owner's and admin's, for a weekly review),
// Inbox "Needs you" and "Review all" — so answering it in one must show it answered in the others.
//
//   - A suggestion card (proposalId) whose mentor_proposals row is no longer 'shown' gets `answered:
//     <status>`; disruptive-ui-registry.js then draws it without its buttons.
//   - An end-of-week check (mentor_commitments "close") whose commitment is no longer open gets `closed`.
//
// Never throws; a missing table leaves the cards as they were.

import { and, eq, inArray } from 'drizzle-orm';
import { mentorCommitments, mentorProposals } from '../../db/schema';

type Db = any;

export async function refreshMentorCards<M extends { uiElement: unknown }>(db: Db, organisationId: number, messages: M[]): Promise<M[]> {
    const ui = (m: M) => (m.uiElement && typeof m.uiElement === 'object' ? m.uiElement as Record<string, unknown> : null);
    const proposalIds = [...new Set(messages.map((m) => Number(ui(m)?.proposalId)).filter((n) => Number.isInteger(n) && n > 0))];
    const commitmentIds = [...new Set(messages.map((m) => {
        const u = ui(m);
        return u?.type === 'mentor_commitments' && u.op === 'close' ? Number(u.commitmentId) : NaN;
    }).filter((n) => Number.isInteger(n) && n > 0))];
    if (!proposalIds.length && !commitmentIds.length) return messages;

    const proposals = new Map<number, string>();
    const commitments = new Map<number, string>();
    try {
        if (proposalIds.length) {
            const rows = await db.select({ id: mentorProposals.id, status: mentorProposals.status }).from(mentorProposals)
                .where(and(eq(mentorProposals.organisationId, organisationId), inArray(mentorProposals.id, proposalIds)));
            for (const r of rows) proposals.set(r.id, r.status);
        }
    } catch (err) {
        console.warn('[mentor-proposal-cards] proposals unreadable (non-fatal):', (err as Error)?.message);
    }
    try {
        if (commitmentIds.length) {
            const rows = await db.select({ id: mentorCommitments.id, status: mentorCommitments.status }).from(mentorCommitments)
                .where(and(eq(mentorCommitments.organisationId, organisationId), inArray(mentorCommitments.id, commitmentIds)));
            for (const r of rows) commitments.set(r.id, r.status);
        }
    } catch (err) {
        console.warn('[mentor-proposal-cards] commitments unreadable (non-fatal):', (err as Error)?.message);
    }

    return messages.map((m) => {
        const u = ui(m);
        if (!u) return m;
        const p = proposals.get(Number(u.proposalId));
        if (p && p !== 'shown') return { ...m, uiElement: { ...u, answered: p } };
        if (u.type === 'mentor_commitments' && u.op === 'close') {
            const c = commitments.get(Number(u.commitmentId));
            if (c && c !== 'open') return { ...m, uiElement: { ...u, closed: c } };
        }
        return m;
    });
}
