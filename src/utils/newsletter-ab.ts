// src/utils/newsletter-ab.ts
// Two subject lines, a sample, and the winner to everyone else.
//
// ── Three properties, each of which is a decision ───────────────────────────────────────────────
//
// 1. NO NEW SCHEDULE. Everything here is called from sendDueIssues, the sweep that already ticks
//    every few minutes and already holds a sending issue open. ⚠️ An A/B decider on a cron of its
//    own would be a single point of failure whose failure mode is "80% of the list never receives
//    the issue" — and two nightly sweeps in this codebase have never run once. If sending works,
//    deciding works.
//
// 2. IT ALWAYS DECIDES. There is no path that leaves an issue half-sent: a tie decides, no opens at
//    all decides, an issue that could not measure opens decides. The fallback is always variant A,
//    the subject the human wrote first, and the reason is written to ab_note in words they can read.
//
// 3. IT NEVER CLAIMS MORE THAN IT KNOWS. Opens are a trend, not a measurement (Apple Mail
//    pre-fetches the pixel), and a four-open lead on a sample of ninety is noise. So a small margin
//    is reported as "too close to call" and the tenant is told we sent the first subject, rather
//    than being handed a winner they would reasonably act on next month.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { newsletterIssues, newsletterSends } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export type AbState = 'off' | 'testing' | 'decided';
export type AbVariant = 'A' | 'B';

/**
 * The margin at which we are willing to call a winner.
 *
 * ⚠️ A RULE OF THUMB, AND SAID TO BE ONE. It is not a significance test and must never be described
 * as one: opens are inflated for some recipients and invisible for others, so the input is not
 * clean enough for statistics to mean what they would appear to mean. What this does is refuse to
 * dress up a small difference as a finding.
 */
export const MIN_LEAD_OPENS = 3;
export const MIN_LEAD_RATIO = 1.2;

export interface AbDecision {
    winner: AbVariant;
    note: string;
    openedA: number;
    openedB: number;
}

/**
 * Which subject won, and what to tell the tenant about it.
 *
 * Pure, so the rule can be read and tested without a database — the input is two numbers and
 * whether opens were measurable at all.
 */
export function decideWinner(args: {
    openedA: number; openedB: number; sentA: number; sentB: number; engagementTracked: boolean;
}): AbDecision {
    const { openedA, openedB, sentA, sentB } = args;
    const base = { openedA, openedB };

    if (!args.engagementTracked) {
        return {
            ...base,
            winner: 'A',
            note: 'This issue was sent from a connected mailbox, which cannot report opens, so there was nothing to compare. Everyone else was sent the first subject line.',
        };
    }
    if (!openedA && !openedB) {
        return {
            ...base,
            winner: 'A',
            note: 'Nobody in the sample opened either version, so there was nothing to choose between. Everyone else was sent the first subject line.',
        };
    }

    const [high, low] = openedA >= openedB ? [openedA, openedB] : [openedB, openedA];
    const leader: AbVariant = openedA >= openedB ? 'A' : 'B';
    const clear = (high - low) >= MIN_LEAD_OPENS && (low === 0 || high / low >= MIN_LEAD_RATIO);

    if (!clear) {
        return {
            ...base,
            winner: 'A',
            note: `Too close to call — ${openedA} opened the first subject and ${openedB} the second, out of ${sentA + sentB} sampled. `
                + 'A difference that small is noise rather than a result, so everyone else was sent the first subject line.',
        };
    }
    return {
        ...base,
        winner: leader,
        note: `Subject ${leader} won: ${openedA} opened the first and ${openedB} the second, out of ${sentA + sentB} sampled. `
            + 'Everyone held back was sent the winner.',
    };
}

/**
 * Split the materialised recipients into a sample and a remainder, once.
 *
 * ⚠️ Runs only when NO row carries a variant yet. Re-running would re-cut the split under an issue
 * that is already part-way sent, which is how somebody receives both subject lines.
 *
 * The remainder is HELD rather than left uncreated: the audience is frozen at approval, so the
 * recipient count cannot jump mid-send and a list edited between the sample and the winner cannot
 * change who the test was run on.
 */
