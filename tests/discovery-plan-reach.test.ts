// tests/discovery-plan-reach.test.ts
// Say what a plan can reach BEFORE the user spends on it.
//
// Tier 1 (tests/discovery-coverage.test.ts) reports coverage after a run. By then the money is
// gone and a 175-lead sample of ~4,500 schools already looks like a finished search. This is the
// same fact moved to the brief-approval screen, where "narrow this to one county" is still a
// five-second edit.
//
// ⚠️ The design rule this file exists to hold: REACH IS ARITHMETIC, MARKET SIZE IS NOT. The plan's
// ceiling is exactly knowable from the query count, the results-per-query and the user's own
// guardrails. How many schools exist is not, so it is never computed, never asked of a model, and
// never rendered next to the exact figures. A confident wrong number is what the product was
// already shipping.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePlanReach, RESULTS_PER_QUERY } from '../src/config/plan-reach';
import {
    DEFAULT_MAX_LEADS_PER_RUN, DEFAULT_MAX_LEADS_PER_MONTH, DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
} from '../src/config/discovery-limits';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nDiscovery plan reach\n');

const DEFAULTS = {
    maxLeadsPerRun: DEFAULT_MAX_LEADS_PER_RUN,
    maxSearchCallsPerRun: DEFAULT_MAX_SEARCH_CALLS_PER_RUN,
    maxLeadsPerMonth: DEFAULT_MAX_LEADS_PER_MONTH,
};

// ── The arithmetic ─────────────────────────────────────────────────────────────────────────────

check('the schools plan is reported as 15 searches and 150 results', () => {
    // The real campaign: 5 queries x 3 strategies against ~4,500 South East schools.
    const r = computePlanReach(15, DEFAULTS);
    assert.strictEqual(r.searchesThatWillRun, 15);
    assert.strictEqual(r.maxResultsRead, 150);
    assert.strictEqual(r.maxLeadsBanked, 50, 'the 50-lead run cap bounds it well below 150');
    assert.strictEqual(r.bindingLimit, 'lead_cap', 'and the user needs to know WHICH limit that is');
});

check('the search cap decides how many queries run, before any lead cap applies', () => {
    // ⚠️ Order matters. Applying lead caps first would report a plan reading 300 results when its
    // search cap only ever allowed 30 to run.
    const r = computePlanReach(30, { ...DEFAULTS, maxSearchCallsPerRun: 3 });
    assert.strictEqual(r.searchesThatWillRun, 3);
    assert.strictEqual(r.maxResultsRead, 3 * RESULTS_PER_QUERY);
    assert.strictEqual(r.bindingLimit, 'search_cap');
});

check('a spent monthly allowance outranks the per-run caps', () => {
    // Raising a per-run limit does nothing here, so naming the wrong one wastes the user's time.
    const r = computePlanReach(15, { ...DEFAULTS, leadsThisMonth: DEFAULT_MAX_LEADS_PER_MONTH - 2 });
    assert.strictEqual(r.maxLeadsBanked, 2);
    assert.strictEqual(r.bindingLimit, 'month_cap');
});

check('a plan that fits inside every limit reports no binding limit', () => {
    // ⚠️ Sized against the DEEP ceiling, not the plan as written. Once a productive query can earn
    // extra pages, a 2-query plan reaches 80 results and the 50-lead cap genuinely does bite — so
    // the honest "unconstrained" example is a smaller one. Reporting null for the 2-query case
    // would be the understatement this whole feature exists to remove.
    const r = computePlanReach(1, DEFAULTS);
    assert.ok(r.maxResultsReadIfAllProductive < DEFAULT_MAX_LEADS_PER_RUN, 'the example must genuinely fit');
    assert.strictEqual(r.bindingLimit, null, 'inventing a constraint here would be its own lie');

    // And the converse: a plan that only reaches a cap once depth is earned must still say so.
    assert.strictEqual(computePlanReach(2, DEFAULTS).bindingLimit, 'lead_cap');
});

check('an empty or nonsense plan degrades to zero rather than NaN', () => {
    for (const q of [0, -5, 1.7]) {
        const r = computePlanReach(q, DEFAULTS);
        assert.ok(Number.isFinite(r.maxResultsRead) && r.maxResultsRead >= 0, `q=${q} produced ${r.maxResultsRead}`);
    }
});

