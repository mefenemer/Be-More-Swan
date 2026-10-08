// src/utils/campaign-plan.ts
// A plan agreed in chat becomes a pending STRATEGY decision. docs/campaign-orchestrator-plan.md §9.1.
//
// ── The hole this fills ─────────────────────────────────────────────────────────────────────────
// The chat's campaign_strategy_proposal card always carried `orders` — who to brief, with what —
// and nothing kept them. `onCampaignCreate` posted the objective and dropped the orders; `create`
// would have ignored them anyway; and decision kind 'strategy', which campaigns.ts `decide` already
// treats as "place these orders and start the campaign", was inserted by nothing. So a campaign
// agreed in chat and then started briefed nobody, and with no orders the §13 directive steered no
// drafting either. Prod's only campaign ran for eight days that way.
//
// ── Why a decision, not orders placed on the spot ───────────────────────────────────────────────
// §1.3: approving in chat SAVES, it never STARTS. Placing orders IS starting — it commits the
// month's allowance across other assistants. So the chat's orders are filed as a pending decision
// and only a human approval (Campaigns tab, or the Decisions queue) places them. `decide` applies
// them verbatim; the model gets no second turn between that approval and execution.
//
// ── Rules ───────────────────────────────────────────────────────────────────────────────────────
// 1. One pending plan per campaign. A newer plan SUPERSEDES the older one rather than queuing
//    beside it — two live plans for one campaign means approving both and paying twice.
// 2. Evidence is built from the closed vocabulary, never from model prose. The model's rationale
//    is not stored here: the card the user approved in chat already showed it, and a decision card
//    is a record of facts (campaign-proposer.ts's rule, kept).

import { and, desc, eq, sql } from 'drizzle-orm';
import { campaignBudgets, campaignDecisions, campaigns, discoveryCampaigns } from '../../db/schema';
import { persistProposal, type LiveCampaign, type ProposedDecision } from './campaign-proposer';
import { settleDecisionMirror } from './campaign-mirror';
import { campaignSpendTotals } from './campaign-ledger';
import { audienceLine } from '../config/campaign-audience';
import {
    CAMPAIGN_STATUS_LABELS, ORDER_ACTION_SPECS, isOrderAction, orderWorkItems,
    type CampaignOrderAction, type CampaignStatus,
} from '../config/campaign-vocab';

type Db = Parameters<typeof persistProposal>[0];

/** More than this in one plan is a model listing everything it can think of, not a plan. */
export const MAX_PLAN_ORDERS = 10;

/** Upper bound for any order; each action's own cap is ORDER_ACTION_SPECS[action].maxQuantity. */
export const MAX_ORDER_QUANTITY = 20;

/** Named for the user, matching the catalog names and the chat proposal card. */
export const ORDER_ROLE_LABELS: Record<string, string> = {
    social_media_manager: 'Social Media Assistant',
    blog_writer: 'Blog Writing Assistant',
    lead_qualifier: 'Lead Generation Assistant',
};

/** Campaign states a plan may be filed against and approved on. Paused needs a Resume first. */
export const PLANNABLE_STATUSES: readonly CampaignStatus[] = ['draft', 'active', 'throttled'];

export interface PlanOrder {
    action: CampaignOrderAction;
    quantity: number;
    brief: Record<string, unknown>;
}

/**
 * The brief fields something actually READS, and how long each may be. Anything else is dropped:
 * a field no executor or blueprint reads is a promise to the user that nothing keeps.
 *   angle / audience      → blueprint section 13-campaign (campaign-directive.ts)
 *   idea / name           → run_lead_search, narrow_targeting (campaign-orders.ts executors)
 *   discoveryCampaignId   → narrow_targeting: WHICH saved search to tighten
 * `quantity` is not here on purpose — placeOrder writes it from the priced quantity, so the
 * number drafted can never differ from the number charged.
 */
const BRIEF_TEXT_FIELDS: Record<string, number> = { angle: 300, audience: 300, idea: 1000, name: 120 };

