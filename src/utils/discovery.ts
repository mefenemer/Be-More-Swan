// src/utils/discovery.ts
// Shared helper to spin up an outbound discovery run: create the campaign (+ guardrails
// + schedule) and enqueue a discovery_job. Used by discovery-campaigns.ts (the UI API)
// and by lead-generation.ts (the "approve idea" → real run swap) so both paths behave
// identically. Design: docs/lead-generator-discovery-plan.md.

import { getDb } from '../../db/client';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { discoveryCampaigns, discoveryGuardrails, discoverySchedules, discoveryJobs, aiAssistants } from '../../db/schema';
import { icpFromOnboarding } from './icp-snapshot';
import { MAX_ACTIVE_CAMPAIGNS_PER_ORG } from '../config/discovery-limits';
import { DEFAULT_MAX_SEARCH_CALLS_PER_RUN, DEFAULT_MAX_TOKENS_PER_RUN } from '../config/discovery-limits';

type Db = ReturnType<typeof getDb>;

export interface CreateRunInput {
    db: Db;
    organisationId: number;
    userId: number;
    aiAssistantId: number;
    /** Short label for the saved search ("UK retreat venues"). Optional — readers fall back to `idea`. */
    name?: string | null;
    idea: string;
    targetPersona?: Record<string, unknown> | null;
    /** Partial guardrail overrides; unset fields keep the table defaults. */
    guardrails?: Partial<{
        maxLeadsPerRun: number; maxLeadsPerMonth: number; maxSearchCallsPerRun: number;
        maxTokensPerRun: number; maxCostGbpPerRun: number;
        negativeKeywords: string[]; excludedDomains: string[]; requireHumanApproval: boolean;
    }>;
    /** 'one_off' (default — run once now) | 'daily' | 'weekly'. */
    cadence?: 'one_off' | 'daily' | 'weekly';
    runAtHourUtc?: number;
    /**
     * 'active' (default) starts the campaign: a one_off is enqueued immediately and a recurring
     * cadence begins dispatching. 'draft' creates it WITHOUT spending anything — no job is
     * enqueued and the schedule stays disabled until a human starts it.
     *
     * The draft path exists for campaigns the assistant PROPOSES in chat rather than ones the
     * user filled in a form for. A search costs real money per run (maxCostGbpPerRun) and emails
     * real strangers downstream, so a proposal the user has merely approved in conversation must
     * not begin spending on the strength of a model's judgement. `draft` is the table's own
     * default status and the documented head of the lifecycle (draft → active → paused →
     * archived); dispatch-discovery-runs.ts only ever fires `active`.
     */
    status?: 'draft' | 'active';
}

/** `jobId` is null when nothing was enqueued — i.e. a draft, or any recurring cadence. */
export interface CreateRunResult { campaignId: number; jobId: string | null; }

/**
 * Is there room for one more RUNNING search in this organisation?
 *
 * ── Why a per-org cap exists at all ──────────────────────────────────────────
 * Every guardrail in this system is per campaign — 50 leads a run, £2 of search a run — so the
 * actual ceiling on our spend was £2 × active searches × runs per day, and nothing capped the
 * middle term. Twenty daily searches is a £40/day search bill on a plan that meters chat turns and
 * not one search call. See src/config/discovery-limits.ts.
 *
 * Counts `status = 'active'` only. Drafts and paused searches spend nothing, and a tenant drafting
 * fifteen ideas before starting three is the behaviour the draft state was built for.
 *
 * ⚠️ Fails OPEN on a read error. A transient database blip must not read as "you have too many
 * searches" — the honest failure mode of a spend guard whose input is unavailable is to let the work
 * through and stay noisy in the logs, not to tell a paying user they are over a limit we could not
 * measure. Every per-run cost cap downstream is still in force.
 */
export async function activeCampaignCapacity(
    db: Db,
    organisationId: number,
): Promise<{ ok: boolean; active: number; limit: number }> {
    const limit = MAX_ACTIVE_CAMPAIGNS_PER_ORG;
    try {
        const [row] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(discoveryCampaigns)
            .where(and(
                eq(discoveryCampaigns.organisationId, organisationId),
                eq(discoveryCampaigns.status, 'active'),
            ));
        const active = Number(row?.n ?? 0);
        return { ok: active < limit, active, limit };
    } catch (err) {
        console.error('[discovery] active-campaign count failed; allowing the start', err);
        return { ok: true, active: 0, limit };
    }
}

