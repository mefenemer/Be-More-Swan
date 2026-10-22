// src/utils/chat-schedule.ts
// The posting schedule — how often, which days, what times, which timezone — as the chat sees it, and
// a card to change it, for the roles whose Assistant Profile shows the Posting Schedule card (the
// Social Media and Blog Writer assistants; Email Marketing's cadence lives in its setup answers).
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. "Post on Tuesdays and Thursdays at 8am instead" could only be done in the Posting Schedule
// card; the chat could only say where it was.
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Same contract as the other confirm cards. The model proposes a `schedule_proposal` with only what
// changes; this module normalises it with posting-cadence.ts's own vocabulary (weekday keys, HH:MM
// times, the frequency labels the dropdown stores, a real IANA timezone) and rebuilds the card from the
// assistant's stored context. The card carries ONLY the keys that change (`set`).
//
// The click (chat-session.js) saves through update-assistant-context.ts, the endpoint the Posting
// Schedule card autosaves through. That endpoint REPLACES onboarding_context wholesale, so the click
// reads the assistant's current context (get-assistant-context) at the moment of the click, changes only
// the keys in `set`, and sends the whole thing back — never a copy taken when the card was drawn, which
// could undo an edit made on the page in between. The endpoint then tops the queue up from the new
// schedule, as it does for a page edit. Nothing here writes.
//
// ⚠️ Never throws.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { POSTING_CADENCES, WEEKDAY_KEYS, normaliseTime, resolvePostingSchedule, type WeekdayKey } from '../config/posting-cadence';
import { settingsForRole } from './chat-assistant-settings';

type Db = ReturnType<typeof getDb>;

export const SCHEDULE_PROPOSAL_TYPE = 'schedule_proposal';
/** Most posting times a day the card accepts. */
const MAX_TIMES = 6;

/** The roles with the Posting Schedule card — the same card that holds "Generate posts ahead". */
export function hasPostingSchedule(roleKey: string | null | undefined): boolean {
    return settingsForRole(roleKey).includes('draft_horizon');
}

const DAY_ORDER: WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAME: Record<WeekdayKey, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export interface Schedule { frequency: string; days: WeekdayKey[]; times: string[]; timezone: string }
/** The onboarding_context keys the Posting Schedule card writes. */
export interface ScheduleSet { posting_frequency?: string; posting_days?: WeekdayKey[]; posting_times?: string[]; posting_timezone?: string }

export function describeSchedule(s: Schedule): string {
    const days = s.days.length === 7 ? 'every day' : s.days.map((d) => DAY_NAME[d]).join(', ');
    return `${s.frequency} · ${days} · at ${s.times.join(', ')} · ${s.timezone.replace(/_/g, ' ')}`;
}

function currentSchedule(ctx: unknown): Schedule {
    const s = resolvePostingSchedule(ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx as Record<string, unknown> : null);
    const days = [...s.days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    return { frequency: s.frequency, days, times: [...s.times].sort(), timezone: s.timezone };
}

export function isTimezone(tz: string): boolean {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

/** The schedule block for this turn's prompt (sync: the context is already loaded). Null for other roles. */
export function schedulePromptBlock(roleKey: string | null | undefined, onboardingContext: unknown): string | null {
    if (!hasPostingSchedule(roleKey)) return null;
    const s = currentSchedule(onboardingContext);
    return `YOUR POSTING SCHEDULE (Assistant Profile ▸ When and how I ${roleKey === 'blog_writer' ? 'work' : 'post'} ▸ Posting Schedule), right now: ${describeSchedule(s)}.
CHANGING IT — when the user asks to post more or less often, on other days, at other times, or in another timezone, put this in "uiElement" instead of anything else, with ONLY the parts that change:
{ "type": "schedule_proposal", "frequency": ${POSTING_CADENCES.map((c) => `"${c.label}"`).join(' | ')}, "days": ["mon" … "sun"], "times": ["HH:MM", …], "timezone": "<IANA name, e.g. Europe/London>" }
Times are 24-hour, in the schedule's timezone; at most ${MAX_TIMES} a day. "days" is the full new list of days, not the ones to add. If the frequency and the days would disagree (3 times a week on 5 days), say which it will follow. You never change it yourself: the user confirms on the card, and only that click saves it. So never say the schedule HAS changed — say the card is there to confirm.`;
}

// ── Propose ──────────────────────────────────────────────────────────────────────────────────────

export interface ScheduleRequest { frequency?: string; days?: WeekdayKey[]; times?: string[]; timezone?: string; invalid: string[] }

/** Shape check + normalisation. Pure. Null when it is not a schedule proposal or names nothing. */
export function scheduleProposalFromUiElement(uiElement: unknown): ScheduleRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== SCHEDULE_PROPOSAL_TYPE) return null;
    const req: ScheduleRequest = { invalid: [] };
    if (ui.frequency != null) {
        const f = String(ui.frequency).trim().toLowerCase();
        const c = POSTING_CADENCES.find((x) => x.key === f || x.label.toLowerCase() === f);
        if (c) req.frequency = c.label; else req.invalid.push(`“${String(ui.frequency)}” isn’t one of the frequencies`);
    }
    if (Array.isArray(ui.days)) {
        const days = ui.days.map((d) => String(d).trim().toLowerCase().slice(0, 3))
            .filter((d): d is WeekdayKey => (WEEKDAY_KEYS as readonly string[]).includes(d));
        if (days.length) req.days = [...new Set(days)].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
        else req.invalid.push('there has to be at least one day');
    }
    if (Array.isArray(ui.times)) {
        const times = ui.times.map((t) => normaliseTime(t)).filter((t): t is string => t !== null);
        if (!times.length) req.invalid.push('the times have to be like 09:00 or 17:30');
        else if (new Set(times).size > MAX_TIMES) req.invalid.push(`at most ${MAX_TIMES} times a day`);
        else req.times = [...new Set(times)].sort();
    }
    if (ui.timezone != null) {
        const tz = String(ui.timezone).trim();
        if (isTimezone(tz)) req.timezone = tz; else req.invalid.push(`“${tz}” isn’t a timezone`);
    }
    if (!req.frequency && !req.days && !req.times && !req.timezone && !req.invalid.length) return null;
    return req;
}

