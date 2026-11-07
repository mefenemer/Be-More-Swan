// tests/post-revision-feedback.test.ts
// Guest comment "the image is too dark" → Use these comments → Regenerate (2026-11-07). Two bugs:
//   1. The redraft never saw the draft it revised, and the picture writer never saw the feedback, so
//      the new picture was a fresh one from the same brand steer, just as dark.
//   2. The redraft is a new post, so the guest's comment vanished from its panel.
//
// Run:  npx tsx tests/post-revision-feedback.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { previousDraftBlock, revisionPictureSection } from '../src/utils/post-revision';
import { revisionAncestors } from '../src/utils/review-links';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

(async () => {
    console.log('post revision feedback');

    await test('the drafter is shown the previous caption and picture, and told to change only what was named', () => {
        const block = previousDraftBlock({ caption: 'Cosy winter evenings at the café.', picturePrompt: 'A moody candle-lit café at night, deep shadows.' });
        assert.match(block, /Cosy winter evenings at the café\./);
        assert.match(block, /moody candle-lit café/);
        assert.match(block, /too dark" means a bright, well-lit/);
        assert.match(block, /beats the brand colours/);
    });

    await test('no picture prompt (stock or library media) leaves that line out', () => {
        assert.doesNotMatch(previousDraftBlock({ caption: 'Hi', picturePrompt: null }), /PREVIOUS PICTURE/);
    });

    await test('the picture section carries the feedback and the last picture', () => {
        const section = revisionPictureSection('The image is too dark', 'A moody café, deep shadows');
        assert.match(section, /The image is too dark/);
        assert.match(section, /A moody café, deep shadows/);
        assert.match(section, /too dark means bright/);
    });

    await test('request-post-changes marks the job as a revision of the post, with the whole feedback', () => {
        const src = read('netlify/functions/request-post-changes.ts');
        assert.match(src, /revisedFromPostId: postId/);
        assert.doesNotMatch(src, /apply this reviewer feedback: \$\{feedback\}`\.slice/);
    });

    await test('process-content-jobs reads the previous draft and passes the revision to the picture writer', () => {
        const src = read('netlify/functions/process-content-jobs.ts');
        assert.match(src, /loadPreviousDraft\(db, job\.organisation_id, job\.revised_from_post_id\)/);
        assert.match(src, /revision: job\.revised_from_post_id && job\.context_prompt/);
    });

    await test('revisionAncestors walks redrafts back, stops on a loop, and stays in the workspace query', async () => {
        // 30 ← 20 ← 10, and 7 points at itself.
        const parent: Record<number, number | null> = { 30: 20, 20: 10, 10: null, 7: 7 };
        const db = {
            select: () => ({
                from: () => ({
                    // Every row, whatever the filter: the walk must only follow the ids it asked about.
                    where: () => Promise.resolve(Object.keys(parent).map(Number).map((id) => ({ id, from: parent[id] }))),
                }),
            }),
        };
        const out = await revisionAncestors(db as never, 1, [30, 7]);
        assert.deepStrictEqual(out.get(30), [20, 10]);
        assert.deepStrictEqual(out.get(7), []);
    });

    await test('the panel keeps a used comment and offers Mark as done, Ignore and Undo', () => {
        const js = read('src/components/review-links.js');
        assert.match(js, /data-rl-resolution="done"/);
        assert.match(js, /data-rl-resolution="ignored"/);
        assert.match(js, />Undo</);
        // Using a comment must not resolve it: useComments only fills the box.
        const use = js.slice(js.indexOf('function useComments'), js.indexOf('async function shareCard'));
        assert.ok(use.length > 0);
        assert.doesNotMatch(use, /resolve/);
    });

    await test('the resolve action is workspace-scoped and the SQL adds the columns', () => {
        const util = read('src/utils/review-links.ts');
        const fn = util.slice(util.indexOf('export async function resolveReviewResponse'), util.indexOf('/** Signed in. Only a link in this workspace can be revoked. */'));
        assert.match(fn, /eq\(reviewLinkResponses\.organisationId, orgId\)/);
        const sql = read('db/review-link-response-resolved.sql');
        assert.match(sql, /ADD COLUMN IF NOT EXISTS resolution/);
        assert.match(sql, /IN \('done','ignored'\)/);
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exit(1);
})();
