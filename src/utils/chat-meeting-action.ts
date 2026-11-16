// src/utils/chat-meeting-action.ts
// The Meeting Note Taker chat's hands on meetings that ALREADY exist (docs/meeting-note-taker-finish-plan.md
// step 6, the chat half of the GUI-and-chat rule): approve one, add a missing attendee's email, change
// the follow-up email, or reject one with a note. The meeting twin of chat-lead-action.ts.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Each turn the chat sees YOUR MEETINGS RIGHT NOW (buildMeetingsSnapshot): this assistant's recent
// meetings by "#id", which ones wait for approval, and who has no email. The model never acts: it
// proposes a `meeting_action_proposal` naming a meeting by its "#id". This module checks it against
// assistant_records (this organisation's, this assistant's, a meeting, still waiting) and rebuilds the
// card from the row. The click is the Inbox's own PATCH on assistant-records (approve, reject with
// `feedback`, or `dataMerge` of attendees / followupEmail — the same keys the Inbox editor writes), so
// approving from chat fires exactly the hand-offs approving in the Inbox does, and only then.
//
// `dataHash` fingerprints the attendees and follow-up the card was built from. A stored card whose
// meeting has changed since (edited in the Inbox, approved, rejected) is settled when the
// conversation is reopened (refreshMeetingActionCards) rather than writing over the newer words.
//
// ⚠️ Never throws.

import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { assistantRecords } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const MEETING_ACTION_PROPOSAL_TYPE = 'meeting_action_proposal';
export const MEETING_ACTIONS = ['approve', 'add_email', 'edit_followup', 'reject'] as const;
export type MeetingAction = typeof MEETING_ACTIONS[number];

/** How many meetings the snapshot lists, and how many waiting ones show their follow-up in full. */
export const MEETINGS_SNAPSHOT_MAX = 12;
const FOLLOWUP_SHOWN_MAX = 5;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneLine = (v: unknown, max: number) => str(v, max * 2).replace(/\s+/g, ' ').slice(0, max);

type Attendee = { name: string; email: string | null };
type Followup = { subject: string; body: string } | null;

function asData(data: unknown): Record<string, unknown> {
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

/** Attendees as the Inbox stores them (attendees[i].email), with a usable address or null. */
export function meetingAttendees(data: unknown): Attendee[] {
    const d = asData(data);
    return (Array.isArray(d.attendees) ? d.attendees : []).flatMap((a) => {
        if (!a || typeof a !== 'object') return [];
        const r = a as Record<string, unknown>;
        const email = str(r.email, 254);
        return [{ name: str(r.name, 120), email: EMAIL.test(email) ? email : null }];
    });
}

function meetingFollowup(data: unknown): Followup {
    const fe = asData(asData(data).followupEmail);
    const subject = str(fe.subject, 300);
    const body = str(fe.body, 10000);
    return subject || body ? { subject, body } : null;
}

/** What a card was built from: the attendees and the follow-up, as stored. */
export function meetingDataHash(data: unknown): string {
    const d = asData(data);
    return createHash('sha256').update(JSON.stringify([d.attendees ?? null, d.followupEmail ?? null])).digest('hex').slice(0, 16);
}

const STATE_WORDS: Record<string, string> = {
    pending_approval: 'waiting for approval',
    approved: 'approved',
    scheduled: 'approved',
    rejected: 'rejected',
};

/** The meetings block for the chat prompt. Null on failure (the prompt then says it cannot see them). */
export async function buildMeetingsSnapshot(db: Db, organisationId: number, aiAssistantId: number): Promise<string | null> {
    try {
        const where = and(
            eq(assistantRecords.organisationId, organisationId),
            eq(assistantRecords.aiAssistantId, aiAssistantId),
            eq(assistantRecords.recordType, 'meeting'),
        );
        const [counts] = await db.select({
            total: sql<number>`count(*)::int`,
            waiting: sql<number>`count(*) FILTER (WHERE ${assistantRecords.approvalStatus} = 'pending_approval')::int`,
        }).from(assistantRecords).where(where);
        const rows = await db.select({
            id: assistantRecords.id, title: assistantRecords.title, approvalStatus: assistantRecords.approvalStatus,
            data: assistantRecords.data, updatedAt: assistantRecords.updatedAt,
        }).from(assistantRecords).where(where).orderBy(desc(assistantRecords.updatedAt)).limit(MEETINGS_SNAPSHOT_MAX);
        return formatMeetingsSnapshot(counts?.total ?? 0, counts?.waiting ?? 0, rows);
    } catch (err) {
        console.error('[chat-meeting-action] meetings snapshot failed (non-fatal)', err);
        return null;
    }
}

/** Pure: the snapshot text from the rows. */
export function formatMeetingsSnapshot(
    total: number, waiting: number,
    rows: { id: number; title: string; approvalStatus: string; data: unknown; updatedAt: Date | string | null }[],
): string {
    if (!total) return 'YOUR MEETINGS RIGHT NOW: none yet. Nothing is waiting for approval.';
    let shown = 0;
    const lines = rows.map((r) => {
        const d = asData(r.data);
        const tasks = Array.isArray(d.tasks) ? d.tasks.length : 0;
        const missing = meetingAttendees(d).filter((a) => !a.email).map((a) => a.name || 'an unnamed attendee');
        const day = r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 10) : '';
        const parts = [
            `#${r.id} "${oneLine(r.title, 120)}" — ${STATE_WORDS[r.approvalStatus] ?? r.approvalStatus}`,
            day,
            `${tasks} action item${tasks === 1 ? '' : 's'}`,
            missing.length ? `no email for: ${missing.slice(0, 8).join(', ')}` : '',
        ].filter(Boolean);
        let line = parts.join(' · ');
        const fe = meetingFollowup(d);
        if (r.approvalStatus === 'pending_approval' && fe && shown < FOLLOWUP_SHOWN_MAX) {
            shown++;
            line += `\n    follow-up email — subject: "${oneLine(fe.subject, 200)}"; body: "${oneLine(fe.body, 1500)}"`;
        }
        return line;
    });
    return `YOUR MEETINGS RIGHT NOW (newest first; ${total} in all, ${waiting} waiting for approval${total > rows.length ? `; showing the latest ${rows.length}` : ''}):\n${lines.join('\n')}`;
}

