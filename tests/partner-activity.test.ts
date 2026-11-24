// tests/partner-activity.test.ts
// Partner Terms 1.3 §7.5 "Staying active" (src/utils/partner-activity.ts, db/z-partner-activity.sql).
//
// WHY THIS EXISTS (2026-11-23): the owner wanted partners to keep selling rather than sell once to
// their network and earn for ever. The legal review made the clause fair (cure, notice by tenure,
// run-off, re-approval) and the financial review narrowed it: standard ≤12-month customers run to
// term. Every one of those promises is in the contract, so each is pinned here.
//
// Run:  npx tsx tests/partner-activity.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeUntil, extendedNoticeEnd, freePeriodEnd, noticeMonths, pauseDaysFor, runOffAllows } from '../src/utils/partner-activity';
import { effectiveShareBps } from '../src/utils/partner-rate-periods';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const d = (s: string) => new Date(`${s}T00:00:00Z`);

console.log('the clock (7.5(c))');
check('6 months from approval when nobody has paid yet', () => {
    assert.deepStrictEqual(activeUntil(d('2027-01-10'), null, 0), d('2027-07-10'));
});
check('a later Qualifying Customer restarts it; an earlier one does not', () => {
    assert.deepStrictEqual(activeUntil(d('2027-01-10'), d('2027-03-05'), 0), d('2027-09-05'));
    assert.deepStrictEqual(activeUntil(d('2027-01-10'), d('2026-12-01'), 0), d('2027-07-10'));
});
check('paused days (suspended, sign-ups paused) push it back day for day', () => {
    assert.deepStrictEqual(activeUntil(d('2027-01-10'), null, 12), d('2027-07-22'));
});

check('paused days belong to the clock start they were counted for; a newer start resets them (review #820)', () => {
    assert.strictEqual(pauseDaysFor(9, d('2027-01-10'), d('2027-01-10')), 9);
    assert.strictEqual(pauseDaysFor(9, d('2027-01-10'), d('2027-03-05')), 0, 'a new Qualifying Customer restarts the clock');
    assert.strictEqual(pauseDaysFor(9, null, d('2027-03-05')), 0);
});

console.log('notice (7.5(d), (e))');
check('1 month in year one, 2 after a year, 3 after two years', () => {
    assert.strictEqual(noticeMonths(d('2027-01-10'), d('2027-12-01')), 1);
    assert.strictEqual(noticeMonths(d('2027-01-10'), d('2028-02-01')), 2);
    assert.strictEqual(noticeMonths(d('2027-01-10'), d('2029-02-01')), 3);
});
check('free period = 14-day trial then the first month free', () => {
    assert.deepStrictEqual(freePeriodEnd(d('2027-03-01')), d('2027-04-15'));
});
check('a sign-up still in their free period when the notice ends extends it to 7 days after', () => {
    const ends = d('2027-04-01');
    assert.deepStrictEqual(extendedNoticeEnd(ends, [d('2027-03-20')]), d('2027-05-10'));   // trial to 3 Apr, free month to 3 May, + 7 days
});
check('no extension for sign-ups after the notice ended, or whose free period was already over', () => {
    const ends = d('2027-04-01');
    assert.strictEqual(extendedNoticeEnd(ends, [d('2027-04-02')]), null);
    assert.strictEqual(extendedNoticeEnd(ends, [d('2027-01-01')]), null);
    assert.strictEqual(extendedNoticeEnd(ends, []), null);
});

console.log('run-off after ending (7.2, 7.5(h), 7.4)');
const ended = d('2027-08-01');
check('inactivity: a ≤12-month customer runs to term (the window check still applies)', () => {
    assert.ok(runOffAllows('inactivity', ended, 12, d('2028-06-01')));
    assert.ok(runOffAllows('inactivity', ended, 6, d('2028-01-01')));
});
check('inactivity: a longer or lifetime period earns for 3 months only', () => {
    assert.ok(runOffAllows('inactivity', ended, 24, d('2027-10-31')));
    assert.ok(!runOffAllows('inactivity', ended, 24, d('2027-11-01')));
    assert.ok(!runOffAllows('inactivity', ended, null, d('2027-11-02')));
});
check('Terms 7.4(a) (cross-border review): leaving, declining a change and closure get the same run-off as inactivity', () => {
    for (const r of ['left', 'change_declined', 'closure']) {
        assert.ok(runOffAllows(r, ended, 12, d('2028-06-01')), `${r}: ≤12-month to term`);
        assert.ok(runOffAllows(r, ended, 24, d('2027-10-31')), `${r}: longer, inside 3 months`);
        assert.ok(!runOffAllows(r, ended, 24, d('2027-11-01')), `${r}: longer, after 3 months`);
    }
});
check('7.4(b): breach, other (or no end date): nothing after the end', () => {
    for (const r of ['breach', 'other', null]) assert.ok(!runOffAllows(r, ended, 12, d('2027-08-02')), String(r));
    assert.ok(!runOffAllows('inactivity', null, 12, d('2027-08-02')));
});

