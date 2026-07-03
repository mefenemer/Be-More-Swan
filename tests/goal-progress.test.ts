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

console.log(`\n${passed} checks passed.`);
