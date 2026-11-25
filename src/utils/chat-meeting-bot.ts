// src/utils/chat-meeting-bot.ts
// The Note Taker chat's hands on its meeting bots (docs/note-taker-bot-plan.md §4, step 3, the chat half of the
// GUI-and-chat rule): "join my 2pm call <link>" or "cancel the 2pm one" draws a `meeting_bot_proposal` card, and only
// the user's click sends or withdraws a bot — through the SAME server action as the Inbox's "Send to a call"
// (netlify/functions/meeting-bots.ts → sendMeetingBot / removeMeetingBot).
//
// The chat sees THE NOTE TAKER IN CALLS (buildMeetingBotsSnapshot) only while the meeting_bot flag is on for the
// workspace; with it off the block is absent and the chat keeps saying it cannot join a call. The model never acts: it
// proposes, this module re-checks the proposal (link, platform, time, DPA 1.2, the bot belongs to this assistant) and
// rebuilds the card from facts, so a made-up bot id or a link the bot can't join draws nothing or a "can't be done" card.
//
// ⚠️ Never throws.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { meetingBots } from '../../db/schema';
import { isFeatureEnabled } from './feature-flags';
import {
    BOT_STATUS_WORDS, MEETING_BOT_FLAG, MEETING_BOT_ZOOM_FLAG, OPEN_BOT_STATUSES, cleanJoinAt, cleanMeetingLink,
    type BotStatus,
} from './meeting-bot';
import { hasAcceptedBotDpa } from './meeting-bot-db';
import { PICKUP_PLATFORM_LABELS, type PickupPlatform } from './meeting-pickup';
import { getTaskCosts, getUpcomingTaskCosts } from './task-costs';

type Db = ReturnType<typeof getDb>;

export const MEETING_BOT_PROPOSAL_TYPE = 'meeting_bot_proposal';
/** How long a stored "send" card is offered again. After that a click could send a bot into a LATER call on a recurring
 *  link (the duplicate check only looks back 3 hours) and charge for it (review of #774). */
export const SEND_CARD_FRESH_MS = 10 * 60 * 1000;
const LIVE: readonly string[] = ['joining', 'waiting_room', 'in_call'];
const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export interface BotSnapshotRow { id: number; platform: string; title: string | null; joinAt: Date; status: string }

