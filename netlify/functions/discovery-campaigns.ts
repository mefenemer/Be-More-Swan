// netlify/functions/discovery-campaigns.ts
// Tenant-scoped API for the Lead Generator's outbound discovery campaigns. Backs the
// "Idea / Blueprint" UI on assistant-detail.html. Every action is ownership-checked
// (IDOR guard) against the caller's organisation. Design: docs/lead-generator-discovery-plan.md.
//
//   POST { action: 'create',    assistantId, idea, targetPersona?, guardrails?, cadence?, runAtHourUtc? }
//        → creates campaign (+guardrails+schedule); one_off enqueues a run now. → { campaignId, jobId }
//   POST { action: 'list',      assistantId }
//        → this assistant's campaigns, newest first, each with its latest run status.
//   POST { action: 'get',       campaignId }
//        → ONE campaign in full: idea, guardrails, schedule and the approved search plan. Backs
//          the View / Edit / Schedule modals on the Searches tab.
//   POST { action: 'schedule',  campaignId, cadence, daysOfWeek?, runAtHourUtc?, timezone?, enabled? }
//        → rewrites the repeat schedule and recomputes next_run_at. → { nextRunAt, blockedBy }
//   POST { action: 'generate_brief', campaignId }
//        → drafts the search plan for review BEFORE anything is spent. → { queries, exclusions }
//   POST { action: 'approve_brief',  campaignId, queries }
//        → stores the approved plan, starts the campaign, and enqueues a run whose cursor is
//          pre-seeded with those queries so the worker skips its own query_gen. → { jobId }
//   POST { action: 'run_now',   campaignId }
//        → enqueues an on_demand run for an existing campaign (no duplicate if one is in flight).
//   POST { action: 'list_leads', campaignId }
//        → discovered_leads for the campaign (raw discovery output + provenance).
//   POST { action: 'exclude_domain', campaignId, domain }
//        → APPENDS one domain to the campaign's excluded list (the reject-flow follow-up).

import { Handler } from '@netlify/functions';
import { randomUUID } from 'crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, discoveryCampaigns, discoveryGuardrails, discoverySchedules, discoveryJobs, discoveredLeads } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { activeCampaignCapacity, campaignCapacityMessage, createDiscoveryRun } from '../../src/utils/discovery';
import {
    clampGuardrail, MAX_LEADS_PER_MONTH_CEILING, MAX_LEADS_PER_RUN_CEILING,
} from '../../src/config/discovery-limits';
import { triggerDiscoveryDrain } from '../../src/utils/trigger-drain';
import { isSearchConfigured, normaliseDomain } from '../../src/lib/discovery-search';
import {
    generateQueries, flattenQueries, QUERY_GEN_MODEL, type GeneratedQueries,
} from '../../src/lib/discovery-query-gen';
import {
    computeNextRun, isDiscoveryCadence, normaliseDaysOfWeek, normaliseHourUtc,
} from '../../src/utils/discovery-schedule';
import { logAiUsage } from '../../src/utils/ai-usage';
import { withLambda } from '@netlify/aws-lambda-compat';
import { computePlanReach } from '../../src/config/plan-reach';
import { readTerritoryPlan, nextSlice, type TerritoryPlan } from '../../src/config/territory-plan';
import { MAX_PAGES_PER_QUERY } from '../../src/config/plan-reach';
import { assessMarket } from '../../src/lib/market-enumerability';
import { splitTerritories, expandQueryAcrossTerritories, pickExpansionSource, MAX_TERRITORIES } from '../../src/lib/territory-split';
import {
    DEFAULT_MAX_LEADS_PER_RUN, DEFAULT_MAX_LEADS_PER_MONTH, DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
    DEFAULT_MAX_TOKENS_PER_RUN, MAX_TOKENS_PER_RUN_CEILING, MAX_SEARCH_CALLS_PER_RUN_CEILING,
} from '../../src/config/discovery-limits';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function str(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * Sanity bound per strategy on an APPROVED plan.
 *
 * ⚠️ This was 10, written when a generated plan was five queries per strategy and the comment read
 * "matches the generator's ceiling". Territory expansion walked straight past it: a district split
 * offered 37 queries per group, the review screen showed 111, the reach block promised 111 searches
 * across 33 areas — and approve_brief silently kept the first 10 of each, so the run executed 30
 * and worked about ten districts. Nothing anywhere said so.
 *
 * Sized from what an expansion can legitimately produce: MAX_TERRITORIES (80) plus room for the
 * leftovers kept beside them. It is a guard against a malformed request, NOT a spend control —
 * maxSearchCallsPerRun bounds the money, and it does it honestly, in a number the user can see and
 * the reach block computes from.
 */
const MAX_QUERIES_PER_STRATEGY = MAX_TERRITORIES + 20;

/** Sanitise one strategy's worth of user-edited queries. A query is a search string, nothing more. */
function cleanQueryList(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 300))
        .slice(0, MAX_QUERIES_PER_STRATEGY);
}

/** The queries from a stored brief, flattened. Empty when no brief has ever been approved. */
function readApprovedQueries(brief: unknown): string[] {
    if (!brief || typeof brief !== 'object') return [];
    const q = (brief as Record<string, unknown>).queries;
    if (!q || typeof q !== 'object') return [];
    const groups = q as Record<string, unknown>;
    return (['niche_scrape', 'intent_signal', 'footprint'] as const)
        .flatMap((k) => cleanQueryList(groups[k]));
}

/**
 * Plain-English names for what the deterministic filter throws away, for the brief to state.
 *
 * The exclusions are half of what a user approves — "it will skip directories, job boards and
 * social networks" is the reassurance the old create form never gave.
 */
