// src/utils/mentor-commitments.ts
// Commitments and the end-of-week check (docs/business-mentor-plan.md §5.1, §2.5), over the
// mentor_commitments table (db/z-business-mentor-phase-3.sql).
//
//   - A person picks 1–3 things to do this week (MAX_PER_WEEK). Each has an OWNER: the person who set it.
//   - Closing one: done, missed or dropped. A missed one says why from a CLOSED list (MISS_REASONS, the
//     template_feedback approach); "other" needs a note. The reasons are what the Mentor learns from
//     (missReasonAdvice): repeated "no time" → fewer commitments or an assistant to take the work, and so on.
//   - Anyone in the workspace can see everyone's; each person sees their own first. Only the owner, or
//     the workspace's owner or an admin, can close one.
//
// One server action for both ways in: the Mentor's Results tab (src/components/mentor-commitments.js)
// and the chat's `mentor_commitments` card both POST netlify/functions/mentor.ts, which calls this.
// ⚠️ Tolerates the table being missing: reads return null ("not switched on yet"), writes refuse with 503.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { mentorCommitments, users } from '../../db/schema';

type Db = any;

export const MAX_PER_WEEK = 3;
export const TEXT_MAX = 200;
export const NOTE_MAX = 500;
/** How far back the Results tab and the Mentor look. */
export const HISTORY_WEEKS = 6;

export const MISS_REASONS = {
    no_time: 'No time',
    didnt_know_how: 'Didn’t know how',
    priorities_changed: 'Priorities changed',
    waiting_on_someone: 'Waiting on someone else',
    decided_against: 'Decided against it',
    other: 'Other',
} as const;
export type MissReason = keyof typeof MISS_REASONS;
export const isMissReason = (v: unknown): v is MissReason => typeof v === 'string' && Object.prototype.hasOwnProperty.call(MISS_REASONS, v);

export const CLOSE_STATUSES = ['done', 'missed', 'dropped'] as const;
export type CloseStatus = typeof CLOSE_STATUSES[number];
export const isCloseStatus = (v: unknown): v is CloseStatus => (CLOSE_STATUSES as readonly string[]).includes(String(v));

export interface Commitment {
    id: number;
    ownerUserId: number;
    ownerName: string;
    weekStart: string;
    text: string;
    status: 'open' | CloseStatus;
    missReason: MissReason | null;
    note: string | null;
    createdAt: string | null;
    closedAt: string | null;
}

export const NOT_READY = 'Commitments aren’t switched on for this workspace yet — please try again later.';

const missing = (err: any) => ['42P01', '42703'].includes(err?.code ?? err?.cause?.code);

/** Pure: Monday of the week an instant falls in, UK time, as YYYY-MM-DD. */
export function weekStartUk(at: Date = new Date()): string {
    const date = at.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const d = new Date(`${date}T12:00:00Z`);
    const back = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
}