export interface ScheduleCard {
    type: typeof SCHEDULE_PROPOSAL_TYPE;
    assistantId: number;
    current: string;
    proposed: string;
    /** Only the onboarding_context keys that change — what the click merges in. */
    set: ScheduleSet;
    blocked: string | null;
    settled?: boolean;
}

function buildScheduleCard(aiAssistantId: number, roleKey: string | null | undefined, ctx: unknown, req: ScheduleRequest): ScheduleCard {
    const cur = currentSchedule(ctx);
    const next: Schedule = {
        frequency: req.frequency ?? cur.frequency, days: req.days ?? cur.days, times: req.times ?? cur.times, timezone: req.timezone ?? cur.timezone,
    };
    const set: ScheduleSet = {};
    if (next.frequency !== cur.frequency) set.posting_frequency = next.frequency;
    if (next.days.join() !== cur.days.join()) set.posting_days = next.days;
    if (next.times.join() !== cur.times.join()) set.posting_times = next.times;
    if (next.timezone !== cur.timezone) set.posting_timezone = next.timezone;
    const card: ScheduleCard = {
        type: SCHEDULE_PROPOSAL_TYPE, assistantId: aiAssistantId,
        current: describeSchedule(cur), proposed: describeSchedule(next), set, blocked: null,
    };
    if (!hasPostingSchedule(roleKey)) card.blocked = 'This assistant doesn’t have a posting schedule.';
    else if (req.invalid.length) card.blocked = `That can’t be saved: ${req.invalid.join('; ')}.`;
    else if (!Object.keys(set).length) card.blocked = 'The schedule already says exactly that.';
    return card;
}

async function readContext(db: Db, organisationId: number, aiAssistantId: number): Promise<{ ctx: unknown } | null> {
    const [row] = await db.select({ ctx: aiAssistants.onboardingContext }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, aiAssistantId), eq(aiAssistants.organisationId, organisationId))).limit(1);
    return row ? { ctx: row.ctx } : null;
}

/** Check a proposal against the stored schedule and return the card. Null when the read fails. */
export async function resolveScheduleProposal(
    db: Db, organisationId: number, aiAssistantId: number, roleKey: string | null | undefined, req: ScheduleRequest,
): Promise<ScheduleCard | null> {
    try {
        const row = await readContext(db, organisationId, aiAssistantId);
        return row ? buildScheduleCard(aiAssistantId, roleKey, row.ctx, req) : null;
    } catch (err) {
        console.error('[chat-schedule] could not resolve the proposal (non-fatal)', err);
        return null;
    }
}

/** A stored card closes once the schedule already holds everything in `set`. */
export async function refreshScheduleCards<M extends { uiElement: unknown }>(
    db: Db, organisationId: number, aiAssistantId: number, messages: M[],
): Promise<M[]> {
    if (!messages.some((m) => (m.uiElement as { type?: unknown } | null)?.type === SCHEDULE_PROPOSAL_TYPE)) return messages;
    let row: { ctx: unknown } | null;
    try { row = await readContext(db, organisationId, aiAssistantId); }
    catch (err) {
        console.error('[chat-schedule] could not refresh stored cards (non-fatal)', err);
        return messages;
    }
    const cur = currentSchedule(row?.ctx);
    return messages.map((m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || ui.type !== SCHEDULE_PROPOSAL_TYPE || ui.settled || ui.blocked) return m;
        const set = (ui.set ?? {}) as ScheduleSet;
        const done = (set.posting_frequency == null || set.posting_frequency === cur.frequency)
            && (set.posting_days == null || set.posting_days.join() === cur.days.join())
            && (set.posting_times == null || set.posting_times.join() === cur.times.join())
            && (set.posting_timezone == null || set.posting_timezone === cur.timezone);
        return done ? { ...m, uiElement: { ...ui, current: describeSchedule(cur), settled: true, blocked: 'Already done — the schedule says this now.' } } : m;
    });
}