export async function prepareAbSample(
    db: Db,
    issue: { id: number; organisationId: number; abSamplePercent: number },
): Promise<{ sampled: number; held: number } | null> {
    const [already] = await db
        .select({ id: newsletterSends.id })
        .from(newsletterSends)
        .where(and(eq(newsletterSends.issueId, issue.id), isNotNull(newsletterSends.variant)))
        .limit(1);
    if (already) return null;

    const rows = await db
        .select({ id: newsletterSends.id })
        .from(newsletterSends)
        .where(and(eq(newsletterSends.issueId, issue.id), eq(newsletterSends.status, 'queued')))
        .orderBy(newsletterSends.id);
    if (!rows.length) return null;

    const sampleSize = Math.max(2, Math.floor((rows.length * issue.abSamplePercent) / 100));
    // A list too small to hold back anybody is not a sample — it is the whole audience, split in
    // two. That is still a legitimate test (the tenant learns which subject worked); there is just
    // no winner to send on afterwards, and the note at decision time says so.
    const sample = rows.slice(0, Math.min(sampleSize, rows.length));
    const held = rows.slice(sample.length);

    // Interleaved rather than halved: ids are creation order, which is contact order, which
    // correlates with when somebody subscribed. Giving the first half of the list one subject and
    // the second half the other would compare two different audiences.
    const groupA = sample.filter((_, i) => i % 2 === 0).map((r) => r.id);
    const groupB = sample.filter((_, i) => i % 2 === 1).map((r) => r.id);

    const CHUNK = 500;
    for (const [variant, ids] of [['A', groupA], ['B', groupB]] as const) {
        for (let i = 0; i < ids.length; i += CHUNK) {
            await db.update(newsletterSends)
                .set({ variant, updatedAt: new Date() })
                .where(inArray(newsletterSends.id, ids.slice(i, i + CHUNK)));
        }
    }
    for (let i = 0; i < held.length; i += CHUNK) {
        await db.update(newsletterSends)
            .set({ status: 'held', updatedAt: new Date() })
            .where(inArray(newsletterSends.id, held.slice(i, i + CHUNK).map((r) => r.id)));
    }

    return { sampled: sample.length, held: held.length };
}

/** Unique opens per variant. count of ROWS with an opened_at, which is people, not events. */
export async function sampleResults(
    db: Db,
    issueId: number,
): Promise<{ openedA: number; openedB: number; sentA: number; sentB: number }> {
    const rows = await db
        .select({
            variant: newsletterSends.variant,
            sent: sql<number>`count(*)::int`,
            opened: sql<number>`count(${newsletterSends.openedAt})::int`,
        })
        .from(newsletterSends)
        .where(and(eq(newsletterSends.issueId, issueId), isNotNull(newsletterSends.variant)))
        .groupBy(newsletterSends.variant);

    const get = (v: AbVariant) => rows.find((r) => r.variant === v);
    return {
        openedA: Number(get('A')?.opened ?? 0),
        openedB: Number(get('B')?.opened ?? 0),
        sentA: Number(get('A')?.sent ?? 0),
        sentB: Number(get('B')?.sent ?? 0),
    };
}

/**
 * Decide the test and release the remainder, if it is time.
 *
 * Returns null when there is nothing to do yet. Called on every tick of the send sweep for an issue
 * whose sample has gone out.
 */
export async function decideAndRelease(
    db: Db,
    issue: {
        id: number; organisationId: number; abSampleSentAt: Date | null;
        abDecideAfterHours: number; engagementTracked: boolean;
    },
    now = new Date(),
): Promise<{ decision: AbDecision; released: number } | null> {
    if (!issue.abSampleSentAt) return null;
    const due = issue.abSampleSentAt.getTime() + issue.abDecideAfterHours * 60 * 60 * 1000;
    if (now.getTime() < due) return null;

    const results = await sampleResults(db, issue.id);
    const decision = decideWinner({ ...results, engagementTracked: issue.engagementTracked });

    // ⚠️ The winner is STAMPED onto the held rows, not left to be inferred at send time from the
    // issue. A record of what somebody was sent has to survive the issue being edited afterwards.
    const released = await db.update(newsletterSends)
        .set({ status: 'queued', variant: decision.winner, updatedAt: now })
        .where(and(eq(newsletterSends.issueId, issue.id), eq(newsletterSends.status, 'held')))
        .returning({ id: newsletterSends.id });

    await db.update(newsletterIssues).set({
        abState: 'decided',
        abWinner: decision.winner,
        abDecidedAt: now,
        abNote: released.length
            ? decision.note
            : `${decision.note} Everyone was in the sample, so there was nobody left to send the winner to.`,
        updatedAt: now,
    }).where(eq(newsletterIssues.id, issue.id));

    return { decision, released: released.length };
}
