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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { actionItems, activeScenarios, assistantRecords, integrationScenarios } from '../../db/schema';
import { isMeetingSendTarget, loadMeetingSendTargets, MEETING_SEND_TARGETS, MEETING_TASK_TARGETS, meetingSendState, meetingTaskCount, type MeetingSendTarget } from './meeting-send-to';
import { followupBlockedByNoMailbox } from './mailbox-connected';
import { TASK_TOOL_RECIPES } from '../config/recipe-settings';

type Db = ReturnType<typeof getDb>;

export const MEETING_ACTION_PROPOSAL_TYPE = 'meeting_action_proposal';
// 'send_to' (Fix pipeline #73): send an APPROVED meeting to one switched-on tool now (src/utils/meeting-send-to.ts).
export const MEETING_ACTIONS = ['approve', 'add_email', 'edit_followup', 'reject', 'send_to'] as const;
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
        const targets = await loadMeetingSendTargets(db, organisationId, aiAssistantId);
        const sync = await taskSyncByMeeting(db, organisationId, rows.map((r) => r.id));
        const text = formatMeetingsSnapshot(counts?.total ?? 0, counts?.waiting ?? 0, rows, { targets, sync });
        return (await followupBlockedByNoMailbox(db, organisationId, aiAssistantId)) ? `${text}\n${NO_MAILBOX_SNAPSHOT_LINE}` : text;
    } catch (err) {
        console.error('[chat-meeting-action] meetings snapshot failed (non-fatal)', err);
        return null;
    }
}

/** Said to the model when the follow-up action is on but no Gmail or Outlook is connected. */
export const NO_MAILBOX_SNAPSHOT_LINE = 'FOLLOW-UP EMAILS ARE NOT SENDING: the follow-up action is switched on, but no Gmail or Outlook is connected. Follow-ups only ever go from the user’s own inbox — never from Be More Swan’s address — so approving a meeting now will NOT email the attendees. Say so whenever approval or the follow-up comes up, and tell them to connect Gmail or Outlook on the Connections tab first. A meeting already approved without one shows "Send the follow-up now" in the Inbox once it is connected.';

/** Which task tool this assistant has switched on ('Jira' / 'Asana'), or null. Undefined on a read failure (the card keeps its old wording). */
export async function taskToolOn(db: Db, organisationId: number, aiAssistantId: number): Promise<string | null | undefined> {
    try {
        const [row] = await db.select({ key: integrationScenarios.scenarioKey })
            .from(activeScenarios)
            .innerJoin(integrationScenarios, eq(activeScenarios.scenarioId, integrationScenarios.id))
            .where(and(
                eq(activeScenarios.organisationId, organisationId),
                eq(activeScenarios.assistantId, aiAssistantId),
                eq(activeScenarios.isEnabled, true),
                inArray(integrationScenarios.scenarioKey, [...TASK_TOOL_RECIPES]),
            )).limit(1);
        if (!row) return null;
        return row.key.startsWith('jira') ? 'Jira' : 'Asana';
    } catch (err) {
        console.error('[chat-meeting-action] could not read the task tool (non-fatal)', err);
        return undefined;
    }
}

/** Per meeting: how many of its action items are in the ledger, and how many synced. {} on a read failure. */
type TaskSync = { total: number; synced: number; syncedBy: Record<string, number> };
async function taskSyncByMeeting(db: Db, organisationId: number, ids: number[]): Promise<Record<number, TaskSync>> {
    if (!ids.length) return {};
    try {
        const rows = await db.select({
            id: actionItems.meetingRecordId,
            total: sql<number>`count(*)::int`,
            synced: sql<number>`count(*) FILTER (WHERE ${actionItems.syncStatus} = 'synced')::int`,
            jira: sql<number>`count(*) FILTER (WHERE ${actionItems.syncStatus} = 'synced' AND ${actionItems.provider} = 'jira')::int`,
            asana: sql<number>`count(*) FILTER (WHERE ${actionItems.syncStatus} = 'synced' AND ${actionItems.provider} = 'asana')::int`,
        }).from(actionItems).where(and(eq(actionItems.organisationId, organisationId), inArray(actionItems.meetingRecordId, ids)))
            .groupBy(actionItems.meetingRecordId);
        return Object.fromEntries(rows.map((r) => [r.id, { total: Number(r.total), synced: Number(r.synced), syncedBy: { jira: Number(r.jira), asana: Number(r.asana) } }]));
    } catch {
        return {};
    }
}

