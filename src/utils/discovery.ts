// src/utils/discovery.ts
// Shared helper to spin up an outbound discovery run: create the campaign (+ guardrails
// + schedule) and enqueue a discovery_job. Used by discovery-campaigns.ts (the UI API)
// and by lead-generation.ts (the "approve idea" → real run swap) so both paths behave
// identically. Design: docs/lead-generator-discovery-plan.md.

import { getDb } from '../../db/client';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { discoveryCampaigns, discoveryGuardrails, discoverySchedules, discoveryJobs, aiAssistants } from '../../db/schema';
import { icpFromOnboarding } from './icp-snapshot';

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
        ...(g.maxSearchCallsPerRun !== undefined ? { maxSearchCallsPerRun: g.maxSearchCallsPerRun } : {}),
        ...(g.maxTokensPerRun !== undefined ? { maxTokensPerRun: g.maxTokensPerRun } : {}),
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
