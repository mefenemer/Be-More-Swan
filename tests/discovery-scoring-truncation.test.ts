// tests/discovery-scoring-truncation.test.ts
// A scoring reply cut off at the token ceiling must not file every candidate as a cold blank.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// Measured on a prod tenant 2026-08-25: 132 of 500 discovered leads (26%) carried no prospectType,
// a rating of cold, a score of exactly 0, and — in 131 cases — no reasons at all. Not one untyped
// lead in the workspace was rated anything but cold, which is the giveaway: a model that merely
// omitted the field now and then would leave untyped leads across all three ratings. These were
// never scored. They were searched for, paid for, and filed as verdicts.
//
// The chain, all of it by design until the last step:
//   1. scoreCandidates asks for one object per candidate, each carrying a COMPLETE outreach email.
//   2. max_tokens was 2048 — five or six candidates' worth. A SERP page inserts up to ten.
//   3. The array is cut off mid-string, so it never closes.
//   4. parseModelJsonArray returns null rather than a partial list (correctly — a partial list
//      would desync the cards from the candidates).
//   5. Every candidate therefore gets normaliseLeadCard(undefined): score 0, no reasons, no
//      prospectType, rating falling through to 'cold'.
//   6. NOTHING SAID SO. The catch only sees transport errors; a truncation is a 200.
//
// ⚠️ Step 5 is the reason this matters beyond the wasted spend: an unscored lead is
// indistinguishable from a lead the scorer rejected, so it is invisible in every count, and
// ENRICH_ELIGIBLE_SQL (src/config/lead-contact-state.ts) will not look one up.
//
// Run:  npx tsx tests/discovery-scoring-truncation.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseLeadCard } from '../src/lib/discovery-scoring';
import { parseModelJsonArray } from '../src/utils/model-json';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCORING = readFileSync(join(root, 'src/lib/discovery-scoring.ts'), 'utf8');

console.log('\n──── the blank card, and why it looks like a verdict ────');

check('an absent entry produces EXACTLY the shape the prod data showed', () => {
    // This is the diagnosis, executable. If this card ever stops looking like this, the 132 leads
    // that motivated the fix would no longer be explained by it.
    const card = normaliseLeadCard(undefined, 'Acme Primary School');
    assert.equal(card.score, 0, 'a blank card must score 0 — that is what made the cohort findable');
    assert.equal(card.rating, 'cold', 'the rating falls through to cold, which is why it passes for a verdict');
    assert.equal(card.prospectType, null, 'no prospect type — the field that exposed the cohort');
    assert.deepEqual(card.reasons, [], 'no reasons: a real cold verdict names the criteria it missed');
    assert.equal(card.leadName, 'Acme Primary School', 'the fallback name is all that survives');
});

check('a blank card is NOT enrichment-eligible, so the loss compounds', () => {
    // Not a separate bug — the reason an unscored lead is worse than a wasted API call. It is
    // filed as cold with no prospect type, which is precisely the pair ENRICH_ELIGIBLE_SQL
    // refuses, so it never gets an address either.
    const card = normaliseLeadCard(undefined, 'Acme');
    assert.equal(card.rating, 'cold');
    assert.equal(card.prospectType, null);
});

console.log('\n──── a truncated array is a TOTAL loss, not a partial one ────');

check('parseModelJsonArray returns null for an array cut off mid-string', () => {
    // The behaviour is correct and must stay — a partial list would misalign cards with
    // candidates, which is far worse than losing the batch. It is pinned here because it is what
    // turns "the last two entries were cut off" into "all ten candidates are blank".
    const truncated = '[{"leadName":"A","score":80,"outreachDraft":{"body":"Dear Head of Sc';
    assert.equal(parseModelJsonArray(truncated), null, 'a partial list must never be returned');
    // The complete case still parses, or the whole pipeline is broken.
    assert.deepEqual(parseModelJsonArray('[{"leadName":"A"}]'), [{ leadName: 'A' }]);
});

console.log('\n──── the ceiling clears a full batch ────');

check('scoreCandidates has room for a whole SERP page of outreach drafts', () => {
    const start = SCORING.indexOf('export async function scoreCandidates');
    assert.ok(start !== -1, 'scoreCandidates is gone');
    const fn = SCORING.slice(start, SCORING.indexOf('export', start + 10));
    const m = fn.match(/max_tokens:\s*(\d+)/);
    assert.ok(m, 'scoreCandidates no longer sets max_tokens');
    const ceiling = Number(m![1]);
    // A candidate costs 250-400 output tokens because each carries a full email. Ten per page.
    // 2048 was the value that lost 26% of a tenant's leads; anything in that region is the bug.
    assert.ok(ceiling >= 8192,
        `max_tokens is ${ceiling} — a ten-candidate page needs ~4000 and 2048 silently blanked whole pages. Output is billed on tokens produced, so the headroom is free.`);
});

check('every batched scoring call reports a truncation instead of swallowing it', () => {
    assert.ok(/function warnIfTruncated/.test(SCORING), 'the truncation tripwire is gone');
    // All three model calls in this file, named so a new one cannot quietly skip it.
    for (const site of ['scoreCandidates', 'classifyProspects', 'rescoreWithIntel']) {
        assert.ok(new RegExp(`warnIfTruncated\\('${site}'`).test(SCORING),
            `${site} no longer reports a truncated or unparseable reply — that silence is the whole defect`);
    }
    assert.ok(/stop_reason/.test(SCORING),
        'nothing reads stop_reason, so a token-ceiling cut-off is indistinguishable from an empty answer');
});

check('the tripwire fires on the three distinct ways a batch can come back short', () => {
    const start = SCORING.indexOf('function warnIfTruncated');
    const fn = SCORING.slice(start, SCORING.indexOf('\n}', start));
    assert.ok(/max_tokens/.test(fn), 'the ceiling case is no longer distinguished — it is the actionable one');
    assert.ok(/got === 0/.test(fn), 'a reply that parsed to nothing no longer warns');
    assert.ok(/got < expected/.test(fn), 'a short-but-parseable batch no longer warns');
});

console.log(`\n${passed} checks passed.`);
