// netlify/functions/reconcile-campaigns.ts
// The Campaign Assistant's return path — the half that tells a campaign what actually happened.
//
//   for every order still 'issued' or 'in_review'
//     → the work is still being drafted            → leave it alone
//     → posts/articles exist and await approval     → 'in_review'
//     → the user approved or scheduled them         → 'delivered', and release anything chained behind it
//     → the user turned them all down               → 'rejected'
//     → nothing usable was produced                 → 'cancelled', and refund the work items charged
//   for every live campaign past its end date       → 'finished'
//
// ── Why this is a separate cron from autonomous-campaign-agent ──────────────────────────────────
// That function PROPOSES and must never act; this one only ever records what already happened, or
// continues a plan a human already approved. Two mandates, two functions — see the header of
// src/utils/campaign-reconciler.ts for the full argument. Merging them would make "the autonomous
// proposer never places an order" a claim qualified by a flag instead of a property of the file.
//
// ── Cadence ─────────────────────────────────────────────────────────────────────────────────────
// Hourly. Drafting takes minutes and human approval takes hours or days, so a tighter loop would
// only add invocations and Neon wake-ups (the compute quota is project-wide — see the 2026-07-11
// staging outage). Hourly also keeps the Orders tab honest within one hour of the user clicking
// Approve, which is the interaction this whole path exists to reflect.
//
// ⚠️ Netlify fires scheduled functions ONLY on the production deploy. Staging is a branch deploy,
// so this never runs there — .github/workflows/staging-crons.yml pokes run-campaign-reconciler
// instead, which calls the same function. The two must stay in step.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { setPlatformConfig } from '../../src/utils/platform-config';
import { reconcileCampaigns, type ReconcileResult } from '../../src/utils/campaign-reconciler';

/** Where the run records itself, so "did it fire?" is answerable without reading logs. */
const LAST_RUN_KEY = 'campaign_reconciler.last_run';

export async function runCampaignReconciler(): Promise<ReconcileResult> {
    // Deliberately NOT gated on isGlobalAiDisabled(). The kill switch silences the autonomous
    // surfaces — things that decide, generate or reach a user. This run makes no model call and
    // originates nothing: it reads statuses other parts of the product already wrote and copies
    // them onto the order. Freezing it during an incident would not make the product quieter, it
    // would just leave every campaign's Orders tab reporting work as outstanding after it landed.
    const db = getDb();
    const result = await reconcileCampaigns(db);

    // Non-blocking: a run that did its work and failed to record itself is still a successful run.
    try {
        await setPlatformConfig(LAST_RUN_KEY, { at: new Date().toISOString(), ...result }, undefined, 'reconcile-campaigns');
    } catch (err) {
        console.warn('[campaign-reconciler] could not record last_run', err);
    }

    return result;
}

export default withLambda(async () => {
    try {
        const result = await runCampaignReconciler();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[campaign-reconciler]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
