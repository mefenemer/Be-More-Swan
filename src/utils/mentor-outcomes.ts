// src/utils/mentor-outcomes.ts
// "What changed since your Mentor's suggestion" — the track record (docs/business-mentor-plan.md §5.3),
// over the mentor_outcomes table (db/z-business-mentor-phase-3.sql).
//
//   - Every accepted suggestion is remembered when it is accepted (recordOutcome, from mentor.ts
//     `decide`): what changed, when, which assistant, the measure it was meant to move and its value then.
//   - Each weekly review fills in the value now (checkOutcomes) and reports it with sinceLine().
//   - It says "since", never "because": the Mentor can't separate its suggestion from everything else
//     that happened. Too early (under a week) or too small (MIN_SAMPLE) is said plainly, never as a trend.
//   - A draft the Mentor asked for is linked here by its job id (linkOutcomeJob, from generate-post.ts),
//     which is how the post carries a "Requested by <Mentor>" pill (src/utils/requested-by.ts).
//
// Screens: the Track record panel on the Mentor's Overview tab (mentor.ts), the weekly review, and the
// Mentor's prompt. Never throws on a missing table.

import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { aiAssistants, goals, mentorOutcomes, mentorProposals } from '../../db/schema';
import { countRoiActivity } from './roi-activity';

type Db = any;

/** Below this many items across before and after, a work count is too small to judge. */
export const MIN_SAMPLE = 5;
/** The value is read again no sooner than this after the change. */
export const CHECK_AFTER_DAYS = 7;
/** Outcomes older than this are no longer followed. */
export const FOLLOW_DAYS = 90;

const DAY = 86_400_000;
const missing = (err: any) => ['42P01', '42703'].includes(err?.code ?? err?.cause?.code);

export type Verdict = 'too_early' | 'too_small' | 'up' | 'down' | 'same' | 'no_measure' | 'drafted';

export interface TrackRecordItem {
    id: number;
    proposalId: number;
    title: string;
    kind: string;
    target: string | null;
    acceptedAt: string;
    /** When the suggestion was first shown — "suggested 20 Oct, accepted yesterday" explains why an
     *  earlier week's suggestions don't count in this week's 3. Null for an outcome without a proposal row. */
    suggestedAt?: string | null;
    measureLabel: string | null;
    before: number | null;
    after: number | null;
    verdict: Verdict;
    line: string;
}

/** Pure: what a measure's movement says, held to the minimum-sample rule. */
export function verdictFor(o: { measureKey: string | null; before: number | null; after: number | null; acceptedAt: Date; checkedAt: Date | null; jobId?: string | null }, now: Date): Verdict {
    if (!o.measureKey) return o.jobId ? 'drafted' : 'no_measure';
    if (now.getTime() - o.acceptedAt.getTime() < CHECK_AFTER_DAYS * DAY || o.after === null || o.before === null) return 'too_early';
    if (o.measureKey.startsWith('work7:') && o.before + o.after < MIN_SAMPLE) return 'too_small';
    if (o.after > o.before) return 'up';
    if (o.after < o.before) return 'down';
    return 'same';
}

