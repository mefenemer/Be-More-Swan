// netlify/functions/process-discovery-jobs.ts
// Drains the discovery_jobs queue. Mirrors process-content-jobs.ts: FOR UPDATE SKIP
// LOCKED claim, stuck-job reset, exponential backoff. The difference is each tick runs
// only a BOUNDED SLICE of a run and persists progress on discovery_jobs.cursor, so a
// logical run spans many 1-minute ticks and never hits a function timeout.
// Design: docs/lead-generator-discovery-plan.md §2.
//
// Slice model:
//   stage query_gen  → generate search queries once, cache on cursor.flat, resume
//   stage searching  → process a few queries/tick: search → dedupe → store → score
//   stage promoting  → mirror qualified discovered_leads into assistant_records
//   stage enriching  → scrape each hot/warm lead's own site for a contact address
//
// Guardrails (discovery_guardrails) are enforced BEFORE each unit of work; tripping a
// cap ends the run cleanly and promotes whatever qualified so far.

import { Handler } from '@netlify/functions';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    discoveryCampaigns, discoveryGuardrails, discoveredLeads, discoveryJobs,
    aiAssistants, assistantRecords,
} from '../../db/schema';
import { generateQueries, type DiscoveryStrategy } from '../../src/lib/discovery-query-gen';
import { scoreCandidates, type ScoreCandidate } from '../../src/lib/discovery-scoring';
import { search, isSearchConfigured, normaliseDomain, fetchSiteIdentity, SearchNotConfiguredError } from '../../src/lib/discovery-search';
import { enrichLeadContact } from '../../src/lib/discovery-enrich';
import { recordEnrichment } from '../../src/utils/lead-enrichment';
import {
    isEnrichProviderConfigured, lookupProviderContact, ENRICH_COST_GBP_PER_LOOKUP,
} from '../../src/lib/discovery-enrich-provider';
import { classifyCandidate, resolveCandidateDomain } from '../../src/lib/discovery-domain-filter';
import { logAiUsage } from '../../src/utils/ai-usage';
import { enqueueScenarioTrigger } from '../../src/utils/scenario-engine';
import { recordEvent } from '../../src/utils/revenue-ledger';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { getIcpSnapshot } from '../../src/utils/icp-snapshot';
import { createNotification } from '../../src/utils/notify';
import { savedSearchLabel } from '../../src/config/signal-sources';
import { withLambda } from '@netlify/aws-lambda-compat';

type Db = ReturnType<typeof getDb>;

const BACKOFF_SECS = [10, 30, 90];
// Queries processed per tick — ONE search + one scoring call per slice keeps a tick well
// under Netlify's ~10s function limit (3/tick was hitting 504 Inactivity Timeouts). The
// cursor resumes the next query on the next tick, so total coverage is unchanged.
const QUERIES_PER_SLICE = 1;
const RESULTS_PER_QUERY = 10;
// Leads promoted into assistant_records per tick — bounded so promotion can't exceed the
// function timeout even when a run discovered dozens of leads.
const PROMOTE_BATCH = 20;
// Leads whose site is scraped for a contact address per tick. Each one costs up to 4
// sequential HTTPS fetches (2.5s timeout each), so the batch runs CONCURRENTLY and stays
// small — the tick budget is ~10s and 3 searches/tick already caused 504s.
const ENRICH_BATCH = 5;
// Whole-slice budget for reading rewritten candidates' home pages for their real name. Only
// rewritten hits need one, they run concurrently, and the slice already spends ~10s on a search
// plus a scoring call — so this is deliberately smaller than the per-lead enrichment budget.
const IDENTITY_BUDGET_MS = 4000;
// Whole-slice budget for the PAID enrichment phase. Runs after the scrape phase and concurrently
// across the batch, so the slice costs the slower of the two phases rather than their sum — the
// compounding that cost this worker a round of 504s the first time round.
const PAID_ENRICH_BUDGET_MS = 3000;

type JobRow = {
    id: number; job_id: string; organisation_id: number; campaign_id: number;
    attempt: number; max_attempts: number;
};

interface Cursor {
    flat: Array<{ query: string; strategy: DiscoveryStrategy }>;
    queryIndex: number;
}

interface Guardrails {
    maxLeadsPerRun: number; maxLeadsPerMonth: number; maxSearchCallsPerRun: number;
    maxEnrichmentCallsPerRun: number;
    maxTokensPerRun: number; maxCostGbpPerRun: number;
    negativeKeywords: string[]; excludedDomains: string[]; requireHumanApproval: boolean;
}

const DEFAULT_GUARDRAILS: Guardrails = {
    maxLeadsPerRun: 50, maxLeadsPerMonth: 500, maxSearchCallsPerRun: 100,
    // Matches db/discovery-enrichment-cap.sql's default. A campaign row predating that migration
    // reads NULL, and Number(null) is 0 — which would silently disable paid enrichment rather
    // than cap it — so loadGuardrails coalesces to this instead.
    maxEnrichmentCallsPerRun: 25,
    maxTokensPerRun: 200000, maxCostGbpPerRun: 2.0,
    negativeKeywords: [], excludedDomains: [], requireHumanApproval: true,
};

