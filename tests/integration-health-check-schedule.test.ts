// tests/integration-health-check-schedule.test.ts
// integration-health-check.ts sends the "connection expires in N days" and "disconnected" alerts.
// Its header said "Scheduled daily at 08:30 UTC" for months while netlify.toml had no entry for it,
// so it never ran, and LinkedIn connections died at 60 days without a word (October 2026).
//
// Switching it on had to come with the anti-spam rules, or it would have:
//   • emailed every dead connection EVERY DAY (the dedupe key carried today's date),
//   • told every X customer daily that their token "expires in 0 days" (X tokens last 2 hours),
//   • doubled the email the refresh crons already send, and nagged people who disconnected on purpose.
//
// Run:  npx tsx tests/integration-health-check-schedule.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const toml = read('../netlify.toml');
const src = read('../netlify/functions/integration-health-check.ts');

console.log('\nintegration-health-check: scheduled, and once per cycle\n');

test('netlify.toml schedules it daily', () => {
    const m = toml.match(/\[functions\.integration-health-check\]\s*\n\s*schedule\s*=\s*"([^"]+)"/);
    assert.ok(m, 'no [functions.integration-health-check] schedule in netlify.toml — the alerts never send');
    assert.equal(m![1], '30 8 * * *', 'schedule changed — update the header in integration-health-check.ts too');
});

test('the dedupe key is per cycle, not per day', () => {
    const line = src.split('\n').find(l => l.includes('const dedupeKey'));
    assert.ok(line, 'could not find dedupeKey — update this test');
    assert.ok(!/toISOString\(\)\.slice\(0,\s*10\)/.test(line!), 'dedupe is keyed on the date again: every dead connection is alerted daily');
    assert.ok(line!.includes('${cycle}'), 'dedupe key no longer carries the connection cycle');
});

test('auto-renewed and self-warning services are excluded from the expiring alert', () => {
    assert.ok(src.includes('notInArray(systemConnections.serviceName, NO_EXPIRY_ALERT_SERVICES)'),
        'the expiring branch alerts on X/Meta tokens a cron renews, and doubles the LinkedIn warning');
    assert.ok(/NO_EXPIRY_ALERT_SERVICES = \[\.\.\.CRON_RENEWED_SERVICES, \.\.\.CRON_WARNS_OWN_EXPIRY\]/.test(src),
        'NO_EXPIRY_ALERT_SERVICES no longer comes from connection-renewal.ts');
});

test('dead statuses already handled elsewhere are not re-alerted', () => {
    const m = src.match(/ALREADY_HANDLED_DEAD_STATUSES = \[([^\]]*)\]/);
    assert.ok(m, 'could not find ALREADY_HANDLED_DEAD_STATUSES — update this test');
    for (const s of ['token_refresh_failed', 'revoked']) {
        assert.ok(m![1].includes(`'${s}'`), `${s} is alerted again (already emailed, or the customer chose it)`);
    }
    assert.ok(src.includes('inArray(systemConnections.status, alertableDead)'), 'the dead branch ignores ALREADY_HANDLED_DEAD_STATUSES');
});

test('only recent breakages are alerted', () => {
    assert.ok(src.includes('gte(systemConnections.updatedAt, deadSince)'), 'system_connections dead branch has no age limit');
    assert.ok(src.includes('gte(workspaceIntegrations.updatedAt, deadSince)'), 'workspace_integrations dead branch has no age limit');
});

console.log(`\n${passed} checks passed`);
