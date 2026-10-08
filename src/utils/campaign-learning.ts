// src/utils/campaign-learning.ts
// A/B test results, the end-of-campaign summary, and the lessons a business keeps. Plan §9.8.
//
// ── The rules, each a way this could lie ────────────────────────────────────────────────────────
// 1. NOT ENOUGH DATA IS AN ANSWER. Organic samples are small; with three posts a side, one viral
//    post decides the "winner". Below MIN_POSTS_PER_VARIANT measured posts per angle the verdict is
//    'not_enough_data', and a gap under WIN_RATIO is 'no_clear_difference' — never a winner.
// 2. NO MODEL. Every number in a summary is a COUNT or an AVG, and every candidate lesson is a
//    sentence about those numbers. A model asked "what did we learn?" would write plausible
//    marketing insight the data does not support; the user can write their own lesson instead.
// 3. A SAVED LESSON MUST REACH SOMETHING (goals-steer-generation, learned-directives-gated-to-
//    posts-roles). It reaches the Campaign Assistant's planning every turn (learningsPromptBlock),
//    and — only if the user asks — the drafting of the writing assistants the campaign briefed, as
//    a content_rules row on EACH of them: visible and deletable in that assistant's Rules tab,
//    never an invisible workspace-wide rule.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, campaignDecisions, campaignExperiments, campaignLearnings, campaignOrders, campaigns, contentRules,
} from '../../db/schema';
import { CAMPAIGN_OUTCOME_LABELS, CAMPAIGN_STATUS_LABELS, type CampaignOutcomeMetric, type CampaignStatus } from '../config/campaign-vocab';
import { CAMPAIGN_REJECT_REASON_LABELS, type CampaignRejectReason } from '../config/campaign-reject-reasons';
import { BLOG_WRITER_ROLE_KEY, SMM_ROLE_KEY } from '../constants/roles';
import { campaignSpendTotals } from './campaign-ledger';
import { countCampaignOutcome } from './campaign-outcomes';
import { assembleBlueprint } from './blueprint';

type Db = ReturnType<typeof getDb>;

/** Measured posts each angle needs before a test may name a winner. 4 + 4 = the proposer's floor of 8. */
export const MIN_POSTS_PER_VARIANT = 4;
/** How far ahead one angle's average must be to count as a winner rather than noise. */
export const WIN_RATIO = 1.25;
export const LEARNING_MAX = 300;
/** Lessons the planning prompt carries. Newest first. */
const PROMPT_LEARNINGS = 15;

export interface VariantStats { posts: number; measured: number; mean: number | null }
export type TestVerdict =
    | { verdict: 'not_enough_data'; need: number }
    | { verdict: 'no_clear_difference'; ratio: number }
    | { verdict: 'a' | 'b'; ratio: number };

/** Pure: the honest verdict on two angles' engagement. */
export function judgeExperiment(a: VariantStats, b: VariantStats): TestVerdict {
    if (a.measured < MIN_POSTS_PER_VARIANT || b.measured < MIN_POSTS_PER_VARIANT
        || a.mean === null || b.mean === null) {
        return { verdict: 'not_enough_data', need: MIN_POSTS_PER_VARIANT };
    }
    const hi = Math.max(a.mean, b.mean);
    const lo = Math.min(a.mean, b.mean);
    // Zero against zero is no difference; anything against zero is a clear lead.
    const ratio = lo === 0 ? (hi === 0 ? 1 : Infinity) : hi / lo;
    if (ratio < WIN_RATIO) return { verdict: 'no_clear_difference', ratio: Math.round(ratio * 100) / 100 };
    return { verdict: a.mean > b.mean ? 'a' : 'b', ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : ratio };
}

/** One sentence for a verdict — the same words on the row, in the summary and in the chat. */
export function verdictSentence(exp: { angleA: string; angleB: string }, a: VariantStats, b: VariantStats, v: TestVerdict): string {
    if (v.verdict === 'not_enough_data') {
        return `Not enough data yet — each angle needs ${v.need} published posts with engagement figures (A has ${a.measured}, B has ${b.measured}).`;
    }
    if (v.verdict === 'no_clear_difference') {
        return `No clear difference: "${exp.angleA}" and "${exp.angleB}" drew similar engagement over ${a.measured} and ${b.measured} posts.`;
    }
    const [win, lose, wn, ln] = v.verdict === 'a' ? [exp.angleA, exp.angleB, a.measured, b.measured] : [exp.angleB, exp.angleA, b.measured, a.measured];
    const times = Number.isFinite(v.ratio) ? `${v.ratio}×` : 'far more than';
    return `"${win}" drew ${times} the engagement of "${lose}" (${wn} and ${ln} published posts).`;
}

/**
 * Every test on a campaign, with each angle's numbers and the verdict. Engagement is
 * total_interactions — the one counter every platform returns (reach is null on several).
 */
