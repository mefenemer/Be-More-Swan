// tests/discovery-scoring-time-budget.test.ts
// Lead discovery's scoring must finish inside the scheduled worker's tick (2026-10-25). One call for
// a ten-candidate page took 22–25s on Haiku 4.5 and Opus 5.5 alike — near the limit on its own,
// before the tick's search and home-page reads. A page is now scored in small groups side by side,
// under one time budget, with no SDK retries; a call that overruns leaves unscored cards (which are
// kept, never discarded) instead of the platform killing the tick.
// Run:  npx tsx tests/discovery-scoring-time-budget.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { SCORE_BUDGET_MS, SCORE_GROUP_SIZE, discardReason } from '../src/lib/discovery-scoring';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const src = readFileSync(new URL('../src/lib/discovery-scoring.ts', import.meta.url), 'utf8');
const fnBody = src.slice(src.indexOf('export async function scoreCandidates('), src.indexOf('// RE-SCORING ON NEW EVIDENCE'));

check('a page is split into small groups that are scored at the same time', () => {
    assert.ok(SCORE_GROUP_SIZE >= 1 && SCORE_GROUP_SIZE <= 4, 'small enough that one call is a fraction of a page');
    assert.ok(fnBody.includes('if (depth === 0 && !grouped && candidates.length > SCORE_GROUP_SIZE)'));
    assert.ok(fnBody.includes('await Promise.all(groups.map((g) => scoreCandidates(g, icp, sender, rulesBlock, searchContext, modelChoice, 0, true, endsAt)))'), 'side by side, not one after another');
    // Order is kept: groups are cut in order and their cards concatenated in order.
    assert.ok(fnBody.includes('cards: parts.flatMap((p) => p.cards)'));
});

check('every call is held to what is left of one page budget, with no SDK retries', () => {
    assert.ok(SCORE_BUDGET_MS > 0 && SCORE_BUDGET_MS <= 20_000, 'leaves the tick room for its search and page reads');
    assert.ok(fnBody.includes('if (!endsAt) endsAt = Date.now() + SCORE_BUDGET_MS;'));
    assert.ok(fnBody.includes('{ timeout: Math.max(MIN_SCORE_CALL_MS, endsAt - Date.now()), maxRetries: 0 }'));
});

check('the blank-card retry only starts while the budget has room, and shares it', () => {
    assert.ok(fnBody.includes('depth < MAX_RESCORE_DEPTH && endsAt - Date.now() > MIN_SCORE_CALL_MS'));
    assert.ok(fnBody.includes('modelChoice, depth + 1, true, endsAt)'), 'a retry never re-splits and never restarts the clock');
});

check('a card left unscored by the budget is kept, never discarded', () => {
    assert.strictEqual(discardReason({ scoringFailed: true, prospectType: 'media', outsideArea: 'Ohio' } as never), null);
});

console.log(`\n${passed} passed`);