const EXCLUSION_CATEGORY_LABELS: Record<string, string> = {
    social: 'social networks',
    aggregator: 'directories and review sites',
    media: 'news, magazines and podcasts',
    reference: 'encyclopaedias and data platforms',
    jobs: 'job boards',
    content_page: 'articles, guides and PDFs',
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    // ── create ────────────────────────────────────────────────────────────────
    if (action === 'create') {
        const assistantId = Number(body.assistantId);
        const idea = str(body.idea, 1000);
        if (!idea) return json(400, { error: 'An idea / blueprint is required.' });

        // IDOR guard: the assistant instance must belong to this org.
        const [assistant] = await db.select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return json(404, { error: 'Assistant not found.' });

        const cadence = ['one_off', 'daily', 'weekly'].includes(String(body.cadence)) ? String(body.cadence) as 'one_off' | 'daily' | 'weekly' : 'one_off';
        const guardrails = (body.guardrails && typeof body.guardrails === 'object') ? body.guardrails as Record<string, unknown> : {};

        // `asDraft` is the chat path (a DiscoveryCampaignProposalCard the user approved in
        // conversation): create the campaign but spend nothing until a human starts it. The form
        // never sets it — a user who filled the form in and pressed "Start finding leads" has
        // already made the decision this flag defers.
        const asDraft = body.asDraft === true;

        // Approving the same proposal twice must not buy two campaigns. It is a live risk rather
        // than a theoretical one: chat transcripts re-hydrate from chatMessages.uiElementJson on
        // reload, so an old proposal card comes back with working buttons.
        //
        // ⚠️ Scoped to the CHAT path, not to `asDraft`. Phase 0 made the form send asDraft too —
        // it now saves a draft and sends the user to the brief instead of starting a run — so
        // keying the dedupe on that flag alone would silently hand a form submission back its
        // previous campaign. Re-submitting the form with the same idea is a deliberate act, and
        // getting someone else's older draft would look like the button was broken.
        const fromForm = body.fromForm === true;
        if (asDraft && !fromForm) {
            const [existing] = await db.select({ id: discoveryCampaigns.id })
                .from(discoveryCampaigns)
                .where(and(
                    eq(discoveryCampaigns.organisationId, orgId),
                    eq(discoveryCampaigns.aiAssistantId, assistantId),
                    eq(discoveryCampaigns.idea, idea),
                    ne(discoveryCampaigns.status, 'archived'),
                ))
                .limit(1);
            if (existing) {
                return json(200, { campaignId: existing.id, jobId: null, cadence, deduped: true, searchConfigured: isSearchConfigured() });
            }
        }

        // Per-org ceiling on RUNNING searches. Checked only for a real start: a draft spends nothing
        // and must always be creatable, or a tenant at the cap cannot even write down the next idea.
        if (!asDraft) {
            const capacity = await activeCampaignCapacity(db, orgId);
            if (!capacity.ok) {
                return json(409, {
                    error: campaignCapacityMessage(capacity.limit),
                    code: 'CAMPAIGN_LIMIT',
                    active: capacity.active,
                    limit: capacity.limit,
                });
            }
        }

        const result = await createDiscoveryRun({
            db, organisationId: orgId, userId, aiAssistantId: assistantId,
            // Optional: the Signal Inbox filters by this, falling back to a truncated idea.
            name: str(body.name, 80),
            idea,
            targetPersona: (body.targetPersona && typeof body.targetPersona === 'object') ? body.targetPersona as Record<string, unknown> : null,
            cadence,
            runAtHourUtc: typeof body.runAtHourUtc === 'number' ? body.runAtHourUtc : undefined,
            // maxCostGbpPerRun is intentionally NOT accepted here. It caps OUR Serper spend, not
            // the user's — nothing bills it to them — so it is an operator ceiling that belongs to
            // the table default (£2.00), not to a chat proposal or a form. It was accepted here
            // once, and a model duly invented "Max £50 per run" onto an approval card.
            guardrails: {
                // ⚠️ CLAMPED, not just type-checked. These two are the only volume fields a caller
                // can set, and until now `typeof x === 'number'` was the whole validation — so the
                // ceiling on a tenant's own discovery was whatever the request body said. See
                // src/config/discovery-limits.ts. Undefined means "keep the table default".
                ...(() => {
                    const perRun = clampGuardrail(guardrails.maxLeadsPerRun, MAX_LEADS_PER_RUN_CEILING);
                    return perRun === undefined ? {} : { maxLeadsPerRun: perRun };
                })(),
                ...(() => {
                    const perMonth = clampGuardrail(guardrails.maxLeadsPerMonth, MAX_LEADS_PER_MONTH_CEILING);
                    return perMonth === undefined ? {} : { maxLeadsPerMonth: perMonth };
                })(),
                ...(Array.isArray(guardrails.negativeKeywords) ? { negativeKeywords: (guardrails.negativeKeywords as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
                ...(Array.isArray(guardrails.excludedDomains) ? { excludedDomains: (guardrails.excludedDomains as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
                ...(typeof guardrails.requireHumanApproval === 'boolean' ? { requireHumanApproval: guardrails.requireHumanApproval } : {}),
            },
            status: asDraft ? 'draft' : 'active',
        });

        // A one-off active campaign enqueued a job; start it now rather than leaving the user
        // watching "Queued" until the next cron tick. jobId is null for a draft or a recurring
        // cadence — a draft must spend nothing, and a recurring run belongs to the dispatcher.
        // Awaited deliberately — see trigger-drain.ts.
        if (result.jobId) {
            await triggerDiscoveryDrain(event.headers as Record<string, string | undefined>, result.jobId, 'discovery-campaigns:create');
        }

        return json(200, { ...result, cadence, asDraft, searchConfigured: isSearchConfigured() });
    }

    // ── list campaigns for an assistant ─────────────────────────────────────────
    if (action === 'list') {
        const assistantId = Number(body.assistantId);
        const campaigns = await db
            .select({
                id: discoveryCampaigns.id, name: discoveryCampaigns.name,
                idea: discoveryCampaigns.idea, status: discoveryCampaigns.status,
                createdAt: discoveryCampaigns.createdAt,
                // Schedule facts, so a card can say WHEN it next runs rather than only how often.
                // Mirrors signal-inbox.ts `list` — the two surfaces show the same search and must
                // not disagree about it. isEnabled distinguishes "no next run exists" (draft, or
                // one_off) from "next run is due"; nextRunAt alone cannot.
                cadence: discoverySchedules.cadence,
                nextRunAt: discoverySchedules.nextRunAt,
                scheduleEnabled: discoverySchedules.isEnabled,
                latestJobStatus: sql<string | null>`(
                    SELECT j.status FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                // Mirrors signal-inbox.ts, and for the same reason: a sliced run rests at
                // status='queued' between slices, so status alone cannot tell a search that has
                // never been looked at from one that is part-way through and already producing
                // leads. `stage` is NULL only until the first slice claims the job.
                latestJobStage: sql<string | null>`(
                    SELECT j.stage FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                leadsFound: sql<number>`(
                    SELECT COALESCE(SUM(j.leads_found), 0)::int FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                )`,
                // What the latest run found on its own — mirrors signal-inbox.ts, and for the same
                // reason: `leads_found` counts only newly INSERTED domains, so a re-run of a
                // campaign that re-finds the same companies scores 0 while the cumulative total
                // above still reads the first run's figure. This card said a bare "15 leads found",
                // which reads as this run's result. Both surfaces show the same campaign and must
                // not disagree about what it just did.
                latestRunLeadsFound: sql<number>`(
                    SELECT COALESCE(j.leads_found, 0)::int FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                // ── Coverage of the latest run ────────────────────────────────────────────
                // Whether that run worked its whole plan or stopped early, and how much of what it
                // read was new. Both live on the job's `cursor` jsonb (no migration — see the
                // Coverage note in process-discovery-jobs.ts). NULL for runs predating this, which
                // the client renders as "not recorded" rather than as "finished cleanly".
                // Territory progress, for the card to say "12 of 58 areas worked".
                territoriesTotal: sql<number | null>`jsonb_array_length(${discoveryCampaigns.approvedBrief} #> '{territoryPlan,territories}')`,
                territoriesCovered: sql<number | null>`jsonb_array_length(${discoveryCampaigns.approvedBrief} #> '{territoryPlan,covered}')`,
            latestRunStopReason: sql<string | null>`(
                    SELECT j.cursor ->> 'stopReason' FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                latestRunQueriesRun: sql<number | null>`(
                    SELECT (j.cursor -> 'coverage' ->> 'queriesRun')::int FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                latestRunQueriesPlanned: sql<number | null>`(
                    SELECT jsonb_array_length(j.cursor -> 'flat') FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                latestRunResolved: sql<number | null>`(
                    SELECT (j.cursor -> 'coverage' ->> 'resolved')::int FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                latestRunNewDomains: sql<number | null>`(
                    SELECT (j.cursor -> 'coverage' ->> 'inserted')::int FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC, j.id DESC LIMIT 1
                )`,
                // Guardrail snapshot so the Edit form can prefill without a second round-trip.
                // Only the fields the form actually shows — maxCostGbpPerRun is operator-only.
                maxLeadsPerRun: discoveryGuardrails.maxLeadsPerRun,
                maxSearchCallsPerRun: discoveryGuardrails.maxSearchCallsPerRun,
                maxTokensPerRun: discoveryGuardrails.maxTokensPerRun,
                negativeKeywords: discoveryGuardrails.negativeKeywords,
                // Returned so a domain blocked from the reject flow is VISIBLE and removable. A
                // one-click permanent exclusion the user can never see again is a trap, not a
                // shortcut.
                excludedDomains: discoveryGuardrails.excludedDomains,
                requireHumanApproval: discoveryGuardrails.requireHumanApproval,
            })
            .from(discoveryCampaigns)
            .leftJoin(discoveryGuardrails, eq(discoveryGuardrails.campaignId, discoveryCampaigns.id))
            .leftJoin(discoverySchedules, eq(discoverySchedules.campaignId, discoveryCampaigns.id))
            .where(and(
                eq(discoveryCampaigns.organisationId, orgId),
                eq(discoveryCampaigns.aiAssistantId, assistantId),
                ne(discoveryCampaigns.status, 'archived'),
            ))
            .orderBy(desc(discoveryCampaigns.createdAt));
        return json(200, { campaigns, searchConfigured: isSearchConfigured() });
    }

    // ── one campaign, in full ───────────────────────────────────────────────────
    //
    // Backs the View / Edit / Schedule modals on the Searches tab. Deliberately NOT a widening of
    // `list`: those three surfaces want the approved search plan, the exclusions and the schedule's
    // day-and-hour, and none of that belongs on a row the tab renders for every search on every
    // poll. One campaign, read when a human opens it.
    if (action === 'get') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({
            id: discoveryCampaigns.id,
            name: discoveryCampaigns.name,
            idea: discoveryCampaigns.idea,
            status: discoveryCampaigns.status,
            createdAt: discoveryCampaigns.createdAt,
            approvedBrief: discoveryCampaigns.approvedBrief,
            targetPersona: discoveryCampaigns.targetPersona,
            maxLeadsPerRun: discoveryGuardrails.maxLeadsPerRun,
            maxSearchCallsPerRun: discoveryGuardrails.maxSearchCallsPerRun,
            maxTokensPerRun: discoveryGuardrails.maxTokensPerRun,
            negativeKeywords: discoveryGuardrails.negativeKeywords,
            excludedDomains: discoveryGuardrails.excludedDomains,
            requireHumanApproval: discoveryGuardrails.requireHumanApproval,
            cadence: discoverySchedules.cadence,
            daysOfWeek: discoverySchedules.daysOfWeek,
            runAtHourUtc: discoverySchedules.runAtHourUtc,
            timezone: discoverySchedules.timezone,
            scheduleEnabled: discoverySchedules.isEnabled,
            nextRunAt: discoverySchedules.nextRunAt,
            lastRunAt: discoverySchedules.lastRunAt,
            // Same latest-job shape (and the same created_at + id tiebreaker) as `list` above —
            // the View modal states what the search is doing beside the same chip the row shows,
            // and two orderings would let them describe different runs.
            latestJobStatus: sql<string | null>`(
                SELECT j.status FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            latestJobStage: sql<string | null>`(
                SELECT j.stage FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            lastFinishedAt: sql<string | null>`(
                SELECT j.updated_at FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                  AND j.status IN ('completed','failed')
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            runCount: sql<number>`(
                SELECT count(*)::int FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id} AND j.status IN ('completed','failed')
            )`,
            leadsFound: sql<number>`(
                SELECT COALESCE(SUM(j.leads_found), 0)::int FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
            )`,
            latestRunLeadsFound: sql<number>`(
                SELECT COALESCE(j.leads_found, 0)::int FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            territoriesTotal: sql<number | null>`jsonb_array_length(${discoveryCampaigns.approvedBrief} #> '{territoryPlan,territories}')`,
            territoriesCovered: sql<number | null>`jsonb_array_length(${discoveryCampaigns.approvedBrief} #> '{territoryPlan,covered}')`,
            // Coverage of that run — see the matching block on the list query above, and the
            // Coverage note in process-discovery-jobs.ts for why these live on the cursor jsonb.
            latestRunStopReason: sql<string | null>`(
                SELECT j.cursor ->> 'stopReason' FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            latestRunQueriesRun: sql<number | null>`(
                SELECT (j.cursor -> 'coverage' ->> 'queriesRun')::int FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            latestRunQueriesPlanned: sql<number | null>`(
                SELECT jsonb_array_length(j.cursor -> 'flat') FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            latestRunResolved: sql<number | null>`(
                SELECT (j.cursor -> 'coverage' ->> 'resolved')::int FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
            latestRunNewDomains: sql<number | null>`(
                SELECT (j.cursor -> 'coverage' ->> 'inserted')::int FROM discovery_jobs j
                WHERE j.campaign_id = ${discoveryCampaigns.id}
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1
            )`,
        })
            .from(discoveryCampaigns)
            .leftJoin(discoveryGuardrails, eq(discoveryGuardrails.campaignId, discoveryCampaigns.id))
            .leftJoin(discoverySchedules, eq(discoverySchedules.campaignId, discoveryCampaigns.id))
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        // The plan the user actually approved, flattened per strategy. Empty until a brief has been
        // approved — a draft has none, and View must say so rather than showing an empty list that
        // reads as "it will search for nothing".
        const brief = (campaign.approvedBrief && typeof campaign.approvedBrief === 'object')
            ? campaign.approvedBrief as Record<string, unknown> : null;
        const briefQueries = (brief?.queries && typeof brief.queries === 'object')
            ? brief.queries as Record<string, unknown> : null;

        return json(200, {
            campaign: {
                id: campaign.id,
                name: campaign.name,
                idea: campaign.idea,
                status: campaign.status,
                createdAt: campaign.createdAt,
                maxLeadsPerRun: campaign.maxLeadsPerRun ?? 50,
                negativeKeywords: Array.isArray(campaign.negativeKeywords) ? campaign.negativeKeywords : [],
                excludedDomains: Array.isArray(campaign.excludedDomains) ? campaign.excludedDomains : [],
                requireHumanApproval: campaign.requireHumanApproval !== false,
                cadence: campaign.cadence ?? 'one_off',
                daysOfWeek: normaliseDaysOfWeek(campaign.daysOfWeek),
                runAtHourUtc: normaliseHourUtc(campaign.runAtHourUtc),
                timezone: campaign.timezone ?? 'UTC',
                scheduleEnabled: campaign.scheduleEnabled === true,
                nextRunAt: campaign.nextRunAt ? new Date(campaign.nextRunAt).toISOString() : null,
                lastRunAt: campaign.lastRunAt ? new Date(campaign.lastRunAt).toISOString() : null,
                latestJobStatus: campaign.latestJobStatus ?? null,
                latestJobStage: campaign.latestJobStage ?? null,
                lastFinishedAt: campaign.lastFinishedAt ? new Date(campaign.lastFinishedAt).toISOString() : null,
                runCount: Number(campaign.runCount ?? 0),
                leadsFound: Number(campaign.leadsFound ?? 0),
                latestRunLeadsFound: Number(campaign.latestRunLeadsFound ?? 0),
                // ⚠️ null, not 0, and deliberately not coerced with Number(). "We did not record
                // coverage for this run" and "this run covered nothing" are different facts, and
                // the card says different things about them — runs predating this feature must not
                // masquerade as runs that covered zero queries.
                territoriesTotal: campaign.territoriesTotal ?? null,
                territoriesCovered: campaign.territoriesCovered ?? null,
                latestRunStopReason: campaign.latestRunStopReason ?? null,
                latestRunQueriesRun: campaign.latestRunQueriesRun ?? null,
                latestRunQueriesPlanned: campaign.latestRunQueriesPlanned ?? null,
                latestRunResolved: campaign.latestRunResolved ?? null,
                latestRunNewDomains: campaign.latestRunNewDomains ?? null,
                approvedQueries: briefQueries ? {
                    niche_scrape: cleanQueryList(briefQueries.niche_scrape),
                    intent_signal: cleanQueryList(briefQueries.intent_signal),
                    footprint: cleanQueryList(briefQueries.footprint),
                } : null,
                briefApprovedAt: typeof brief?.approvedAt === 'string' ? brief.approvedAt : null,
                skippedCategories: Object.values(EXCLUSION_CATEGORY_LABELS),
            },
        });
    }

    // ── generate a brief for review, before anything is searched ────────────────
    //
    // Phase 0. Query generation used to happen INSIDE the job, so the first time anyone saw what
    // the assistant was about to search was never — a prod run spent its whole budget on
    // `site:linkedin.com/jobs` and `best social media agencies UK ... directories` and the only
    // feedback channel was rejecting the leads afterwards.
    //
    // Cost-neutral, not an extra call: the worker skips its own query_gen stage entirely when the
    // job's cursor already carries `flat` (process-discovery-jobs.ts). Generating here and seeding
    // the cursor at approval RELOCATES the existing Haiku call rather than adding one.
    if (action === 'generate_brief') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({
            id: discoveryCampaigns.id,
            idea: discoveryCampaigns.idea,
            targetPersona: discoveryCampaigns.targetPersona,
            icpSnapshot: discoveryCampaigns.icpSnapshot,
            approvedBrief: discoveryCampaigns.approvedBrief,
        })
            .from(discoveryCampaigns)
            .leftJoin(discoveryGuardrails, eq(discoveryGuardrails.campaignId, discoveryCampaigns.id))
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });
        if (!isSearchConfigured()) return json(200, { searchConfigured: false });

        const [g] = await db.select({
            negativeKeywords: discoveryGuardrails.negativeKeywords,
            excludedDomains: discoveryGuardrails.excludedDomains,
        }).from(discoveryGuardrails).where(eq(discoveryGuardrails.campaignId, campaignId)).limit(1);

        const negativeKeywords = Array.isArray(g?.negativeKeywords) ? g!.negativeKeywords as string[] : [];
        const excludedDomains = Array.isArray(g?.excludedDomains) ? g!.excludedDomains as string[] : [];

        // A previously approved plan steers a REGENERATION — never a replay. See QueryGenInput.
        const prior = readApprovedQueries(campaign.approvedBrief);

        const gen = await generateQueries({
            idea: campaign.idea,
            targetPersona: (campaign.targetPersona ?? null) as Record<string, unknown> | null,
            icpSnapshot: (campaign.icpSnapshot ?? null) as Record<string, unknown> | null,
            negativeKeywords,
            approvedQueries: prior,
        });
        void logAiUsage({
            workspaceId: orgId, assistantId: Number(body.assistantId) || 0,
            model: QUERY_GEN_MODEL, inputTokens: gen.inputTokens, outputTokens: gen.outputTokens,
            sessionId: `discovery:brief:${campaignId}`, dataCategories: ['business_context'],
        });
        if (gen.flat.length === 0) {
            return json(200, { failed: true, message: 'Could not draft a search plan for this idea. Try describing the business you are looking for more concretely.' });
        }

        // ── What this plan can actually reach ────────────────────────────────────
        // Tier 2 of the coverage work. Tier 1 told the user AFTER a run that it had sampled rather
        // than covered; this says it while they can still act — narrow the target, raise a limit,
        // or take a different route entirely. The arithmetic is exact (src/config/plan-reach.ts);
        // the market advice is explicitly advisory and may be absent.
        const [gl] = await db.select({
            maxLeadsPerRun: discoveryGuardrails.maxLeadsPerRun,
            maxSearchCallsPerRun: discoveryGuardrails.maxSearchCallsPerRun,
            maxLeadsPerMonth: discoveryGuardrails.maxLeadsPerMonth,
        }).from(discoveryGuardrails).where(eq(discoveryGuardrails.campaignId, campaignId)).limit(1);

        const [{ monthTotal } = { monthTotal: 0 }] = await db.execute<{ monthTotal: number }>(
            `SELECT COALESCE(SUM(leads_found), 0)::int AS "monthTotal"
             FROM discovery_jobs
             WHERE campaign_id = ${campaignId} AND created_at >= date_trunc('month', now())`
        );

        const planReach = computePlanReach(gen.flat.length, {
            maxLeadsPerRun: gl?.maxLeadsPerRun ?? DEFAULT_MAX_LEADS_PER_RUN,
            maxSearchCallsPerRun: gl?.maxSearchCallsPerRun ?? DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
            maxLeadsPerMonth: gl?.maxLeadsPerMonth ?? DEFAULT_MAX_LEADS_PER_MONTH,
            leadsThisMonth: Number(monthTotal ?? 0),
        });

        // ⚠️ Awaited, but it cannot fail the request: assessMarket() swallows everything and
        // resolves null. The user is waiting on this screen, so it is one small call, not a chain.
        const marketAdvice = await assessMarket(campaign.idea, (campaign.icpSnapshot ?? null) as Record<string, unknown> | null);

        // Tier 3: is this plan aimed at an area big enough to be worth working piece by piece?
        // Offered, never applied — the expansion is a separate action the user triggers and reads.
        // Both calls fail soft and resolve null; neither can fail the brief screen.
        const territorySplit = await splitTerritories(
            campaign.idea,
            body.granularity === 'fine' ? 'fine' : 'coarse',
        );

        // The exclusions are returned alongside the queries because they are half of what the user
        // is approving: "it will skip directories, job boards and social networks" is reassurance
        // the old UI never gave, and it is the difference between a plan and a list of strings.
        return json(200, {
            planReach,
            marketAdvice,
            territorySplit,
            queries: gen.queries,
            persona: campaign.targetPersona ?? null,
            icpSnapshot: campaign.icpSnapshot ?? null,
            exclusions: {
                negativeKeywords,
                excludedDomains,
                categories: Object.values(EXCLUSION_CATEGORY_LABELS),
            },
            searchConfigured: true,
        });
    }

    // ── expand a plan across territories ────────────────────────────────────────
    //
    // ⚠️ Returns a plan; saves NOTHING. The expanded queries go back to the same review screen the
    // user was already reading, so a 15-query plan becoming a 60-query one is something they see
    // and can edit before it costs anything. An expansion applied silently would be the same class
    // of surprise this whole piece of work exists to remove.
    if (action === 'expand_territories') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({
            id: discoveryCampaigns.id,
            idea: discoveryCampaigns.idea,
            // Read so a re-split can carry forward what the campaign has already worked.
            approvedBrief: discoveryCampaigns.approvedBrief,
        })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        // From the REQUEST, like approve_brief: the user may have edited the plan on screen, and
        // expanding a regenerated one would silently discard those edits.
        const raw = (body.queries && typeof body.queries === 'object') ? body.queries as Record<string, unknown> : {};
        const queries: GeneratedQueries = {
            niche_scrape: cleanQueryList(raw.niche_scrape),
            intent_signal: cleanQueryList(raw.intent_signal),
            footprint: cleanQueryList(raw.footprint),
        };

        // ⚠️ Prefer the split the BRIEF already computed and showed the user. splitTerritories is a
        // model call and is non-deterministic — the same idea has returned 18, 10, 9 and 12 areas —
        // so re-deriving it here meant the button offered "Split into 9 areas" and the expansion
        // delivered 12. What the user approves has to be what runs.
        const offered = (body.territorySplit && typeof body.territorySplit === 'object')
            ? body.territorySplit as Record<string, unknown> : null;
        const offeredTerritories = Array.isArray(offered?.territories)
            ? offered!.territories
                .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                .map((t) => t.trim().slice(0, 80))
                .slice(0, MAX_TERRITORIES)
            : [];

        // Falls back to a fresh split only when the client sent none — an older cached page, or a
        // caller that predates this. Two territories is the same floor splitTerritories enforces.
        const split = offeredTerritories.length >= 2
            ? {
                area: typeof offered?.area === 'string' ? offered.area.trim().slice(0, 120) : '',
                basis: typeof offered?.basis === 'string' ? offered.basis.trim().slice(0, 120) : '',
                granularity: offered?.granularity === 'fine' ? 'fine' as const : 'coarse' as const,
                parents: Array.isArray(offered?.parents)
                    ? offered!.parents.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                        .map((t) => t.trim().slice(0, 80))
                    : [],
                territories: offeredTerritories,
            }
            : await splitTerritories(campaign.idea, body.granularity === 'fine' ? 'fine' : 'coarse');
        if (!split) return json(200, { expanded: false, reason: 'no_territories' });

        // ── Which queries get expanded ──────────────────────────────────────
        // ONE per strategy. Expanding all fifteen across eighteen counties is 270 searches — a plan
        // nobody can read and a bill nobody sanctioned.
        //
        // ⚠️ NOT blindly the first. The generator often slices geographically on its own, so the
        // first query of a group may already name a place; if that place is one the split did not
        // enumerate, expanding it yields a query about two different places. pickExpansionSource
        // chooses the one the substitution can handle exactly — preferring a query that names the
        // area itself — and everything else is kept verbatim.
        // ── Phase 1: the METHOD ─────────────────────────────────────────────
        // One pre-expansion query per strategy, chosen for how cleanly it substitutes. Kept on the
        // campaign so later runs can continue into territories this plan never reaches — see
        // src/config/territory-plan.ts. Picked before the slice, because the slice is sized from
        // how many templates there turn out to be.
        const templates: Record<'niche_scrape' | 'intent_signal' | 'footprint', string | null> = {
            niche_scrape: null, intent_signal: null, footprint: null,
        };
        const sources: Partial<Record<'niche_scrape' | 'intent_signal' | 'footprint', number>> = {};
        for (const key of ['niche_scrape', 'intent_signal', 'footprint'] as const) {
            const list = queries[key];
            if (list.length === 0) continue;
            const i = pickExpansionSource(list, split.area, split.territories, split.parents ?? []);
            sources[key] = i;
            templates[key] = list[i];
        }

        // ── Progress survives a re-split ────────────────────────────────────
        //
        // ⚠️ `covered: []` here meant that merely re-opening the plan and approving it threw away
        // the sweep. A campaign that had worked ten districts would silently restart at the first,
        // re-searching ground it had already paid for, and nothing on the screen said so.
        //
        // Carried forward BY NAME, not by position: the split is non-deterministic and has returned
        // 56 and 66 areas for the same idea, so index-matching would credit the wrong districts. A
        // name that is no longer in the new list is dropped, since it is no longer part of the plan.
        const prior = readTerritoryPlan(campaign.approvedBrief);
        const stillListed = new Set(split.territories.map((t) => t.toLowerCase()));
        const carriedOver = (prior?.covered ?? []).filter((t) => stillListed.has(t.toLowerCase()));

        const territoryPlan: TerritoryPlan = {
            area: split.area, basis: split.basis,
            granularity: 'granularity' in split ? split.granularity : 'coarse',
            parents: split.parents ?? [],
            territories: split.territories, covered: carriedOver, templates,
        };

        // ── Phase 2: how much of it THIS run takes on ───────────────────────
        //
        // ⚠️ The first slice, not every territory. 58 districts x 3 strategies is 174 queries —
        // more than one run can execute and more than anyone can read on a review screen. Worse,
        // approving all of them seeded a first run that banked no territory progress, so the next
        // run began the sweep at territory one and re-covered ground the first had already done.
        //
        // Slicing here makes the screen honest both ways: what you review is what runs now, and
        // the plan states what follows. A coarse split of 9-13 counties fits inside one slice, so
        // it behaves exactly as it did before.
        const [gl] = await db.select({
            maxLeadsPerRun: discoveryGuardrails.maxLeadsPerRun,
            maxSearchCallsPerRun: discoveryGuardrails.maxSearchCallsPerRun,
            maxLeadsPerMonth: discoveryGuardrails.maxLeadsPerMonth,
        }).from(discoveryGuardrails).where(eq(discoveryGuardrails.campaignId, campaignId)).limit(1);

        const slice = nextSlice(territoryPlan, {
            maxSearchCalls: gl?.maxSearchCallsPerRun ?? DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
            maxPagesPerQuery: MAX_PAGES_PER_QUERY,
        });

        const expandedQueries: GeneratedQueries = { niche_scrape: [], intent_signal: [], footprint: [] };
        for (const key of ['niche_scrape', 'intent_signal', 'footprint'] as const) {
            const list = queries[key];
            const i = sources[key];
            if (list.length === 0 || i === undefined) continue;
            const expanded = expandQueryAcrossTerritories(list[i], split.area, slice, split.parents ?? []);

            // ⚠️ Deduped against the EXPANSION, not just within it. The generator often writes
            // "primary school Kent" alongside the broader query that gets expanded, and expanding
            // across Kent reproduces it exactly — so keeping every leftover verbatim left three
            // identical queries in one group, each a paid search for a result already fetched.
            const seen = new Set(expanded.map((q) => q.toLowerCase()));
            const leftovers = list.filter((q, n) => n !== i && !seen.has(q.trim().toLowerCase()));
            expandedQueries[key] = [...expanded, ...leftovers];
        }

        const flat = flattenQueries(expandedQueries);
        if (flat.length === 0) return json(200, { expanded: false, reason: 'no_territories' });

        // Recomputed for the EXPANDED plan. A split that quadruples the query count usually moves
        // the binding limit to the search cap, and the user needs to see that before approving —
        // otherwise the expansion reads as free coverage when most of it will never run.
        // Same month-to-date figure generate_brief uses. Omitting it here reported a full monthly
        // allowance on the expanded plan while the un-expanded one knew better — two screens
        // disagreeing about the same limit, one of them wrong.
        const [{ monthTotal: expandMonthTotal } = { monthTotal: 0 }] = await db.execute<{ monthTotal: number }>(
            `SELECT COALESCE(SUM(leads_found), 0)::int AS "monthTotal"
             FROM discovery_jobs
             WHERE campaign_id = ${campaignId} AND created_at >= date_trunc('month', now())`
        );

        const planReach = computePlanReach(flat.length, {
            maxLeadsPerRun: gl?.maxLeadsPerRun ?? DEFAULT_MAX_LEADS_PER_RUN,
            maxSearchCallsPerRun: gl?.maxSearchCallsPerRun ?? DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
            maxLeadsPerMonth: gl?.maxLeadsPerMonth ?? DEFAULT_MAX_LEADS_PER_MONTH,
            leadsThisMonth: Number(expandMonthTotal ?? 0),
        });

        // territoryPlan travels back to the client, which returns it on approve_brief. Persisting
        // here would save a plan the user may never approve.
        // `slice` travels back too: approving seeds the first job with exactly these territories,
        // so the run banks progress for the ground it actually works.
        return json(200, { expanded: true, queries: expandedQueries, planReach, territorySplit: split, territoryPlan, slice });
    }

    // ── approve a brief and start the run it describes ──────────────────────────
    if (action === 'approve_brief') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id, status: discoveryCampaigns.status })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        // Take the queries from the REQUEST, not from a regeneration: the whole point is that the
        // run executes what was on screen, including the user's edits.
        const raw = (body.queries && typeof body.queries === 'object') ? body.queries as Record<string, unknown> : {};
        const queries: GeneratedQueries = {
            niche_scrape: cleanQueryList(raw.niche_scrape),
            intent_signal: cleanQueryList(raw.intent_signal),
            footprint: cleanQueryList(raw.footprint),
        };
        const flat = flattenQueries(queries);
        if (flat.length === 0) return json(400, { error: 'A search plan needs at least one query.' });

        // Approving a brief PROMOTES a draft, so it is one of the three doors into 'active' and has
        // to answer to the same per-org ceiling. Refused before the brief is stored: saving the plan
        // and then declining to run it would leave the user with a campaign that looks started.
        if (campaign.status === 'draft') {
            const capacity = await activeCampaignCapacity(db, orgId);
            if (!capacity.ok) {
                return json(409, {
                    error: campaignCapacityMessage(capacity.limit),
                    code: 'CAMPAIGN_LIMIT',
                    active: capacity.active,
                    limit: capacity.limit,
                });
            }
        }

        await db.update(discoveryCampaigns)
            .set({
                approvedBrief: {
                    queries,
                    // ⚠️ The campaign's memory of which territories it has worked. Without it every
                    // run re-plans from scratch and the same few areas get searched repeatedly
                    // while the rest are never looked at once.
                    ...(readTerritoryPlan({ territoryPlan: body.territoryPlan })
                        ? { territoryPlan: readTerritoryPlan({ territoryPlan: body.territoryPlan }) }
                        : {}),
                    persona: body.persona ?? null,
                    exclusions: (body.exclusions && typeof body.exclusions === 'object') ? body.exclusions : null,
                    approvedAt: new Date().toISOString(),
                    approvedBy: userId,
                },
                // Approving is what starts a campaign, mirroring run_now: a draft that has been
                // read and signed off is no longer a draft. Only 'draft' promotes — resurrecting a
                // deliberately paused campaign here would undo a human's decision.
                ...(campaign.status === 'draft' ? { status: 'active' as const } : {}),
                updatedAt: new Date(),
            })
            .where(eq(discoveryCampaigns.id, campaignId));
        if (campaign.status === 'draft') {
            await db.update(discoverySchedules)
                .set({ isEnabled: sql`${discoverySchedules.cadence} <> 'one_off'`, updatedAt: new Date() })
                .where(eq(discoverySchedules.campaignId, campaignId));
        }

        const [inflight] = await db.select({ id: discoveryJobs.id })
            .from(discoveryJobs)
            .where(and(eq(discoveryJobs.campaignId, campaignId), sql`${discoveryJobs.status} IN ('queued','processing')`))
            .limit(1);
        if (inflight) return json(200, { alreadyRunning: true });

        // ⚠️ The cursor is SEEDED here, and that is what makes Phase 0 free. The worker runs its
        // query_gen stage only when `cursor.flat` is missing, so a pre-seeded cursor means the
        // approved queries run verbatim AND the Haiku call is not paid for twice. stage must be
        // 'searching' to match what query_gen would have set.
        const jobId = randomUUID();
        await db.insert(discoveryJobs).values({
            jobId, organisationId: orgId, campaignId, triggerType: 'on_demand',
            // ⚠️ `territorySlice` makes the FIRST run the first leg of the sweep rather than a
            // one-off. Without it that run banked no progress, so the next one restarted at
            // territory one and re-covered ground already worked.
            cursor: {
                flat, queryIndex: 0,
                ...(Array.isArray(body.slice) && body.slice.length
                    ? { territorySlice: (body.slice as unknown[])
                        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                        .map((t) => t.trim().slice(0, 80)) }
                    : {}),
            },
            stage: 'searching',
        });

        await triggerDiscoveryDrain(event.headers as Record<string, string | undefined>, jobId, 'discovery-campaigns:approve_brief');
        return json(200, { jobId, queryCount: flat.length, searchConfigured: isSearchConfigured() });
    }

    // ── enqueue an on-demand run for an existing campaign ───────────────────────
    if (action === 'run_now') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id, status: discoveryCampaigns.status })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        // Starting a draft is what promotes it. Without this a chat-proposed DAILY campaign would
        // run exactly once and never again — status stays 'draft', which the dispatcher filters
        // out, so the recurrence the user agreed to would silently never happen. Only 'draft'
        // promotes: resurrecting a deliberately 'paused' campaign here would undo a human's
        // decision, and the UI disables Run now for paused anyway.
        if (campaign.status === 'draft') {
            // The third door into 'active' — same ceiling, same refusal, checked before the promotion
            // rather than after the job is enqueued.
            const capacity = await activeCampaignCapacity(db, orgId);
            if (!capacity.ok) {
                return json(409, {
                    error: campaignCapacityMessage(capacity.limit),
                    code: 'CAMPAIGN_LIMIT',
                    active: capacity.active,
                    limit: capacity.limit,
                });
            }
            await db.update(discoveryCampaigns)
                .set({ status: 'active', updatedAt: new Date() })
                .where(eq(discoveryCampaigns.id, campaignId));
            await db.update(discoverySchedules)
                .set({ isEnabled: sql`${discoverySchedules.cadence} <> 'one_off'`, updatedAt: new Date() })
                .where(eq(discoverySchedules.campaignId, campaignId));
        }

        const [inflight] = await db.select({ id: discoveryJobs.id })
            .from(discoveryJobs)
            .where(and(eq(discoveryJobs.campaignId, campaignId), sql`${discoveryJobs.status} IN ('queued','processing')`))
            .limit(1);
        if (inflight) return json(200, { alreadyRunning: true });

        const jobId = randomUUID();
        await db.insert(discoveryJobs).values({ jobId, organisationId: orgId, campaignId, triggerType: 'on_demand' });

        // This is the "Start search" / "Run now" button. Someone is watching it, so start the run
        // instead of leaving the row queued for the ten-minute cron (and, on a branch deploy where
        // native crons never fire, leaving it queued for good). Awaited — see trigger-drain.ts.
        await triggerDiscoveryDrain(event.headers as Record<string, string | undefined>, jobId, 'discovery-campaigns:run_now');

        return json(200, { jobId, searchConfigured: isSearchConfigured() });
    }

    // ── list discovered leads for a campaign ────────────────────────────────────
    if (action === 'list_leads') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        const leads = await db
            .select({
                id: discoveredLeads.id, companyName: discoveredLeads.companyName, domain: discoveredLeads.domain,
                sourceUrl: discoveredLeads.sourceUrl, discoveredVia: discoveredLeads.discoveredVia,
                matchedQuery: discoveredLeads.matchedQuery, score: discoveredLeads.score, rating: discoveredLeads.rating,
                status: discoveredLeads.status, createdAt: discoveredLeads.createdAt,
            })
            .from(discoveredLeads)
            .where(and(eq(discoveredLeads.organisationId, orgId), eq(discoveredLeads.campaignId, campaignId)))
            .orderBy(desc(discoveredLeads.score));
        return json(200, { leads });
    }

    // ── pause / resume / archive a campaign ─────────────────────────────────────
    if (action === 'pause' || action === 'resume' || action === 'archive') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        const nextStatus = action === 'pause' ? 'paused' : action === 'archive' ? 'archived' : 'active';
        await db.update(discoveryCampaigns)
            .set({ status: nextStatus, updatedAt: new Date() })
            .where(eq(discoveryCampaigns.id, campaignId));

        // Keep the schedule in lock-step: paused/archived campaigns stop dispatching; resuming
        // re-enables recurring cadences (one_off campaigns have no recurring schedule to run).
        await db.update(discoverySchedules)
            .set({
                isEnabled: action === 'resume' ? sql`${discoverySchedules.cadence} <> 'one_off'` : sql`false`,
                updatedAt: new Date(),
            })
            .where(eq(discoverySchedules.campaignId, campaignId));

        // Pausing/archiving also drops any not-yet-finished run from the queue (see cancel_run).
        if (action !== 'resume') {
            await db.delete(discoveryJobs)
                .where(and(eq(discoveryJobs.campaignId, campaignId), sql`${discoveryJobs.status} IN ('queued','processing')`));
        }
        return json(200, { status: nextStatus });
    }

    // ── set how often a search repeats ──────────────────────────────────────────
    //
    // Cadence was previously write-once, at creation, from a three-option select — so "run it every
    // Monday instead" meant archiving the search and building a new one, losing its history and its
    // dedupe table with it. The schedule row always existed; nothing could edit it.
    //
    // Two rules this branch is careful about:
    //   • A DRAFT keeps its schedule disabled whatever cadence is chosen. Enabling here would let a
    //     search that nobody has read or started begin spending money on a timer — the exact thing
    //     the draft state exists to prevent. Starting it (run_now / approve_brief) enables it.
    //   • A PAUSED search likewise stays disabled: pausing is a decision, and editing the cadence is
    //     not a request to undo it. Resume does that, explicitly.
    if (action === 'schedule') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id, status: discoveryCampaigns.status })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        if (!isDiscoveryCadence(body.cadence)) {
            return json(400, { error: 'Choose how often this search should run.' });
        }
        const cadence = body.cadence;
        const runAtHourUtc = normaliseHourUtc(body.runAtHourUtc);
        // Only weekly carries days. Storing them for daily would be dead data that the next reader
        // has to guess the meaning of — and computeNextRun ignores them there anyway.
        const daysOfWeek = cadence === 'weekly' ? normaliseDaysOfWeek(body.daysOfWeek) : null;
        if (cadence === 'weekly' && !daysOfWeek) {
            return json(400, { error: 'Pick at least one day of the week.' });
        }
        const timezone = str(body.timezone, 64) ?? 'UTC';

        // `enabled: false` is "keep the cadence but stop it firing" — the schedule equivalent of
        // pausing, without touching the campaign's own status.
        const wantEnabled = body.enabled !== false;
        const isEnabled = wantEnabled && cadence !== 'one_off' && campaign.status === 'active';
        const nextRunAt = isEnabled ? computeNextRun(cadence, runAtHourUtc, daysOfWeek, new Date()) : null;

        const patch = {
            cadence, daysOfWeek, runAtHourUtc, timezone, isEnabled, nextRunAt, updatedAt: new Date(),
        };
        const updated = await db.update(discoverySchedules)
            .set(patch)
            .where(eq(discoverySchedules.campaignId, campaignId))
            .returning({ id: discoverySchedules.id });
        // Every campaign gets a schedule row at creation, but a row that went missing must not make
        // the cadence silently unsettable — the UI would report success and nothing would repeat.
        if (updated.length === 0) {
            await db.insert(discoverySchedules).values({ organisationId: orgId, campaignId, ...patch });
        }

        return json(200, {
            cadence, daysOfWeek, runAtHourUtc, timezone, scheduleEnabled: isEnabled,
            nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
            // Why nothing is scheduled, when nothing is — the client says this out loud rather than
            // showing a saved schedule with no next run and letting the user infer a bug.
            blockedBy: isEnabled || cadence === 'one_off' ? null : campaign.status,
        });
    }

    // ── cancel the in-flight run, leaving the campaign active ───────────────────
    if (action === 'cancel_run') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });
        // Delete queued AND processing jobs. A processing job's worker runs each slice as a
        // separate statement, so a mid-slice delete removes the row and its next update no-ops.
        const cancelled = await db.delete(discoveryJobs)
            .where(and(eq(discoveryJobs.campaignId, campaignId), sql`${discoveryJobs.status} IN ('queued','processing')`))
            .returning({ id: discoveryJobs.id });
        return json(200, { cancelled: cancelled.length });
    }

    // ── edit a campaign's idea + guardrails ─────────────────────────────────────
    if (action === 'edit') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        // `name` is settable independently of `idea` — renaming a search must not require
        // retyping the hypothesis, and clearing it (empty string) reverts to the idea fallback.
        const idea = str(body.idea, 1000);
        const namePatch = body.name === undefined ? {} : { name: str(body.name, 80) };
        if (idea || Object.keys(namePatch).length) {
            await db.update(discoveryCampaigns)
                .set({ ...(idea ? { idea } : {}), ...namePatch, updatedAt: new Date() })
                .where(eq(discoveryCampaigns.id, campaignId));
        }

        const g = (body.guardrails && typeof body.guardrails === 'object') ? body.guardrails as Record<string, unknown> : null;
        if (g) {
            const patch: Record<string, unknown> = { updatedAt: new Date() };
            // maxCostGbpPerRun is not editable — see the create branch above.
            // Clamped on the way in, exactly as on create: the edit modal is the other door to the
            // same column, and a limit that can only be raised through Edit is not a limit.
            // The two limits that actually end a run, now settable. Both were invisible: a user
            // could raise their lead cap to 200 and still be stopped at ~63 searches by a token
            // budget they had never been shown.
            const searchCalls = clampGuardrail(g.maxSearchCallsPerRun, MAX_SEARCH_CALLS_PER_RUN_CEILING);
            if (searchCalls !== undefined) patch.maxSearchCallsPerRun = searchCalls;
            const tokens = clampGuardrail(g.maxTokensPerRun, MAX_TOKENS_PER_RUN_CEILING);
            if (tokens !== undefined) patch.maxTokensPerRun = tokens;

            const perRun = clampGuardrail(g.maxLeadsPerRun, MAX_LEADS_PER_RUN_CEILING);
            if (perRun !== undefined) patch.maxLeadsPerRun = perRun;
            const perMonth = clampGuardrail(g.maxLeadsPerMonth, MAX_LEADS_PER_MONTH_CEILING);
            if (perMonth !== undefined) patch.maxLeadsPerMonth = perMonth;
            if (Array.isArray(g.negativeKeywords)) patch.negativeKeywords = (g.negativeKeywords as unknown[]).filter((x): x is string => typeof x === 'string');
            // Accepted here so a blocked domain can be REVIEWED and removed. The column and the
            // run-time filter both existed already; only this branch was missing, which made
            // exclusions from the reject flow a one-way door with no surface to undo them.
            // Normalised on the way in — isExcluded() compares against a normalised domain, so
            // "https://Foo.com/" stored raw would silently never match anything.
            if (Array.isArray(g.excludedDomains)) {
                patch.excludedDomains = (g.excludedDomains as unknown[])
                    .filter((x): x is string => typeof x === 'string')
                    .map((d) => normaliseDomain(d))
                    .filter((d): d is string => !!d);
            }
            if (typeof g.requireHumanApproval === 'boolean') patch.requireHumanApproval = g.requireHumanApproval;
            if (Object.keys(patch).length > 1) {
                await db.update(discoveryGuardrails).set(patch).where(eq(discoveryGuardrails.campaignId, campaignId));
            }
        }
        return json(200, { ok: true });
    }

    // ── exclude one domain from a campaign ──────────────────────────────────────
    // The follow-up to rejecting a lead as a competitor or a non-business. Deliberately NOT the
    // `edit` branch above: that one REPLACES the array, so a caller who only knows about one
    // domain would have to read-modify-write and would clobber a concurrent change. Appending
    // server-side keeps the whole operation in one statement and means the browser never needs to
    // hold the full list.
    if (action === 'exclude_domain') {
        const campaignId = Number(body.campaignId);
        const domain = normaliseDomain(str(body.domain, 253) ?? '');
        if (!domain) return json(400, { error: 'A valid domain is required.' });

        const [campaign] = await db.select({ id: discoveryCampaigns.id })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        const [row] = await db.select({ excludedDomains: discoveryGuardrails.excludedDomains })
            .from(discoveryGuardrails)
            .where(eq(discoveryGuardrails.campaignId, campaignId))
            .limit(1);
        if (!row) return json(404, { error: 'This search has no guardrails row to update.' });

        const current = Array.isArray(row.excludedDomains)
            ? (row.excludedDomains as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
        // Already blocked: report success rather than an error. The user's intent is satisfied, and
        // a second click on a stale card must not read as a failure.
        if (current.includes(domain)) return json(200, { ok: true, domain, alreadyExcluded: true });

        await db.update(discoveryGuardrails)
            .set({ excludedDomains: [...current, domain], updatedAt: new Date() })
            .where(eq(discoveryGuardrails.campaignId, campaignId));

        return json(200, { ok: true, domain, alreadyExcluded: false });
    }

    return json(400, { error: `Unknown action "${action}".` });
});
