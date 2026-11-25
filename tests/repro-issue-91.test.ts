// tests/repro-issue-91.test.ts
// Fix pipeline #91 (prod, owner, 2026-11-24): "When a new person subscribes, an email should be sent to
// hello@bemoreswan.com … a new subscriber has signed up on 19th Nov and I was not aware."
// Prod: user 50 (org 49) registered 19 Nov 22:18 and got the no-card 14-day free trial at 22:19 (plans row 11,
// plan_type 'trial', no Stripe ids); user 49 (org 48) on 17 Nov the same. The only founder alert for a new
// customer, sendNewSubscriberAlert, fires from the Stripe webhook when money is taken — a trial never reaches
// Stripe, so no one was told. Since the free trial (2026-10-17) every new customer starts this way.
//
// Fix: a "New free trial" founder alert, sent when verify.ts actually starts the trial (once per workspace;
// startTrialIfEligible is the one-trial gate), never blocking the login.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as alerts from '../src/utils/founder-alerts';

const build = (alerts as any).buildNewTrialAlertEmail;
assert.strictEqual(typeof build, 'function', 'founder-alerts has a new-trial alert');

const email = build({
    companyName: 'Acme Plumbing', fullName: 'Sam Jones', email: 'sam@acme.test',
    planName: 'Free Trial', endsOn: '2026-12-03', industry: 'Trades', websiteUrl: 'https://acme.test',
    userId: 50, organisationId: 49, registeredOn: '2026-11-19',
});
assert.match(email.subject, /New free trial/);
assert.match(email.subject, /Acme Plumbing/);
assert.match(email.html, /sam@acme\.test/);
assert.match(email.html, /2026-12-03/, 'says when the trial ends');
assert.match(email.text, /Sam Jones/);
const escaped = build({ companyName: '<b>x</b>', fullName: '', email: null, planName: 'Free Trial', endsOn: null, userId: 1, organisationId: null });
assert.ok(!escaped.html.includes('<b>x</b>'), 'company name is escaped');

// verify.ts sends it only when the trial actually started, after the start, and never lets it block the login.
const verify = readFileSync(join(__dirname, '..', 'netlify', 'functions', 'verify.ts'), 'utf8');
const start = verify.indexOf('startTrialIfEligible(db,');
const send = verify.indexOf('sendNewTrialAlert(');
assert.ok(start !== -1 && send > start, 'verify.ts sends the new-trial alert after starting the trial');
const between = verify.slice(start, send);
assert.match(between, /t\.started/, 'only when the trial started');

console.log('repro-issue-91: a new free trial tells the founder ✓');
