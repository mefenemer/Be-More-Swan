// tests/partner-ledger-reconcile.test.ts
// Refunds, disputes and won disputes all follow ONE rule (src/utils/partner-ledger.ts planReconcile): everything
// recorded for a payment — its invoice row (unless voided) plus every adjustment and payment-linked bonus — adds up to
// what the payment earns now.
//
// WHY THIS EXISTS (2026-11-23): the review of #824 found two wrong-amount paths in the old row-by-row logic once a
// payout run had been exported and then cancelled. This replays those sequences (and more) through the real planner
// with a small in-memory ledger that applies plans the way applyPlan does, and checks the TOTAL each time.
//
// Run:  npx tsx tests/partner-ledger-reconcile.test.ts

import assert from 'node:assert';
import { deriveReconcileState, planReconcile, DISPUTE_REASON, type ReconcileEvent, type ReconcileState } from '../src/utils/partner-ledger';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const WON_NOTE = 'Dispute closed in our favour — commission returned';
type Run = null | 'draft' | 'exported' | 'paid';
class Payment {
    status: 'pending' | 'payable' | 'paid' | 'voided' = 'payable';
    commission: number;
    voidReason: string | null = null;
    run: Run = null;
    linked: Array<{ pence: number; note: string; status: string }> = [];
    constructor(commission: number) { this.commission = commission; }
    state(): ReconcileState {
        // The SAME derivation production uses (deriveReconcileState), so this can't drift from stateFor.
        const inExportedOrPaid = this.status === 'paid' || this.run === 'exported' || this.run === 'paid';
        return deriveReconcileState(
            { status: this.status, commissionPence: this.commission, voidReason: this.voidReason, payoutBatchId: this.run ? 1 : null },
            this.linked.map((a) => ({ status: a.status, commissionPence: a.pence, note: a.note })),
            inExportedOrPaid);
    }
    apply(ev: ReconcileEvent): void {
        const plan = planReconcile(this.state(), ev);
        if (plan.row?.void) { this.status = 'voided'; this.voidReason = plan.row.reason; this.run = null; }
        else if (plan.row) { if (this.status === 'voided') this.status = 'payable'; this.commission = plan.row.amount; this.voidReason = null; }
        if (plan.extra) this.linked.push({ pence: plan.extra.pence, note: plan.extra.note, status: 'payable' });
        if (plan.closeDispute) this.linked.push({ pence: 0, note: WON_NOTE, status: 'payable' });
    }
    total(): number { return (this.status === 'voided' ? 0 : this.commission) + this.linked.filter((a) => a.status !== 'voided').reduce((s, a) => s + a.pence, 0); }
    refund(desired: number) { this.apply({ kind: 'refund', desired, reason: desired === 0 ? 'Payment refunded' : 'Payment partly refunded' }); }
    dispute() { this.apply({ kind: 'dispute', desired: 0, reason: DISPUTE_REASON }); }
    won(desired: number) { this.apply({ kind: 'dispute_won', desired }); }
    exportRun() { this.run = 'exported'; }
    cancelRun() { this.run = null; }
    markPaid() { this.status = 'paid'; this.run = 'paid'; }
}

const C = 1380; // £13.80 commission on a £69 payment

