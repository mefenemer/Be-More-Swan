// src/utils/campaign-reconciler.ts
// Closing the loop: moving campaign orders off 'issued', and campaigns off 'active'.
//
// ── The hole this fills ─────────────────────────────────────────────────────────────────────────
// Phase 1 shipped a complete forward path — a human approves a decision, placeOrder commissions
// work, the ledger charges it — and no return path at all. `placeOrder` set an order to 'issued'
// (or straight to 'delivered' for the two steering actions that produce nothing), and no code
// anywhere ever moved it again. Concretely, before this file existed:
//
//   * a draft_social_posts order read "With the assistant" for ever, including long after its posts
//     were drafted, approved and published. The Orders tab is described to the user in the
//     orchestrator prompt as "where the user checks whether a campaign actually produced
//     anything", and it could not answer that question;
//   * 'in_review' and 'delivered' were in the status CHECK constraint and in the client's label
//     map, and were unreachable;
//   * a `blocked` order — the chained "pillar first, then the teasers behind it" shape — waited on
//     a predecessor that could never deliver, so it waited for ever. `issueOrder` was exported
//     specifically so an unblock path could reuse it; that path was never written;
//   * `campaigns.status` could never reach 'finished'. `ends_at` was collected at create time, fed
//     into the blueprint, and enforced by nothing, so a campaign kept steering generation
//     indefinitely. The `campaigns_active_idx` index on (status, ends_at) was built for this sweep.
//
// ── Mandate, and how it differs from the proposer ───────────────────────────────────────────────
// campaign-proposer.ts PROPOSES and must never act — every order it could suggest waits for a
// human. This file is the opposite mandate on purpose: it ACTS, but only ever to record what has
// already happened elsewhere, or to continue a plan a human already approved. It is deliberately
// NOT called from autonomous-campaign-agent.ts. Keeping them as two crons with two mandates means
// "the autonomous proposer never places an order" stays literally true of that file, rather than
// becoming a claim qualified by a flag. The cost is that the proposer may read order statuses up to
// one reconcile-interval stale, which is immaterial against its 24-hour and 7-day windows.
//
// ── Rules it holds to ───────────────────────────────────────────────────────────────────────────
// 1. FORWARD ONLY. Every transition here leaves a terminal status terminal. A delivered order is
//    never re-opened, and nothing reads a status back to an earlier one — otherwise a post edited
//    back to draft after publication would resurrect a settled order.
// 2. It never STARTS, resumes, re-budgets or un-pauses a campaign. The only campaign transition it
//    makes is active|throttled → finished, on a date the user themselves set. A paused campaign is
//    a human decision and is left exactly where it is, expired or not.
// 3. It places work in exactly one circumstance — releasing an order that was already created,
//    already costed and already approved, and was only waiting for its predecessor. That is the
//    completion of an approved plan, not a new one.
// 4. Silence is a real outcome. An order it cannot judge is LEFT ALONE rather than guessed at; see
//    the `unknowable` path below.

import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, blogPosts, campaignOrders, campaigns, contentGenerationJobs, discoveryCampaigns,
    scheduledPosts,
} from '../../db/schema';
import { isScheduleActive } from '../config/post-status';
import { recordCampaignSpend } from './campaign-ledger';
import { mirrorOrder } from './campaign-mirror';
import { issueOrder } from './campaign-orders';
import { ORDER_ACTION_SPECS, type CampaignOrderAction } from '../config/campaign-vocab';

type Db = ReturnType<typeof getDb>;

/** Orders examined per run. Each is a couple of indexed lookups. */
const ORDER_BATCH = 500;
/** Campaigns examined by the expiry sweep per run. */
const CAMPAIGN_BATCH = 500;

/**
 * How long an issued order may sit with no trace of the work it commissioned before we stop
 * expecting one. Only reached by orders placed before db/campaign-order-tracing.sql existed, or
 * whose jobs were purged — both of which are "we cannot know", not "it failed".
 */
const UNTRACEABLE_AFTER_DAYS = 30;

export interface ReconcileResult {
    skipped?: string;
    /** Orders looked at. */
    examined: number;
    /** Orders moved to 'in_review' — work exists and is waiting on the user. */
    toReview: number;
    /** Orders moved to 'delivered'. */
    delivered: number;
    /** Orders moved to 'rejected' — the user turned the work down. */
    rejected: number;
    /** Orders moved to 'cancelled' because everything they commissioned failed. */
    failed: number;
    /** Blocked orders released because their predecessor delivered. */
    unblocked: number;
    /** Campaigns swept past their end date to 'finished'. */
    finished: number;
    /** Work items refunded to campaigns whose orders produced nothing. */
    refundedWork: number;
}

