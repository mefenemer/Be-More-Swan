// netlify/functions/campaigns.ts
// Tenant-scoped API for the Campaign Assistant (roleKey `campaign_orchestrator`).
// Backs the Campaigns tab on assistant-detail.html. Design: docs/campaign-orchestrator-plan.md.
//
//   POST { action: 'list',        assistantId }            → campaigns + budgets + live state
//   POST { action: 'create',      assistantId, objective, outcomeMetric, targetValue?,
//                                 maxWorkItems?, endsAt?, asDraft? }
//   POST { action: 'edit',        campaignId, ...fields }
//   POST { action: 'start',       campaignId }             → draft|paused → active
//   POST { action: 'pause',       campaignId, reason }
//   POST { action: 'stop_all',    assistantId }            → pause every live campaign
//   POST { action: 'list_orders', campaignId }
//   POST { action: 'place_order', campaignId, orderAction, brief?, quantity? }
//   POST { action: 'create_link',  campaignId, destinationUrl, label?, medium?, network? }
//   POST { action: 'list_links',   campaignId }            → links + clicks + conversions
//   POST { action: 'archive_link', linkId }                → stops the redirect, keeps the clicks
//   POST { action: 'list_decisions', assistantId }
//   POST { action: 'decide',      decisionId, verdict: 'approve'|'reject', reason?, note? }
//
// ── The invariants this file enforces ────────────────────────────────────────
// 1. STARTING IS A HUMAN ACT. `create` with asDraft writes a campaign that commissions nothing.
//    Only `start` — a click on the Campaigns tab — makes it live. A model's judgement plus an
//    approval click must never begin committing work.
// 2. MONEY IS REFUSED, NOT IGNORED. Any attempt to create a paid/blended campaign, or to set a
//    non-zero spend ceiling, is rejected here with a plain explanation. The UI does not offer it,
//    but a UI-only guard holds for exactly one caller.
// 3. REJECTING TEACHES. `decide` with verdict 'reject' requires a reason from the closed
//    vocabulary and folds it into the campaign's constraints, which the next proposal reads.
// 4. EVERY PAUSE HAS A REASON AND A RESUME. `pause` requires a reason; `start` is the documented
//    way back and works from 'paused' as well as 'draft'.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
    aiAssistants, campaignAttributions, campaignBudgets, campaignClickEvents, campaignDecisions,
    campaignLinks, campaignOrders, campaigns,
} from '../../db/schema';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { campaignSpendTotals, fitsBudget, readPlanTaskGate } from '../../src/utils/campaign-ledger';
import { placeOrder } from '../../src/utils/campaign-orders';
import { settleDecisionMirror } from '../../src/utils/campaign-mirror';
import {
    CREATABLE_CAMPAIGN_MODES, LIVE_CAMPAIGN_STATUSES,
    isLinkMedium, isOrderAction, isSelectableOutcomeMetric, orderWorkItems,
} from '../../src/config/campaign-vocab';
import { isSafeDestination, mintLinkToken } from '../../src/utils/campaign-attribution';
import { resolveBaseUrl } from '../../src/utils/base-url';
import {
    applyRejectionToConstraints, isCampaignRejectReason, type CampaignConstraints,
} from '../../src/config/campaign-reject-reasons';
import { CAMPAIGN_ORCHESTRATOR_ROLE_KEY } from '../../src/constants/roles';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function str(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Active tracked links one campaign may hold. A real campaign runs a handful of creatives. */
const MAX_LINKS_PER_CAMPAIGN = 50;

/** Clamp an untrusted integer into a sane range, falling back to a default. */
function int(v: unknown, min: number, max: number, dflt: number): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    /**
     * IDOR guard for an assistant id supplied by the caller. Also checks the ROLE: only a
     * Campaign Assistant may own campaigns, so a crafted request naming a Social Media Assistant
     * cannot file campaigns into its workspace.
     */
    async function requireOrchestrator(assistantId: number) {
        const [a] = await db.select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(
                eq(aiAssistants.id, assistantId),
                eq(aiAssistants.organisationId, orgId),
                sql`(${aiAssistants.configuration} ->> 'type') = ${CAMPAIGN_ORCHESTRATOR_ROLE_KEY}`,
            ))
            .limit(1);
        return a ?? null;
    }

    /** IDOR guard for a campaign id supplied by the caller. */
    async function requireCampaign(campaignId: number) {
        const [c] = await db.select()
            .from(campaigns)
            .where(and(eq(campaigns.id, campaignId), eq(campaigns.organisationId, orgId)))
            .limit(1);
        return c ?? null;
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (action === 'list') {
        const assistantId = Number(body.assistantId);
        if (!await requireOrchestrator(assistantId)) return json(404, { error: 'Assistant not found.' });

        const rows = await db
            .select({
                id: campaigns.id,
                objective: campaigns.objective,
                outcomeMetric: campaigns.outcomeMetric,
                targetValue: campaigns.targetValue,
                mode: campaigns.mode,
                status: campaigns.status,
                startsAt: campaigns.startsAt,
                endsAt: campaigns.endsAt,
                haltReason: campaigns.haltReason,
                // Load-bearing for the state chip, not diagnostics. "Paused (you)" and
                // "Paused (guardrail)" are different facts — one is the user's decision, the other
                // is the agent stopping itself — and only a human pause sets haltedBy. The client
                // must not infer this from haltReason prose: that is string-matching a sentence we
                // reword freely, and connection-status-vocabulary-drift is what it costs when a
                // surface guesses a state instead of reading one.
                haltedBy: campaigns.haltedBy,
                createdAt: campaigns.createdAt,
                maxWorkItems: campaignBudgets.maxWorkItems,
                maxSpendGbp: campaignBudgets.maxSpendGbp,
            })
            .from(campaigns)
            .leftJoin(campaignBudgets, eq(campaignBudgets.campaignId, campaigns.id))
            .where(and(
                eq(campaigns.organisationId, orgId),
                eq(campaigns.aiAssistantId, assistantId),
                sql`${campaigns.status} <> 'archived'`,
            ))
            .orderBy(desc(campaigns.createdAt));

        // Per-campaign live state. Serial rather than parallel on purpose: this is a small list
        // (a workspace runs a handful of campaigns, not hundreds) and a Promise.all here would
        // open one connection per campaign against a pooled Neon endpoint.
        const items = [];
        for (const r of rows) {
            const totals = await campaignSpendTotals(db, r.id);
            const [live] = await db
                .select({
                    open: sql<number>`COUNT(*) FILTER (WHERE ${campaignOrders.status} IN ('queued','issued','blocked'))`,
                    inReview: sql<number>`COUNT(*) FILTER (WHERE ${campaignOrders.status} = 'in_review')`,
                    delivered: sql<number>`COUNT(*) FILTER (WHERE ${campaignOrders.status} = 'delivered')`,
                })
                .from(campaignOrders)
                .where(eq(campaignOrders.campaignId, r.id));
            items.push({ ...r, ...totals, orders: live ?? { open: 0, inReview: 0, delivered: 0 } });
        }

        // The plan gate travels with the list so the Budget & Control strip can render in one
        // round trip — and so the client never has to compute it and get it wrong.
        const planGate = await readPlanTaskGate(db, orgId);
        return json(200, { campaigns: items, planGate });
    }

    // ── create ────────────────────────────────────────────────────────────────
    if (action === 'create') {
        const assistantId = Number(body.assistantId);
        if (!await requireOrchestrator(assistantId)) return json(404, { error: 'Assistant not found.' });

        const objective = str(body.objective, 500);
        if (!objective) return json(400, { error: 'What do you want this campaign to achieve?' });

        // Invariant 2. The UI never offers a paid campaign, but this is the boundary that holds.
        const mode = str(body.mode, 20) ?? 'organic';
        if (!CREATABLE_CAMPAIGN_MODES.includes(mode as never)) {
            return json(400, {
                error: 'Paid campaigns are not available yet. Ad channels are waiting on approvals from Meta, LinkedIn and Google that we do not control — everything else works today.',
            });
        }
        if (Number(body.maxSpendGbp) > 0) {
            return json(400, { error: 'This campaign cannot be given a money budget yet. Its budget is the work it commissions.' });
        }

        const outcomeMetric = isSelectableOutcomeMetric(body.outcomeMetric) ? body.outcomeMetric : 'leads';
        const maxWorkItems = int(body.maxWorkItems, 1, 1000, 100);
        const targetValue = Number.isFinite(Number(body.targetValue)) ? int(body.targetValue, 1, 100000, 10) : null;
        const endsAt = typeof body.endsAt === 'string' && body.endsAt ? new Date(body.endsAt) : null;

        // Invariant 1. `asDraft` is the chat path: a proposal the user approved in conversation
        // becomes a saved campaign that commissions nothing until a human starts it.
        const asDraft = body.asDraft === true;

        // Approving the same proposal twice must not create two campaigns. Transcripts re-hydrate
        // from chatMessages.uiElementJson on reload, so an old proposal card comes back with live
        // buttons. Scoped to the draft path only — re-submitting the FORM is a deliberate act, and
        // silently handing back an existing campaign would look like a broken button.
        if (asDraft) {
            const [existing] = await db.select({ id: campaigns.id })
                .from(campaigns)
                .where(and(
                    eq(campaigns.organisationId, orgId),
                    eq(campaigns.aiAssistantId, assistantId),
                    eq(campaigns.objective, objective),
                    sql`${campaigns.status} <> 'archived'`,
                ))
                .limit(1);
            if (existing) return json(200, { campaignId: existing.id, deduped: true, status: 'draft' });
        }

        const [created] = await db.insert(campaigns).values({
            organisationId: orgId,
            aiAssistantId: assistantId,
            createdBy: userId,
            objective,
            outcomeMetric,
            targetValue,
            mode: 'organic',
            status: 'draft',
            endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
        }).returning({ id: campaigns.id });

        await db.insert(campaignBudgets).values({
            organisationId: orgId,
            campaignId: created.id,
            maxWorkItems,
            // Explicit, not defaulted. The organic-money lock in db/campaigns.sql would reject
            // anything else, and writing it here documents that this is deliberate.
            maxSpendGbp: '0.00',
            autonomyThresholdWork: int(body.autonomyThresholdWork, 0, 50, 0),
        });

        return json(200, { campaignId: created.id, status: 'draft' });
    }

    // ── edit ──────────────────────────────────────────────────────────────────
    if (action === 'edit') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });
        if (Number(body.maxSpendGbp) > 0) {
            return json(400, { error: 'This campaign cannot be given a money budget yet.' });
        }

        const patch: Record<string, unknown> = { updatedAt: new Date() };
        const objective = str(body.objective, 500);
        if (objective) patch.objective = objective;
        if (isSelectableOutcomeMetric(body.outcomeMetric)) patch.outcomeMetric = body.outcomeMetric;
        if (body.targetValue !== undefined) patch.targetValue = int(body.targetValue, 1, 100000, 10);
        if (typeof body.endsAt === 'string') {
            const d = new Date(body.endsAt);
            patch.endsAt = Number.isNaN(d.getTime()) ? null : d;
        }
        await db.update(campaigns).set(patch).where(eq(campaigns.id, campaign.id));

        if (body.maxWorkItems !== undefined || body.autonomyThresholdWork !== undefined) {
            const bpatch: Record<string, unknown> = { updatedAt: new Date() };
            if (body.maxWorkItems !== undefined) bpatch.maxWorkItems = int(body.maxWorkItems, 1, 1000, 100);
            if (body.autonomyThresholdWork !== undefined) bpatch.autonomyThresholdWork = int(body.autonomyThresholdWork, 0, 50, 0);
            await db.update(campaignBudgets).set(bpatch).where(eq(campaignBudgets.campaignId, campaign.id));
        }
        return json(200, { ok: true });
    }

    // ── start (also the documented RESUME path) ───────────────────────────────
    if (action === 'start') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });
        if (!['draft', 'paused'].includes(campaign.status)) {
            return json(400, { error: `This campaign is ${campaign.status} — there is nothing to start.` });
        }

        // The plan gate. Not the campaign's budget: a different unit entirely (see
        // campaign-ledger.ts). Read here because an assistant in a capped workspace cannot do the
        // work anyway, and starting a campaign that can commission nothing is worse than refusing.
        const gate = await readPlanTaskGate(db, orgId);
        if (gate.noPlan) return json(402, { error: 'Choose a plan to start running campaigns.' });
        if (gate.atCap) {
            return json(429, {
                error: 'This workspace has used its monthly task allowance, so your assistants cannot take on new work until it resets. Nothing has been charged — the allowance is a stop, not a bill.',
            });
        }

        await db.update(campaigns).set({
            status: 'active',
            startsAt: campaign.startsAt ?? new Date(),
            // Clearing the halt fields is what makes "resume" a real state transition rather than
            // a campaign that runs while still claiming to be halted.
            haltReason: null,
            haltedAt: null,
            haltedBy: null,
            updatedAt: new Date(),
        }).where(eq(campaigns.id, campaign.id));

        return json(200, { ok: true, status: 'active' });
    }

    // ── pause ─────────────────────────────────────────────────────────────────
    if (action === 'pause') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        // Invariant 4. The CHECK constraint enforces this too — belt and braces, because the
        // constraint would surface as an opaque 502 rather than this sentence.
        const reason = str(body.reason, 300) ?? 'Paused by you';
        await db.update(campaigns).set({
            status: 'paused', haltReason: reason, haltedAt: new Date(), haltedBy: userId, updatedAt: new Date(),
        }).where(eq(campaigns.id, campaign.id));

        // Cancel work that has not started. No compensating ledger row is needed and none is
        // written: spend is recorded on ISSUE, and only 'queued' (transient) and 'blocked' (waiting
        // on a predecessor) orders reach here — neither has been charged. Orders already issued are
        // left alone and stay charged, because their work is in the target assistant's queue and
        // will still be done. Cancelling them here would take back budget for work that happens.
        const queued = await db.select({ id: campaignOrders.id, cost: campaignOrders.costWorkItems })
            .from(campaignOrders)
            .where(and(eq(campaignOrders.campaignId, campaign.id), inArray(campaignOrders.status, ['queued', 'blocked'])));
        for (const o of queued) {
            await db.update(campaignOrders)
                .set({ status: 'cancelled', resultSummary: 'Campaign paused', updatedAt: new Date() })
                .where(eq(campaignOrders.id, o.id));
        }
        return json(200, { ok: true, cancelledOrders: queued.length });
    }

    // ── stop_all ──────────────────────────────────────────────────────────────
    if (action === 'stop_all') {
        const assistantId = Number(body.assistantId);
        if (!await requireOrchestrator(assistantId)) return json(404, { error: 'Assistant not found.' });

        const live = await db.select({ id: campaigns.id })
            .from(campaigns)
            .where(and(
                eq(campaigns.organisationId, orgId),
                eq(campaigns.aiAssistantId, assistantId),
                inArray(campaigns.status, [...LIVE_CAMPAIGN_STATUSES]),
            ));

        for (const c of live) {
            await db.update(campaigns).set({
                status: 'paused',
                haltReason: 'You stopped everything',
                haltedAt: new Date(),
                haltedBy: userId,
                updatedAt: new Date(),
            }).where(eq(campaigns.id, c.id));
            await db.update(campaignOrders)
                .set({ status: 'cancelled', resultSummary: 'Stopped by you', updatedAt: new Date() })
                .where(and(eq(campaignOrders.campaignId, c.id), inArray(campaignOrders.status, ['queued', 'blocked'])));
        }
        // Deliberately does NOT touch delivered work. A post already drafted stays drafted; a
        // published article stays published. "Stop everything" stops the machine, it does not
        // reach backwards and unmake things.
        return json(200, { ok: true, stopped: live.length });
    }

    // ── list_orders ───────────────────────────────────────────────────────────
    if (action === 'list_orders') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });
        const orders = await db.select()
            .from(campaignOrders)
            .where(eq(campaignOrders.campaignId, campaign.id))
            .orderBy(desc(campaignOrders.createdAt))
            .limit(200);
        return json(200, { orders });
    }

    // ── place_order ───────────────────────────────────────────────────────────
    if (action === 'place_order') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });
        if (!LIVE_CAMPAIGN_STATUSES.includes(campaign.status as never)) {
            return json(400, { error: 'This campaign is not running, so it cannot commission work.' });
        }
        const orderAction = body.orderAction;
        if (!isOrderAction(orderAction)) return json(400, { error: 'Unknown order type.' });

        const quantity = int(body.quantity, 1, 20, 1);
        const workItems = orderWorkItems(orderAction, quantity);

        const [budget] = await db.select({ maxWorkItems: campaignBudgets.maxWorkItems })
            .from(campaignBudgets).where(eq(campaignBudgets.campaignId, campaign.id)).limit(1);
        const totals = await campaignSpendTotals(db, campaign.id);
        const verdict = fitsBudget(totals, budget?.maxWorkItems ?? 0, workItems);
        if (!verdict.allowed) return json(400, { error: verdict.message });

        const result = await placeOrder({
            db, organisationId: orgId, userId,
            campaignId: campaign.id,
            orchestratorAssistantId: campaign.aiAssistantId,
            campaignObjective: campaign.objective,
            action: orderAction,
            brief: (body.brief && typeof body.brief === 'object') ? body.brief as Record<string, unknown> : {},
            quantity,
        });
        if (result.status === 'failed') return json(400, { error: result.message ?? 'The order could not be placed.' });
        return json(200, { orderId: result.orderId, status: result.status, workItems: result.workItems });
    }

    // ── create_link ───────────────────────────────────────────────────────────
    // Mint a tracked link: https://<host>/go/<token> → the tenant's own destination.
    if (action === 'create_link') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        const destinationUrl = str(body.destinationUrl, 2000);
        if (!destinationUrl) return json(400, { error: 'Where should this link send people?' });

        // ⚠️ VALIDATED HERE, AT THE WRITE. A link on our domain that forwards anywhere is an open
        // redirector — the classic phishing gift, and it would be OUR domain lending the
        // credibility. Checking only at redirect time would leave a bad destination sitting in the
        // database looking legitimate until someone clicked it.
        if (!isSafeDestination(destinationUrl)) {
            return json(400, {
                error: 'That destination cannot be used. Links must be a normal http:// or https:// web address, without a username or password in them, and cannot point at another tracked link.',
            });
        }

        const medium = body.medium === undefined ? 'organic' : body.medium;
        if (!isLinkMedium(medium)) return json(400, { error: 'Unknown link medium.' });
        const network = str(body.network, 60);
        // Mirrors campaign_links_paid_network_check. Enforced here too so the caller gets a
        // sentence rather than a constraint violation — and because a UI-only guard holds for
        // exactly one caller.
        if (medium === 'paid' && !network) {
            return json(400, { error: 'A paid link needs to say which network it runs on, or its results cannot be broken down by channel.' });
        }

        // Bounded so one campaign cannot grow an unbounded table. Generous: a real campaign runs a
        // handful of creatives, not hundreds.
        const [{ existing } = { existing: 0 }] = await db
            .select({ existing: sql<number>`count(*)::int` })
            .from(campaignLinks)
            .where(and(eq(campaignLinks.campaignId, campaign.id), isNull(campaignLinks.archivedAt)));
        if (existing >= MAX_LINKS_PER_CAMPAIGN) {
            return json(400, { error: `This campaign already has ${MAX_LINKS_PER_CAMPAIGN} active links. Archive one you are no longer using.` });
        }

        const token = mintLinkToken();
        const [row] = await db.insert(campaignLinks).values({
            organisationId: orgId,
            campaignId: campaign.id,
            createdBy: userId,
            token,
            destinationUrl,
            label: str(body.label, 120),
            medium,
            network: medium === 'paid' ? network : null,
        }).returning({ id: campaignLinks.id });

        const base = resolveBaseUrl(event.headers as Record<string, string | undefined>);
        return json(200, {
            id: row.id,
            token,
            // ⚠️ Null rather than a guessed host when BASE_URL is unset. A tracked link with the
            // wrong origin is pasted into an advert and cannot be recalled — the caller must be
            // able to tell "we could not build this" from "here it is".
            url: base ? `${base}/go/${token}` : null,
        });
    }

    // ── list_links ────────────────────────────────────────────────────────────
    if (action === 'list_links') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        const links = await db.select()
            .from(campaignLinks)
            .where(eq(campaignLinks.campaignId, campaign.id))
            .orderBy(desc(campaignLinks.createdAt))
            .limit(200);
        if (links.length === 0) return json(200, { links: [] });

        // Two GROUPED queries, not two per link. countRoiActivityByAssistant settled this shape:
        // the N+1 version is invisible until a tenant has thirty links and the tab takes a second.
        //
        // ⚠️ ::int on both counts. postgres-js hands back a bigint count as a STRING, and a string
        // reaching the client turns "12" + 1 into "121" in any arithmetic the UI does.
        const clickRows = await db
            .select({
                linkId: campaignClickEvents.linkId,
                clicks: sql<number>`count(*) FILTER (WHERE ${campaignClickEvents.isProbableBot} = false)::int`,
                botClicks: sql<number>`count(*) FILTER (WHERE ${campaignClickEvents.isProbableBot})::int`,
            })
            .from(campaignClickEvents)
            .where(eq(campaignClickEvents.campaignId, campaign.id))
            .groupBy(campaignClickEvents.linkId);

        const conversionRows = await db
            .select({
                linkId: campaignAttributions.linkId,
                conversions: sql<number>`count(*)::int`,
            })
            .from(campaignAttributions)
            .where(eq(campaignAttributions.campaignId, campaign.id))
            .groupBy(campaignAttributions.linkId);

        const clicksBy = new Map(clickRows.map((r) => [r.linkId, r]));
        const conversionsBy = new Map(conversionRows.map((r) => [r.linkId, r.conversions]));
        const base = resolveBaseUrl(event.headers as Record<string, string | undefined>);

        return json(200, {
            links: links.map((l) => ({
                id: l.id,
                token: l.token,
                url: base ? `${base}/go/${l.token}` : null,
                destinationUrl: l.destinationUrl,
                label: l.label,
                medium: l.medium,
                network: l.network,
                archivedAt: l.archivedAt,
                createdAt: l.createdAt,
                clicks: clicksBy.get(l.id)?.clicks ?? 0,
                // Reported separately rather than folded into `clicks`. Mail scanners and
                // link-preview bots hit these constantly; adding them to the headline number
                // inflates every click-through rate in the product, and hiding them entirely
                // leaves a tenant unable to explain why the ad platform's count is higher.
                botClicks: clicksBy.get(l.id)?.botClicks ?? 0,
                conversions: conversionsBy.get(l.id) ?? 0,
            })),
        });
    }

    // ── archive_link ──────────────────────────────────────────────────────────
    if (action === 'archive_link') {
        const linkId = Number(body.linkId);
        // IDOR: the link must belong to the caller's organisation. Scoped on organisation_id
        // rather than trusting a campaignId the caller also supplied.
        const [link] = await db.select({ id: campaignLinks.id })
            .from(campaignLinks)
            .where(and(eq(campaignLinks.id, linkId), eq(campaignLinks.organisationId, orgId)))
            .limit(1);
        if (!link) return json(404, { error: 'Link not found.' });

        // ⚠️ A SOFT DELETE, and it has to stay one. The clicks already recorded against this link
        // are history the funnel counts; a hard delete would cascade them away and silently
        // reduce a past campaign's results. Archiving stops the redirect and keeps the record.
        await db.update(campaignLinks)
            .set({ archivedAt: new Date(), updatedAt: new Date() })
            .where(eq(campaignLinks.id, link.id));
        return json(200, { ok: true });
    }

    // ── list_decisions ────────────────────────────────────────────────────────
    if (action === 'list_decisions') {
        const assistantId = Number(body.assistantId);
        if (!await requireOrchestrator(assistantId)) return json(404, { error: 'Assistant not found.' });
        const rows = await db
            .select({
                id: campaignDecisions.id,
                campaignId: campaignDecisions.campaignId,
                objective: campaigns.objective,
                kind: campaignDecisions.kind,
                title: campaignDecisions.title,
                evidence: campaignDecisions.evidence,
                proposed: campaignDecisions.proposed,
                costOfInaction: campaignDecisions.costOfInaction,
                costWorkItems: campaignDecisions.costWorkItems,
                expiresAt: campaignDecisions.expiresAt,
                createdAt: campaignDecisions.createdAt,
            })
            .from(campaignDecisions)
            .innerJoin(campaigns, eq(campaigns.id, campaignDecisions.campaignId))
            .where(and(
                eq(campaignDecisions.organisationId, orgId),
                eq(campaigns.aiAssistantId, assistantId),
                eq(campaignDecisions.status, 'pending'),
            ))
            .orderBy(desc(campaignDecisions.createdAt));
        return json(200, { decisions: rows });
    }

    // ── decide ────────────────────────────────────────────────────────────────
    if (action === 'decide') {
        const decisionId = Number(body.decisionId);
        const [decision] = await db.select()
            .from(campaignDecisions)
            .where(and(eq(campaignDecisions.id, decisionId), eq(campaignDecisions.organisationId, orgId)))
            .limit(1);
        if (!decision) return json(404, { error: 'Decision not found.' });
        if (decision.status !== 'pending') return json(400, { error: 'This decision has already been settled.' });

        // Expiry is checked at decision time, not only by a sweeper. Without this a card that has
        // been on screen since before it lapsed is still approvable by clicking it.
        if (decision.expiresAt.getTime() < Date.now()) {
            await db.update(campaignDecisions)
                .set({ status: 'expired', updatedAt: new Date() })
                .where(eq(campaignDecisions.id, decision.id));
            return json(400, { error: 'This proposal has expired — its evidence is too old to act on. The assistant will propose again if it still applies.' });
        }

        const verdict = String(body.verdict || '');
        const campaign = await requireCampaign(decision.campaignId);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        if (verdict === 'reject') {
            // Invariant 3. A reason is REQUIRED — this is what makes rejection a feedback loop
            // rather than a status flip. The CHECK constraint enforces it too, but a 400 with a
            // sentence beats a 502 with a constraint name.
            if (!isCampaignRejectReason(body.reason)) {
                return json(400, { error: 'Tell it why you are turning this down — that is what stops it proposing the same thing again.' });
            }
            const next = applyRejectionToConstraints(
                campaign.constraints as CampaignConstraints | null,
                body.reason,
                str(body.note, 280),
            );
            await db.update(campaigns)
                .set({ constraints: next, updatedAt: new Date() })
                .where(eq(campaigns.id, campaign.id));
            await db.update(campaignDecisions).set({
                status: 'rejected',
                rejectReason: body.reason,
                rejectNote: str(body.note, 280),
                decidedAt: new Date(),
                decidedBy: userId,
                updatedAt: new Date(),
            }).where(eq(campaignDecisions.id, decision.id));
            await settleDecisionMirror(db, decision.id, 'rejected');
            return json(200, { ok: true, verdict: 'rejected' });
        }

        if (verdict !== 'approve') return json(400, { error: 'Unknown verdict.' });

        // Approving applies the proposal VERBATIM. The model gets no second turn between the
        // human's approval and execution — re-asking it here would mean the user approved one
        // thing and something else happened.
        const proposed = (decision.proposed ?? {}) as { orders?: Array<Record<string, unknown>> };
        const placed: Array<{ orderId: number | null; status: string; message?: string }> = [];
        for (const o of (proposed.orders ?? []).slice(0, 10)) {
            if (!isOrderAction(o.action)) continue;
            const r = await placeOrder({
                db, organisationId: orgId, userId,
                campaignId: campaign.id,
                orchestratorAssistantId: campaign.aiAssistantId,
                campaignObjective: campaign.objective,
                action: o.action,
                brief: (o.brief && typeof o.brief === 'object') ? o.brief as Record<string, unknown> : {},
                quantity: Number(o.quantity) || 1,
            });
            placed.push({ orderId: r.orderId, status: r.status, message: r.message });
        }

        await db.update(campaignDecisions).set({
            status: 'approved', decidedAt: new Date(), decidedBy: userId, updatedAt: new Date(),
        }).where(eq(campaignDecisions.id, decision.id));
        await settleDecisionMirror(db, decision.id, 'approved');

        // A strategy decision is the campaign's own go-ahead, so approving it starts the campaign.
        // Every other kind acts on a campaign that is already running.
        if (decision.kind === 'strategy' && campaign.status === 'draft') {
            await db.update(campaigns)
                .set({ status: 'active', startsAt: new Date(), updatedAt: new Date() })
                .where(eq(campaigns.id, campaign.id));
        }

        // Report what actually happened per order rather than a blanket success. Some orders fail
        // for legitimate reasons (the workspace has not hired that assistant), and the user needs
        // to know which — a bare "approved" would claim work that was never commissioned.
        return json(200, { ok: true, verdict: 'approved', orders: placed });
    }

    return json(400, { error: 'Unknown action.' });
});
