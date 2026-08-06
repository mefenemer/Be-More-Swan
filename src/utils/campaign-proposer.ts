// src/utils/campaign-proposer.ts
// The two autonomous triggers from docs/campaign-orchestrator-plan.md §4, scenarios 1 and 2.
//
// ── Why there is no model in this file ───────────────────────────────────────
// autonomous-strategy-agent.ts needs an LLM because it REWRITES PROSE — an outreach playbook has
// no closed form. These two decisions have one: "this post beat the account average by 2.5x" and
// "more than 40% of the last day's leads were cold" are thresholds, and the orders that follow are
// a fixed template. A model here would add a way to be wrong without adding a way to be right.
//
// That also settles the safety question the strategy agent had to argue at length. Its rule was
// "evidence is computed in SQL and attached by the persist path, so a model that invents
// sampleSize: 400 cannot launder it into the UI". Here EVERY number is computed in SQL, because
// there is nothing else to compute it.
//
// ── What this may and may not do ─────────────────────────────────────────────
// It writes a `campaign_decisions` row with status 'pending' and its Review Queue mirror. That row
// is INERT: it changes no behaviour anywhere until a human approves it, and approval goes through
// campaigns.ts `decide`, which is the only thing that ever calls placeOrder. Nothing here queues a
// job, edits a search, or spends a task.
//
// ⚠️ It must also never propose the same thing twice. A weekly-ish trigger reading a 7-day window
// re-detects the same outperforming post on every run, and a queue with four identical cards is a
// queue the user stops reading — which is how the feedback loop dies quietly.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
    aiAssistants, campaignDecisions, campaigns, discoveredLeads, discoveryCampaigns,
    postInsights, scheduledPosts,
} from '../../db/schema';
import { mirrorDecision } from './campaign-mirror';
import { DECISION_TTL_DAYS, orderWorkItems, type CampaignDecisionKind } from '../config/campaign-vocab';
import { SMM_ROLE_KEY, LEAD_GENERATOR_ROLE_KEY } from '../constants/roles';

type Db = Parameters<typeof mirrorDecision>[0];

// ── Thresholds ───────────────────────────────────────────────────────────────
// Named and exported so the test asserts against these rather than re-typing the numbers, and so
// the one place to argue about them is here.

/** How far above the account average a post must land before it is worth commissioning more. */
export const OUTPERFORM_MULTIPLE = 2.5;

/**
 * Posts needed before an "account average" means anything.
 *
 * With two posts, whichever did better is ~2x the mean by construction — the trigger would fire on
 * noise for every new account, which is precisely when a user has least reason to trust it.
 */
export const MIN_POSTS_FOR_AVERAGE = 8;

/** How far back to look for a breakout post. */
export const OUTPERFORM_WINDOW_DAYS = 7;

/** Share of a day's discovered leads rated 'cold' that means the search is aimed wrong. */
export const LEAD_QUALITY_FLOOR = 0.4;

/** Leads needed before a percentage is a signal rather than an accident of a small run. */
export const MIN_LEADS_FOR_QUALITY = 10;

/** Nothing is proposed for the same campaign and kind while one is still pending. */
export const DEDUPE_KINDS: readonly CampaignDecisionKind[] = ['escalation', 'halt'];

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface LiveCampaign {
    id: number;
    organisationId: number;
    aiAssistantId: number;
    objective: string;
}

/** One structured fact. Never prose a model wrote — every field here came out of a COUNT or an AVG. */
export interface EvidenceItem {
    label: string;
    value: string;
    detail?: string;
}

export interface ProposedDecision {
    kind: CampaignDecisionKind;
    title: string;
    evidence: EvidenceItem[];
    costOfInaction: string;
    /** Applied verbatim by campaigns.ts `decide`. The model gets no turn between approval and execution. */
    orders: Array<{ action: string; brief: Record<string, unknown>; quantity: number }>;
}

/** Sum the work items a proposal would cost, so the card can state it before approval. */
export function proposalWorkItems(p: ProposedDecision): number {
    return p.orders.reduce((n, o) => n + orderWorkItems(o.action, o.quantity), 0);
}

// ── Scenario 1: a post outperformed, so commission more of it ────────────────

/**
 * Find the best post of the window, if it beat the account's own average by enough.
 *
 * Measured on `total_interactions` rather than an engagement RATE on purpose: reach is null on
 * several platforms (post_insights documents this), and a rate computed from a null denominator
 * would silently rank those posts last. Interactions are the one counter every platform returns.
 *
 * The comparison is against the SAME assistant's own average, never a cross-account benchmark —
 * "good for you" is the only claim the data supports.
 */
