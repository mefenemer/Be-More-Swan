// tests/free-trial.test.ts
// The free 14-day trial, no card (src/utils/trial.ts). Owner decisions 2026-10-17: it starts when a
// new workspace's owner verifies their email; it is the Busywork Buster's features with 150 tasks;
// when it ends, assistants pause and scheduled work is held — never deleted, never charged.
//
// Run:  npx tsx tests/free-trial.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FREE_PLAN_TYPES, featureTierKey, TRIAL_TIER_KEY } from '../src/config/beta-plan';
import { TRIAL_DAYS, TRIAL_PLAN_TYPE, trialDaysLeft } from '../src/utils/trial';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('Free trial — 14 days, every assistant, no card');

check('14 days, and a trial plan is a free plan a paid plan replaces', () => {
    assert.strictEqual(TRIAL_DAYS, 14);
    assert.strictEqual(TRIAL_PLAN_TYPE, 'trial');
    assert.ok((FREE_PLAN_TYPES as readonly string[]).includes('trial'));
    assert.ok((FREE_PLAN_TYPES as readonly string[]).includes('beta'));
});

check('the trial gets the Busywork Buster\'s features wherever the tier key gates them', () => {
    assert.strictEqual(featureTierKey(TRIAL_TIER_KEY), 'buster');
    assert.strictEqual(featureTierKey('beta'), 'employee');
    assert.strictEqual(featureTierKey('saver'), 'saver');
});

check('days left rounds up and never goes negative', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    assert.strictEqual(trialDaysLeft(new Date('2026-10-31T12:00:00Z'), now), 14);
    assert.strictEqual(trialDaysLeft(new Date('2026-10-17T18:00:00Z'), now), 1);
    assert.strictEqual(trialDaysLeft(new Date('2026-10-16T12:00:00Z'), now), 0);
});

check('the trial starts at first verification, never blocks the login', () => {
    const v = read('netlify/functions/verify.ts');
    const at = v.indexOf('startTrialIfEligible(db');
    assert.ok(at > -1, 'verify.ts does not start the trial');
    assert.ok(v.lastIndexOf('if (isFirstLogin && user.organisationId)', at) > -1, 'only on the first verification');
    assert.ok(v.indexOf('catch (err)', at) > at, 'a failure must not block the login');
});

check('one trial per workspace and per person', () => {
    const t = read('src/utils/trial.ts');
    assert.match(t, /eq\(plans\.organisationId, params\.organisationId\)\)\.limit\(1\);\s*if \(anyPlan\) return \{ started: false, reason: 'has_plan' \}/);
    assert.match(t, /eq\(trials\.userId, params\.userId\)/);
    assert.match(read('db/z-trial-plan.sql'), /organisation_id\s+INTEGER NOT NULL UNIQUE/);
});

check('ending pauses only RUNNING assistants, stamped; nothing is deleted or charged', () => {
    const t = read('src/utils/trial.ts');
    const end = t.slice(t.indexOf('export async function endTrialFor'), t.indexOf('export async function resumeAfterTrialConversion'));
    assert.match(end, /eq\(aiAssistants\.isActive, true\)/);
    assert.match(end, /provisioningStatus: TRIAL_ENDED_PAUSE/);
    assert.ok(!/\.delete\(/.test(end));
    assert.ok(!/stripe/i.test(end));
});

check('subscribing brings an ended trial back, through the shared paid-plan hook', () => {
    const b = read('src/utils/beta-ending.ts');
    const after = b.slice(b.indexOf('export async function afterPaidPlanStarted'));
    assert.match(after, /resumeAfterTrialConversion\(db, organisationId, now\)/);
    const retire = b.slice(b.indexOf('export async function retireBetaPlanBeforePaid'), b.indexOf('export async function afterPaidPlanStarted'));
    assert.match(retire, /inArray\(plans\.planType, \[\.\.\.FREE_PLAN_TYPES\]\)/);
});

check('an ended trial\'s publishing is held, and the lifecycle shows it as system-paused', () => {
    assert.match(read('src/utils/beta-ending.ts'), /for \(const id of await endedTrialOrganisationIds\(db\)\) held\.add\(id\)/);
    assert.match(read('db/z-trial-plan.sql'), /'paused_beta_ended','paused_trial_ended'\)\s+THEN 'system_paused'/);
});

check('the sweep runs daily, emails once, and the templates exist', () => {
    assert.match(read('netlify.toml'), /\[functions\.trial-sweep\]\s+schedule = "15 7 \* \* \*"/);
    const sweep = read('netlify/functions/trial-sweep.ts');
    assert.match(sweep, /isNull\(trials\.reminderSentAt\)\)\)\.returning/);
    const cat = read('src/utils/email-templates-catalog.ts');
    assert.match(cat, /triggerKey: 'trial_ending_soon'/);
    assert.match(cat, /triggerKey: 'trial_ended'/);
});

check('logged out, the pricing buttons start the trial — no plan choice, so no card checkout', () => {
    const p = read('pricing.html');
    const fn = p.slice(p.indexOf('window.choosePlan = function'));
    assert.match(fn, /sessionStorage\.removeItem\('pending_tier'\)/);
    assert.ok(!/sessionStorage\.setItem\('pending_tier'/.test(fn));
});

check('the terms and the FAQ say what the trial is', () => {
    assert.match(read('terms_of_service.html'), /6\.10 — Free trial\./);
    assert.match(read('faq.html'), /14 days free, and no card needed/);
});

console.log(`\n${passed} checks passed.`);
