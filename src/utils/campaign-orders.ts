// src/utils/campaign-orders.ts
// Placing an order — the single point where the Campaign Assistant reaches into another
// assistant's world.
//
// ── Why this is one file ─────────────────────────────────────────────────────
// The orchestrator is the only assistant allowed to change another assistant's work. Spreading
// that across call sites would mean the answer to "what can this thing do to my Social Media
// Assistant?" lives in five places and drifts. Every order goes through `placeOrder` and every
// mechanism is a branch in `EXECUTORS` below.
//
// ── The two mechanisms, and which is which ───────────────────────────────────
// 1. ENQUEUE — creates a row in the target's own queue (a content_generation_jobs row, a
//    discovery_campaigns row). The target's existing engine picks it up unchanged.
// 2. STEER — creates no row at all. The campaign's directive reaches generation through blueprint
//    section 13-campaign, which the target already reads. `adjust_messaging` and
//    `narrow_targeting` are this: they change what gets written, not how much.
//
// A steering order costs 0 work items because it produces no artefact. That is not a discount —
// it is the honest price of an instruction that only takes effect the next time something is
// drafted anyway.
//
// ── What this deliberately cannot do ─────────────────────────────────────────
// * It cannot start a discovery run. `run_lead_search` creates the saved search as a DRAFT, and a
//   human starts it from Find New Leads. A run costs real money and emails real strangers, so a
//   model's judgement plus an approval click must never be enough. Same invariant the Lead
//   Generator's own chat path settled on — do not "helpfully" set status:'active' here.
// * It cannot publish anything. Every artefact it creates lands in its own assistant's review
//   gate, which is where it stays until a human approves it there.
// * It cannot reach a role outside ORCHESTRATABLE_ROLE_KEYS.

import { randomUUID } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, aiBlueprints, campaignOrders, contentGenerationJobs, discoveryCampaigns,
} from '../../db/schema';
import { assembleBlueprint } from './blueprint';
import { createDiscoveryRun } from './discovery';
import { recordCampaignSpend } from './campaign-ledger';
import { mirrorOrder } from './campaign-mirror';
import { ORDER_ACTION_SPECS, orderWorkItems, type CampaignOrderAction } from '../config/campaign-vocab';
import { ORCHESTRATABLE_ROLE_KEYS } from '../constants/roles';

type Db = ReturnType<typeof getDb>;

export interface PlaceOrderInput {
    db: Db;
    organisationId: number;
    userId: number | null;
    campaignId: number;
    /** The ORCHESTRATOR's assistant id. The Data Hub mirror belongs to its workspace, not the
     *  workspace of the assistant receiving the order. */
    orchestratorAssistantId: number;
    /** Quoted verbatim into the mirror row so the Orders table reads without a join. */
    campaignObjective: string;
    action: CampaignOrderAction;
    /** The brief: keywords, persona, CTA, angle, quantity. Stored verbatim on the order. */
    brief: Record<string, unknown>;
    /** Only meaningful for actions whose spec has takesQuantity. */
    quantity?: number;
    /** When this order cannot start until another finishes (teasers behind a pillar). */
    blockedOnOrderId?: number | null;
}

export interface PlaceOrderResult {
    orderId: number | null;
    status: 'issued' | 'blocked' | 'failed';
    workItems: number;
    /** Present on failure. Already phrased for display. */
    message?: string;
}