/** What the artefacts behind one order add up to. */
type Verdict =
    | { kind: 'pending' }                       // still being worked on — leave at 'issued'
    | { kind: 'unknowable' }                    // no trace; leave alone
    | { kind: 'in_review'; summary: string }
    | { kind: 'delivered'; summary: string }
    | { kind: 'rejected'; summary: string }
    | { kind: 'failed'; summary: string };

/**
 * Blog statuses meaning "a human committed this article". The social equivalent is
 * isScheduleActive() from post-status.ts, which is exactly this question for scheduled_posts and is
 * reused rather than restated. Blog needs its own list: it has 'archived' and lacks
 * 'paused_credits', so the two vocabularies are near-neighbours rather than the same set.
 *
 * 'failed' counts as committed on purpose. The user approved it and the campaign produced it; a
 * publish that then failed is a delivery problem with its own recovery path (retry-failed-post),
 * not evidence the order never delivered.
 */
const BLOG_COMMITTED = new Set(['approved', 'scheduled', 'publishing', 'published', 'paused', 'failed', 'archived']);
/** Blog statuses still waiting on a human. */
const BLOG_AWAITING = new Set(['draft', 'pending_approval', 'in_review']);

/** Social statuses still waiting on a human — the complement of isScheduleActive, minus dead ends. */
const POST_AWAITING = new Set(['draft', 'pending_approval', 'in_review']);
/** Social statuses meaning the user turned it down (or let it lapse unapproved). */
const POST_TURNED_DOWN = new Set(['rejected', 'cancelled', 'missed']);

/**
 * Reduce a set of artefact statuses to one verdict for the order that commissioned them.
 *
 * Pure, and exported for the test: this is the whole decision, and it is much easier to assert
 * against a table of statuses than through five tables of fixtures.
 *
 * Precedence matters and is deliberate:
 *   anything still awaiting a human  → in_review  (the campaign is waiting on THEM, say so)
 *   else anything committed          → delivered
 *   else anything turned down        → rejected
 *   else                             → failed
 * "Awaiting" wins over "committed" because a partly-approved batch is still asking the user for
 * something, and an order that reads 'delivered' while three of its posts sit unapproved would
 * quietly drop them off the user's radar.
 */
export function verdictFromArtefactStatuses(
    statuses: readonly string[],
    kind: 'post' | 'blog',
): Verdict {
    if (statuses.length === 0) return { kind: 'unknowable' };

    const awaiting = kind === 'blog' ? BLOG_AWAITING : POST_AWAITING;
    const committed = (s: string) => (kind === 'blog' ? BLOG_COMMITTED.has(s) : isScheduleActive(s));
    const turnedDown = (s: string) =>
        kind === 'blog' ? s === 'rejected' : POST_TURNED_DOWN.has(s);

    const nAwaiting = statuses.filter((s) => awaiting.has(s)).length;
    const nCommitted = statuses.filter(committed).length;
    const nTurnedDown = statuses.filter(turnedDown).length;
    const noun = kind === 'blog' ? 'article' : 'post';
    const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;

    if (nAwaiting > 0) {
        return { kind: 'in_review', summary: `${plural(nAwaiting)} waiting for your approval` };
    }
    if (nCommitted > 0) {
        return { kind: 'delivered', summary: `${plural(nCommitted)} approved and scheduled` };
    }
    if (nTurnedDown > 0) {
        return { kind: 'rejected', summary: `${plural(nTurnedDown)} turned down` };
    }
    return { kind: 'failed', summary: 'Nothing usable was produced' };
}

/** The two actions whose work lands as content_generation_jobs. */
const CONTENT_ACTIONS: readonly CampaignOrderAction[] = ['draft_social_posts', 'draft_blog_pillar'];

/**
 * Judge one content order from the jobs it enqueued and the posts those jobs produced.
 *
 * The job row is the trace (db/campaign-order-tracing.sql); the post is the artefact. Both matter:
 * a job that is still `queued` means the order is genuinely mid-flight, whereas a job that
 * `completed` without a result post means the drafter ran and produced nothing.
 */
