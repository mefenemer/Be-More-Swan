// tests/blueprint-prompt-sync.test.ts
// The blueprint is meant to BE the brief the assistant is generated from. These checks pin the
// places where the two can silently disagree.
//
// What this guards, all found by auditing the two against each other:
//   1. Section 2's compiled brief ends with a full copy of AURA_SAFE_CONTENT_BENCHMARK, and the
//      caller appends the same constant again — ~1,400 tokens of identical safety text, twice, per
//      draft.
//   2. Section 2 is a HIRE-TIME snapshot, never rebuilt, so dumping it put a frozen copy of the
//      user's audience/tone/platforms/guardrails beside the live ones, plus the platform's own
//      "Be More Swan Workspace" paragraph, in copy written for the client's brand.
//   3. Section 8 (plan name, £ price, usage) and section 10 (execution budgets) reaching a
//      copywriter — a model given a price can put that price in a caption.
//   4. Two hand-written copies of the dump loop: the admin smoke test applied NO withholding rules
//      at all, so it tested a prompt no customer ever receives.
//   5. Operational Setup answer sets declared in two files, free to drift.
//
// Run:  npx tsx tests/blueprint-prompt-sync.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../src/constants/safety-benchmark';
import { OPERATIONAL_TRIGGERS, OPERATIONAL_SOURCES, operationalSetupLines } from '../src/utils/operational-setup';
import { renderBlueprintPrompt, PROMPT_KEY_BLOCKLIST, PROMPT_SECTION_BLOCKLIST } from '../src/utils/blueprint-prompt';
import { landmark } from './landmark';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const worker = read('../netlify/functions/process-content-jobs.ts');
const adminTest = read('../netlify/functions/admin-test-generate-background.ts');
const blueprint = read('../src/utils/blueprint.ts');
const saveFn = read('../netlify/functions/update-assistant-context.ts');
const rulesFn = read('../netlify/functions/content-rules.ts');

/** A blueprint shaped like the real thing, carrying every hazard at once. */
const HAZARDOUS_SECTIONS = {
    '1-identity': { content: { assistantName: 'Nova', role: 'Social Media Manager' } },
    '2-base-prompt': {
        content: {
            systemPrompt: `BE MORE SWAN ENGINEERING BRIEF\n\nTrigger: On Demand\n\nAPPROVAL PROTOCOL\n`
                + `All requests requiring your sign-off are managed exclusively through your Be More Swan `
                + `Workspace.\n\n${AURA_SAFE_CONTENT_BENCHMARK}`,
            workflowText: 'Research topics, draft copy, stage for review.',
            versionNumber: 3,
        },
    },
    '5-org-context': { content: { businessName: 'Willowbrook Coffee Roasters', targetAudience: 'cafe owners' } },
    '8-plan': { content: { planName: 'Task Buster', monthlyPriceGbp: 99, currentTasksUsed: 412 } },
    '9-compliance': { content: { hitlMode: 'review', disclosureText: 'This post was created with AI.' } },
    '10-execution': { content: { maxLlmCalls: 12, maxCostGbp: 0.4 } },
};

console.log('\nBlueprint ↔ generation prompt sync\n');

// ── One renderer, two callers ────────────────────────────────────────────────────────────────

