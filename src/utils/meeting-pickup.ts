// The Note Taker picks up meetings from Google Meet, Teams and Zoom by itself (docs/meeting-apps-pickup-plan.md §2).
//
// After a call ends, the platform's OWN transcript is read (no bot joins, nothing is recorded by us), written up
// by the same minutes writer as "New meeting", and filed in the Inbox waiting for approval, exactly like pasted
// notes. Nothing is sent anywhere until a person approves.
//
//   1. discoverMeetings — every 15 minutes (meeting-pickup.ts), ask each connected platform for meetings that ended
//      since the last check, and add one meeting_imports row each. The unique key means a meeting is never
//      written up twice, however often it is seen.
//   2. writeImport — in the background (meeting-import-background.ts), per row: claim it, fetch the transcript
//      (retried with a back-off until it is ready, for up to 24 hours), check the task allowance, write the
//      minutes, file them, then spend 1 task (meeting_pickup) AFTER the success latch.
//
// This file holds the rules and nothing that touches the database or a platform, so tests can drive it with a
// fake platform and an in-memory store. meeting-pickup-db.ts is the real store and wiring. Each platform is a
// MeetingSource (src/utils/meeting-sources/), listed in meeting-pickup-db.ts meetingSources.

import type { WriteMinutesResult, MinutesAssistant } from './meeting-minutes-writer';

export type PickupPlatform = 'google_meet' | 'teams' | 'zoom';

export const PICKUP_PLATFORM_LABELS: Record<PickupPlatform, string> = {
    google_meet: 'Google Meet',
    teams: 'Microsoft Teams',
    zoom: 'Zoom',
};

/** How far back the first check looks for a newly connected platform. */
export const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Each check looks a little before where the last one stopped, so a meeting that ended mid-check is not missed. */
export const CHECK_OVERLAP_MS = 10 * 60 * 1000;
/** A meeting is not written until it has been over this long (platforms finish the transcript after the call). */
export const SETTLE_MS = 2 * 60 * 1000;
/** How long to keep looking for a transcript before giving up ('no_transcript'). */
export const TRANSCRIPT_WAIT_MS = 24 * 60 * 60 * 1000;
/** Failures (not "transcript not ready yet") before a meeting is given up as 'failed'. */
export const MAX_ATTEMPTS = 4;
/** How long a meeting waits for room in the task allowance (it resets on the 1st) before it is given up. */
export const TASK_LIMIT_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
/** How often a meeting waiting for the allowance is tried again. */
export const TASK_LIMIT_RETRY_MS = 6 * 60 * 60 * 1000;
/** A writer's claim on a meeting; a writer that dies frees it when this runs out. */
export const LEASE_MS = 20 * 60 * 1000; // longer than a background function may run (15 minutes)
/** Most meetings handed to writers per check. */
export const DUE_PER_RUN = 25;

// ── What a platform provides ─────────────────────────────────────────────────────────────────────

/** A workspace that has this platform connected and a Note Taker to write for. */
export interface PickupAccount {
    organisationId: number;
    assistantId: number;
    platform: PickupPlatform;
    /** Whatever the platform needs to make calls (a connection id, say). The engine never reads it. */
    ref?: unknown;
}

export interface FinishedMeeting {
    externalId: string;
    title?: string | null;
    link?: string | null;
    startedAt?: Date | null;
    endedAt: Date;
}

export interface TranscriptLine { speaker: string | null; text: string }
export interface PickedTranscript {
    lines: TranscriptLine[];
    /** Everyone the platform says took part, by name (speakers or not). */
    attendees?: string[];
    /**
     * The platform says this transcript is FINISHED, so no lines means there will never be any: 'complete' (it heard
     * nobody speak) or 'failed' (it couldn't make one). Absent = it may still be coming, so empty means wait (up to 24 h).
     * Only Recall says this today (the bot); a picked-up transcript keeps the wait.
     */
    finished?: 'complete' | 'failed';
}

/** How a meeting's transcript reached us: the platform's own (picked up) or our bot's (docs/note-taker-bot-plan.md). */
export type ImportVia = 'transcript' | 'bot';

