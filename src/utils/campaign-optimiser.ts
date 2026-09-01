// src/utils/campaign-optimiser.ts
// The daily kill switch, as a pure function. US4 of the brief: pause losers, protect the budget.
//
// No db, no clock, no network: it takes metrics and returns decisions. Everything that makes this
// dangerous — that it stops a customer's advertising, or fails to — is therefore unit-testable,
// which is the only reason it is safe to run unattended.
//
// ── The three rules, and why each is shaped the way it is ───────────────────────────────────────
//
//   1. FATIGUE, BEHIND SAMPLE FLOORS. A variant whose CTR has fallen far below its own 7-day
//      average is tiring. But "far below" on a small sample is noise — and the smallest samples
//      occur on day one, when the user is watching hardest. So the floors come first and the
//      threshold second. Getting this backwards produces an assistant that pauses a brand-new
//      campaign's best ad within an hour of launch, which is worse than doing nothing at all.
//
//   2. COST PER OUTCOME, AGAINST A CEILING THE USER SET. Not against a benchmark, not against the
//      other variants: against a number the customer chose. An agent that decides for itself what
//      a lead is worth is making a commercial judgement it has no standing to make.
//
//   3. THE TOTAL NEVER RISES. The optimiser may stop things and may let the network redistribute
//      what remains, and that is the whole of its authority over money. AC 4.3 in the brief, and
//      the reason `AdNetworkAdapter` has no method that could raise a budget even if this file
//      wanted to.
//
// ── What it deliberately cannot do ──────────────────────────────────────────────────────────────
// It cannot start anything. It cannot resume a paused variant. It cannot raise a ceiling. A daily
// job that could start a spend would mean a model's judgement plus a cron tick was enough to begin
// costing money, which is the invariant `chat-creates-draft-campaigns` settled for the whole
// product: approving is a human act.

import {
    CTR_FATIGUE_DROP, FATIGUE_WINDOW_DAYS, MIN_CLICKS_FOR_FATIGUE, MIN_DAYS_FOR_FATIGUE,
    MIN_IMPRESSIONS_FOR_FATIGUE, OPTIMISER_STALE_HOURS, type PauseReason,
} from '../config/ad-networks';

/** One day of one variant's performance. */
export interface DailyMetric {
    day: string;              // YYYY-MM-DD
    impressions: number;
    clicks: number;
    spendGbp: number;
    /** OUR attributed conversions for that day, not the network's claim. */
    conversions: number;
}

export interface VariantWindow {
    variantId: number;
    externalVariantId: string;
    status: 'staged' | 'active' | 'paused' | 'archived' | 'rejected';
    /** Oldest first. The most recent day is the one being judged. */
    days: DailyMetric[];
}

export interface OptimiserInput {
    variants: VariantWindow[];
    /** The user's ceiling, or null if they set none. Never inferred. */
    maxCostPerOutcomeGbp: number | null;
    /** Guards carried over from campaign_budgets. */
    maxActionsPerDay: number;
    /** Actions already taken today, so a re-run inside the same day cannot exceed the cap. */
    actionsTakenToday: number;
}

export interface PauseDecision {
    variantId: number;
    externalVariantId: string;
    reason: PauseReason;
    /** The sentence shown in the feed and the digest. Contains the numbers it was based on. */
    explanation: string;
}

export interface OptimiserResult {
    pauses: PauseDecision[];
    /**
     * Variants examined but left alone, with why. Not diagnostics — this is what makes "the
     * assistant did nothing today" legible instead of suspicious, and it is what the user reads
     * when they ask why an obviously bad ad is still running.
     */
    held: { variantId: number; reason: string }[];
    /**
     * True when pausing everything below would leave the campaign with no live variant.
     *
     * ⚠️ Reported rather than acted on. Pausing the last ad standing is sometimes right (they are
     * all losing money) and sometimes catastrophic (the whole campaign silently stops). That is a
     * judgement about the customer's business, so it becomes a decision for a human.
     */
    wouldStopCampaign: boolean;
}

const sum = (rows: DailyMetric[], f: (d: DailyMetric) => number) => rows.reduce((n, d) => n + f(d), 0);

/** Clicks ÷ impressions, or null when there is nothing to divide. Never a fake zero. */
export function ctr(rows: DailyMetric[]): number | null {
    const impressions = sum(rows, (d) => d.impressions);
    if (impressions <= 0) return null;
    return sum(rows, (d) => d.clicks) / impressions;
}

/** Spend ÷ conversions, or null. A variant with spend and no conversions has an UNDEFINED cost. */
export function costPerOutcome(rows: DailyMetric[]): number | null {
    const conversions = sum(rows, (d) => d.conversions);
    if (conversions <= 0) return null;
    return sum(rows, (d) => d.spendGbp) / conversions;
}

/**
 * Does this variant have enough history to be judged at all?
 *
 * Checked against the BASELINE (everything before the most recent day), because that is what the
 * comparison is against. A variant with 50,000 impressions today and none before it has no average
 * to have fallen below.
 */
