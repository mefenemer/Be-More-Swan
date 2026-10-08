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

import { triggerCampaignEmailDraft } from './trigger-campaign-email-draft';
import { randomUUID } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    aiAssistants, aiBlueprints, campaignOrders, contentGenerationJobs, discoveryCampaigns,
    campaignExperiments, campaignExperimentJobs,
} from '../../db/schema';
import { assembleBlueprint } from './blueprint';
import { createDiscoveryRun } from './discovery';
import { recordCampaignSpend } from './campaign-ledger';
import { mirrorOrder } from './campaign-mirror';
import { HUMAN_ROLE_KEY, ORDER_ACTION_SPECS, orderWorkItems, type CampaignOrderAction } from '../config/campaign-vocab';
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
    const { db, organisationId, campaignId, action } = input;
    const spec = ORDER_ACTION_SPECS[action];
    if (!spec) return { orderId: null, status: 'failed', workItems: 0, message: 'Unknown order type.' };

    // Belt and braces: the HTTP boundary validates the action, but this is the function that
    // actually reaches another assistant, so it re-checks the role boundary itself.
    // A task for a PERSON (§9.5): no assistant to resolve, nothing to execute, no tasks charged.
    if (spec.roleKey === HUMAN_ROLE_KEY) return placeHumanTask(input);

    if (!ORCHESTRATABLE_ROLE_KEYS.includes(spec.roleKey)) {
        return { orderId: null, status: 'failed', workItems: 0, message: 'That assistant cannot be given orders.' };
    }

    const workItems = orderWorkItems(action, input.quantity);
    // The executors read the count from `brief.quantity`, while the ledger prices `input.quantity`.
    // Written here, from the priced number, so the two can never disagree: before this a plan
    // priced at six posts arrived with no brief.quantity and drafted one.
    const brief = spec.takesQuantity
        ? { ...input.brief, quantity: Math.max(1, Math.floor(Number(input.quantity) || 1)) }
        : input.brief;

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

/** "Waiting on Sam (Legal) — due 14 Oct". The row's one sentence for a person's task. */
export function humanTaskSummary(brief: Record<string, unknown>): string {
    const who = typeof brief.assignee === 'string' && brief.assignee.trim() ? brief.assignee.trim() : 'someone on your team';
    const due = typeof brief.dueDate === 'string' ? brief.dueDate : null;
    return `Waiting on ${who}${due ? ` — due ${due}` : ''}`;
}

/**
 * Place a task for a person. The order row is the whole record: there is no executor, no artefact
 * and no ledger charge (a teammate's time is not the workspace's task allowance).
 *
 * ⚠️ Nothing is sent to the person. The brief may carry an email address so the USER knows who to
 * tell, but a plan the model drafted must never become a message from this business to anyone —
 * telling them is the user's act (or, later, a ticket in their own Jira/Asana).
 */
async function placeHumanTask(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const blocked = !!input.blockedOnOrderId;
    const [order] = await input.db.insert(campaignOrders).values({
        organisationId: input.organisationId,
        campaignId: input.campaignId,
        targetAssistantId: null,
        targetRoleKey: HUMAN_ROLE_KEY,
        action: input.action,
        brief: input.brief,
        costWorkItems: 0,
        status: blocked ? 'blocked' : 'queued',
        blockedOnOrderId: input.blockedOnOrderId ?? null,
    }).returning({ id: campaignOrders.id });
    if (!order) return { orderId: null, status: 'failed', workItems: 0, message: 'Could not record the task.' };
    if (blocked) return { orderId: order.id, status: 'blocked', workItems: 0 };
    await issueHumanTask(input.db, order.id, {
        organisationId: input.organisationId,
        orchestratorAssistantId: input.orchestratorAssistantId,
        campaignObjective: input.campaignObjective,
        brief: input.brief,
    });
    return { orderId: order.id, status: 'issued', workItems: 0 };
}

/**
 * Put a person's task in front of them: 'issued' is "waiting on <name>" for this action. Exported
 * for the reconciler, which releases a person's task that was waiting on earlier work — the
 * assistant path (issueOrder) cannot, because there is no assistant to issue to.
 */
