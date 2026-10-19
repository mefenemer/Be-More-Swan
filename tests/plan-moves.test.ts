// tests/plan-moves.test.ts
// Admin → Revenue → Plan moves, and the shared scheduler behind every plan change at renewal.
//
// WHY THIS EXISTS (owner, 2026-10-19). Moving customers between plans in bulk changes what real
// people pay. What can go wrong without anything failing:
//
//   · a coupon falls off at renewal — the downgrade used to rebuild schedule phases WITHOUT the
//     subscription's discounts, and Stripe does not keep a subscription-level coupon for a phase
//     that omits them
//   · a price rise starts with less than the 30 days' notice the Terms promise
//   · a customer is told the list price while a coupon will still apply, or told a discount
//     carries on when it ends first
//   · free beta/trial, cancelling or overdue customers get moved
//   · the webhook stops finishing a move, or a customer's own plan change leaves a stale move
//
// Run:  npx tsx tests/plan-moves.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    addIntervals, earliestStart, keepDiscounts, moveDirection, periodsBeforeChange, schedulePlanChange,
    PRICE_RISE_NOTICE_DAYS,
} from '../src/utils/plan-change-schedule';
import { discountLine, skipReason, targetAmountPence, priceLabel, type MoveFacts } from '../src/utils/plan-moves';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const DAY = 86_400_000;
const NOW = new Date('2026-10-19T12:00:00Z');