// ── Queue drain (public — driven by native cron AND run-discovery-jobs.ts) ─────

export async function drainDiscoveryJobs(): Promise<number> {
    const db = getDb();

    // Reset jobs stuck in 'processing' for >3 minutes (function timed out mid-slice). A slice runs
    // in ~10s and bumps updated_at, so a run making progress is never caught by this — including
    // one being driven in a tight loop by run-discovery-jobs-background.
    await db.execute(
        `UPDATE discovery_jobs SET status = 'queued', next_retry_at = now()
         WHERE status = 'processing' AND updated_at < now() - interval '3 minutes' AND attempt < max_attempts`
    );

    // Claim and select in ONE statement. This used to be a SELECT ... FOR UPDATE SKIP LOCKED
    // followed by a separate UPDATE inside processJob, which left a window where two drainers
    // could return the same row: the row lock is released when the SELECT statement ends, because
    // db.execute does not wrap it in a transaction. That window was tolerable while the only
    // drainer was a ten-minute cron. It is not, now that run-discovery-jobs-background loops the
    // drain for minutes at a time and can overlap a cron tick — and a double-claimed slice means
    // the same search query billed twice and its leads inserted twice.
    const jobs = await db.execute<JobRow>(
        `UPDATE discovery_jobs SET status = 'processing', updated_at = now()
         WHERE id IN (
             SELECT id FROM discovery_jobs
             WHERE status = 'queued'
               AND (next_retry_at IS NULL OR next_retry_at <= now())
             ORDER BY created_at
             LIMIT 5
             FOR UPDATE SKIP LOCKED
         )
         RETURNING id, job_id, organisation_id, campaign_id, attempt, max_attempts`
    );
    if (!jobs.length) return 0;

    await Promise.allSettled(jobs.map((job) => processJob(db, job)));
    return jobs.length;
}

export default withLambda(async () => {
    const processed = await drainDiscoveryJobs();
    return { statusCode: 200, body: processed ? `processed ${processed} discovery jobs` : 'no jobs' };
});

// ── One bounded slice of one job ───────────────────────────────────────────────

