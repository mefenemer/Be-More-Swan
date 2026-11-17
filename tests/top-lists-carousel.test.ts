// tests/top-lists-carousel.test.ts
// Top lists Phase 2 — "Make it a carousel" (docs/top-lists-plan.md §6; owner decisions 3 and 4,
// 2026-11-15: on request only, one task per carousel). What could quietly regress:
//   · slides saying something the caption doesn't (they must come from its numbered items)
//   · a cover that keeps the model's wrong count ("Seven" over five items)
//   · more than 20 slides (the platforms' ceiling) or a slide too long for a card
//   · a carousel landing on LinkedIn / Facebook / X rows, whose feed formats take one picture
//   · charging per slide, or charging before the slides exist
//   · the editor button, the chat action or the card being unwired from the one endpoint
//
// Run:  npx tsx tests/top-lists-carousel.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    captionListItems, carouselSlideTexts, carouselFormatFor, slideTextForItem, countCaptionItems,
    CAROUSEL_MAX_SLIDES, SLIDE_TEXT_MAX,
} from '../src/utils/top-lists';
import { postFormatSpec } from '../src/config/post-formats';
import { DEFAULT_TASK_WEIGHTS } from '../src/config/task-weights';
import { postActionFromUiElement, POST_ACTIONS } from '../src/utils/chat-post-action';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { process.exitCode = 1; console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const CAPTION = [
    'Most odd true stories can\'t carry a film. Seven checks tell you in ten minutes.',
    '',
    'We run every story through these.',
    '',
    '1. Someone wants something badly. No want, no story.',
    '2. **Something blocks them.** Weather, the law, family.',
    '3) The record holds up. Letters and court reports.',
    '4 - The ending still lands when people know it.',
    '5. One detail nobody would believe if you made it up.',
    '',
    'Five yeses? Start writing.',
].join('\n');

check('items come straight from the caption, in order, without numbers or bold', () => {
    const items = captionListItems(CAPTION);
    assert.strictEqual(items.length, 5);
    assert.strictEqual(items.length, countCaptionItems(CAPTION), 'same run the count fix uses');
    assert.strictEqual(items[1], 'Something blocks them. Weather, the law, family.');
    assert.ok(items.every((t) => !/^\d/.test(t) && !t.includes('**')));
});

check('a caption with no list, or a one-item list, makes no carousel', () => {
    assert.strictEqual(carouselSlideTexts('Just a thought about Mondays.'), null);
    assert.strictEqual(carouselSlideTexts('Intro\n1. Only one thing.'), null);
});

check('the cover is the opening line with its count made to match the items', () => {
    const t = carouselSlideTexts(CAPTION)!;
    assert.match(t.cover, /Five checks/, 'the model wrote "Seven" over five items');
    assert.strictEqual(t.items.length, 5);
});

check('a caption that starts at item 1 takes the card headline as its cover, count fixed', () => {
    const t = carouselSlideTexts('1. Book early.\n2. Ask about parking.\n3. Bring cash.', 'Top 7 wedding tips')!;
    assert.strictEqual(t.cover, 'Top 3 wedding tips');
});

check('each slide is "N. first sentence", never longer than a card holds', () => {
    assert.strictEqual(slideTextForItem(3, 'The record holds up. Letters and reports.'), '3. The record holds up.');
    const long = slideTextForItem(1, 'A '.repeat(200));
    assert.ok(long.length <= SLIDE_TEXT_MAX && long.endsWith('…'));
    for (const s of carouselSlideTexts(CAPTION)!.items) assert.ok(s.length <= SLIDE_TEXT_MAX);
});

check('never more than 20 slides: the cover plus at most 19 items', () => {
    const many = ['Twenty things:', ...Array.from({ length: 20 }, (_, i) => `${i + 1}. Thing number ${i + 1}.`)].join('\n');
    const t = carouselSlideTexts(many)!;
    assert.strictEqual(1 + t.items.length, CAROUSEL_MAX_SLIDES);
});

check('carousels only where the format is live: Instagram and Threads', () => {
    assert.strictEqual(carouselFormatFor('instagram'), 'ig_carousel');
    assert.strictEqual(carouselFormatFor('Threads'), 'th_carousel');
    for (const p of ['linkedin', 'facebook', 'x', 'youtube', '', null]) assert.strictEqual(carouselFormatFor(p), null, String(p));
    for (const key of ['ig_carousel', 'th_carousel']) {
        const spec = postFormatSpec(key)!;
        assert.strictEqual(spec.availability, 'live', key);
        assert.ok(spec.maxItems >= CAROUSEL_MAX_SLIDES, `${key} takes ${CAROUSEL_MAX_SLIDES}`);
        assert.ok(spec.aspectRatios.includes('4:5'), `${key} accepts the 4:5 the cards are rendered at`);
    }
});

check('one task per carousel (decision 4): its own kind at 1, seeded in the cost table', () => {
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.carousel, 1);
    assert.match(read('db/z-task-costs.sql'), /\(1, 'carousel', 1\)/);
});