/** Pure: the snapshot text from the rows. */
/** The platform a meeting was picked up from (data.pickedUpFrom, src/utils/meeting-pickup.ts), or ''. */
function pickedUpLabel(d: Record<string, unknown>): string {
    const p = d.pickedUpFrom;
    return p && typeof p === 'object' && typeof (p as { label?: unknown }).label === 'string' ? oneLine((p as { label: string }).label, 40) : '';
}

export function formatMeetingsSnapshot(
    total: number, waiting: number,
    rows: { id: number; title: string; approvalStatus: string; data: unknown; updatedAt: Date | string | null }[],
    send?: { targets: MeetingSendTarget[]; sync: Record<number, { total: number; synced: number; syncedBy?: Record<string, number> }> },
): string {
    if (!total) return `YOUR MEETINGS RIGHT NOW: none yet. Nothing is waiting for approval.${send ? toolsLine(send.targets) : ''}`;
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
            pickedUpLabel(d) ? `picked up from ${pickedUpLabel(d)}` : '',
            send && (r.approvalStatus === 'approved' || r.approvalStatus === 'scheduled') ? sentWords(send.targets, d, send.sync[r.id]) : '',
        ].filter(Boolean);
        let line = parts.join(' · ');
        const fe = meetingFollowup(d);
        if (r.approvalStatus === 'pending_approval' && fe && shown < FOLLOWUP_SHOWN_MAX) {
            shown++;
            line += `\n    follow-up email — subject: "${oneLine(fe.subject, 200)}"; body: "${oneLine(fe.body, 1500)}"`;
        }
        return line;
    });
    return `YOUR MEETINGS RIGHT NOW (newest first; ${total} in all, ${waiting} waiting for approval${total > rows.length ? `; showing the latest ${rows.length}` : ''}):\n${lines.join('\n')}${send ? toolsLine(send.targets) : ''}`;
}

/** Pure: the switched-on tools, by the key a send_to card names. */
function toolsLine(targets: MeetingSendTarget[]): string {
    return targets.length
        ? `\nTOOLS SWITCHED ON for this assistant (a "send_to" card names one by its key): ${targets.map((t) => `"${t}" (${MEETING_SEND_TARGETS[t].label})`).join(', ')}.`
        : '\nNO TOOLS ARE SWITCHED ON for this assistant: approved meetings stay in Be More Swan. To send meetings to Slack, Notion, Jira or Asana, the user switches one on in Assistant Settings ▸ Connections.';
}

/** Pure: where one approved meeting has gone, of the switched-on tools. */
function sentWords(targets: MeetingSendTarget[], d: Record<string, unknown>, sync?: { total: number; synced: number; syncedBy?: Record<string, number> }): string {
    if (!targets.length) return '';
    const sent: string[] = []; const notYet: string[] = [];
    for (const t of targets) {
        const s = meetingSendState(t, d, sync ?? null);
        (s.sent ? sent : notYet).push(MEETING_TASK_TARGETS.has(t) && s.partly ? `${MEETING_SEND_TARGETS[t].label} (some action items)` : MEETING_SEND_TARGETS[t].label);
    }
    return [sent.length ? `sent to ${sent.join(', ')}` : '', notYet.length ? `not yet sent to ${notYet.join(', ')}` : ''].filter(Boolean).join('; ');
}

