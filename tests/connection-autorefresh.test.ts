// tests/connection-autorefresh.test.ts
// CRON_REFRESHED (integrations.ts) tells the Connections UI which system_connections tokens are
// renewed silently by a cron, so _connHealth can suppress the "Expiring in Nd" reconnect nag for
// them. It is a hand-written list of service names sitting in a different file from the crons it
// describes — exactly the shape that rots.
//
// It had already rotted: facebook and instagram ARE rotated nightly by refresh-meta-tokens, but
// were absent from the set, so a healthy Meta connection counted itself down to "Disconnected"
// over the last week of every 60-day window while the cron was quietly extending it.
//
// Both directions of the mismatch are bugs, and the second is the worse one:
//   missing entry → the UI nags the user to reconnect something already being renewed.
//   extra entry   → the UI swears a connection is fine when NOTHING is renewing it, and the first
//                   the user hears of it is a failed publish.
//
// Run:  npx tsx tests/connection-autorefresh.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** The service names a refresh cron actually SELECTS from system_connections. */
function cronSelects(src: string, file: string): string[] {
    const m = src.match(/inArray\(systemConnections\.serviceName,\s*\[([^\]]*)\]\)/);
    assert.ok(m, `could not find the serviceName selection in ${file} — update this test`);
    return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

const integrations = read('../netlify/functions/integrations.ts');
const social = cronSelects(read('../netlify/functions/refresh-social-tokens.ts'), 'refresh-social-tokens.ts');
const meta = cronSelects(read('../netlify/functions/refresh-meta-tokens.ts'), 'refresh-meta-tokens.ts');

const declared = (() => {
    const m = integrations.match(/const CRON_REFRESHED = new Set\(\[([^\]]*)\]\)/);
    assert.ok(m, 'could not find CRON_REFRESHED in integrations.ts — update this test');
    return new Set([...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]));
})();

const refreshed = new Set([...social, ...meta]);

console.log('\nCRON_REFRESHED ↔ the refresh crons\n');

test('every cron-rotated service is declared auto-refreshing', () => {
    const missing = [...refreshed].filter(s => !declared.has(s));
    assert.deepEqual(missing, [],
        `a cron renews these but CRON_REFRESHED omits them, so the card nags to reconnect a ` +
        `connection that is being renewed: ${missing.join(', ')}`);
});

test('nothing is declared auto-refreshing that no cron renews', () => {
    const phantom = [...declared].filter(s => !refreshed.has(s));
    assert.deepEqual(phantom, [],
        `CRON_REFRESHED claims these renew silently but no cron selects them, so the card will ` +
        `read "Connected" until a publish fails: ${phantom.join(', ')}`);
});

test('the Meta pair specifically is covered', () => {
    // The regression that prompted this file. Named explicitly so a future refactor of
    // refresh-meta-tokens that drops the Meta services fails here loudly rather than by set maths.
    for (const svc of ['facebook', 'instagram']) {
        assert.ok(meta.includes(svc), `refresh-meta-tokens no longer renews ${svc}`);
        assert.ok(declared.has(svc), `${svc} is missing from CRON_REFRESHED`);
    }
});

test('the dead-status check still runs before autoRefresh in the UI', () => {
    // What keeps this suppression honest: a genuinely dead connection must render "Disconnected"
    // regardless of autoRefresh. If these two ever swap order in _connHealth, marking the Meta
    // services auto-refreshing would start hiding real breakage instead of a false alarm.
    const health = read('../integrations.js');
    const fn = health.slice(health.indexOf('function _connHealth('));
    const dead = fn.indexOf('isConnectionDead');
    const auto = fn.indexOf('conn.autoRefresh');
    assert.ok(dead !== -1 && auto !== -1, 'could not locate _connHealth internals — update this test');
    assert.ok(dead < auto, 'autoRefresh is now checked before isConnectionDead — a dead connection would render as Connected');
});

console.log(`\n${passed} checks passed\n`);
