// tests/draft-not-lost.test.ts
// A post someone actually built must be reachable again.
//
// The composer creates its row BLANK, so create-manual-post stamps it 'draft' — and 'draft' is in
// no Review Queue family, on no calendar and in no column. Correct for the empty shell a composer
// needs before it can open; catastrophic once someone has spent an hour in it. Four clips, a cut and
// five text boxes were saved to a row nothing could show again, and closing the composer read as
// losing the work.
//
// Run:  npx tsx tests/draft-not-lost.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW_QUEUE_STATUS_FAMILIES } from '../src/config/post-status';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(import.meta.dirname, '..');
const drafts = readFileSync(join(root, 'netlify/functions/get-social-drafts.ts'), 'utf8');
const attach = readFileSync(join(root, 'netlify/functions/attach-draft-media.ts'), 'utf8');
const cleanup = readFileSync(join(root, 'netlify/functions/archive-cleanup.ts'), 'utf8');
const create = readFileSync(join(root, 'netlify/functions/create-manual-post.ts'), 'utf8');

console.log('\nthe shape of the problem');

check('the composer really does create its row as a draft', () => {
    // If this ever stops being true the rest of this suite is guarding nothing.
    assert.match(create, /status: blank \? 'draft' : 'pending_approval'/);
});

check("and 'draft' is still in no Review Queue family", () => {
    for (const [name, family] of Object.entries(REVIEW_QUEUE_STATUS_FAMILIES)) {
        assert.ok(!(family as readonly string[]).includes('draft'),
            `'draft' must not be added to the ${name} family wholesale — blank shells would flood the queue`);
    }
});

console.log('\nrecovering what is already stranded');

check('the queue shows a draft that has content', () => {
    // A promotion on write fixes the NEXT one and none of the ones already lost, so the read side
    // has to be widened too.
    assert.ok(drafts.includes('const contentfulDraft ='), 'the queue must recognise a built draft');
    const at = drafts.indexOf('const contentfulDraft =');
    const scope = drafts.slice(at, at + 900);
    assert.ok(scope.includes('caption'), 'a caption counts as content');
    assert.ok(scope.includes('scheduled_post_assets'), 'so does attached media');
    assert.ok(scope.includes('content_asset_ids') || scope.includes('contentAssetIds'), 'and the legacy array');
});

check('only the awaiting-review tab is widened', () => {
    // Drafts are not scheduled and not archived; showing them there would be a different lie.
    const at = drafts.indexOf('const awaitingReview =');
    assert.ok(at > 0, 'the widening must be scoped to one tab');
    assert.ok(drafts.slice(at, at + 400).includes("statusFilter === 'pending_approval'"));
});

console.log('\nkeeping the status honest from here on');

check('attaching media promotes the draft', () => {
    // Media is the first real content a post gets, and the cut and the overlays both require it.
    const at = attach.indexOf("status: 'pending_approval'");
    assert.ok(at > 0, 'attach-draft-media must promote');
    const scope = attach.slice(at - 200, at + 300);
    assert.ok(scope.includes("eq(scheduledPosts.status, 'draft')"),
        'and ONLY a draft — promoting a scheduled or published post would rewind it');
});

console.log('\nnothing with work in it is swept');

check('the blank sweep still requires no media at all', () => {
    // This is what stops the seven-day collector eating a post someone built. If the media clauses
    // ever leave this query, an abandoned composer with four clips becomes a deletion.
    const at = cleanup.indexOf('WITH untouched AS');
    const scope = cleanup.slice(at, at + 1400);
    assert.ok(scope.includes("btrim(coalesce(sp.caption, '')) = ''"), 'no caption');
    assert.ok(scope.includes('jsonb_array_length(sp.content_asset_ids) = 0'), 'no media array');
    assert.ok(scope.includes('NOT EXISTS'), 'and no junction rows');
});

console.log(`\n${passed} checks passed`);