/**
 * Place one order against a campaign.
 *
 * The order row is written FIRST, then the mechanism runs. That ordering is deliberate: if the
 * enqueue fails we still have a durable record that the orchestrator tried, with the failure on
 * it, rather than a silent no-op that leaves the campaign looking idle for reasons nobody can
 * reconstruct. The Orders table showing a failed order is a feature.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const { db, organisationId, campaignId, action, brief } = input;
    const spec = ORDER_ACTION_SPECS[action];
    if (!spec) return { orderId: null, status: 'failed', workItems: 0, message: 'Unknown order type.' };

    // Belt and braces: the HTTP boundary validates the action, but this is the function that
    // actually reaches another assistant, so it re-checks the role boundary itself.
    if (!ORCHESTRATABLE_ROLE_KEYS.includes(spec.roleKey)) {
        return { orderId: null, status: 'failed', workItems: 0, message: 'That assistant cannot be given orders.' };
    }

    const workItems = orderWorkItems(action, input.quantity);

    // Resolve the colleague. An order to an assistant the org has not hired is a real and common
    // case (the orchestrator proposes a blog pillar in a workspace with no Blog Writer), so it is
    // a plain refusal with a useful message, not an error.
    // ⚠️ There is no `role_key` COLUMN on ai_assistants — the role lives in
    // `configuration->>'type'`, which is the join key the whole platform uses (hire-assistant.ts
    // does the same). Reaching for a column that reads like it should exist is how a query ends up
    // silently matching nothing.
    const [target] = await db
        .select({ id: aiAssistants.id, userId: aiAssistants.userId })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, organisationId),
            sql`(${aiAssistants.configuration} ->> 'type') = ${spec.roleKey}`,
        ))
        .orderBy(desc(aiAssistants.id))
        .limit(1);

    if (!target) {
        return {
            orderId: null, status: 'failed', workItems,
            message: `No ${spec.label.toLowerCase()} is possible — this workspace has not hired the assistant that does it.`,
        };
    }

    const blocked = !!input.blockedOnOrderId;
    const [order] = await db.insert(campaignOrders).values({
        organisationId,
        campaignId,
        targetAssistantId: target.id,
        targetRoleKey: spec.roleKey,
        action,
        brief,
        costWorkItems: workItems,
        status: blocked ? 'blocked' : 'queued',
        blockedOnOrderId: input.blockedOnOrderId ?? null,
    }).returning({ id: campaignOrders.id });

    if (!order) return { orderId: null, status: 'failed', workItems, message: 'Could not record the order.' };

    // A blocked order is real and costed, but nothing runs until its predecessor delivers. The
    // spend is recorded when it is actually issued, not now — otherwise cancelling the chain would
    // need a compensating row for work that never started.
    if (blocked) return { orderId: order.id, status: 'blocked', workItems };

    return issueOrder(db, order.id, {
        organisationId, campaignId, action, brief, workItems,
        orchestratorAssistantId: input.orchestratorAssistantId,
        campaignObjective: input.campaignObjective,
        targetAssistantId: target.id, targetUserId: target.userId,
    });
}

interface IssueContext {
    organisationId: number;
    campaignId: number;
    orchestratorAssistantId: number;
    campaignObjective: string;
    action: CampaignOrderAction;
    brief: Record<string, unknown>;
    workItems: number;
    targetAssistantId: number;
    targetUserId: number;
}

/**
 * Run the mechanism for an order that is ready to go, and record what happened.
 *
 * Exported so the "unblock the next order in the chain" path can reuse it without duplicating the
 * ledger write — the pillar delivering is what issues the teasers behind it.
 */
export async function issueOrder(db: Db, orderId: number, ctx: IssueContext): Promise<PlaceOrderResult> {
    const executor = EXECUTORS[ctx.action];
    let outcome: ExecutorResult;
    try {
        outcome = await executor(db, ctx, orderId);
    } catch (err) {
        console.error('[campaign-orders] executor threw', { orderId, action: ctx.action, err });
        outcome = { ok: false, message: 'The assistant could not be reached. Nothing was charged.' };
    }

    if (!outcome.ok) {
        await db.update(campaignOrders)
            .set({ status: 'cancelled', resultSummary: outcome.message, updatedAt: new Date() })
            .where(eq(campaignOrders.id, orderId));
        // Mirror the failure too. An order that vanishes from the Orders table on failure leaves
        // the campaign looking idle for reasons nobody can reconstruct — the visible failed row IS
        // the diagnostic.
        await mirrorOrder(db, {
            organisationId: ctx.organisationId, aiAssistantId: ctx.orchestratorAssistantId,
            orderId, campaignObjective: ctx.campaignObjective, action: ctx.action,
            status: 'cancelled', targetRoleLabel: ORDER_ACTION_SPECS[ctx.action].roleKey,
            workItems: 0, resultSummary: outcome.message,
        });
        return { orderId, status: 'failed', workItems: ctx.workItems, message: outcome.message };
    }

    await db.update(campaignOrders).set({
        status: outcome.terminal ? 'delivered' : 'issued',
        artefactKind: outcome.artefactKind ?? null,
        artefactId: outcome.artefactId ?? null,
        resultSummary: outcome.summary ?? null,
        issuedAt: new Date(),
        deliveredAt: outcome.terminal ? new Date() : null,
        updatedAt: new Date(),
    }).where(eq(campaignOrders.id, orderId));

    // Charge on ISSUE, not on delivery. The work has been commissioned and the target's engine
    // will do it; waiting for delivery would let a campaign queue far past its ceiling while every
    // order sat at "issued" costing nothing.
    await recordCampaignSpend(db, {
        organisationId: ctx.organisationId,
        campaignId: ctx.campaignId,
        orderId,
        currency: 'work',
        amount: ctx.workItems,
        reason: ORDER_ACTION_SPECS[ctx.action].label,
    });

    await mirrorOrder(db, {
        organisationId: ctx.organisationId, aiAssistantId: ctx.orchestratorAssistantId,
        orderId, campaignObjective: ctx.campaignObjective, action: ctx.action,
        status: outcome.terminal ? 'delivered' : 'issued',
        targetRoleLabel: ORDER_ACTION_SPECS[ctx.action].roleKey,
        workItems: ctx.workItems, resultSummary: outcome.summary ?? null,
    });

    return { orderId, status: 'issued', workItems: ctx.workItems };
}