console.log('wiring');
check('the ledger: suspended locks but earns nothing, ended uses the run-off, re-approval ignores old customers', () => {
    const l = read('src/utils/partner-ledger.ts');
    assert.ok(l.includes("inArray(partners.status, ['approved', 'suspended', 'ended'])"), 'lookup covers suspended + ended');
    assert.ok(l.includes("if (ref.status === 'suspended') {") && l.includes("return { recorded: false, reason: 'suspended' };"));
    assert.ok(l.includes('runOffAllows(ref.endReason, ref.endedAt, existing.durationMonths, payment.paidAt)'));
    assert.ok(l.includes("terms.subscribedAt.getTime() < ref.partnerSince.getTime()) return { recorded: false, reason: 'before_partnership' }"));
    // The suspended return must come AFTER the terms lock, so the real first payment is the one locked.
    assert.ok(l.indexOf('const terms = await lockedTermsFor(') > 0 && l.indexOf('const terms = await lockedTermsFor(') < l.indexOf("reason: 'suspended' }"));
});
check('an ended partner\'s link earns no refer-a-friend tokens (7.4)', () => {
    const l = read('src/utils/partner-ledger.ts');
    const fn = l.slice(l.indexOf('export async function isPartnerReferrer'), l.indexOf('export async function isPartnerReferrer') + 400);
    assert.ok(fn.includes("['approved', 'suspended', 'ended']"));
});
check('admin decisions set the clock, partnership start and end reason; inactivity has its own two steps', () => {
    const a = read('netlify/functions/admin-partners.ts');
    assert.ok(a.includes("? { approvedAt: now, inactivityNoticeAt: null, inactivityNoticeEnds: null, activityPauseDays: 0, activityPauseAnchor: now,"), 'any approval restarts the clock and clears an old notice');
    // Owner 2026-11-24: approval no longer sets partner_since — accepting the terms starts it (tests/partner-start.test.ts).
    assert.ok(a.includes("...(before.status !== 'suspended' ? { partnerSince: null, endedAt: null, endReason: null } : {}) }"));
    assert.ok(a.includes("rule.to === 'suspended' ? { inactivityNoticeAt: null, inactivityNoticeEnds: null }"), 'suspending clears a notice');
    assert.ok(a.includes("['closure', 'left', 'breach', 'other'].includes(String(body.endReason))"), 'inactivity cannot be chosen on a plain end');
    assert.ok(a.includes("body.action === 'inactivity_notice' || body.action === 'end_inactivity'"));
    assert.ok(read('netlify/functions/admin-partners-chat.ts').includes('NEVER end a partner for inactivity here'));
});
check('the nightly sweep runs the activity step with the registration lock', () => {
    const s = read('netlify/functions/partner-commission-sweep.ts');
    assert.ok(s.includes('sweepPartnerActivity(db, now, await isRegistrationLocked()'));
});
check('the Partner page shows the date (7.5(g)) and both notice emails exist', () => {
    assert.ok(read('netlify/functions/partner-hub.ts').includes('const a = await getPartnerActivity(db, p.id);'));
    const page = read('partner-content.html');
    assert.ok(page.includes('id="pt-activity"') && page.includes('Stay active by <strong>'));
    const emails = read('src/utils/email-templates-catalog.ts');
    const notes = read('src/utils/notification-templates-catalog.ts');
    for (const k of ['partner_inactivity_notice', 'partner_inactivity_withdrawn']) {
        assert.ok(emails.includes(`triggerKey: '${k}'`), `email ${k}`);
        assert.ok(notes.includes(`templateKey: '${k}'`), `notification ${k}`);
    }
});
check('the migration adds every column the code reads, and backfills partner_since EARLY (never cuts customers)', () => {
    const sqlText = read('db/z-partner-activity.sql');
    for (const c of ['approved_at', 'partner_since', 'ended_at', 'end_reason', 'activity_pause_days', 'activity_pause_last_day', 'activity_pause_anchor', 'inactivity_notice_at', 'inactivity_notice_ends']) {
        assert.ok(sqlText.includes(`ADD COLUMN IF NOT EXISTS ${c} `), c);
    }
    assert.ok(sqlText.includes('UPDATE partners SET partner_since = created_at'));
});
check('earned commission is never held back for a newer version (8.1): any accepted version pays; none = no contract', () => {
    const b = read('src/utils/partner-payout-batches.ts');
    assert.ok(b.includes(": !r.terms_version ? `Hasn’t accepted the Partner Terms"));
    assert.ok(!b.includes('hasAcceptedCurrentTerms('));
});