export async function experimentResults(db: Db, campaignId: number, organisationId: number) {
    const exps = await db.select().from(campaignExperiments)
        .where(and(eq(campaignExperiments.campaignId, campaignId), eq(campaignExperiments.organisationId, organisationId)))
        .orderBy(campaignExperiments.id);
    const out = [];
    for (const e of exps) {
        const rows = await db.execute<{ variant: string; posts: number; measured: number; mean: number | null }>(sql`
            SELECT t.variant,
                   count(j.result_post_id)::int AS posts,
                   count(pi.id) FILTER (WHERE p.status = 'published')::int AS measured,
                   avg(pi.total_interactions) FILTER (WHERE p.status = 'published')::float AS mean
              FROM campaign_experiment_jobs t
              JOIN content_generation_jobs j ON j.id = t.job_id
              LEFT JOIN scheduled_posts p ON p.id = j.result_post_id AND p.organisation_id = ${organisationId}
              LEFT JOIN post_insights pi ON pi.scheduled_post_id = p.id
             WHERE t.experiment_id = ${e.id}
             GROUP BY t.variant`);
        const pick = (v: 'A' | 'B'): VariantStats => {
            const r = [...rows].find((x) => x.variant === v);
            return { posts: Number(r?.posts ?? 0), measured: Number(r?.measured ?? 0), mean: r?.mean == null ? null : Number(r.mean) };
        };
        const a = pick('A');
        const b = pick('B');
        const verdict = judgeExperiment(a, b);
        out.push({
            id: e.id, hypothesis: e.hypothesis, angleA: e.angleA, angleB: e.angleB,
            postsPerVariant: e.postsPerVariant, a, b, verdict, sentence: verdictSentence(e, a, b, verdict),
        });
    }
    return out;
}

/**
 * The end-of-campaign summary: what it set out to do, what it did, what it cost, what the user
 * turned down and why, what its tests showed — and candidate lessons, each a sentence about those
 * facts. Works on a live campaign too ("how is it going?"); the row offers it once finished.
 */
