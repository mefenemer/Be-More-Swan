// The Note Taker joins a call itself: the RULES (docs/note-taker-bot-plan.md §4, step 2). Pure, so
// tests/meeting-bot.test.ts can drive every one. A bot from Recall.ai (meeting-bot-recall.ts) is sent into a Google
// Meet, Teams or Zoom call; Recall's events move the bot through its states (nextBotState); when the call is over its
// transcript goes through the meeting pick-up engine (meeting-pickup.ts, via 'bot') into the Inbox, waiting for approval.
// meeting-bot-db.ts is the database half.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MEETING_SPECIAL_CATEGORY_CLAUSE } from './meeting-minutes';
import type { PickupPlatform } from './meeting-pickup';

export const MEETING_BOT_FLAG = 'meeting_bot';
/** Plan B7: Zoom joins only once our Zoom app passes Zoom's review (OBF). No row needed: absent = off. */
export const MEETING_BOT_ZOOM_FLAG = 'meeting_bot_zoom';

/**
 * How the minutes writer is told a bot meeting reached it (instead of meeting-pickup.ts PICKUP_CHANNEL_BLOCK). Carries the
 * Note Taker's special-category clause: a bot can only be sent after the workspace accepted DPA 1.2, whose clause 13
 * covers what people say in those meetings.
 */
export const BOT_CHANNEL_BLOCK = `The user's message is a transcript of a meeting the Note Taker joined itself, sent automatically after the call ended. Nobody is waiting to answer questions, so write the minutes from all of it at once and always include the card. Speaker names come from the meeting platform. Set uiElement to null only when the transcript holds no real meeting (only a sound check or silence, say), and then say in "reply" why.\n\n${MEETING_SPECIAL_CATEGORY_CLAUSE}`;

// ── The link ─────────────────────────────────────────────────────────────────────────────────────

export const MEETING_LINK_MAX = 500;

/** Which platform a meeting link is on, or null when it is not a link a bot can join. Pure. */
export function botPlatformOf(raw: unknown): PickupPlatform | null {
    let u: URL;
    try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (host === 'meet.google.com') return /^\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}\/?$/i.test(u.pathname) ? 'google_meet' : null;
    if (host === 'teams.microsoft.com' || host === 'teams.live.com') return u.pathname.length > 1 ? 'teams' : null;
    if (host === 'zoom.us' || host.endsWith('.zoom.us')) return /^\/(j|my|w|wc\/join)\//i.test(u.pathname) ? 'zoom' : null;
    return null;
}

export type LinkResult = { ok: true; url: string; platform: PickupPlatform } | { ok: false; error: string };

/** A pasted meeting link: https, a real Meet / Teams / Zoom meeting, no user name or password, at most 500 characters. */
export function cleanMeetingLink(raw: unknown): LinkResult {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return { ok: false, error: 'Paste the meeting link first.' };
    if (s.length > MEETING_LINK_MAX) return { ok: false, error: 'That link is too long to be a meeting link.' };
    const platform = botPlatformOf(s);
    if (!platform) return { ok: false, error: 'That isn\'t a Google Meet, Microsoft Teams or Zoom meeting link. Copy the link from the meeting invite.' };
    return { ok: true, url: new URL(s).toString(), platform };
}

// ── Where it runs ────────────────────────────────────────────────────────────────────────────────

/** Each Recall region is its own account and key (Recall, in writing, 2026-11-19). */
export type RecallRegion = 'eu' | 'us';
export const RECALL_HOSTS: Record<RecallRegion, string> = { eu: 'eu-central-1.recall.ai', us: 'us-west-2.recall.ai' };

/**
 * UK and EU workspaces run in the EU (Frankfurt); US workspaces in the US (docs/note-taker-bot-legal.md §2). Read from
 * the workspace OWNER's billing country (free text; meeting-bot-db.ts regionFor): anything that reads as the United States is 'us', everything else, and no
 * country at all, is 'eu' (we are UK first). Pure.
 */
export function recallRegionFor(country: string | null | undefined): RecallRegion {
    const c = String(country ?? '').toLowerCase().replace(/[.\s]+/g, ' ').trim();
    return /^(us|usa|u s|u s a|united states|united states of america|america)$/.test(c) ? 'us' : 'eu';
}

// ── What it says in the call ─────────────────────────────────────────────────────────────────────

const BOT_NAME_MAX = 100;
/** Google Meet allows 500 characters in a chat message. */
export const JOIN_MESSAGE_MAX = 500;

const shortBusiness = (name: string | null | undefined) => (String(name ?? '').replace(/\s+/g, ' ').trim() || 'this business').slice(0, 60);