/** The chat-only instructions for acting on the meetings above. */
export function meetingActionsPromptBlock(snapshot: string | null): string {
    return `${snapshot ?? 'YOUR MEETINGS RIGHT NOW — your meetings could not be read this turn. Do not guess which meetings exist or what state they are in: say you cannot see them right now and point the user to the Inbox tab. Do not propose a meeting action this turn.'}

EXISTING MEETINGS — you can act on a meeting listed above, named by its "#" number, in four ways, by setting uiElement to a meeting_action_proposal INSTEAD of the minutes card:
- "approve": approve a meeting that is waiting. Approving sends it to the connections switched on for this assistant (the follow-up email to attendees, a Slack summary, a Notion page, tickets in the task tracker). If attendees have no email, say who before offering it: they will not get the follow-up unless an address is added first.
- "add_email": add one attendee's email address — "attendeeName" (as listed) and "email" (exactly as the user gave it; never guess or complete an address).
- "edit_followup": replace the follow-up email — "subject" and "body", the whole new email, written to what the user asked for, starting from the current one listed above.
- "reject": turn a meeting down — "note" is what the user said was wrong, in their words (optional). The note is kept as a rule for future minutes.
Only meetings waiting for approval can be changed. You never do it yourself: the user confirms on the card, and only that click changes anything. So never say a meeting HAS been approved, rejected or changed — say the card is there to confirm. One meeting and one action per reply; to add two emails, do one, then the next. If you cannot tell which meeting they mean, ask, quoting the candidates. To change the summary, decisions or action items, tell them to open the meeting in the Inbox tab, or paste the corrected notes so you write it up again.
{ "type": "meeting_action_proposal", "action": "approve" | "add_email" | "edit_followup" | "reject", "recordId": 123, "attendeeName": "<add_email>", "email": "<add_email>", "subject": "<edit_followup>", "body": "<edit_followup>", "note": "<reject, optional>" }`;
}

