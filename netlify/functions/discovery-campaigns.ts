// netlify/functions/discovery-campaigns.ts
// Tenant-scoped API for the Lead Generator's outbound discovery campaigns. Backs the
// "Idea / Blueprint" UI on assistant-detail.html. Every action is ownership-checked
// (IDOR guard) against the caller's organisation. Design: docs/lead-generator-discovery-plan.md.
//
//   POST { action: 'create',    assistantId, idea, targetPersona?, guardrails?, cadence?, runAtHourUtc? }
//        → creates campaign (+guardrails+schedule); one_off enqueues a run now. → { campaignId, jobId }
//   POST { action: 'list',      assistantId }
//        → this assistant's campaigns, newest first, each with its latest run status.
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
import { createDiscoveryRun } from '../../src/utils/discovery';
import { triggerDiscoveryDrain } from '../../src/utils/trigger-drain';
import { isSearchConfigured, normaliseDomain } from '../../src/lib/discovery-search';
import {
    generateQueries, flattenQueries, QUERY_GEN_MODEL, type GeneratedQueries,
} from '../../src/lib/discovery-query-gen';
import { logAiUsage } from '../../src/utils/ai-usage';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function str(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Cap per strategy on an APPROVED plan. Matches the generator's ceiling — each query is paid search. */
const MAX_QUERIES_PER_STRATEGY = 10;

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
                ...(typeof guardrails.maxLeadsPerRun === 'number' ? { maxLeadsPerRun: guardrails.maxLeadsPerRun } : {}),
                ...(typeof guardrails.maxLeadsPerMonth === 'number' ? { maxLeadsPerMonth: guardrails.maxLeadsPerMonth } : {}),
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
                // Guardrail snapshot so the Edit form can prefill without a second round-trip.
                // Only the fields the form actually shows — maxCostGbpPerRun is operator-only.
                maxLeadsPerRun: discoveryGuardrails.maxLeadsPerRun,
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

        // The exclusions are returned alongside the queries because they are half of what the user
        // is approving: "it will skip directories, job boards and social networks" is reassurance
        // the old UI never gave, and it is the difference between a plan and a list of strings.
        return json(200, {
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

        await db.update(discoveryCampaigns)
            .set({
                approvedBrief: {
                    queries,
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
            cursor: { flat, queryIndex: 0 }, stage: 'searching',
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
            if (typeof g.maxLeadsPerRun === 'number') patch.maxLeadsPerRun = g.maxLeadsPerRun;
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
