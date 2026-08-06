// src/utils/campaign-ledger.ts
// The ONE way to write a campaign_spend_events row, and the only place campaign budget arithmetic
// lives.
//
// Same contract as revenue-ledger.ts and lead-reject-feedback.ts: a single writer, so the
// invariants have exactly one place to be enforced. Here those invariants are:
//   * the ledger is APPEND-ONLY — a correction is a new negative row, never an UPDATE;
//   * spend is always attributed to a campaign, and to an order where one exists;
//   * a failed ledger write never fails the caller (see below).
//
// ── Two different numbers, never conflated ───────────────────────────────────
// COMMITTED is a forecast: the sum of what non-terminal orders were quoted at. It reserves
// nothing.
// SPENT is history: the sum of the ledger. Only work that actually happened appears here.
// A UI that shows one and labels it as the other is how a budget bar starts lying, so both are
// returned separately and the caller has to choose.
//
// ── And a third number that is NOT ours ──────────────────────────────────────
// `readPlanTaskGate` reads the org's billing task allowance. That is a DIFFERENT unit from a work
// item and it is not spent by campaigns — see the ⚠️ block in db/campaigns.sql. It is read here
// only as a GATE ("is this workspace able to run anything at all right now?") and must never be
// rendered as the campaign's budget.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    campaignOrders, campaignSpendEvents, masterPlans, plans, usageCounters,
} from '../../db/schema';
import { getPeriodStart } from './atomic-cap-check';
import { TERMINAL_ORDER_STATUSES } from '../config/campaign-vocab';

type Db = ReturnType<typeof getDb>;

export type SpendCurrency = 'work' | 'money';

export interface RecordSpendInput {
    organisationId: number;
    campaignId: number;
    /** The order this spend belongs to. Null only for campaign-level adjustments. */
    orderId?: number | null;
    currency: SpendCurrency;
    /** Signed. Negative = a compensating row (a cancelled order releasing its quote). */
    amount: number;
    /** Why, in a few words. Shown verbatim in the campaign's activity list. */
    reason: string;
}

/**
 * Append one spend event.
 *
 * NEVER THROWS. The work being recorded has already happened by the time this runs, and that
 * ordering is deliberate: failing an order because its ledger row could not be written would turn
 * a successful piece of work into a user-visible error over bookkeeping.
 *
 * The corollary — as everywhere in this family — is that silence is a real outcome. If a campaign
 * shows less spend than it should, look for the console.error below before concluding the call
 * site never ran.
 */
export async function recordCampaignSpend(db: Db, input: RecordSpendInput): Promise<number | null> {
    // A zero-amount row is noise: it moves no total and adds a line to the activity list that
    // says nothing happened. The steering-only order actions legitimately cost 0, so this is a
    // normal path, not an error.
    if (!Number.isFinite(input.amount) || input.amount === 0) return null;
    try {
        const [row] = await db.insert(campaignSpendEvents).values({
            organisationId: input.organisationId,
            campaignId: input.campaignId,
            orderId: input.orderId ?? null,
            currency: input.currency,
            amount: String(input.amount),
            reason: input.reason.slice(0, 500),
        }).returning({ id: campaignSpendEvents.id });
        return row?.id ?? null;
    } catch (err) {
        console.error('[campaign-ledger] spend write failed', {
            campaignId: input.campaignId, currency: input.currency, amount: input.amount, err,
        });
        return null;
    }
}

export interface CampaignSpendTotals {
    /** Work items actually consumed — the sum of the ledger. History. */
    spentWork: number;
    /** Money actually spent. Zero for the whole of Phase 1. */
    spentMoney: number;
    /** Work items quoted on orders that have not reached a terminal state. A FORECAST, not a reservation. */
    committedWork: number;
}

/**
 * Both numbers for one campaign, in one round trip each.
 *
 * `committedWork` deliberately excludes terminal orders. A delivered order's cost is already in
 * the ledger, so counting it in both would double it; a cancelled order's quote was released by a
 * compensating ledger row and counting it would resurrect spend that was given back.
 */
