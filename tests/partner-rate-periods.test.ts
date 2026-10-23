// tests/partner-rate-periods.test.ts
// Affiliate Partner Programme — dated commission rates (docs/affiliate-partner-programme-plan.md).
//
// WHY THIS EXISTS (2026-10-18): the owner chose dated rate periods — a partner's new subscriber gets
// the rate of the period they FIRST PAY in, kept for their whole window. That promise only holds if
// a started period can never be re-priced, the programme always has a rate, and the boundaries are
// exact. Also pins the step-1 migration: it must not alter user_referrals (adding a column there
// would break every existing read of that table until the SQL is applied — see the plan §4.1).
//
// Run:  npx tsx tests/partner-rate-periods.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    partnerCommissions, partnerLinkStats, partnerPayoutBatches, partnerProgrammeSettings,
    partnerRatePeriods, partnerReferrals, partners,
} from '../db/schema';
import {
    addMonthsUtc, commissionPence, isWithinCommissionWindow, lockTerms, resolvePeriodAt,
    validatePeriodChanges, type RatePeriod,
} from '../src/utils/partner-rate-periods';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const d = (s: string) => new Date(`${s}T00:00:00Z`);

const LAUNCH: RatePeriod = { id: 1, partnerId: null, rateBps: 2500, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-10-18'), endsAt: null };

console.log('resolving the rate');

check('programme rate applies when the partner has no period of their own', () => {
    assert.strictEqual(resolvePeriodAt([LAUNCH], 7, d('2026-11-01'))?.id, 1);
});

check("a partner's own period beats the programme period", () => {
    const vip: RatePeriod = { id: 2, partnerId: 7, rateBps: 3000, costDeductionBps: 0, durationMonths: null, startsAt: d('2026-11-01'), endsAt: d('2026-12-01') };
    assert.strictEqual(resolvePeriodAt([LAUNCH, vip], 7, d('2026-11-15'))?.id, 2);
    assert.strictEqual(resolvePeriodAt([LAUNCH, vip], 8, d('2026-11-15'))?.id, 1, 'other partners keep the programme rate');
    assert.strictEqual(resolvePeriodAt([LAUNCH, vip], 7, d('2026-12-05'))?.id, 1, 'falls back once the partner period ends');
});

check('start is inclusive, end is exclusive', () => {
    const a: RatePeriod = { ...LAUNCH, id: 1, endsAt: d('2026-12-01') };
    const b: RatePeriod = { ...LAUNCH, id: 2, rateBps: 2000, startsAt: d('2026-12-01') };
    assert.strictEqual(resolvePeriodAt([a, b], 7, d('2026-12-01'))?.id, 2, 'the boundary instant belongs to the new period');
    assert.strictEqual(resolvePeriodAt([a, b], 7, new Date(d('2026-12-01').getTime() - 1))?.id, 1);
    assert.strictEqual(resolvePeriodAt([a, b], 7, d('2026-10-17')), null, 'before the programme starts, no rate');
});

check('a trial started in one period and paid in the next gets the NEXT rate (rate fixed at first payment)', () => {
    const a: RatePeriod = { ...LAUNCH, id: 1, endsAt: d('2026-12-01') };
    const b: RatePeriod = { ...LAUNCH, id: 2, rateBps: 2000, costDeductionBps: 2000, startsAt: d('2026-12-01') };
    const firstPaidAt = d('2026-12-10');          // trial began 2026-11-26
    assert.deepStrictEqual(lockTerms(resolvePeriodAt([a, b], 7, firstPaidAt)!), { ratePeriodId: 2, rateBps: 2000, costDeductionBps: 2000, durationMonths: 12 });
});

console.log('commission window and amount');

check('12-month window: month 12 pays, month 13 does not', () => {
    const sub = d('2026-11-05');
    assert.ok(isWithinCommissionWindow(sub, 12, d('2027-10-05')));
    assert.ok(!isWithinCommissionWindow(sub, 12, d('2027-11-05')));
    assert.ok(!isWithinCommissionWindow(sub, 12, d('2026-11-04')), 'nothing before subscribing');
});

check('lifetime (null) never runs out', () => {
    assert.ok(isWithinCommissionWindow(d('2026-11-05'), null, d('2040-01-01')));
});

check('month arithmetic clamps to the last day of the month', () => {
    assert.strictEqual(addMonthsUtc(d('2027-01-31'), 1).toISOString().slice(0, 10), '2027-02-28');
    assert.strictEqual(addMonthsUtc(d('2028-01-31'), 1).toISOString().slice(0, 10), '2028-02-29');
    assert.strictEqual(addMonthsUtc(d('2026-11-30'), 3).toISOString().slice(0, 10), '2027-02-28');
});

check('commission rounds down to the penny and is never negative', () => {
    assert.strictEqual(commissionPence(2900, 2500), 725);
    assert.strictEqual(commissionPence(2417, 2500), 604);   // 604.25 → 604
    assert.strictEqual(commissionPence(0, 2500), 0);
    assert.strictEqual(commissionPence(-500, 2500), 0);
});

check('commission is after costs: the deduction comes off first, then the rate (Partner Terms 3.2)', () => {
    assert.strictEqual(commissionPence(7900, 5000, 2000), 3160);   // £79, 20% costs, 50% → £31.60
    assert.strictEqual(commissionPence(7900, 2500, 2000), 1580);   // the Terms' worked example → £15.80
    assert.strictEqual(commissionPence(2417, 2500, 2000), 483);    // 483.4 → 483, one rounding
    assert.strictEqual(commissionPence(7900, 2500, 0), commissionPence(7900, 2500));   // locked before costs existed
    assert.strictEqual(commissionPence(7900, 2500, 10000), 0);
});

console.log('changing rates');
const NOW = d('2026-11-20');

check('end the current rate and start a new one at the same moment — allowed as one edit', () => {
    const errors = validatePeriodChanges([LAUNCH], [
        { op: 'update', id: 1, period: { ...LAUNCH, endsAt: d('2026-12-01') } },
        { op: 'create', period: { partnerId: null, rateBps: 2000, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-12-01'), endsAt: null } },
    ], NOW);
    assert.deepStrictEqual(errors, []);
});

check('ending the programme rate on its own is refused (no rate would apply afterwards)', () => {
    const errors = validatePeriodChanges([LAUNCH], [{ op: 'update', id: 1, period: { ...LAUNCH, endsAt: d('2026-12-01') } }], NOW);
    assert.match(errors.join(' '), /no end date/);
});

check('a gap between programme rates is refused', () => {
    const errors = validatePeriodChanges([LAUNCH], [
        { op: 'update', id: 1, period: { ...LAUNCH, endsAt: d('2026-12-01') } },
        { op: 'create', period: { partnerId: null, rateBps: 2000, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-12-02'), endsAt: null } },
    ], NOW);
    assert.match(errors.join(' '), /no gap/);
});

check('overlapping periods in the same scope are refused', () => {
    const vip: RatePeriod = { id: 2, partnerId: 7, rateBps: 3000, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-12-01'), endsAt: d('2027-01-01') };
    const errors = validatePeriodChanges([LAUNCH, vip], [
        { op: 'create', period: { partnerId: 7, rateBps: 3500, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-12-15'), endsAt: null } },
    ], NOW);
    assert.match(errors.join(' '), /overlap/);
});

check('a partner period may sit on top of the programme rate, and partner periods may have gaps', () => {
    const errors = validatePeriodChanges([LAUNCH], [
        { op: 'create', period: { partnerId: 7, rateBps: 3000, costDeductionBps: 0, durationMonths: null, startsAt: d('2026-12-01'), endsAt: d('2027-01-01') } },
        { op: 'create', period: { partnerId: 7, rateBps: 3000, costDeductionBps: 0, durationMonths: null, startsAt: d('2027-03-01'), endsAt: d('2027-04-01') } },
    ], NOW);
    assert.deepStrictEqual(errors, []);
});

check('a started period cannot be re-priced, re-lengthened or re-dated', () => {
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'update', id: 1, period: { ...LAUNCH, rateBps: 2000 } }], NOW).join(' '), /fixed/);
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'update', id: 1, period: { ...LAUNCH, durationMonths: null } }], NOW).join(' '), /fixed/);
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'update', id: 1, period: { ...LAUNCH, startsAt: d('2026-10-01') } }], NOW).join(' '), /start date is fixed/);
});

