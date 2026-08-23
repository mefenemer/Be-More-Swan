// tests/discovery-coverage.test.ts
// A discovery run must say whether it saw the market or a corner of it.
//
// The failure this closes: a run that read 9 of its 15 searches before tripping a lead cap
// reported EXACTLY the same as one that worked its whole plan — a lead count, and nothing else.
// So 175 leads out of roughly 4,500 South East schools presented itself as a finished search, and
// nothing on screen invited the reader to doubt it. The worker already computed the distinction
// (`stopped`) and collapsed it into `done` before it could be persisted.
//
// Two independent facts, and conflating them is the whole trap:
//   • Did we finish OUR PLAN?   — stopReason
//   • Is there more OUT THERE?  — the newness rate
// A run can finish its plan and still have barely scratched the market. That is the schools case,
// and "completed" on its own would be true and still misleading.
//
// Source-scan for the worker/API wiring (an LLM+network round trip would be slow and flaky), and
// direct evaluation for the copy, which is where the honesty actually lives.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nDiscovery run coverage\n');

const WORKER = read('netlify/functions/process-discovery-jobs.ts');
const API = read('netlify/functions/discovery-campaigns.ts');
const UI = read('src/components/assistant-discovery-campaigns.js');

// ── The worker records WHICH cap, not merely THAT one tripped ──────────────────────────────────

check('each cap reports itself distinctly', () => {
    // "Stopped early" is not actionable alone: raising a lead cap is the fix for one of these and
    // useless for the others.
    for (const reason of ['search_cap', 'cost_cap', 'token_cap', 'lead_cap', 'month_cap']) {
        assert.ok(WORKER.includes(`'${reason}'`), `the worker must be able to report ${reason}`);
    }
});

check('the old single combined cap test is gone, not merely supplemented', () => {
    // It set one boolean for four different causes. Leaving it in place beside the new branches
    // would mean whichever ran first decided the reason.
    assert.ok(!/stopped = true/.test(WORKER), 'the undifferentiated `stopped = true` flag is back');
});

check('finishing the plan is recorded as its own outcome', () => {
    assert.ok(WORKER.includes("'plan_complete'"), 'a run that worked every query must say so');
});

// ── Persistence ────────────────────────────────────────────────────────────────────────────────

check('coverage rides on the cursor jsonb, with no new columns', () => {
    // ⚠️ Deliberate. New columns would need DDL landing on staging AND prod BEFORE the code that
    // names them — every db.select() lists every column, so the window between push and migration
    // would break reads of this table. A jsonb key cannot half-apply.
    assert.match(WORKER, /coverage\?: Coverage/, 'Coverage must be part of the Cursor shape');
    assert.ok(
        !/discovery_jobs.*ADD COLUMN|stopReason: text\(/i.test(WORKER + read('db/schema.ts')),
        'coverage must not have become a column without a migration conversation',
    );
});

check('the resume path preserves the tally instead of rebuilding the cursor', () => {
    // ⚠️ The cursor used to be written as `{ flat, queryIndex }`, which drops every other key. A
    // tally accumulated over five slices would be erased by the sixth — and a run spans many ticks,
    // so this is the common path, not the edge case.
    // Asserted on the INVARIANT (the spread) rather than the exact field list — the write
    // legitimately gained `flat` when pagination let a plan grow mid-run, and an exact-string
    // assertion just fails on every honest change while catching no real regression.
    assert.match(WORKER, /cursor: \{ \.\.\.cursor,[^}]*queryIndex: nextIndex,[^}]*coverage[^}]*\}/,
        'the resume write must spread the existing cursor');
    assert.ok(
        !/cursor: \{ flat: cursor\.flat, queryIndex: nextIndex \}/.test(WORKER),
        'the rebuild-from-two-keys write is back — it silently drops coverage',
    );
});

check('a run carries its tally forward across slices', () => {
    assert.match(WORKER, /cursor\.coverage \?\? \{ queriesRun: 0, resolved: 0, inserted: 0 \}/,
        'coverage must resume from the cursor, not restart per tick');
});

check('the monthly allowance is not relabelled as a per-run cap', () => {
    // It shares enterPromoting with the per-run paths; without its own write it would inherit
    // whatever the searching stage last said.
    const i = WORKER.indexOf('monthTotal >= guardrails.maxLeadsPerMonth');
    assert.ok(i > 0, 'the monthly cap check must still exist');
    assert.match(WORKER.slice(i, i + 700), /stopReason: 'month_cap'/, 'the monthly cap must record itself');
});