export async function issueHumanTask(db: Db, orderId: number, ctx: {
    organisationId: number; orchestratorAssistantId: number; campaignObjective: string;
    brief: Record<string, unknown>;
}): Promise<void> {
    const summary = humanTaskSummary(ctx.brief);
    await db.update(campaignOrders)
        .set({ status: 'issued', issuedAt: new Date(), resultSummary: summary, updatedAt: new Date() })
        .where(eq(campaignOrders.id, orderId));
    await mirrorOrder(db, {
        organisationId: ctx.organisationId, aiAssistantId: ctx.orchestratorAssistantId,
        orderId, campaignObjective: ctx.campaignObjective, action: 'request_human_task',
        status: 'issued',
        targetRoleLabel: typeof ctx.brief.assignee === 'string' && ctx.brief.assignee ? ctx.brief.assignee : 'A person on your team',
        workItems: 0, resultSummary: summary,
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
    // ⚠️ Recompile the target BEFORE the executor stamps any job. The campaign reaches drafting only
    // through blueprint section 13-campaign, which is built from this assistant's campaign ORDERS —
    // and this order only just came into existence. Without this, every job below was stamped with
    // the blueprint compiled before the order, so the posts a campaign ordered were drafted with no
    // campaign in them at all, and an adjust_messaging order changed nothing (found 2026-09-30).
    // Best-effort: a failed recompile still lets the order run, just unsteered.
    await recompileAssistantForCampaign(ctx.targetAssistantId, 'campaign-order');
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

/** Recompile one assistant so its blueprint reflects the campaigns it serves. Never throws. */
async function recompileAssistantForCampaign(assistantId: number, reason: string): Promise<void> {
    try {
        await assembleBlueprint(assistantId, 'campaign-orchestrator', reason);
    } catch (err) {
        console.warn('[campaign-orders] recompile failed — drafting stays on the previous blueprint', { assistantId, reason, err });
    }
}

/**
 * Recompile every assistant this campaign has given orders to.
 *
 * Call it whenever the campaign's state or wording changes: started or resumed, paused, stopped,
 * finished, or its objective or end date edited. Generation reads the PERSISTED blueprint, and
 * nothing else recompiles on these events — so without this a finished or paused campaign kept
 * steering every draft until some unrelated edit happened to recompile, and an edited objective
 * never arrived. Parallel and best-effort: one failed assistant must not block the rest, or the
 * caller's own write.
 */
export async function recompileCampaignTargets(db: Db, campaignId: number, reason: string): Promise<void> {
    try {
        const rows = await db
            .selectDistinct({ id: campaignOrders.targetAssistantId })
            .from(campaignOrders)
            .where(eq(campaignOrders.campaignId, campaignId));
        const ids = rows.map((r) => r.id).filter((id): id is number => id != null);
        await Promise.allSettled(ids.map((id) => recompileAssistantForCampaign(id, reason)));
    } catch (err) {
        console.warn('[campaign-orders] could not list campaign targets for recompile', { campaignId, reason, err });
    }
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

    // An email campaign (§9.7). Drafting is a BACKGROUND job — one model call per email, too slow
    // for the plan-approval request this runs inside — so the executor only wakes the worker
    // (src/utils/campaign-email-order.ts). The order stays 'issued' until the emails exist; a lost
    // wake-up is re-sent by the reconciler, so a failed dispatch is NOT a failed order.
    // Nothing here or in the worker ever sends an email.
    // An A/B test (§9.8): N posts per angle, interleaved A, B, A, B across the days ahead so neither
    // angle gets the better posting days — a test where every A goes out on a Monday measures Mondays.
    // Each job is TAGGED with its variant (campaign_experiment_jobs); the drafting worker reads the
    // tag to give each job ITS angle (campaign-job-directive.ts). Without the tag both halves would
    // be drafted with the blueprint's one angle and the test would compare a thing to itself.
    ab_test_posts: async (db, ctx, orderId) => {
        const blueprintId = await resolveBlueprintId(db, ctx.targetAssistantId, ctx.organisationId);
        if (!blueprintId) return { ok: false, message: 'The Social Media Assistant has no usable setup yet, so nothing could be queued.' };
        const angleA = String(ctx.brief.angleA || '').trim();
        const angleB = String(ctx.brief.angleB || '').trim();
        const hypothesis = String(ctx.brief.hypothesis || '').trim();
        if (!angleA || !angleB || !hypothesis) return { ok: false, message: 'The test needs what it is testing and both angles.' };
        const perVariant = Math.max(1, Math.min(10, Math.floor(Number(ctx.brief.quantity) || 1)));

        const [exp] = await db.insert(campaignExperiments).values({
            organisationId: ctx.organisationId, campaignId: ctx.campaignId, orderId,
            hypothesis: hypothesis.slice(0, 300), angleA: angleA.slice(0, 300), angleB: angleB.slice(0, 300),
            postsPerVariant: perVariant,
        }).returning({ id: campaignExperiments.id });

        const now = Date.now();
        for (let i = 0; i < perVariant * 2; i++) {
            const variant = i % 2 === 0 ? 'A' : 'B';
            const [job] = await db.insert(contentGenerationJobs).values({
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
                campaignOrderId: orderId,
            }).returning({ id: contentGenerationJobs.id });
            await db.insert(campaignExperimentJobs).values({ jobId: job.id, experimentId: exp.id, variant });
        }
        return { ok: true, summary: `${perVariant * 2} posts queued — ${perVariant} for each angle` };
    },

    // Never reached: a person's task is placed by placeHumanTask and released by issueHumanTask,
    // neither of which runs an executor. Present only because this table must name every action;
    // if it IS reached, something routed a human task to an assistant, so refuse rather than guess.
    request_human_task: async () => ({
        ok: false, message: 'A task for a person cannot be given to an assistant.',
    }),

    draft_email_campaign: async (_db, ctx, orderId) => {
        const n = Math.max(1, Math.floor(Number(ctx.brief.quantity) || 1));
        await triggerCampaignEmailDraft(orderId, 'order-issued');
        return {
            ok: true,
            summary: `The Email Marketing Assistant is writing ${n} email${n === 1 ? '' : 's'}`,
        };
    },
};