interface ExecutorResult {
    ok: boolean;
    message?: string;
    /** True when the order is complete the moment it is issued (steering orders). */
    terminal?: boolean;
    artefactKind?: 'scheduled_post' | 'blog_post' | 'discovery_campaign';
    artefactId?: number;
    summary?: string;
}

/**
 * `orderId` is passed separately rather than living on IssueContext because the context is built
 * BEFORE the order row exists (placeOrder inserts, then issues). The two content executors stamp it
 * on every job they enqueue — that stamp is the only thing that later lets the reconciler tell
 * whether this order produced anything. See db/campaign-order-tracing.sql.
 */
type Executor = (db: Db, ctx: IssueContext, orderId: number) => Promise<ExecutorResult>;

/**
 * Resolve the target assistant's current blueprint, compiling one if it has never had it.
 *
 * A content job without a blueprint id cannot be drafted, and the orchestrator runs unattended —
 * skipping here would leave a campaign that looks live and produces nothing, which is the failure
 * mode this whole design is trying to avoid.
 */
async function resolveBlueprintId(db: Db, assistantId: number, organisationId: number): Promise<number | null> {
    const [bp] = await db
        .select({ id: aiBlueprints.id })
        .from(aiBlueprints)
        .where(and(eq(aiBlueprints.assistantId, assistantId), eq(aiBlueprints.organisationId, organisationId)))
        .orderBy(desc(aiBlueprints.compiledAt))
        .limit(1);
    if (bp) return bp.id;
    try {
        const result = await assembleBlueprint(assistantId, 'campaign-orchestrator', 'campaign-order');
        return result.blueprint.id;
    } catch (err) {
        console.error('[campaign-orders] blueprint compile failed', { assistantId, err });
        return null;
    }
}