// ── The API exposes it on BOTH surfaces ────────────────────────────────────────────────────────

check('both the list and the single-campaign query return coverage', () => {
    // The card renders from the list; the detail panel from the single fetch. A field on one and
    // not the other is how two surfaces come to disagree about the same run.
    for (const field of ['latestRunStopReason', 'latestRunQueriesRun', 'latestRunQueriesPlanned', 'latestRunResolved', 'latestRunNewDomains']) {
        const hits = API.split(`${field}:`).length - 1;
        assert.ok(hits >= 3, `${field} must appear in both selects and the mapper (found ${hits})`);
    }
});

check('an unmeasured run stays null rather than being coerced to zero', () => {
    // Runs predating this have no coverage. Number(null) is 0, which would render as "0 of 0
    // searches" — a confident statement about something never measured.
    assert.ok(
        !/latestRunStopReason: Number\(/.test(API),
        'coverage fields must not be coerced with Number()',
    );
});

// ── The copy, which is where the honesty actually lives ────────────────────────────────────────

/** Evaluate coverageLine() out of the component without booting a browser. */
function coverageLine(c: Record<string, unknown>): string | null {
    const src = UI.slice(UI.indexOf('function coverageLine(c) {'));
    const body = src.slice(0, src.indexOf('\n  }\n') + 4);
    return new Function(`${body}\nreturn coverageLine(arguments[0]);`)(c) as string | null;
}

const CAPPED_RUN = {
    latestRunStopReason: 'lead_cap', latestRunQueriesRun: 9, latestRunQueriesPlanned: 15,
    latestRunResolved: 90, latestRunNewDomains: 88,
};

check('a capped run says it stopped early, how far it got, and that more remained', () => {
    const line = coverageLine(CAPPED_RUN)!;
    assert.match(line, /Stopped early/);
    assert.match(line, /9 of 15 searches/, 'the reader needs the actual progress, not just "early"');
    assert.match(line, /sample rather than the whole market/, 'it must say the list is incomplete');
});

check('a completed plan that is still finding new companies does NOT claim to be finished', () => {
    // ⚠️ The schools case, and the subtlest of the set. Every query ran, so the plan is complete —
    // but 88 of 90 companies were new, meaning the market is nowhere near exhausted. A bare
    // "completed" here is true and misleading.
    const line = coverageLine({ ...CAPPED_RUN, latestRunStopReason: 'plan_complete' })!;
    assert.match(line, /all 15 searches/);
    assert.match(line, /many more out there/, 'a high newness rate must be surfaced as "more exists"');
    assert.match(line, /narrowing|register/, 'it must offer the reader a next move');
});

check('a completed plan that is mostly re-finding the same companies says so', () => {
    const line = coverageLine({
        latestRunStopReason: 'plan_complete', latestRunQueriesRun: 15, latestRunQueriesPlanned: 15,
        latestRunResolved: 90, latestRunNewDomains: 4,
    })!;
    assert.match(line, /already on this list/, 'saturation is the one case where "we found what we can" is honest');
    assert.ok(!/many more out there/.test(line));
});

check('the monthly allowance does not tell the reader to re-run', () => {
    const line = coverageLine({ ...CAPPED_RUN, latestRunStopReason: 'month_cap' })!;
    assert.match(line, /monthly lead allowance/);
    assert.match(line, /will not find more/, 'a re-run today changes nothing — saying otherwise wastes their time');
});

check('a tiny sample never claims the market is unexhausted', () => {
    // 2 of 2 new proves nothing. Without a floor, every first-ever run would shout "many more".
    const line = coverageLine({
        latestRunStopReason: 'plan_complete', latestRunQueriesRun: 1, latestRunQueriesPlanned: 1,
        latestRunResolved: 2, latestRunNewDomains: 2,
    })!;
    assert.ok(!/many more out there/.test(line), 'the newness claim needs a meaningful sample behind it');
});

check('an unmeasured run says nothing at all', () => {
    // Silence beats a guess about a run we never measured — and every run before this shipped is
    // in that state.
    assert.strictEqual(coverageLine({ latestRunStopReason: null }), null);
    assert.strictEqual(coverageLine({}), null);
});

check('both surfaces render the line', () => {
    const hits = UI.split('coverageLine(c)').length - 1;
    assert.ok(hits >= 4, `expected the card and the detail panel to render it (found ${hits} references)`);
});

console.log(`\n${passed} checks passed\n`);
