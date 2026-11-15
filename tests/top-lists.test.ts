// tests/top-lists.test.ts
// Top lists, Phase 1 (feature request #34, docs/top-lists-plan.md — owner agreed all six decisions
// 2026-11-15). What could quietly regress:
//   · a list title saying "7" over five items (the count must come from the finished list)
//   · the count fixer touching a year, a price or "24/7"
//   · "More lists" going above 1 in 4, or putting two lists back to back
//   · a twelfth social shape (the count must stay 11, coprime with the 7 hooks)
//   · the New post Shape picker, the chat pass-through or the Content mix toggle being unwired
//
// Run:  npx tsx tests/top-lists.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    countCaptionItems, countArticleItems, fixListCount, fixCaptionListCount, fixArticleListCount, TOP_LIST_RULES,
} from '../src/utils/top-lists';
import {
    SOCIAL_POST_SHAPES, BLOG_ARTICLE_TYPES, socialShapeFor, socialShapeBlock, blogArticleTypeFor, socialShapeByKey,
    MORE_LISTS_EVERY, wantsMoreLists,
} from '../src/utils/content-shapes';
import { blogBatchFromUiElement } from '../src/utils/blog-chat-batch';
import { decodeInteractiveBrief, encodeInteractiveBrief } from '../src/utils/blog-interactive-brief';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

// ── The count ───────────────────────────────────────────────────────────────────────────────────

check('counts numbered caption items, in the forms people write them', () => {
    assert.strictEqual(countCaptionItems('5 ways to…\n\n1. One\n2. Two\n3. Three'), 3);
    assert.strictEqual(countCaptionItems('Top tips\n1) a\n2) b'), 2);
    assert.strictEqual(countCaptionItems('Tips\n1️⃣ a\n2️⃣ b\n3️⃣ c\n4️⃣ d'), 4);
    assert.strictEqual(countCaptionItems('Tips\n**1.** a\n**2.** b'), 2);
    assert.strictEqual(countCaptionItems('No list here. Founded in\n2015. Since then…'), 0, 'a year on its own line is not item 1');
    assert.strictEqual(countCaptionItems('Tips\n1. a\n2. b\n2. b again\n3. c'), 2, 'a repeated number ends the run');
});

check('counts numbered level-2 headings in an article, not intro/close headings', () => {
    const md = '# 7 ways to save on heating\n\nIntro.\n\n## 1. Bleed your radiators\nText\n\n## 2. Draught-proof doors\nText\n\n## 3) Turn it down a degree\nText\n\n## Wrapping up\nBye';
    assert.strictEqual(countArticleItems(md), 3);
    assert.strictEqual(countArticleItems('## Why\n## How'), 0);
});

check('the title count is rewritten to the real count, keeping its form', () => {
    assert.strictEqual(fixListCount('7 ways to save on heating', 5), '5 ways to save on heating');
    assert.strictEqual(fixListCount('Top 10 picnic spots', 6), 'Top 6 picnic spots');
    assert.strictEqual(fixListCount('Seven ways to sleep better', 4), 'Four ways to sleep better');
    assert.strictEqual(fixListCount('seven quick fixes', 3), 'three quick fixes');
    assert.strictEqual(fixListCount('5 ways', 5), '5 ways', 'already right');
});

check('the count fixer never touches a year, a price, 24/7 or a title with no count', () => {
    assert.strictEqual(fixListCount('What 2026 taught us', 5), 'What 2026 taught us');
    assert.strictEqual(fixListCount('Open 24/7 for you', 5), 'Open 24/7 for you');
    assert.strictEqual(fixListCount('Under £5 treats', 3), 'Under £5 treats');
    assert.strictEqual(fixListCount('Ways to save on heating', 5), 'Ways to save on heating', 'no number: nothing invented');
    assert.strictEqual(fixListCount('7 ways', 1), '7 ways', 'a one-item "list" is not retitled');
});

check('a social list caption: first line fixed, items untouched', () => {
    const out = fixCaptionListCount('7 ways to get more from your boiler:\n\n1. Service it yearly\n2. Bleed radiators\n3. Check the pressure\n4. Use a thermostat\n5. Insulate pipes');
    assert.ok(out.startsWith('5 ways to get more'), out);
    assert.ok(out.includes('\n5. Insulate pipes'));
    // The first line is item 1 (no intro line): leave it alone.
    const bare = '1. Service it\n2. Bleed it';
    assert.strictEqual(fixCaptionListCount(bare), bare);
});