async function judgeContentOrder(
    db: Db,
    order: { id: number; action: string; issuedAt: Date | null },
): Promise<Verdict> {
    const isBlog = order.action === 'draft_blog_pillar';
    const jobs = await db
        .select({
            status: contentGenerationJobs.status,
            postId: contentGenerationJobs.resultPostId,
            blogPostId: contentGenerationJobs.resultBlogPostId,
        })
        .from(contentGenerationJobs)
        .where(eq(contentGenerationJobs.campaignOrderId, order.id));

    if (jobs.length === 0) {
        // No trace. Either the order predates the tracing column or its jobs were purged. Guessing
        // here would settle an order on no evidence, so it is left at 'issued' — except once it is
        // old enough that no answer is ever coming, when leaving it pending is its own lie.
        const issued = order.issuedAt?.getTime() ?? 0;
        const tooOld = issued > 0 && Date.now() - issued > UNTRACEABLE_AFTER_DAYS * 86_400_000;
        return tooOld
            ? { kind: 'failed', summary: 'No record of the work this order commissioned' }
            : { kind: 'unknowable' };
    }

    // Any job still running means the order is genuinely in flight. Say nothing yet.
    if (jobs.some((j) => j.status === 'queued' || j.status === 'processing')) return { kind: 'pending' };

    const artefactIds = jobs
        .map((j) => (isBlog ? j.blogPostId : j.postId))
        .filter((id): id is number => typeof id === 'number');

    if (artefactIds.length === 0) {
        // Every job reached a terminal state and none produced anything.
        return { kind: 'failed', summary: 'The drafting run produced nothing' };
    }

    const rows = isBlog
        ? await db.select({ status: blogPosts.status }).from(blogPosts).where(inArray(blogPosts.id, artefactIds))
        : await db.select({ status: scheduledPosts.status }).from(scheduledPosts).where(inArray(scheduledPosts.id, artefactIds));

    return verdictFromArtefactStatuses(rows.map((r) => String(r.status)), isBlog ? 'blog' : 'post');
}

/**
 * Judge a run_lead_search order from the saved search it created.
 *
 * The order's own work finished the moment the draft search existed — starting it is a human act
 * by design (a run costs money and reaches real strangers). So 'in_review' is the honest resting
 * state while it sits as a draft, and it delivers when the user actually starts it.
 */
async function judgeLeadSearchOrder(db: Db, order: { artefactId: number | null }): Promise<Verdict> {
    if (!order.artefactId) return { kind: 'unknowable' };
    const [row] = await db
        .select({ status: discoveryCampaigns.status })
        .from(discoveryCampaigns)
        .where(eq(discoveryCampaigns.id, order.artefactId))
        .limit(1);

    if (!row) return { kind: 'failed', summary: 'That saved search no longer exists' };
    if (row.status === 'draft') return { kind: 'in_review', summary: 'Saved search ready — start it from Find New Leads' };
    if (row.status === 'archived') return { kind: 'rejected', summary: 'Saved search archived without being run' };
    return { kind: 'delivered', summary: 'Saved search is running' };
}

/**
 * Release any orders that were waiting on this one, now that it has delivered.
 *
 * This is the only place the reconciler commissions work, and the justification is narrow: the
 * blocked order was created, costed and approved in the same human decision as the predecessor it
 * is chained behind. Nothing new is being decided here.
 */