export async function detectOutperformingPost(
    db: Db, organisationId: number, since: Date,
): Promise<{ postId: number; interactions: number; average: number; multiple: number; caption: string | null } | null> {
    const [stats] = await db
        .select({
            n: sql<number>`COUNT(*)::int`,
            avg: sql<number>`COALESCE(AVG(${postInsights.totalInteractions}), 0)::float`,
        })
        .from(postInsights)
        .where(and(
            eq(postInsights.organisationId, organisationId),
            gte(postInsights.publishedAt, since),
            sql`${postInsights.totalInteractions} IS NOT NULL`,
        ));

    // Below the sample floor there is no "average" to beat, so there is nothing to say. Returning
    // null (rather than proposing with a caveat) is the same choice the Searches tab makes: an
    // honest silence beats a confident number built on four data points.
    if (!stats || Number(stats.n) < MIN_POSTS_FOR_AVERAGE || Number(stats.avg) <= 0) return null;

    const average = Number(stats.avg);
    const [best] = await db
        .select({
            postId: postInsights.scheduledPostId,
            interactions: postInsights.totalInteractions,
            caption: scheduledPosts.caption,
        })
        .from(postInsights)
        .leftJoin(scheduledPosts, eq(scheduledPosts.id, postInsights.scheduledPostId))
        .where(and(
            eq(postInsights.organisationId, organisationId),
            gte(postInsights.publishedAt, since),
            sql`${postInsights.totalInteractions} IS NOT NULL`,
        ))
        .orderBy(desc(postInsights.totalInteractions))
        .limit(1);

    if (!best?.interactions) return null;
    const multiple = Number(best.interactions) / average;
    if (multiple < OUTPERFORM_MULTIPLE) return null;

    return {
        postId: best.postId,
        interactions: Number(best.interactions),
        average,
        multiple,
        caption: best.caption ?? null,
    };
}

/**
 * Turn a breakout post into an escalation proposal.
 *
 * The orders mirror the plan: one pillar article on the topic, plus three more social posts. Both
 * steer through blueprint section 13-campaign rather than a brief field, which is why neither
 * carries the post's text — see the note on `draft_social_posts` in campaign-orders.ts.
 */
export function buildEscalationProposal(
    hit: { postId: number; interactions: number; average: number; multiple: number; caption: string | null },
): ProposedDecision {
    // Trimmed hard. The caption is user/AI-authored text going onto a card and into a jsonb column;
    // it is shown as context, never used as an instruction to anything.
    const snippet = (hit.caption ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);

    return {
        kind: 'escalation',
        title: 'One post is well ahead of your average — commission more on that topic',
        evidence: [
            { label: 'Interactions on the post', value: String(hit.interactions) },
            { label: 'Your average over the window', value: hit.average.toFixed(1) },
            { label: 'How far ahead', value: `${hit.multiple.toFixed(1)}x your average` },
            ...(snippet ? [{ label: 'The post', value: snippet, detail: `Post #${hit.postId}` }] : []),
        ],
        costOfInaction: 'The post keeps performing and nothing else is built on it. Attention on a topic fades within a week or two, so the window for a follow-up closes on its own.',
        orders: [
            { action: 'draft_blog_pillar', brief: {}, quantity: 1 },
            { action: 'draft_social_posts', brief: {}, quantity: 3 },
        ],
    };
}

// ── Scenario 2: lead quality dropped, so stop aiming there ───────────────────

/**
 * Find a saved search whose recent results are mostly cold.
 *
 * Reads `discovered_leads.rating`, which the scorer sets — NOT the reject feedback table. Those
 * answer different questions: rejections tell you what a human disliked about leads they SAW, and
 * that already feeds the Lead Generator's own strategy agent. This asks whether the search is
 * finding the wrong companies at all, which is visible before anyone reviews anything.
 */
