// tests/roi-period.test.ts
// ROI reporting window — roi-stats.ts (dashboard) and get-assistant-metrics.ts
// (assistant detail Impact & ROI) must aggregate over identical date ranges.
// Locks the shared helper's behaviour, including the month-boundary case where
// the calendar week reaches into the previous month (the original cause of the
// dashboard showing 1.3h while the detail tab showed 1.5h).
// Run:  npx tsx tests/roi-period.test.ts

import assert from 'node:assert';
import { parseRoiPeriod, roiPeriodStart } from '../src/utils/roi-period';

// ── parseRoiPeriod ──────────────────────────────────────────────
assert.strictEqual(parseRoiPeriod('week'), 'week');
assert.strictEqual(parseRoiPeriod('month'), 'month');
assert.strictEqual(parseRoiPeriod(undefined), 'week', 'missing param defaults to week');
assert.strictEqual(parseRoiPeriod('garbage'), 'week', 'unknown values fall back to week');

// ── week start: Saturday 4 July 2026 → Sunday 28 June 2026 00:00 ─
const sat = new Date(2026, 6, 4, 15, 30); // local time, mid-afternoon
const weekStart = roiPeriodStart('week', sat);
assert.strictEqual(weekStart.getFullYear(), 2026);
assert.strictEqual(weekStart.getMonth(), 5); // June
assert.strictEqual(weekStart.getDate(), 28);
assert.strictEqual(weekStart.getHours(), 0);
assert.strictEqual(weekStart.getMinutes(), 0);

// A Sunday is its own week start.
const sun = new Date(2026, 6, 5, 9, 0);
const sunStart = roiPeriodStart('week', sun);
assert.strictEqual(sunStart.getDate(), 5);
assert.strictEqual(sunStart.getMonth(), 6);
assert.strictEqual(sunStart.getHours(), 0);

// ── month start: 4 July 2026 → 1 July 2026 00:00 ────────────────
const monthStart = roiPeriodStart('month', sat);
assert.strictEqual(monthStart.getFullYear(), 2026);
assert.strictEqual(monthStart.getMonth(), 6); // July
assert.strictEqual(monthStart.getDate(), 1);
assert.strictEqual(monthStart.getHours(), 0);

// ── the boundary quirk: early in a month, week start < month start,
//    so "this week" legitimately covers more than "this month". ───
assert.ok(weekStart.getTime() < monthStart.getTime(),
    'first week of July 2026 reaches back into June');

// Week start crossing a year boundary: Friday 2 Jan 2026 → Sunday 28 Dec 2025.
const jan = new Date(2026, 0, 2, 12, 0);
const janWeek = roiPeriodStart('week', jan);
assert.strictEqual(janWeek.getFullYear(), 2025);
assert.strictEqual(janWeek.getMonth(), 11);
assert.strictEqual(janWeek.getDate(), 28);

console.log('roi-period.test.ts: all assertions passed');