check('a started period cannot be deleted', () => {
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'delete', id: 1 }], NOW).join(' '), /cannot be deleted/);
});

check('an end date cannot be set in the past', () => {
    const errors = validatePeriodChanges([LAUNCH], [
        { op: 'update', id: 1, period: { ...LAUNCH, endsAt: d('2026-11-01') } },
        { op: 'create', period: { partnerId: null, rateBps: 2000, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-11-01'), endsAt: null } },
    ], NOW);
    assert.match(errors.join(' '), /end date cannot be in the past/);
    assert.match(errors.join(' '), /cannot start in the past/);
});

check('an upcoming period can be edited freely and deleted', () => {
    const current: RatePeriod = { ...LAUNCH, endsAt: d('2026-12-01') };
    const upcoming: RatePeriod = { id: 2, partnerId: null, rateBps: 2000, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-12-01'), endsAt: null };
    assert.deepStrictEqual(validatePeriodChanges([current, upcoming], [
        { op: 'update', id: 2, period: { ...upcoming, rateBps: 3000, durationMonths: 6 } },
    ], NOW), []);
    assert.deepStrictEqual(validatePeriodChanges([current, upcoming], [
        { op: 'delete', id: 2 },
        { op: 'update', id: 1, period: { ...current, endsAt: null } },
    ], NOW), []);
});

check('bad shapes are refused in plain words', () => {
    const base = { partnerId: 7, costDeductionBps: 0, durationMonths: 12, startsAt: d('2026-12-01'), endsAt: null };
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'create', period: { ...base, rateBps: 12000 } }], NOW).join(' '), /0% and 100%/);
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'create', period: { ...base, rateBps: 2500, durationMonths: 0 } }], NOW).join(' '), /months/);
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'create', period: { ...base, rateBps: 2500, endsAt: d('2026-11-30') } }], NOW).join(' '), /after the start/);
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'create', period: { ...base, rateBps: 2500, costDeductionBps: 10000 } }], NOW).join(' '), /cost deduction/);
    assert.match(validatePeriodChanges([LAUNCH], [{ op: 'create', period: { ...base, rateBps: 2500, costDeductionBps: -1 } }], NOW).join(' '), /cost deduction/);
});

