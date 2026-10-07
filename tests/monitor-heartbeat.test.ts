// tests/monitor-heartbeat.test.ts
// The watchdog over the monitors: src/utils/monitor-heartbeat.ts + platform-watchdog.ts +
// .github/workflows/prod-watchdog.yml.
//
// What has to hold: a check that stopped running, could not alert, or is reporting an open outage
// FAILS the watchdog; a healthy or merely-warning one passes it. No network, no database.
//
// Run:  npx tsx tests/monitor-heartbeat.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessHeartbeats, MAX_AGE_HOURS, type Heartbeat, type HeartbeatLog } from '../src/utils/monitor-heartbeat';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const NOW = new Date('2026-10-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const beat = (h: number, over: Partial<Heartbeat> = {}): Heartbeat =>
    ({ at: hoursAgo(h), problems: [], warnings: [], alertFailed: false, ...over });
const healthy: HeartbeatLog = { provider_balances: beat(1), content_generation: beat(5) };

console.log('assessHeartbeats');
check('both monitors fresh and quiet → ok', () => {
    const v = assessHeartbeats(healthy, NOW);
    assert.equal(v.ok, true, v.failures.join('; '));
    assert.equal(v.monitors.provider_balances.ageHours, 1);
});
check('no heartbeat at all → fails, naming BOTH monitors', () => {
    const v = assessHeartbeats({}, NOW);
    assert.equal(v.ok, false);
    assert.equal(v.failures.length, 2);
    assert.ok(v.failures.every(f => f.includes('never recorded a run')));
});
check('a stale heartbeat fails (the check stopped running)', () => {
    const v = assessHeartbeats({ ...healthy, provider_balances: beat(MAX_AGE_HOURS.provider_balances + 1) }, NOW);
    assert.equal(v.ok, false);
    assert.match(v.failures[0], /provider_balances: last ran .* stopped running/);
});
check('one missed 6h tick is tolerated', () => {
    assert.equal(assessHeartbeats({ ...healthy, provider_balances: beat(12) }, NOW).ok, true);
});
check('one missed daily tick (content_generation) fails', () => {
    assert.equal(assessHeartbeats({ ...healthy, content_generation: beat(MAX_AGE_HOURS.content_generation + 1) }, NOW).ok, false);
});
check('an open outage fails even while the check sits out its email cooldown', () => {
    const v = assessHeartbeats({ ...healthy, provider_balances: beat(1, { problems: ['Anthropic credit is EXHAUSTED'] }) }, NOW);
    assert.equal(v.ok, false);
    assert.ok(v.failures.some(f => f.includes('EXHAUSTED')));
});
check('a failed alert send fails the watchdog', () => {
    const v = assessHeartbeats({ ...healthy, content_generation: beat(2, { alertFailed: true }) }, NOW);
    assert.equal(v.ok, false);
    assert.ok(v.failures.some(f => f.includes('could NOT send')));
});
check('a low-balance warning is reported but does NOT fail', () => {
    const v = assessHeartbeats({ ...healthy, provider_balances: beat(1, { warnings: ['fal balance is low'] }) }, NOW);
    assert.equal(v.ok, true);
    assert.deepEqual(v.warnings, ['provider_balances: fal balance is low']);
});
check('an unparseable timestamp counts as never ran, not as fresh', () => {
    assert.equal(assessHeartbeats({ ...healthy, provider_balances: { ...beat(1), at: 'nonsense' } }, NOW).ok, false);
});

console.log('wiring');
check('both checks stamp a heartbeat', () => {
    assert.ok(read('netlify/functions/check-content-generation-health.ts').includes("recordHeartbeat('content_generation'"));
    assert.ok(read('netlify/functions/check-provider-balances.ts').includes("recordHeartbeat('provider_balances'"));
});
check('both alert-send catch blocks report alertFailed: true', () => {
    assert.ok(read('netlify/functions/check-content-generation-health.ts').includes('alerted: false, alertFailed: true'));
    assert.ok(read('netlify/functions/check-provider-balances.ts').includes('alerted: false, open, alertFailed: true'));
});
check('the watchdog endpoint fails closed and answers 503 on a bad verdict', () => {
    const src = read('netlify/functions/platform-watchdog.ts');
    assert.ok(src.includes('if (!secret)'));
    assert.ok(src.includes('verdict.ok ? 200 : 503'));
});
check('the workflow calls PROD, not staging, and fails on non-2xx', () => {
    const wf = read('.github/workflows/prod-watchdog.yml');
    assert.ok(wf.includes('https://bemoreswan.com/.netlify/functions/platform-watchdog'));
    assert.ok(!wf.includes('staging--'));
    assert.ok(wf.includes('SECRET: ${{ secrets.CRON_TRIGGER_SECRET }}'));
    assert.match(wf, /\*\)\s+echo .*exit 1/);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
