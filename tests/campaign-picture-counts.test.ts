// tests/campaign-picture-counts.test.ts
// A campaign's picture brief is for as many pictures as the posts it serves, and each chosen
// picture goes on one of those posts. Owner, 2026-10-14:
//   "if the brief is for 10 social posts to be sent out, then the brand designer should be
//    providing options until 10 have been selected where it should then state no more required"
//   "If the blog posts are to have images or videos as well, this should be another brief"
// and, asked where a chosen picture goes: swap it onto a campaign post still awaiting review,
// replacing the picture the drafter found — never one the user chose.
//
// Run:  npx tsx tests/campaign-picture-counts.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER_ACTION_SPECS, orderWorkItems } from '../src/config/campaign-vocab';
import { MAX_PICTURES_NEEDED } from '../src/utils/campaign-visual-order';
import { maxRoundsFor } from '../src/utils/visual-briefs';
import { MAX_ROUNDS } from '../src/config/visual-brief-vocab';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const ddl = read('db/z-campaign-picture-counts.sql');
const engine = read('src/utils/visual-briefs.ts');
const order = read('src/utils/campaign-visual-order.ts');
const media = read('src/utils/brief-post-media.ts');

console.log('campaign picture counts');

check('the order asks for N pictures, one task each, capped where the DB caps it', () => {
    const spec = ORDER_ACTION_SPECS.commission_visuals;
    assert.strictEqual(spec.takesQuantity, true);
    assert.strictEqual(spec.maxQuantity, MAX_PICTURES_NEEDED);
    assert.ok(ddl.includes(`CHECK (pictures_needed BETWEEN 1 AND ${MAX_PICTURES_NEEDED})`), 'DB cap differs');
    assert.strictEqual(orderWorkItems('commission_visuals', 10), 10);
    assert.ok(order.includes('picturesNeeded, origin: \'campaign\''), 'the brief does not record how many');
});

check('the DDL is idempotent and adds both columns', () => {
    assert.ok(/ADD COLUMN IF NOT EXISTS pictures_needed integer NOT NULL DEFAULT 1/.test(ddl));
    assert.ok(/ADD COLUMN IF NOT EXISTS auto_media_asset_id integer/.test(ddl));
    assert.ok(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'visual_briefs_pictures_needed_check'\)/.test(ddl));
    const schema = read('db/schema.ts');
    assert.ok(schema.includes('picturesNeeded: integer("pictures_needed")') && schema.includes('autoMediaAssetId: integer("auto_media_asset_id")'), 'drizzle mirror missing');
});

check('a brief is done only when enough are chosen, and refuses rounds and picks after that', () => {
    assert.ok(/>= b\.pictures_needed THEN 'approved'/.test(engine), 'status ignores the count');
    assert.ok(engine.includes("'This brief already has every picture it needs — no more options are required.'"), 'rounds continue after done');
    assert.ok(/if \(brief\.campaignId && await picturesStillNeeded\(db, brief\) === 0\)/.test(engine), 'extra picks accepted on a finished campaign brief');
});

check('a brief for many pictures gets at least a round per picture', () => {
    assert.strictEqual(maxRoundsFor({ picturesNeeded: 1 }), MAX_ROUNDS);
    assert.strictEqual(maxRoundsFor({ picturesNeeded: 15 }), 15);
});

check('the order is delivered at N of N, says "x of N" before, and keeps a closed brief\'s picks', () => {
    assert.ok(order.includes('if (chosen >= needed)'), 'delivered on the first pick');
    assert.ok(order.includes('`${chosen} of ${needed} pictures chosen — ${needed - chosen} more needed'), 'no running tally');
    assert.ok(order.includes("chosen > 0 && brief.status === 'cancelled'"), 'a closed brief loses its picks');
});

check('a chosen picture replaces only the drafter\'s own pick, on a waiting campaign post', () => {
    const fn = media.slice(media.indexOf('export async function placeOnCampaignPost('));
    assert.ok(fn.includes('inArray(scheduledPosts.status, [...MEDIA_EDITABLE_STATUSES])'), 'could touch a scheduled or published post');
    assert.ok(fn.includes("o.action IN ('draft_social_posts', 'ab_test_posts')"), 'not limited to the campaign\'s social posts');
    assert.ok(fn.includes('carriesOnlyItsOwnPick(db, c.id, c.auto)'), 'could replace a picture the user chose');
    assert.ok(/rows\.length === 1 && rows\[0\]\.id === auto/.test(media), 'the own-pick test is not exact');
    assert.ok(fn.includes('ca.campaign_id = ${args.campaignId}'), 'two campaign pictures could land on one post');
});

check('the drafter records its own pick, on the post and its cross-post siblings', () => {
    const jobs = read('netlify/functions/process-content-jobs.ts');
    assert.ok(jobs.includes('set({ autoMediaAssetId: resolved.assetId })'), 'primary not marked');
    assert.ok(jobs.includes('set({ autoMediaAssetId: sharedAssetIds[0] })'), 'siblings not marked');
});

check('article pictures are their own brief and never go on social posts', () => {
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('Pictures for ARTICLES are a SEPARATE commission_visuals with "purpose": "blog_header"'));
    const r = read('src/utils/media-resolver.ts');
    const fn = r.slice(r.indexOf('async function pickCampaignAsset('), r.indexOf('async function pickStockAsset('));
    assert.ok(fn.includes("b.purpose IN ('blog_header', 'email_header')"), 'article pictures can land on social posts');
    assert.ok(engine.includes("const SOCIAL_PURPOSES = new Set(['social_post', 'story', 'ad', 'other']);"));
});

check('the Briefs tab says "x of N chosen", then "no more needed", and stops offering', () => {
    const tab = read('src/components/assistant-briefs.js');
    assert.ok(tab.includes("o.status === 'proposed' && b.status !== 'cancelled' && !progress(b).done"), '"Use this" still offered when done');
    assert.ok(tab.includes('${progress(b).done ? \'\' : `<button type="button" data-brief-generate'), 'more options still offered when done');
});

console.log(`\n${passed} passed`);
