// tests/blog-replace-picture.test.ts
// Issue 35 (2026-11-10): a picture selected in Blog Studio with "replace it with a woman listening"
// went to Add pictures, which can only insert new ones, and answered that the article "already has
// the pictures it needs". Now the chat card carries the selected picture's asset id and the job swaps
// that one picture, in the same place.
// Run:  npx tsx tests/blog-replace-picture.test.ts

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { swapPicture, bodyHasPicture } from '../src/utils/blog-picture-swap';
import { encodeInteractiveBrief, decodeInteractiveBrief } from '../src/utils/blog-interactive-brief';
import { blogActionFromUiElement } from '../src/utils/chat-blog-action';

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const BODY = 'Intro paragraph.\n\n:::media{asset=2612 type=image alt="Two people talking" align=wide}\n\nAfter it.\n\n:::media{asset=26120 type=image}\n';

check('swaps the selected picture in place, keeps align, sets the new alt', () => {
    const out = swapPicture(BODY, 2612, 9001, 'A woman listening, happily engaged');
    assert.strictEqual(out, 'Intro paragraph.\n\n:::media{asset=9001 type=image alt="A woman listening, happily engaged" align=wide}\n\nAfter it.\n\n:::media{asset=26120 type=image}\n');
});

check('never matches a longer asset number, and is null when the picture is gone', () => {
    assert.strictEqual(swapPicture('x\n\n:::media{asset=26120 type=image}', 2612, 1, ''), null);
    assert.strictEqual(bodyHasPicture(BODY, 2612), true);
    assert.strictEqual(bodyHasPicture(BODY, 77), false);
});

check('quoted asset, a video, a picture inside columns, and ![](asset://) all swap to an image', () => {
    assert.strictEqual(swapPicture(':::media{asset="5" type=video caption="Cap"}', 5, 6, 'New'), ':::media{asset=6 type=image caption="Cap" alt="New"}');
    const cols = '::::columns{count=2}\n\n:::media{asset=5}\n\nText\n\n::::';
    assert.ok(swapPicture(cols, 5, 6, '')!.includes(':::media{asset=6 type=image}'));
    assert.strictEqual(swapPicture('![old](asset://5)', 5, 6, 'new alt'), '![new alt](asset://6)');
    assert.strictEqual(swapPicture('![old](asset://5)', 5, 6, ''), '![old](asset://6)');
});

check('the chat card and job brief carry replaceAsset; an add-pictures card keeps its shape', () => {
    const r = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'pictures', postId: 142, replaceAsset: 'asset=2612', instruction: 'a woman actively listening' });
    assert.strictEqual(r?.replaceAsset, 2612);
    const add = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'pictures', postId: 142 });
    assert.ok(add && !('replaceAsset' in add));
    const notPics = blogActionFromUiElement({ type: 'blog_action_proposal', action: 'shorter', postId: 142, replaceAsset: 2612 });
    assert.ok(notPics && !('replaceAsset' in notPics));
    const b = decodeInteractiveBrief(encodeInteractiveBrief({ topic: '', addImages: { source: 'stock', instruction: 'x', replaceAsset: 2612 } }));
    assert.deepStrictEqual(b?.addImages, { source: 'stock', instruction: 'x', replaceAsset: 2612 });
});

check('wired end to end: prompt, card, click, endpoint, worker', () => {
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"replaceAsset"'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("'Replace this picture'"));
    assert.ok(read('src/components/chat-session.js').includes('replaceAsset: d.replaceAsset'));
    assert.ok(read('netlify/functions/generate-blog.ts').includes('addImagesRaw.replaceAsset'));
    assert.ok(read('netlify/functions/process-blog-jobs.ts').includes('replaceAssetId: addImages.replaceAsset'));
});

console.log(`\n${passed} passed, 0 failed\n`);
