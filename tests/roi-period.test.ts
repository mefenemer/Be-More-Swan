// tests/roi-period.test.ts
// ROI reporting window — roi-stats.ts (dashboard) and get-assistant-metrics.ts
// (assistant detail Impact & ROI) must aggregate over identical date ranges.
// Locks the shared helper's behaviour, including the month-boundary case where
// the calendar week reaches into the previous month (the original cause of the
// dashboard showing 1.3h while the detail tab showed 1.5h).
// Run:  npx tsx tests/roi-period.test.ts

import assert from 'node:assert';
import { parseRoiPeriod, roiPeriodStart, roiPeriodLabel } from '../src/utils/roi-period';

// ── parseRoiPeriod ──────────────────────────────────────────────
assert.strictEqual(parseRoiPeriod('week'), 'week');
assert.strictEqual(parseRoiPeriod('month'), 'month');
assert.strictEqual(parseRoiPeriod('all'), 'all');
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

// ── 'all': the epoch, so nothing is ever windowed out ───────────
// This is the regression the period exists for — on the morning of 1 August 2026
// the month window was hours old and the ROI hero reported zero despite a full
// month of activity the day before. 'all' must be stable across any boundary.
const augFirst = new Date(2026, 7, 1, 9, 15);
const allStart = roiPeriodStart('all', augFirst);
assert.strictEqual(allStart.getTime(), 0, "'all' starts at the epoch");
assert.ok(allStart.getTime() < roiPeriodStart('month', augFirst).getTime());
assert.ok(allStart.getTime() < roiPeriodStart('week', augFirst).getTime());
// Stable regardless of when it's asked — the whole point of the window.
assert.strictEqual(roiPeriodStart('all', jan).getTime(), roiPeriodStart('all', sat).getTime());
// Must survive the ISO-string bind used against raw sql`` fragments (see roi-stats.ts).
assert.strictEqual(allStart.toISOString(), '1970-01-01T00:00:00.000Z');

// The 1 August case, stated directly: a month window opened that morning excludes
// all of July, which is exactly why 'all' had to become the dashboard default.
const julyActivity = new Date(2026, 6, 31, 18, 0);
assert.ok(julyActivity.getTime() < roiPeriodStart('month', augFirst).getTime(),
    "31 July activity falls outside a 1 August month window");
assert.ok(julyActivity.getTime() > allStart.getTime(),
    "…but is still counted by 'all'");

// ── roiPeriodLabel ──────────────────────────────────────────────
assert.strictEqual(roiPeriodLabel('all'), 'all time');
assert.strictEqual(roiPeriodLabel('week'), 'this week');
assert.strictEqual(roiPeriodLabel('month'), 'this month');

console.log('roi-period.test.ts: all assertions passed');