async function processJob(db: Db, job: JobRow): Promise<void> {
    // The slice is ALREADY claimed — drainDiscoveryJobs set status='processing' in the same
    // statement that selected this row, so there is no second claim to make here.
    // NOTE: attempt is bumped only on failure (handleFailure), not per slice — a legit run spans
    // many slices and must not exhaust its retry budget just by making progress.
    try {
        // Load campaign + owning assistant (name + roleKey for scoring prompt).
        const [campaign] = await db
            .select({
                id: discoveryCampaigns.id,
                aiAssistantId: discoveryCampaigns.aiAssistantId,
                idea: discoveryCampaigns.idea,
                targetPersona: discoveryCampaigns.targetPersona,
                icpSnapshot: discoveryCampaigns.icpSnapshot,
                approvedBrief: discoveryCampaigns.approvedBrief,
                assistantName: aiAssistants.name,
            })
            .from(discoveryCampaigns)
            .leftJoin(aiAssistants, eq(discoveryCampaigns.aiAssistantId, aiAssistants.id))
            .where(eq(discoveryCampaigns.id, job.campaign_id))
            .limit(1);
        if (!campaign) {
            await finishJob(db, job.id, 'failed', 'Campaign no longer exists.');
            return;
        }
        const assistantName = campaign.assistantName ?? 'your business';
        const icp = (campaign.icpSnapshot && typeof campaign.icpSnapshot === 'object' ? campaign.icpSnapshot : {}) as Record<string, unknown>;
        // The other half of the attribution key (§7.2). Read ONCE per job rather than per lead:
        // one job is one campaign is one assistant, and a recompile mid-run should not split a
        // single run's events across two versions.
        const blueprintVersion = await getBlueprintVersion(db, campaign.aiAssistantId);
        const guardrails = await loadGuardrails(db, job.campaign_id);

        // Current run counters (persisted on the job row).
        const [state] = await db
            .select({
                cursor: discoveryJobs.cursor,
                stage: discoveryJobs.stage,
                leadsFound: discoveryJobs.leadsFound,
                searchCallsMade: discoveryJobs.searchCallsMade,
                tokensUsed: discoveryJobs.tokensUsed,
                costGbp: discoveryJobs.costGbp,
            })
            .from(discoveryJobs)
            .where(eq(discoveryJobs.id, job.id))
            .limit(1);
        let leadsFound = state?.leadsFound ?? 0;
        let searchCallsMade = state?.searchCallsMade ?? 0;
        let tokensUsed = state?.tokensUsed ?? 0;
        let costGbp = Number(state?.costGbp ?? 0);
        const cursor = (state?.cursor && typeof state.cursor === 'object' ? state.cursor : null) as Cursor | null;

        // ── STAGE query_gen: generate queries once, cache, resume next tick ──────
        if (!cursor || !Array.isArray(cursor.flat)) {
            const gen = await generateQueries({
                idea: campaign.idea,
                targetPersona: (campaign.targetPersona ?? null) as Record<string, unknown> | null,
                icpSnapshot: icp,
                negativeKeywords: guardrails.negativeKeywords,
                // A brief the user approved steers this REGENERATION (Phase 0). Reaching this
                // branch at all means the cursor was not seeded, i.e. this is a scheduled re-run
                // rather than the approved first run — and re-issuing the approved strings
                // verbatim would return the same domains, which the (campaign_id, domain) dedupe
                // then discards wholesale. So the plan is shown to the model as the shape the user
                // signed off, and fresh queries are written within it.
                approvedQueries: approvedQueriesOf(campaign.approvedBrief),
            });
            tokensUsed += gen.inputTokens + gen.outputTokens;
            void logAiUsage({
                workspaceId: job.organisation_id, assistantId: campaign.aiAssistantId,
                model: 'claude-haiku-4-5-20251001', inputTokens: gen.inputTokens, outputTokens: gen.outputTokens,
                sessionId: `discovery:${job.job_id}:query_gen`, dataCategories: ['business_context'],
            });
            if (gen.flat.length === 0) {
                await finishJob(db, job.id, 'failed', 'Could not generate search queries for this idea.');
                return;
            }
            const newCursor: Cursor = { flat: gen.flat, queryIndex: 0 };
            await db.update(discoveryJobs)
                .set({ cursor: newCursor, stage: 'searching', status: 'queued', tokensUsed, updatedAt: new Date() })
                .where(eq(discoveryJobs.id, job.id));
            return; // resume on the next tick in the searching stage
        }

        // ── STAGE promoting: mirror qualified leads into the Leads tab, a BOUNDED batch
        // per tick (promoting 60+ leads in one slice was itself blowing the function timeout). ──
        if (state?.stage === 'promoting') {
            await promoteBatch(db, job, campaign.aiAssistantId, guardrails, { leadsFound, searchCallsMade, tokensUsed, costGbp });
            return;
        }

        // ── STAGE enriching: find a contact address for each promoted hot/warm lead ──
        if (state?.stage === 'enriching') {
            await enrichBatch(db, job, guardrails, { leadsFound, searchCallsMade, tokensUsed, costGbp });
            return;
        }

        // ── Monthly volume cap (across all this campaign's runs this month) ──────
        const [{ monthTotal } = { monthTotal: 0 }] = await db.execute<{ monthTotal: number }>(
            `SELECT COALESCE(SUM(leads_found), 0)::int AS "monthTotal"
             FROM discovery_jobs
             WHERE campaign_id = ${job.campaign_id} AND created_at >= date_trunc('month', now())`
        );
        if (monthTotal >= guardrails.maxLeadsPerMonth) {
            await enterPromoting(db, job.id, { leadsFound, searchCallsMade, tokensUsed, costGbp });
            return;
        }

        // ── STAGE searching: process the next slice of queries ──────────────────
        const slice = cursor.flat.slice(cursor.queryIndex, cursor.queryIndex + QUERIES_PER_SLICE);
        // Each qualified lead is mirrored into the Leads tab AS IT'S FOUND (not just in the
        // end-of-run promoting stage), so the tab fills live during a run. The promoting stage
        // below stays as a safety net for any lead whose inline promotion failed.
        const approvalStatus = guardrails.requireHumanApproval ? 'pending_approval' : 'approved';
        let stopped = false;

        for (const { query, strategy } of slice) {
            // Enforce per-run caps BEFORE spending anything.
            if (
                searchCallsMade >= guardrails.maxSearchCallsPerRun ||
                costGbp >= guardrails.maxCostGbpPerRun ||
                tokensUsed >= guardrails.maxTokensPerRun ||
                leadsFound >= guardrails.maxLeadsPerRun
            ) { stopped = true; break; }

            if (!isSearchConfigured()) throw new SearchNotConfiguredError();

            const { results, costGbp: callCost } = await search(query, { limit: RESULTS_PER_QUERY });
            searchCallsMade += 1;
            costGbp += callCost;

            // Resolve each hit to the company it is about, then dedupe, then apply guardrails.
            //
            // ⚠️ The resolve step MUST come before the dedupe. It can rewrite blog.foo.co.uk to
            // foo.co.uk, so two hits that look distinct at this point (a company's blog post and
            // its home page) collapse to one domain — dedupe after the rewrite or they survive as
            // duplicates and only collide at the (campaign_id, domain) unique index.
            //
            // resolveCandidateDomain subsumes the old classifyCandidate test: it drops everything
            // that was dropped before, except the two shapes where the company is real and only
            // the PAGE was wrong (its own blog post, a blog./careers. subdomain). Those it keeps,
            // pointing at the root domain. See docs/discovery-candidate-resolution-plan.md.
            const seen = new Set<string>();
            const resolved = results
                .map((r) => ({ ...r, domain: normaliseDomain(r.domain || r.url) }))
                .map((r) => {
                    const res = resolveCandidateDomain({ domain: r.domain, url: r.url, title: r.title });
                    if (!res) {
                        const verdict = classifyCandidate({ domain: r.domain, url: r.url, title: r.title });
                        console.log(`[discovery] job ${job.job_id} dropped ${r.domain} (${verdict.category}): ${verdict.reason}`);
                        return null;
                    }
                    if (res.rewritten) {
                        console.log(`[discovery] job ${job.job_id} resolved ${r.domain} → ${res.domain}: ${res.reason}`);
                    }
                    return { ...r, domain: res.domain, rewrittenFrom: res.rewritten ? r.domain : null };
                })
                .filter((r): r is NonNullable<typeof r> => r !== null)
                .filter((r) => r.domain && !seen.has(r.domain) && (seen.add(r.domain), true))
                .filter((r) => !isExcluded(r.domain!, `${r.title} ${r.snippet}`, guardrails));

            // A rewritten candidate's title and snippet describe the ARTICLE that surfaced it, not
            // the company — and `companyName` is taken straight from the title. Read the company's
            // own home page for an honest name before scoring. Budgeted across the whole slice and
            // run concurrently: enrichment learned the hard way that four slow-but-not-timing-out
            // fetches compound past the function tick (LEAD_BUDGET_MS in discovery-enrich.ts).
            // On timeout or failure the lead is kept with its domain as the name — never dropped.
            const candidates = await resolveIdentities(resolved, job.job_id);

            if (candidates.length === 0) continue;

            // Insert new domains only (dedupe against prior runs via the unique index).
            const inserted = await db.insert(discoveredLeads)
                .values(candidates.map((c) => ({
                    organisationId: job.organisation_id,
                    campaignId: job.campaign_id,
                    jobId: job.id,
                    companyName: c.title || c.domain!,
                    domain: c.domain,
                    sourceUrl: c.url,
                    discoveredVia: strategy,
                    matchedQuery: query,
                    // rewrittenFrom records that this lead is the ROOT of the page that actually
                    // ranked — the company is right, the URL that found it was its blog post or a
                    // publishing subdomain. Without it, a lead whose sourceUrl is an article looks
                    // like a filter failure rather than a deliberate resolution. jsonb, no migration.
                    signals: c.rewrittenFrom
                        ? { snippet: c.snippet, rewrittenFrom: c.rewrittenFrom }
                        : { snippet: c.snippet },
                    status: 'discovered' as const,
                })))
                // Match the PARTIAL unique index (…) WHERE domain IS NOT NULL — Postgres won't
                // infer a partial index from a bare ON CONFLICT target, so the predicate is required.
                .onConflictDoNothing({ target: [discoveredLeads.campaignId, discoveredLeads.domain], where: sql`${discoveredLeads.domain} IS NOT NULL` })
                .returning({ id: discoveredLeads.id, companyName: discoveredLeads.companyName, domain: discoveredLeads.domain, snippet: sql<string>`(${discoveredLeads.signals} ->> 'snippet')` });

            if (inserted.length === 0) continue;

            // Score the newly-discovered candidates (one batched call).
            const toScore: ScoreCandidate[] = inserted.map((r) => ({ companyName: r.companyName, domain: r.domain, snippet: r.snippet }));
            const scored = await scoreCandidates(toScore, icp, assistantName);
            tokensUsed += scored.inputTokens + scored.outputTokens;
            void logAiUsage({
                workspaceId: job.organisation_id, assistantId: campaign.aiAssistantId,
                model: 'claude-haiku-4-5-20251001', inputTokens: scored.inputTokens, outputTokens: scored.outputTokens,
                sessionId: `discovery:${job.job_id}:scoring`, dataCategories: ['business_context'],
            });

            for (let i = 0; i < inserted.length; i++) {
                const card = scored.cards[i];
                await db.update(discoveredLeads)
                    .set({ score: card.score, rating: card.rating, scoringCard: card, status: 'qualified', updatedAt: new Date() })
                    .where(eq(discoveredLeads.id, inserted[i].id));
                // Mirror into the Leads tab immediately (item 4). promoteOne flips the row to
                // 'promoted' + links the assistant_record, so the promoting stage skips it later.
                const recordId = await promoteOne(db, job.organisation_id, campaign.aiAssistantId, {
                    id: inserted[i].id, companyName: inserted[i].companyName, rating: card.rating, scoringCard: card,
                }, approvalStatus);

                // Revenue ledger (Phase 0). Emitted AFTER promoteOne so both events carry the
                // assistant_record link. `icp` is the campaign's activation-time snapshot, which is
                // exactly the attribution key the Strategy Agent needs — it says which ICP was live
                // when this lead was found, not which one is live when the aggregate runs.
                // recordEvent never throws, so no try/catch here by design.
                const ledgerBase = {
                    organisationId: job.organisation_id,
                    aiAssistantId: campaign.aiAssistantId,
                    discoveredLeadId: inserted[i].id,
                    assistantRecordId: recordId,
                    actor: 'agent' as const,
                    icpSnapshot: icp,
                    blueprintVersion,
                };
                await recordEvent(db, 'lead_discovered', {
                    ...ledgerBase,
                    payload: { domain: inserted[i].domain, matchedQuery: query, discoveredVia: strategy },
                });
                await recordEvent(db, 'lead_scored', {
                    ...ledgerBase,
                    payload: { score: card.score, rating: card.rating },
                });
            }
            leadsFound += inserted.length;
        }

        const nextIndex = cursor.queryIndex + slice.length;
        const done = stopped || nextIndex >= cursor.flat.length;

        if (done) {
            // Searching finished — hand off to the resumable promoting stage.
            await enterPromoting(db, job.id, { leadsFound, searchCallsMade, tokensUsed, costGbp });
        } else {
            // Persist progress and resume next tick.
            await db.update(discoveryJobs)
                .set({
                    cursor: { flat: cursor.flat, queryIndex: nextIndex } satisfies Cursor,
                    status: 'queued', stage: 'searching', errorMessage: null,
                    leadsFound, searchCallsMade, tokensUsed, costGbp: String(costGbp), updatedAt: new Date(),
                })
                .where(eq(discoveryJobs.id, job.id));
        }
    } catch (err) {
        await handleFailure(db, job, err);
    }
}

