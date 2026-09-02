// tests/optimiser-health.test.ts
// The uptime check on the paid-campaign sweep — the one guard the sweep cannot provide for itself.
//
// The sweep checks its own staleness, which catches a cron that stops and RESUMES. Nothing that is
// not running can notice it is not running, and that is the case that matters: every guardrail in
// the paid rails stops being enforced while the customer's money keeps going out, and the failure
// is invisible precisely because nothing happens.
//
// So the checks below are about two things: does the assessment stay quiet when silence is
// CORRECT, and do the three watchers actually have different failure modes. A monitor that cries
// wolf gets muted, and three copies of the same watcher is one watcher.
//
// Run:  npx tsx tests/optimiser-health.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { OPTIMISER_STALE_HOURS } from '../src/config/ad-networks';
import {
    OPTIMISER_INCIDENT_HOURS, assessOptimiserHealth, readLastRunAt,
} from '../src/utils/optimiser-health';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const NOW = new Date('2026-09-02T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

console.log('\n──── silence is only a fault when something is at risk ────');

check('no live campaigns means NOT actionable, however long it has been', () => {
    // ⚠️ Checked before staleness, deliberately. An alert that fires when nothing is at risk is an
    // alert people learn to ignore — and that costs us the one time it matters.
    const h = assessOptimiserHealth(hoursAgo(500), 0, NOW);
    assert.equal(h.state, 'idle');
    assert.equal(h.actionable, false);
    assert.match(h.message, /nothing for the optimiser to check/);
});

check('never having run is not actionable either, if nothing is live', () => {
    assert.equal(assessOptimiserHealth(null, 0, NOW).actionable, false);
});

check('but never having run WITH live campaigns is actionable', () => {
    const h = assessOptimiserHealth(null, 2, NOW);
    assert.equal(h.state, 'never_run');
    assert.equal(h.actionable, true);
    assert.match(h.message, /Nothing is watching that spend/);
});

console.log('\n──── late, down, and the difference between them ────');

check('a healthy run is quiet', () => {
    const h = assessOptimiserHealth(hoursAgo(3), 2, NOW);
    assert.equal(h.state, 'ok');
    assert.equal(h.actionable, false);
});

check('past the staleness window is LATE, and says the customer is protected', () => {
    // The sweep's own watchdog is already halting campaigns at this point. It is a warning about
    // the machinery, not an emergency about the money.
    const h = assessOptimiserHealth(hoursAgo(OPTIMISER_STALE_HOURS + 1), 2, NOW);
    assert.equal(h.state, 'late');
    assert.equal(h.actionable, true);
    assert.match(h.message, /halting themselves/);
});

check('well past it is DOWN, and says the spend is unsupervised', () => {
    const h = assessOptimiserHealth(hoursAgo(OPTIMISER_INCIDENT_HOURS + 1), 3, NOW);
    assert.equal(h.state, 'down');
    assert.match(h.message, /unsupervised/);
});

check('the incident threshold sits above the staleness window, not on it', () => {
    // One missed run is a blip; a second is a pattern. Alerting at exactly the staleness hour
    // would page a human for every slightly-late run.
    assert.ok(OPTIMISER_INCIDENT_HOURS > OPTIMISER_STALE_HOURS);
});

check('every actionable message names the live campaign count', () => {
    for (const [last, n] of [[null, 2], [hoursAgo(40), 1], [hoursAgo(200), 5]] as [Date | null, number][]) {
        const h = assessOptimiserHealth(last, n, NOW);
        assert.ok(h.actionable);
        assert.ok(new RegExp(`\\b${n}\\b`).test(h.message), `message omits the count: ${h.message}`);
    }
});

console.log('\n──── the marker is read defensively ────');

check('a missing or malformed marker reads as NEVER RUN, not as fine', () => {
    // ⚠️ An uptime check that fails open is not an uptime check.
    assert.equal(readLastRunAt(null), null);
    assert.equal(readLastRunAt({}), null);
    assert.equal(readLastRunAt({ at: 12345 }), null);
    assert.equal(readLastRunAt({ at: 'not a date' }), null);
});

check('a good marker parses', () => {
    const d = readLastRunAt({ at: '2026-09-02T06:40:00.000Z' });
    assert.ok(d instanceof Date);
    assert.equal(d!.toISOString(), '2026-09-02T06:40:00.000Z');
});

check('the sweep and the check use the SAME config key constant', () => {
    // A drift here would have the checker reading a key nothing writes — permanently reporting
    // "never run" while the sweep ran perfectly, or worse, the reverse.
    const cfg = read('src/utils/platform-config.ts');
    assert.match(cfg, /PAID_OPTIMISER_LAST_RUN:\s+'paid_optimiser\.last_run'/);
    for (const f of ['netlify/functions/optimise-paid-campaigns.ts', 'netlify/functions/check-optimiser-health.ts']) {
        assert.match(code(read(f)), /CONFIG_KEYS\.PAID_OPTIMISER_LAST_RUN/, `${f} does not use the constant`);
    }
});

console.log('\n──── three watchers, three failure modes ────');

const health = read('netlify/functions/check-optimiser-health.ts');
const api = read('netlify/functions/campaigns.ts');
const toml = read('netlify.toml');
const workflow = read('.github/workflows/staging-crons.yml');

check('the scheduled checker runs on a DIFFERENT schedule from the sweep', () => {
    // One broken schedule entry must not silently take both.
    const sweep = toml.match(/\[functions\.optimise-paid-campaigns\]\s*\n\s*schedule = "([^"]+)"/)![1];
    const checker = toml.match(/\[functions\.check-optimiser-health\]\s*\n\s*schedule = "([^"]+)"/)![1];
    assert.notEqual(sweep, checker, 'the checker shares the sweep\'s schedule string');
});

