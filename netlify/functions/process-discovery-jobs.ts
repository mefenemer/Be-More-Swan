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
import { search, isSearchConfigured, normaliseDomain, SearchNotConfiguredError } from '../../src/lib/discovery-search';
import { logAiUsage } from '../../src/utils/ai-usage';

type Db = ReturnType<typeof getDb>;

const BACKOFF_SECS = [10, 30, 90];
// Queries processed per tick — keep small so one slice stays well under the function timeout.
const QUERIES_PER_SLICE = 3;
const RESULTS_PER_QUERY = 10;

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
    maxTokensPerRun: number; maxCostGbpPerRun: number;
    negativeKeywords: string[]; excludedDomains: string[]; requireHumanApproval: boolean;
}

const DEFAULT_GUARDRAILS: Guardrails = {
    maxLeadsPerRun: 50, maxLeadsPerMonth: 500, maxSearchCallsPerRun: 100,
    maxTokensPerRun: 200000, maxCostGbpPerRun: 2.0,
    negativeKeywords: [], excludedDomains: [], requireHumanApproval: true,
};

// ── Queue drain (public — driven by native cron AND run-discovery-jobs.ts) ─────

export async function drainDiscoveryJobs(): Promise<number> {
    const db = getDb();
    const now = new Date();

    // Reset jobs stuck in 'processing' for >3 minutes (function timed out mid-slice).
    await db.execute(
        `UPDATE discovery_jobs SET status = 'queued', next_retry_at = now()
         WHERE status = 'processing' AND updated_at < now() - interval '3 minutes' AND attempt < max_attempts`
    );

    const jobs = await db.execute<JobRow>(
        `SELECT id, job_id, organisation_id, campaign_id, attempt, max_attempts
         FROM discovery_jobs
         WHERE status = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY created_at
         LIMIT 5
         FOR UPDATE SKIP LOCKED`
    );
    if (!jobs.length) return 0;

    await Promise.allSettled(jobs.map((job) => processJob(db, job)));
    return jobs.length;
}

export const handler: Handler = async () => {
    const processed = await drainDiscoveryJobs();
    return { statusCode: 200, body: processed ? `processed ${processed} discovery jobs` : 'no jobs' };
};

// ── One bounded slice of one job ───────────────────────────────────────────────

async function processJob(db: Db, job: JobRow): Promise<void> {
    await db.execute(
        `UPDATE discovery_jobs SET status = 'processing', attempt = attempt + 1, updated_at = now() WHERE id = ${job.id}`
    );

    try {
        // Load campaign + owning assistant (name + roleKey for scoring prompt).
        const [campaign] = await db
            .select({
                id: discoveryCampaigns.id,
                aiAssistantId: discoveryCampaigns.aiAssistantId,
                idea: discoveryCampaigns.idea,
                targetPersona: discoveryCampaigns.targetPersona,
                icpSnapshot: discoveryCampaigns.icpSnapshot,
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
        const guardrails = await loadGuardrails(db, job.campaign_id);

        // Current run counters (persisted on the job row).
        const [state] = await db
            .select({
                cursor: discoveryJobs.cursor,
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

        // ── Monthly volume cap (across all this campaign's runs this month) ──────
        const [{ monthTotal } = { monthTotal: 0 }] = await db.execute<{ monthTotal: number }>(
            `SELECT COALESCE(SUM(leads_found), 0)::int AS "monthTotal"
             FROM discovery_jobs
             WHERE campaign_id = ${job.campaign_id} AND created_at >= date_trunc('month', now())`
        );
        if (monthTotal >= guardrails.maxLeadsPerMonth) {
            await promoteAndComplete(db, job, campaign.aiAssistantId, guardrails, leadsFound, searchCallsMade, tokensUsed, costGbp, 'Monthly lead cap reached.');
            return;
        }

        // ── STAGE searching: process the next slice of queries ──────────────────
        const slice = cursor.flat.slice(cursor.queryIndex, cursor.queryIndex + QUERIES_PER_SLICE);
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

            // Brand-safety filter + domain dedupe within this slice.
            const seen = new Set<string>();
            const candidates = results
                .map((r) => ({ ...r, domain: normaliseDomain(r.domain || r.url) }))
                .filter((r) => r.domain && !seen.has(r.domain) && (seen.add(r.domain), true))
                .filter((r) => !isExcluded(r.domain!, `${r.title} ${r.snippet}`, guardrails));

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
                    signals: { snippet: c.snippet },
                    status: 'discovered' as const,
                })))
                .onConflictDoNothing({ target: [discoveredLeads.campaignId, discoveredLeads.domain] })
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
            }
            leadsFound += inserted.length;
        }

        const nextIndex = cursor.queryIndex + slice.length;
        const done = stopped || nextIndex >= cursor.flat.length;

        if (done) {
            await promoteAndComplete(db, job, campaign.aiAssistantId, guardrails, leadsFound, searchCallsMade, tokensUsed, costGbp, null);
        } else {
            // Persist progress and resume next tick.
            await db.update(discoveryJobs)
                .set({
                    cursor: { flat: cursor.flat, queryIndex: nextIndex } satisfies Cursor,
                    status: 'queued', stage: 'searching',
                    leadsFound, searchCallsMade, tokensUsed, costGbp: String(costGbp), updatedAt: new Date(),
                })
                .where(eq(discoveryJobs.id, job.id));
        }
    } catch (err) {
        await handleFailure(db, job, err);
    }
}

