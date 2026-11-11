// tests/seo-task-costs.test.ts — task costs in the HTML the deploy build publishes (build-seo-html Job 10).
//
// A crawler without JavaScript, and the FAQ JSON-LD the build generates from page text, only ever saw the
// fallback inside <span data-task-cost>; hand-written JSON-LD wrote the cost in. The build now bakes today's
// figure into both. These checks keep its wording identical to the server's and the page script's.
// Run:  npx tsx tests/seo-task-costs.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COST_KEYS, DEFAULT_TASK_COSTS, taskCostLabel } from '../src/config/task-weights';
import { taskCostText, bakeTaskCostSpans, fillJsonLdTaskTokens, pageFallbacks } from '../scripts/seo/task-costs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const figures = (bySecond: boolean, over: Record<string, number> = {}) => ({
    weights: { ...DEFAULT_TASK_COSTS.weights, ...over },
    videoTasksPerSecond: DEFAULT_TASK_COSTS.videoTasksPerSecond,
    chatMessagesPerTask: DEFAULT_TASK_COSTS.chatMessagesPerTask,
    videoPricedBySecond: bySecond,
});
const withSwitch = (on: boolean, fn: () => void) => {
    const was = process.env.AI_VIDEO_PRICED_BY_SECOND;
    if (on) process.env.AI_VIDEO_PRICED_BY_SECOND = 'on'; else delete process.env.AI_VIDEO_PRICED_BY_SECOND;
    try { fn(); } finally { if (was === undefined) delete process.env.AI_VIDEO_PRICED_BY_SECOND; else process.env.AI_VIDEO_PRICED_BY_SECOND = was; }
};

check('the build words every cost exactly as the server does, per-second off and on', () => {
    for (const on of [false, true]) {
        withSwitch(on, () => {
            for (const key of COST_KEYS) {
                assert.strictEqual(taskCostText(key, figures(on)), taskCostLabel(key, DEFAULT_TASK_COSTS), `${key} (per-second ${on ? 'on' : 'off'})`);
            }
        });
    }
    assert.strictEqual(taskCostText('nope', figures(false)), null);
    assert.strictEqual(taskCostText('ai_image', null), null);
});

check('a tagged cost takes today\'s figure; a clip example is worked out from the per-second rate', () => {
    const html = 'An image is <span data-task-cost="ai_image">1 task</span>; 5 s is <span data-task-cost="ai_video_per_second" data-task-seconds="5">20 tasks</span>.';
    const b = bakeTaskCostSpans(html, { ...figures(false, { ai_image: 3 }), videoTasksPerSecond: 6 });
    assert.strictEqual(b.html, 'An image is <span data-task-cost="ai_image">3 tasks</span>; 5 s is <span data-task-cost="ai_video_per_second" data-task-seconds="5">30 tasks</span>.');
    assert.strictEqual(b.count, 2);
    assert.deepStrictEqual(bakeTaskCostSpans('<span data-task-cost="typo">1 task</span>', figures(false)).unknown, ['typo']);
});

check('JSON-LD placeholders are filled, and only inside JSON-LD', () => {
    const html = '<p>{{tasks.site_draft}}</p><script type="application/ld+json">{"text":"uses {{tasks.site_draft}}"}</script>';
    const r = fillJsonLdTaskTokens(html, figures(false, { site_draft: 2 }));
    assert.strictEqual(r.html, '<p>{{tasks.site_draft}}</p><script type="application/ld+json">{"text":"uses 2 tasks"}</script>');
    assert.strictEqual(r.count, 1);
});

check('with /task-costs unreachable a placeholder takes the figure the page shows; nothing can fill → reported', () => {
    const page = '<span data-task-cost="site_draft">1 task</span><script type="application/ld+json">{"a":"{{tasks.site_draft}}","b":"{{tasks.ai_music}}"}</script>';
    assert.deepStrictEqual(pageFallbacks(page), { site_draft: '1 task' });
    const r = fillJsonLdTaskTokens(page, null);
    assert.ok(r.html.includes('"a":"1 task"'));
    assert.deepStrictEqual(r.unresolved, ['ai_music'], 'an unfillable token fails the build, never ships raw');
});

check('the comparison page\'s FAQ JSON-LD says the placeholder, and the real page bakes cleanly', () => {
    const html = read('be-more-swan-vs-website-builders.html');
    const ld = html.slice(html.indexOf('<script type="application/ld+json">'));
    assert.ok(ld.includes('each uses {{tasks.site_draft}} from your monthly allowance'));
    const baked = fillJsonLdTaskTokens(bakeTaskCostSpans(html, figures(false)).html, figures(false));
    assert.deepStrictEqual(baked.unresolved, []);
    assert.ok(!baked.html.includes('{{tasks.'), 'nothing raw left after the build');
    for (const page of ['faq.html', 'pricing.html', 'checkout.html', 'terms_of_service.html', 'website-builder-for-small-business.html']) {
        const b = bakeTaskCostSpans(read(page), figures(true));
        assert.deepStrictEqual(b.unknown, [], `${page}: every tagged key is a cost`);
        assert.ok(b.count > 0, `${page} has tagged costs`);
    }
});

check('the build bakes costs before it generates FAQ JSON-LD from the page text', () => {
    const b = read('scripts/build-seo-html.mjs');
    const tail = b.slice(b.indexOf('\ninlineFooters();\n'));
    assert.ok(tail.indexOf('await bakeTaskCosts();') > -1 && tail.indexOf('await bakeTaskCosts();') < tail.indexOf('buildFaqJsonLd();'));
    assert.ok(tail.indexOf('await bakeTaskCosts();') < tail.indexOf('buildHomeFaqJsonLd();'));
    assert.match(b, /JSON-LD \{\{tasks\.\*\}\} left unfilled/, 'an unfilled placeholder is a failure');
});

check('/task-costs.js fills JSON-LD placeholders on a page served without the build', () => {
    const js = read('task-costs.js');
    assert.match(js, /script\[type="application\/ld\+json"\]/);
    assert.match(js, /tasks\\\.\(\[a-z_\]\+\)/);
});

console.log(`\n${passed} checks passed`);