console.log('review #820 fixes');
check('End is only possible once the active date has passed AND the notice has run out', () => {
    const a = read('src/utils/partner-activity.ts');
    assert.ok(a.includes("canEnd: p.status === 'approved' && !!notice && !qualifiedSinceNotice && pastDate && now.getTime() >= notice.endsAt.getTime(),"));
    assert.ok(a.includes('sentAt.getTime() >= base.getTime() ? { sentAt, endsAt } : null'), 'a notice from before the clock base (start / reinstatement) is ignored');
});
check('a Qualifying Customer: first payment not while suspended, first commission not voided', () => {
    const a = read('src/utils/partner-activity.ts');
    // Second review of #820: a flag, not timing — a late or hand-entered first commission still counts.
    assert.ok(a.includes('AND NOT pr.locked_while_suspended'));
    assert.ok(a.includes("ORDER BY c.created_at ASC LIMIT 1), FALSE) = FALSE"));
    assert.ok(!a.includes("interval '3 days'"));
    const l = read('src/utils/partner-ledger.ts');
    assert.ok(l.includes('if (terms.subscribedAt.getTime() === payment.paidAt.getTime()) {') && l.includes('.set({ lockedWhileSuspended: true })'));
    assert.ok(read('db/z-partner-activity.sql').includes('ALTER TABLE partner_referrals ADD COLUMN IF NOT EXISTS locked_while_suspended BOOLEAN NOT NULL DEFAULT FALSE;'));
});
check('End checks the free-period extension itself, not only the nightly sweep', () => {
    const a = read('src/utils/partner-activity.ts');
    const end = a.slice(a.indexOf('export async function endForInactivity'), a.indexOf('// ── The nightly sweep'));
    assert.ok(end.includes('await extendForFreePeriods(db, partnerId,') && end.indexOf('extendForFreePeriods') < end.indexOf("SET status = 'ended'"));
});
check('the notice reports whether the EMAIL went, and the admin is warned if not (12.2)', () => {
    assert.ok(read('src/utils/partner-activity.ts').includes('return !!sent;'));
    assert.ok(read('netlify/functions/admin-partners.ts').includes('emailed: r.emailed });'));
    assert.ok(read('admin.html').includes('but the email did NOT send'));
});
// Owner decision 2026-11-23 (docs/partner-actual-costs-plan.md) replaced the "plain fixed share": commission is the rate
// AFTER COSTS — the higher of the 20% minimum or that customer's actual costs that month.
check('the Partner Assistant explains commission after actual costs (owner 2026-11-23)', () => {
    const a = read('netlify/functions/partner-assistant.ts');
    assert.ok(a.includes('Commission (Partner Terms 3.2) is commissionForNewCustomers.ratePercent of each plan payment AFTER COSTS'));
    assert.ok(a.includes("the higher of minimumCostPercent of the payment or that customer's actual costs that month"));
    assert.ok(!a.includes('costDeductionBps, 2000 = 20%'));
});

console.log('commission said plainly (3.2)');
check('25% after a 20% deduction is told as 20% of each payment; 40% after 20% as 32%', () => {
    assert.strictEqual(effectiveShareBps(2500, 2000), 2000);
    assert.strictEqual(effectiveShareBps(4000, 2000), 3200);
    assert.strictEqual(effectiveShareBps(2500, 0), 2500);
});
check('the Terms state the actual-costs rule (owner 2026-11-23) and keep the 32% cap', () => {
    const t = read('partner-terms.html');
    assert.ok(t.includes('<strong>25% of each Subscription Payment after costs</strong>'));
    assert.ok(t.includes('<strong>the higher of</strong> (a) a minimum share'));
    assert.ok(t.includes('Commission is never less than zero, you never owe us anything because of costs'));
    assert.ok(t.includes('no commission is higher than 32% of a Subscription Payment'));
});

console.log(`\n${passed} passed`);
