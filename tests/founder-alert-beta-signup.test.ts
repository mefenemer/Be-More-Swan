// tests/founder-alert-beta-signup.test.ts
// Follow-up to Fix pipeline #91 (owner, 2026-11-25): "Fix the beta sign-up alert gap too".
// A beta sign-up gets the free beta plan at registration (register.ts), so at email verification
// startTrialIfEligible returns 'has_plan': no trial, no Stripe, and so no founder email at all.
// verify.ts now sends a "New beta tester" alert when the person verifying owns that beta plan row.
// A person joining an existing workspace has no plan row of their own and is not announced.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNewTrialAlertEmail } from '../src/utils/founder-alerts';

const beta = buildNewTrialAlertEmail({
    kind: 'beta', companyName: 'Acme Plumbing', fullName: 'Sam Jones', email: 'sam@acme.test',
    planName: 'Beta', endsOn: null, userId: 51, organisationId: 50, registeredOn: '2026-11-25',
});
assert.match(beta.subject, /^🧪 New beta tester: Acme Plumbing$/);
assert.match(beta.html, /New beta tester/);
assert.match(beta.html, /free beta, no card/);
assert.ok(!/Trial ends/.test(beta.html) && !/Trial ends/.test(beta.text), 'a beta has no trial end date');
assert.match(beta.text, /^New beta tester/);

// The trial email is unchanged when no kind is given.
const trial = buildNewTrialAlertEmail({ companyName: 'X', fullName: '', email: null, planName: 'Free Trial', endsOn: '2026-12-09', userId: 1, organisationId: 1 });
assert.match(trial.subject, /^🌱 New free trial: X$/);
assert.match(trial.html, /Trial ends/);

// verify.ts: whenever no trial started (beta workspaces already have a plan), only for the verifier's OWN beta plan row.
const verify = readFileSync(join(__dirname, '..', 'netlify', 'functions', 'verify.ts'), 'utf8');
const at = verify.indexOf('if (t.started) await sendNewTrialAlert(');
assert.ok(at !== -1, 'verify.ts sends the trial alert when the trial started');
assert.ok(!verify.includes("t.reason === 'has_plan'"), 'the beta check runs whenever no trial started, not only on has_plan');
const block = verify.slice(at, verify.indexOf("kind: 'beta'", at) + 20);
assert.ok(block.includes("kind: 'beta'"), 'sends the beta alert in that branch');
assert.match(block, /eq\(plans\.userId, user\.id\)/, "the verifier's own plan row");
assert.match(block, /eq\(plans\.planType, BETA_PLAN_TYPE\)/, 'a beta plan');
assert.ok(verify.indexOf('startTrialIfEligible(db,') < at, 'after the trial attempt');

console.log('founder-alert-beta-signup: a new beta tester tells the founder ✓');
