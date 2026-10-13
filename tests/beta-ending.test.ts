// tests/beta-ending.test.ts
// Ending the beta: per-workspace end dates, admin-only emails, the founding offer, and what happens
// on the day — pause, hold, never delete, and switch back on the moment they subscribe.
//
// Also pins the blocker found while building it: checkout treated the free beta plan as "already
// subscribed", so a beta tester could not pay before their end date.
//
// No database: pure helpers plus source checks.
// Run:  npx tsx tests/beta-ending.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    suggestTier, discountedPrice, offerLine, offerCheckoutUrl, heldOrgsClause, longDate, type TierLimits,
} from '../src/utils/beta-ending';
import { EMAIL_VARIABLES } from '../src/utils/email-template';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const TIERS: TierLimits[] = [
    { tierKey: 'employee', name: 'The Digital Employee', monthlyPriceGbp: 349, assistantLimit: null, monthlyTaskLimit: null },
    { tierKey: 'saver', name: 'The Workflow Saver', monthlyPriceGbp: 29, assistantLimit: 1, monthlyTaskLimit: 200 },
    { tierKey: 'buster', name: 'The Busywork Buster', monthlyPriceGbp: 79, assistantLimit: 3, monthlyTaskLimit: 1000 },
];
const FOUNDER = { code: 'FOUNDER30', percentOff: 30, amountOffPence: null, duration: 'repeating', durationInMonths: 12 };

console.log('\nThe offer');

check('the smallest plan that covers what they used, not the beta tier', () => {
    assert.deepStrictEqual(suggestTier({ assistants: 1, peakMonthlyTasks: 120 }, TIERS), { tierKey: 'saver', fits: true });
    assert.deepStrictEqual(suggestTier({ assistants: 2, peakMonthlyTasks: 120 }, TIERS), { tierKey: 'buster', fits: true });
    assert.deepStrictEqual(suggestTier({ assistants: 1, peakMonthlyTasks: 1500 }, TIERS), { tierKey: 'employee', fits: true });
});

check('30% off £29 is £20.30; an amount-off never goes below zero', () => {
    assert.strictEqual(discountedPrice(29, FOUNDER), 20.3);
    assert.strictEqual(discountedPrice(29, { percentOff: null, amountOffPence: 5000 }), 0);
    assert.strictEqual(discountedPrice(29, null), 29);
});

check('the offer sentence states the price, how long, the full price after, and the code', () => {
    const line = offerLine('The Workflow Saver', 29, FOUNDER);
    assert.match(line, /£20\.30 a month for your first 12 months \(then £29\)/);
    assert.match(line, /code FOUNDER30 is already applied/);
    assert.doesNotMatch(offerLine('The Workflow Saver', 29, null), /code|founding/i, 'no coupon → no promise of one');
});

check('the email link opens checkout on the offered plan with the code applied', () => {
    assert.strictEqual(offerCheckoutUrl('https://bemoreswan.com', 'saver', 'FOUNDER30'), 'https://bemoreswan.com/checkout.html?tier=saver&promo=FOUNDER30');
});

check('the end date reads as a UK date', () => {
    assert.strictEqual(longDate('2026-11-13'), 'Friday 13 November 2026');
});

console.log('\nOnly an admin emails a tester; only a told workspace is ended');

const sweep = read('netlify/functions/end-beta-sweep.ts');
const admin = read('netlify/functions/admin-beta.ts');
const core = read('src/utils/beta-ending.ts');

check('the sweep never sends the notice or reminder — only beta_ended, on the day', () => {
    assert.ok(!/beta_ending_notice|beta_ending_reminder/.test(sweep));
    assert.ok(/triggerKey: 'beta_ended'/.test(sweep));
});

check('a workspace is ended only if its notice was sent', () => {
    assert.ok(/isNotNull\(betaEndings\.noticeSentAt\)/.test(sweep), 'the sweep selects untold workspaces');
    assert.ok(/!ending\.noticeSentAt\) return 'skipped'/.test(core), 'endBetaFor would end an untold workspace');
});

check('sending is admin-only, once for the notice, audit-logged', () => {
    assert.ok(/requirePermission\(admin\?\.role, 'manage_beta'\)/.test(admin));
    assert.ok(/action === 'notice' && ws\.ending\.noticeSentAt\) return json\(409/.test(admin));
    assert.ok(/action === 'reminder' && !ws\.ending\.noticeSentAt\) return json\(409/.test(admin));
    assert.ok(/beta_notice_sent/.test(admin) && /beta_reminder_sent/.test(admin));
});

console.log('\nOn the day, and after they pay');

