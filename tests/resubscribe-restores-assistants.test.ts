// tests/resubscribe-restores-assistants.test.ts
// Found on staging, workspace 58, 2026-10-25: a customer who cancelled and later bought a new plan
//   1. was told "Your subscription has ended" at every login (login read the OLDEST plan row), and
//   2. kept every assistant paused on the active plan (nothing released paused_payment / paused_limit
//      when a NEW subscription started).
// And while tracing it: every bulk pause would also have paused the Business Mentor, which must stay
// for Help Centre answers and support with no paid plan (docs/business-mentor-plan.md §2.7).
//
// Run:  npx tsx tests/resubscribe-restores-assistants.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(path.join(root, dir))) {
        const rel = path.join(dir, name);
        if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
        else if (rel.endsWith('.ts')) out.push(rel);
    }
    return out;
}

console.log('re-subscribing restores assistants; the Mentor is never bulk-paused');

test('login reads the active plan first, then past_due, then the newest', () => {
    const v = read('netlify/functions/verify.ts');
    assert.match(v, /\.orderBy\(sql`CASE \$\{plans\.status\} WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 ELSE 2 END`, desc\(plans\.startedAt\)\)/);
    assert.doesNotMatch(v, /\.orderBy\(plans\.startedAt\)\s*\n\s*\.limit\(1\)/);
});

test('both new-plan paths in the Stripe webhook restore paused assistants after the plan is written', () => {
    const w = read('netlify/functions/stripe-webhook.ts');
    const calls = [...w.matchAll(/await afterPaidPlanStarted\(db, orgIdInt\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(orgIdInt && userIdInt\) await restoreAfterNewPlan\(db, userIdInt, orgIdInt\);/g)];
    assert.strictEqual(calls.length, 2, 'checkout.session.completed and payment_intent.succeeded');
});

test('restore turns payment pauses into slot pauses, then releases up to the new limit', () => {
    const r = read('src/utils/restore-after-new-plan.ts');
    const fn = r.slice(r.indexOf('export async function restoreAfterNewPlan'));
    const toLimit = fn.indexOf(".set({ provisioningStatus: 'paused_limit'");
    const fromPayment = fn.indexOf("eq(aiAssistants.provisioningStatus, 'paused_payment')");
    const release = fn.indexOf('return await releasePausedLimit(db, userId, organisationId)');
    assert.ok(toLimit > 0 && fromPayment > toLimit && release > fromPayment);
    assert.match(fn, /isNull\(aiAssistants\.archivedAt\)/);
    assert.match(fn, /catch \(err\)/, 'never throws inside the webhook');
});

test('every bulk pause leaves the Business Mentor running', () => {
    // A write that switches assistants off with a pause marker, chosen by user or organisation.
    const offenders: string[] = [];
    for (const f of [...walk('netlify/functions'), ...walk('src')]) {
        const src = read(f);
        for (const m of src.matchAll(/\.set\((?:withUpdatedAt\()?\{\s*isActive: false, provisioningStatus: [^}]+\}\)?\)\s*\n?\s*\.where\(([\s\S]{0,1400}?)\)\)?;/g)) {
            const where = m[1];
            if (/inArray\(aiAssistants\.id/.test(where)) continue;          // a chosen list of ids
            if (!/takesASeat\(\)/.test(where)) offenders.push(`${f}: ${m[0].split('\n')[0].trim().slice(0, 90)}`);
        }
    }
    assert.deepStrictEqual(offenders, [], 'Add takesASeat() so the Mentor is never paused in bulk');
});

test('the five known bulk pauses are covered by that scan', () => {
    for (const [f, marker] of [
        ['netlify/functions/stripe-webhook.ts', "provisioningStatus: 'paused_payment', updatedAt: now"],
        ['netlify/functions/stripe-webhook.ts', "provisioningStatus: 'paused_payment' as const"],
        ['netlify/functions/task-volume-check.ts', "provisioningStatus: 'paused_quota'"],
        ['src/utils/trial.ts', 'provisioningStatus: TRIAL_ENDED_PAUSE'],
        ['src/utils/beta-ending.ts', 'provisioningStatus: BETA_ENDED_PAUSE'],
    ] as const) {
        const src = read(f);
        const i = src.indexOf(marker);
        assert.ok(i > 0, `${f} no longer has ${marker}`);
        assert.match(src.slice(i, i + 1400), /takesASeat\(\)/, `${f} ${marker}`);
    }
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