/** "Note Taker for ⟨Business⟩" (plan B5). Pure. */
export function botName(businessName: string | null | undefined): string {
    return `Note Taker for ${shortBusiness(businessName)}`.slice(0, BOT_NAME_MAX);
}

/** The notice posted (and pinned where the platform allows) when the bot joins (plan §6). Pure. */
export function joinMessage(businessName: string | null | undefined): string {
    return `Hi, I'm ${shortBusiness(businessName)}'s Be More Swan Note Taker. I'm making a transcript of this call to write the minutes. The host can remove me at any time.`.slice(0, JOIN_MESSAGE_MAX);
}

// ── Length, timing and charging ──────────────────────────────────────────────────────────────────

/** Plan B4: 2 hours by default, at most 4. */
export const DEFAULT_LENGTH_LIMIT_MINUTES = 120;
export const MAX_LENGTH_LIMIT_MINUTES = 240;
/** Recall advises scheduling with join_at at least 10 minutes ahead; anything sooner joins straight away. */
export const SCHEDULE_AHEAD_MS = 10 * 60 * 1000;
/** How far ahead a bot can be booked. */
export const MAX_SCHEDULE_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
/** Plan §4 auto-leave rules. */
export const WAITING_ROOM_TIMEOUT_S = 600;
export const ALONE_TIMEOUT_S = 120;

export function cleanLengthLimit(raw: unknown): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LENGTH_LIMIT_MINUTES;
    return Math.min(Math.max(n, 5), MAX_LENGTH_LIMIT_MINUTES);
}

export type JoinAtResult = { ok: true; joinAt: Date; scheduled: boolean } | { ok: false; error: string };

/**
 * "Join now" is stored on the minute, so two presses in the same minute hit the (org, link, join time) unique index and
 * send one bot even when they race (review of #769). Pure.
 */