export interface MeetingSource {
    platform: PickupPlatform;
    /** 'bot': the Note Taker's own bot, for meetings on any platform (absent = 'transcript'). */
    via?: ImportVia;
    /** Every workspace with this platform connected and an active Note Taker. */
    accounts(): Promise<PickupAccount[]>;
    /** One workspace's account, or null when it has since disconnected. */
    account(organisationId: number): Promise<PickupAccount | null>;
    /** Meetings that ended between `since` and `now`. */
    listFinished(account: PickupAccount, since: Date, now: Date): Promise<FinishedMeeting[]>;
    /** The transcript, or null when the platform has not finished it (or the meeting has none). */
    fetchTranscript(account: PickupAccount, externalId: string, endedAt: Date | null): Promise<PickedTranscript | null>;
}

/**
 * Pick-up is switched on per workspace (feature_flags 'meeting_pickup', db/z-meeting-pickup-flag.sql) until Google
 * approves the Meet scope and the Terms notice for the new charge has run. The platforms themselves are listed in
 * meeting-pickup-db.ts meetingSources (Google Meet first, plan Phase 2).
 */
export const MEETING_PICKUP_FLAG = 'meeting_pickup';

/**
 * The source that reads a meeting's transcript: the bot source for a bot's meeting (whatever its platform), otherwise
 * the platform's own. Pure.
 */
export function sourceFor(sources: readonly MeetingSource[], row: { platform: PickupPlatform; via?: ImportVia }): MeetingSource | undefined {
    const via = row.via ?? 'transcript';
    return sources.find((s) => (s.via ?? 'transcript') === via && (via === 'bot' || s.platform === row.platform));
}

// ── Turning a transcript into the writer's message ────────────────────────────────────────────────

