// tests/goal-edit-regrades.test.ts
// Editing a goal's target or end date must re-grade it immediately.
//
// Reported 2026-09-30 on PROD: Be More Swan's goals were moved to an end date of 30 Nov 2026 and all
// still read "Off Track". manage-goals PATCH saved the new date but never touched `status`, which
// moves only when fresh telemetry arrives — and a metric whose poll returns nothing (LinkedIn has no
// follower count; Meta is restricted) never re-grades at all, so the old verdict stuck indefinitely.
//
// Run:  npx tsx tests/goal-edit-regrades.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGoalProgress } from '../src/utils/goal-progress';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'netlify/functions/manage-goals.ts'), 'utf8');
const patch = src.slice(src.indexOf("if (method === 'PATCH')"), src.indexOf("if (method === 'DELETE')"));

check('why it matters: a later end date can turn the same numbers from off track to on track', () => {
    const base = {
        startValue: 100, latestValue: 250, targetValue: 400, direction: 'increase' as const,
        createdAt: new Date('2026-08-01'), lastTelemetryAt: new Date('2026-09-30'), now: new Date('2026-09-30'),
        rateAsOfLastEntry: true,
    };
    assert.strictEqual(computeGoalProgress({ ...base, targetDate: new Date('2026-10-15') }).status, 'off_track');
    assert.strictEqual(computeGoalProgress({ ...base, targetDate: new Date('2027-06-30') }).status, 'on_track');
});

check('PATCH re-grades when the target or the date changes, BEFORE saving', () => {
    assert.match(patch, /if \(targetValue !== undefined \|\| targetDate !== undefined\) \{\s*const regraded = await regradeFromRecord\(db, \{ \.\.\.existing, \.\.\.updates \}\)/,
        'the re-grade must see the NEW target/date, i.e. existing merged with updates');
    assert.ok(patch.indexOf('regradeFromRecord(') < patch.indexOf('db.update(goals).set(updates)'),
        'status must be set before the row is written, or the response and the blueprint recompile carry the stale one');
    assert.match(patch, /updates\.status = regraded/);
});

check('the re-grade uses the same rules as the writers it stands in for', () => {
    const fn = src.slice(src.indexOf('async function regradeFromRecord'));
    assert.match(fn, /rateAsOfLastEntry: true/, 'rate as of the last data point, not as of the edit');
    assert.match(fn, /isManualMetric\(goal\.metricKey\)/);
    assert.match(fn, /minDataPoints: 2/, 'manual metrics need two entries, as in record-goal-value');
    assert.match(fn, /return null/, 'no baseline → leave status alone');
});

check('an edit never declares data stale — that is the poller\'s call (it sends the alerts)', () => {
    const fn = src.slice(src.indexOf('async function regradeFromRecord'));
    assert.match(fn, /\['on_track', 'at_risk', 'off_track', 'pending'\]/);
    assert.doesNotMatch(fn.slice(fn.indexOf('RUN_RATE_STATUSES')), /data_disconnected'\]/);
});

console.log(`\n${passed} checks passed`);
