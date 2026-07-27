// tests/plan-limit-coercion.test.ts
// plans.featureOverrides is jsonb, so its declared TypeScript shape is a description of intent, not
// a runtime guarantee. effectiveLimit used to assert that shape (`as number | null`) rather than
// check it, and a string limit went straight into atomicCapCheck's SQL — where it is bound as a
// parameter and compared against an integer column:
//
//     AND task_count + $increment <= $limit
//
// Postgres rejects `integer <= text`, so the cap check does not deny the request, it FAILS THE
// QUERY. Every caller that spends a task credit then surfaces a raw
// "Failed query: UPDATE usage_counters SET task_count = task_count + $1 ..." to the user —
// chat-orchestrator's "Talk it through in chat" among them.
//
// Run:  npx tsx tests/plan-limit-coercion.test.ts

import assert from 'node:assert';
import { effectiveLimit, type FeatureOverrides } from '../src/utils/plan-features';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

console.log('\nplan limit coercion\n');

check('a numeric override is returned as-is', () => {
    assert.strictEqual(effectiveLimit({ monthlyTaskLimit: 500 }, 'monthlyTaskLimit', 100), 500);
});

check('no override falls back to the live master limit', () => {
    assert.strictEqual(effectiveLimit(null, 'monthlyTaskLimit', 100), 100);
    assert.strictEqual(effectiveLimit({}, 'monthlyTaskLimit', 100), 100);
});

check('an explicit null override means frozen-as-unlimited, not fall back', () => {
    assert.strictEqual(effectiveLimit({ monthlyTaskLimit: null }, 'monthlyTaskLimit', 100), null);
});

check('a STRING limit out of the jsonb is coerced, never passed through', () => {
    // The whole point: this is what reached the SQL and broke the query.
    const v = effectiveLimit({ monthlyTaskLimit: '500' as unknown as number }, 'monthlyTaskLimit', 100);
    assert.strictEqual(v, 500);
    assert.strictEqual(typeof v, 'number', 'a string here is bound as text and compared to an integer column');
});

check('a junk limit degrades to unlimited rather than to zero', () => {
    // Guessing zero would lock a paying org out of its own plan over a data-quality problem.
    for (const junk of ['unlimited', 'abc', {}, [], NaN]) {
        assert.strictEqual(
            effectiveLimit({ monthlyTaskLimit: junk as unknown as number }, 'monthlyTaskLimit', 100), null,
            `${JSON.stringify(junk)} must not become a cap`,
        );
    }
});

check('a fractional limit is truncated to something an integer column can hold', () => {
    assert.strictEqual(effectiveLimit({ monthlyTaskLimit: 12.7 as number }, 'monthlyTaskLimit', 100), 12);
});

check('every limit key gets the same treatment', () => {
    const keys = ['assistantLimit', 'monthlyTaskLimit', 'monthlyTokenLimit', 'appConnectionLimit', 'seatLimit'] as const;
    for (const k of keys) {
        const o = { [k]: '7' } as unknown as FeatureOverrides;
        assert.strictEqual(effectiveLimit(o, k, 1), 7, `${k} must coerce too`);
    }
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
