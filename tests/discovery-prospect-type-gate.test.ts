// tests/discovery-prospect-type-gate.test.ts
// The prospect-type gate: src/config/icp-profile.ts (vocabulary + prompt) and the clamp in
// normaliseLeadCard (src/lib/discovery-scoring.ts).
//
// The fixtures are the two real leads from the prod run of 2026-08-12 that the prose-only rule
// let through: treyd.io, embedded finance for e-commerce sellers, scored 75/hot, and
// idsfulfillment.com, a B2B third-party logistics provider, scored 72/hot. The campaign was
// hunting DTC brands. Both are suppliers TO that market and neither is "a software vendor or
// agency", which is all the old instruction named — see the note above PROSPECT_TYPES.
//
// What is actually under test is that the verdict is now ENFORCED rather than requested: the
// model's own classification is data, and the clamp is code that runs whether or not the same
// pass chose to honour it.
// Run:  npx tsx tests/discovery-prospect-type-gate.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DISQUALIFIED_MAX_SCORE,
    PROSPECT_TYPES,
    PROSPECT_TYPE_RULE,
    isDisqualifyingProspectType,
} from '../src/config/icp-profile';
import { applyProspectType, normaliseLeadCard } from '../src/lib/discovery-scoring';
import { isLeadDeliverable, resolveLeadRecipient } from '../src/config/lead-recipient';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

// ── The two leads that got through ────────────────────────────────────────────

check('clamps the fintech that scored 75/hot (treyd.io)', () => {
    const card = normaliseLeadCard({
        leadName: 'Treyd',
        prospectType: 'supplier_to_target',
        score: 75,
        rating: 'hot',
        reasons: ['Serves e-commerce, a target industry'],
        suggestedNextStep: 'Email the founder',
        outreachDraft: { to: null, subject: 'Hello', body: 'Hi there' },
    }, 'Treyd');

    assert.equal(card.score, DISQUALIFIED_MAX_SCORE, 'a supplier must not keep its fit score');
    assert.equal(card.rating, 'cold', 'the model said hot; the gate outranks it');
    assert.equal(card.outreachDraft, null, 'a disqualified lead carries no draft');
    assert.equal(card.prospectType, 'supplier_to_target', 'the classification is kept for the Leads tab');
});

check('clamps the 3PL that scored 72/hot (idsfulfillment.com)', () => {
    const card = normaliseLeadCard({
        leadName: 'IDS Fulfillment',
        prospectType: 'supplier_to_target',
        score: 72,
        rating: 'hot',
        reasons: ['Strong e-commerce presence'],
    }, 'IDS Fulfillment');
    assert.equal(card.score, DISQUALIFIED_MAX_SCORE);
    assert.equal(card.rating, 'cold');
});

check('the clamp explains itself when it contradicts the model', () => {
    const card = normaliseLeadCard(
        { prospectType: 'supplier_to_target', score: 75, rating: 'hot', reasons: ['Serves e-commerce'] },
        'Treyd',
    );
    assert.match(card.reasons[0], /75/, 'the claimed score belongs in the reason');
    assert.match(card.reasons[0], /supplier_to_target/, 'the reason must name the verdict');
    assert.ok(card.reasons.includes('Serves e-commerce'), "the model's own reasons survive");
    assert.ok(card.reasons.length <= 6, 'reasons stay within the card cap');
});

check('no added reason when the model already scored it low itself', () => {
    // Nothing was overruled here, so there is nothing to explain — the model's prose stands alone.
    const card = normaliseLeadCard(
        { prospectType: 'aggregator', score: 5, rating: 'cold', reasons: ['A directory of retailers'] },
        'Some Directory',
    );
    assert.deepEqual(card.reasons, ['A directory of retailers']);
    assert.equal(card.score, 5, 'the clamp is a ceiling, not a floor');
});

// ── Every disqualifying type, and the one that is not ─────────────────────────

check('all six types are handled, and only target_business survives', () => {
    for (const type of PROSPECT_TYPES) {
        const card = normaliseLeadCard({ prospectType: type, score: 90, rating: 'hot' }, 'X');
        if (type === 'target_business') {
            assert.equal(card.score, 90, 'a real prospect keeps its score');
            assert.equal(card.rating, 'hot');
        } else {
            assert.equal(card.score, DISQUALIFIED_MAX_SCORE, `${type} must be clamped`);
            assert.equal(card.rating, 'cold', `${type} must be cold`);
        }
    }
});

