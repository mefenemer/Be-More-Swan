// src/utils/goal-progress.ts
//
// SMART Goals — US1.2 Progress Calculation Logic (pure, no I/O so it's fully unit-testable).
// Given a goal's baseline, latest value and timeline, compute the required vs actual run-rate
// (AC1.2.2) and assign a status (AC1.2.3). Stale telemetry overrides to data_disconnected
// (AC4.3.2). Thresholds come from RUN_RATE_THRESHOLDS in the metric-catalog SoT.

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

    // Stale telemetry → data_disconnected (AC4.3.2), but still surface last-known progress.
    const needed = targetValue - startValue;       // signed: +ve for increase goals, -ve for decrease
    const gained = latestValue - startValue;
    const progressFraction = needed !== 0 ? gained / needed : (gained === 0 ? 1 : 0);
    const pct = clampPct(progressFraction * 100);

    if (lastTelemetryAt && now.getTime() - lastTelemetryAt.getTime() > RUN_RATE_THRESHOLDS.staleDataHours * 3600_000) {
        return { status: 'data_disconnected', pct, requiredRunRate: null, actualRunRate: null, ratio: null };
    }

    const elapsedMs = now.getTime() - createdAt.getTime();
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