const ago = (from: Date, now: Date) => {
    const days = Math.max(0, Math.round((now.getTime() - from.getTime()) / DAY));
    if (days < 1) return 'today';
    if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
    return `${Math.round(days / 7)} weeks ago`;
};
const ukDay = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Pure: one line of the track record. "Since", never "because". */
export function sinceLine(o: { title: string; measureLabel: string | null; before: number | null; after: number | null; acceptedAt: Date; suggestedAt?: Date | null }, verdict: Verdict, now: Date): string {
    const suggested = o.suggestedAt && ukDay(o.suggestedAt) !== ukDay(o.acceptedAt) ? `suggested ${ukDay(o.suggestedAt)}, ` : '';
    const head = `${o.title} — ${suggested}accepted ${ago(o.acceptedAt, now)}.`;
    switch (verdict) {
        case 'no_measure': return `${head} No figure to follow for this one.`;
        case 'drafted': return `${head} The draft is with the assistant for your review.`;
        case 'too_early': return `${head} Too early to tell.`;
        case 'too_small': return `${head} ${o.measureLabel}: ${num(o.before!)} then, ${num(o.after!)} now — too little activity to judge yet.`;
        case 'same': return `${head} ${o.measureLabel}: ${num(o.before!)} then, ${num(o.after!)} now — no change since.`;
        default: {
            const diff = o.after! - o.before!;
            const pct = o.before! > 0 ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / o.before!) * 100)}%)` : '';
            return `${head} ${o.measureLabel}: ${num(o.before!)} then, ${num(o.after!)} now — ${verdict === 'up' ? 'up' : 'down'} ${num(Math.abs(diff))}${pct} since. That may not be down to this change alone.`;
        }
    }
}

/** The measure a change to this assistant is meant to move, and its value now: its primary goal, else its week's work. */
export async function measureNow(db: Db, orgId: number, assistantId: number, measureKey?: string | null): Promise<{ key: string; label: string; value: number | null } | null> {
    if (measureKey?.startsWith('goal:') || !measureKey) {
        const goalId = measureKey ? Number(measureKey.slice(5)) : null;
        const [g] = await db.select({ id: goals.id, title: goals.title, metricKey: goals.metricKey, latest: goals.latestValue }).from(goals)
            .where(and(eq(goals.organisationId, orgId), eq(goals.assistantId, assistantId), goalId ? eq(goals.id, goalId) : eq(goals.isActive, true)))
            .orderBy(desc(goals.isPrimary), desc(goals.createdAt)).limit(1);
        if (g) return { key: `goal:${g.id}`, label: g.title || String(g.metricKey).replace(/_/g, ' '), value: g.latest === null || g.latest === undefined ? null : Number(g.latest) };
        if (measureKey) return null;
    }
    const [a] = await db.select({ name: aiAssistants.name }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!a) return null;
    const act = await countRoiActivity(db, { organisationId: orgId, assistantIds: [assistantId], windowStart: new Date(Date.now() - 7 * DAY) });
    return { key: `work7:${assistantId}`, label: `Work done by ${a.name || 'the assistant'} in a week`, value: act.degraded ? null : act.completedTasks };
}

/** Remember an accepted suggestion (mentor.ts `decide` → accepted). Idempotent; never throws. */
export async function recordOutcome(db: Db, orgId: number, proposalId: number): Promise<void> {
    try {
        const [p] = await db.select({ kind: mentorProposals.kind, title: mentorProposals.title, target: mentorProposals.targetAssistantId, payload: mentorProposals.payload })
            .from(mentorProposals).where(and(eq(mentorProposals.id, proposalId), eq(mentorProposals.organisationId, orgId), eq(mentorProposals.status, 'accepted'))).limit(1);
        if (!p) return;
        const targetId = p.target ?? (Number((p.payload as any)?.assistantId) || null);
        // A draft request has no figure: its result is the draft itself, linked by job id.
        const m = targetId && p.kind !== 'draft_request' ? await measureNow(db, orgId, targetId).catch(() => null) : null;
        await db.insert(mentorOutcomes).values({
            organisationId: orgId, proposalId, targetAssistantId: targetId, kind: p.kind, change: String(p.title).slice(0, 300),
            measureKey: m?.key ?? null, measureLabel: m?.label ?? null, beforeValue: m?.value === null || m?.value === undefined ? null : String(m.value),
        }).onConflictDoNothing();
    } catch (err) {
        if (!missing(err)) console.warn('[mentor-outcomes] could not record (non-blocking):', (err as Error)?.message);
    }
}

/**
 * A draft the Mentor asked for (generate-post.ts, when the click came from its draft-request card): link
 * the job so the post shows "Requested by <Mentor>". Only an ACCEPTED suggestion of this workspace. Never throws.
 */
export async function linkOutcomeJob(db: Db, orgId: number, proposalId: unknown, jobId: string): Promise<boolean> {
    const id = Number(proposalId);
    if (!Number.isInteger(id) || id <= 0 || !jobId) return false;
    try {
        const [p] = await db.select({ kind: mentorProposals.kind, title: mentorProposals.title, target: mentorProposals.targetAssistantId })
            .from(mentorProposals).where(and(eq(mentorProposals.id, id), eq(mentorProposals.organisationId, orgId), eq(mentorProposals.kind, 'draft_request'))).limit(1);
        if (!p) return false;
        await db.insert(mentorOutcomes).values({
            organisationId: orgId, proposalId: id, targetAssistantId: p.target, kind: p.kind, change: String(p.title).slice(0, 300), jobId,
        }).onConflictDoUpdate({ target: mentorOutcomes.proposalId, set: { jobId } });
        return true;
    } catch (err) {
        if (!missing(err)) console.warn('[mentor-outcomes] could not link the draft (non-blocking):', (err as Error)?.message);
        return false;
    }
}

/** Read each followed measure again, once it has had a week (the weekly review). Never throws. */
export async function checkOutcomes(db: Db, orgId: number, now = new Date()): Promise<number> {
    try {
        const rows = await db.select({ id: mentorOutcomes.id, target: mentorOutcomes.targetAssistantId, measureKey: mentorOutcomes.measureKey })
            .from(mentorOutcomes).where(and(
                eq(mentorOutcomes.organisationId, orgId),
                sql`${mentorOutcomes.measureKey} IS NOT NULL`,
                lte(mentorOutcomes.acceptedAt, new Date(now.getTime() - CHECK_AFTER_DAYS * DAY)),
                gte(mentorOutcomes.acceptedAt, new Date(now.getTime() - FOLLOW_DAYS * DAY)),
                or(isNull(mentorOutcomes.checkedAt), lte(mentorOutcomes.checkedAt, new Date(now.getTime() - DAY))),
            )).limit(30);
        let n = 0;
        for (const r of rows) {
            if (!r.target) continue;
            const m = await measureNow(db, orgId, r.target, r.measureKey).catch(() => null);
            if (!m || m.value === null) continue;
            await db.update(mentorOutcomes).set({ afterValue: String(m.value), checkedAt: now }).where(and(eq(mentorOutcomes.id, r.id), eq(mentorOutcomes.organisationId, orgId)));
            n++;
        }
        return n;
    } catch (err) {
        if (!missing(err)) console.warn('[mentor-outcomes] check failed (non-blocking):', (err as Error)?.message);
        return 0;
    }
}

/** The Track record panel and the review's "since" lines, newest first. Null when the table isn't there. */
export async function loadTrackRecord(db: Db, orgId: number, now = new Date(), limit = 20): Promise<TrackRecordItem[] | null> {
    try {
        const rows = await db.select({
            id: mentorOutcomes.id, proposalId: mentorOutcomes.proposalId, kind: mentorOutcomes.kind, change: mentorOutcomes.change,
            measureKey: mentorOutcomes.measureKey, measureLabel: mentorOutcomes.measureLabel, before: mentorOutcomes.beforeValue, after: mentorOutcomes.afterValue,
            acceptedAt: mentorOutcomes.acceptedAt, checkedAt: mentorOutcomes.checkedAt, jobId: mentorOutcomes.jobId, target: aiAssistants.name,
            suggestedAt: mentorProposals.shownAt,
        }).from(mentorOutcomes)
            .leftJoin(aiAssistants, eq(aiAssistants.id, mentorOutcomes.targetAssistantId))
            .leftJoin(mentorProposals, eq(mentorProposals.id, mentorOutcomes.proposalId))
            .where(eq(mentorOutcomes.organisationId, orgId))
            .orderBy(desc(mentorOutcomes.acceptedAt)).limit(limit);
        return rows.map((r: any) => {
            const o = {
                title: r.change, measureKey: r.measureKey, measureLabel: r.measureLabel,
                before: r.before === null ? null : Number(r.before), after: r.after === null ? null : Number(r.after),
                acceptedAt: new Date(r.acceptedAt), checkedAt: r.checkedAt ? new Date(r.checkedAt) : null, jobId: r.jobId,
                suggestedAt: r.suggestedAt ? new Date(r.suggestedAt) : null,
            };
            const verdict = verdictFor(o, now);
            return {
                id: r.id, proposalId: r.proposalId, title: r.change, kind: r.kind, target: r.target ?? null, acceptedAt: o.acceptedAt.toISOString(),
                suggestedAt: o.suggestedAt ? o.suggestedAt.toISOString() : null, measureLabel: r.measureLabel ?? null, before: o.before, after: o.after, verdict, line: sinceLine(o, verdict, now),
            };
        });
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

/** Pure: the prompt's block. */
export function renderTrackRecordForMentor(items: TrackRecordItem[] | null): string[] {
    if (!items?.length) return [];
    return ['YOUR TRACK RECORD (suggestions they accepted, and what happened SINCE — say "since", never "because"; too early or too small means say so):',
        ...items.slice(0, 8).map((i) => `- ${i.line}`)];
}