/** "Name: words" lines, with back-to-back lines from the same speaker joined. Pure. */
export function speakerLines(lines: readonly TranscriptLine[]): string[] {
    const out: string[] = [];
    let last: string | null = null;
    for (const l of lines) {
        const text = String(l.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const who = (l.speaker ?? '').trim() || 'Unknown speaker';
        if (who === last) out[out.length - 1] += ` ${text}`;
        else out.push(`${who}: ${text}`);
        last = who;
    }
    return out;
}

/** How the writer is told where the text came from (the form has its own, FORM_CHANNEL_BLOCK). */
export const PICKUP_CHANNEL_BLOCK = 'The user\'s message is a transcript the meeting platform made itself, picked up automatically after the call ended. Nobody is waiting to answer questions, so write the minutes from all of it at once and always include the card. Speaker names come from the platform. Set uiElement to null only when the transcript holds no real meeting (only a sound check or silence, say), and then say in "reply" why.';

/** The one message the writer gets for a picked-up meeting. Pure. */
export function pickupMessage(i: {
    platform: PickupPlatform; title?: string | null; startedAt?: Date | null; attendees?: readonly string[]; lines: readonly string[];
}): string {
    const label = PICKUP_PLATFORM_LABELS[i.platform];
    const when = i.startedAt ? `, ${i.startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
    const names = [...new Set((i.attendees ?? []).map((n) => n.trim()).filter(Boolean))];
    return [
        `Meeting on ${label}: ${(i.title ?? '').trim() || `${label} call`}${when}`,
        names.length ? `Present: ${names.join(', ')}` : '',
        `<<<TRANSCRIPT\n${i.lines.join('\n')}\nTRANSCRIPT>>>`,
    ].filter(Boolean).join('\n');
}

/** What a picked-up meeting record carries so the Inbox and chat can say where it came from. */
export interface PickedUpFrom {
    platform: PickupPlatform; label: string; link: string | null; startedAt: string | null; importId: number;
    /** 'bot' when the Note Taker joined the call itself; absent for a picked-up platform transcript. */
    via?: 'bot';
}

export function pickedUpFrom(platform: PickupPlatform, importId: number, link?: string | null, startedAt?: Date | null, via?: ImportVia): PickedUpFrom {
    const safeLink = typeof link === 'string' && /^https:\/\//i.test(link) ? link.slice(0, 500) : null;
    const out: PickedUpFrom = { platform, label: PICKUP_PLATFORM_LABELS[platform], link: safeLink, startedAt: startedAt ? startedAt.toISOString() : null, importId };
    if (via === 'bot') out.via = 'bot';
    return out;
}

/** Where the next check should start from. Pure. */
export function checkWindowStart(checkedThrough: Date | null, now: Date): Date {
    if (!checkedThrough) return new Date(now.getTime() - FIRST_LOOKBACK_MS);
    return new Date(Math.max(checkedThrough.getTime() - CHECK_OVERLAP_MS, now.getTime() - FIRST_LOOKBACK_MS * 7));
}

/**
 * The transcript isn't there yet: when to look again, or null to give up. Waits about half the meeting's age,
 * between 10 minutes and 6 hours, so a meeting with no transcript costs a few dozen look-ups, not hundreds. Pure.
 */
export function transcriptRetryAt(endedAt: Date | null, now: Date): Date | null {
    const ended = endedAt ?? now;
    const age = now.getTime() - ended.getTime();
    if (age >= TRANSCRIPT_WAIT_MS) return null;
    const wait = Math.min(Math.max(age / 2, 10 * 60 * 1000), 6 * 60 * 60 * 1000);
    return new Date(now.getTime() + wait);
}

// ── The Note Taker's own bot in the same call ─────────────────────────────────────────────────────
//
// A workspace can have Google Meet connected AND send the Note Taker's bot to a call (docs/note-taker-bot-plan.md).
// Without a rule the call would be written up twice and charged twice (1 task for the pick-up, plus the bot's minutes
// in the call). The bot wins: someone chose to send it, and it is charged by its time in the call. A picked-up
// meeting whose call the bot got into is skipped ('bot_joined'), free.

/** A meeting_bots row, only the fields the rule reads. */
export interface BotOnCall { meetingUrl: string; status: string; joinAt: Date; joinedAt: Date | null; leftAt: Date | null }

/** Bot statuses that can still turn into "it got in" (meeting-bot.ts OPEN_BOT_STATUSES). */
const BOT_STILL_OPEN = new Set(['scheduled', 'joining', 'waiting_room', 'in_call', 'ended']);
/** Clock slack either side of the call when matching a bot's time in it. */
export const BOT_MATCH_SLACK_MS = 10 * 60 * 1000;
/** How early before the call a bot may have been booked and still be for this call. */
export const BOT_BOOKED_EARLY_MS = 60 * 60 * 1000;
/** How long after the call an open bot is waited for (its webhook or the 15-minute poll settles it well before). */
export const BOT_WAIT_MS = 2 * 60 * 60 * 1000;
/** How often a meeting waiting on an open bot is looked at again. */
export const BOT_WAIT_RETRY_MS = 15 * 60 * 1000;

/** One call's link in a form both sides share: host + path, lower case, no query or trailing slash. Pure. */
export function sameCallKey(link: string | null | undefined): string | null {
    let u: URL;
    try { u = new URL(String(link ?? '').trim()); } catch { return null; }
    const path = u.pathname.replace(/\/+$/, '');
    if (!path) return null;
    return `${u.hostname.toLowerCase()}${path.toLowerCase()}`;
}

/**
 * Was the Note Taker's bot in this call? 'covered' (it got in while the call ran: skip the pick-up), 'wait' (a bot for
 * this call has not settled yet: look again shortly) or 'clear' (write it up). Matched on the join link and on time,
 * so the same Meet code used for a call next week is a different call. Pure.
 */
export function botCover(row: { link: string | null; startedAt: Date | null; endedAt: Date | null }, bots: readonly BotOnCall[], now: Date): 'covered' | 'wait' | 'clear' {
    const key = sameCallKey(row.link);
    if (!key || !row.endedAt) return 'clear';
    const from = (row.startedAt ?? row.endedAt).getTime() - BOT_MATCH_SLACK_MS;
    const to = row.endedAt.getTime() + BOT_MATCH_SLACK_MS;
    let wait = false;
    for (const b of bots) {
        if (sameCallKey(b.meetingUrl) !== key) continue;
        if (b.joinedAt) {
            const left = (b.leftAt ?? now).getTime();
            if (b.joinedAt.getTime() <= to && left >= from) return 'covered';
            continue;
        }
        const booked = b.joinAt.getTime();
        if (BOT_STILL_OPEN.has(b.status) && booked >= from - BOT_BOOKED_EARLY_MS && booked <= to) wait = true;
    }
    return wait && now.getTime() - row.endedAt.getTime() < BOT_WAIT_MS ? 'wait' : 'clear';
}

// ── The store (meeting-pickup-db.ts in production, a Map in tests) ─────────────────────────────────

export interface ImportRow {
    id: number;
    organisationId: number;
    assistantId: number | null;
    platform: PickupPlatform;
    externalId: string;
    title: string | null;
    link: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    attempts: number;
    /** Absent = 'transcript'. */
    via?: ImportVia;
}

export type ImportRelease =
    | { status: 'found'; retryAt?: Date | null; lastError?: string | null; refundAttempt?: boolean }
    | { status: 'skipped'; skipReason: 'no_transcript' | 'nobody_spoke' | 'no_meeting' | 'task_limit' | 'assistant_gone' | 'disconnected' | 'blocked' | 'bot_joined' }
    | { status: 'failed'; lastError: string };

export interface PickupStore {
    checkedThrough(organisationId: number, platform: PickupPlatform): Promise<Date | null>;
    saveCheck(organisationId: number, platform: PickupPlatform, s: { at: Date; through: Date | null; found: number; error: string | null }): Promise<void>;
    /** Adds the meetings not seen before; returns how many were new. */
    addFound(account: PickupAccount, meetings: readonly FinishedMeeting[]): Promise<number>;
    /** Meetings ready for a writer: 'found' (or a dead writer's 'writing'), lease free, over for SETTLE_MS. */
    due(now: Date, limit: number): Promise<number[]>;
    /** Take the meeting for this writer, or null when another has it or it is done. Counts an attempt. */
    claim(id: number, now: Date): Promise<ImportRow | null>;
    release(id: number, r: ImportRelease, now: Date): Promise<void>;
    /** The success latch: 'writing' → 'written'. False when this writer no longer held it. */
    markWritten(id: number, recordId: number, now: Date): Promise<boolean>;
}

// ── 1. Finding finished meetings ──────────────────────────────────────────────────────────────────

export interface DiscoverResult { accounts: number; found: number; errors: number }

export async function discoverMeetings(store: PickupStore, sources: readonly MeetingSource[], now: Date): Promise<DiscoverResult> {
    const out: DiscoverResult = { accounts: 0, found: 0, errors: 0 };
    for (const source of sources) {
        let accounts: PickupAccount[] = [];
        try { accounts = await source.accounts(); } catch (err) {
            out.errors++;
            console.error('[meeting-pickup] could not list accounts', { platform: source.platform, err: errText(err) });
            continue;
        }
        for (const account of accounts) {
            out.accounts++;
            const through = await store.checkedThrough(account.organisationId, source.platform);
            const since = checkWindowStart(through, now);
            try {
                const meetings = (await source.listFinished(account, since, now))
                    .filter((m) => m.externalId && m.endedAt instanceof Date && !Number.isNaN(m.endedAt.getTime()));
                const added = await store.addFound(account, meetings);
                out.found += added;
                await store.saveCheck(account.organisationId, source.platform, { at: now, through: now, found: added, error: null });
            } catch (err) {
                out.errors++;
                // The window is NOT moved on, so the next check covers this one again. A platform that has never been
                // checked successfully is pinned to this first window start, so a run of failures loses no meetings.
                await store.saveCheck(account.organisationId, source.platform, { at: now, through: through ? null : since, found: 0, error: errText(err).slice(0, 300) })
                    .catch(() => undefined);
                console.error('[meeting-pickup] check failed', { organisationId: account.organisationId, platform: source.platform, err: errText(err) });
            }
        }
    }
    return out;
}

// ── 2. Writing one meeting up ─────────────────────────────────────────────────────────────────────

export interface WriterDeps {
    store: PickupStore;
    sources: readonly MeetingSource[];
    now: () => Date;
    /** The Note Taker, when it is still active in that workspace; null otherwise. */
    assistant(organisationId: number, assistantId: number): Promise<MinutesAssistant | null>;
    /**
     * Room in the task allowance for one picked-up meeting (fails open, like all background work). A bot's meeting was
     * checked before the bot was sent, so its deps answer true.
     */
    hasCapacity(organisationId: number, row: ImportRow): Promise<boolean>;
    /** true when moderation blocks the text. */
    blocked(organisationId: number, text: string): Promise<boolean>;
    /** `row` says how the transcript reached us (a bot meeting gets its own channel block). */
    writeMinutes(organisationId: number, assistant: MinutesAssistant, message: string, row: ImportRow): Promise<WriteMinutesResult>;
    /**
     * Files the meeting in the Inbox; its id, or null when it could not be saved. When a meeting record already carries
     * this import's id (a writer that died between filing and the latch), returns that one instead of filing a second.
     */
    file(organisationId: number, assistantId: number, card: Record<string, unknown>, importId: number): Promise<number | null>;
    /**
     * The workspace's Note Taker bots around this call's time (any status), for botCover. Asked only for a picked-up
     * meeting, never a bot's own. Absent = no bots to check.
     */
    botsOnCall?(organisationId: number, row: ImportRow): Promise<BotOnCall[]>;
    /** Spends the task(s). Called once, after the latch. A bot's meeting is charged by its minutes in the call. */
    charge(organisationId: number, assistantId: number, importId: number, row: ImportRow): Promise<void>;
}

export type WriteOutcome =
    | 'not_claimed' | 'written' | 'lost_latch' | 'waiting_for_transcript' | 'waiting_for_tasks'
    | 'skipped_no_transcript' | 'skipped_nobody_spoke' | 'skipped_no_meeting' | 'skipped_task_limit' | 'skipped_assistant_gone'
    | 'skipped_disconnected' | 'skipped_blocked' | 'skipped_bot_joined' | 'waiting_for_bot' | 'retry' | 'failed';

export async function writeImport(importId: number, d: WriterDeps): Promise<WriteOutcome> {
    const now = d.now();
    const row = await d.store.claim(importId, now);
    if (!row) return 'not_claimed';

    const failOrRetry = async (message: string): Promise<WriteOutcome> => {
        if (row.attempts >= MAX_ATTEMPTS) {
            await d.store.release(row.id, { status: 'failed', lastError: message.slice(0, 300) }, d.now());
            return 'failed';
        }
        await d.store.release(row.id, { status: 'found', lastError: message.slice(0, 300), retryAt: new Date(d.now().getTime() + 15 * 60 * 1000) }, d.now());
        return 'retry';
    };

    try {
        const assistant = row.assistantId ? await d.assistant(row.organisationId, row.assistantId) : null;
        if (!assistant) {
            await d.store.release(row.id, { status: 'skipped', skipReason: 'assistant_gone' }, d.now());
            return 'skipped_assistant_gone';
        }
        const source = sourceFor(d.sources, row);
        const account = source ? await source.account(row.organisationId) : null;
        if (!source || !account) {
            await d.store.release(row.id, { status: 'skipped', skipReason: 'disconnected' }, d.now());
            return 'skipped_disconnected';
        }

        // The Note Taker's bot was in this call: its minutes are the ones kept (see botCover). Before the transcript is
        // read, so a covered call costs no platform look-ups.
        if ((row.via ?? 'transcript') === 'transcript' && d.botsOnCall) {
            const cover = botCover(row, await d.botsOnCall(row.organisationId, row), d.now());
            if (cover === 'covered') {
                await d.store.release(row.id, { status: 'skipped', skipReason: 'bot_joined' }, d.now());
                return 'skipped_bot_joined';
            }
            if (cover === 'wait') {
                await d.store.release(row.id, { status: 'found', retryAt: new Date(d.now().getTime() + BOT_WAIT_RETRY_MS), refundAttempt: true, lastError: null }, d.now());
                return 'waiting_for_bot';
            }
        }

        const transcript = await source.fetchTranscript(account, row.externalId, row.endedAt);
        const lines = transcript ? speakerLines(transcript.lines) : [];
        if (!lines.length) {
            // Finished and empty: waiting can't help, so say so now rather than show "writing" for a day.
            if (transcript?.finished === 'complete') {
                await d.store.release(row.id, { status: 'skipped', skipReason: 'nobody_spoke' }, d.now());
                return 'skipped_nobody_spoke';
            }
            if (transcript?.finished === 'failed') {
                await d.store.release(row.id, { status: 'skipped', skipReason: 'no_transcript' }, d.now());
                return 'skipped_no_transcript';
            }
            const retryAt = transcriptRetryAt(row.endedAt, d.now());
            if (!retryAt) {
                await d.store.release(row.id, { status: 'skipped', skipReason: 'no_transcript' }, d.now());
                return 'skipped_no_transcript';
            }
            // Not a failure: the platform just hasn't finished it. The attempt is given back.
            await d.store.release(row.id, { status: 'found', retryAt, refundAttempt: true, lastError: null }, d.now());
            return 'waiting_for_transcript';
        }

        // Check before, record after (background work spends tasks; fails open).
        if (!(await d.hasCapacity(row.organisationId, row))) {
            const age = d.now().getTime() - (row.endedAt ?? d.now()).getTime();
            if (age >= TASK_LIMIT_WAIT_MS) {
                await d.store.release(row.id, { status: 'skipped', skipReason: 'task_limit' }, d.now());
                return 'skipped_task_limit';
            }
            // Kept, not dropped: tried again every few hours, so it is written once the allowance resets or tasks are added.
            await d.store.release(row.id, {
                status: 'found', retryAt: new Date(d.now().getTime() + TASK_LIMIT_RETRY_MS), refundAttempt: true, lastError: 'task_limit',
            }, d.now());
            return 'waiting_for_tasks';
        }

        const message = pickupMessage({
            platform: row.platform, title: row.title, startedAt: row.startedAt, attendees: transcript?.attendees, lines,
        });
        if (await d.blocked(row.organisationId, message.slice(0, 20000))) {
            await d.store.release(row.id, { status: 'skipped', skipReason: 'blocked' }, d.now());
            return 'skipped_blocked';
        }

        const written = await d.writeMinutes(row.organisationId, assistant, message, row);
        if (!written.ok) {
            if (written.reason === 'no_meeting') {
                await d.store.release(row.id, { status: 'skipped', skipReason: 'no_meeting' }, d.now());
                return 'skipped_no_meeting';
            }
            return await failOrRetry('The write-up did not finish.');
        }

        const card = { ...(written.card as unknown as Record<string, unknown>), pickedUpFrom: pickedUpFrom(row.platform, row.id, row.link, row.startedAt, row.via) };
        const recordId = await d.file(row.organisationId, assistant.id, card, row.id);
        if (!recordId) return await failOrRetry('The minutes could not be saved.');

        // From here the meeting IS in the Inbox: never retry (that would file it twice) and never throw.
        let latched = false;
        try { latched = await d.store.markWritten(row.id, recordId, d.now()); } catch (err) {
            await d.store.release(row.id, { status: 'failed', lastError: `Filed as record ${recordId} but not marked written: ${errText(err)}`.slice(0, 300) }, d.now())
                .catch(() => undefined);
            return 'failed';
        }
        if (!latched) return 'lost_latch';
        await d.charge(row.organisationId, assistant.id, row.id, row);
        return 'written';
    } catch (err) {
        return await failOrRetry(errText(err));
    }
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