/**
 * The sentence shown when the cap is hit. One place, because three call sites raise it (create,
 * approve_brief, run_now) plus the chat-side idea approval, and four differently-worded refusals for
 * one rule is how a limit reads as a bug.
 */
export function campaignCapacityMessage(limit: number): string {
    return `You already have ${limit} searches running, which is the most this workspace can run at once. `
        + 'Pause one on the Searches tab to start another — paused and draft searches do not count.';
}

/**
 * Create a campaign + guardrails + schedule and (unless it is a draft) enqueue a run.
 * one_off cadence enqueues an on_demand job immediately AND records a disabled schedule
 * (so the run history has a schedule row); daily/weekly leave dispatch to the cron.
 */
export async function createDiscoveryRun(input: CreateRunInput): Promise<CreateRunResult> {
    const { db, organisationId, userId, aiAssistantId } = input;
    const cadence = input.cadence ?? 'one_off';

    // Snapshot the ICP at creation so the run is reproducible if onboarding changes later.
    const [assistant] = await db
        .select({ onboardingContext: aiAssistants.onboardingContext })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, aiAssistantId))
        .limit(1);
    const icpSnapshot = icpFromOnboarding(assistant?.onboardingContext);

    const status = input.status ?? 'active';
    const isDraft = status === 'draft';

    const [campaign] = await db.insert(discoveryCampaigns).values({
        organisationId, aiAssistantId, createdBy: userId,
        name: input.name ?? null,
        idea: input.idea, targetPersona: input.targetPersona ?? null,
        status, icpSnapshot,
    }).returning({ id: discoveryCampaigns.id });

    // Guardrails — only set the columns the caller overrode; the rest take table defaults.
    const g = input.guardrails ?? {};
    await db.insert(discoveryGuardrails).values({
        organisationId, campaignId: campaign.id,
        ...(g.maxLeadsPerRun !== undefined ? { maxLeadsPerRun: g.maxLeadsPerRun } : {}),
        ...(g.maxLeadsPerMonth !== undefined ? { maxLeadsPerMonth: g.maxLeadsPerMonth } : {}),
        // ⚠️ Written explicitly rather than left to the column default. The table defaults
        // (100 searches / 200k tokens) predate the measurement that showed the token budget binds
        // at ~63 searches — see src/config/discovery-limits.ts. Falling through to them would give
        // every new campaign the ceiling we just established is too low to finish a split sweep.
        maxSearchCallsPerRun: g.maxSearchCallsPerRun ?? DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
        maxTokensPerRun: g.maxTokensPerRun ?? DEFAULT_MAX_TOKENS_PER_RUN,
        ...(g.maxCostGbpPerRun !== undefined ? { maxCostGbpPerRun: String(g.maxCostGbpPerRun) } : {}),
        ...(g.negativeKeywords !== undefined ? { negativeKeywords: g.negativeKeywords } : {}),
        ...(g.excludedDomains !== undefined ? { excludedDomains: g.excludedDomains } : {}),
        ...(g.requireHumanApproval !== undefined ? { requireHumanApproval: g.requireHumanApproval } : {}),
    });

    // Schedule row. For recurring cadences the dispatcher fires the first run; for one_off we
    // enqueue immediately below and leave the schedule disabled.
    const runAtHourUtc = input.runAtHourUtc ?? 8;
    await db.insert(discoverySchedules).values({
        organisationId, campaignId: campaign.id, cadence, runAtHourUtc,
        // A draft dispatches nothing whatever its cadence. Belt and braces: the dispatcher already
        // filters on status='active', so this is the second of two independent guards. When the
        // draft is started, run_now flips BOTH (discovery-campaigns.ts) — leaving a recurring draft
        // reachable only via Pause→Resume would be a campaign that silently never runs.
        isEnabled: !isDraft && cadence !== 'one_off',
        nextRunAt: cadence === 'one_off' ? null : new Date(),
    });

    // A draft costs nothing and starts nothing: no job row, so no worker picks it up.
    if (isDraft) return { campaignId: campaign.id, jobId: null };

    const jobId = randomUUID();
    if (cadence === 'one_off') {
        await db.insert(discoveryJobs).values({
            jobId, organisationId, campaignId: campaign.id, triggerType: 'on_demand',
        });
    }

    return { campaignId: campaign.id, jobId };
}