console.log('simple paths');
check('unpaid: partial refund → dispute → won after the partial refund', () => {
    const p = new Payment(C);
    p.refund(690); assert.strictEqual(p.total(), 690);
    p.dispute(); assert.strictEqual(p.total(), 0);
    p.won(690); assert.strictEqual(p.total(), 690);
});
check('paid: dispute → won → a later full refund still applies (the dispute is closed)', () => {
    const p = new Payment(C); p.markPaid();
    p.dispute(); assert.strictEqual(p.total(), 0);
    p.won(C); assert.strictEqual(p.total(), C);
    p.refund(0); assert.strictEqual(p.total(), 0);
});
check('paid: won after a partial refund made during the dispute closes it at the refunded amount', () => {
    const p = new Payment(C); p.markPaid();
    p.dispute(); p.won(500); assert.strictEqual(p.total(), 500);
    p.refund(200); assert.strictEqual(p.total(), 200, 'dispute counted as closed, so the refund acts');
});
check('a refund while a dispute is open changes nothing (the won dispute applies it)', () => {
    const p = new Payment(C);
    p.dispute(); p.refund(500); assert.strictEqual(p.total(), 0);
    p.won(500); assert.strictEqual(p.total(), 500);
});
check('redelivered events land on the same total (idempotent)', () => {
    const p = new Payment(C);
    p.refund(700); p.refund(700); assert.strictEqual(p.total(), 700);
    p.dispute(); p.dispute(); assert.strictEqual(p.total(), 0);
    p.won(700); p.won(700); assert.strictEqual(p.total(), 700);
});
check("an admin's own cancellation (fraud) is never undone by Stripe events", () => {
    const p = new Payment(C); p.status = 'voided'; p.voidReason = 'Self-referral';
    p.refund(500); p.dispute(); p.won(C); assert.strictEqual(p.total(), 0);
});

console.log('the review of #824 sequences (exported run, then cancelled)');
check('#1: exported → dispute → run cancelled → won → partial refund — no overpay', () => {
    const p = new Payment(C); p.exportRun();
    p.dispute(); assert.strictEqual(p.total(), 0);
    p.cancelRun();
    p.won(C); assert.strictEqual(p.total(), C);
    p.refund(500); assert.strictEqual(p.total(), 500);
});
check('#2: exported → partial refund → run cancelled → dispute → won — partner keeps the unrefunded share', () => {
    const p = new Payment(C); p.exportRun();
    p.refund(900); assert.strictEqual(p.total(), 900);
    p.cancelRun();
    p.dispute(); assert.strictEqual(p.total(), 0);
    p.won(900); assert.strictEqual(p.total(), 900);
});
check('original #823 note: exported → refund → run cancelled → second refund — no double clawback', () => {
    const p = new Payment(C); p.exportRun();
    p.refund(1000); assert.strictEqual(p.total(), 1000);
    p.cancelRun();
    p.refund(600); assert.strictEqual(p.total(), 600);
    p.refund(0); assert.strictEqual(p.total(), 0);
});
check('exported → full refund → run cancelled → paid later: nothing paid twice', () => {
    const p = new Payment(C); p.exportRun();
    p.refund(0); assert.strictEqual(p.total(), 0);
    p.cancelRun(); assert.strictEqual(p.total(), 0);
});
check('draft run: refund edits the row in place and it leaves the run when voided', () => {
    const p = new Payment(C); p.run = 'draft';
    p.refund(400); assert.strictEqual(p.total(), 400); assert.strictEqual(p.run, 'draft');
    p.refund(0); assert.strictEqual(p.total(), 0); assert.strictEqual(p.run, null);
});

console.log('second review of #824');
check('an adjustment an admin cancelled no longer counts: goodwill-cancelled clawback + won dispute pays once', () => {
    const p = new Payment(C); p.markPaid();
    p.dispute(); assert.strictEqual(p.total(), 0);
    p.linked[0].status = 'voided';               // admin cancels the clawback as goodwill → partner keeps C
    assert.strictEqual(p.total(), C);
    p.won(C); assert.strictEqual(p.total(), C, 'no second +C');
});
check('the unexpected negative won branch still closes the dispute, so later refunds act', () => {
    const plan = planReconcile({ rowStatus: 'paid', rowCommission: C, rowVoidReason: null, rowEditable: false, others: 500 - C + 900, disputeAdjustmentsOpen: true }, { kind: 'dispute_won', desired: 500 });
    assert.ok(plan.extra && plan.extra.pence < 0 && plan.closeDispute === true);
});

check('a closure row written with the OLD "Dispute won" wording still closes the dispute', () => {
    const p = new Payment(C); p.markPaid();
    p.dispute();
    p.linked.push({ pence: C, note: 'Dispute won — commission returned', status: 'payable' });
    assert.strictEqual(p.total(), C);
    assert.strictEqual(p.state().disputeAdjustmentsOpen, false);
    p.refund(500); assert.strictEqual(p.total(), 500, 'closed, so the refund acts');
});

console.log(`\n${passed} passed`);
