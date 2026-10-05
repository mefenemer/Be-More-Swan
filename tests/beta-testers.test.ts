// tests/beta-testers.test.ts
//
// Run:  npx tsx tests/beta-testers.test.ts
//
// Beta testers (decided 2026-10-05, src/utils/beta-testers.ts): anyone who applied through /beta may
// create an account while registration is locked, and gets the free 'beta' plan — no Stripe, no
// card. These checks pin the four places that have to agree, each of which fails SILENTLY if it
// drifts: a tester who cannot sign up, a tester sent to checkout, or a nightly false alarm.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const REGISTER = read('netlify/functions/register.ts');
const GUARD = read('netlify/edge-functions/auth-guard.ts');
const RECONCILE = read('netlify/functions/reconcile-billing.ts');
const PAGE = read('register.html');
const SQL = read('db/beta-tester-plan.sql');

check('register: the lock is checked AFTER the beta check, and skipped for beta applicants', () => {
    const beta = landmark(REGISTER, 'isBetaApplicant(db, email)');
    const lock = landmark(REGISTER, 'await isRegistrationLocked()');
    assert.ok(beta < lock, 'the lock runs before we know whether this email is a beta applicant — every tester is turned away');
    assert.match(REGISTER, /if \(!isBeta && await isRegistrationLocked\(\)\)/, 'the lock must exempt beta applicants');
});

check('register: a beta applicant never carries a paid plan to checkout, and gets the beta plan', () => {
    assert.match(REGISTER, /if \(isBeta\) planTier = null;/);
    const tx = REGISTER.slice(landmark(REGISTER, 'const resultUser = await db.transaction'));
    assert.match(tx, /planType: BETA_PLAN_TYPE,[\s\S]{0,40}status: 'active'/, 'the new workspace must get an active beta plan inside the same transaction');
});

check('edge: ?beta=1 is let through the lock (and nothing else is)', () => {
    assert.match(GUARD, /registrationLocked\s*&&\s*path\s*===\s*['"]\/register['"]\s*&&\s*url\.searchParams\.get\('beta'\)\s*!==\s*'1'/);
});

check('register.html: beta mode drops any pending plan and explains a non-applicant instead of redirecting', () => {
    assert.match(PAGE, /const planTier = IS_BETA \? null :/);
    const branch = PAGE.slice(landmark(PAGE, 'data.waitlist && IS_BETA'));
    assert.ok(branch.indexOf('beta.html') !== -1 && branch.indexOf('beta.html') < branch.indexOf("window.location.href = '/waitlist.html'"),
        'a beta sign-up with the wrong email must be told so, not bounced to the waitlist');
});

check('reconcile-billing: beta plans are not flagged as missing a Stripe subscription', () => {
    assert.match(RECONCILE, /ne\(plans\.planType, BETA_PLAN_TYPE\)/);
});

check('the beta master plan is hidden from the picker and costs nothing', () => {
    assert.match(SQL, /'beta', 'Beta'/);
    assert.match(SQL, /FROM master_plans\s+WHERE tier_key = 'employee'/, 'copies the top self-serve tier');
    assert.match(SQL, /features, false\s*\nFROM/, 'is_active must be false — get-plans lists active plans only');
    assert.match(SQL, /ON CONFLICT \(tier_key\) DO NOTHING/, 'must be safe to re-run');
});

if (process.exitCode) console.error('\nbeta testers: FAILED');
else console.log(`\nbeta testers: ${passed} passed`);