export function hasEnoughEvidence(baseline: DailyMetric[]): boolean {
    if (baseline.length < MIN_DAYS_FOR_FATIGUE) return false;
    if (sum(baseline, (d) => d.impressions) < MIN_IMPRESSIONS_FOR_FATIGUE) return false;
    if (sum(baseline, (d) => d.clicks) < MIN_CLICKS_FOR_FATIGUE) return false;
    return true;
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const gbp = (v: number) => `£${v.toFixed(2)}`;

export function optimise(input: OptimiserInput): OptimiserResult {
    const pauses: PauseDecision[] = [];
    const held: { variantId: number; reason: string }[] = [];

    // Only live variants are candidates. A `staged` variant has never spent and pausing it would
    // silently reject something the user has not been asked about yet.
    const live = input.variants.filter((v) => v.status === 'active');

    let budget = Math.max(0, input.maxActionsPerDay - input.actionsTakenToday);

    for (const v of live) {
        if (v.days.length === 0) { held.push({ variantId: v.variantId, reason: 'No performance data yet.' }); continue; }

        const today = v.days.slice(-1);
        const baseline = v.days.slice(-1 - FATIGUE_WINDOW_DAYS, -1);

        // ── Rule 2 first: a ceiling the user set beats a trend we inferred. ──
        const cpo = costPerOutcome(v.days);
        if (input.maxCostPerOutcomeGbp != null && cpo != null && cpo > input.maxCostPerOutcomeGbp) {
            if (budget <= 0) { held.push({ variantId: v.variantId, reason: 'Daily change limit reached; will look again tomorrow.' }); continue; }
            budget--;
            pauses.push({
                variantId: v.variantId,
                externalVariantId: v.externalVariantId,
                reason: 'cost_per_outcome',
                explanation: `Each result was costing ${gbp(cpo)}, above the ${gbp(input.maxCostPerOutcomeGbp)} ceiling you set.`,
            });
            continue;
        }

        // ── Rule 1: fatigue, but only with enough evidence to mean anything. ──
        if (!hasEnoughEvidence(baseline)) {
            held.push({
                variantId: v.variantId,
                // Names what is missing, so "why is this still running" has an answer.
                reason: `Not enough history yet — needs ${MIN_DAYS_FOR_FATIGUE} days, ${MIN_IMPRESSIONS_FOR_FATIGUE.toLocaleString('en-GB')} impressions and ${MIN_CLICKS_FOR_FATIGUE} clicks before its average means anything.`,
            });
            continue;
        }

        const baseCtr = ctr(baseline);
        const todayCtr = ctr(today);
        if (baseCtr == null || todayCtr == null) {
            held.push({ variantId: v.variantId, reason: 'No impressions today, so there is nothing to compare.' });
            continue;
        }

        const floor = baseCtr * (1 - CTR_FATIGUE_DROP);
        if (todayCtr < floor) {
            if (budget <= 0) { held.push({ variantId: v.variantId, reason: 'Daily change limit reached; will look again tomorrow.' }); continue; }
            budget--;
            pauses.push({
                variantId: v.variantId,
                externalVariantId: v.externalVariantId,
                reason: 'creative_fatigue',
                explanation: `Click-through fell to ${pct(todayCtr)} against a ${FATIGUE_WINDOW_DAYS}-day average of ${pct(baseCtr)} — more than the ${Math.round(CTR_FATIGUE_DROP * 100)}% drop that means an ad has been seen too often.`,
            });
            continue;
        }

        held.push({ variantId: v.variantId, reason: `Performing normally — ${pct(todayCtr)} against a ${pct(baseCtr)} average.` });
    }

    return {
        pauses,
        held,
        wouldStopCampaign: live.length > 0 && pauses.length >= live.length,
    };
}

// ── The heartbeat ───────────────────────────────────────────────────────────────────────────────

export interface HeartbeatVerdict {
    stale: boolean;
    hoursSince: number | null;
    /** What the user is told when it has gone stale. Names the consequence, not the mechanism. */
    message: string | null;
}

/**
 * Has the optimiser stopped running?
 *
 * ⚠️ THIS IS THE MOST IMPORTANT FUNCTION IN THE FILE, and it exists because of this codebase's own
 * history: two nightly sweeps never ran for weeks and nothing noticed, and the scheduler drops a
 * large share of its ticks. For organic work that is a delay. For paid work it means every rule
 * above silently stops being enforced while the customer's money keeps going out — the failure is
 * invisible precisely because nothing happens.
 *
 * So a paid campaign whose optimiser has gone quiet must HALT ITSELF. Failing closed costs the
 * customer a pause they did not ask for; failing open costs them a budget nobody is watching.
 *
 * `lastRunAt: null` means it has never run, which for an active paid campaign is the same
 * situation and gets the same answer.
 */
export function assessHeartbeat(lastRunAt: Date | null, now: Date): HeartbeatVerdict {
    if (!lastRunAt) {
        return {
            stale: true,
            hoursSince: null,
            message: 'We have not been able to check on this campaign since it started, so we have paused it. Your ads are not running and nothing further is being spent.',
        };
    }
    const hoursSince = (now.getTime() - lastRunAt.getTime()) / (60 * 60 * 1000);
    if (hoursSince <= OPTIMISER_STALE_HOURS) return { stale: false, hoursSince, message: null };
    return {
        stale: true,
        hoursSince,
        message: `We have not been able to check on this campaign for ${Math.floor(hoursSince)} hours, so we have paused it rather than let it keep spending unwatched. You can resume it once things are running normally again.`,
    };
}