export async function detectLeadQualityDrop(
    db: Db, organisationId: number, since: Date,
): Promise<{ discoveryCampaignId: number; searchName: string | null; total: number; cold: number; coldShare: number } | null> {
    const rows = await db
        .select({
            discoveryCampaignId: discoveredLeads.campaignId,
            searchName: discoveryCampaigns.name,
            total: sql<number>`COUNT(*)::int`,
            cold: sql<number>`COUNT(*) FILTER (WHERE ${discoveredLeads.rating} = 'cold')::int`,
        })
        .from(discoveredLeads)
        .innerJoin(discoveryCampaigns, eq(discoveryCampaigns.id, discoveredLeads.campaignId))
        .where(and(
            eq(discoveryCampaigns.organisationId, organisationId),
            gte(discoveredLeads.createdAt, since),
        ))
        .groupBy(discoveredLeads.campaignId, discoveryCampaigns.name)
        .having(sql`COUNT(*) >= ${MIN_LEADS_FOR_QUALITY}`)
        .orderBy(desc(sql`COUNT(*) FILTER (WHERE ${discoveredLeads.rating} = 'cold')::float / COUNT(*)`))
        .limit(1);

    const worst = rows[0];
    if (!worst) return null;
    const coldShare = Number(worst.cold) / Number(worst.total);
    if (coldShare <= LEAD_QUALITY_FLOOR) return null;

    return {
        discoveryCampaignId: worst.discoveryCampaignId,
        searchName: worst.searchName ?? null,
        total: Number(worst.total),
        cold: Number(worst.cold),
        coldShare,
    };
}

/**
 * Turn a quality drop into a halt proposal.
 *
 * ⚠️ `narrow_targeting` is proposed WITHOUT an `idea` rewrite, and that is deliberate rather than
 * unfinished. Rewriting the search brief is prose, which is the one thing this file has no business
 * generating — and campaign-orders.ts leaves the existing idea untouched when no replacement is
 * given, so approving this flags the search and records the decision without silently rewording
 * what the user wrote. The Lead Generator's own Strategy tab is where a reworded brief belongs.
 *
 * The angle on `adjust_messaging` IS set, because that one is a routing instruction rather than
 * copy: it reaches the drafter through blueprint section 13-campaign as a single sentence.
 */