function cleanBrief(rec: Record<string, unknown>): Record<string, unknown> {
    // Accept the fields either flat on the order (the chat wire shape — simpler for a model to
    // emit) or nested under `brief` (the GUI's place_order payload).
    const src = { ...(rec.brief && typeof rec.brief === 'object' ? rec.brief as Record<string, unknown> : {}), ...rec };
    const out: Record<string, unknown> = {};
    for (const [k, max] of Object.entries(BRIEF_TEXT_FIELDS)) {
        const v = src[k];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, max);
    }
    const dc = Math.floor(Number(src.discoveryCampaignId));
    if (Number.isInteger(dc) && dc > 0) out.discoveryCampaignId = dc;
    return out;
}

/**
 * Turn whatever arrived over the wire into orders the executor actually has.
 *
 * Pure and total. Unknown actions are DROPPED rather than refused: the chat card already hides any
 * order it cannot name, so the user never saw them, and refusing the whole plan over one invented
 * action would throw away the parts they did agree to. `assignedRole` is ignored — the action alone
 * decides the receiving assistant (ORDER_ACTION_SPECS), so a mismatched pair cannot misroute.
 * Used by BOTH the chat plan path and the GUI's place_order, so the two validate identically.
 */
export function normalisePlanOrders(raw: unknown): PlanOrder[] {
    if (!Array.isArray(raw)) return [];
    const out: PlanOrder[] = [];
    for (const o of raw) {
        if (!o || typeof o !== 'object') continue;
        const rec = o as Record<string, unknown>;
        if (!isOrderAction(rec.action)) continue;
        const spec = ORDER_ACTION_SPECS[rec.action];
        const q = Math.floor(Number(rec.quantity));
        const quantity = spec.takesQuantity && Number.isFinite(q)
            ? Math.max(1, Math.min(spec.maxQuantity, MAX_ORDER_QUANTITY, q))
            : 1;
        out.push({ action: rec.action, quantity, brief: cleanBrief(rec) });
        if (out.length >= MAX_PLAN_ORDERS) break;
    }
    return out;
}

/**
 * Why this order cannot run, as a sentence — or null when it can.
 *
 * Checked when the plan is FILED, not only when it is approved: a lead search with no description
 * of who to find fails in its executor, and finding that out after the user approved it means they
 * agreed to work that was never going to happen.
 */
export function planOrderProblem(o: PlanOrder): string | null {
    const label = ORDER_ACTION_SPECS[o.action].label;
    if (o.action === 'run_lead_search' && !o.brief.idea) {
        return `"${label}" needs a description of who to look for.`;
    }
    if (o.action === 'narrow_targeting' && !o.brief.discoveryCampaignId) {
        return `"${label}" needs to know which saved search to tighten.`;
    }
    if (o.action === 'adjust_messaging' && !o.brief.angle) {
        return `"${label}" needs the new angle to take.`;
    }
    return null;
}

/** The first problem in a plan, or null. */
export function planProblem(orders: PlanOrder[]): string | null {
    for (const o of orders) {
        const p = planOrderProblem(o);
        if (p) return p;
    }
    return null;
}

/** Total work items a plan would commit. */
export function planWorkItems(orders: PlanOrder[]): number {
    return orders.reduce((n, o) => n + orderWorkItems(o.action, o.quantity), 0);
}

/**
 * The decision a plan becomes. Pure.
 *
 * The title says what approving DOES, because that is the question the card has to answer: on a
 * draft it starts the campaign, on a running one it only adds work.
 */
