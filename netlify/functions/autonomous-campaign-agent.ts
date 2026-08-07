// netlify/functions/autonomous-campaign-agent.ts
// The Campaign Assistant's autonomous run — scenarios 1 and 2 of
// docs/campaign-orchestrator-plan.md §4. Until this existed, a campaign decision could only ever
// arrive because a human opened the chat and asked, which made "it reallocates when something is
// not landing" a claim with no mechanism behind it.
//
//   expire pending decisions whose evidence has aged out (and settle their Review Queue rows)
//   for each LIVE campaign (active | throttled), newest first, capped at BATCH
//     → scenario 1: a post ≥ OUTPERFORM_MULTIPLE × the account average  → 'escalation'
//     → scenario 2: > LEAD_QUALITY_FLOOR of a day's leads rated cold    → 'halt'
//   record the run in platform_config
//
// ── This is NOT a clone of autonomous-strategy-agent's shape, on purpose ─────
// That one is a DISPATCHER: one org costs ~50 seconds because a model rewrites a playbook, which no
// scheduled function can hold, so it hands off to a background worker. Every number here comes out
// of a COUNT or an AVG and there is no model call at all, so the work runs inline in milliseconds
// per campaign. Adding a background hop would buy nothing and add a way for jobs to strand
// (background-trigger-must-be-awaited). Do not "make it consistent" with the strategy agent.
//
// ── What it may write ────────────────────────────────────────────────────────
// `campaign_decisions` rows with status='pending', their `assistant_records` mirror, and the
// run marker. Nothing else. It NEVER calls placeOrder: a pending decision is inert, and orders are
// placed only by campaigns.ts `decide`, only after a human approves. tests/campaign-proposer.test.ts
// asserts that against this source.
//
// ⚠️ NO NOTIFICATION IS SENT, and that is a deliberate gap rather than an oversight. There is no
// `campaign_decision_pending` template row, and createNotification() with an unknown key logs and
// returns false — a silent no-op that would look wired. The Review Queue tab badge already surfaces
// these (the mirror sets approval_status='pending_approval'). Add the template before adding the
// call; see notification-template-management.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { isGlobalAiDisabled, setPlatformConfig } from '../../src/utils/platform-config';
import {
    SCENARIO_REQUIREMENTS, buildEscalationProposal, buildHaltProposal, detectLeadQualityDrop,
    detectOutperformingPost, expirePendingDecisions, hasPendingDecision, hiredRoleKeys,
    liveCampaignsForRun, persistProposal, OUTPERFORM_WINDOW_DAYS,
} from '../../src/utils/campaign-proposer';

/**
 * Campaigns considered per run. Generous — each is a handful of indexed aggregates, and a
 * workspace runs a few campaigns rather than hundreds.
 */
const BATCH = 200;

/** Where the run records itself, so "did it fire?" is answerable without reading logs. */
const LAST_RUN_KEY = 'campaign_agent.last_run';

export interface CampaignAgentResult {
    skipped?: string;
    campaigns: number;
    proposed: number;
    expired: number;
    escalations: number;
    halts: number;
}

export async function runCampaignProposer(): Promise<CampaignAgentResult> {
    const empty: CampaignAgentResult = { campaigns: 0, proposed: 0, expired: 0, escalations: 0, halts: 0 };

    // The platform kill switch. This function makes no model call, so the letter of the flag does
    // not cover it — but a decision card appearing in someone's queue during an incident is still
    // the autonomous surface acting, and it is work a human must then respond to. Quiet is quiet.
    if (await isGlobalAiDisabled()) return { ...empty, skipped: 'global_ai_disabled' };

    const db = getDb();

    // Expiry runs FIRST and unconditionally. It is the half that keeps the queue honest, and it
    // must not be skippable by the proposal half finding nothing to say.
    const expired = await expirePendingDecisions(db);

    const live = await liveCampaignsForRun(db, BATCH);
    const since7d = new Date(Date.now() - OUTPERFORM_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // One lookup per ORG, not per campaign — several campaigns commonly share an organisation and
    // the hired-roles answer is identical for all of them.
    const rolesByOrg = new Map<number, Set<string>>();
    let escalations = 0;
    let halts = 0;

    for (const campaign of live) {
        try {
            let hired = rolesByOrg.get(campaign.organisationId);
            if (!hired) {
                hired = await hiredRoleKeys(db, campaign.organisationId);
                rolesByOrg.set(campaign.organisationId, hired);
            }

            // ── Scenario 1 — a post is well ahead, so build on it ──────────────
            // The pending check runs BEFORE the detection query, not just inside persistProposal:
            // a 7-day window re-detects the same breakout post on every run, and there is no point
            // paying for the aggregate to then throw the answer away.
            if (SCENARIO_REQUIREMENTS.escalation.every((r) => hired!.has(r))
                && !await hasPendingDecision(db, campaign.id, 'escalation')) {
                const hit = await detectOutperformingPost(db, campaign.organisationId, since7d);
                if (hit && await persistProposal(db, campaign, buildEscalationProposal(hit))) escalations++;
            }

            // ── Scenario 2 — the search is finding the wrong companies ─────────
            if (SCENARIO_REQUIREMENTS.halt.every((r) => hired!.has(r))
                && !await hasPendingDecision(db, campaign.id, 'halt')) {
                const hit = await detectLeadQualityDrop(db, campaign.organisationId, since24h);
                if (hit && await persistProposal(db, campaign, buildHaltProposal(hit))) halts++;
            }
        } catch (err) {
            // One campaign's failure must not cost the rest of the run. Logged with the id so a
            // recurring offender is findable, then skipped.
            console.error('[campaign-agent] campaign failed', { campaignId: campaign.id, err });
        }
    }

    const result: CampaignAgentResult = {
        campaigns: live.length,
        proposed: escalations + halts,
        expired,
        escalations,
        halts,
    };

    // Non-blocking: a run that did its work and failed to record itself is still a successful run.
    try {
        await setPlatformConfig(LAST_RUN_KEY, { at: new Date().toISOString(), ...result }, undefined, 'autonomous-campaign-agent');
    } catch (err) {
        console.warn('[campaign-agent] could not record last_run', err);
    }

    return result;
}

// Netlify fires scheduled functions ONLY on the production deploy, so this never runs on staging —
// .github/workflows/staging-crons.yml pokes run-campaign-agent instead, which calls the
// same function. The two must stay in step.
export default withLambda(async () => {
    try {
        const result = await runCampaignProposer();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[campaign-agent]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