export function immediateJoinAt(now: Date): Date {
    return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

/** "Now" (null/empty) or a time: in the past or under 10 minutes away means now. Pure. */
export function cleanJoinAt(raw: unknown, now: Date): JoinAtResult {
    if (raw === null || raw === undefined || raw === '' || raw === 'now') return { ok: true, joinAt: immediateJoinAt(now), scheduled: false };
    const t = new Date(String(raw));
    if (Number.isNaN(t.getTime())) return { ok: false, error: 'That time could not be read.' };
    if (t.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) return { ok: false, error: 'A Note Taker can be booked up to 60 days ahead.' };
    if (t.getTime() - now.getTime() < SCHEDULE_AHEAD_MS) return { ok: true, joinAt: immediateJoinAt(now), scheduled: false };
    return { ok: true, joinAt: t, scheduled: true };
}

/** Whole minutes from joining to leaving, rounded up. Pure. */
export function minutesInCall(joinedAt: Date | null, leftAt: Date | null): number {
    if (!joinedAt || !leftAt) return 0;
    const ms = leftAt.getTime() - joinedAt.getTime();
    return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

/** Plan B3: `weight` tasks per STARTED 5 minutes in the call; nothing when it was never in it. Pure. */
export function chargeUnits(minutes: number, weight: number): number {
    if (!(minutes > 0) || !(weight > 0)) return 0;
    return Math.ceil(minutes / 5) * weight;
}

/** What the allowance must have room for before a bot is sent: its whole length limit. Pure. */
export function reserveUnits(lengthLimitMinutes: number, weight: number): number {
    return chargeUnits(lengthLimitMinutes, weight);
}

// ── States ───────────────────────────────────────────────────────────────────────────────────────

export type BotStatus = 'scheduled' | 'joining' | 'waiting_room' | 'in_call' | 'ended' | 'done' | 'not_admitted' | 'removed' | 'cancelled' | 'failed';
export const OPEN_BOT_STATUSES: readonly BotStatus[] = ['scheduled', 'joining', 'waiting_room', 'in_call', 'ended'];
export const FINAL_BOT_STATUSES: readonly BotStatus[] = ['done', 'not_admitted', 'removed', 'cancelled', 'failed'];

/** What the GUI and chat say for each state (plan §3: say which one stopped it, never leave it silent). */
export const BOT_STATUS_WORDS: Record<BotStatus, string> = {
    scheduled: 'Booked',
    joining: 'Joining the call',
    waiting_room: 'Waiting to be let in',
    in_call: 'In the call',
    ended: 'Call ended, getting the transcript',
    done: 'Done',
    not_admitted: 'Not let in',
    removed: 'Removed from the call',
    cancelled: 'Cancelled',
    failed: 'Couldn\'t join',
};

export interface BotStateRow {
    status: BotStatus;
    joinedAt: Date | null;
    leftAt: Date | null;
    /** Kept when an event brings no reason of its own (so 'done' doesn't wipe the call_ended reason). */
    statusReason?: string | null;
}

export interface BotStatePatch {
    status: BotStatus;
    statusReason: string | null;
    joinedAt: Date | null;
    leftAt: Date | null;
    minutesInCall: number | null;
}

const WAITING_ROOM_REASON = /waiting_room|not_admitted|noone_joined|no_one_joined|denied_entry|rejected/i;
const REMOVED_REASON = /kicked_from_call|removed|call_ended_by_host_removed/i;

/**
 * Recall's event code (and sub-code) applied to a bot. Codes are not a closed list (Recall says so): unknown ones change
 * nothing. A final state never moves, except that a bot that was in the call is still written up when Recall says
 * 'done' after a removal. Pure.
 */
export function nextBotState(row: BotStateRow, code: string, subCode: string | null | undefined, at: Date): BotStatePatch | null {
    const reason = subCode ? String(subCode).slice(0, 120) : null;
    const base: BotStatePatch = { status: row.status, statusReason: row.statusReason ?? null, joinedAt: row.joinedAt, leftAt: row.leftAt, minutesInCall: null };
    const isFinal = FINAL_BOT_STATUSES.includes(row.status);
    const left = () => base.leftAt ?? at;

    switch (code) {
        case 'joining_call':
            if (isFinal || row.status !== 'scheduled') return null;
            return { ...base, status: 'joining' };
        case 'in_waiting_room':
            if (isFinal || row.status === 'in_call' || row.status === 'ended') return null;
            return { ...base, status: 'waiting_room' };
        case 'in_call_not_recording':
        case 'recording_permission_allowed':
        case 'in_call_recording':
            if (isFinal || row.status === 'ended') return null;
            return { ...base, status: 'in_call', joinedAt: row.joinedAt ?? at };
        case 'recording_permission_denied':
            if (isFinal) return null;
            return { ...base, status: row.joinedAt ? 'in_call' : row.status, statusReason: 'recording_permission_denied' };
        case 'call_ended': {
            if (isFinal || row.status === 'ended') return null;
            if (!row.joinedAt) return { ...base, status: WAITING_ROOM_REASON.test(reason ?? '') || row.status === 'waiting_room' ? 'not_admitted' : 'failed', statusReason: reason ?? base.statusReason, leftAt: left() };
            return { ...base, status: 'ended', statusReason: reason ?? base.statusReason, leftAt: left() };
        }
        case 'done': {
            if (row.status === 'done' || row.status === 'cancelled') return null;
            if (!row.joinedAt) {
                if (isFinal) return null;
                return { ...base, status: row.status === 'waiting_room' ? 'not_admitted' : 'failed', statusReason: reason ?? 'never_joined', leftAt: left() };
            }
            // Removed by the host after joining: what was heard is still written up (plan §6); the call_ended reason stays.
            const leftAt = left();
            return { ...base, status: 'done', statusReason: reason ?? base.statusReason, leftAt, minutesInCall: minutesInCall(row.joinedAt, leftAt) };
        }
        case 'fatal': {
            if (isFinal && row.status !== 'removed') return null;
            if (row.joinedAt) {
                // It got some of the call: treat like an early end, so what was heard can still be written up.
                const leftAt = left();
                return { ...base, status: 'done', statusReason: reason ?? 'fatal', leftAt, minutesInCall: minutesInCall(row.joinedAt, leftAt) };
            }
            const status: BotStatus = WAITING_ROOM_REASON.test(reason ?? '') ? 'not_admitted' : REMOVED_REASON.test(reason ?? '') ? 'removed' : 'failed';
            return { ...base, status, statusReason: reason ?? 'fatal', leftAt: left() };
        }
        default:
            return null;
    }
}

export interface BotStatusChange { code: string; subCode: string | null; at: Date }

/**
 * Every status change Recall holds for a bot, applied in order (the 15-minute poll's way in). Reading only the LAST change
 * would turn a recorded call whose webhooks were all missed ("joining" → … → "done") into "never joined" and lose it
 * (review of #769). The combined change from the row's state, or null when nothing moved. Pure.
 */
export function replayBotState(row: BotStateRow, changes: readonly BotStatusChange[]): BotStatePatch | null {
    let cur: BotStateRow = { ...row };
    let last: BotStatePatch | null = null;
    let minutes: number | null = null;
    for (const c of [...changes].sort((a, b) => a.at.getTime() - b.at.getTime())) {
        const p = nextBotState(cur, c.code, c.subCode, c.at);
        if (!p) continue;
        last = p;
        if (p.minutesInCall !== null) minutes = p.minutesInCall;
        cur = { status: p.status, joinedAt: p.joinedAt, leftAt: p.leftAt, statusReason: p.statusReason };
    }
    if (!last) return null;
    const same = (x: Date | null | undefined, y: Date | null | undefined) => (x?.getTime() ?? null) === (y?.getTime() ?? null);
    const moved = last.status !== row.status || !same(last.joinedAt, row.joinedAt) || !same(last.leftAt, row.leftAt)
        || (last.statusReason ?? null) !== (row.statusReason ?? null) || minutes !== null;
    return moved ? { ...last, minutesInCall: minutes } : null;
}

// ── The request to Recall ────────────────────────────────────────────────────────────────────────

export interface BotRequestInput {
    meetingUrl: string;
    businessName: string | null;
    joinAt: Date;
    scheduled: boolean;
    lengthLimitMinutes: number;
    botRowId: number;
    organisationId: number;
}

/**
 * The POST /api/v1/bot/ body (Recall docs, read 2026-11-19; proven on free Meet and Teams in Phase 0): Recall's own
 * transcript with speaker names from the meeting platform (B2), the pinned join notice, and the auto-leave rules. Pure.
 */
export function recallBotRequest(i: BotRequestInput): Record<string, unknown> {
    return {
        meeting_url: i.meetingUrl,
        bot_name: botName(i.businessName),
        ...(i.scheduled ? { join_at: i.joinAt.toISOString() } : {}),
        chat: { on_bot_join: { send_to: 'everyone', message: joinMessage(i.businessName), pin: true } },
        recording_config: {
            transcript: {
                provider: { recallai_streaming: { mode: 'prioritize_accuracy', language_code: 'auto' } },
                diarization: { use_separate_streams_when_available: true },
            },
        },
        automatic_leave: {
            waiting_room_timeout: WAITING_ROOM_TIMEOUT_S,
            noone_joined_timeout: WAITING_ROOM_TIMEOUT_S,
            everyone_left_timeout: { timeout: ALONE_TIMEOUT_S },
            in_call_recording_timeout: cleanLengthLimit(i.lengthLimitMinutes) * 60,
        },
        // Echoed back on every webhook. Strings only (Recall). Never meeting text.
        metadata: { bms_bot_id: String(i.botRowId), bms_org_id: String(i.organisationId) },
    };
}

// ── Recall's transcript ──────────────────────────────────────────────────────────────────────────

export interface BotTranscriptLine { speaker: string | null; text: string }

/** Recall's transcript download, [{ participant: { name }, words: [{ text }] }], as lines. Pure. */
export function recallTranscriptLines(json: unknown): BotTranscriptLine[] {
    if (!Array.isArray(json)) return [];
    return json.map((b) => {
        const block = (b && typeof b === 'object' ? b : {}) as { participant?: { name?: unknown }; words?: { text?: unknown }[] };
        const name = typeof block.participant?.name === 'string' ? block.participant.name.trim().slice(0, 120) : '';
        const text = (Array.isArray(block.words) ? block.words : []).map((w) => (typeof w?.text === 'string' ? w.text : '')).join(' ').replace(/\s+/g, ' ').trim();
        return { speaker: name || null, text };
    }).filter((l) => l.text);
}

// ── Recall's webhook signature ───────────────────────────────────────────────────────────────────

/**
 * Which of the region secrets signed this request, or null (Recall docs, 2026-11-19): the signed string is
 * `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the secret after "whsec_" base64-decoded, and the header holds
 * space-separated "v1,<base64>" entries (several during a rotation). Older accounts send svix-* headers instead. Pure.
 */
export function verifyRecallSignature(
    secrets: Partial<Record<RecallRegion, string>>,
    headers: Record<string, string | undefined>,
    rawBody: string,
    now: Date = new Date(),
): RecallRegion | null {
    const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
    const id = h('webhook-id') ?? h('svix-id');
    const ts = h('webhook-timestamp') ?? h('svix-timestamp');
    const sig = h('webhook-signature') ?? h('svix-signature');
    if (!id || !ts || !sig) return null;
    // Five minutes either way, the usual Svix tolerance, so an old captured request can't be replayed.
    const tsMs = Number(ts) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(now.getTime() - tsMs) > 5 * 60 * 1000) return null;
    const given = sig.split(' ').map((p) => p.split(',')).filter(([v, s]) => v === 'v1' && s).map(([, s]) => Buffer.from(s, 'base64'));
    if (!given.length) return null;
    for (const region of ['eu', 'us'] as RecallRegion[]) {
        const secret = secrets[region];
        if (!secret) continue;
        const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
        const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
        if (given.some((g) => g.length === expected.length && timingSafeEqual(g, expected))) return region;
    }
    return null;
}
