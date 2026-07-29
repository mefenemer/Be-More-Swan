// tests/blueprint-sections.test.ts
// The blueprint reports what an assistant IS configured with. These checks pin the two places it
// described the configuration from scratch instead of from the code that acts on it, and so
// reported gaps that did not exist.
//
// What this guards, both found by auditing prod warnings against prod data:
//   1. Section 10 read the five budget keys from the TOP level of ai_assistants.configuration.
//      execution-budget.ts — the enforcer — reads them NESTED under `.budget`. Nothing writes
//      either shape, so EVERY assistant on the platform reported "executionBudgets missing" while
//      every run was in fact budgeted by WORKSPACE_DEFAULTS. A permanent warning teaches people to
//      ignore the warnings list.
//   2. Section 7 scoped system_connections by user_id while the rest of the platform scopes by
//      organisation_id. The column is nullable and meta-oauth.ts never sets it, so Facebook and
//      Instagram were invisible on every org; Threads/YouTube/Canva live in workspace_integrations
//      and were invisible too. One prod workspace with six live connections listed two, and its
//      primary-platform mismatch check would have false-warned on four.
//
// Run:  npx tsx tests/blueprint-sections.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    resolveBudget,
    clampToPlatform,
    WORKSPACE_DEFAULTS,
    PLATFORM_DEFAULTS,
    BUDGET_CONFIG_KEY,
} from '../src/config/execution-budgets';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const blueprint = read('../src/utils/blueprint.ts');
const enforcer = read('../netlify/functions/execution-budget.ts');

console.log('\nBlueprint sections ↔ the code that acts on them\n');

// ── Section 10 — execution budgets ───────────────────────────────────────────────────────────

test('an assistant with no budget of its own is budgeted, not unbudgeted', () => {
    // The bug in one line: this used to be reported as a missing field.
    const { budget, explicit } = resolveBudget({});
    assert.equal(explicit, false, 'nothing was chosen for this assistant');
    assert.deepEqual(budget, WORKSPACE_DEFAULTS, 'but the shared ceilings still apply');
});

test('the budget is read from configuration.budget, the key the enforcer writes', () => {
    const { budget, explicit } = resolveBudget({ [BUDGET_CONFIG_KEY]: { maxLlmCalls: 12 } });
    assert.equal(explicit, true);
    assert.equal(budget.maxLlmCalls, 12, 'the assistant’s own ceiling wins');
    assert.equal(budget.maxCostGbp, WORKSPACE_DEFAULTS.maxCostGbp, 'unset keys fall back');
});

test('the top-level shape the blueprint used to read is NOT a budget', () => {
    // If someone reintroduces the old shape, this fails rather than silently reporting defaults.
    const { explicit } = resolveBudget({ maxLlmCalls: 12, maxCostGbp: 0.4 });
    assert.equal(explicit, false, 'top-level keys are not where a budget lives');
});

test('an assistant can lower the platform ceiling but never raise it', () => {
    const clamped = clampToPlatform(
        { maxLlmCalls: 10_000, maxCostGbp: 0.25 },
        { maxLlmCalls: 200 },
    );
    assert.equal(clamped.maxLlmCalls, 200, 'clamped down to the platform limit');
    assert.equal(clamped.maxCostGbp, 0.25, 'a stricter number is kept');
});

test('platform defaults are never below workspace defaults', () => {
    // A workspace default above its own ceiling would be clamped away and mean nothing.
    for (const k of Object.keys(WORKSPACE_DEFAULTS) as (keyof typeof WORKSPACE_DEFAULTS)[]) {
        assert.ok(PLATFORM_DEFAULTS[k] >= WORKSPACE_DEFAULTS[k], `${k}: platform ceiling is below the default`);
    }
});

test('the ceilings are declared once, not copied into either consumer', () => {
    // Exactly the drift that produced the two-shape bug. Same guard as OPERATIONAL_TRIGGERS.
    for (const [name, src] of [['blueprint', blueprint], ['execution-budget', enforcer]] as const) {
        assert.ok(!/const WORKSPACE_DEFAULTS = \{/.test(src), `${name} redeclares WORKSPACE_DEFAULTS`);
        assert.ok(!/const PLATFORM_DEFAULTS = \{/.test(src), `${name} redeclares PLATFORM_DEFAULTS`);
    }
    assert.match(enforcer, /from '\.\.\/\.\.\/src\/config\/execution-budgets'/);
    assert.match(blueprint, /from '\.\.\/config\/execution-budgets'/);
});

test('an inherited budget is a complete section, not a partial one', () => {
    // The UI renders the field count beside the status, so tying status to whether a HUMAN chose
    // the numbers produced "6/6 fields — Partial", which reads as a fault when nothing is wrong.
    // Provenance belongs to budgetSource; only a malformed budget (the one case that warns) is partial.
    assert.match(blueprint, /status: budgetMalformed \? 'partial' : 'complete'/);
    assert.match(blueprint, /budgetSource: budgetExplicit \? 'assistant' : 'platform-default'/);
});

test('section 10 no longer reads budget keys off the top of configuration', () => {
    assert.ok(
        !/execConfig\.max(LlmCalls|ToolCalls|TokensGenerated|WallClockMinutes|CostGbp)/.test(blueprint),
        'the top-level read is back — section 10 will report "missing" for every assistant again',
    );
});

// ── Section 7 — active integrations ──────────────────────────────────────────────────────────

test('connections are scoped by organisation, never by user', () => {
    // user_id is nullable and meta-oauth.ts has never set it.
    assert.ok(
        !/eq\(systemConnections\.userId, asst\.userId\)/.test(blueprint),
        'user-scoped again — Facebook/Instagram will vanish from section 7',
    );
    assert.match(blueprint, /eq\(systemConnections\.organisationId, asst\.organisationId\)/);
});

test('section 7 reads BOTH credential stores', () => {
    // Threads/YouTube/Canva tokens live only in workspace_integrations.
    assert.match(blueprint, /from\(workspaceIntegrations\)/, 'the second store is not consulted');
    assert.match(
        blueprint,
        /eq\(workspaceIntegrations\.organisationId, asst\.organisationId\)/,
        'the workspace store must be org-scoped too',
    );
});

test('the primary-platform mismatch check counts only usable connections', () => {
    // A revoked token is a real gap; reporting it as connected would hide it.
    assert.match(blueprint, /wsIntegrations\.filter\(w => w\.status === 'active'\)/);
});

console.log(`\n${passed} passed\n`);