/** Pure: the block from the facts. */
export function formatMeetingBotsSnapshot(i: { dpaAccepted: boolean; tasksPer5Min: number; next?: { units: number; from: string } | null; zoom: boolean; rows: readonly BotSnapshotRow[] }): string {
    const lines = i.rows.map((r) => {
        const label = PICKUP_PLATFORM_LABELS[r.platform as PickupPlatform] ?? r.platform;
        const when = r.status === 'scheduled' ? `booked for ${r.joinAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : `sent ${r.joinAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        return `bot #${r.id} · ${label} · "${oneLine(r.title, 120) || 'Meeting'}" · ${when} · ${BOT_STATUS_WORDS[r.status as BotStatus] ?? r.status}`;
    });
    return [
        `THE NOTE TAKER IN CALLS: it can join ${i.zoom ? 'Google Meet, Microsoft Teams and Zoom' : 'Google Meet and Microsoft Teams'} calls when the user sends it a link.`,
        i.dpaAccepted ? '' : 'IT CANNOT JOIN YET: an owner or admin of the workspace must first accept the updated Data Processing Agreement (version 1.2). Say so if they ask; a send card will say it can\'t be done.',
        i.tasksPer5Min > 0 ? `Cost: ${i.tasksPer5Min} task${i.tasksPer5Min === 1 ? '' : 's'} for each started 5 minutes in the call (about ${i.tasksPer5Min * 12} an hour); nothing if it isn't let in.` : (i.next && i.next.units > 0 ? `Cost: free until ${i.next.from} (YYYY-MM-DD; say the date in words), then ${i.next.units} task${i.next.units === 1 ? '' : 's'} for each started 5 minutes in the call; nothing if it isn't let in.` : 'Cost: nothing at the moment.'),
        lines.length ? `Booked or in a call now (newest first):\n${lines.join('\n')}` : 'None booked or in a call now.',
    ].filter(Boolean).join('\n');
}

/** The block for the chat prompt, or null when the meeting_bot flag is off (or the read failed). */
export async function buildMeetingBotsSnapshot(db: Db, organisationId: number, aiAssistantId: number): Promise<string | null> {
    try {
        if (!(await isFeatureEnabled(organisationId, MEETING_BOT_FLAG))) return null;
        const [rows, dpaAccepted, costs, zoom, upcoming] = await Promise.all([
            db.select({ id: meetingBots.id, platform: meetingBots.platform, title: meetingBots.title, joinAt: meetingBots.joinAt, status: meetingBots.status })
                .from(meetingBots).where(and(
                    eq(meetingBots.organisationId, organisationId), eq(meetingBots.aiAssistantId, aiAssistantId),
                    inArray(meetingBots.status, [...OPEN_BOT_STATUSES]),
                )).orderBy(desc(meetingBots.joinAt)).limit(10),
            hasAcceptedBotDpa(db, organisationId),
            getTaskCosts(),
            isFeatureEnabled(organisationId, MEETING_BOT_ZOOM_FLAG).catch(() => false),
            getUpcomingTaskCosts(),
        ]);
        return formatMeetingBotsSnapshot({ dpaAccepted, tasksPer5Min: costs.weights.meeting_bot_call, next: upcoming.meeting_bot_call ?? null, zoom, rows });
    } catch (err) {
        console.error('[chat-meeting-bot] snapshot failed (non-fatal)', err instanceof Error ? err.message : err);
        return null;
    }
}

/** The chat-only instructions. '' when the snapshot is null (flag off): the chat then says it cannot join a call. */
export function meetingBotPromptBlock(snapshot: string | null): string {
    if (!snapshot) return '';
    return `${snapshot}

SENDING THE NOTE TAKER INTO A CALL — you cannot join a call yourself, but the user can send the Note Taker (a bot named after the business, which posts a recording notice in the meeting chat, records, and leaves when the call ends; the minutes then wait in the Inbox). When the user asks for that, set uiElement to a meeting_bot_proposal INSTEAD of the minutes card:
- "send": "meetingUrl" exactly as the user gave it (never invent or complete a link; if they gave none, ask for it), optional "joinAt" (ISO 8601 with their timezone offset, only when they named a time; omit for "now"), optional "title" (a short name for the meeting).
- "remove": cancel a booked bot or take a live one out of the call — "botId" from the list above.
You never send or remove a bot yourself: the user confirms on the card. So never say it HAS been sent, booked or removed — say the card is there to confirm. Remind them to tell the people in the meeting that the Note Taker is recording. One card per reply.
{ "type": "meeting_bot_proposal", "action": "send" | "remove", "meetingUrl": "<send>", "joinAt": "<send, optional>", "title": "<send, optional>", "botId": 12 }`;
}

export interface MeetingBotRequest { action: 'send' | 'remove'; meetingUrl: string | null; joinAt: string | null; title: string | null; botId: number | null }

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function meetingBotFromUiElement(uiElement: unknown): MeetingBotRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== MEETING_BOT_PROPOSAL_TYPE) return null;
    if (ui.action === 'send') {
        const meetingUrl = typeof ui.meetingUrl === 'string' ? ui.meetingUrl.trim().slice(0, 500) : '';
        if (!meetingUrl) return null;
        return { action: 'send', meetingUrl, joinAt: typeof ui.joinAt === 'string' && ui.joinAt.trim() ? ui.joinAt.trim().slice(0, 40) : null, title: oneLine(ui.title, 200) || null, botId: null };
    }
    if (ui.action === 'remove') {
        const botId = Number(String(ui.botId ?? '').replace(/^#/, ''));
        return Number.isInteger(botId) && botId > 0 ? { action: 'remove', meetingUrl: null, joinAt: null, title: null, botId } : null;
    }
    return null;
}

/**
 * The card, rebuilt from facts, or null when the proposal names nothing real (a bot that isn't this assistant's).
 * A send that can't happen (bad link, Zoom, DPA, flag off, time out of range) still draws a card, marked blocked with
 * the reason in words, so the user sees why rather than a silent nothing.
 */
export async function resolveMeetingBotProposal(
    db: Db, organisationId: number, aiAssistantId: number, req: MeetingBotRequest, now: Date = new Date(),
): Promise<Record<string, unknown> | null> {
    try {
        if (req.action === 'remove') {
            const [row] = await db.select().from(meetingBots).where(and(
                eq(meetingBots.id, req.botId!), eq(meetingBots.organisationId, organisationId), eq(meetingBots.aiAssistantId, aiAssistantId),
            )).limit(1);
            if (!row) return null;
            const open = OPEN_BOT_STATUSES.includes(row.status as BotStatus) && row.status !== 'ended';
            return {
                type: MEETING_BOT_PROPOSAL_TYPE, action: 'remove', assistantId: aiAssistantId, botId: row.id,
                platformLabel: PICKUP_PLATFORM_LABELS[row.platform as PickupPlatform] ?? row.platform,
                title: row.title, joinAt: row.joinAt.toISOString(), live: LIVE.includes(row.status),
                statusWords: BOT_STATUS_WORDS[row.status as BotStatus] ?? row.status,
                madeAt: now.toISOString(),
                ...(open ? {} : { blocked: 'It has already finished, so there is nothing to cancel.' }),
            };
        }
        // madeAt: a stored send card is only offered again for a short while (refreshMeetingBotCards). freshForMs: how long
        // the card on screen stays clickable, RELATIVE, so a device clock that runs fast can't expire it at once (review of #774).
        const base = { type: MEETING_BOT_PROPOSAL_TYPE, action: 'send', assistantId: aiAssistantId, meetingUrl: req.meetingUrl, title: req.title, madeAt: now.toISOString(), freshForMs: SEND_CARD_FRESH_MS };
        const block = (reason: string) => ({ ...base, joinAt: null, blocked: reason });
        if (!(await isFeatureEnabled(organisationId, MEETING_BOT_FLAG))) return block('Sending the Note Taker into a call isn\'t switched on for this workspace yet.');
        const link = cleanMeetingLink(req.meetingUrl);
        if (!link.ok) return block(link.error);
        if (link.platform === 'zoom' && !(await isFeatureEnabled(organisationId, MEETING_BOT_ZOOM_FLAG).catch(() => false))) {
            return block('The Note Taker can join Google Meet and Microsoft Teams calls. Zoom is coming soon.');
        }
        const when = cleanJoinAt(req.joinAt, now);
        if (!when.ok) return block(when.error);
        if (!(await hasAcceptedBotDpa(db, organisationId))) return block('An owner or admin of your workspace needs to accept the updated Data Processing Agreement (version 1.2) first.');
        return {
            ...base, meetingUrl: link.url, platformLabel: PICKUP_PLATFORM_LABELS[link.platform],
            joinAt: when.scheduled ? when.joinAt.toISOString() : null,
            tasksPer5Min: (await getTaskCosts()).weights.meeting_bot_call,
        };
    } catch (err) {
        console.error('[chat-meeting-bot] resolve failed (non-fatal)', err instanceof Error ? err.message : err);
        // A send the user DID give a link for: say we couldn't check it, rather than asking for the link again.
        if (req.action === 'send') {
            return { type: MEETING_BOT_PROPOSAL_TYPE, action: 'send', assistantId: aiAssistantId, meetingUrl: req.meetingUrl, title: req.title, joinAt: null,
                blocked: 'I couldn’t check that just now, so nothing was sent. Try again in a moment, or use “Send to a call” on the Inbox tab.' };
        }
        return null;
    }
}

// ── Stored cards (a reopened conversation, the Team feed: src/utils/chat-card-refresh.ts) ───────────


/** Pure: why a stored card can no longer be acted on, or null while it still can. `bot` is the remove card's row. */
export function botCardSettledReason(ui: Record<string, unknown>, bot: { status: string } | null, now: Date = new Date()): string | null {
    if (ui.action === 'send') {
        const made = typeof ui.madeAt === 'string' ? Date.parse(ui.madeAt) : NaN;
        if (!Number.isFinite(made) || now.getTime() - made > SEND_CARD_FRESH_MS) {
            return 'An earlier request, so it isn’t offered again. If the Note Taker should still join, ask me again or use “Send to a call” on the Inbox tab.';
        }
        return null;
    }
    if (ui.action === 'remove') {
        if (!bot) return 'This booking no longer exists.';
        if (!OPEN_BOT_STATUSES.includes(bot.status as BotStatus) || bot.status === 'ended') {
            return `Already finished (${BOT_STATUS_WORDS[bot.status as BotStatus] ?? bot.status}), so there is nothing to cancel.`;
        }
    }
    return null;
}

/** Settles stored meeting_bot_proposal cards that must not be clicked again. Never throws. */
export async function refreshMeetingBotCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[], now: Date = new Date(),
): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== MEETING_BOT_PROPOSAL_TYPE || ui.settled || ui.blocked) return m;
        try {
            let bot: { status: string } | null = null;
            if (ui.action === 'remove') {
                const [row] = await db.select({ status: meetingBots.status }).from(meetingBots).where(and(
                    eq(meetingBots.id, Number(ui.botId)), eq(meetingBots.organisationId, organisationId), eq(meetingBots.aiAssistantId, aiAssistantId),
                )).limit(1);
                bot = row ?? null;
            }
            const why = botCardSettledReason(ui, bot, now);
            if (why) return { ...m, uiElement: { ...ui, settled: true, blocked: why } };
            // A send card still fresh is re-served with only the time it has LEFT, measured on our clock.
            if (ui.action === 'send') return { ...m, uiElement: { ...ui, freshForMs: Math.max(0, SEND_CARD_FRESH_MS - (now.getTime() - Date.parse(String(ui.madeAt)))) } };
            return m;
        } catch (err) {
            console.error('[chat-meeting-bot] could not refresh a stored card (non-fatal)', err instanceof Error ? err.message : err);
            // Safer to settle than to leave a live button we couldn't check.
            return { ...m, uiElement: { ...ui, settled: true, blocked: 'This earlier request can’t be checked right now. Ask me again if it still needs doing.' } };
        }
    }));
}