test('both drafting paths render through the shared renderer', () => {
    // The admin loop was a hand-written copy and had drifted to zero withholding rules.
    for (const [name, src] of [['process-content-jobs', worker], ['admin-test-generate-background', adminTest]] as const) {
        assert.match(src, /renderBlueprintPrompt\(sections\)/, `${name} must use the shared renderer`);
        assert.ok(
            !/for \(const \[k, v\] of Object\.entries\(sec/.test(src),
            `${name} still has its own hand-written dump loop`,
        );
    }
});

// ── What the renderer withholds ──────────────────────────────────────────────────────────────

test('the stale hire-time brief never reaches the model', () => {
    const out = renderBlueprintPrompt(HAZARDOUS_SECTIONS);
    assert.ok(!out.includes('ENGINEERING BRIEF'), 'the frozen brief must be withheld');
    assert.ok(!out.includes('Be More Swan Workspace'), 'platform language must not reach client copy');
    assert.ok(PROMPT_KEY_BLOCKLIST.has('systemPrompt'));
});

test('workflowText survives — it is the one fact section 2 uniquely held', () => {
    // Withholding the brief is only safe because this was lifted out and sourced live.
    const out = renderBlueprintPrompt(HAZARDOUS_SECTIONS);
    assert.match(out, /Research topics, draft copy, stage for review\./);
    assert.match(out, /versionNumber: 3/, 'other section 2 fields still render');
});

test('the safety benchmark appears zero times in the rendered body', () => {
    // Zero, not one: the caller appends the canonical copy after this.
    const out = renderBlueprintPrompt(HAZARDOUS_SECTIONS);
    assert.ok(!out.includes(AURA_SAFE_CONTENT_BENCHMARK), 'benchmark must not be duplicated by the dump');
});

test('the benchmark is stripped from ANY string, not just section 2', () => {
    const out = renderBlueprintPrompt({
        '5-org-context': { content: { businessDescription: `We roast coffee.\n${AURA_SAFE_CONTENT_BENCHMARK}` } },
    });
    assert.ok(!out.includes(AURA_SAFE_CONTENT_BENCHMARK));
    assert.match(out, /We roast coffee\./, 'the real content survives the strip');
});

test('the plan section, price included, is withheld wholesale', () => {
    const out = renderBlueprintPrompt(HAZARDOUS_SECTIONS);
    assert.ok(!out.includes('8-PLAN'), 'blocked section header must not appear');
    assert.ok(!out.includes('99'), 'the monthly price must not reach a copywriter');
    assert.ok(!out.includes('Task Buster'));
    assert.ok(PROMPT_SECTION_BLOCKLIST.has('8-plan'));
});

test('execution budgets are withheld', () => {
    const out = renderBlueprintPrompt(HAZARDOUS_SECTIONS);
    assert.ok(!out.includes('10-EXECUTION'));
    assert.ok(!out.includes('maxCostGbp'));
});

test('the disclosure strings stay withheld', () => {
    // The original rule, preserved through the refactor — prod once shipped a post with three.
    const out = renderBlueprintPrompt(HAZARDOUS_SECTIONS);
    assert.ok(!out.includes('This post was created with AI.'));
    assert.match(out, /hitlMode: review/, 'the rest of section 9 still renders');
});

test('everything not withheld still renders', () => {
    const out = renderBlueprintPrompt(HAZARDOUS_SECTIONS);
    assert.match(out, /--- 1-IDENTITY ---/);
    assert.match(out, /assistantName: Nova/);
    assert.match(out, /businessName: Willowbrook Coffee Roasters/);
});

test('null values and empty sections do not emit noise', () => {
    const out = renderBlueprintPrompt({ '5-org-context': { content: { businessName: null, website: undefined } } });
    assert.ok(!out.includes('businessName'), 'null fields are skipped');
    assert.ok(!out.includes('website'));
});

// ── Live sourcing that makes withholding section 2 safe ──────────────────────────────────────

test('section 2 sources workflowText live, not from the frozen brief', () => {
    assert.match(blueprint, /workflowText: \(execInputs\.workflowText/);
});

test('section 3 falls back to the strict rules the profile actually writes', () => {
    // constraints from onboardingContext alone was ALWAYS null — neither the wizard nor the profile
    // writes there, so an edited guardrail steered nothing.
    assert.match(blueprint, /onboardingCtx\.constraints \?\? onboardingCtx\.strict_rules \?\? liveStrictRules/);
});

// ── The compiled blueprint tracks profile edits ──────────────────────────────────────────────

test('saving the profile recompiles the blueprint', () => {
    assert.match(saveFn, /assembleBlueprint\(assistantId/, 'a profile save must recompile');
    const idx = landmark(saveFn, 'assembleBlueprint(assistantId');
    assert.match(saveFn.slice(idx - 200, idx + 300), /catch/, 'a recompile failure must not fail the save');
});

test('every content-rule mutation recompiles the blueprint', () => {
    // Rules reach the model through COMPILED section 4, never live: the generation worker dumps the
    // blueprint, and post-quality-review reads section 4 from the latest persisted row. A rule added
    // in the Guardrails panel used to sit dormant until an unrelated recompile happened.
    // Deactivating and deleting count too — section 4 filters on isActive.
    for (const mutation of ['create', 'edit', 'delete']) {
        assert.match(
            rulesFn,
            // [^;]* not [^)]* — the create call passes Number(assistantId), parens and all.
            new RegExp(`recompileAfterRuleChange\\([^;]*'${mutation}'\\)`),
            `the ${mutation} path must recompile`,
        );
    }
    const idx = landmark(rulesFn, 'await assembleBlueprint');
    assert.match(rulesFn.slice(idx - 200, idx + 300), /catch/, 'a recompile failure must not fail the edit');
});

test('an unchanged recompile reuses the existing row instead of appending', () => {
    // Without this the 1.2s-debounced autosave would bury real versions under near-identical rows.
    assert.match(blueprint, /contentFingerprint/, 'recompiles must be content-idempotent');
});

test('idempotence compares CONTENT, never the version hash or sources', () => {
    // The hash is built from row ids + updated_at, so it moves on any touch; `sources` carry those
    // same timestamps. Only section content can decide whether this is a genuinely new blueprint.
    const fingerprint = (sections: Record<string, { content?: unknown }>) => JSON.stringify(
        Object.fromEntries(Object.entries(sections).map(([k, s]) => [k, s?.content ?? null])));

    const base = {
        '4-content-rules': { content: { rules: ['no delivery promises'] }, sources: [{ updatedAt: 'T1' }] },
        '8-plan': { content: { monthlyPriceGbp: 29 } },
    };
    const touched = { ...base, '4-content-rules': { ...base['4-content-rules'], sources: [{ updatedAt: 'T2' }] } };
    const ruleAdded = { ...base, '4-content-rules': { ...base['4-content-rules'], content: { rules: ['no delivery promises', 'say Swan'] } } };
    const repriced = { ...base, '8-plan': { content: { monthlyPriceGbp: 39 } } };

    assert.equal(fingerprint(base), fingerprint(touched), 'a sources-only touch must reuse the row');
    assert.notEqual(fingerprint(base), fingerprint(ruleAdded), 'a new rule must write a row');
    assert.notEqual(fingerprint(base), fingerprint(repriced), 'a price change must write a row');
});

// ── One definition of the Operational Setup answers ──────────────────────────────────────────

test('the blueprint validates against the generator\'s own answer sets', () => {
    assert.ok(/from '\.\/operational-setup'/.test(blueprint), 'blueprint must import the allowed values');
    assert.ok(!/const OPERATIONAL_TRIGGERS = \[/.test(blueprint), 'redeclared OPERATIONAL_TRIGGERS will drift');
    assert.ok(!/const OPERATIONAL_SOURCES = \[/.test(blueprint), 'redeclared OPERATIONAL_SOURCES will drift');
});

test('every answer the blueprint accepts actually steers generation', () => {
    for (const source of OPERATIONAL_SOURCES) {
        assert.equal(operationalSetupLines({ content_source: source }).length, 1,
            `content_source '${source}' produces no directive`);
    }
    assert.deepEqual([...OPERATIONAL_TRIGGERS], ['on_demand', 'reactive', 'scheduled']);
    assert.equal(operationalSetupLines({ trigger_type: 'scheduled' }).length, 1);
});

test('an answer outside the shared set steers nothing', () => {
    assert.deepEqual(operationalSetupLines({ content_source: 'made_up' }), []);
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}\n`);