export function buildHaltProposal(
    hit: { discoveryCampaignId: number; searchName: string | null; total: number; cold: number; coldShare: number },
): ProposedDecision {
    const pct = Math.round(hit.coldShare * 100);
    const name = hit.searchName?.trim() || `search #${hit.discoveryCampaignId}`;

    return {
        kind: 'halt',
        title: `"${name}" is mostly finding the wrong companies`,
        evidence: [
            { label: 'Leads found in the window', value: String(hit.total) },
            { label: 'Rated cold', value: `${hit.cold} (${pct}%)` },
            { label: 'Your threshold', value: `${Math.round(LEAD_QUALITY_FLOOR * 100)}%` },
        ],
        costOfInaction: 'The search keeps running against the same targeting and keeps costing you review time on companies that were never a fit. Each run also spends part of your monthly allowance.',
        orders: [
            {
                action: 'narrow_targeting',
                brief: { discoveryCampaignId: hit.discoveryCampaignId },
                quantity: 1,
            },
            {
                action: 'adjust_messaging',
                brief: {
                    angle: 'Speak to the specific problem this product solves and who it is for, rather than broad category benefits. The current targeting is reaching companies that are not a fit.',
                },
                quantity: 1,
            },
        ],
    };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Is there already a pending decision of this kind for this campaign?
 *
 * The check that stops the queue filling with the same card. A 7-day window re-detects the same
 * breakout post every run, so without this a fortnight of runs leaves four identical escalations
 * and the user learns to ignore the tab.
 */
export async function hasPendingDecision(db: Db, campaignId: number, kind: CampaignDecisionKind): Promise<boolean> {
    const [row] = await db
        .select({ id: campaignDecisions.id })
        .from(campaignDecisions)
        .where(and(
            eq(campaignDecisions.campaignId, campaignId),
            eq(campaignDecisions.kind, kind),
            eq(campaignDecisions.status, 'pending'),
        ))
        .limit(1);
    return !!row;
}

/**
 * Persist one proposal and its Review Queue mirror.
 *
 * Returns the decision id, or null when it was skipped as a duplicate. Never places an order:
 * `proposed` is stored and only campaigns.ts `decide` ever reads it back to act on.
 */
export async function persistProposal(
    db: Db, campaign: LiveCampaign, p: ProposedDecision,
): Promise<number | null> {
    if (await hasPendingDecision(db, campaign.id, p.kind)) return null;

    const workItems = proposalWorkItems(p);
    const expiresAt = new Date(Date.now() + DECISION_TTL_DAYS[p.kind] * 24 * 60 * 60 * 1000);

    const [row] = await db.insert(campaignDecisions).values({
        organisationId: campaign.organisationId,
        campaignId: campaign.id,
        kind: p.kind,
        title: p.title,
        evidence: p.evidence,
        proposed: { orders: p.orders },
        costOfInaction: p.costOfInaction,
        costWorkItems: workItems,
        // Explicit, not defaulted: Phase 1 campaigns spend capacity, never money, and writing the
        // zero here documents that rather than leaving it to a column default to mean it.
        costGbp: '0.00',
        status: 'pending',
        expiresAt,
    }).returning({ id: campaignDecisions.id });

    if (!row) return null;

    await mirrorDecision(db, {
        organisationId: campaign.organisationId,
        aiAssistantId: campaign.aiAssistantId,
        decisionId: row.id,
        kind: p.kind,
        title: p.title,
        campaignObjective: campaign.objective,
        evidence: p.evidence,
        costOfInaction: p.costOfInaction,
        workItems,
        expiresAt,
    });

    return row.id;
}

/**
 * Expire pending decisions whose evidence has aged out, and settle their Review Queue rows.
 *
 * Without the mirror half, an expired decision vanishes from the campaign side while its card sits
 * in the Review Queue for ever, still counting towards the badge and still offering an Approve
 * button that campaigns.ts will refuse. Every pause needs a resume; every expiry needs a sweep.
 */
export async function expirePendingDecisions(db: Db): Promise<number> {
    const stale = await db
        .select({ id: campaignDecisions.id, recordId: campaignDecisions.assistantRecordId })
        .from(campaignDecisions)
        .where(and(
            eq(campaignDecisions.status, 'pending'),
            sql`${campaignDecisions.expiresAt} < now()`,
        ))
        .limit(500);

    for (const d of stale) {
        await db.update(campaignDecisions)
            .set({ status: 'expired', updatedAt: new Date() })
            .where(eq(campaignDecisions.id, d.id));
    }
    if (stale.length) {
        const recordIds = stale.map((d) => d.recordId).filter((id): id is number => typeof id === 'number');
        if (recordIds.length) {
            // 'rejected' rather than a new status: assistant_records has a fixed approval vocabulary
            // and inventing a value here would fail its CHECK. The campaign side keeps the precise
            // truth ('expired'); the mirror only needs to stop being actionable.
            const { assistantRecords } = await import('../../db/schema');
            await db.update(assistantRecords)
                .set({ approvalStatus: 'rejected', updatedAt: new Date() })
                .where(inArray(assistantRecords.id, recordIds));
        }
    }
    return stale.length;
}

/**
 * The campaigns a run should consider.
 *
 * Live only. A draft campaign has commissioned nothing and a paused one was stopped on purpose —
 * proposing new work for either would be the agent overriding a human decision, which is the
 * failure connection-pause-needs-a-resume is named after, pointed the other way.
 */
export async function liveCampaignsForRun(db: Db, limit: number): Promise<LiveCampaign[]> {
    return db
        .select({
            id: campaigns.id,
            organisationId: campaigns.organisationId,
            aiAssistantId: campaigns.aiAssistantId,
            objective: campaigns.objective,
        })
        .from(campaigns)
        .where(inArray(campaigns.status, ['active', 'throttled']))
        .orderBy(desc(campaigns.id))
        .limit(limit);
}

/**
 * Does this organisation actually have the assistant an order would be sent to?
 *
 * Checked BEFORE proposing, not after approving. placeOrder already refuses an order to an
 * unhired assistant with a clear message, but discovering that at approval time means the user
 * agreed to something that then partly failed — the card should never have offered it.
 *
 * ⚠️ There is no `role_key` column on ai_assistants: the role lives in `configuration->>'type'`.
 */
export async function hiredRoleKeys(db: Db, organisationId: number): Promise<Set<string>> {
    const rows = await db
        .select({ roleKey: sql<string>`(${aiAssistants.configuration} ->> 'type')` })
        .from(aiAssistants)
        .where(eq(aiAssistants.organisationId, organisationId));
    return new Set(rows.map((r) => r.roleKey).filter(Boolean));
}

/** The roles each scenario needs before it is worth proposing. */
export const SCENARIO_REQUIREMENTS = {
    escalation: [SMM_ROLE_KEY, 'blog_writer'],
    halt: [LEAD_GENERATOR_ROLE_KEY, SMM_ROLE_KEY],
} as const;