export function buildStrategyProposal(orders: PlanOrder[], campaignStatus: string): ProposedDecision {
    const n = orders.length;
    const briefs = `${n} ${n === 1 ? 'brief' : 'briefs'}`;
    const isDraft = campaignStatus === 'draft';
    return {
        kind: 'strategy',
        title: isDraft ? `Start this campaign with ${briefs}` : `Add ${briefs} to this campaign`,
        evidence: [
            ...orders.map((o) => {
                const spec = ORDER_ACTION_SPECS[o.action];
                const items = orderWorkItems(o.action, o.quantity);
                return {
                    label: ORDER_ROLE_LABELS[spec.roleKey] ?? spec.roleKey,
                    value: `${spec.label}${o.quantity > 1 ? ` ×${o.quantity}` : ''}`,
                    detail: `${items} ${items === 1 ? 'task' : 'tasks'}`,
                };
            }),
            { label: 'Where this came from', value: 'Agreed in conversation with your Campaign Assistant' },
        ],
        costOfInaction: isDraft
            ? 'The campaign stays a draft: nothing is commissioned and no assistant is briefed.'
            : 'None of this work is commissioned. The campaign carries on with what it already has.',
        orders: orders.map((o) => ({ action: o.action, brief: o.brief, quantity: o.quantity })),
    };
}

/**
 * File a plan against a campaign, superseding any plan still pending for it.
 *
 * Returns the new decision id, or null if nothing was filed (empty plan, or the insert lost a
 * race). Never places an order — see the file header.
 */
export async function fileStrategyPlan(
    db: Db, campaign: LiveCampaign & { status: string }, orders: PlanOrder[],
): Promise<number | null> {
    if (!orders.length) return null;

    const pending = await db
        .select({ id: campaignDecisions.id })
        .from(campaignDecisions)
        .where(and(
            eq(campaignDecisions.campaignId, campaign.id),
            eq(campaignDecisions.kind, 'strategy'),
            eq(campaignDecisions.status, 'pending'),
        ));
    for (const d of pending) {
        await db.update(campaignDecisions)
            .set({ status: 'superseded', updatedAt: new Date() })
            .where(eq(campaignDecisions.id, d.id));
        // The mirror's approval vocabulary has no 'superseded'; 'rejected' takes it off the queue
        // and the badge, which is all the mirror is for. The campaign side keeps the precise truth.
        await settleDecisionMirror(db, d.id, 'rejected');
    }

    return persistProposal(db, campaign, buildStrategyProposal(orders, campaign.status));
}

/**
 * The plan waiting on a campaign, shaped for the Campaigns tab row. Null when there is none.
 */
export async function pendingPlanFor(db: Db, campaignId: number): Promise<{
    decisionId: number; workItems: number; expiresAt: Date;
    orders: Array<{ action: string; label: string; role: string; quantity: number; workItems: number }>;
} | null> {
    const [d] = await db
        .select({
            id: campaignDecisions.id,
            proposed: campaignDecisions.proposed,
            costWorkItems: campaignDecisions.costWorkItems,
            expiresAt: campaignDecisions.expiresAt,
        })
        .from(campaignDecisions)
        .where(and(
            eq(campaignDecisions.campaignId, campaignId),
            eq(campaignDecisions.kind, 'strategy'),
            eq(campaignDecisions.status, 'pending'),
            sql`${campaignDecisions.expiresAt} > now()`,
        ))
        .orderBy(desc(campaignDecisions.createdAt))
        .limit(1);
    if (!d) return null;

    const orders = normalisePlanOrders((d.proposed as { orders?: unknown } | null)?.orders).map((o) => {
        const spec = ORDER_ACTION_SPECS[o.action];
        return {
            action: o.action,
            label: spec.label,
            role: ORDER_ROLE_LABELS[spec.roleKey] ?? spec.roleKey,
            quantity: o.quantity,
            workItems: orderWorkItems(o.action, o.quantity),
        };
    });
    return { decisionId: d.id, workItems: Number(d.costWorkItems) || 0, expiresAt: d.expiresAt, orders };
}

/** Campaigns listed to the chat. A workspace runs a handful; more than this is a list to page. */
const SNAPSHOT_CAMPAIGNS = 15;

