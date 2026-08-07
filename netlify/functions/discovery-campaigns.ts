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
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function str(v: unknown, max: number): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
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
        // reload, so an old proposal card comes back with working buttons. Scoped to the draft
        // path on purpose — re-submitting the FORM with the same idea is a deliberate act, and
        // silently handing back the old campaign would look like the button was broken.
        if (asDraft) {
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
                    ORDER BY j.created_at DESC LIMIT 1
                )`,
                leadsFound: sql<number>`(
                    SELECT COALESCE(SUM(j.leads_found), 0)::int FROM discovery_jobs j
                    WHERE j.campaign_id = ${discoveryCampaigns.id}
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
