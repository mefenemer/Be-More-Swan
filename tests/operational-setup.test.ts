// tests/operational-setup.test.ts
// The onboarding wizard's Operational Setup answers must reach the generation prompt as
// DIRECTIVES, not just as part of the verbatim blueprint dump.
//
// The bug this guards: a user who answered "I will provide the raw inputs" was still getting
// posts full of invented statistics and customer stories, because nothing in the prompt told the
// model that the material was supposed to come from them. The answer was captured, stored (after
// the onboarding fix) and dumped into the system prompt — and changed nothing.
//
// Drives the REAL operationalSetupLines(), so the precedence and fail-soft contracts are
// exercised rather than restated.

import assert from 'node:assert';
import { operationalSetupLines } from '../src/utils/operational-setup';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const joined = (...args: Parameters<typeof operationalSetupLines>) => operationalSetupLines(...args).join('\n');

async function main() {

await check('each content source produces its own directive', () => {
    assert.match(joined({ content_source: 'client_provided' }), /the user supplies the raw material/);
    assert.match(joined({ content_source: 'hybrid' }), /provides the direction and you fill the gaps/);
    assert.match(joined({ content_source: 'assistant_generated' }), /develop these posts independently/);
});

await check('every content source carries the anti-fabrication clause', () => {
    // This is the whole point of the directive — a mode that drops it is a regression, including
    // 'assistant_generated', which licenses independent research, not invented specifics.
    for (const mode of ['client_provided', 'hybrid', 'assistant_generated']) {
        assert.match(joined({ content_source: mode }), /Never invent concrete specifics/,
            `${mode} must not license fabrication`);
    }
});

await check('a scheduled post is told it is an unprompted calendar slot', () => {
    assert.match(joined({ trigger_type: 'scheduled' }), /did not ask for it just now/);
});

await check('on-demand and reactive drafts get no trigger line', () => {
    // They ARE responses to a request, so warning them not to read like one would be wrong.
    assert.deepEqual(operationalSetupLines({ trigger_type: 'on_demand' }), []);
    assert.deepEqual(operationalSetupLines({ trigger_type: 'reactive' }), []);
});

await check('content source leads, trigger follows', () => {
    // Order matters in the prompt: the constraint on what may be claimed outranks the note about
    // how the post was triggered.
    const lines = operationalSetupLines({ content_source: 'hybrid', trigger_type: 'scheduled' });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /CONTENT SOURCE/);
    assert.match(lines[1], /posting schedule/);
});

await check('an unanswered assistant changes the prompt not at all', () => {
    // These answers are optional and predate the wizard storing them, so a missing one must leave
    // the prompt byte-identical rather than injecting a hedge or a default.
    assert.deepEqual(operationalSetupLines({}), []);
    assert.deepEqual(operationalSetupLines(null), []);
    assert.deepEqual(operationalSetupLines(undefined, undefined), []);
});

await check('an unrecognised stored value is ignored, not echoed', () => {
    // Old rows hold DOM labels ("I will provide the raw inputs") rather than keys. Those must not
    // reach the model as an instruction, and must not throw.
    assert.deepEqual(operationalSetupLines({ content_source: 'I will provide the raw inputs' }), []);
    assert.deepEqual(operationalSetupLines({ content_source: 'on_a_schedule', trigger_type: 'Reactively' }), []);
});

await check('non-string stored values are ignored', () => {
    assert.deepEqual(operationalSetupLines({ content_source: 42, trigger_type: { v: 'scheduled' } }), []);
});

await check('live context wins over the recompiled blueprint copy', () => {
    // A profile edit must apply immediately; waiting on a blueprint recompile is what the live
    // read exists to avoid.
    const lines = joined({ content_source: 'client_provided' }, { content_source: 'assistant_generated' });
    assert.match(lines, /the user supplies the raw material/);
    assert.doesNotMatch(lines, /develop these posts independently/);
});

await check('the blueprint copy is used when the live context lacks the answer', () => {
    assert.match(joined({}, { content_source: 'hybrid' }), /fill the gaps/);
    assert.match(joined({ trigger_type: 'scheduled' }, { content_source: 'hybrid' }), /fill the gaps/);
});

console.log(`\n${passed} checks passed.`);

}

main();
