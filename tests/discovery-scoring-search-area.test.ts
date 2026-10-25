// tests/discovery-scoring-search-area.test.ts
// The scorer must know where the search asked for businesses, and code must enforce its answer.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// Customer report, 2026-10-18: a UK search returned US leads. Even with the right country sent to
// the search provider, some foreign businesses rank — and the scorer could not catch them, because
// it was shown the profile (industries, headcount, exclusions) and never the search. A location
// typed into the search reached the query generator and then vanished.
//
// Now the scorer gets the search's own words and the country it names, answers "outsideArea", and
// code caps the card exactly as it does for the exclusion gate. A foreign country-code domain
// (.com.au on a UK search) settles it without the model.
//
// Run:  npx tsx tests/discovery-scoring-search-area.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    isBlankCard, markOutsideArea, normaliseLeadCard, searchAreaBlock, unscoredCard,
} from '../src/lib/discovery-scoring';
import { isForeignDomain, resolveSearchArea } from '../src/lib/discovery-search-area';
import { EXCLUDED_MAX_SCORE } from '../src/config/icp-profile';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCORING = readFileSync(join(root, 'src/lib/discovery-scoring.ts'), 'utf8');
const WORKER = readFileSync(join(root, 'netlify/functions/process-discovery-jobs.ts'), 'utf8');

const UK = resolveSearchArea(['Independent coffee shops in the UK'])!;

console.log('\n──── the prompt carries the search ────');

check('the block quotes the search and names its country', () => {
    const block = searchAreaBlock({ idea: 'Independent coffee shops in the UK', area: UK });
    assert.ok(block.includes('"Independent coffee shops in the UK"'), 'the search in the user\'s own words');
    assert.ok(block.includes('businesses in United Kingdom'), 'the resolved country, stated outright');
    assert.ok(block.includes('"outsideArea"'), 'asks for the field code enforces');
    assert.ok(/never guess/i.test(block), 'no evidence must mean null, not a guess');
});

check('a search naming a place the table does not know still reaches the scorer', () => {
    const block = searchAreaBlock({ idea: 'Cafés in Tromsø', area: null });
    assert.ok(block.includes('Tromsø'), 'the scorer reads the place even when no country was resolved');
    assert.ok(!block.includes('The search is for businesses in'), 'no country is invented');
});

check('no search → no block, so the prompt is unchanged for other callers', () => {
    assert.equal(searchAreaBlock(null), '');
    assert.equal(searchAreaBlock({ idea: '   ', area: null }), '');
});

check('scoreCandidates puts the block and the field in the prompt only when there is a search', () => {
    assert.ok(SCORING.includes("${areaBlock ? `\\n${areaBlock}\\n` : ''}"), 'block interpolated into the system prompt');
    assert.ok(/\$\{areaBlock \? `\s*\n\s*"outsideArea"/.test(SCORING), 'outsideArea added to the JSON schema with it');
});

check('the halving retry keeps the search context', () => {
    // A retried batch scored without the context would lose the location gate on exactly the
    // candidates the first attempt could not finish.
    assert.ok(SCORING.includes('icp, sender, rulesBlock, searchContext, modelChoice, depth + 1)'));
});

check('the worker passes the search context to the scorer', () => {
    assert.ok(WORKER.includes("await scoreCandidates(toScore, icp, sender, rulesBlock, searchContext, await loadRoleModel(db, 'lead_qualifier'))"));
});

console.log('\n──── code enforces the answer ────');

check('a hot candidate the model places outside the area is capped and cold, with no draft', () => {
    const card = normaliseLeadCard({
        leadName: 'Ohio Coffee Co', score: 82, rating: 'hot', prospectType: 'target_business',
        reasons: ['Independent coffee shop'], outsideArea: 'Ohio, United States',
        outreachDraft: { to: null, subject: 'Hi', body: 'Hello there' },
    }, 'Ohio Coffee Co');
    assert.equal(card.score, EXCLUDED_MAX_SCORE);
    assert.equal(card.rating, 'cold', 'the model said hot; code must overrule it');
    assert.equal(card.outreachDraft, null, 'a polished email to a business we were not asked to find reads as ready to send');
    assert.equal(card.outsideArea, 'Ohio, United States');
    assert.ok(card.reasons[0].includes('outside the area this search asked for'), 'the cap explains itself');
});

check('inside the area (null) leaves the card alone', () => {
    const card = normaliseLeadCard({ score: 82, rating: 'hot', prospectType: 'target_business', reasons: ['x'], outsideArea: null }, 'A');
    assert.equal(card.score, 82);
    assert.equal(card.rating, 'hot');
    assert.equal('outsideArea' in card, false, 'absent rather than null, so old and new cards look the same');
});

check('a card marked outside the area is a verdict, not a blank to retry', () => {
    assert.ok(!isBlankCard(normaliseLeadCard({ outsideArea: 'Texas, United States' }, 'A')));
});

console.log('\n──── the domain settles it without the model ────');

check('a foreign country-code domain on a UK search is outside the area', () => {
    assert.equal(isForeignDomain('smithplumbing.com.au', UK), 'Australia');
    assert.equal(isForeignDomain('acme.ca', UK), 'Canada');
    assert.equal(isForeignDomain('acme.us', UK), 'United States');
});

check('UK, generic and vanity domains are never treated as foreign', () => {
    assert.equal(isForeignDomain('acme.co.uk', UK), null);
    assert.equal(isForeignDomain('acme.com', UK), null, '.com says nothing about where a business is');
    assert.equal(isForeignDomain('acme.io', UK), null, 'vanity ccTLDs are used worldwide');
    assert.equal(isForeignDomain('acme.co', UK), null);
});

check('no area resolved → nothing is foreign', () => {
    assert.equal(isForeignDomain('acme.com.au', null), null);
});

check('markOutsideArea caps the card and replaces an "unscored" placeholder', () => {
    const marked = markOutsideArea(unscoredCard('Acme'), 'Australia');
    assert.equal(marked.rating, 'cold');
    assert.equal(marked.outsideArea, 'Australia');
    assert.equal(marked.scoringFailed, undefined, '"could not be scored" is no longer the truth');
    assert.ok(marked.reasons[0].includes('Australia'));
    assert.equal(marked.reasons.length, 1, 'the placeholder reason is dropped');
});

check('scoreCandidates applies the domain check once, at the top level', () => {
    assert.ok(/if \(depth === 0 && searchContext\?\.area\)[\s\S]{0,300}isForeignDomain\(candidates\[i\]\.domain, searchContext\.area\)/.test(SCORING));
});

check('a re-score on new evidence keeps the location verdict', () => {
    assert.ok(SCORING.includes('outsideArea: current.outsideArea ?? null,'),
        'new evidence about a company does not move it to another country');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}.`);