check('make-carousel: asks for capacity before rendering, records ONE task after the slides are saved', () => {
    const src = read('netlify/functions/make-carousel.ts');
    const ask = src.indexOf('hasTaskCapacity(db, orgId)');
    const render = src.indexOf('renderAndPersistBrandCard(db,');
    const write = src.indexOf('writePostSlides(db, [t.id]');
    const record = src.indexOf("recordCompletedWork(db, orgId, 'carousel'");
    assert.ok(ask > 0 && render > ask && write > render && record > write, 'order: ask → render → save → record');
    assert.strictEqual(src.split('recordCompletedWork(').length - 1, 1, 'one charge per press, not per slide or row');
    assert.match(src, /carouselFormatFor\(r\.platform\) && isMediaEditable\(r\.status\)/, 'only carousel platforms that can still change');
    assert.match(src, /writePostSlides\(db, \[t\.id\], assetIds, \{ formatKey \}\)/, 'slides and format in one update');
    assert.match(read('netlify.toml'), /\[functions\.make-carousel\]\s+timeout = 26/);
});

check('set-post-slides and make-carousel share one slide writer (junction + legacy array together)', () => {
    assert.match(read('netlify/functions/set-post-slides.ts'), /await writePostSlides\(db, targetIds, assetIds\);/);
    const util = read('src/utils/post-slides.ts');
    assert.match(util, /scheduledPostAssets/);
    assert.match(util, /contentAssetIds: \[\.\.\.assetIds\]/);
});

check('chat: a `carousel` post action, offered for Instagram / Threads lists, confirmed on a card', () => {
    assert.ok((POST_ACTIONS as readonly string[]).includes('carousel'));
    const req = postActionFromUiElement({ type: 'post_action_proposal', action: 'carousel', postId: '#202' });
    assert.deepStrictEqual(req && { action: req.action, postId: req.postId }, { action: 'carousel', postId: 202 });
    const pa = read('src/utils/chat-post-action.ts');
    assert.match(pa, /req\.action !== 'carousel' \|\| !!carouselFormatFor\(r\.platform\)/);
    assert.match(pa, /req\.action === 'carousel' && rows\.length && !carouselSlideTexts\(/);
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /"time_text" \| "carousel"/);
    assert.match(orch, /action "carousel" — only for a post on Instagram or Threads/);
    assert.match(read('src/components/disruptive-ui-registry.js'), /carousel: \{ head: 'Make it a carousel'/);
    assert.match(read('src/components/chat-session.js'), /postActionCall\('make-carousel', \{ postId: d\.postId \}\)/);
});

check('editor: "Make it a carousel" calls the same endpoint, saves first and reloads after', () => {
    const ws = read('workspace.html');
    assert.match(ws, /id="pce-carousel-go" onclick="_pceMakeCarousel\(\)"/);
    assert.match(ws, /function _pceSyncForPost[\s\S]{0,4000}_pceSyncCarouselBtn\(post, editable\)/);
    assert.match(ws, /fetch\('\/\.netlify\/functions\/make-carousel'/);
    assert.match(ws, /'time_text', 'carousel'\]\.includes\(d\.action\)/, 'the editor reloads after a carousel');
});

check('the editor shows a carousel of brand cards as slides, not as one card (browser check 2026-11-16)', () => {
    // Every slide is a brand_card asset; flagging the post as "a brand card" made the editor draw the
    // last slide alone and hide the slide strip. Only a single-picture post may carry brandCard.
    const src = read('netlify/functions/get-social-drafts.ts');
    assert.match(src, /brandCard: slideIds\.length > 1 \? null : \(brandCards\.get\(d\.id\) \?\? null\)/);
    assert.match(read('workspace.html'), /const capable = !!post && !post\.brandCard && /, 'the strip hides for a brandCard post');
});

check('after a carousel the editor asks the format router again, never reusing the no-media answer (2026-11-17)', () => {
    const ws = read('workspace.html');
    const i = ws.indexOf("'time_text', 'carousel'].includes(d.action)");
    assert.ok(i > 0);
    const block = ws.slice(i, i + 900);
    assert.ok(block.indexOf('_rqRoutesFor = null;') > 0 && block.indexOf('_rqRoutesFor = null;') < block.indexOf('_rqOpenPostReview('), 'cleared before the refresh');
    assert.match(read('netlify/functions/chat-orchestrator.ts'), /the cover's number is corrected to the items there really are/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