check('the READ PATH checks too — the only uncorrelated watcher', () => {
    // Driven by user traffic, so it cannot fail the way a scheduler fails.
    assert.match(code(api), /assessOptimiserHealth\(/);
    assert.match(code(api), /optimiserHealth/);
});

check('the read path stays silent for workspaces with no paid campaigns', () => {
    // A cheerful "ok" would be a claim about machinery this workspace does not use.
    assert.match(code(api), /const optimiserHealth = livePaid > 0/);
    assert.match(code(api), /:\s*null;/);
});

check('the read path counts only THIS workspace\'s live paid campaigns', () => {
    assert.match(code(api), /items\.filter\(\(c\) => c\.mode === 'paid'/);
});

check('the correlated-failure limitation is written down, not glossed', () => {
    // ⚠️ Presenting any one of these as "the" uptime check would be a false guarantee. The whole
    // value of the arrangement is that a reader knows what is NOT covered.
    assert.match(read('src/utils/optimiser-health.ts'), /CORRELATED|correlated/);
    assert.match(health, /CORRELATED FAILURE/);
    assert.match(toml, /CORRELATED FAILURE/);
});

console.log('\n──── the alert itself ────');

check('it alerts the OPERATOR, not the customer', () => {
    // A dead optimiser is our failure. The customer already gets the consequence — their campaigns
    // halt — and "our monitoring stopped" adds alarm without an action they can take.
    assert.match(code(health), /FOUNDER_ALERT_EMAIL/);
    assert.ok(!/createNotification/.test(code(health)), 'the health check notifies tenants');
});

check('an ongoing incident does not email on every run', () => {
    assert.match(code(health), /ALERT_COOLDOWN_HOURS/);
    assert.match(code(health), /sinceAlert < ALERT_COOLDOWN_HOURS/);
});

check('the cooldown is short enough to resurface within a working day', () => {
    // Hourly gets filtered; daily lets a whole day pass on a second look.
    const hours = Number(health.match(/const ALERT_COOLDOWN_HOURS = (\d+)/)![1]);
    assert.ok(hours >= 2 && hours <= 12, `cooldown of ${hours}h is outside the useful range`);
});

check('a failed alert send is logged LOUDLY and never looks like a clean run', () => {
    // ⚠️ The quiet failure that would defeat the whole thing: an unhealthy optimiser AND a
    // swallowed alert reads, in the logs, exactly like everything being fine.
    assert.match(code(health), /ALERT SEND FAILED/);
    assert.match(code(health), /alerted: false/);
});

check('the alert only fires when the assessment says actionable', () => {
    assert.ok(
        landmark(health, 'if (!health.actionable)') < landmark(health, 'await sendEmail({'),
        'the email is sent before actionability is decided',
    );
});

console.log(`\n${passed} checks passed.\n`);