check('a blog list article: post title AND body heading agree with the items', () => {
    const body = '# Top 10 walks near Leeds\n\nIntro\n\n## 1. Otley Chevin\nx\n\n## 2. Golden Acre\nx\n\n## 3. Roundhay\nx\n\n## 4. Ilkley Moor\nx';
    const fixed = fixArticleListCount('Top 10 walks near Leeds', body);
    assert.strictEqual(fixed.count, 4);
    assert.strictEqual(fixed.title, 'Top 4 walks near Leeds');
    assert.ok(fixed.bodyMarkdown.startsWith('# Top 4 walks near Leeds'), fixed.bodyMarkdown.slice(0, 40));
});

// ── The shapes ──────────────────────────────────────────────────────────────────────────────────

check('Top list replaces the list shape in place: 11 social shapes, 8 article types', () => {
    assert.strictEqual(SOCIAL_POST_SHAPES.length, 11, 'prime and coprime with the 7 hooks — never a twelfth');
    assert.strictEqual(BLOG_ARTICLE_TYPES.length, 8);
    const social = SOCIAL_POST_SHAPES.find((s) => s.key === 'list')!;
    const blog = BLOG_ARTICLE_TYPES.find((t) => t.key === 'list')!;
    assert.strictEqual(social.label, 'Top list');
    assert.strictEqual(blog.label, 'Top list');
    for (const brief of [social.brief, blog.brief]) {
        assert.ok(brief.includes(TOP_LIST_RULES), 'every list brief carries the guardrails');
        assert.match(brief, /real count/i);
    }
    assert.match(TOP_LIST_RULES, /NO INVENTED STATISTICS/);
    assert.match(TOP_LIST_RULES, /NO SELF-CROWNING/);
    assert.match(TOP_LIST_RULES, /NO BAIT TITLES/);
});

check('the default rotation never puts two social lists back to back', () => {
    const start = Date.UTC(2026, 0, 1, 9);
    let prev = '';
    for (let d = 0; d < 120; d++) {
        const { shape } = socialShapeFor(new Date(start + d * 86_400_000));
        assert.ok(!(prev === 'list' && shape.key === 'list'), `day ${d}`);
        prev = shape.key;
    }
});

check('"More lists": social lists are at most 1 in 4 and never two in a row', () => {
    assert.ok(wantsMoreLists('more'));
    assert.ok(!wantsMoreLists(undefined) && !wantsMoreLists('normal'));
    const start = Date.UTC(2026, 0, 1, 9);
    let lists = 0;
    let prev = '';
    const N = 400;
    for (let d = 0; d < N; d++) {
        const { shape } = socialShapeFor(new Date(start + d * 86_400_000), undefined, { listFrequency: 'more' });
        if (shape.key === 'list') lists++;
        assert.ok(!(prev === 'list' && shape.key === 'list'), `day ${d}`);
        prev = shape.key;
    }
    assert.ok(lists <= Math.ceil(N / MORE_LISTS_EVERY), `${lists} lists in ${N}`);
    assert.ok(lists >= Math.floor(N / MORE_LISTS_EVERY), 'and it really is more than the default 1 in 11');
});

check('"More lists" does nothing when Top list is switched off in Content mix', () => {
    const allowed = ['story', 'opinion', 'question'];
    for (let d = 0; d < 60; d++) {
        const { shape } = socialShapeFor(new Date(Date.UTC(2026, 0, 1 + d, 9)), allowed, { listFrequency: 'more' });
        assert.notStrictEqual(shape.key, 'list');
    }
});

check('"More lists": blog lists are every 4th article, never consecutive; default stays 1 in 8', () => {
    let more = 0, normal = 0;
    let prev = '';
    for (let i = 0; i < 80; i++) {
        const t = blogArticleTypeFor(i, undefined, 'more');
        if (t.key === 'list') more++;
        assert.ok(!(prev === 'list' && t.key === 'list'), `post ${i}`);
        prev = t.key;
        if (blogArticleTypeFor(i).key === 'list') normal++;
    }
    assert.strictEqual(more, 20);
    assert.strictEqual(normal, 10);
});

