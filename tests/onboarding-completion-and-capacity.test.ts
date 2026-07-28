// tests/onboarding-completion-and-capacity.test.ts
// Finishing the onboarding form must (a) read as finished, and (b) never hand out a seat the plan
// does not have. These were one causal chain, reported together.
//
// ── The bug ─────────────────────────────────────────────────────────────────────────────────────
// get-onboarding-progress decides the form is unfinished if ANY onboarding_drafts row exists for
// the org. onboarding.ts deleted only the row whose id was submitted — and drafts are multi-row on
// purpose, with the form POSTing a NEW one on every fresh page load that has no draftId in the URL.
//
// So one leftover row left the setup wizard saying "not complete" for ever, with a "Resume setup"
// link back into the form. Following it ran onboarding.ts again, which created a SECOND assistant —
// because that endpoint had no capacity check at all. The only assistant-limit gate lived in the
// browser (_catHire), which that link never goes through and which fails OPEN on error.
//
// Run:  npx tsx tests/onboarding-completion-and-capacity.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkAssistantCapacity, SEAT_OCCUPYING_STATUSES } from '../src/utils/assistant-capacity';
import { extractOnboardingGuardrails } from '../src/utils/onboarding-guardrails';

let passed = 0, total = 0;
const deferred: Array<() => Promise<void>> = [];
/** Queued, not awaited inline: tsx compiles these to CJS, which has no top-level await. */
function check(name: string, fn: () => void | Promise<void>) {
    total++;
    deferred.push(async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
    });
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Stands in for the three reads checkAssistantCapacity makes, in order: the plan, the org's bonus
 * assistants, and the seat count.
 */
function fakeDb(opts: { plan: unknown; bonus?: number; occupied?: number }) {
    let call = 0;
    const chain: any = {
        from: () => chain, leftJoin: () => chain, where: () => chain, orderBy: () => chain,
        limit: async () => (call === 1 ? (opts.plan ? [opts.plan] : []) : [{ bonusAssistants: opts.bonus ?? 0 }]),
        then: (res: (v: unknown) => void) => res([{ value: opts.occupied ?? 0 }]),
    };
    return { select: () => { call++; return chain; } };
}
const PLAN = { assistantLimit: 1, featureOverrides: null };

console.log('\nonboarding completion & capacity\n');

// ── The capacity rule ───────────────────────────────────────────────────────────────────────────
check('a one-assistant plan refuses the second', async () => {
    const refusal = await checkAssistantCapacity(fakeDb({ plan: PLAN, occupied: 1 }) as any, 1, 1);
    assert.ok(refusal, 'the £29 plan allows one assistant — the second must be refused');
    assert.strictEqual(refusal!.code, 'CAPACITY');
    assert.strictEqual(refusal!.status, 409);
});

check('the first assistant is allowed', async () => {
    assert.strictEqual(await checkAssistantCapacity(fakeDb({ plan: PLAN, occupied: 0 }) as any, 1, 1), null);
});

check('no plan is a hard block, not unlimited', async () => {
    // A missing plan used to resolve to assistantLimit=null and skip the gate entirely.
    const refusal = await checkAssistantCapacity(fakeDb({ plan: null }) as any, 1, 1);
    assert.strictEqual(refusal?.code, 'NO_PLAN');
    assert.strictEqual(refusal?.status, 402);
});

check('an unlimited plan is not blocked', async () => {
    const plan = { assistantLimit: null, featureOverrides: null };
    assert.strictEqual(await checkAssistantCapacity(fakeDb({ plan, occupied: 99 }) as any, 1, 1), null);
});

check('bonus assistants extend the limit', async () => {
    // Referral bonuses add seats on top of the plan's own limit.
    assert.strictEqual(await checkAssistantCapacity(fakeDb({ plan: PLAN, bonus: 1, occupied: 1 }) as any, 1, 1), null);
    const refusal = await checkAssistantCapacity(fakeDb({ plan: PLAN, bonus: 1, occupied: 2 }) as any, 1, 1);
    assert.strictEqual(refusal?.code, 'CAPACITY');
});

check('archived and paused assistants do not hold a seat', () => {
    // Which is what makes archiving a workable way to free one — the fix for an org that already
    // has a duplicate.
    assert.deepStrictEqual([...SEAT_OCCUPYING_STATUSES], ['provisioning', 'ready_for_work', 'working']);
    for (const free of ['archived', 'paused', 'system_paused']) {
        assert.ok(!SEAT_OCCUPYING_STATUSES.includes(free as never),
            `'${free}' must not occupy a seat`);
    }
});

// ── The wiring ──────────────────────────────────────────────────────────────────────────────────
check('the endpoint that creates an assistant from the form now checks capacity', () => {
    const src = read('netlify/functions/onboarding.ts');
    assert.match(src, /const capacityRefusal = await checkAssistantCapacity\(db, existingUser\.id, orgId\)/,
        'onboarding.ts creates assistants and must gate on the plan');
    // Order matters: the dedup runs first so re-submitting the SAME assistant still repairs an
    // abandoned row rather than being refused for a seat it already holds.
    // Compared against the CALL SITE, not the import — which sits at the top of the file and would
    // make this assertion pass no matter where the gate actually ran.
    assert.ok(src.indexOf('2. DEDUP CHECK') < src.indexOf('const capacityRefusal = await'),
        'the dedup must run before the capacity gate');
});