/** The chat-only instructions for acting on the meetings above. */
export function meetingActionsPromptBlock(snapshot: string | null): string {
    return `${snapshot ?? 'YOUR MEETINGS RIGHT NOW — your meetings could not be read this turn. Do not guess which meetings exist or what state they are in: say you cannot see them right now and point the user to the Inbox tab. Do not propose a meeting action this turn.'}

EXISTING MEETINGS — you can act on a meeting listed above, named by its "#" number, in five ways, by setting uiElement to a meeting_action_proposal INSTEAD of the minutes card:
- "approve": approve a meeting that is waiting. Approving sends it to the connections switched on for this assistant (the follow-up email to attendees, a Slack summary, a Notion page, tickets in the task tracker). If attendees have no email, say who before offering it: they will not get the follow-up unless an address is added first.
- "add_email": add one attendee's email address — "attendeeName" (as listed) and "email" (exactly as the user gave it; never guess or complete an address).
- "edit_followup": replace the follow-up email — "subject" and "body", the whole new email, written to what the user asked for, starting from the current one listed above.
- "reject": turn a meeting down — "note" is what the user said was wrong, in their words (optional). The note is kept as a rule for future minutes.
- "send_to": send an APPROVED meeting to one switched-on tool now — "target" is its key from TOOLS SWITCHED ON (for example after they switched a tool on, or a send failed). It only sends what has not gone already: Slack, Notion and the follow-up email go once per meeting; Jira and Asana file only the action items not already there. Only for a tool listed as not yet sent; if no tool is switched on, say how to switch one on instead of offering a card.
Only meetings waiting for approval can be changed (approve, add_email, edit_followup, reject); send_to is only for approved ones. You never do it yourself: the user confirms on the card, and only that click changes anything. So never say a meeting HAS been approved, rejected or changed — say the card is there to confirm. One meeting and one action per reply; to add two emails, do one, then the next. If you cannot tell which meeting they mean, ask, quoting the candidates. To change the summary, decisions or action items, tell them to open the meeting in the Inbox tab, or paste the corrected notes so you write it up again.
{ "type": "meeting_action_proposal", "action": "approve" | "add_email" | "edit_followup" | "reject" | "send_to", "recordId": 123, "attendeeName": "<add_email>", "email": "<add_email>", "subject": "<edit_followup>", "body": "<edit_followup>", "note": "<reject, optional>", "target": "<send_to: a tool key>" }`;
}