export interface MeetingActionRequest {
    action: MeetingAction;
    recordId: number;
    attendeeName: string | null;
    email: string | null;
    subject: string | null;
    body: string | null;
    note: string | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function meetingActionFromUiElement(uiElement: unknown): MeetingActionRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== MEETING_ACTION_PROPOSAL_TYPE) return null;
    const action = MEETING_ACTIONS.find((a) => a === ui.action);
    const recordId = Number(String(ui.recordId ?? '').replace(/^#/, ''));
    if (!action || !Number.isInteger(recordId) || recordId <= 0) return null;
    return {
        action, recordId,
        attendeeName: str(ui.attendeeName, 120) || null,
        email: str(ui.email, 254) || null,
        subject: str(ui.subject, 300) || null,
        body: str(ui.body, 10000) || null,
        note: oneLine(ui.note, 500) || null,
    };
}

export interface MeetingActionCard {
    type: typeof MEETING_ACTION_PROPOSAL_TYPE;
    action: MeetingAction;
    recordId: number;
    assistantId: number;
    title: string;
    approvalStatus: string;
    /** Why the button is not offered. Null = it is. */
    blocked: string | null;
    settled?: boolean;
    dataHash: string;
    /** approve: who gets the follow-up, who does not, how many tasks. */
    to?: string[];
    missing?: string[];
    tasks?: number;
    /** add_email: the attendee, and the full attendees list the click writes back. */
    attendeeName?: string;
    email?: string;
    attendees?: Attendee[];
    /** edit_followup: the follow-up as it stands, and as it will be. */
    before?: Followup;
    followupEmail?: { subject: string; body: string };
    /** reject: what was wrong. */
    note?: string | null;
}

type MeetingRow = { id: number; title: string; approvalStatus: string; data: unknown };

async function loadMeeting(db: Db, organisationId: number, aiAssistantId: number, id: number): Promise<MeetingRow | null> {
    const [row] = await db.select({
        id: assistantRecords.id, title: assistantRecords.title, approvalStatus: assistantRecords.approvalStatus, data: assistantRecords.data,
    }).from(assistantRecords).where(and(
        eq(assistantRecords.id, id),
        eq(assistantRecords.organisationId, organisationId),
        eq(assistantRecords.aiAssistantId, aiAssistantId),
        eq(assistantRecords.recordType, 'meeting'),
    )).limit(1);
    return row ?? null;
}

function stateBlock(approvalStatus: string): string | null {
    if (approvalStatus === 'pending_approval') return null;
    return approvalStatus === 'rejected'
        ? 'This meeting was rejected, so it can’t be changed from here.'
        : 'This meeting is already approved and has gone to your connections, so it can’t be changed from here.';
}

/** Which attendee "name" means: exact, then the only one whose name starts with or contains it. */
export function findAttendee(attendees: Attendee[], name: string | null): { index: number } | { error: string } {
    const missing = attendees.map((a, i) => ({ a, i })).filter((x) => !x.a.email);
    if (!name) {
        if (missing.length === 1) return { index: missing[0].i };
        return { error: missing.length ? `Which attendee is this address for? ${missing.map((x) => x.a.name || 'unnamed').join(', ')} have none.` : 'Every attendee already has an email address.' };
    }
    const n = name.toLowerCase();
    const tiers = [
        attendees.map((a, i) => ({ a, i })).filter((x) => x.a.name.toLowerCase() === n),
        attendees.map((a, i) => ({ a, i })).filter((x) => x.a.name.toLowerCase().startsWith(n)),
        attendees.map((a, i) => ({ a, i })).filter((x) => x.a.name.toLowerCase().includes(n)),
    ];
    for (const hits of tiers) {
        if (hits.length === 1) return { index: hits[0].i };
        if (hits.length > 1) return { error: `More than one attendee matches "${name}": ${hits.map((x) => x.a.name).join(', ')}. Which one?` };
    }
    return { error: attendees.length ? `No attendee called "${name}" on this meeting. The attendees are ${attendees.map((a) => a.name || 'unnamed').join(', ')}.` : 'This meeting lists no attendees. Add the address in the Inbox tab instead.' };
}

/**
 * Check a proposal against the database and return the card the user confirms — built only from the
 * row. Null when the meeting is not this assistant's.
 */
export async function resolveMeetingActionProposal(
    db: Db, organisationId: number, aiAssistantId: number, req: MeetingActionRequest,
): Promise<MeetingActionCard | null> {
    try {
        const rec = await loadMeeting(db, organisationId, aiAssistantId, req.recordId);
        if (!rec) return null;
        return buildMeetingActionCard(rec, aiAssistantId, req);
    } catch (err) {
        console.error('[chat-meeting-action] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

/** Pure: the card for a request against a stored meeting. */
export function buildMeetingActionCard(rec: MeetingRow, aiAssistantId: number, req: MeetingActionRequest): MeetingActionCard {
    const attendees = meetingAttendees(rec.data);
    const card: MeetingActionCard = {
        type: MEETING_ACTION_PROPOSAL_TYPE,
        action: req.action,
        recordId: rec.id,
        assistantId: aiAssistantId,
        title: oneLine(rec.title, 200),
        approvalStatus: rec.approvalStatus,
        blocked: stateBlock(rec.approvalStatus),
        dataHash: meetingDataHash(rec.data),
    };
    if (req.action === 'approve') {
        const d = asData(rec.data);
        card.to = attendees.filter((a) => a.email).map((a) => a.email as string);
        card.missing = attendees.filter((a) => !a.email).map((a) => a.name || 'an unnamed attendee');
        card.tasks = Array.isArray(d.tasks) ? d.tasks.length : 0;
    }
    if (req.action === 'add_email') {
        const email = req.email ?? '';
        const found = findAttendee(attendees, req.attendeeName);
        if ('error' in found) {
            card.attendeeName = req.attendeeName ?? '';
            card.email = email;
            card.blocked ??= found.error;
        } else {
            card.attendeeName = attendees[found.index].name;
            card.email = email;
            if (!EMAIL.test(email)) card.blocked ??= `“${email || 'That'}” isn’t a full email address. What is ${card.attendeeName || 'their'} address?`;
            else if (attendees[found.index].email?.toLowerCase() === email.toLowerCase()) card.blocked ??= `${card.attendeeName || 'They'} already ${card.attendeeName ? 'has' : 'have'} that address.`;
            // The whole list, as the Inbox editor writes it: every other attendee kept as stored.
            const stored = (Array.isArray(asData(rec.data).attendees) ? asData(rec.data).attendees as unknown[] : []);
            card.attendees = stored.map((a, i) => {
                const r = (a && typeof a === 'object') ? a as Record<string, unknown> : {};
                return i === found.index ? { ...r, name: str(r.name, 120), email } as Attendee : r as unknown as Attendee;
            });
        }
    }
    if (req.action === 'edit_followup') {
        card.before = meetingFollowup(rec.data);
        const subject = req.subject ?? card.before?.subject ?? '';
        const body = req.body ?? '';
        card.followupEmail = { subject, body };
        if (!body) card.blocked ??= 'Say what the new follow-up email should say, and I’ll write it out for you to check.';
        else if (card.before && card.before.subject === subject && card.before.body === body) card.blocked ??= 'That is the follow-up email as it already stands.';
    }
    if (req.action === 'reject') card.note = req.note;
    return card;
}

/**
 * Re-check every stored meeting_action_proposal in a transcript, so a card acted on — here, in the Inbox,
 * or overtaken by an edit there — says so instead of offering a button that would act twice or write
 * over newer words. Mutates nothing it is given.
 */
export async function refreshMeetingActionCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== MEETING_ACTION_PROPOSAL_TYPE || ui.settled || ui.blocked) return m;
        try {
            const rec = await loadMeeting(db, organisationId, aiAssistantId, Number(ui.recordId));
            const why = settledReason(ui, rec);
            return why ? { ...m, uiElement: { ...ui, approvalStatus: rec?.approvalStatus ?? ui.approvalStatus, settled: true, blocked: why } } : m;
        } catch (err) {
            console.error('[chat-meeting-action] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}

/** Pure: why a stored card can no longer be acted on, or null when it still can. */
export function settledReason(ui: Record<string, unknown>, rec: MeetingRow | null): string | null {
    if (!rec) return 'This meeting no longer exists.';
    if (rec.approvalStatus !== 'pending_approval') {
        return rec.approvalStatus === 'rejected' ? 'Already dealt with — this meeting was rejected.' : 'Already dealt with — this meeting was approved.';
    }
    if (ui.action === 'add_email' && typeof ui.email === 'string'
        && meetingAttendees(rec.data).some((a) => a.email?.toLowerCase() === String(ui.email).toLowerCase())) {
        return `Done — ${ui.attendeeName ? `${String(ui.attendeeName)}’s` : 'the'} address is saved on this meeting.`;
    }
    const fe = ui.followupEmail as { subject?: unknown; body?: unknown } | undefined;
    const now = meetingFollowup(rec.data);
    if (ui.action === 'edit_followup' && fe && now && now.subject === fe.subject && now.body === fe.body) {
        return 'Done — the follow-up email is saved as shown.';
    }
    if ((ui.action === 'add_email' || ui.action === 'edit_followup') && ui.dataHash !== meetingDataHash(rec.data)) {
        return 'This meeting has changed since this card was made, so it isn’t offered again. Ask me again if it still needs doing.';
    }
    return null;
}