// ── One definition of the numbers ──────────────────────────────────────────────────────────────

check('the worker and the planner read the SAME results-per-query', () => {
    // ⚠️ A planner promising 150 results while the worker read 100 would be a worse lie than the
    // silence it replaced. The constant moved out of the worker for exactly this reason.
    const worker = read('netlify/functions/process-discovery-jobs.ts');
    // Matches the import of the NAME, not the exact brace contents — the same import legitimately
    // gained MAX_PAGES_PER_QUERY and YIELD_TO_PAGINATE when depth arrived.
    assert.match(worker, /import \{[^}]*\bRESULTS_PER_QUERY\b[^}]*\} from '.*plan-reach'/, 'the worker must import it');
    assert.ok(!/const RESULTS_PER_QUERY = /.test(worker), 'the worker kept its own copy');
});

check('the guardrail defaults have one definition', () => {
    const worker = read('netlify/functions/process-discovery-jobs.ts');
    assert.match(worker, /maxLeadsPerRun: DEFAULT_MAX_LEADS_PER_RUN/, 'the worker must use the shared default');
    assert.ok(!/maxLeadsPerRun: 50,/.test(worker), 'a literal default is back in the worker');
});

// ── The advisory half, and its limits ──────────────────────────────────────────────────────────

const ADVICE = read('src/lib/market-enumerability.ts');

check('the model is never asked how big the market is', () => {
    // ⚠️ The single most important constraint here. A plausible invented headcount rendered beside
    // exact arithmetic would be the most dangerous number on the screen.
    assert.match(ADVICE, /NEVER estimate how many/i, 'the prompt must forbid a count');
    for (const field of ['count', 'total', 'estimate', 'size']) {
        assert.ok(
            !new RegExp(`"${field}"\\s*:`).test(ADVICE),
            `the response schema must not carry a "${field}" field`,
        );
    }
});

check('an uncertain register name comes back null rather than invented', () => {
    assert.match(ADVICE, /set registerName to null/i, 'the prompt must offer an out');
    assert.match(ADVICE, /registerName: parsed\.enumerable && name \? name : null/,
        'a register name must not survive a "not enumerable" verdict');
});

check('the assessment can never fail the brief screen', () => {
    // It runs while the user waits, and it is advice, not a gate.
    assert.match(ADVICE, /catch \(err\)/, 'every failure path must be swallowed');
    assert.match(ADVICE, /return null;/, 'and resolve to null');
    assert.match(ADVICE, /!process\.env\.ANTHROPIC_API_KEY/, 'a missing key must short-circuit, not throw');
});

// ── The screen ─────────────────────────────────────────────────────────────────────────────────

const UI = read('src/components/assistant-discovery-campaigns.js');

check('both blocks render above the approve button, not below it', () => {
    const reach = UI.indexOf('${planReachBlock(brief)}');
    const advice = UI.indexOf('${marketAdviceBlock(brief)}');
    const approve = UI.indexOf('data-dc-approve');
    assert.ok(reach > 0 && advice > 0, 'both blocks must be rendered');
    assert.ok(reach < approve && advice < approve, 'advice after the commit button is advice nobody reads');
});

check('a "not enumerable" verdict renders nothing at all', () => {
    // Sampling IS the right tool for a fuzzy market. Saying so would be noise on every campaign
    // that is working correctly.
    const fn = UI.slice(UI.indexOf('function marketAdviceBlock(brief) {'));
    assert.match(fn.slice(0, 400), /if \(!m \|\| !m\.enumerable\) return '';/);
});

check('a missing assessment degrades to silence, not to a broken block', () => {
    const fn = UI.slice(UI.indexOf('function planReachBlock(brief) {'));
    assert.match(fn.slice(0, 300), /if \(!r \|\| !r\.queries\) return '';/);
});

check('the API ships both, and the arithmetic is not model-derived', () => {
    const api = read('netlify/functions/discovery-campaigns.ts');
    assert.match(api, /planReach,/, 'generate_brief must return the reach');
    assert.match(api, /marketAdvice,/, 'and the advisory');
    assert.match(api, /computePlanReach\(gen\.flat\.length,/, 'reach must come from the real query count');
});

console.log(`\n${passed} checks passed\n`);