export async function campaignSpendTotals(db: Db, campaignId: number): Promise<CampaignSpendTotals> {
    const [totals] = await db
        .select({
            work: sql<string>`COALESCE(SUM(CASE WHEN ${campaignSpendEvents.currency} = 'work'  THEN ${campaignSpendEvents.amount} ELSE 0 END), 0)`,
            money: sql<string>`COALESCE(SUM(CASE WHEN ${campaignSpendEvents.currency} = 'money' THEN ${campaignSpendEvents.amount} ELSE 0 END), 0)`,
        })
        .from(campaignSpendEvents)
        .where(eq(campaignSpendEvents.campaignId, campaignId));

    const [committed] = await db
        .select({ work: sql<string>`COALESCE(SUM(${campaignOrders.costWorkItems}), 0)` })
        .from(campaignOrders)
        .where(and(
            eq(campaignOrders.campaignId, campaignId),
            // `notInArray` would exclude NULL statuses; the column is NOT NULL, but writing the
            // positive form keeps it true if that ever changes.
            sql`${campaignOrders.status} NOT IN ${sql.raw(`(${TERMINAL_ORDER_STATUSES.map(s => `'${s}'`).join(',')})`)}`,
        ));

    return {
        spentWork: Number(totals?.work ?? 0),
        spentMoney: Number(totals?.money ?? 0),
        committedWork: Number(committed?.work ?? 0),
    };
}

export interface BudgetVerdict {
    allowed: boolean;
    /** Work items that would remain after this order. Negative means it does not fit. */
    remainingAfter: number;
    /** User-facing refusal, already phrased for display. Null when allowed. */
    message: string | null;
}

/**
 * Would committing `workItems` more keep this campaign inside its ceiling?
 *
 * Compares against spent + committed, not just spent. Checking spent alone would let a campaign
 * queue unlimited work as long as none of it had run yet — the ceiling would only bite after the
 * budget was already gone, which is not a ceiling.
 */
export function fitsBudget(totals: CampaignSpendTotals, maxWorkItems: number, workItems: number): BudgetVerdict {
    const used = totals.spentWork + totals.committedWork;
    const remainingAfter = maxWorkItems - used - workItems;
    if (remainingAfter >= 0) return { allowed: true, remainingAfter, message: null };
    const left = Math.max(0, maxWorkItems - used);
    return {
        allowed: false,
        remainingAfter,
        message: `This campaign has ${left} of its ${maxWorkItems} pieces of work left, and this needs ${workItems}. Raise its workload limit or finish some outstanding work first.`,
    };
}

export interface PlanTaskGate {
    /** The org's monthly task allowance. Null = an uncapped paid tier. */
    limit: number | null;
    used: number;
    /** Null when `limit` is null. */
    remaining: number | null;
    /** True when the workspace can run nothing further this month. */
    atCap: boolean;
    /** True when there is no active/past_due plan at all — a paywall, not a cap. */
    noPlan: boolean;
}

/**
 * Read the org's billing task allowance. READ ONLY — this consumes nothing.
 *
 * ⚠️ This is NOT the campaign's budget and must never be rendered as one. It is a different unit
 * (a billing task, moved by chat turns and a few on-demand buttons) and campaigns do not spend it.
 * It is read for exactly one purpose: to refuse to start a campaign in a workspace that has hit
 * its plan cap, because the assistant it would give orders to cannot answer a chat turn either.
 *
 * Plan resolution mirrors consumeTaskCredit (active preferred, then past_due, so a lapsed plan
 * keeps its limits through the grace window). Kept as a separate read rather than a call into
 * task-credit.ts because that module's whole job is to INCREMENT, and this must not.
 */
export async function readPlanTaskGate(db: Db, organisationId: number): Promise<PlanTaskGate> {
    const [plan] = await db
        .select({ monthlyTaskLimit: masterPlans.monthlyTaskLimit })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, organisationId), inArray(plans.status, ['active', 'past_due'])))
        .orderBy(plans.status, plans.startedAt)
        .limit(1);

    if (!plan) return { limit: null, used: 0, remaining: null, atCap: true, noPlan: true };

    // Counter of record: usage_counters, by ORGANISATION, on a UTC calendar month. Never
    // re-derived from task_runs — that read is by userId on a local-time month and disagrees
    // with enforcement.
    const [counter] = await db
        .select({ taskCount: usageCounters.taskCount })
        .from(usageCounters)
        .where(and(
            eq(usageCounters.organisationId, organisationId),
            eq(usageCounters.periodStart, getPeriodStart()),
        ))
        .limit(1);

    const used = counter?.taskCount ?? 0;
    const limit = plan.monthlyTaskLimit ?? null;
    if (limit === null) return { limit: null, used, remaining: null, atCap: false, noPlan: false };
    return { limit, used, remaining: Math.max(0, limit - used), atCap: used >= limit, noPlan: false };
}