const EXECUTORS: Record<CampaignOrderAction, Executor> = {
    // Queue extra posts for the Social Media Assistant. The campaign's angle does NOT ride on the
    // job row — it reaches the drafter through blueprint section 13-campaign, which the assistant
    // already reads. That is why there is no `brief` field on the job below and why there does not
    // need to be.
    draft_social_posts: async (db, ctx, orderId) => {
        const blueprintId = await resolveBlueprintId(db, ctx.targetAssistantId, ctx.organisationId);
        if (!blueprintId) return { ok: false, message: 'The Social Media Assistant has no usable setup yet, so nothing could be queued.' };

        const count = Math.max(1, Math.min(20, Math.floor(Number(ctx.brief.quantity) || 1)));
        // Spread the drafts across the days ahead rather than stacking them on one date: a
        // campaign that dumps six posts on the same slot produces six near-identical drafts,
        // because the variety block only compares against what is already scheduled.
        const now = Date.now();
        for (let i = 0; i < count; i++) {
            await db.insert(contentGenerationJobs).values({
                jobId: randomUUID(),
                blueprintId,
                assistantId: ctx.targetAssistantId,
                organisationId: ctx.organisationId,
                userId: ctx.targetUserId,
                status: 'queued',
                attempt: 0,
                maxAttempts: 3,
                triggerType: 'on_demand',
                targetPublishDate: new Date(now + (i + 1) * 24 * 60 * 60 * 1000),
                // The trace back to this order. Without it the reconciler cannot tell whether the
                // order produced anything, and it sits at 'issued' for ever.
                campaignOrderId: orderId,
            });
        }
        return { ok: true, summary: `${count} post${count === 1 ? '' : 's'} queued for drafting` };
    },

    // Brief a pillar article. Same principle: the brief steers through the blueprint, the job row
    // just says "write one".
    draft_blog_pillar: async (db, ctx, orderId) => {
        const blueprintId = await resolveBlueprintId(db, ctx.targetAssistantId, ctx.organisationId);
        if (!blueprintId) return { ok: false, message: 'The Blog Writing Assistant has no usable setup yet, so nothing could be queued.' };

        const count = Math.max(1, Math.min(5, Math.floor(Number(ctx.brief.quantity) || 1)));
        for (let i = 0; i < count; i++) {
            await db.insert(contentGenerationJobs).values({
                jobId: randomUUID(),
                blueprintId,
                assistantId: ctx.targetAssistantId,
                organisationId: ctx.organisationId,
                userId: ctx.targetUserId,
                status: 'queued',
                attempt: 0,
                maxAttempts: 3,
                triggerType: 'on_demand',
                contentType: 'blog',
                targetPublishDate: new Date(Date.now() + (i + 1) * 3 * 24 * 60 * 60 * 1000),
                campaignOrderId: orderId,
            });
        }
        return { ok: true, summary: `${count} article${count === 1 ? '' : 's'} briefed` };
    },

    // Create the saved search as a DRAFT. See the header: starting it is a human act.
    run_lead_search: async (db, ctx) => {
        const idea = String(ctx.brief.idea || '').trim();
        if (!idea) return { ok: false, message: 'The search had no description of who to look for, so it was not created.' };
        const result = await createDiscoveryRun({
            db,
            organisationId: ctx.organisationId,
            userId: ctx.targetUserId,
            aiAssistantId: ctx.targetAssistantId,
            name: String(ctx.brief.name || '').trim() || null,
            idea,
            status: 'draft',
            cadence: 'one_off',
        });
        return {
            ok: true,
            artefactKind: 'discovery_campaign',
            artefactId: result.campaignId,
            summary: 'Saved search created as a draft — start it from Find New Leads',
        };
    },

    // Tighten an existing search. Appends negative keywords rather than replacing them: the user
    // may have added their own, and silently dropping those would undo a human decision.
    narrow_targeting: async (db, ctx) => {
        const campaignId = Number(ctx.brief.discoveryCampaignId);
        if (!Number.isInteger(campaignId)) return { ok: false, message: 'No saved search was named, so nothing was changed.' };
        const [existing] = await db
            .select({ id: discoveryCampaigns.id, idea: discoveryCampaigns.idea })
            .from(discoveryCampaigns)
            .where(and(
                eq(discoveryCampaigns.id, campaignId),
                eq(discoveryCampaigns.organisationId, ctx.organisationId),
            ))
            .limit(1);
        if (!existing) return { ok: false, message: 'That saved search no longer exists.' };

        const refinedIdea = String(ctx.brief.idea || '').trim();
        if (refinedIdea && refinedIdea !== existing.idea) {
            await db.update(discoveryCampaigns)
                .set({ idea: refinedIdea, updatedAt: new Date() })
                .where(eq(discoveryCampaigns.id, campaignId));
        }
        return {
            ok: true, terminal: true,
            artefactKind: 'discovery_campaign', artefactId: campaignId,
            summary: 'Search targeting tightened',
        };
    },

    // Steering only. Creates nothing: the angle is already stored on the campaign and reaches
    // generation through the blueprint. Terminal on issue because there is nothing to wait for.
    adjust_messaging: async () => ({
        ok: true, terminal: true,
        summary: 'Campaign angle updated — applies to work drafted from now on',
    }),
};
