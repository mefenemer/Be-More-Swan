// tests/partner-disputes.test.ts
// Partner Terms 4.3: when a dispute closes in our favour, commission comes back only if no OTHER dispute on the same
// charge still threatens the money (src/utils/partner-disputes.ts, used by stripe-webhook.ts charge.dispute.closed).
//
// WHY THIS EXISTS (2026-11-23): review of #826 — the rule was only checked by matching source text; these run it.
//
// Run:  npx tsx tests/partner-disputes.test.ts

import assert from 'node:assert';
import { otherDisputeBlocksReinstate } from '../src/utils/partner-disputes';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const me = { id: 'dp_closing', status: 'warning_closed' };

check('only the closing dispute on the charge → reinstate', () => {
    assert.strictEqual(otherDisputeBlocksReinstate([me], me.id), false);
    assert.strictEqual(otherDisputeBlocksReinstate([], me.id), false);
});
check('another dispute still open blocks (every open status)', () => {
    for (const status of ['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review']) {
        assert.strictEqual(otherDisputeBlocksReinstate([me, { id: 'dp_other', status }], me.id), true, status);
    }
});
check('another dispute LOST blocks — the money was taken back', () => {
    assert.strictEqual(otherDisputeBlocksReinstate([me, { id: 'dp_other', status: 'lost' }], me.id), true);
});
check('siblings closed in our favour do not block', () => {
    assert.strictEqual(otherDisputeBlocksReinstate([me, { id: 'a', status: 'won' }, { id: 'b', status: 'warning_closed' }], me.id), false);
});
check('a PREVENTED sibling (stopped by a refund) does not block — the refund already brings commission to ~£0', () => {
    assert.strictEqual(otherDisputeBlocksReinstate([me, { id: 'dp_prev', status: 'prevented' }], me.id), false);
});
check('the closing dispute is ignored whatever its own status says', () => {
    assert.strictEqual(otherDisputeBlocksReinstate([{ id: 'dp_closing', status: 'needs_response' }], 'dp_closing'), false);
});

console.log(`\n${passed} passed`);