// ── Promotion: mirror qualified discovered_leads into assistant_records ─────────

async function promoteAndComplete(
    db: Db, job: JobRow, assistantId: number, guardrails: Guardrails,
    leadsFound: number, searchCallsMade: number, tokensUsed: number, costGbp: number,
    note: string | null,
): Promise<void> {
    const qualified = await db
        .select({ id: discoveredLeads.id, companyName: discoveredLeads.companyName, rating: discoveredLeads.rating, scoringCard: discoveredLeads.scoringCard })
        .from(discoveredLeads)
        .where(and(
            eq(discoveredLeads.campaignId, job.campaign_id),
            eq(discoveredLeads.status, 'qualified'),
            isNull(discoveredLeads.assistantRecordId),
        ));

    const approvalStatus = guardrails.requireHumanApproval ? 'pending_approval' : 'approved';

    for (const lead of qualified) {
        // Upsert on (org, assistant, recordType 'lead', title) — same rule the chat route uses.
        const [existing] = await db
            .select({ id: assistantRecords.id })
            .from(assistantRecords)
            .where(and(
                eq(assistantRecords.organisationId, job.organisation_id),
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
                    organisationId: job.organisation_id, aiAssistantId: assistantId,
                    recordType: 'lead', title: lead.companyName, status: lead.rating,
                    source: 'integration', approvalStatus, data: lead.scoringCard as object,
                })
                .returning({ id: assistantRecords.id });
            recordId = created.id;
        }
        await db.update(discoveredLeads)
            .set({ status: 'promoted', assistantRecordId: recordId, updatedAt: new Date() })
            .where(eq(discoveredLeads.id, lead.id));
    }

    await db.update(discoveryJobs)
        .set({
            status: 'completed', stage: 'promoting', errorMessage: note,
            leadsFound, searchCallsMade, tokensUsed, costGbp: String(costGbp), updatedAt: new Date(),
        })
        .where(eq(discoveryJobs.id, job.id));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function loadGuardrails(db: Db, campaignId: number): Promise<Guardrails> {
    const [g] = await db.select().from(discoveryGuardrails).where(eq(discoveryGuardrails.campaignId, campaignId)).limit(1);
    if (!g) return DEFAULT_GUARDRAILS;
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return {
        maxLeadsPerRun: g.maxLeadsPerRun,
        maxLeadsPerMonth: g.maxLeadsPerMonth,
        maxSearchCallsPerRun: g.maxSearchCallsPerRun,
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
    // attempt was already incremented at slice start.
    if (job.attempt + 1 >= job.max_attempts) {
        await db.update(discoveryJobs).set({ status: 'failed', errorMessage: message, updatedAt: new Date() }).where(eq(discoveryJobs.id, job.id));
    } else {
        const backoff = BACKOFF_SECS[Math.min(job.attempt, BACKOFF_SECS.length - 1)];
        await db.update(discoveryJobs)
            .set({ status: 'queued', errorMessage: message, nextRetryAt: new Date(Date.now() + backoff * 1000), updatedAt: new Date() })
            .where(eq(discoveryJobs.id, job.id));
    }
}