check('a shape picked for one post wins, even outside the Content mix', () => {
    const { shape, line } = socialShapeBlock(new Date(Date.UTC(2026, 0, 3, 9)), ['story'], { forced: 'list' });
    assert.strictEqual(shape.key, 'list');
    assert.match(line, /TOP LIST/);
    assert.strictEqual(socialShapeFor(null, ['story'], { forced: 'list' }).shape.key, 'list');
    assert.strictEqual(socialShapeByKey('nope'), null);
    assert.strictEqual(socialShapeFor(null, ['story'], { forced: 'nope' }).shape.key, 'story', 'unknown key: rotation');
});

// ── Chat pass-through ───────────────────────────────────────────────────────────────────────────

check('a blog chat topic keeps a valid articleType and drops an unknown one', () => {
    const card = blogBatchFromUiElement({ type: 'blog_batch_proposal', topics: [
        { title: '7 ways to cut energy bills', brief: 'x', articleType: 'list' },
        { title: 'Why we switched suppliers', brief: 'y', articleType: 'listicle' },
    ] })!;
    assert.strictEqual(card.topics[0].articleType, 'list');
    assert.strictEqual(card.topics[1].articleType, undefined);
    // …and it survives the trip through the job's brief to the writer.
    assert.strictEqual(decodeInteractiveBrief(encodeInteractiveBrief({ topic: 't', articleType: 'list' }))?.articleType, 'list');
});

check('chat orchestrator: social drafts mark a list and fix its count; blog topics carry articleType', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    assert.match(src, /const isList = ui\.shape === 'list';/);
    assert.match(src, /caption = fixCaptionListCount\(caption\);/);
    assert.match(src, /"shape": "list"\s+\/\/ ONLY on a Top list/);
    assert.match(src, /TOP LISTS — when the user asks for a list article/);
    assert.match(src, /"articleType": "list" \}\]/);
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.match(reg, /articleType: t\.articleType \|\| undefined/);
    assert.match(read('netlify/functions/generate-blog.ts'), /articleType: t\.articleType \}\)/);
});

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────

check('drafters apply the count fix and honour More lists / the picked shape', () => {
    const jobs = read('netlify/functions/process-content-jobs.ts');
    assert.match(jobs, /to_jsonb\(content_generation_jobs\) ->> 'post_shape' AS post_shape/, 'tolerant of a DB without the column');
    assert.match(jobs, /listFrequency: brandCtx\.list_frequency,\s+forced: job\.post_shape,/);
    assert.match(jobs, /fixCaptionListCount\(String\(generated\.caption/);
    const blog = read('src/utils/blog-generate.ts');
    assert.match(blog, /blogArticleTypeFor\(sequence, allowedTypes, listFrequency\)/);
    assert.match(blog, /fixArticleListCount\(post\.title/);
});

check('generate-post validates the shape and stores it best-effort, outside Drizzle', () => {
    const gp = read('netlify/functions/generate-post.ts');
    assert.match(gp, /socialShapeByKey\(body\.shape\)/);
    assert.match(gp, /Unknown post shape\./);
    assert.match(gp, /UPDATE content_generation_jobs SET post_shape/);
    assert.ok(!/postShape/.test(read('db/schema.ts')), 'a Drizzle column ahead of the SQL breaks every job insert');
    assert.match(read('db/z-post-shape.sql'), /ADD COLUMN IF NOT EXISTS post_shape TEXT/);
});

check('The editor\'s "Draft it for me" offers Shape and sends it', () => {
    // New post → destinations → the editor is the ONLY on-screen route to an AI draft; the old
    // generate-post sheet is never opened, which is where Shape first went (found 2026-11-15).
    const ws = read('workspace.html');
    assert.match(ws, /<select id="pce-ai-shape"/);
    assert.ok(!ws.includes('id="gen-post-shape"'), 'Shape must not sit in the unreachable sheet');
    assert.match(ws, /function gpRenderShapeOptions\(\)[\s\S]{0,300}getElementById\('pce-ai-shape'\)/);
    assert.match(ws, /shape: _pceEl\('pce-ai-shape'\)\?\.value \|\| undefined/);
    assert.match(ws, /function _pceSyncForPost[\s\S]{0,2500}gpRenderShapeOptions\(\)/);
});

check('Content mix has "More lists", saved as list_frequency and carried across saves', () => {
    assert.match(read('assistant-detail.html'), /id="edit_mix_more_lists"/);
    const js = read('assistants.js');
    assert.match(js, /listFrequency: moreLists \? 'more' : null/);
    assert.match(js, /newContext\.list_frequency = mix\.listFrequency;/);
    assert.match(read('netlify/functions/update-assistant-context.ts'), /'list_frequency'/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
