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
import { isBlankCard, normaliseLeadCard, unscoredCard } from '../src/lib/discovery-scoring';
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

check('the blank shape is detectable, and a real cold verdict is not mistaken for it', () => {
    // ⚠️ Keyed on the ABSENCE of everything a verdict carries, not on score 0 alone. A lead the
    // scorer rejected always says why, so requiring no reasons AND no prospect type is what keeps
    // a genuine cold verdict out of the retry path.
    assert.ok(isBlankCard(normaliseLeadCard(undefined, 'Acme')), 'the fallback card must be detectable');
    assert.ok(isBlankCard(normaliseLeadCard({}, 'Acme')), 'an empty object is the same failure');

    // A real verdict: scored 0 but with reasons and a classification. Must NOT be retried or
    // relabelled — retrying it pays twice for the same answer, and relabelling it erases a verdict.
    const realVerdict = normaliseLeadCard(
        { leadName: 'Acme', score: 0, rating: 'cold', reasons: ['Outside the target industries'], prospectType: 'aggregator' },
        'Acme',
    );
    assert.ok(!isBlankCard(realVerdict), 'a scored, reasoned, classified cold lead is a VERDICT, not a blank');
    // Reasons alone are enough to mark it judged.
    assert.ok(!isBlankCard(normaliseLeadCard({ score: 0, reasons: ['No trading signals found'] }, 'Acme')));
});

check('an unscored lead says so, and does not pass for a rejection', () => {
    const card = unscoredCard('Acme Primary School');
    assert.equal(card.scoringFailed, true, 'the marker is what every surface reads');
    assert.equal(card.leadName, 'Acme Primary School');
    assert.ok(card.reasons.length > 0, 'a blank reasons array is what made these invisible');
    // ⚠️ The reason must deny the rejection outright. "No reasons given" beside a cold rating reads
    // as a terse verdict; this has to say that no verdict exists.
    assert.match(card.reasons[0], /could not be scored/i);
    assert.match(card.reasons[0], /NOT been judged/i, 'it must deny being a poor-fit verdict, not just omit one');
    assert.match(card.suggestedNextStep, /again/i, 'an unscored lead needs a next action, or it is just a dead end');
    // Still detectably blank-shaped underneath — the marker is additive, not a disguise.
    assert.equal(card.score, 0);
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

console.log('\n──── the retry: a blank batch is halved, not accepted ────');

check('scoreCandidates halves and re-scores rather than filing blanks', () => {
    const fn = SCORING.slice(SCORING.indexOf('export async function scoreCandidates'));
    // Halving is the mechanism: the SAME prompt over fewer candidates needs strictly fewer output
    // tokens, so the retry cannot fail the way the original did. A plain re-issue of the identical
    // batch would just truncate again at the same point, which is a retry that cannot work.
    assert.ok(/blanks\.slice\(0, half\)/.test(fn) && /Math\.ceil\(blanks\.length \/ 2\)/.test(fn),
        'the retry no longer SPLITS the batch — re-issuing the same batch reproduces the same truncation');
    assert.ok(/depth \+ 1/.test(fn), 'the recursion no longer deepens, so the ceiling can never be reached');
    assert.ok(/candidates\.length > 1/.test(fn),
        'a single candidate must not recurse — it is the smallest request this prompt can make');
    assert.ok(/MAX_RESCORE_DEPTH/.test(SCORING), 'the recursion is unbounded — each level costs a model call per half');
    // Token accounting has to survive the recursion or a retried run under-reports its spend
    // against the cost guardrails.
    assert.ok(/inputTokens \+= retry\.inputTokens/.test(fn) && /outputTokens \+= retry\.outputTokens/.test(fn),
        'retry tokens are not accumulated — the run would under-report spend against its cost cap');
    // And the results must land back on the ORIGINAL indices; the caller aligns cards to
    // candidates by position, so a misplaced retry stamps one company's verdict onto another.
    assert.ok(/cards\[i\] = retry\.cards\[k\]/.test(fn), 'retried cards are no longer written back by original index');
});

check('whatever is still blank is marked, never left to pass as cold', () => {
    const fn = SCORING.slice(SCORING.indexOf('export async function scoreCandidates'));
    assert.ok(/isBlankCard\(cards\[i\]\)\) cards\[i\] = unscoredCard/.test(fn),
        'a card that survives the retry still blank is filed as a cold verdict nobody made');
});

check('the worker writes NULL rating for an unscored lead, not cold', () => {
    const WORKER = readFileSync(join(root, 'netlify/functions/process-discovery-jobs.ts'), 'utf8');
    assert.ok(/card\.scoringFailed === true/.test(WORKER), 'the worker no longer detects an unscored card');
    assert.ok(/rating: unscored \? null : card\.rating/.test(WORKER),
        "an unscored lead is being written as 'cold' — that is a verdict nobody made, and it is the whole defect");
    assert.ok(/score: unscored \? null : card\.score/.test(WORKER), 'a score of 0 nobody assigned is still a claim');
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