check('a disqualified lead is NOT promoted to doNotContact', () => {
    // "Not worth emailing" and "must never be emailed" are different verdicts. Merging them would
    // put every 3PL in the suppression path and make the do-not-contact gate mean less.
    const card = normaliseLeadCard({ prospectType: 'supplier_to_target', score: 75 }, 'Treyd');
    assert.equal(card.doNotContact, false);
    assert.equal(card.doNotContactReason, null);
});

check('doNotContact still wins on its own', () => {
    const card = normaliseLeadCard({
        prospectType: 'target_business', score: 88, rating: 'hot',
        outreachDraft: { to: 'a@b.com', subject: 's', body: 'b' },
        doNotContact: true, doNotContactReason: 'Competitor',
    }, 'X');
    assert.equal(card.outreachDraft, null);
    assert.equal(card.doNotContact, true);
});

// ── The false-positive guard: silence must never clamp ────────────────────────

check('an absent or unrecognised prospectType leaves the card alone', () => {
    // The manual score_lead path in lead-generation.ts shares this normaliser and never asks for
    // the field; cards written before the gate existed have none either. Clamping on silence would
    // freeze every one of them at 10 — a real customer lost, looking like a scoring opinion.
    for (const raw of [
        { score: 85, rating: 'hot' },
        { prospectType: null, score: 85, rating: 'hot' },
        { prospectType: 'TARGET_BUSINESS', score: 85, rating: 'hot' },
        { prospectType: 'something_new', score: 85, rating: 'hot' },
        { prospectType: 42, score: 85, rating: 'hot' },
    ]) {
        const card = normaliseLeadCard(raw, 'X');
        assert.equal(card.score, 85, `unrecognised prospectType must not clamp: ${JSON.stringify(raw)}`);
        assert.equal(card.rating, 'hot');
        assert.equal(card.prospectType, null, 'only a known value is recorded');
    }
});

check('isDisqualifyingProspectType rejects non-members and target_business', () => {
    assert.equal(isDisqualifyingProspectType('target_business'), false);
    assert.equal(isDisqualifyingProspectType('supplier_to_target'), true);
    assert.equal(isDisqualifyingProspectType('media'), true);
    assert.equal(isDisqualifyingProspectType(''), false);
    assert.equal(isDisqualifyingProspectType(undefined), false);
    assert.equal(isDisqualifyingProspectType({ toString: () => 'media' }), false);
});

// ── Retro-fitting the gate to leads scored before it existed ──────────────────

check('applyProspectType clamps a stored card, and is idempotent', () => {
    const stored = normaliseLeadCard(
        { leadName: 'Treyd', score: 75, rating: 'hot', reasons: ['Serves e-commerce'], outreachDraft: { to: 'a@b.com', subject: 's', body: 'b' } },
        'Treyd',
    );
    assert.equal(stored.score, 75, 'a pre-gate card has no prospectType and must not clamp');

    const once = applyProspectType(stored, 'supplier_to_target');
    assert.equal(once.score, DISQUALIFIED_MAX_SCORE);
    assert.equal(once.rating, 'cold');
    assert.equal(once.outreachDraft, null);

    // A re-run after a partial failure must not stack reasons or move the score again.
    const twice = applyProspectType(once, 'supplier_to_target');
    assert.deepEqual(twice, once, 'replaying a clamped card must be a no-op');
});

check('applyProspectType(card, null) leaves a card completely alone', () => {
    // What the backfill does when the model fails or returns junk. Clamping on silence would demote
    // a real customer on a network error.
    const stored = normaliseLeadCard(
        { leadName: 'A Real Brand', score: 82, rating: 'hot', reasons: ['Matches'], outreachDraft: { to: 'a@b.com', subject: 's', body: 'b' } },
        'A Real Brand',
    );
    assert.deepEqual(applyProspectType(stored, null), stored);
});

check('a demoted lead leaves the Review tab but keeps its address', () => {
    // The Review tab needs a drafted body AND a recipient. The clamp nulls the draft, so the lead
    // drops back to Leads and cannot be approved into a real send — while contactEmail, which is an
    // enrichment stamp and not a card key, is untouched by the card write.
    const before = normaliseLeadCard(
        { leadName: 'IDS Fulfillment', score: 72, rating: 'hot', outreachDraft: { to: null, subject: 's', body: 'Hello there' } },
        'IDS Fulfillment',
    );
    const stamps = { contactEmail: 'hello@idsfulfillment.com' };
    assert.equal(isLeadDeliverable({ ...before, ...stamps }), true, 'it is in the Review tab to begin with');

    const after = applyProspectType(before, 'supplier_to_target');
    assert.equal(isLeadDeliverable({ ...after, ...stamps }), false, 'it must leave the Review tab');
    assert.equal(resolveLeadRecipient({ ...after, ...stamps }), 'hello@idsfulfillment.com', 'the address survives');
});