// ── Promotion: mirror qualified discovered_leads into assistant_records ─────────
// Bounded + resumable: each tick promotes at most PROMOTE_BATCH leads, then either stays
// in the promoting stage (more remain) or marks the job completed. This keeps promotion
// within the function timeout even for runs that discovered many leads.

type Counters = { leadsFound: number; searchCallsMade: number; tokensUsed: number; costGbp: number };

function counterCols(c: Counters) {
    return { leadsFound: c.leadsFound, searchCallsMade: c.searchCallsMade, tokensUsed: c.tokensUsed, costGbp: String(c.costGbp) };
}

/** Flip a finished searching run into the promoting stage; the next tick promotes. */
async function enterPromoting(db: Db, jobId: number, counters: Counters): Promise<void> {
    await db.update(discoveryJobs)
        .set({ status: 'queued', stage: 'promoting', errorMessage: null, ...counterCols(counters), updatedAt: new Date() })
        .where(eq(discoveryJobs.id, jobId));
}

async function promoteBatch(db: Db, job: JobRow, assistantId: number, guardrails: Guardrails, counters: Counters): Promise<void> {
    const batch = await db
        .select({ id: discoveredLeads.id, companyName: discoveredLeads.companyName, rating: discoveredLeads.rating, scoringCard: discoveredLeads.scoringCard })
        .from(discoveredLeads)
        .where(and(
            eq(discoveredLeads.campaignId, job.campaign_id),
            eq(discoveredLeads.status, 'qualified'),
            isNull(discoveredLeads.assistantRecordId),
        ))
        .limit(PROMOTE_BATCH);

    const approvalStatus = guardrails.requireHumanApproval ? 'pending_approval' : 'approved';
    for (const lead of batch) {
        await promoteOne(db, job.organisation_id, assistantId, lead, approvalStatus);
    }

    // Anything left to promote? If so, stay in the promoting stage; else move on to
    // enriching (leads are already visible in the Leads tab by now — enrichment only
    // backfills the contact address, so it deliberately runs last).
    const [{ remaining } = { remaining: 0 }] = await db.execute<{ remaining: number }>(
        `SELECT count(*)::int AS remaining FROM discovered_leads
         WHERE campaign_id = ${job.campaign_id} AND status = 'qualified' AND assistant_record_id IS NULL`
    );
    await db.update(discoveryJobs)
        .set({
            status: 'queued', stage: remaining > 0 ? 'promoting' : 'enriching', errorMessage: null,
            ...counterCols(counters), updatedAt: new Date(),
        })
        .where(eq(discoveryJobs.id, job.id));
}