async function unblockChain(db: Db, deliveredOrderId: number): Promise<number> {
    const waiting = await db
        .select({
            id: campaignOrders.id,
            organisationId: campaignOrders.organisationId,
            campaignId: campaignOrders.campaignId,
            action: campaignOrders.action,
            brief: campaignOrders.brief,
            costWorkItems: campaignOrders.costWorkItems,
            targetAssistantId: campaignOrders.targetAssistantId,
        })
        .from(campaignOrders)
        .where(and(
            eq(campaignOrders.blockedOnOrderId, deliveredOrderId),
            eq(campaignOrders.status, 'blocked'),
        ));

    let released = 0;
    for (const next of waiting) {
        try {
            if (!next.targetAssistantId) {
                await db.update(campaignOrders)
                    .set({
                        status: 'cancelled',
                        resultSummary: 'The assistant this was waiting for is no longer in the workspace',
                        updatedAt: new Date(),
                    })
                    .where(eq(campaignOrders.id, next.id));
                continue;
            }

            // The campaign carries both the objective quoted into the mirror and the orchestrator's
            // own assistant id (campaigns.ai_assistant_id) — the Data Hub row belongs to the
            // orchestrator's workspace, not the workspace of whoever receives the order.
            const [campaign] = await db
                .select({ objective: campaigns.objective, orchestratorId: campaigns.aiAssistantId, status: campaigns.status })
                .from(campaigns)
                .where(eq(campaigns.id, next.campaignId))
                .limit(1);
            if (!campaign) continue;

            // A campaign that stopped while its chain waited must not have the chain resume behind
            // it. Only a live campaign releases work.
            if (campaign.status !== 'active' && campaign.status !== 'throttled') {
                await db.update(campaignOrders)
                    .set({
                        status: 'cancelled',
                        resultSummary: 'The campaign was no longer running when this became due',
                        updatedAt: new Date(),
                    })
                    .where(eq(campaignOrders.id, next.id));
                continue;
            }

            const [target] = await db
                .select({ userId: aiAssistants.userId })
                .from(aiAssistants)
                .where(eq(aiAssistants.id, next.targetAssistantId))
                .limit(1);
            if (!target) continue;

            await issueOrder(db, next.id, {
                organisationId: next.organisationId,
                campaignId: next.campaignId,
                orchestratorAssistantId: campaign.orchestratorId,
                campaignObjective: campaign.objective,
                action: next.action as CampaignOrderAction,
                brief: (next.brief ?? {}) as Record<string, unknown>,
                workItems: next.costWorkItems,
                targetAssistantId: next.targetAssistantId,
                targetUserId: target.userId,
            });
            released++;
        } catch (err) {
            console.error('[campaign-reconciler] could not release blocked order', { orderId: next.id, err });
        }
    }
    return released;
}

/**
 * Settle one order: write the new status, mirror it into the Data Hub, and refund the ledger if
 * the work it was charged for never materialised.
 */
async function settleOrder(
    db: Db,
    order: {
        id: number; organisationId: number; campaignId: number; action: string;
        costWorkItems: number;
    },
    verdict: Extract<Verdict, { kind: 'in_review' | 'delivered' | 'rejected' | 'failed' }>,
    result: ReconcileResult,
): Promise<void> {
    const status = verdict.kind === 'failed' ? 'cancelled' : verdict.kind;
    const terminal = status === 'delivered' || status === 'rejected' || status === 'cancelled';

    await db.update(campaignOrders)
        .set({
            status,
            resultSummary: verdict.summary,
            deliveredAt: status === 'delivered' ? new Date() : null,
            updatedAt: new Date(),
        })
        .where(eq(campaignOrders.id, order.id));

    // The charge happened on ISSUE, which is right: the work was commissioned and the target's
    // engine took it on. But when the commission produced nothing at all, the campaign has been
    // billed part of the user's monthly allowance for work that does not exist. Correct it the way
    // this family always corrects an append-only ledger — a compensating negative row, never an
    // edit. A rejected order is NOT refunded: the assistants really did the work, the user simply
    // did not want it, and hiding that cost would make the budget lie about capacity actually used.
    if (verdict.kind === 'failed' && order.costWorkItems > 0) {
        await recordCampaignSpend(db, {
            organisationId: order.organisationId,
            campaignId: order.campaignId,
            orderId: order.id,
            currency: 'work',
            amount: -order.costWorkItems,
            reason: `Refund — ${ORDER_ACTION_SPECS[order.action as CampaignOrderAction]?.label ?? order.action} produced nothing`,
        });
        result.refundedWork += order.costWorkItems;
    }

    // Best-effort, exactly as on the issue path: a failed mirror must never fail the settlement.
    try {
        const [campaign] = await db
            .select({ objective: campaigns.objective, orchestratorId: campaigns.aiAssistantId })
            .from(campaigns)
            .where(eq(campaigns.id, order.campaignId))
            .limit(1);
        if (campaign) {
            await mirrorOrder(db, {
                organisationId: order.organisationId,
                aiAssistantId: campaign.orchestratorId,
                orderId: order.id,
                campaignObjective: campaign.objective,
                action: order.action as CampaignOrderAction,
                status,
                targetRoleLabel: ORDER_ACTION_SPECS[order.action as CampaignOrderAction]?.roleKey ?? order.action,
                workItems: verdict.kind === 'failed' ? 0 : order.costWorkItems,
                resultSummary: verdict.summary,
            });
        }
    } catch (err) {
        console.error('[campaign-reconciler] mirror failed', { orderId: order.id, err });
    }

    if (verdict.kind === 'in_review') result.toReview++;
    else if (verdict.kind === 'delivered') result.delivered++;
    else if (verdict.kind === 'rejected') result.rejected++;
    else result.failed++;

    if (status === 'delivered') result.unblocked += await unblockChain(db, order.id);
    else if (terminal) {
        // The chain will never come. Cancel what was waiting rather than leaving it 'blocked' for
        // ever — a blocked order with a dead predecessor is exactly the silent stall this file
        // exists to remove.
        await db.update(campaignOrders)
            .set({
                status: 'cancelled',
                resultSummary: 'The work this was waiting for did not happen',
                updatedAt: new Date(),
            })
            .where(and(
                eq(campaignOrders.blockedOnOrderId, order.id),
                eq(campaignOrders.status, 'blocked'),
            ));
    }
}