(async () => {
    console.log('plan-moves');

    await check('direction compares what they pay now with the new price', () => {
        assert.strictEqual(moveDirection(7900, 6900), 'down');
        assert.strictEqual(moveDirection(2900, 6900), 'up');
        assert.strictEqual(moveDirection(6900, 6900), 'same');
    });

    await check('a price rise waits 30 days; anything else can start at the next renewal', () => {
        assert.strictEqual(PRICE_RISE_NOTICE_DAYS, 30);
        assert.strictEqual(earliestStart('up', NOW).getTime(), NOW.getTime() + 30 * DAY);
        assert.strictEqual(earliestStart('down', NOW).getTime(), NOW.getTime());
        assert.strictEqual(earliestStart('same', NOW).getTime(), NOW.getTime());
    });

    await check('a rise whose renewal is 7 days away moves to the renewal after; a cut does not', () => {
        const periodEnd = new Date(NOW.getTime() + 7 * DAY);
        assert.strictEqual(periodsBeforeChange(periodEnd, 'month', earliestStart('up', NOW)), 2);
        assert.strictEqual(periodsBeforeChange(periodEnd, 'month', earliestStart('down', NOW)), 1);
        // An annual renewal 7 days away + a rise → next year's renewal.
        assert.strictEqual(periodsBeforeChange(periodEnd, 'year', earliestStart('up', NOW)), 2);
        // An annual renewal 90 days away already gives the notice.
        assert.strictEqual(periodsBeforeChange(new Date(NOW.getTime() + 90 * DAY), 'year', earliestStart('up', NOW)), 1);
    });

    await check('month arithmetic clamps to the end of a short month', () => {
        assert.strictEqual(addIntervals(new Date('2027-01-31T10:00:00Z'), 'month', 1).toISOString(), '2027-02-28T10:00:00.000Z');
        assert.strictEqual(addIntervals(new Date('2026-10-26T17:43:56Z'), 'month', 2).toISOString(), '2026-12-26T17:43:56.000Z');
    });

    await check('discounts are kept by id, whatever shape Stripe returns them in', () => {
        assert.deepStrictEqual(keepDiscounts([
            { discount: 'di_1' }, { discount: { id: 'di_2' } }, { coupon: 'co_1' }, { promotion_code: { id: 'promo_1' } }, {},
        ]), [{ discount: 'di_1' }, { discount: 'di_2' }, { coupon: 'co_1' }, { promotion_code: 'promo_1' }]);
        assert.deepStrictEqual(keepDiscounts(null), []);
    });

    const base: MoveFacts = { planType: 'subscription', planStatus: 'active', stripeSubscriptionId: 'sub_1', hasScheduledMove: false, sameTier: false, samePrice: false, stripeStatus: 'active' };
    await check('only active, paying, unscheduled customers can move', () => {
        assert.strictEqual(skipReason(base), null);
        assert.match(skipReason({ ...base, planType: 'beta' })!, /free beta or trial/);
        assert.match(skipReason({ ...base, planType: 'trial' })!, /free beta or trial/);
        assert.match(skipReason({ ...base, stripeSubscriptionId: null })!, /Override Subscription/);
        assert.match(skipReason({ ...base, hasScheduledMove: true })!, /already scheduled/);
        assert.match(skipReason({ ...base, planStatus: 'downgrading' })!, /own downgrade/);
        assert.match(skipReason({ ...base, cancelAtPeriodEnd: true })!, /cancel/);
        assert.match(skipReason({ ...base, planStatus: 'past_due' })!, /overdue/);
        assert.match(skipReason({ ...base, stripeHasSchedule: true })!, /Stripe already has/);
    });

    await check('the same plan at an old price CAN move (the £79 → £69 case); at its current price it cannot', () => {
        assert.strictEqual(skipReason({ ...base, sameTier: true, samePrice: false }), null);
        assert.match(skipReason({ ...base, sameTier: true, samePrice: true })!, /Already on that plan/);
    });

    await check('the new price follows the customer\'s interval (annual = the checkout sum)', () => {
        assert.strictEqual(targetAmountPence('69.00', 'month'), 6900);
        assert.strictEqual(targetAmountPence('69.00', 'year'), 66000); // round(69 × 0.8) = 55, × 12
        assert.strictEqual(priceLabel(66000, 'year'), '£660 a year');
        assert.strictEqual(priceLabel(4830, 'month'), '£48.30 a month');
    });

    const effective = new Date('2026-11-26T00:00:00Z');
    const voucher = (over: Record<string, unknown> = {}) => ({
        codes: ['VITALROOTS12'], name: '12 Month Free Coupon', label: '100% off', discountAmount: 69, grossAmount: 69,
        netAmount: 0, percentCovered: 100, duration: 'repeating', durationInMonths: 12, endsAt: '2027-10-19T00:00:00Z', currency: 'gbp', ...over,
    }) as any;
    await check('the coupon sentence tells the customer what they will actually pay', () => {
        assert.match(discountLine({ discount: null, appliesToNewPlan: true, effectiveAt: effective, interval: 'month', newPlanName: 'X' }), /no discount/);
        const carries = discountLine({ discount: voucher(), appliesToNewPlan: true, effectiveAt: effective, interval: 'month', newPlanName: 'X' });
        assert.match(carries, /VITALROOTS12 discount \(100% off\) carries on until 19 October 2027, so you will pay £0 a month/);
        const ends = discountLine({ discount: voucher({ endsAt: '2026-11-01T00:00:00Z' }), appliesToNewPlan: true, effectiveAt: effective, interval: 'month', newPlanName: 'X' });
        assert.match(ends, /ends on 1 November 2026, before the new plan starts, so you will pay the full price/);
        const notHere = discountLine({ discount: voucher(), appliesToNewPlan: false, effectiveAt: effective, interval: 'month', newPlanName: 'The Busywork Buster' });
        assert.match(notHere, /does not apply to The Busywork Buster/);
    });

    // ── The scheduler against a fake Stripe ─────────────────────────────────────────────────────
    function fakeStripe(opts: { subSchedule?: string | null; failUpdate?: boolean; phase0Discounts?: any[]; interval?: 'month' | 'year' } = {}) {
        const calls: any = { released: [] as string[], updates: [] as any[] };
        const start = Math.floor(new Date('2026-09-26T17:43:56Z').getTime() / 1000);
        const end = Math.floor(new Date('2026-10-26T17:43:56Z').getTime() / 1000);
        const stripe: any = {
            subscriptions: { retrieve: async () => ({
                id: 'sub_1', schedule: opts.subSchedule ?? null,
                items: { data: [{ quantity: 1, price: { id: 'price_old', recurring: { interval: opts.interval ?? 'month' } } }] },
            }) },
            prices: { list: async () => ({ data: [{ id: 'price_new' }] }), create: async () => ({ id: 'price_new' }) },
            subscriptionSchedules: {
                release: async (id: string) => { calls.released.push(id); },
                create: async () => ({ id: 'sched_1', phases: [{ start_date: start, end_date: end, items: [{ price: 'price_old', quantity: 1 }], discounts: opts.phase0Discounts ?? [{ discount: 'di_coupon' }] }] }),
                update: async (_id: string, params: any) => {
                    calls.updates.push(params);
                    if (opts.failUpdate) throw new Error('stripe said no');
                    const p0 = params.phases[0];
                    const endUnix = p0.end_date ?? Math.floor(addIntervals(new Date(start * 1000), 'month', p0.duration.interval_count).getTime() / 1000);
                    return { phases: [{ end_date: endUnix }, { start_date: endUnix }] };
                },
            },
        };
        return { stripe, calls };
    }
    const target = { tierKey: 'buster', name: 'The Busywork Buster', monthlyPriceGbp: '69.00', stripeProductId: 'prod_b' };

    await check('the scheduler puts the coupon on BOTH phases and the move id on the new one', async () => {
        const { stripe, calls } = fakeStripe();
        const r = await schedulePlanChange(stripe, { subscriptionId: 'sub_1', target, notBefore: new Date('2026-10-19T00:00:00Z'), phaseMetadata: { masterPlanId: '2', planMoveId: '7' } });
        const p = calls.updates[0].phases;
        assert.deepStrictEqual(p[0].discounts, [{ discount: 'di_coupon' }]);
        assert.deepStrictEqual(p[1].discounts, [{ discount: 'di_coupon' }]);
        assert.strictEqual(p[1].items[0].price, 'price_new');
        assert.strictEqual(p[1].proration_behavior, 'none');
        assert.strictEqual(p[1].metadata.planMoveId, '7');
        assert.ok(p[0].end_date && !p[0].duration, 'next renewal = the current period end exactly');
        assert.strictEqual(r.effectiveAt.toISOString(), '2026-10-26T17:43:56.000Z');
    });

    await check('a price rise with a renewal 7 days out runs the old price one more period', async () => {
        const { stripe, calls } = fakeStripe();
        const r = await schedulePlanChange(stripe, { subscriptionId: 'sub_1', target, notBefore: new Date('2026-11-18T12:00:00Z'), phaseMetadata: {} });
        assert.deepStrictEqual(calls.updates[0].phases[0].duration, { interval: 'month', interval_count: 2 });
        assert.strictEqual(r.effectiveAt.toISOString(), '2026-11-26T17:43:56.000Z');
    });

    await check('no coupon → no discounts param (nothing invented); an old schedule is released first', async () => {
        const { stripe, calls } = fakeStripe({ phase0Discounts: [], subSchedule: 'sched_old' });
        await schedulePlanChange(stripe, { subscriptionId: 'sub_1', target, notBefore: new Date('2026-10-19T00:00:00Z'), phaseMetadata: {} });
        assert.ok(!('discounts' in calls.updates[0].phases[0]) && !('discounts' in calls.updates[0].phases[1]));
        assert.deepStrictEqual(calls.released, ['sched_old']);
    });

    await check('if Stripe refuses the update, the new schedule is released — the subscription is left as it was', async () => {
        const { stripe, calls } = fakeStripe({ failUpdate: true });
        await assert.rejects(schedulePlanChange(stripe, { subscriptionId: 'sub_1', target, notBefore: NOW, phaseMetadata: {} }), /stripe said no/);
        assert.deepStrictEqual(calls.released, ['sched_1']);
    });

    // ── Wiring ─────────────────────────────────────────────────────────────────────────────────
    await check('the customer\'s own downgrade uses the shared scheduler (no hand-built phases left)', () => {
        const src = read('netlify/functions/billing-downgrade.ts');
        assert.ok(src.includes('schedulePlanChange(stripe, {'));
        assert.ok(!src.includes('subscriptionSchedules.create('), 'billing-downgrade builds its own schedule again');
        assert.ok(src.includes('cancelMovesForCustomerChange(db, user.organisationId)'));
    });

    await check('an upgrade releases a schedule and cancels a pending move', () => {
        const src = read('netlify/functions/billing-upgrade.ts');
        assert.ok(src.includes('subscriptionSchedules.release(sub.schedule)') && src.includes('cancelMovesForCustomerChange(db, user.organisationId)'));
    });

    await check('the webhook finishes a move BEFORE enforcing the assistant limit', () => {
        const src = read('netlify/functions/stripe-webhook.ts');
        const finish = src.indexOf('finishPlanMove(db, sub');
        const limit = src.indexOf('resolveAssistantLimit(db, userId, uo.organisationId)');
        assert.ok(finish > 0 && limit > 0 && finish < limit);
    });

    await check('the admin screen is behind Override Subscription and the API is live-only', () => {
        assert.ok(/view: 'plan-moves',.*perm: 'override_subscription'/.test(read('admin.html')));
        const api = read('netlify/functions/admin-plan-moves.ts');
        assert.ok(api.includes("requirePermission(admin?.role, 'override_subscription')"));
        assert.ok(api.includes('not available in Sandbox mode'));
        assert.ok(api.includes("body.confirm !== true"));
    });

    await check('both emails quote no typed price — every value comes from the move', () => {
        for (const key of ['plan_move_scheduled', 'plan_move_cancelled']) {
            const t = getTemplateDefault(key);
            assert.ok(t, key);
            assert.ok(!/£\s?\d/.test(t!.bodyHtml + t!.subject), `${key} has a typed price`);
        }
        const s = getTemplateDefault('plan_move_scheduled')!.bodyHtml;
        for (const v of ['plan_move.new_price', 'plan_move.starts_on', 'plan_move.discount_line', 'plan_move.price_change_line']) assert.ok(s.includes(v), v);
    });

    console.log(`\n${passed} passed`);
})().catch(() => process.exit(1));