check('the backfill MERGES the card into assistant_records.data, never replaces it', () => {
    // The single most destructive mistake available here. recordEnrichment() stamps contactEmail,
    // emailKind, emailSource and emailFoundOn on top of the card in `data`; a bare `data: card`
    // write would silently delete every scraped address the pipeline has — 4 of 64 on the run this
    // was built for, and the scarcest thing in it.
    const src = read('scripts/rescore-lead-prospect-type.ts');
    assert.match(src, /COALESCE\(\$\{assistantRecords\.data\}, '\{\}'::jsonb\) \|\| /,
        'the assistant_records write is no longer a jsonb merge');
    assert.ok(!/\.set\(\{[^}]*\bdata:\s*(after|card)\b/s.test(src),
        'the card is being assigned to `data` wholesale — that wipes the enrichment stamps');
});

check('the backfill never classifies and writes in one command', () => {
    // temperature 0 is not determinism — measured on staging, nationalgeographic.org came back
    // "media" on one run and "target_business" on the next. If --apply re-classified, the operator
    // would review one diff and commit a different one. --apply replays a saved plan instead.
    const src = read('scripts/rescore-lead-prospect-type.ts');
    assert.ok(/if \(apply\) \{[\s\S]*?if \(!planFile\)[\s\S]*?process\.exit\(1\)/.test(src),
        '--apply must refuse to run without --plan');
    assert.ok(!/classifyProspects/.test(src.slice(src.indexOf('async function applyPlan'))),
        'applyPlan must not call the classifier');
});

check('a plan refuses to land on a database it was not built against', () => {
    // Staging and prod share lead ids, so an unpinned plan is one flag away from rewriting the
    // wrong environment's leads.
    const src = read('scripts/rescore-lead-prospect-type.ts');
    assert.ok(/doc\.target !== target/.test(src), 'the plan target is no longer compared');
    assert.ok(/REFUSING TO APPLY/.test(src), 'the mismatch must abort, not warn');
});

check('the backfill is dry-run by default and names its target', () => {
    const src = read('scripts/rescore-lead-prospect-type.ts');
    assert.ok(src.includes("args.includes('--apply')"), 'writes must be opt-in');
    assert.ok(/describeTarget/.test(src), 'the script must print which database it is pointed at');
    // .env here is staging and these leads are in production — a script that writes without saying
    // where is one command away from rewriting the wrong environment's leads.
    assert.ok(src.includes('--url-var'), 'the target database must be overridable');
});

// ── Prompt and schema must stay in step ───────────────────────────────────────

check('the rule names every type in the vocabulary', () => {
    for (const type of PROSPECT_TYPES) {
        assert.ok(PROSPECT_TYPE_RULE.includes(`"${type}"`), `PROSPECT_TYPE_RULE never defines "${type}"`);
    }
});

check('the discovery prompt asks for the field, and offers every value', () => {
    // Asking for the reasoning without asking for the field is how the old prose rule failed: the
    // model could agree with it and still not act on it, and nothing downstream could tell.
    const src = read('src/lib/discovery-scoring.ts');
    assert.ok(src.includes('PROSPECT_TYPE_RULE'), 'discovery-scoring.ts must include the rule');
    assert.ok(src.includes('"prospectType":'), 'the JSON schema in the prompt must ask for prospectType');
    for (const type of PROSPECT_TYPES) {
        assert.ok(src.includes(`"${type}"`), `the prompt schema omits "${type}", so the model cannot return it`);
    }
});

check('the manual score_lead path deliberately does NOT carry the gate', () => {
    // A human typed that company in. A model overruling them is a bug, not a filter — the rule's
    // own doc comment says so, and this is the guard that keeps it true.
    const src = read('netlify/functions/lead-generation.ts');
    assert.ok(!src.includes('PROSPECT_TYPE_RULE'),
        'lead-generation.ts must not apply the prospect-type gate to manually entered leads');
});

check('the old prose rule is gone, not merely supplemented', () => {
    // Leaving "a software vendor or agency that SELLS TO the target market" in place next to the
    // new rule would re-teach the narrow enumeration that missed a lender and a 3PL.
    const src = read('src/lib/discovery-scoring.ts');
    assert.ok(!src.includes('a software vendor or agency that SELLS TO'),
        'the superseded prose rule is still in the discovery prompt');
});

console.log(`\n${passed} checks passed.`);
