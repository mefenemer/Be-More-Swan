// tests/lead-exclusion-gate.test.ts
// An exclusion the user wrote down must be enforced in CODE, not requested in prose.
//
// ── What happened ────────────────────────────────────────────────────────────
// Restorative Futures' profile excluded "companies outside of the UK". Four US schools were scored
// hot and warm anyway — and the model had identified the geography correctly in every one, in its
// own reasons:
//
//   #255 "Located in US (West Virginia), outside UK exclusion zone"  → 45, warm
//   #134 "UK exclusion does not apply: located in New York, USA"     → hot
//   #225 "Location is Iowa, which is in scope"                       → 62, warm
//   #228 "Location is Ohio, USA; profile emphasizes UK"              → 68, warm
//
// It was not confused about the facts. The rule asked it to score AND to decide whether the rule
// applied, so it could do only the first, and nothing downstream could tell. That is the same
// failure the prospect-type gate was built for, and it now takes the same shape: the model emits
// its judgement as DATA and the clamp happens in normaliseLeadCard.
//
// ⚠️ The old rule was also written entirely about COMPETITORS — every example was a peer or rival.
// A geographic exclusion did not look like the thing the rule was describing.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseLeadCard } from '../src/lib/discovery-scoring';
import { EXCLUDE_PROFILE_RULE, EXCLUDED_MAX_SCORE, DISQUALIFIED_MAX_SCORE } from '../src/config/icp-profile';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nLead exclusion gate\n');

/** The West Virginia card, as the scorer actually returned it. */
const HAMPSHIRE_WV = {
    leadName: 'Hampshire County Schools', score: 45, rating: 'warm',
    reasons: ['Target industry match: School system serving multiple schools', 'Located in US (West Virginia), outside UK exclusion zone'],
    prospectType: 'target_business',
    outreachDraft: { to: null, subject: 'Restorative practice training', body: 'Dear colleague, ...' },
};

// ── The clamp ──────────────────────────────────────────────────────────────────────────────────

check('a card naming an exclusion is capped and cooled, whatever it scored', () => {
    const card = normaliseLeadCard({ ...HAMPSHIRE_WV, excludedBy: 'companies outside of the UK' }, 'Hampshire County Schools');
    assert.strictEqual(card.score, EXCLUDED_MAX_SCORE);
    assert.strictEqual(card.rating, 'cold');
});

check('an excluded candidate loses its outreach draft', () => {
    // A polished email to a market the business cannot serve is worse than none: it reads as ready
    // to send, and 20 of these were one click from going out.
    const card = normaliseLeadCard({ ...HAMPSHIRE_WV, excludedBy: 'companies outside of the UK' }, 'x');
    assert.strictEqual(card.outreachDraft, null);
});

check('the reason says which exclusion matched, and what it cost', () => {
    // Without this the card silently reads "cold, 10" and the user cannot tell a poor prospect from
    // an excluded one.
    const card = normaliseLeadCard({ ...HAMPSHIRE_WV, excludedBy: 'companies outside of the UK' }, 'x');
    assert.match(card.reasons[0], /companies outside of the UK/);
    assert.match(card.reasons[0], /45/, 'the original score belongs in the record');
});

check('a candidate with no exclusion is untouched', () => {
    const card = normaliseLeadCard({ ...HAMPSHIRE_WV, excludedBy: null }, 'x');
    assert.strictEqual(card.score, 45);
    assert.strictEqual(card.rating, 'warm');
    assert.ok(card.outreachDraft, 'a clean lead keeps its draft');
});

check('an absent field is not an exclusion', () => {
    // ⚠️ Cards scored before this existed have no `excludedBy`. Treating absent as excluded would
    // retroactively cold every lead in the estate.
    const card = normaliseLeadCard(HAMPSHIRE_WV, 'x');
    assert.strictEqual(card.score, 45);
    assert.strictEqual(card.excludedBy, null);
});

check('an excluded card that scored low is not raised', () => {
    const card = normaliseLeadCard({ ...HAMPSHIRE_WV, score: 3, excludedBy: 'competitors' }, 'x');
    assert.strictEqual(card.score, 3, 'the cap is a ceiling, never a floor');
});

check('exclusion and prospect-type gates compose', () => {
    const card = normaliseLeadCard(
        { ...HAMPSHIRE_WV, score: 90, prospectType: 'aggregator', excludedBy: 'companies outside of the UK' }, 'x');
    assert.ok(card.score <= Math.min(EXCLUDED_MAX_SCORE, DISQUALIFIED_MAX_SCORE));
    assert.strictEqual(card.rating, 'cold');
});

// ── The rule the model is given ────────────────────────────────────────────────────────────────

check('the rule is no longer only about competitors', () => {
    // Every example used to be a peer or rival, so a geographic exclusion did not resemble the
    // thing being described.
    assert.match(EXCLUDE_PROFILE_RULE, /PLACE|place/, 'the rule must say an exclusion can be geographic');
    assert.match(EXCLUDE_PROFILE_RULE, /outside of the UK/, 'and give the worked example that failed');
});

check('the rule closes the "outside the exclusion" reading', () => {
    // #255 read "outside the UK" as meaning outside the exclusion, and scored it warm.
    assert.match(EXCLUDE_PROFILE_RULE, /outside the stated territory IS a match/i);
});

check('the rule asks for a field, not a score adjustment', () => {
    assert.match(EXCLUDE_PROFILE_RULE, /"excludedBy"/, 'the judgement must be returned as data');
    assert.ok(!/score it 0-10/.test(EXCLUDE_PROFILE_RULE), 'asking for the score back is the failure being fixed');
});

// ── Every scoring surface must ask for it ──────────────────────────────────────────────────────

check('all three card schemas request excludedBy', () => {
    // A schema that omits it yields null forever, and the clamp reads a field nothing sets.
    const scoring = read('src/lib/discovery-scoring.ts');
    assert.strictEqual(scoring.split('"excludedBy":').length - 1, 2, 'discovery scoring AND the deep re-score');
    assert.match(read('netlify/functions/lead-generation.ts'), /"excludedBy":/, 'manual lead scoring');
});

check('the deep re-score carries the exclusion rule, not just the field', () => {
    // ⚠️ It writes a fresh card. Asking for `excludedBy` without telling it the rule would let
    // "Research again" quietly clear the flag and resurrect an excluded lead as hot.
    const scoring = read('src/lib/discovery-scoring.ts');
    const i = scoring.indexOf('You are re-reading ONE lead');
    assert.ok(i > 0);
    assert.match(scoring.slice(i, scoring.indexOf('const payload', i)), /\$\{EXCLUDE_PROFILE_RULE\}/,
        'the re-score prompt must carry the rule');
});

console.log(`\n${passed} checks passed\n`);