check('ending pauses only RUNNING assistants, stamped so only they come back; nothing is deleted', () => {
    const end = core.slice(core.indexOf('export async function endBetaFor'), core.indexOf('export async function resumeAfterBetaConversion'));
    assert.ok(/eq\(aiAssistants\.isActive, true\)/.test(end));
    assert.ok(/provisioningStatus: BETA_ENDED_PAUSE/.test(end));
    assert.ok(!/\.delete\(/.test(end));
    const resume = core.slice(core.indexOf('export async function resumeAfterBetaConversion'));
    assert.ok(/eq\(aiAssistants\.provisioningStatus, BETA_ENDED_PAUSE\)/.test(resume), 'resume must touch only beta-paused assistants');
});

check('what fell due while paused goes back to Review instead of publishing late', () => {
    const resume = core.slice(core.indexOf('export async function resumeAfterBetaConversion'));
    assert.ok(/scheduledPosts\)\.set\(\{ status: 'pending_approval'/.test(resume));
    assert.ok(/blogPosts\)\.set\(\{ status: 'draft'/.test(resume));
    assert.ok(/newsletterIssues\)\.set\(\{ status: 'approved'/.test(resume));
});

check('every publisher holds an ended workspace IN the query (not after it), and keeps going if it cannot tell', () => {
    for (const f of ['netlify/functions/publish-social-posts.ts', 'netlify/functions/publish-instagram.ts', 'netlify/functions/publish-facebook.ts']) {
        assert.ok(/\$\{heldOrgsClause\(held\)\}/.test(read(f)), `${f} does not hold ended betas in its SQL`);
    }
    assert.ok(/notInArray\(blogPosts\.organisationId, held\)/.test(read('netlify/functions/publish-blog-posts.ts')));
    assert.ok(/heldOrganisationIds\(db\)/.test(read('src/utils/newsletter-send.ts')));
    assert.ok(/catch \(err\)[\s\S]{0,160}return new Set\(\)/.test(core), 'a failed read must hold nothing, not stop publishing');
    assert.strictEqual(heldOrgsClause(new Set()), '');
    assert.strictEqual(heldOrgsClause(new Set([4, 9])), 'AND organisation_id <> ALL(ARRAY[4,9]::int[])');
});

check('a beta-paused assistant shows as paused by the system, with the right message', () => {
    assert.ok(/'paused_beta_ended'\)\s+THEN 'system_paused'/.test(read('db/z-beta-endings.sql')));
    assert.ok(/SYSTEM_PAUSED_BETA_ENDED/.test(read('netlify/functions/kickoff-assistant.ts')));
    assert.ok(/paused_beta_ended/.test(read('netlify/functions/get-assistant-readiness.ts')));
});

console.log('\nA beta tester can actually pay');

check('checkout does not treat the free beta plan as "already subscribed"', () => {
    const cs = read('netlify/functions/create-subscription.ts');
    const guard = cs.slice(cs.indexOf('Double-charge guard'), cs.indexOf('if (activePlan) {'));
    assert.ok(/ne\(plans\.planType, BETA_PLAN_TYPE\)/.test(guard), 'a beta tester would be sent to the dashboard without paying');
});

check('every paid-plan insert retires the beta plan first and resumes after', () => {
    const cs = read('netlify/functions/create-subscription.ts');
    assert.ok(/retireBetaPlanBeforePaid\(db, orgId\);\s+const \[newPlan\] = await db\.insert\(plans\)/.test(cs));
    assert.ok(/afterPaidPlanStarted\(db, orgId\)/.test(cs));
    const wh = read('netlify/functions/stripe-webhook.ts');
    assert.strictEqual(wh.match(/retireBetaPlanBeforePaid\(db, orgIdInt\)/g)?.length, 2, 'both webhook paths');
    assert.strictEqual(wh.match(/afterPaidPlanStarted\(db, orgIdInt\)/g)?.length, 2, 'both webhook paths');
});

console.log('\nThe emails');

check('the three templates exist, are transactional, and use only declared variables', () => {
    const declared = new Set(EMAIL_VARIABLES.map((v) => v.key));
    for (const key of ['beta_ending_notice', 'beta_ending_reminder', 'beta_ended']) {
        const t = getTemplateDefault(key);
        assert.ok(t, `${key} missing`);
        assert.ok(t!.transactional, `${key} must be transactional — it is about their account, not marketing`);
        for (const m of (t!.subject + t!.bodyHtml).matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)/g)) {
            assert.ok(declared.has(m[1]), `${key} uses undeclared variable ${m[1]}`);
        }
    }
    assert.match(getTemplateDefault('beta_ending_notice')!.bodyHtml, /Nothing is deleted/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
