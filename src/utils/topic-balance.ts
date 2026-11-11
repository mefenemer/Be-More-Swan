// src/utils/topic-balance.ts
// Which topic the next Blog post or Email is written under (docs/pillar-records-plan.md §7, phase 3a).
// The same rule a Social assistant's pillars use (process-content-jobs.ts): count each topic over the
// recent drafts, by pillar_id where the draft has one (a rename keeps its count) and by name otherwise,
// then pickPillarForSlot walks the least-used ones, so every topic gets its turn and next-door drafts differ.
//
// Before this, the Blog Writer was handed the whole topic text ("pick one of these") and one topic could
// win every post, and every autopilot email was "about" the entire list.

import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPosts, newsletterIssues } from '../../db/schema';
import { loadDraftPillars, type DraftPillar } from './content-pillars-store';
import { pickPillarForSlot } from './draft-variety';

type Db = ReturnType<typeof getDb>;

export interface TopicChoice {
    /** The topic for THIS draft, or null when the assistant has no topics. */
    chosen: DraftPillar | null;
    /** Every active topic, in order (the chosen one included). */
    all: DraftPillar[];
}

/** Pure: the per-topic counts, matched the way the Social path matches them. */
export function countsForTopics(topics: DraftPillar[], used: { pillarId: number | null; pillar: string | null; n: number }[]): number[] {
    return topics.map((t) => used
        .filter((u) => (t.id !== null && u.pillarId === t.id) || (u.pillarId === null && u.pillar === t.name))
        .reduce((n, u) => n + u.n, 0));
}

/**
 * The topic for the next draft of a Blog (`blog_posts`) or Email (`newsletter_issues`) assistant.
 * Never throws: a failed count falls back to plain rotation by day.
 */
export async function pickBalancedTopic(db: Db, args: {
    organisationId: number;
    assistantId: number;
    onboardingContext: unknown;
    table: 'blog_posts' | 'newsletter_issues';
    days: number;
    slot?: Date | string | null;
}): Promise<TopicChoice> {
    let all: DraftPillar[] = [];
    try {
        all = await loadDraftPillars(db, args.organisationId, args.assistantId, args.onboardingContext);
    } catch (err) {
        console.warn('[topic-balance] topics unavailable:', (err as Error)?.message);
        return { chosen: null, all: [] };
    }
    if (!all.length) return { chosen: null, all };

    const t = args.table === 'blog_posts' ? blogPosts : newsletterIssues;
    let counts: number[] | null = null;
    try {
        const used = await db
            .select({ pillarId: t.pillarId, pillar: t.pillar, n: sql<number>`count(*)::int` })
            .from(t)
            .where(and(
                eq(t.assistantId, args.assistantId),
                eq(t.organisationId, args.organisationId),
                isNotNull(t.pillar),
                gt(t.createdAt, sql`now() - make_interval(days => ${args.days})`),
            ))
            .groupBy(t.pillarId, t.pillar);
        counts = countsForTopics(all, used.map((u) => ({ pillarId: u.pillarId ?? null, pillar: u.pillar ?? null, n: Number(u.n) })));
    } catch (err) {
        console.warn('[topic-balance] count failed, rotating by day:', (err as Error)?.message);
    }
    const when = args.slot ? new Date(args.slot) : new Date();
    const dayIndex = Math.floor((Number.isNaN(when.getTime()) ? Date.now() : when.getTime()) / 86_400_000);
    const name = pickPillarForSlot(all.map((p) => p.name), counts, dayIndex);
    return { chosen: all.find((p) => p.name === name) ?? null, all };
}

/** The prompt line for the chosen topic: its name, and what the owner said belongs under it. */
export function topicLine(t: DraftPillar): string {
    return t.description ? `"${t.name}" (what belongs under it: ${t.description})` : `"${t.name}"`;
}
