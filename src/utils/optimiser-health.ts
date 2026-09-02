// src/utils/optimiser-health.ts
// Is the paid-campaign sweep still running? The one guard the sweep cannot provide for itself.
//
// ── The problem, stated honestly ────────────────────────────────────────────────────────────────
// `optimise-paid-campaigns` checks its own staleness, which catches a cron that stops and RESUMES.
// It cannot catch a cron that never comes back — nothing that is not running can notice that it is
// not running. And that is the case that matters most: every guardrail in the paid rails (fatigue
// pauses, the cost ceiling, the control check) stops being enforced while the customer's money
// keeps going out, and the failure is invisible precisely because nothing happens.
//
// ── Why this file is pure, and what actually calls it ───────────────────────────────────────────
// The assessment is separated from the alerting because it has THREE callers with genuinely
// different failure characteristics, and no single one of them is trustworthy alone:
//
//   1. `check-optimiser-health` — a scheduled function on a DIFFERENT schedule from the sweep.
//      ⚠️ Correlated failure: if the whole Netlify scheduler is down, this is down too. It catches
//      the likely case (one function broken, deploy issue, an exception in the sweep) and not the
//      unlikely one.
//   2. The staging-crons GitHub workflow — genuinely separate infrastructure, so it survives a
//      Netlify scheduler outage. But it is itself unreliable (a fraction of ticks delivered).
//   3. THE READ PATH — `campaigns.ts` `list`. Driven by user traffic, not by any scheduler, so it
//      is the only one that cannot fail in the same way as the thing it watches. It is also the
//      only one that is silent when nobody is looking.
//
// Three imperfect watchers with uncorrelated failure modes is the honest best available. Any one of
// them presented as "the" uptime check would be a false guarantee.

import { OPTIMISER_STALE_HOURS } from '../config/ad-networks';

/**
 * How far past the staleness window we let things drift before this is an INCIDENT rather than a
 * late run.
 *
 * The sweep already halts individual campaigns at OPTIMISER_STALE_HOURS. This is about telling a
 * human that the machinery itself has stopped, which is a different and later judgement — one
 * missed run is a blip, a second is a pattern.
 */
export const OPTIMISER_INCIDENT_HOURS = OPTIMISER_STALE_HOURS + 12;

export type OptimiserHealthState = 'ok' | 'late' | 'down' | 'idle' | 'never_run';

export interface OptimiserHealth {
    state: OptimiserHealthState;
    hoursSince: number | null;
    /**
     * Does this need a human? Deliberately FALSE when there are no live paid campaigns: a sweep
     * that has not run because there was nothing to sweep is not a fault, and paging someone about
     * it is how alerts get muted.
     */
    actionable: boolean;
    /** What to tell whoever is being told. Written for a person, not a log. */
    message: string;
}

/**
 * Assess the sweep's health.
 *
 * @param lastRunAt        `paid_optimiser.last_run`, or null if it has never run.
 * @param liveCampaigns    How many paid campaigns are currently live. THE thing that decides
 *                         whether silence is a problem or the correct answer.
 */
export function assessOptimiserHealth(
    lastRunAt: Date | null,
    liveCampaigns: number,
    now: Date,
): OptimiserHealth {
    const hoursSince = lastRunAt ? (now.getTime() - lastRunAt.getTime()) / 3_600_000 : null;

    // ⚠️ Checked FIRST, before staleness. With no live paid campaigns there is nothing to protect,
    // so a stale sweep is not an incident — and an alert that fires when nothing is at risk is an
    // alert people learn to ignore, which costs us the one time it matters.
    if (liveCampaigns === 0) {
        return {
            state: 'idle',
            hoursSince,
            actionable: false,
            message: 'No paid campaigns are running, so there is nothing for the optimiser to check.',
        };
    }

    if (hoursSince === null) {
        return {
            state: 'never_run',
            hoursSince: null,
            actionable: true,
            message: `The paid-campaign optimiser has never run, and ${liveCampaigns} campaign${liveCampaigns === 1 ? ' is' : 's are'} live. Nothing is watching that spend.`,
        };
    }
    if (hoursSince > OPTIMISER_INCIDENT_HOURS) {
        return {
            state: 'down',
            hoursSince,
            actionable: true,
            message: `The paid-campaign optimiser has not run for ${Math.floor(hoursSince)} hours with ${liveCampaigns} campaign${liveCampaigns === 1 ? '' : 's'} live. Ad spend is unsupervised and the automatic pauses are not being applied.`,
        };
    }
    if (hoursSince > OPTIMISER_STALE_HOURS) {
        return {
            state: 'late',
            hoursSince,
            // Late, but the sweep's own watchdog is already halting campaigns at this point — the
            // customer is protected. This is a warning about the machinery, not an emergency.
            actionable: true,
            message: `The paid-campaign optimiser last ran ${Math.floor(hoursSince)} hours ago. Live campaigns will start halting themselves until it runs again.`,
        };
    }
    return {
        state: 'ok',
        hoursSince,
        actionable: false,
        message: `Checked ${Math.floor(hoursSince)} hour${Math.floor(hoursSince) === 1 ? '' : 's'} ago.`,
    };
}

/**
 * The `paid_optimiser.last_run` marker, parsed defensively.
 *
 * It is a JSON blob written by the sweep. A missing, malformed or unparseable marker is treated as
 * NEVER RUN rather than as fine — an uptime check that fails open is not an uptime check.
 */
export function readLastRunAt(marker: unknown): Date | null {
    const at = (marker as { at?: unknown } | null)?.at;
    if (typeof at !== 'string') return null;
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? null : d;
}
