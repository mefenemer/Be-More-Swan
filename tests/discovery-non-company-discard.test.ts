// tests/discovery-non-company-discard.test.ts
// Blog posts, directories, publishers and suppliers must not land in the Leads tab.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// Customer report, 2026-10-18: "the Lead Generator is returning blog posts". The scorer already
// classified them — prospectType content_page / media / aggregator / supplier_to_target — and the
// prospect-type gate capped them at cold. But the worker then promoted EVERY scored candidate into
// the Leads tab regardless, so the classification only changed the colour of the chip. A business
// outside the search's area went the same way.
//
// discardReason() now names the two cases where there is no lead to judge; the worker files those
// at 'discarded' instead of promoting them, on both the inline path and the promoting safety net.
//
// Run:  npx tsx tests/discovery-non-company-discard.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discardReason, normaliseLeadCard, unscoredCard } from '../src/lib/discovery-scoring';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(join(root, 'netlify/functions/process-discovery-jobs.ts'), 'utf8');

const card = (raw: Record<string, unknown>) => normaliseLeadCard({ score: 50, rating: 'warm', reasons: ['r'], ...raw }, 'Acme');

console.log('\n──── what counts as not-a-lead ────');

check('every non-business prospect type is discarded', () => {
    for (const t of ['content_page', 'media', 'aggregator', 'supplier_to_target', 'platform']) {
        assert.ok(discardReason(card({ prospectType: t })), `${t} must not become a lead`);
    }
});

check('a blog post is discarded with a reason that names it', () => {
    assert.ok(discardReason(card({ prospectType: 'content_page' }))!.includes('content_page'));
});

check('a business outside the search area is discarded', () => {
    assert.ok(discardReason(card({ prospectType: 'target_business', outsideArea: 'Ohio, United States' }))!.includes('Ohio'));
});

check('a real business that fits poorly is STILL a lead (cold, but the user\'s to judge)', () => {
    // ⚠️ The narrowness is the point. Hiding poor-fit businesses would be the scorer overruling
    // the user; only "there is no lead here" is discarded.
    assert.equal(discardReason(card({ prospectType: 'target_business', score: 5, rating: 'cold' })), null);
});

check('an ICP exclusion alone is not discarded — that gate already caps and blocks outreach', () => {
    assert.equal(discardReason(card({ prospectType: 'target_business', excludedBy: 'other training providers' })), null);
});

check('an unscored card is never discarded — nothing has judged it', () => {
    assert.equal(discardReason(unscoredCard('Acme')), null);
});

check('a card with no prospectType (manual path, pre-gate cards) is kept', () => {
    assert.equal(discardReason(card({})), null);
});

console.log('\n──── the worker honours it ────');

function between(src: string, start: string, end: string): string {
    const a = src.indexOf(start);
    assert.notEqual(a, -1, `landmark not found: ${start}`);
    const b = src.indexOf(end, a);
    assert.notEqual(b, -1, `landmark not found: ${end}`);
    return src.slice(a, b);
}

check('inline path: discard is checked BEFORE promoteOne, and skips it', () => {
    const loop = between(WORKER, 'const unscored = card.scoringFailed === true;', 'const recordId = await promoteOne(');
    assert.ok(loop.includes('const discard = discardReason(card);'), 'the gate must run before the promotion');
    assert.ok(/if \(discard\) \{[\s\S]*status: 'discarded'[\s\S]*continue;\s*\}/.test(loop),
        'a discarded candidate is filed at discarded and the loop moves on — no promotion, no ledger events');
});

check('inline path: discarded candidates do not count against the lead cap', () => {
    assert.ok(!WORKER.includes('leadsFound += inserted.length;'),
        'counting every inserted row let blog posts use up a run\'s lead budget');
    assert.ok(WORKER.includes('leadsFound += 1;'));
});

check('promoting safety net applies the same gate', () => {
    const batch = between(WORKER, 'async function promoteBatch(', 'const [{ remaining }');
    const iGate = batch.indexOf('discardReason(card)');
    const iPromote = batch.indexOf('await promoteOne(');
    assert.ok(iGate !== -1 && iPromote !== -1 && iGate < iPromote,
        'a row left at qualified by an earlier run must not reach the Leads tab through the net');
    assert.ok(batch.includes("status: 'discarded'"));
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}.`);
