// tests/blog-blueprint-injection.test.ts
// Blog Autopilot: long-form drafts must receive the workspace's Content Rules (§4) and the
// owner's AUTHORITATIVE Business Knowledge (§11) from the compiled blueprint.
//
// Blog generation historically read no blueprint at all, so a user could upload brand guidelines,
// see them labelled as overriding any conflicting instruction, and have long-form ignore them.
//
// Drives the REAL buildBlueprintGuardrailsBlock() against a stubbed db, so the serialisation and
// the fail-soft contract are genuinely exercised rather than restated.

import assert from 'node:assert';
import { buildBlueprintGuardrailsBlock } from '../src/utils/blog-generate';
import { landmark } from './landmark';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

/** Minimal drizzle-ish stub whose select() chain resolves to `rows`. */
function dbReturning(rows: unknown[]) {
    const chain: any = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => void) => res(rows);
    return { select: () => chain } as any;
}

const OPTS = { assistantId: 1, organisationId: 2, compiledBy: 'test' };

const FULL_SECTIONS = {
    '4-content-rules': {
        content: {
            rules: [
                { id: 1, text: 'Never promise delivery times.', origin: 'manual' },
                { id: 2, text: 'Always call the product "Swan", never "the app".', origin: 'rejection_feedback' },
                { id: 3, text: '   ', origin: 'manual' },  // whitespace-only → dropped
            ],
        },
    },
    '11-business-knowledge': {
        content: {
            directive: 'The business knowledge below is provided by the business owner and is AUTHORITATIVE.',
            documents: [{ name: 'Brand Guidelines', text: 'Our tone is plain-spoken.', truncated: false }],
            links: [{ name: 'Style guide', url: 'https://example.com/style' }],
        },
    },
};

// Wrapped in main(): the repo's test transform emits CJS, which has no top-level await.
async function main() {

await check('serialises §4 rules and §11 knowledge, dropping blank rules', async () => {
    const block = await buildBlueprintGuardrailsBlock(dbReturning([{ sections: FULL_SECTIONS }]), OPTS);
    assert.ok(block, 'expected a block');
    assert.match(block!, /CONTENT RULES/);
    assert.match(block!, /- Never promise delivery times\./);
    assert.match(block!, /- Always call the product "Swan"/);
    assert.doesNotMatch(block!, /^- \s*$/m, 'the whitespace-only rule must not appear');
    assert.match(block!, /BUSINESS KNOWLEDGE — .*AUTHORITATIVE/);
    assert.match(block!, /\[Brand Guidelines\]/);
    assert.match(block!, /Our tone is plain-spoken\./);
    assert.match(block!, /https:\/\/example\.com\/style/);
});

await check('rules are ordered before business knowledge', async () => {
    const block = await buildBlueprintGuardrailsBlock(dbReturning([{ sections: FULL_SECTIONS }]), OPTS);
    assert.ok(landmark(block!, 'CONTENT RULES') < landmark(block!, 'BUSINESS KNOWLEDGE'));
});

await check('a blueprint with neither section produces no block', async () => {
    const sections = { '1-identity': { content: { assistantName: 'Blogger' } } };
    const block = await buildBlueprintGuardrailsBlock(dbReturning([{ sections }]), OPTS);
    assert.equal(block, null, 'no rules and no knowledge → prompt must be left untouched');
});

await check('empty §11 content does not assert authority over nothing', async () => {
    // The compiler emits `content: {}` for §11 when the org has no knowledge assets.
    const sections = {
        '4-content-rules': { content: { rules: [{ id: 1, text: 'Keep it short.' }] } },
        '11-business-knowledge': { content: {} },
    };
    const block = await buildBlueprintGuardrailsBlock(dbReturning([{ sections }]), OPTS);
    assert.ok(block);
    assert.match(block!, /CONTENT RULES/);
    assert.doesNotMatch(block!, /BUSINESS KNOWLEDGE/);
});

await check('the rules list is capped so a large workspace cannot crowd out the brief', async () => {
    const rules = Array.from({ length: 250 }, (_, i) => ({ id: i, text: `Rule number ${i}.` }));
    const sections = { '4-content-rules': { content: { rules } } };
    const block = await buildBlueprintGuardrailsBlock(dbReturning([{ sections }]), OPTS);
    const emitted = (block!.match(/^- Rule number /gm) || []).length;
    assert.equal(emitted, 40, 'MAX_RULES caps the injected list');
});

await check('fails soft: a db error yields null rather than breaking the draft', async () => {
    const exploding = { select: () => { throw new Error('connection lost'); } } as any;
    const block = await buildBlueprintGuardrailsBlock(exploding, OPTS);
    assert.equal(block, null, 'a blueprint failure must never fail the blog draft');
});

console.log(`\n${passed} checks passed.`);

}

main();