// ── Enrichment: scrape each promoted lead's own site for a contact address ──────
// Discovery surfaces companies, not people, so a promoted lead has no email and
// `send_outreach` bails with reason 'no_recipient'. This backfills the address the
// company already publishes. EXTRACTION ONLY — never inferred, never LLM-generated;
// see src/lib/discovery-enrich.ts for why that rule is absolute.
//
// Runs after promoting so the Leads tab still fills live during the run. Leads that
// yield nothing are stamped attempted so they're never re-scraped by a later tick.

async function enrichBatch(db: Db, job: JobRow, guardrails: Guardrails, counters: Counters): Promise<void> {
    // Only hot/warm leads are worth a fetch — cold leads never receive outreach.
    // ai_assistant_id is joined in (rather than fetched separately) purely so the ledger event can
    // be attributed to the assistant — this stage has the job, not the campaign row.
    const batch = await db.execute<{ id: number; domain: string | null; assistant_record_id: number | null; ai_assistant_id: number }>(
        `SELECT dl.id, dl.domain, dl.assistant_record_id, dc.ai_assistant_id
           FROM discovered_leads dl
           JOIN discovery_campaigns dc ON dc.id = dl.campaign_id
         WHERE dl.campaign_id = ${job.campaign_id}
           AND dl.status = 'promoted'
           AND dl.domain IS NOT NULL
           AND dl.contact_email IS NULL
           AND dl.rating IN ('hot','warm')
           AND dl.signals ->> 'enrichAttemptedAt' IS NULL
         LIMIT ${ENRICH_BATCH}`
    );

    // Attribution (§7.2), resolved BEFORE the parallel map: every row here shares one campaign and
    // therefore one assistant, so this is a single lookup. Doing it inside the map would issue one
    // query per lead — a memo cache does not help, since concurrent callers all miss together.
    const blueprintVersion = await getBlueprintVersion(db, batch[0]?.ai_assistant_id);
    // Same one-lookup reasoning: the batch is filtered to `job.campaign_id`, so every row resolves
    // to the same campaign snapshot. Going via a lead rather than the campaign id keeps this on the
    // one resolver, so the "campaign first, onboarding second" rule lives in a single place.
    const icpSnapshot = await getIcpSnapshot(db, {
        discoveredLeadId: batch[0]?.id ?? null,
        aiAssistantId: batch[0]?.ai_assistant_id ?? null,
    });

    // Concurrent: 5 leads x up to 4 sequential fetches would blow the tick budget serially.
    const scraped = await Promise.all(batch.map(async (lead) => {
        let found: Awaited<ReturnType<typeof enrichLeadContact>> = { contact: null, handles: {} };
        try {
            found = await enrichLeadContact(lead.domain);
        } catch {
            // Best-effort: a scrape failure must never fail the run.
        }
        return { lead, found, paidAttempted: false };
    }));

    // ── Tier 2: BUY an address for the leads the free scrape could not reach ────────────────
    //
    // Waterfall, deliberately in this order: the scrape is free and hits roughly one in three
    // SMB sites, so paying for those would be spending money on data we already have. Only the
    // misses reach a provider.
    //
    // ⚠️ Runs as a SECOND phase rather than inside the map above. Chaining a paid lookup onto
    // each scrape makes the per-lead worst case 6s (LEAD_BUDGET_MS) + the provider timeout, and
    // the leads run concurrently, so the slice would inherit the sum on a bad batch — the same
    // compounding that already cost this worker a round of 504s. Splitting the phases means the
    // slice is bounded by the SLOWER of the two, not their total, and the paid phase gets its
    // own deadline it can abandon without failing anything.
    //
    // Costs nothing and does nothing unless DISCOVERY_ENRICH_PROVIDER names a configured
    // provider — the default. See src/lib/discovery-enrich-provider.ts.
    const misses = scraped.filter((s) => !s.found.contact && s.lead.domain);
    if (misses.length > 0 && isEnrichProviderConfigured()) {
        // What this RUN has already spent. Counted from the `paidLookupAt` stamp rather than a
        // job column, mirroring `enrichAttemptedAt`, and stamped on a MISS too so the cap counts
        // money SPENT rather than addresses found.
        const [{ spent } = { spent: 0 }] = await db.execute<{ spent: number }>(
            `SELECT count(*)::int AS spent FROM discovered_leads
             WHERE job_id = ${job.id} AND signals ->> 'paidLookupAt' IS NOT NULL`
        );
        // Allocation is decided BEFORE the concurrent map: decrementing a shared counter inside
        // parallel callbacks would let a batch overrun the cap by however many run at once.
        const allowed = Math.max(0, Math.min(misses.length, guardrails.maxEnrichmentCallsPerRun - spent));
        if (allowed < misses.length) {
            console.log(`[discovery] job ${job.job_id} paid-enrichment cap reached (${spent}/${guardrails.maxEnrichmentCallsPerRun}) — ${misses.length - allowed} lead(s) left to the scraper`);
        }
        const deadline = Date.now() + PAID_ENRICH_BUDGET_MS;
        await Promise.all(misses.slice(0, allowed).map(async (s) => {
            const bought = await lookupProviderContact(s.lead.domain, { timeoutMs: deadline - Date.now() });
            // Stamp the ATTEMPT whether or not it found anything — that is what the cap counts,
            // and it stops a later slice paying again for the same domain.
            s.paidAttempted = true;
            counters.costGbp += ENRICH_COST_GBP_PER_LOOKUP;
            if (bought) {
                s.found = {
                    ...s.found,
                    contact: { email: bought.email, kind: bought.kind, source: 'provider', foundOn: bought.provider },
                };
            }
        }));
    }

    await Promise.all(scraped.map((s) => recordEnrichment(
        db, s.lead.id, s.lead.assistant_record_id, s.found,
        { organisationId: job.organisation_id, aiAssistantId: s.lead.ai_assistant_id, blueprintVersion, icpSnapshot },
        s.paidAttempted === true,
    )));

    const [{ remaining } = { remaining: 0 }] = await db.execute<{ remaining: number }>(
        `SELECT count(*)::int AS remaining FROM discovered_leads
         WHERE campaign_id = ${job.campaign_id} AND status = 'promoted' AND domain IS NOT NULL
           AND contact_email IS NULL AND rating IN ('hot','warm')
           AND signals ->> 'enrichAttemptedAt' IS NULL`
    );
    const done = remaining === 0;
    await db.update(discoveryJobs)
        .set({
            status: done ? 'completed' : 'queued', stage: 'enriching', errorMessage: null,
            ...counterCols(counters), updatedAt: new Date(),
        })
        .where(eq(discoveryJobs.id, job.id));

    if (done) await publishSignals(db, job);
}

