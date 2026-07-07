// netlify/functions/discovery-campaigns.ts
// Tenant-scoped API for the Lead Generator's outbound discovery campaigns. Backs the
// "Idea / Blueprint" UI on assistant-detail.html. Every action is ownership-checked
// (IDOR guard) against the caller's organisation. Design: docs/lead-generator-discovery-plan.md.
//
//   POST { action: 'create',    assistantId, idea, targetPersona?, guardrails?, cadence?, runAtHourUtc? }
//        → creates campaign (+guardrails+schedule); one_off enqueues a run now. → { campaignId, jobId }
//   POST { action: 'list',      assistantId }
//        → this assistant's campaigns, newest first, each with its latest run status.
//   POST { action: 'run_now',   campaignId }
//        → enqueues an on_demand run for an existing campaign (no duplicate if one is in flight).
//   POST { action: 'list_leads', campaignId }
//        → discovered_leads for the campaign (raw discovery output + provenance).

import { Handler } from '@netlify/functions';
import { randomUUID } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, discoveryCampaigns, discoveryJobs, discoveredLeads } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { createDiscoveryRun } from '../../src/utils/discovery';
import { isSearchConfigured } from '../../src/lib/discovery-search';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function str(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

export const handler: Handler = async (event) => {
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

        const result = await createDiscoveryRun({
            db, organisationId: orgId, userId, aiAssistantId: assistantId,
            idea,
            targetPersona: (body.targetPersona && typeof body.targetPersona === 'object') ? body.targetPersona as Record<string, unknown> : null,
            cadence,
            runAtHourUtc: typeof body.runAtHourUtc === 'number' ? body.runAtHourUtc : undefined,
            guardrails: {
                ...(typeof guardrails.maxLeadsPerRun === 'number' ? { maxLeadsPerRun: guardrails.maxLeadsPerRun } : {}),
                ...(typeof guardrails.maxLeadsPerMonth === 'number' ? { maxLeadsPerMonth: guardrails.maxLeadsPerMonth } : {}),
                ...(typeof guardrails.maxCostGbpPerRun === 'number' ? { maxCostGbpPerRun: guardrails.maxCostGbpPerRun } : {}),
                ...(Array.isArray(guardrails.negativeKeywords) ? { negativeKeywords: (guardrails.negativeKeywords as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
                ...(Array.isArray(guardrails.excludedDomains) ? { excludedDomains: (guardrails.excludedDomains as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
                ...(typeof guardrails.requireHumanApproval === 'boolean' ? { requireHumanApproval: guardrails.requireHumanApproval } : {}),
            },
        });

        return json(200, { ...result, cadence, searchConfigured: isSearchConfigured() });
    }

    // ── list campaigns for an assistant ─────────────────────────────────────────
    if (action === 'list') {
        const assistantId = Number(body.assistantId);
        const campaigns = await db
            .select({
                id: discoveryCampaigns.id, idea: discoveryCampaigns.idea, status: discoveryCampaigns.status,
                createdAt: discoveryCampaigns.createdAt,
                latestJobStatus: sql<string | null>`(
                    SELECT j.status FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                    ORDER BY j.created_at DESC LIMIT 1
                )`,
                leadsFound: sql<number>`(
                    SELECT COALESCE(SUM(j.leads_found), 0)::int FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
                )`,
            })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.organisationId, orgId), eq(discoveryCampaigns.aiAssistantId, assistantId)))
            .orderBy(desc(discoveryCampaigns.createdAt));
        return json(200, { campaigns, searchConfigured: isSearchConfigured() });
    }

    // ── enqueue an on-demand run for an existing campaign ───────────────────────
    if (action === 'run_now') {
        const campaignId = Number(body.campaignId);
        const [campaign] = await db.select({ id: discoveryCampaigns.id })
            .from(discoveryCampaigns)
            .where(and(eq(discoveryCampaigns.id, campaignId), eq(discoveryCampaigns.organisationId, orgId)))
            .limit(1);
        if (!campaign) return json(404, { error: 'Campaign not found.' });

        const [inflight] = await db.select({ id: discoveryJobs.id })
            .from(discoveryJobs)
            .where(and(eq(discoveryJobs.campaignId, campaignId), sql`${discoveryJobs.status} IN ('queued','processing')`))
            .limit(1);
        if (inflight) return json(200, { alreadyRunning: true });

        const jobId = randomUUID();
        await db.insert(discoveryJobs).values({ jobId, organisationId: orgId, campaignId, triggerType: 'on_demand' });
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

    return json(400, { error: `Unknown action "${action}".` });
};