check('a started period cannot have its cost deduction changed (it is promised with the rate)', () => {
    const errors = validatePeriodChanges([LAUNCH], [{ op: 'update', id: 1, period: { ...LAUNCH, costDeductionBps: 3000 } }], NOW);
    assert.match(errors.join(' '), /cost deduction and length are fixed/);
});

console.log('step-1 migration and schema');
const sqlFile = readFileSync(join(root, 'db/z-affiliate-partners.sql'), 'utf8');

check('the migration never alters user_referrals (existing reads must not break while it is pending)', () => {
    assert.ok(!/ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?user_referrals/i.test(sqlFile));
});

check('a retried Stripe webhook cannot write a second commission for the same invoice', () => {
    assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS partner_commissions_invoice_uq\s+ON partner_commissions \(stripe_invoice_id\) WHERE kind = 'invoice'/.test(sqlFile));
});

check('money is integer pence and rates are basis points — no numeric columns', () => {
    assert.ok(!/^\s+\w+\s+(NUMERIC|DECIMAL|REAL)\b/im.test(sqlFile));
});

check('the launch default is seeded only on a fresh table', () => {
    assert.ok(/SELECT NULL, 2500, 12,.*\n\s*WHERE NOT EXISTS \(SELECT 1 FROM partner_rate_periods WHERE partner_id IS NULL\)/.test(sqlFile));
});

check('deleting a user keeps the partner and its ledger', () => {
    assert.ok(/user_id\s+INTEGER UNIQUE REFERENCES users\(id\) ON DELETE SET NULL/.test(sqlFile));
});

check('every table in the migration has a Drizzle mirror', () => {
    for (const t of [partnerProgrammeSettings, partners, partnerRatePeriods, partnerReferrals, partnerPayoutBatches, partnerCommissions, partnerLinkStats]) {
        assert.ok(t);
    }
    for (const name of ['partner_programme_settings', 'partners', 'partner_rate_periods', 'partner_referrals', 'partner_payout_batches', 'partner_commissions', 'partner_link_stats']) {
        assert.ok(sqlFile.includes(`CREATE TABLE IF NOT EXISTS ${name} (`), `${name} missing from the SQL`);
    }
});

console.log('cost-deduction migration');
const costSql = readFileSync(join(root, 'db/z-affiliate-partner-cost-deduction.sql'), 'utf8');

check('existing commissions and locked customers keep 0% — only an unlocked programme period takes 20%', () => {
    assert.ok(/ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS cost_deduction_bps INTEGER NOT NULL DEFAULT 0;/.test(costSql));
    assert.ok(/UPDATE partner_referrals SET cost_deduction_bps = 0 WHERE subscribed_at IS NOT NULL AND cost_deduction_bps IS NULL;/.test(costSql));
    assert.ok(/SET cost_deduction_bps = 2000[\s\S]*WHERE rp\.partner_id IS NULL[\s\S]*NOT EXISTS \(SELECT 1 FROM partner_referrals pr WHERE pr\.rate_period_id = rp\.id AND pr\.subscribed_at IS NOT NULL\)/.test(costSql));
});

check('the Partner Terms state the same worked example the code computes', () => {
    const terms = readFileSync(join(root, 'partner-terms.html'), 'utf8');
    assert.ok(terms.includes('Commission is worked out after costs.'));
    assert.ok(terms.includes('The cost deduction is currently 20%.'));
    assert.ok(terms.includes('at a 25% rate you earn £15.80'));
    assert.strictEqual(commissionPence(7900, 2500, 2000), 1580);
});

console.log(`\n${passed} passed`);