/**
 * Publish a finished run's results to the Signal Inbox: stamp the job and raise ONE notification.
 *
 * Idempotency is the whole point of `signals_published_at`. A discovery run is cursor-resumable
 * across ticks and is retried on failure, so "the run finished" can be observed more than once for
 * a single logical run. The conditional UPDATE below claims the right to notify — only the update
 * that actually flips NULL → now() returns a row, so exactly one caller notifies even if two ticks
 * race. Notifying per lead instead of per run would mean 50 notifications for one action, which is
 * how a notification centre becomes something users mute.
 *
 * Best-effort by contract: a failure here must not fail the run, which has already completed
 * successfully and whose leads are already in the inbox.
 */
async function publishSignals(db: Db, job: JobRow): Promise<void> {
    try {
        const claimed = await db.update(discoveryJobs)
            .set({ signalsPublishedAt: new Date() })
            .where(and(eq(discoveryJobs.id, job.id), isNull(discoveryJobs.signalsPublishedAt)))
            .returning({ id: discoveryJobs.id, leadsFound: discoveryJobs.leadsFound });
        if (claimed.length === 0) return; // already published by an earlier tick

        const found = claimed[0].leadsFound ?? 0;
        if (found === 0) return; // nothing to tell them about

        const [campaign] = await db
            .select({
                name: discoveryCampaigns.name,
                idea: discoveryCampaigns.idea,
                aiAssistantId: discoveryCampaigns.aiAssistantId,
                createdBy: discoveryCampaigns.createdBy,
            })
            .from(discoveryCampaigns)
            .where(eq(discoveryCampaigns.id, job.campaign_id))
            .limit(1);
        if (!campaign?.createdBy) return; // no one to notify

        const [assistant] = await db.select({ name: aiAssistants.name })
            .from(aiAssistants).where(eq(aiAssistants.id, campaign.aiAssistantId)).limit(1);

        await createNotification(db, 'search_signals_published', {
            userId: campaign.createdBy,
            context: {
                assistant: { name: assistant?.name ?? 'Your assistant' },
                search: {
                    name: savedSearchLabel(campaign.name, campaign.idea),
                    // Pluralisation lives at the call site by convention — the merge engine has no
                    // plural rules (see notification-templates-catalog.ts).
                    companies: found === 1 ? '1 company' : `${found} companies`,
                },
            },
            metadata: { assistantId: campaign.aiAssistantId, campaignId: job.campaign_id, jobId: job.id },
        });
    } catch (err) {
        console.error('[process-discovery-jobs] publishSignals failed (non-fatal):', err);
    }
}

