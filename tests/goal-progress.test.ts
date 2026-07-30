// tests/goal-progress.test.ts
// SMART Goals — US1.2 progress/status engine (src/utils/goal-progress.ts).
// Run:  npx tsx tests/goal-progress.test.ts

import assert from 'node:assert';
import { computeGoalProgress } from '../src/utils/goal-progress';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
const daysAhead = (n: number) => new Date(Date.now() + n * 86400_000);

check('no telemetry yet → pending', () => {
    const r = computeGoalProgress({
        startValue: null, latestValue: null, targetValue: 20000,
        createdAt: daysAgo(10), targetDate: daysAhead(20), direction: 'increase', lastTelemetryAt: null,
    });
    assert.equal(r.status, 'pending');
});

check('too new (<1 day) → pending even with data', () => {
    const r = computeGoalProgress({
        startValue: 1000, latestValue: 1010, targetValue: 2000,
        createdAt: new Date(Date.now() - 3600_000), targetDate: daysAhead(30), direction: 'increase', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'pending');
});

check('on pace → on_track', () => {
    // 50% time elapsed (10 of 20 days), 50% progress (1000→1500 of 1000→2000)
    const r = computeGoalProgress({
        startValue: 1000, latestValue: 1500, targetValue: 2000,
        createdAt: daysAgo(10), targetDate: daysAhead(10), direction: 'increase', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'on_track');
    assert.equal(r.pct, 50);
});

check('slightly behind → at_risk', () => {
    // 50% elapsed, ~40% progress → ratio ~0.8 → at_risk
    const r = computeGoalProgress({
        startValue: 0, latestValue: 400, targetValue: 1000,
        createdAt: daysAgo(10), targetDate: daysAhead(10), direction: 'increase', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'at_risk');
});

check('far behind → off_track', () => {
    // 50% elapsed, 10% progress → ratio 0.2 → off_track
    const r = computeGoalProgress({
        startValue: 0, latestValue: 100, targetValue: 1000,
        createdAt: daysAgo(10), targetDate: daysAhead(10), direction: 'increase', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'off_track');
});

check('target reached → on_track at 100%', () => {
    const r = computeGoalProgress({
        startValue: 0, latestValue: 1200, targetValue: 1000,
        createdAt: daysAgo(5), targetDate: daysAhead(10), direction: 'increase', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'on_track');
    assert.equal(r.pct, 100);
});

check('stale telemetry (>48h) → data_disconnected', () => {
    const r = computeGoalProgress({
        startValue: 0, latestValue: 500, targetValue: 1000,
        createdAt: daysAgo(10), targetDate: daysAhead(10), direction: 'increase', lastTelemetryAt: daysAgo(3),
    });
    assert.equal(r.status, 'data_disconnected');
    assert.equal(r.pct, 50); // still surfaces last-known progress
});

check('decrease goal on pace → on_track', () => {
    // reduce churn 100→50; 50% elapsed, down to 75 (50% of the way) → on pace
    const r = computeGoalProgress({
        startValue: 100, latestValue: 75, targetValue: 50,
        createdAt: daysAgo(10), targetDate: daysAhead(10), direction: 'decrease', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'on_track');
    assert.equal(r.pct, 50);
});

check('decrease goal moving wrong way → off_track', () => {
    const r = computeGoalProgress({
        startValue: 100, latestValue: 110, targetValue: 50,
        createdAt: daysAgo(10), targetDate: daysAhead(10), direction: 'decrease', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'off_track');
});

// ── User-reported (manual) metrics ───────────────────────────────────────────────
// Three defaults are overridden for a metric the user types in by hand. Each of these tests is a
// bug that WOULD have shipped by inheriting the polled-metric behaviour unchanged.

check('a manual metric is not stale on the 48h connection rule', () => {
    // A monthly revenue figure entered 10 days ago is perfectly current. On the default window it
    // would read as stale and — via poll-goal-telemetry — raise a critical "reconnect your account"
    // alert about an integration that does not exist.
    const base = {
        startValue: 100_000, latestValue: 150_000, targetValue: 200_000,
        createdAt: daysAgo(40), targetDate: daysAhead(40), direction: 'increase' as const,
        lastTelemetryAt: daysAgo(10), dataPoints: 3, minDataPoints: 2,
    };
    assert.equal(computeGoalProgress(base).status, 'data_disconnected', 'baseline: the 48h default would flag it');

    const r = computeGoalProgress({ ...base, staleAfterHours: 37 * 24, staleStatus: 'awaiting_update' });
    assert.equal(r.status, 'on_track', 'within its own cadence it is judged normally');
});

check('an overdue manual figure becomes awaiting_update, never data_disconnected', () => {
    const r = computeGoalProgress({
        startValue: 100_000, latestValue: 150_000, targetValue: 200_000,
        createdAt: daysAgo(120), targetDate: daysAhead(40), direction: 'increase',
        lastTelemetryAt: daysAgo(60), staleAfterHours: 37 * 24, staleStatus: 'awaiting_update',
        dataPoints: 3, minDataPoints: 2,
    });
    assert.equal(r.status, 'awaiting_update');
    assert.equal(r.pct, 50, 'the bar the user has been watching still shows last-known progress');
});

check('silence between entries does not decay the run-rate into off_track', () => {
    // THE COLLISION THIS PREVENTS. A goal exactly on pace as of its last entry, 25 days ago. Measured
    // against `now` the same gain is divided by 55 days instead of 30, the ratio falls below the
    // off_track threshold, and the goal flips — which is what wakes the autonomous optimizer and has
    // it rewrite the assistant's brand voice. Nothing about the business changed; the user simply
    // hasn't typed this month's number yet.
    const base = {
        startValue: 0, latestValue: 50_000, targetValue: 100_000,
        createdAt: daysAgo(55), targetDate: daysAhead(5), direction: 'increase' as const,
        lastTelemetryAt: daysAgo(25), staleAfterHours: 37 * 24, staleStatus: 'awaiting_update' as const,
        dataPoints: 3, minDataPoints: 2,
    };
    assert.equal(computeGoalProgress(base).status, 'off_track', 'baseline: measuring to now punishes the gap');
    assert.equal(computeGoalProgress({ ...base, rateAsOfLastEntry: true }).status, 'on_track');
});

check('one data point is not a trend', () => {
    // With a single entry the "trend" is an artefact of where the baseline landed. A monthly metric
    // would otherwise be graded — and potentially acted on — a full month before a second reading.
    const base = {
        startValue: 0, latestValue: 10, targetValue: 100_000,
        createdAt: daysAgo(30), targetDate: daysAhead(30), direction: 'increase' as const,
        lastTelemetryAt: new Date(), rateAsOfLastEntry: true,
    };
    assert.equal(computeGoalProgress({ ...base, dataPoints: 1, minDataPoints: 2 }).status, 'pending');
    assert.equal(computeGoalProgress({ ...base, dataPoints: 2, minDataPoints: 2 }).status, 'off_track');
});

check('polled metrics are completely unaffected by the manual knobs', () => {
    // Every new field is optional and defaults to the old behaviour, so no existing caller changes.
    const r = computeGoalProgress({
        startValue: 1000, latestValue: 1500, targetValue: 2000,
        createdAt: daysAgo(10), targetDate: daysAhead(10), direction: 'increase', lastTelemetryAt: new Date(),
    });
    assert.equal(r.status, 'on_track');
    assert.equal(r.pct, 50);
});

console.log(`\n${passed} checks passed.`);
