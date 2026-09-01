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
//   POST { action: 'stage_paid',   campaignId, dailyBudgetGbp, variants[], campaignGroupUrn }
//   POST { action: 'approve_launch', campaignId, confirmDailyBudgetGbp }   ⚠️ starts real spend
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
    adVariants, aiAssistants, auditLogs, campaignAttributions, campaignBudgets,
    campaignClickEvents, campaignDecisions, campaignLinks, campaignOrders, campaigns,
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
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import { linkedInAdapter } from '../../src/utils/ad-networks/registry';
import { assessAdsReadiness, getAdsConnection, getAdsToken } from '../../src/utils/linkedin-ads-connection';
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

    // ── stage_paid ────────────────────────────────────────────────────────────
    // Turn a campaign into a PAID one: create it on the ad network, PAUSED, with its creatives.
    // Nothing here spends. Approval is a separate, human act.
    //
    // ⚠️ THIS IS WHERE PAID BECOMES POSSIBLE, and it is deliberately the only place. The `create`
    // action above still refuses every mode but 'organic'; this action does not widen that, it adds
    // a second, separately-gated door with its own guards. Reading `CREATABLE_CAMPAIGN_MODES` alone
    // and concluding "paid is impossible" would therefore be wrong from here on — the guard that
    // matters now is the adapter registry, which resolves nothing in production.
    if (action === 'stage_paid') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        // Gate 1 — the commercial entitlement.
        if (!await hasFeatureByOrg(db, orgId, PAID_ADS_FEATURE)) {
            return json(403, { error: 'Paid advertising is not available on this plan.' });
        }

        // A campaign that is already running organically must not be silently converted: its work
        // ledger, its orders and its reporting all assume one mode for its lifetime.
        if (campaign.mode !== 'organic') {
            return json(400, { error: 'This campaign has already been set up for advertising.' });
        }
        if (LIVE_CAMPAIGN_STATUSES.includes(campaign.status as never)) {
            return json(400, { error: 'Pause this campaign before adding advertising to it.' });
        }

        // Gate 2 — a connected ad account the user has actually chosen.
        const readiness = assessAdsReadiness(await getAdsConnection(db, orgId));
        if (!readiness.ready) return json(400, { error: readiness.reason });
        const conn = readiness.connection;

        // ⚠️ GBP ONLY, for now, and refused rather than converted. `campaign_budgets.max_spend_gbp`
        // is named for its currency, and writing euros into it would be the same mistake the
        // adapter refuses to make with `costInLocalCurrency`. Converting needs a rate we do not
        // have and would silently misreport every cost-per-outcome figure downstream.
        if (conn.selectedCurrency !== 'GBP') {
            return json(400, {
                error: `That LinkedIn ad account bills in ${conn.selectedCurrency}. We can only manage accounts that bill in GBP at the moment.`,
            });
        }

        const dailyBudgetGbp = Number(body.dailyBudgetGbp);
        if (!Number.isFinite(dailyBudgetGbp) || dailyBudgetGbp <= 0) {
            return json(400, { error: 'Set a daily budget for this campaign.' });
        }
        // A ceiling on the ceiling. Not a judgement about what is affordable — a guard against a
        // typo becoming a five-figure day.
        if (dailyBudgetGbp > 1000) {
            return json(400, { error: 'Daily budgets above £1,000 need to be set up with us directly.' });
        }

        const rawVariants = Array.isArray(body.variants) ? body.variants : [];
        if (rawVariants.length < 1 || rawVariants.length > 3) {
            return json(400, { error: 'Stage between one and three ad variants.' });
        }
        const variants = rawVariants.map((v: any, i: number) => ({
            headline: str(v?.headline, 200),
            bodyText: str(v?.body, 600),
            destinationUrl: str(v?.destinationUrl, 2000),
            format: str(v?.format, 40) ?? 'single_image',
            index: i,
        }));
        for (const v of variants) {
            if (!v.headline || !v.bodyText || !v.destinationUrl) {
                return json(400, { error: 'Every variant needs a headline, body text and a destination link.' });
            }
            // The destination is public-facing and ours to vouch for — same check the tracked-link
            // creator runs, for the same reason.
            if (!isSafeDestination(v.destinationUrl)) {
                return json(400, { error: 'One of the destination links cannot be used. Links must be a normal http:// or https:// web address.' });
            }
        }

        // Gate 3 — an adapter. In production this THROWS: the LinkedIn adapter is Development Tier
        // and registered for development only, so a production caller gets an honest refusal here
        // rather than a half-built campaign.
        const token = await getAdsToken(db, orgId);
        if (!token) return json(400, { error: 'The LinkedIn advertising connection needs reconnecting.' });
        let adapter;
        try {
            adapter = linkedInAdapter({
                accessToken: token,
                accountUrn: conn.selectedAccountUrn!,
                campaignGroupUrn: str(body.campaignGroupUrn, 120) ?? '',
                currencyCode: 'GBP',
            });
        } catch (err) {
            return json(400, { error: err instanceof Error ? err.message : 'Advertising is not available here yet.' });
        }

        // ── The network call comes BEFORE any local write. ──
        // If it fails we have changed nothing. If a local write fails afterwards we have an orphan
        // campaign on LinkedIn — which is PAUSED, so it cannot spend, and that is the right way
        // round for the failure to land. Logged loudly because it still needs cleaning up.
        let staged;
        try {
            staged = await adapter.stageCampaign({
                campaignId: campaign.id,
                organisationId: orgId,
                name: campaign.objective.slice(0, 100),
                dailyBudgetGbp,
                variants: variants.map((v, i) => ({
                    variantId: i,
                    headline: v.headline!,
                    body: v.bodyText!,
                    destinationUrl: v.destinationUrl!,
                    targeting: (body.targeting && typeof body.targeting === 'object') ? body.targeting as Record<string, unknown> : {},
                })),
            });
        } catch (err) {
            console.error('[campaigns] stage_paid failed at the network', { campaignId: campaign.id }, err);
            return json(502, { error: 'LinkedIn would not accept the campaign. Nothing has been created and nothing has been spent.' });
        }

        // ⚠️ ORDER MATTERS. campaigns.mode must be 'paid' BEFORE a non-zero budget is written:
        // db/campaigns.sql carries a trigger that refuses any non-zero max_spend_gbp on a campaign
        // still marked organic. That trigger is a feature, not an obstacle — it is what makes
        // "an organic campaign can never spend" true in the database rather than in a comment.
        try {
            await db.update(campaigns).set({
                mode: 'paid',
                adNetwork: 'linkedin',
                externalCampaignId: staged.externalCampaignId,
                updatedAt: new Date(),
            }).where(eq(campaigns.id, campaign.id));

            await db.update(campaignBudgets)
                .set({ maxSpendGbp: String(dailyBudgetGbp), updatedAt: new Date() })
                .where(eq(campaignBudgets.campaignId, campaign.id));

            await db.insert(adVariants).values(variants.map((v, i) => ({
                organisationId: orgId,
                campaignId: campaign.id,
                network: 'linkedin',
                externalVariantId: staged.externalVariantIds[i] ?? null,
                headline: v.headline!,
                body: v.bodyText!,
                format: v.format!,
                targeting: {},
                // Never 'active'. A CHECK constraint also requires approved_by on anything live.
                status: 'staged',
            })));
        } catch (err) {
            console.error('[campaigns] stage_paid created a LinkedIn campaign but failed to record it', {
                campaignId: campaign.id, externalCampaignId: staged.externalCampaignId,
            }, err);
            return json(500, {
                error: 'The campaign was created on LinkedIn but we could not record it here. It is paused and cannot spend. Please contact support with this campaign id.',
            });
        }

        return json(200, {
            ok: true,
            externalCampaignId: staged.externalCampaignId,
            variantsStaged: variants.length,
            // Said out loud so no caller has to infer it.
            status: 'paused',
            message: 'Staged on LinkedIn and paused. Nothing will be spent until you approve it.',
        });
    }

    // ── approve_launch ────────────────────────────────────────────────────────
    // ⚠️ THE ONLY ACTION IN THIS PRODUCT THAT CAN START SPENDING A CUSTOMER'S MONEY.
    //
    // Everything else — proposing, staging, drafting, optimising — either costs nothing or can only
    // ever reduce spend. This one call flips a LinkedIn campaign from PAUSED to ACTIVE, and from
    // that moment the customer is being charged by a third party on a schedule we do not control.
    // Read the ordering notes before changing anything here.
    //
    // Three properties this must keep:
    //   1. A HUMAN, WITH THE NUMBER IN FRONT OF THEM. The caller must echo back the daily budget it
    //      is approving, and it must match what is stored. A model turn plus a click must never be
    //      enough — chat-creates-draft-campaigns settled that for the whole product, and this is the
    //      case it was settled for.
    //   2. CONTROL IS RE-CHECKED, NOT ASSUMED. `control_state` in our database is a cached opinion.
    //      Before starting a spend we ask LinkedIn directly, because the failure we are guarding
    //      against — a dead token — is invisible until the moment we need to stop the campaign.
    //   3. WE CAN ALWAYS SEE WHAT WE STARTED. See the ordering note below.
    if (action === 'approve_launch') {
        const campaign = await requireCampaign(Number(body.campaignId));
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        if (!await hasFeatureByOrg(db, orgId, PAID_ADS_FEATURE)) {
            return json(403, { error: 'Paid advertising is not available on this plan.' });
        }
        if (campaign.mode !== 'paid' || !campaign.externalCampaignId) {
            return json(400, { error: 'This campaign has not been set up for advertising yet.' });
        }
        if (LIVE_CAMPAIGN_STATUSES.includes(campaign.status as never)) {
            return json(400, { error: 'This campaign is already running.' });
        }

        const [budget] = await db.select({ maxSpendGbp: campaignBudgets.maxSpendGbp })
            .from(campaignBudgets).where(eq(campaignBudgets.campaignId, campaign.id)).limit(1);
        const dailyBudget = Number(budget?.maxSpendGbp ?? 0);
        if (!(dailyBudget > 0)) {
            return json(400, { error: 'This campaign has no daily budget set, so there is nothing to approve.' });
        }

        // Property 1. The caller states the figure it believes it is approving.
        // ⚠️ Not belt-and-braces. Between staging and approval the budget can be edited, in another
        // tab or by a colleague, and approving a number you were never shown is exactly the kind of
        // consent that is worthless afterwards. Mismatch REFUSES and reports both figures.
        const confirmed = Number(body.confirmDailyBudgetGbp);
        if (!Number.isFinite(confirmed) || Math.abs(confirmed - dailyBudget) > 0.001) {
            return json(409, {
                error: `This campaign's daily budget is £${dailyBudget.toFixed(2)}, not £${Number.isFinite(confirmed) ? confirmed.toFixed(2) : '—'}. Check the figure and approve again.`,
                dailyBudgetGbp: dailyBudget,
            });
        }

        const staged = await db.select({ id: adVariants.id, externalVariantId: adVariants.externalVariantId })
            .from(adVariants)
            .where(and(eq(adVariants.campaignId, campaign.id), eq(adVariants.status, 'staged')));
        if (staged.length === 0) {
            return json(400, { error: 'There are no staged ads on this campaign to launch.' });
        }

        const readiness = assessAdsReadiness(await getAdsConnection(db, orgId));
        if (!readiness.ready) return json(400, { error: readiness.reason });

        const token = await getAdsToken(db, orgId);
        if (!token) return json(400, { error: 'The LinkedIn advertising connection needs reconnecting.' });

        let adapter;
        try {
            adapter = linkedInAdapter({
                accessToken: token,
                accountUrn: readiness.connection.selectedAccountUrn!,
                campaignGroupUrn: '',
                currencyCode: 'GBP',
            });
        } catch (err) {
            return json(400, { error: err instanceof Error ? err.message : 'Advertising is not available here yet.' });
        }

        // Property 2. Ask LinkedIn, now, whether we can still control this campaign.
        // A campaign we cannot stop is a campaign we must not start.
        const control = await adapter.checkControl(campaign.externalCampaignId);
        if (!control.ok) {
            await db.update(campaigns).set({
                controlState: 'lost', controlDetail: control.detail ?? null,
                controlCheckedAt: new Date(), updatedAt: new Date(),
            }).where(eq(campaigns.id, campaign.id));
            return json(400, {
                error: 'We cannot reach your LinkedIn ad account, so we will not start this campaign — we would not be able to stop it. Reconnect and try again.',
            });
        }

        // ── Property 3: ORDER. Local write FIRST, network SECOND. ──
        // This is the OPPOSITE of stage_paid, deliberately, and the reason is money.
        //
        // At staging, the network call creates something PAUSED — it cannot spend — so calling it
        // first is safe and leaves nothing behind on failure. Here the network call is the thing
        // that STARTS the spend. If it succeeded and our write then failed, we would have a live,
        // charging campaign that our own records show as paused: the optimiser reads our records,
        // so nothing would ever check on it, and the kill switch would never fire. That is the one
        // outcome worth contorting the code to prevent.
        //
        // So we record the intent first and roll back if LinkedIn refuses. A campaign we believe is
        // live but is actually paused is wrong in the harmless direction: it shows as running,
        // spends nothing, and the next optimiser pass reports no data.
        const approvedAt = new Date();
        await db.update(adVariants).set({
            status: 'active', approvedBy: userId, approvedAt, updatedAt: approvedAt,
        }).where(and(eq(adVariants.campaignId, campaign.id), eq(adVariants.status, 'staged')));

        await db.update(campaigns).set({
            status: 'active',
            startsAt: campaign.startsAt ?? approvedAt,
            controlState: 'ok',
            controlCheckedAt: approvedAt,
            // ⚠️ Stamped at approval, and this is NOT cosmetic. assessHeartbeat() treats a null
            // last-run as STALE and halts the campaign — so without this, every campaign would be
            // halted by the watchdog within a day of launching, before the optimiser had ever had
            // a chance to run. Approval is itself a check: we just asked LinkedIn about this
            // campaign and it answered.
            optimiserLastRunAt: approvedAt,
            updatedAt: approvedAt,
        }).where(eq(campaigns.id, campaign.id));

        try {
            await adapter.activateCampaign(campaign.externalCampaignId);
        } catch (err) {
            console.error('[campaigns] approve_launch: LinkedIn refused activation, rolling back', {
                campaignId: campaign.id,
            }, err);
            // Roll back to exactly where we were. Reverting the variants to 'staged' also clears
            // the approval stamp, because they were never live and an audit trail saying otherwise
            // would be a lie.
            await db.update(adVariants).set({
                status: 'staged', approvedBy: null, approvedAt: null, updatedAt: new Date(),
            }).where(and(eq(adVariants.campaignId, campaign.id), eq(adVariants.status, 'active')));
            await db.update(campaigns).set({
                status: campaign.status, updatedAt: new Date(),
            }).where(eq(campaigns.id, campaign.id));
            return json(502, { error: 'LinkedIn would not start the campaign. Nothing has been launched and nothing has been spent.' });
        }

        // A money action, so it leaves a permanent record of who authorised it.
        await db.insert(auditLogs).values({
            actionType: 'campaign_paid_launched',
            resourceType: 'campaigns',
            resourceId: String(campaign.id),
            newState: {
                organisationId: orgId, approvedByUserId: userId,
                dailyBudgetGbp: dailyBudget, variants: staged.length,
                externalCampaignId: campaign.externalCampaignId,
            },
        });

        return json(200, {
            ok: true,
            status: 'active',
            dailyBudgetGbp: dailyBudget,
            variantsLive: staged.length,
            // Say what happens next, including how to stop it. A launch confirmation without a
            // route back is the pattern connection-pause-needs-a-resume is named after.
            message: `Live on LinkedIn, spending up to £${dailyBudget.toFixed(2)} a day. You can pause it from this page at any time.`,
        });
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