// `recordEnrichment` used to live here — it is now src/utils/lead-enrichment.ts, imported above.
// It moved when "Send back for enrichment" gained the ability to enrich a single lead outside any
// job: copying the persistence would have made a second writer of `enrichAttemptedAt`,
// `contactEmail`, `emailKind`, `emailSource` and `socialHandles` across two tables that must
// agree. One writer, per the notify.ts rule. The behaviour is unchanged — the function moved
// whole, gaining only a nullable `leadId` for leads that have no discovery row at all.

/** Upsert one qualified lead into assistant_records on (org, assistant, 'lead', title). */
/** Returns the assistant_records id the lead was mirrored onto — the ledger links its events to it. */
async function promoteOne(
    db: Db, organisationId: number, assistantId: number,
    lead: { id: number; companyName: string; rating: string | null; scoringCard: unknown },
    approvalStatus: string,
): Promise<number> {
    const [existing] = await db
        .select({ id: assistantRecords.id })
        .from(assistantRecords)
        .where(and(
            eq(assistantRecords.organisationId, organisationId),
            eq(assistantRecords.aiAssistantId, assistantId),
            eq(assistantRecords.recordType, 'lead'),
            eq(assistantRecords.title, lead.companyName),
        ))
        .limit(1);

    let recordId: number;
    if (existing) {
        await db.update(assistantRecords)
            .set({ status: lead.rating, data: lead.scoringCard as object, source: 'integration', updatedAt: new Date() })
            .where(eq(assistantRecords.id, existing.id));
        recordId = existing.id;
    } else {
        const [created] = await db.insert(assistantRecords)
            .values({
                organisationId, aiAssistantId: assistantId,
                recordType: 'lead', title: lead.companyName, status: lead.rating,
                source: 'integration', approvalStatus, data: lead.scoringCard as object,
            })
            .returning({ id: assistantRecords.id });
        recordId = created.id;

        // Integration Scenario Library — auto-approved leads (require_human_approval=false)
        // skip the Review Queue PATCH seam, so fire the outbound handoff (QUALIFIED) here.
        // Human-approved leads insert as 'pending_approval' and fire on approval instead.
        if (approvalStatus === 'approved') {
            const card = (lead.scoringCard && typeof lead.scoringCard === 'object') ? lead.scoringCard as Record<string, unknown> : {};
            await enqueueScenarioTrigger(db, {
                organisationId, assistantId, triggerEvent: 'lead.status_changed',
                subject: {
                    recordType: 'lead', recordId, newStatus: 'QUALIFIED',
                    fields: {
                        company: lead.companyName,
                        rating: lead.rating ?? undefined,
                        score: card.score,
                        aiSummary: card.summary ?? card.reason ?? card.rationale,
                        attribution: 'Be More Swan discovery',
                        contactName: card.contactName ?? card.contact_name,
                        contactEmail: card.contactEmail ?? card.email,
                        domain: card.domain,
                    },
                },
            });
        }
    }
    await db.update(discoveredLeads)
        .set({ status: 'promoted', assistantRecordId: recordId, updatedAt: new Date() })
        .where(eq(discoveredLeads.id, lead.id));
    return recordId;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** The queries from a stored approved brief, flattened. Empty when none was ever approved. */
function approvedQueriesOf(brief: unknown): string[] {
    if (!brief || typeof brief !== 'object') return [];
    const q = (brief as Record<string, unknown>).queries;
    if (!q || typeof q !== 'object') return [];
    const groups = q as Record<string, unknown>;
    return (['niche_scrape', 'intent_signal', 'footprint'] as const).flatMap((k) => {
        const list = groups[k];
        return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
    });
}

interface ResolvedHit {
    title: string;
    url: string;
    snippet: string;
    domain: string;
    /** The hit's original domain when it was rewritten to a root, else null. */
    rewrittenFrom: string | null;
}

/**
 * Give rewritten candidates an honest name before they reach the scorer.
 *
 * A rewritten hit's title and snippet describe the ARTICLE that surfaced it — "How To Host A
 * Corporate Retreat" — while `companyName` downstream is taken straight from the title. Left
 * alone, the Leads tab fills with article headlines and the scorer judges companies by prose
 * about the market. That is exactly why this rewrite was deferred when it was first considered.
 *
 * Only rewritten hits are fetched; an ordinary hit already carries the company's own page title.
 *
 * ⚠️ On failure the lead is KEPT and named by its domain, with the article snippet cleared. The
 * filter's stated bias is false negatives over false positives, and the scorer is the second gate:
 * a cold-rated lead is recoverable, whereas one carrying a misleading name and snippet corrupts
 * both the Leads tab and the scoring decision. Never fall back to the article's own words.
 */
async function resolveIdentities(hits: ResolvedHit[], jobId: string): Promise<ResolvedHit[]> {
    const needing = hits.filter((h) => h.rewrittenFrom);
    if (needing.length === 0) return hits;

    const deadline = Date.now() + IDENTITY_BUDGET_MS;
    await Promise.all(needing.map(async (hit) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            hit.title = hit.domain;
            hit.snippet = '';
            return;
        }
        const identity = await fetchSiteIdentity(hit.domain, { timeoutMs: remaining });
        if (identity?.title) {
            hit.title = identity.title;
            hit.snippet = identity.description || '';
        } else {
            console.log(`[discovery] job ${jobId} could not read ${hit.domain}; naming it by domain`);
            hit.title = hit.domain;
            hit.snippet = '';
        }
    }));
    return hits;
}