check('the rule has ONE implementation', () => {
    // It lived inline in hire-assistant.ts and nowhere else, which is how onboarding.ts came to
    // have none. A second copy would drift the same way.
    const hire = read('netlify/functions/hire-assistant.ts');
    assert.match(hire, /await checkAssistantCapacity\(db, userId, orgId\)/);
    assert.ok(!/occupied >= assistantLimit/.test(hire), 'the inline copy must be gone');
    assert.ok(!/effectiveLimit/.test(hire), 'and its now-unused imports with it');
});

check('submitting clears every draft for that onboarding path', () => {
    const src = read('netlify/functions/onboarding.ts');
    assert.match(src, /eq\(onboardingDrafts\.onboardingPath, submitted\.onboardingPath\)/,
        'one leftover row is what made the wizard say "not complete" for ever');
    assert.ok(!/Drafts are now multi-row — clear the specific draft this submission came from\./.test(src),
        'the delete-by-id-only behaviour is the bug');
});

check('a different role\'s setup is left alone', () => {
    // Multi-row drafts exist so two roles can be set up at once; the fix must not throw that away.
    const src = read('netlify/functions/onboarding.ts');
    const block = src.slice(src.indexOf('// 7. CLEAR DRAFT'), src.indexOf('await createNotification'));
    assert.match(block, /Scoped to the submitted draft's own path/);
    assert.ok(!/delete\(onboardingDrafts\)\.where\(eq\(onboardingDrafts\.userId, existingUser\.id\)\)\);\s*$/m.test(block.split('} else {')[0]),
        'the scoped branch must not delete every draft the user has');
});

check('completion is still judged on drafts existing — so cleanup has to be complete', () => {
    // Pins the other half of the contract. If this check ever changes, the cleanup above can relax.
    const src = read('netlify/functions/get-onboarding-progress.ts');
    assert.match(src, /onboardingDrafts\.organisationId, orgId/);
    assert.match(src, /const onboardAssistant = firstAssistant && !draftInProgress/);
});

// ── Onboarding guardrails become content rules ────────────────────────────────────────────────────
// The wizard's "Guardrails & rules set" item reads the content_rules table (get-assistant-readiness
// → hasRule), but onboarding only ever wrote the rules into the system prompt — which post
// generation doesn't read either. So a user who entered guardrails still saw "enter guardrails", and
// the rules steered nothing. onboarding.ts now materialises them into content_rules.
check('only NON-NEGOTIABLE entries become rules — KNOWLEDGE BASE context is excluded', () => {
    const strictRules = [
        '- NON-NEGOTIABLE: Never mention competitors by name',
        '- NON-NEGOTIABLE: Always use British spelling',
        '- KNOWLEDGE BASE (TEXT): Consider the following brand stories and context: "we roast in Peckham"',
        '- KNOWLEDGE BASE (LINKS): MUST DO: Always cross-reference facts at: https://example.com',
    ];
    assert.deepStrictEqual(extractOnboardingGuardrails(strictRules), [
        'Never mention competitors by name',
        'Always use British spelling',
    ], 'the NON-NEGOTIABLE prefix is stripped; KB entries are not rules');
});

check('blank, whitespace and non-string entries are dropped, non-arrays yield []', () => {
    assert.deepStrictEqual(extractOnboardingGuardrails(['- NON-NEGOTIABLE:   ', '- NON-NEGOTIABLE: real']), ['real']);
    assert.deepStrictEqual(extractOnboardingGuardrails([42, null, '- NON-NEGOTIABLE: keep']), ['keep']);
    for (const notArray of [undefined, null, 'a string', {}, 7]) {
        assert.deepStrictEqual(extractOnboardingGuardrails(notArray), [], `${JSON.stringify(notArray)} → []`);
    }
});

check('onboarding.ts persists the extracted rules into content_rules for the new assistant', () => {
    const src = read('netlify/functions/onboarding.ts');
    // Sourced from the guardrail extractor, then written as content_rules rows against the new
    // assistant. This is the exact join the wizard's hasRule check reads back.
    assert.match(src, /extractOnboardingGuardrails\(rawInputs\?\.strictRules\)/,
        'rules must come from the shared extractor, not an inline re-parse');
    assert.match(src, /db\.insert\(contentRules\)\.values\(/,
        'the rules must land in content_rules — the table get-assistant-readiness reads');
    const block = src.slice(src.indexOf('extractOnboardingGuardrails'), src.indexOf('// 7. CLEAR DRAFT'));
    assert.match(block, /assistantId:\s*newAssistant\.id/, 'rows must be keyed to the assistant just created');
    assert.match(block, /\.slice\(0, 300\)/, 'rule_text is capped at 300, as content-rules.ts enforces');
    // Best-effort: a guardrail write must never fail an otherwise-successful onboarding.
    assert.match(block, /catch \(rulesErr\)/, 'the materialisation must be wrapped so it cannot break onboarding');
});

check('the wizard reads content_rules for the guardrails item — the store onboarding now fills', () => {
    // The two ends of the bug: readiness computes hasRule from content_rules; onboarding writes there.
    const readiness = read('netlify/functions/get-assistant-readiness.ts');
    assert.match(readiness, /from\(contentRules\)/, 'hasRule is a content_rules existence check');
    assert.match(readiness, /key: 'guardrails'.*done: hasRule/s, 'the guardrails item is driven by hasRule');
});

(async () => {
    for (const run of deferred) await run();
    console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
    if (passed !== total) process.exit(1);
})();