/**
 * What the chat knows about this assistant's campaigns, counted per turn.
 *
 * Without it the chat can only ever create — "add two blog posts to the spring campaign" has no
 * campaign to point at, so the assistant either invents an id or makes a duplicate campaign. Same
 * shape and same failure mode as buildLeadsSnapshot() in chat-orchestrator.ts. Never throws: a
 * snapshot is context, not the conversation.
 */
export async function buildCampaignsSnapshot(
    db: Db, organisationId: number, aiAssistantId: number,
): Promise<string | null> {
    try {
        const rows = await db
            .select({
                id: campaigns.id,
                objective: campaigns.objective,
                status: campaigns.status,
                targetValue: campaigns.targetValue,
                outcomeMetric: campaigns.outcomeMetric,
                endsAt: campaigns.endsAt,
                audience: campaigns.audience,
                excludeExistingCustomers: campaigns.excludeExistingCustomers,
                maxWorkItems: campaignBudgets.maxWorkItems,
            })
            .from(campaigns)
            .leftJoin(campaignBudgets, eq(campaignBudgets.campaignId, campaigns.id))
            .where(and(
                eq(campaigns.organisationId, organisationId),
                eq(campaigns.aiAssistantId, aiAssistantId),
                sql`${campaigns.status} <> 'archived'`,
            ))
            .orderBy(desc(campaigns.createdAt))
            .limit(SNAPSHOT_CAMPAIGNS);

        // narrow_targeting has to name WHICH saved search to tighten, and the model has no other
        // way to learn the ids. Without this list every such order would be refused at filing.
        const searches = await db
            .select({ id: discoveryCampaigns.id, name: discoveryCampaigns.name, idea: discoveryCampaigns.idea })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.organisationId, organisationId), sql`${discoveryCampaigns.status} <> 'archived'`))
            .orderBy(desc(discoveryCampaigns.createdAt))
            .limit(SNAPSHOT_CAMPAIGNS);
        const searchBlock = searches.length
            ? `\nSAVED LEAD SEARCHES (the only valid discoveryCampaignId values for "narrow_targeting"):\n${searches
                .map((x) => `- discoveryCampaignId ${x.id}: ${x.name ? `"${x.name}" — ` : ''}${x.idea.slice(0, 160)}`).join('\n')}`
            : '\nThere are no saved lead searches, so "narrow_targeting" cannot be used — propose "run_lead_search" instead.';

        if (!rows.length) {
            return `YOUR CAMPAIGNS RIGHT NOW — this assistant has no campaigns yet. Anything the user wants to run is a NEW campaign.${searchBlock}`;
        }

        const lines: string[] = [];
        for (const r of rows) {
            const t = await campaignSpendTotals(db, r.id);
            const plan = await pendingPlanFor(db, r.id);
            const used = t.spentWork + t.committedWork;
            const label = CAMPAIGN_STATUS_LABELS[r.status as CampaignStatus] ?? r.status;
            const who = audienceLine(r.audience);
            lines.push(
                `- campaignId ${r.id}: "${r.objective}" — ${label}`
                + `${r.targetValue ? `, aiming for ${r.targetValue} ${r.outcomeMetric}` : ''}`
                + `${r.endsAt ? `, ends ${r.endsAt.toISOString().slice(0, 10)}` : ''}`
                + `, ${used} of ${r.maxWorkItems ?? 0} tasks used or committed`
                + `, ${who ? `for: ${who}` : 'no audience set'}`
                + `, ${r.excludeExistingCustomers ? 'leaves existing customers out of its lead searches' : 'INCLUDES existing customers'}`
                + `${plan ? `, a plan of ${plan.orders.length} briefs is waiting for the user's approval` : ''}`,
            );
        }
        return `YOUR CAMPAIGNS RIGHT NOW — read at the moment this message was sent. These are FACT: answer questions about the user's campaigns from here, never guess, and use these campaignId values (never invent one) when the user wants to change or add work to an existing campaign.
${lines.join('\n')}${searchBlock}`;
    } catch (err) {
        console.error('[campaign-plan] campaigns snapshot failed (non-fatal)', err);
        return null;
    }
}