async function loadGuardrails(db: Db, campaignId: number): Promise<Guardrails> {
    const [g] = await db.select().from(discoveryGuardrails).where(eq(discoveryGuardrails.campaignId, campaignId)).limit(1);
    if (!g) return DEFAULT_GUARDRAILS;
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return {
        maxLeadsPerRun: g.maxLeadsPerRun,
        maxLeadsPerMonth: g.maxLeadsPerMonth,
        maxSearchCallsPerRun: g.maxSearchCallsPerRun,
        // ⚠️ Coalesced, not read raw. A campaign row created before
        // db/discovery-enrichment-cap.sql was applied has no value here, and letting that become
        // 0 would look like a cap of zero — paid enrichment silently off — rather than "use the
        // default". The environments this runs in are not guaranteed to be migrated in step with
        // the deploy, so the code has to survive the gap in the safe direction.
        maxEnrichmentCallsPerRun: g.maxEnrichmentCallsPerRun ?? DEFAULT_GUARDRAILS.maxEnrichmentCallsPerRun,
        maxTokensPerRun: g.maxTokensPerRun,
        maxCostGbpPerRun: Number(g.maxCostGbpPerRun),
        negativeKeywords: arr(g.negativeKeywords),
        excludedDomains: arr(g.excludedDomains).map((d) => normaliseDomain(d) ?? d.toLowerCase()),
        requireHumanApproval: g.requireHumanApproval,
    };
}

function isExcluded(domain: string, haystack: string, g: Guardrails): boolean {
    if (g.excludedDomains.includes(domain)) return true;
    const text = haystack.toLowerCase();
    return g.negativeKeywords.some((kw) => kw && text.includes(kw.toLowerCase()));
}

async function finishJob(db: Db, jobId: number, status: 'completed' | 'failed', message: string | null): Promise<void> {
    await db.update(discoveryJobs).set({ status, errorMessage: message, updatedAt: new Date() }).where(eq(discoveryJobs.id, jobId));
}

async function handleFailure(db: Db, job: JobRow, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[process-discovery-jobs] job ${job.job_id} slice failed:`, message);
    const newAttempt = job.attempt + 1;
    if (newAttempt >= job.max_attempts) {
        await db.update(discoveryJobs).set({ status: 'failed', attempt: newAttempt, errorMessage: message, updatedAt: new Date() }).where(eq(discoveryJobs.id, job.id));
    } else {
        const backoff = BACKOFF_SECS[Math.min(job.attempt, BACKOFF_SECS.length - 1)];
        await db.update(discoveryJobs)
            .set({ status: 'queued', attempt: newAttempt, errorMessage: message, nextRetryAt: new Date(Date.now() + backoff * 1000), updatedAt: new Date() })
            .where(eq(discoveryJobs.id, job.id));
    }
}
