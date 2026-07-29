// tests/blueprint-prompt-sync.test.ts
// The blueprint is meant to BE the brief the assistant is generated from. These checks pin the
// places where the two can silently disagree.
//
// Two failures this guards:
//   1. The blueprint's compiled section 2 ends with a full copy of AURA_SAFE_CONTENT_BENCHMARK
//      (compileServerSideBrief appends it at onboarding), and the generation prompt appends the
//      same constant again at the end — ~1,400 tokens of identical safety text, twice, on every
//      draft. The dump now strips it.
//   2. The set of Operational Setup answers the blueprint calls valid must be the same set
//      generation can act on. They were declared in two files and would have drifted apart the
//      moment either gained an option.
//
// Run:  npx tsx tests/blueprint-prompt-sync.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../src/constants/safety-benchmark';
import { OPERATIONAL_TRIGGERS, OPERATIONAL_SOURCES, operationalSetupLines } from '../src/utils/operational-setup';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const worker = readFileSync(new URL('../netlify/functions/process-content-jobs.ts', import.meta.url), 'utf8');
const blueprint = readFileSync(new URL('../src/utils/blueprint.ts', import.meta.url), 'utf8');

console.log('\nBlueprint ↔ generation prompt sync\n');

// ── The benchmark appears exactly once ───────────────────────────────────────────────────────

test('the safety benchmark is stripped from dumped section content', () => {
    // Reproduces the real dump loop's value rendering.
    const withoutBenchmark = (s: string) =>
        s.includes(AURA_SAFE_CONTENT_BENCHMARK) ? s.split(AURA_SAFE_CONTENT_BENCHMARK).join('').trimEnd() : s;

    const compiledBrief = `BE MORE SWAN ENGINEERING BRIEF\n\nsome client config\n\n${AURA_SAFE_CONTENT_BENCHMARK}`;
    const dumped = withoutBenchmark(compiledBrief);

    assert.ok(!dumped.includes(AURA_SAFE_CONTENT_BENCHMARK), 'benchmark must not survive the dump');
    assert.match(dumped, /some client config/, 'the client configuration must be preserved');
    assert.match(dumped, /ENGINEERING BRIEF/, 'the brief itself must be preserved');
});

test('a section carrying no benchmark is passed through untouched', () => {
    const withoutBenchmark = (s: string) =>
        s.includes(AURA_SAFE_CONTENT_BENCHMARK) ? s.split(AURA_SAFE_CONTENT_BENCHMARK).join('').trimEnd() : s;
    const plain = 'businessName: Willowbrook Coffee Roasters';
    assert.equal(withoutBenchmark(plain), plain);
});

test('the worker still appends the canonical copy exactly once', () => {
    // Stripping the duplicate is only safe because one authoritative copy is added at the end.
    const appends = worker.match(/systemPrompt \+= `\\n\\n\$\{AURA_SAFE_CONTENT_BENCHMARK\}`/g) || [];
    assert.equal(appends.length, 1, 'exactly one canonical append expected');
});

test('the dump applies the strip rather than interpolating the raw value', () => {
    // The regression: `${typeof v === 'object' ? JSON.stringify(v) : v}` sent section 2 verbatim.
    const line = worker.split('\n').find(l => l.includes('DISCLOSURE_PROMPT_BLOCKLIST.has(k)') === false
        && l.includes('systemPrompt += `${k}:'));
    assert.ok(line, 'dump line not found');
    assert.match(line!, /withoutBenchmark/, 'dumped string values must be stripped');
});

// ── One definition of the Operational Setup answers ──────────────────────────────────────────

test('the blueprint validates against the generator\'s own answer sets', () => {
    assert.ok(
        /from '\.\/operational-setup'/.test(blueprint),
        'blueprint must import the allowed values, not redeclare them',
    );
    assert.ok(
        !/const OPERATIONAL_TRIGGERS = \[/.test(blueprint),
        'blueprint has redeclared OPERATIONAL_TRIGGERS — it will drift',
    );
    assert.ok(
        !/const OPERATIONAL_SOURCES = \[/.test(blueprint),
        'blueprint has redeclared OPERATIONAL_SOURCES — it will drift',
    );
});

test('every answer the blueprint accepts actually steers generation', () => {
    // The contract that makes the shared list worth having: an answer recorded as valid in the
    // blueprint must produce a directive, or the blueprint is reporting steering that never happens.
    for (const source of OPERATIONAL_SOURCES) {
        const lines = operationalSetupLines({ content_source: source });
        assert.equal(lines.length, 1, `content_source '${source}' produces no directive`);
    }
    // Triggers are asymmetric by design — only 'scheduled' needs to tell the model anything —
    // so assert the set is recognised, not that each one speaks.
    assert.deepEqual([...OPERATIONAL_TRIGGERS], ['on_demand', 'reactive', 'scheduled']);
    assert.equal(operationalSetupLines({ trigger_type: 'scheduled' }).length, 1);
});

test('an answer outside the shared set steers nothing', () => {
    assert.deepEqual(operationalSetupLines({ content_source: 'made_up' }), []);
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}\n`);