/**
 * Sweep campaigns past the end date the user set.
 *
 * Only active|throttled are eligible. A paused campaign stays paused whatever the date says —
 * pausing was a human decision with a recorded reason, and finishing it here would erase that.
 */
async function sweepExpiredCampaigns(db: Db, result: ReconcileResult): Promise<void> {
    const due = await db
        .select({ id: campaigns.id, organisationId: campaigns.organisationId })
        .from(campaigns)
        .where(and(
            inArray(campaigns.status, ['active', 'throttled']),
            isNotNull(campaigns.endsAt),
            lt(campaigns.endsAt, new Date()),
        ))
        .limit(CAMPAIGN_BATCH);

    for (const campaign of due) {
        try {
            await db.update(campaigns)
                .set({ status: 'finished', updatedAt: new Date() })
                .where(and(eq(campaigns.id, campaign.id), inArray(campaigns.status, ['active', 'throttled'])));

            // Orders that never got going will never get going now. These were never charged —
            // spend is recorded on issue — so cancelling them needs no compensating row.
            await db.update(campaignOrders)
                .set({ status: 'cancelled', resultSummary: 'Campaign finished', updatedAt: new Date() })
                .where(and(
                    eq(campaignOrders.campaignId, campaign.id),
                    inArray(campaignOrders.status, ['queued', 'blocked']),
                ));

            result.finished++;
        } catch (err) {
            console.error('[campaign-reconciler] could not finish campaign', { campaignId: campaign.id, err });
        }
    }
}

/**
 * One reconciliation pass over every open order and every expired campaign.
 *
 * Never throws for one bad row: a single order that cannot be judged must not cost the rest of the
 * run, so each is wrapped and logged with its id.
 */
export async function reconcileCampaigns(db: Db): Promise<ReconcileResult> {
    const result: ReconcileResult = {
        examined: 0, toReview: 0, delivered: 0, rejected: 0, failed: 0,
        unblocked: 0, finished: 0, refundedWork: 0,
    };

    // 'issued' and 'in_review' are the two non-terminal states with work outstanding. in_review is
    // re-examined every pass because the user approving a post is exactly the event that turns it
    // into a delivery, and nothing tells us when that happened.
    const open = await db
        .select({
            id: campaignOrders.id,
            organisationId: campaignOrders.organisationId,
            campaignId: campaignOrders.campaignId,
            action: campaignOrders.action,
            status: campaignOrders.status,
            artefactId: campaignOrders.artefactId,
            costWorkItems: campaignOrders.costWorkItems,
            assistantRecordId: campaignOrders.assistantRecordId,
            issuedAt: campaignOrders.issuedAt,
        })
        .from(campaignOrders)
        .where(inArray(campaignOrders.status, ['issued', 'in_review']))
        .limit(ORDER_BATCH);

    for (const order of open) {
        result.examined++;
        try {
            const verdict = CONTENT_ACTIONS.includes(order.action as CampaignOrderAction)
                ? await judgeContentOrder(db, order)
                : order.action === 'run_lead_search'
                    ? await judgeLeadSearchOrder(db, order)
                    // narrow_targeting and adjust_messaging are terminal the moment they are
                    // issued, so they never appear here. If one does, something set the status by
                    // hand — leave it alone rather than inventing a delivery.
                    : { kind: 'unknowable' as const };

            if (verdict.kind === 'pending' || verdict.kind === 'unknowable') continue;
            // Forward only: an order already sitting in 'in_review' must not be rewritten to
            // 'in_review' every hour, which would churn the mirror and the updated_at clock.
            if (verdict.kind === 'in_review' && order.status === 'in_review') continue;

            await settleOrder(db, order, verdict, result);
        } catch (err) {
            console.error('[campaign-reconciler] order failed', { orderId: order.id, err });
        }
    }

    await sweepExpiredCampaigns(db, result);
    return result;
}
