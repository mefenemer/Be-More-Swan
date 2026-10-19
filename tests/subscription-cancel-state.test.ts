// tests/subscription-cancel-state.test.ts
// A plan's 'cancelling' status follows Stripe's cancel flag, both ways.
//
// WHY THIS EXISTS (2026-10-19, prod org 43). A cancellation undone in the Stripe dashboard left the
// plan 'cancelling' for good, so Admin ▸ Override Subscription refused the customer. A cancellation
// made in Stripe's own portal never marked the plan 'cancelling' at all.
//
// Run:  npx tsx tests/subscription-cancel-state.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planStatusForCancelFlag, stripeWillCancel } from '../src/utils/subscription-cancel-state';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

console.log('subscription-cancel-state');

check('undoing a cancellation in Stripe makes the plan active again', () => {
    assert.strictEqual(planStatusForCancelFlag('cancelling', { status: 'active', cancel_at_period_end: false, cancel_at: null }), 'active');
});

check('a cancellation made in Stripe marks the plan cancelling', () => {
    assert.strictEqual(planStatusForCancelFlag('active', { status: 'active', cancel_at_period_end: true }), 'cancelling');
    assert.strictEqual(planStatusForCancelFlag('active', { status: 'active', cancel_at_period_end: false, cancel_at: 1798000000 }), 'cancelling');
});

check('nothing changes when the two already agree', () => {
    assert.strictEqual(planStatusForCancelFlag('active', { status: 'active', cancel_at_period_end: false }), null);
    assert.strictEqual(planStatusForCancelFlag('cancelling', { status: 'active', cancel_at_period_end: true }), null);
});

check('other flows own their statuses: downgrading, past_due and cancelled are never touched', () => {
    for (const s of ['downgrading', 'past_due', 'cancelled', 'paused', null]) {
        assert.strictEqual(planStatusForCancelFlag(s, { status: 'active', cancel_at_period_end: false }), null, String(s));
        assert.strictEqual(planStatusForCancelFlag(s, { status: 'active', cancel_at_period_end: true }), null, String(s));
    }
});

check('a subscription Stripe no longer treats as live changes nothing', () => {
    assert.strictEqual(planStatusForCancelFlag('cancelling', { status: 'past_due', cancel_at_period_end: false }), null);
    assert.strictEqual(planStatusForCancelFlag('cancelling', { status: 'canceled', cancel_at_period_end: false }), null);
    assert.strictEqual(planStatusForCancelFlag('cancelling', { status: 'trialing', cancel_at_period_end: false }), 'active');
});

check('stripeWillCancel reads either flag', () => {
    assert.strictEqual(stripeWillCancel({ status: 'active' }), false);
    assert.strictEqual(stripeWillCancel({ status: 'active', cancel_at_period_end: true }), true);
    assert.strictEqual(stripeWillCancel({ status: 'active', cancel_at: 0 }), false);
});

check('the webhook applies it to THIS subscription, guarded on the status it read', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../netlify/functions/stripe-webhook.ts'), 'utf8');
    const at = src.indexOf("stripeEvent.type === 'customer.subscription.updated'");
    const block = src.slice(at, at + 2500);
    assert.ok(block.includes('planStatusForCancelFlag(cancelRow?.status, sub'));
    assert.ok(block.includes('eq(plans.stripeSubscriptionId, sub.id)'));
    assert.ok(block.includes('eq(plans.status, cancelRow.status)'), 'the update must not overwrite a status changed in between');
    // It runs before (and regardless of) the masterPlanId branch, which needs plan metadata.
    assert.ok(block.indexOf('planStatusForCancelFlag') < block.indexOf('_resolveUserIdFromSub(sub)'));
});

console.log(`\n${passed} passed`);