/** Pure: the Monday `weeks` weeks before the given one. */
export function weeksBefore(weekStart: string, weeks: number): string {
    const d = new Date(`${weekStart}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * weeks);
    return d.toISOString().slice(0, 10);
}

/** Pure: the user's texts, trimmed, de-duplicated, 1 to MAX_PER_WEEK of them. */
export function cleanCommitmentTexts(raw: unknown): { ok: true; texts: string[] } | { ok: false; error: string } {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const seen = new Set<string>();
    const texts = list.flatMap((v) => {
        const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
        if (!t || seen.has(t.toLowerCase())) return [];
        seen.add(t.toLowerCase());
        return [t];
    });
    if (!texts.length) return { ok: false, error: 'Write what you’ll do this week.' };
    if (texts.length > MAX_PER_WEEK) return { ok: false, error: `Pick at most ${MAX_PER_WEEK} things for one week.` };
    const long = texts.find((t) => t.length > TEXT_MAX);
    if (long) return { ok: false, error: `Keep each one under ${TEXT_MAX} characters.` };
    return { ok: true, texts };
}

/** Pure: may this person close this commitment? Its owner, or whoever manages the workspace. */
export function canClose(row: { ownerUserId: number }, userId: number, role: string | null | undefined): boolean {
    return row.ownerUserId === userId || role === 'owner' || role === 'admin';
}

function toView(r: any): Commitment {
    const name = [r.firstName, r.lastName].filter((x: unknown) => typeof x === 'string' && x.trim()).join(' ').trim();
    return {
        id: r.id, ownerUserId: r.ownerUserId, ownerName: name || 'A team member',
        weekStart: typeof r.weekStart === 'string' ? r.weekStart.slice(0, 10) : new Date(r.weekStart).toISOString().slice(0, 10),
        text: r.text, status: r.status, missReason: isMissReason(r.missReason) ? r.missReason : null, note: r.note ?? null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null, closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
    };
}

/**
 * The workspace's commitments for the last HISTORY_WEEKS weeks, newest week first, the given user's own
 * first within a week. Names only — never an email address (§12.2). Null when the table isn't there yet.
 */
export async function loadCommitments(db: Db, orgId: number, userId: number | null, now = new Date()): Promise<Commitment[] | null> {
    try {
        const from = weeksBefore(weekStartUk(now), HISTORY_WEEKS - 1);
        const rows = await db.select({
            id: mentorCommitments.id, ownerUserId: mentorCommitments.ownerUserId, weekStart: sql<string>`${mentorCommitments.weekStart}::text`,
            text: mentorCommitments.text, status: mentorCommitments.status, missReason: mentorCommitments.missReason, note: mentorCommitments.note,
            createdAt: mentorCommitments.createdAt, closedAt: mentorCommitments.closedAt, firstName: users.firstName, lastName: users.lastName,
        }).from(mentorCommitments)
            .leftJoin(users, eq(users.id, mentorCommitments.ownerUserId))
            .where(and(eq(mentorCommitments.organisationId, orgId), gte(mentorCommitments.weekStart, from)))
            .orderBy(desc(mentorCommitments.weekStart), mentorCommitments.id)
            .limit(200);
        const list = rows.map(toView);
        // Within a week: the reader's own first (§2.5), then everyone else's in the order they were set.
        return list.sort((a: Commitment, b: Commitment) => (a.weekStart === b.weekStart
            ? Number(b.ownerUserId === userId) - Number(a.ownerUserId === userId) || a.id - b.id
            : b.weekStart.localeCompare(a.weekStart)));
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

export type CommitmentWrite = { ok: true; commitments: Commitment[] } | { ok: false; status: number; error: string };

/** "Add" on the Results tab and the chat card's "Save these": this week's commitments for the acting user. */
export async function addCommitments(db: Db, orgId: number, userId: number, raw: unknown, now = new Date()): Promise<CommitmentWrite> {
    const clean = cleanCommitmentTexts(raw);
    if (!clean.ok) return { ok: false, status: 400, error: clean.error };
    const week = weekStartUk(now);
    try {
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mentorCommitments).where(and(
            eq(mentorCommitments.organisationId, orgId), eq(mentorCommitments.ownerUserId, userId), eq(mentorCommitments.weekStart, week),
            inArray(mentorCommitments.status, ['open', 'done']),
        ));
        const room = MAX_PER_WEEK - Number(n);
        if (room <= 0) return { ok: false, status: 409, error: `You already have ${MAX_PER_WEEK} for this week. Close or drop one first.` };
        if (clean.texts.length > room) return { ok: false, status: 409, error: `You have room for ${room} more this week (at most ${MAX_PER_WEEK}).` };
        await db.insert(mentorCommitments).values(clean.texts.map((text) => ({
            organisationId: orgId, ownerUserId: userId, weekStart: week, text, createdBy: userId,
        })));
    } catch (err) {
        if (missing(err)) return { ok: false, status: 503, error: NOT_READY };
        throw err;
    }
    return { ok: true, commitments: (await loadCommitments(db, orgId, userId, now)) ?? [] };
}

/** "Done" / "Missed" (with a reason) / "Drop" — on the Results tab, or the chat's end-of-week card. */
export async function closeCommitment(db: Db, orgId: number, userId: number, role: string | null | undefined, args: {
    id: unknown; status: unknown; missReason?: unknown; note?: unknown;
}): Promise<CommitmentWrite> {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'Which commitment?' };
    if (!isCloseStatus(args.status)) return { ok: false, status: 400, error: 'Done, missed or dropped?' };
    const note = typeof args.note === 'string' ? args.note.trim().slice(0, NOTE_MAX) : '';
    if (args.status === 'missed') {
        if (!isMissReason(args.missReason)) return { ok: false, status: 400, error: 'Pick why it was missed.' };
        if (args.missReason === 'other' && !note) return { ok: false, status: 400, error: 'Say a few words about why.' };
    }
    try {
        const [row] = await db.select({ ownerUserId: mentorCommitments.ownerUserId, status: mentorCommitments.status }).from(mentorCommitments)
            .where(and(eq(mentorCommitments.id, id), eq(mentorCommitments.organisationId, orgId))).limit(1);
        if (!row) return { ok: false, status: 404, error: 'That commitment isn’t in this workspace.' };
        if (!canClose(row, userId, role)) return { ok: false, status: 403, error: 'Only the person who made it, or the workspace owner or an admin, can close it.' };
        await db.update(mentorCommitments).set({
            status: args.status, missReason: args.status === 'missed' ? args.missReason : null, note: note || null,
            closedAt: new Date(), closedBy: userId,
        }).where(and(eq(mentorCommitments.id, id), eq(mentorCommitments.organisationId, orgId)));
    } catch (err) {
        if (missing(err)) return { ok: false, status: 503, error: NOT_READY };
        throw err;
    }
    return { ok: true, commitments: (await loadCommitments(db, orgId, userId)) ?? [] };
}

/**
 * Pure: what the miss reasons say (§5.1) — a reason given at least twice in the window, as advice for
 * the Mentor. Never more than the two most frequent.
 */
export function missReasonAdvice(list: Commitment[]): string[] {
    const counts = new Map<MissReason, number>();
    for (const c of list) if (c.status === 'missed' && c.missReason) counts.set(c.missReason, (counts.get(c.missReason) ?? 0) + 1);
    const ADVICE: Record<MissReason, string> = {
        no_time: 'suggest fewer commitments, or an ACTIVE assistant that would take the work (or, with none, who they could hire)',
        didnt_know_how: 'offer a how-to or a smaller first step',
        priorities_changed: 'suggest revisiting the plan',
        waiting_on_someone: 'suggest commitments that depend on them alone',
        decided_against: 'ask whether the plan still holds',
        other: 'read their notes before suggesting anything',
    };
    return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([r, n]) => `"${MISS_REASONS[r]}" ${n} times — ${ADVICE[r]}.`);
}

/** Pure: the prompt's block — this week's and last week's commitments, and what the misses say. */
export function renderCommitmentsForMentor(list: Commitment[] | null, userId: number | null, now = new Date()): string[] {
    if (list === null) return ['COMMITMENTS: not switched on for this workspace yet — don\'t offer the commitments card.'];
    const week = weekStartUk(now);
    const last = weeksBefore(week, 1);
    const line = (c: Commitment) => `- #${c.id} ${c.ownerUserId === userId ? 'You' : c.ownerName}: "${c.text}" — ${c.status === 'missed' ? `missed (${c.missReason ? MISS_REASONS[c.missReason].toLowerCase() : 'no reason'}${c.note ? `: ${c.note.slice(0, 120)}` : ''})` : c.status}`;
    const thisWeek = list.filter((c) => c.weekStart === week);
    const lastWeek = list.filter((c) => c.weekStart === last);
    const lines = ['COMMITMENTS (what people said they would do; the same list is on your Results tab):'];
    lines.push(thisWeek.length ? `This week:\n${thisWeek.map(line).join('\n')}` : 'This week: none set yet.');
    if (lastWeek.length) lines.push(`Last week:\n${lastWeek.map(line).join('\n')}`);
    const stillOpen = lastWeek.filter((c) => c.status === 'open');
    if (stillOpen.length) lines.push(`Last week's still open: ask how each went (the mentor_commitments "close" card), one at a time.`);
    const advice = missReasonAdvice(list);
    if (advice.length) lines.push(`What the misses say (last ${HISTORY_WEEKS} weeks): ${advice.join(' ')}`);
    return lines;
}

/** The chat's end-of-week card for one commitment, rebuilt from its row (so the text and owner are real). */
export async function closeCommitmentCard(db: Db, orgId: number, userId: number, id: number, summary: string): Promise<
    { type: 'mentor_commitments'; op: 'close'; summary: string; commitmentId: number; text: string; ownerName: string; mine: boolean; weekStart: string } | { error: string }> {
    const list = await loadCommitments(db, orgId, userId).catch(() => null);
    if (list === null) return { error: NOT_READY };
    const c = list.find((x) => x.id === id);
    if (!c) return { error: 'That commitment isn’t on the list.' };
    if (c.status !== 'open') return { error: `That one is already marked ${c.status}.` };
    return { type: 'mentor_commitments', op: 'close', summary: summary || 'How did this one go?', commitmentId: c.id, text: c.text, ownerName: c.ownerName, mine: c.ownerUserId === userId, weekStart: c.weekStart };
}
