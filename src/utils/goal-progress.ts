// src/utils/goal-progress.ts
//
// SMART Goals — US1.2 Progress Calculation Logic (pure, no I/O so it's fully unit-testable).
// Given a goal's baseline, latest value and timeline, compute the required vs actual run-rate
// (AC1.2.2) and assign a status (AC1.2.3). Stale telemetry overrides to data_disconnected
// (AC4.3.2) — or to awaiting_update for a user-reported metric. Thresholds come from
// RUN_RATE_THRESHOLDS in the metric-catalog SoT.

import { RUN_RATE_THRESHOLDS, type GoalStatus, type MetricDirection } from '../config/goal-metrics';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProgressInput {
    startValue: number | null;     // baseline captured at first poll
    latestValue: number | null;    // most recent telemetry value
    targetValue: number;
    createdAt: Date;               // timeline start
    targetDate: Date;              // deadline
    direction: MetricDirection;    // 'increase' | 'decrease'
    lastTelemetryAt: Date | null;  // when the latest value was recorded
    now?: Date;

    // ── Manual-metric knobs (see MetricSource in goal-metrics.ts) ────────────────
    // All three default to the polled-metric behaviour, so every existing caller is unaffected.

    /**
     * Hours of silence before the goal counts as stale. Defaults to the 48h AC4.3.2 rule; callers
     * pass staleWindowHoursFor(metricKey) so a monthly manual figure isn't flagged on day three.
     */
    staleAfterHours?: number;
    /**
     * What "stale" means for this metric — 'data_disconnected' (a broken integration) or
     * 'awaiting_update' (we're waiting on the user). Defaults to the former.
     */
    staleStatus?: GoalStatus;
    /**
     * Measure the actual run-rate up to the LAST ENTRY rather than up to now.
     *
     * For a polled metric these are the same instant, so this changes nothing. For a manual metric
     * they are weeks apart, and using `now` would divide the same gain by an ever-growing elapsed
     * time — the run-rate would decay toward zero between entries and the goal would slide from
     * on_track to off_track purely because nobody had typed a number yet. That is a false signal,
     * and an expensive one: an off_track status is what wakes the autonomous optimizer and makes it
     * rewrite the assistant's brief.
     */
    rateAsOfLastEntry?: boolean;
    /**
     * How many data points exist for this goal, and the minimum needed to judge a trend (default 1).
     *
     * A manual goal needs TWO: with a single entry the "trend" is entirely an artefact of where the
     * baseline happened to land, and a monthly metric would otherwise be graded — and possibly acted
     * on — a full month before it has anything resembling a second observation.
     */
    dataPoints?: number;
    minDataPoints?: number;
}

export interface ProgressResult {
    status: GoalStatus;
    pct: number;                   // 0–100 progress toward target (for the UI bar)
    requiredRunRate: number | null;// units/day needed to hit target on time
    actualRunRate: number | null;  // units/day achieved so far
    ratio: number | null;          // actual ÷ required (null when not yet computable)
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Assign on_track / at_risk / off_track (or pending / data_disconnected) for a goal.
 * Works for both 'increase' and 'decrease' goals — the delta arithmetic is sign-agnostic
 * because `needed` and `gained` carry the direction's sign together.
 */
export function computeGoalProgress(input: ProgressInput): ProgressResult {
    const now = input.now ?? new Date();
    const { startValue, latestValue, targetValue, createdAt, targetDate, lastTelemetryAt } = input;

    const none: ProgressResult = { status: 'pending', pct: 0, requiredRunRate: null, actualRunRate: null, ratio: null };

    // No data yet → pending.
    if (startValue == null || latestValue == null) return none;

    // Stale telemetry → data_disconnected / awaiting_update (AC4.3.2), but still surface last-known
    // progress: the bar the user has been watching should not blank out just because a poll lapsed.
    const needed = targetValue - startValue;       // signed: +ve for increase goals, -ve for decrease
    const gained = latestValue - startValue;
    const progressFraction = needed !== 0 ? gained / needed : (gained === 0 ? 1 : 0);
    const pct = clampPct(progressFraction * 100);

    const staleAfterMs = (input.staleAfterHours ?? RUN_RATE_THRESHOLDS.staleDataHours) * 3600_000;
    if (lastTelemetryAt && now.getTime() - lastTelemetryAt.getTime() > staleAfterMs) {
        return { status: input.staleStatus ?? 'data_disconnected', pct, requiredRunRate: null, actualRunRate: null, ratio: null };
    }

    // Not enough observations to call a trend (manual metrics ask for two — see `minDataPoints`).
    if (input.dataPoints != null && input.dataPoints < (input.minDataPoints ?? 1)) {
        return { ...none, pct };
    }

    // The instant the achieved gain is measured AT. Same as `now` for a polled metric; the last
    // entry for a manual one, so silence between entries doesn't dilute the rate — see
    // `rateAsOfLastEntry`.
    const measuredAt = (input.rateAsOfLastEntry && lastTelemetryAt) ? lastTelemetryAt : now;
    const elapsedMs = measuredAt.getTime() - createdAt.getTime();
    const totalMs = targetDate.getTime() - createdAt.getTime();

    // Too new (or malformed timeline) to judge a trend yet.
    if (elapsedMs < RUN_RATE_THRESHOLDS.minObservationDays * DAY_MS || totalMs <= 0) {
        return { ...none, pct };
    }

    // Target already reached.
    if (progressFraction >= 1) {
        return { status: 'on_track', pct, requiredRunRate: needed / (totalMs / DAY_MS), actualRunRate: gained / (elapsedMs / DAY_MS), ratio: Infinity };
    }

    const requiredRunRate = needed / (totalMs / DAY_MS);
    const actualRunRate = gained / (elapsedMs / DAY_MS);
    // ratio compares speed toward the target; sign-agnostic via division of same-signed needs.
    const ratio = requiredRunRate !== 0 ? actualRunRate / requiredRunRate : (gained === 0 ? 0 : Infinity);

    let status: GoalStatus;
    if (ratio >= RUN_RATE_THRESHOLDS.onTrack) status = 'on_track';
    else if (ratio >= RUN_RATE_THRESHOLDS.offTrack) status = 'at_risk';
    else status = 'off_track';

    return { status, pct, requiredRunRate, actualRunRate, ratio };
}