export async function buildCampaignSummary(db: Db, campaignId: number, organisationId: number) {
    const [c] = await db.select().from(campaigns)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.organisationId, organisationId))).limit(1);
    if (!c) return null;

    const progress = await countCampaignOutcome(db, { id: c.id, organisationId }, c.outcomeMetric);
    const spend = await campaignSpendTotals(db, c.id);
    const orderRows = await db.select({ status: campaignOrders.status, n: sql<number>`count(*)::int` })
        .from(campaignOrders).where(eq(campaignOrders.campaignId, c.id)).groupBy(campaignOrders.status);
    const orders = Object.fromEntries(orderRows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
    const decisionRows = await db.select({ status: campaignDecisions.status, n: sql<number>`count(*)::int` })
        .from(campaignDecisions).where(eq(campaignDecisions.campaignId, c.id)).groupBy(campaignDecisions.status);
    const decisions = Object.fromEntries(decisionRows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
    const rejections = ((c.constraints as { rejections?: Record<string, number> } | null)?.rejections ?? {});
    const tests = await experimentResults(db, c.id, organisationId);

    const metricLabel = (CAMPAIGN_OUTCOME_LABELS[c.outcomeMetric as CampaignOutcomeMetric] ?? c.outcomeMetric).toLowerCase();
    const weeks = c.startsAt
        ? Math.max(1, Math.round(((c.status === 'finished' ? c.updatedAt : new Date()).getTime() - c.startsAt.getTime()) / (7 * 24 * 3600 * 1000)))
        : null;

    const facts: string[] = [];
    facts.push(progress === null
        ? `Its measure (${metricLabel}) could not be counted.`
        : c.targetValue
            ? `${progress} of a target of ${c.targetValue} ${metricLabel}${progress >= c.targetValue ? ' — target met' : ''}.`
            : `${progress} ${metricLabel}.`);
    facts.push(`${spend.spentWork} tasks spent${weeks ? ` over ${weeks} ${weeks === 1 ? 'week' : 'weeks'}` : ''}.`);
    facts.push(`Briefs: ${orders.delivered ?? 0} delivered, ${(orders.issued ?? 0) + (orders.in_review ?? 0)} still open, ${orders.rejected ?? 0} turned down, ${orders.cancelled ?? 0} cancelled.`);
    if (Object.keys(decisions).length) {
        facts.push(`Proposals: ${decisions.approved ?? 0} approved, ${decisions.rejected ?? 0} turned down, ${decisions.expired ?? 0} expired.`);
    }

    // Candidate lessons — each says only what the facts say. The user picks which to keep, and can
    // write their own; nothing is saved without them.
    const candidates: { text: string; source: 'summary' | 'test' }[] = [];
    // Only once the campaign has actually DONE something. "Reached 0 of 500 with 0 tasks" is not a
    // lesson — offering it to keep teaches the next plan nothing and buries the real ones.
    if (progress !== null && c.targetValue && weeks && (spend.spentWork > 0 || progress > 0)) {
        candidates.push({
            source: 'summary',
            text: `A ${c.funnelStage} campaign for ${metricLabel} reached ${progress} of ${c.targetValue} in ${weeks} ${weeks === 1 ? 'week' : 'weeks'} with ${spend.spentWork} tasks.`,
        });
    }
    for (const t of tests) {
        if (t.verdict.verdict === 'a' || t.verdict.verdict === 'b') candidates.push({ source: 'test', text: t.sentence });
    }
    const topReason = Object.entries(rejections).sort((x, y) => Number(y[1]) - Number(x[1]))[0];
    if (topReason && Number(topReason[1]) >= 2) {
        candidates.push({
            source: 'summary',
            text: `Proposals were turned down most often as "${CAMPAIGN_REJECT_REASON_LABELS[topReason[0] as CampaignRejectReason] ?? topReason[0]}" (${topReason[1]} times).`,
        });
    }

    return {
        campaignId: c.id,
        objective: c.objective,
        status: c.status,
        statusLabel: CAMPAIGN_STATUS_LABELS[c.status as CampaignStatus] ?? c.status,
        facts,
        tests: tests.map((t) => ({ id: t.id, hypothesis: t.hypothesis, sentence: t.sentence, verdict: t.verdict.verdict })),
        candidates: candidates.map((x) => ({ ...x, text: x.text.slice(0, LEARNING_MAX) })),
    };
}

/**
 * Keep a lesson. Always readable by the Campaign Assistant's planning; with `applyToDrafting`,
 * also a rule on each writing assistant the campaign briefed (and those assistants recompile, so
 * it reaches the next draft rather than whenever something else recompiles).
 */
export async function saveLearning(db: Db, input: {
    organisationId: number; userId: number; campaignId: number | null; text: string;
    source: 'summary' | 'test' | 'user'; applyToDrafting: boolean; campaignObjective?: string | null;
}): Promise<{ learningId: number; appliedTo: number[] }> {
    const text = input.text.replace(/\s+/g, ' ').trim().slice(0, LEARNING_MAX);
    const [row] = await db.insert(campaignLearnings).values({
        organisationId: input.organisationId, campaignId: input.campaignId, learning: text,
        source: input.source, appliedToDrafting: false, createdBy: input.userId,
    }).returning({ id: campaignLearnings.id });

    const appliedTo: number[] = [];
    if (input.applyToDrafting && input.campaignId) {
        // The writing assistants THIS campaign briefed — never every assistant in the workspace.
        const targets = await db.selectDistinct({ id: campaignOrders.targetAssistantId })
            .from(campaignOrders)
            .innerJoin(aiAssistants, and(
                eq(aiAssistants.id, campaignOrders.targetAssistantId),
                eq(aiAssistants.organisationId, input.organisationId),
            ))
            .where(and(
                eq(campaignOrders.campaignId, input.campaignId),
                eq(campaignOrders.organisationId, input.organisationId),
                inArray(campaignOrders.targetRoleKey, [SMM_ROLE_KEY, BLOG_WRITER_ROLE_KEY]),
            ));
        for (const t of targets) {
            if (!t.id) continue;
            await db.insert(contentRules).values({
                assistantId: t.id, workspaceId: input.organisationId, ruleText: text,
                createdByUserId: input.userId, isActive: true, origin: 'campaign_learning',
                note: `Learned from the campaign "${(input.campaignObjective ?? '').slice(0, 120)}"`,
            });
            appliedTo.push(t.id);
            try { await assembleBlueprint(t.id, `user-${input.userId}`, 'context_update'); }
            catch (err) { console.warn('[campaign-learning] recompile failed — applies from the next compile', { assistantId: t.id, err }); }
        }
        if (appliedTo.length) {
            await db.update(campaignLearnings).set({ appliedToDrafting: true }).where(eq(campaignLearnings.id, row.id));
        }
    }
    return { learningId: row.id, appliedTo };
}

/**
 * What past campaigns taught this business, for the Campaign Assistant's planning prompt. Read per
 * turn. Null when there is nothing — the prompt then says nothing rather than "no lessons".
 */
export async function learningsPromptBlock(db: Db, organisationId: number): Promise<string | null> {
    try {
        const rows = await db.select({ learning: campaignLearnings.learning, objective: campaigns.objective })
            .from(campaignLearnings)
            .leftJoin(campaigns, eq(campaigns.id, campaignLearnings.campaignId))
            .where(eq(campaignLearnings.organisationId, organisationId))
            .orderBy(desc(campaignLearnings.createdAt))
            .limit(PROMPT_LEARNINGS);
        if (!rows.length) return null;
        return `WHAT PAST CAMPAIGNS TAUGHT THIS BUSINESS — lessons the user chose to keep. Plan with them: do not repeat what did not work, build on what did, and say when a proposal is shaped by one. They are the user's conclusions about their own results; do not overstate them.
${rows.map((r) => `- ${r.learning}${r.objective ? ` (from "${r.objective.slice(0, 80)}")` : ''}`).join('\n')}`;
    } catch (err) {
        console.error('[campaign-learning] learnings block failed (non-fatal)', err);
        return null;
    }
}
