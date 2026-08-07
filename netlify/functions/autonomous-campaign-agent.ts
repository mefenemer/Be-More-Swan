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
// ── It notifies, as of 2026-08-07 ────────────────────────────────────────────
// Phase 1 shipped without this on purpose: there was no `campaign_decision_pending` template, and
// createNotification() with an unknown key logs and returns false — a silent no-op that LOOKS
// wired, so the call could not go in first. The template now exists in
// src/utils/notification-templates-catalog.ts (no DDL: notification_templates is only an admin
// override layer, and the catalog is the fallback), and the call site is at the foot of the run.
//
// The Review Queue badge was previously the only surface, which was not enough: a decision expires
// in as little as two days (DECISION_TTL_DAYS.halt), so one could be filed, expire and be swept
// without the user ever opening the tab.
//
// ONE notification per ORG per RUN, not one per decision. Three campaigns all filing on the same
// morning is one alert, or the feature becomes the noise it exists to cut through.

import { withLambda } from '@netlify/aws-lambda-compat';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
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
    /** Organisations told about a new decision. One notification per org per run, not per decision. */
    notified: number;
}

/** What one organisation gets told, accumulated across its campaigns during the run. */
interface OrgNotice {
    count: number;
    /** The FIRST proposal's title. A digest of five would be unreadable on a notification card. */
    summary: string;
    assistantId: number;
}

export async function runCampaignProposer(): Promise<CampaignAgentResult> {
    const empty: CampaignAgentResult = { campaigns: 0, proposed: 0, expired: 0, escalations: 0, halts: 0, notified: 0 };

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
    const noticesByOrg = new Map<number, OrgNotice>();
    let escalations = 0;
    let halts = 0;

    /** Record that this org has something new to be told about, without notifying yet. */
    const note = (orgId: number, assistantId: number, title: string) => {
        const prev = noticesByOrg.get(orgId);
        // Keep the FIRST summary rather than the last: a run that files an escalation and then a
        // halt should lead with the escalation the user has not seen, not overwrite it.
        noticesByOrg.set(orgId, {
            count: (prev?.count ?? 0) + 1,
            summary: prev?.summary ?? title,
            assistantId: prev?.assistantId ?? assistantId,
        });
    };

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
                if (hit) {
                    const proposal = buildEscalationProposal(hit);
                    if (await persistProposal(db, campaign, proposal)) {
                        escalations++;
                        note(campaign.organisationId, campaign.aiAssistantId, proposal.title);
                    }
                }
            }

            // ── Scenario 2 — the search is finding the wrong companies ─────────
            if (SCENARIO_REQUIREMENTS.halt.every((r) => hired!.has(r))
                && !await hasPendingDecision(db, campaign.id, 'halt')) {
                const hit = await detectLeadQualityDrop(db, campaign.organisationId, since24h);
                if (hit) {
                    const proposal = buildHaltProposal(hit);
                    if (await persistProposal(db, campaign, proposal)) {
                        halts++;
                        note(campaign.organisationId, campaign.aiAssistantId, proposal.title);
                    }
                }
            }
        } catch (err) {
            // One campaign's failure must not cost the rest of the run. Logged with the id so a
            // recurring offender is findable, then skipped.
            console.error('[campaign-agent] campaign failed', { campaignId: campaign.id, err });
        }
    }

    // ── Tell the user, once per org ──────────────────────────────────────────
    // AFTER every campaign has been considered, so an org running three campaigns gets one alert
    // rather than three. Runs outside the per-campaign try/catch above because a notification
    // failure must not be attributed to a campaign, and createNotification never throws anyway —
    // it returns false and logs, so a missing template degrades to silence rather than a failed run.
    let notified = 0;
    for (const [organisationId, notice] of noticesByOrg) {
        try {
            // The campaign's OWN orchestrator, not an arbitrary assistant in the org — this id is
            // what gives the card its actor identity (the coloured avatar and name eyebrow) and
            // what the "Review decision" CTA routes to.
            const [owner] = await db
                .select({ userId: aiAssistants.userId, name: aiAssistants.name })
                .from(aiAssistants)
                .where(eq(aiAssistants.id, notice.assistantId))
                .limit(1);
            if (!owner?.userId) continue;

            // The merge engine has no plural rules, so the call site passes a resolved noun phrase.
            const ok = await createNotification(db, 'campaign_decision_pending', {
                userId: owner.userId,
                assistantId: notice.assistantId,
                // metadata.assistantId is what notifications.js reads for the deep link. The
                // denormalised column above drives the actor avatar; they are read by different
                // code paths and both are needed.
                metadata: { assistantId: notice.assistantId },
                context: {
                    assistant: { name: owner.name || 'Your Campaign Assistant' },
                    decision: {
                        count: notice.count === 1 ? '1 decision' : `${notice.count} decisions`,
                        summary: notice.summary,
                    },
                },
            });
            if (ok) notified++;
        } catch (err) {
            console.error('[campaign-agent] notify failed', { organisationId, err });
        }
    }

    const result: CampaignAgentResult = {
        campaigns: live.length,
        proposed: escalations + halts,
        expired,
        escalations,
        halts,
        notified,
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