export interface MeetingActionRequest {
    action: MeetingAction;
    recordId: number;
    attendeeName: string | null;
    email: string | null;
    subject: string | null;
    body: string | null;
    note: string | null;
    /** send_to: the tool's key (src/utils/meeting-send-to.ts). */
    target?: string | null;
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
        ...(str(ui.target, 60) ? { target: str(ui.target, 60) } : {}),
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
    /** approve: the follow-up action is on but no Gmail or Outlook is connected — it won't be sent. */
    noMailbox?: boolean;
    /** approve: the task tool switched on ('Jira' / 'Asana'), or null when none is — the action items then go nowhere. */
    taskTool?: string | null;
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
    /** send_to: the tool, its name, and what it gets. */
    target?: string;
    targetLabel?: string;
    targetWhat?: string;
    /** send_to on Jira/Asana: action items not yet in the tool / in all. */
    tasksLeft?: number;
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

/** send_to is the other way round: only an approved meeting can be sent on. */
function sendToStateBlock(approvalStatus: string): string | null {
    if (approvalStatus === 'approved' || approvalStatus === 'scheduled') return null;
    return approvalStatus === 'rejected'
        ? 'This meeting was rejected, so it isn’t sent anywhere.'
        : 'This meeting is still waiting for approval — approving sends it to every tool switched on. Approve it first.';
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
        const card = buildMeetingActionCard(rec, aiAssistantId, req);
        if (card.action === 'send_to' && !card.blocked && isMeetingSendTarget(card.target)) {
            const on = await loadMeetingSendTargets(db, organisationId, aiAssistantId);
            const sync = (await taskSyncByMeeting(db, organisationId, [rec.id]))[rec.id];
            card.blocked = sendToBlock(card.target, on, rec.data, sync);
            if (MEETING_TASK_TARGETS.has(card.target)) card.tasksLeft = sync ? Math.max(0, sync.total - Number(sync.syncedBy?.[card.target === 'jira_create_tasks' ? 'jira' : 'asana'] ?? sync.synced)) : meetingTaskCount(rec.data);
        }
        if (card.action === 'approve' && !card.blocked) {
            card.noMailbox = await followupBlockedByNoMailbox(db, organisationId, aiAssistantId);
            card.taskTool = await taskToolOn(db, organisationId, aiAssistantId);
        }
        return card;
    } catch (err) {
        console.error('[chat-meeting-action] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

/** Pure: why a send_to can't go now, or null. Same rules as the server's `sendTo` (assistant-records.ts). */
export function sendToBlock(target: MeetingSendTarget, on: MeetingSendTarget[], data: unknown, sync?: { total: number; synced: number; syncedBy?: Record<string, number> }): string | null {
    const label = MEETING_SEND_TARGETS[target].label;
    if (!on.includes(target)) return `${label} isn’t switched on for this assistant. Switch it on in Assistant Settings ▸ Connections, then ask me again.`;
    if (MEETING_TASK_TARGETS.has(target)) {
        if (!meetingTaskCount(data)) return 'This meeting has no action items to send.';
        if (meetingSendState(target, data, sync ?? null).sent) return `Every action item is already in ${label}.`;
        return null;
    }
    if (meetingSendState(target, data).sent) return target === 'email_meeting_followup' ? 'The follow-up email has already been sent.' : `Already sent to ${label}.`;
    return null;
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
        blocked: req.action === 'send_to' ? sendToStateBlock(rec.approvalStatus) : stateBlock(rec.approvalStatus),
        dataHash: meetingDataHash(rec.data),
    };
    if (req.action === 'send_to') {
        if (!isMeetingSendTarget(req.target)) {
            card.blocked ??= 'Which tool should it go to? Name one that is switched on for this assistant.';
        } else {
            card.target = req.target;
            card.targetLabel = MEETING_SEND_TARGETS[req.target].label;
            card.targetWhat = MEETING_SEND_TARGETS[req.target].what;
        }
    }
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
            if (why) return { ...m, uiElement: { ...ui, approvalStatus: rec?.approvalStatus ?? ui.approvalStatus, settled: true, blocked: why } };
            // An approve card made before a mailbox was connected (or after one went away) says the truth now.
            if (ui.action === 'approve') return { ...m, uiElement: { ...ui, noMailbox: await followupBlockedByNoMailbox(db, organisationId, aiAssistantId), taskTool: await taskToolOn(db, organisationId, aiAssistantId) } };
            return m;
        } catch (err) {
            console.error('[chat-meeting-action] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}

/** Pure: why a stored card can no longer be acted on, or null when it still can. */
export function settledReason(ui: Record<string, unknown>, rec: MeetingRow | null): string | null {
    if (!rec) return 'This meeting no longer exists.';
    // send_to acts on an approved meeting: settled once that tool has it (Slack/Notion/email stamp; the ledger is
    // re-checked when the card is used, by the server).
    if (ui.action === 'send_to') {
        if (rec.approvalStatus === 'rejected') return 'This meeting was rejected, so it isn’t sent anywhere.';
        if (isMeetingSendTarget(ui.target) && !MEETING_TASK_TARGETS.has(ui.target) && meetingSendState(ui.target, rec.data).sent) {
            return `Done — sent to ${MEETING_SEND_TARGETS[ui.target].label}.`;
        }
        return null;
    }
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
