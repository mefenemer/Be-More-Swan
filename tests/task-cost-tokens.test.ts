// tests/task-cost-tokens.test.ts — task costs in stored copy and on pages read live (owner, 2026-11-11).
//
// Help articles, plan features and assistant showcases wrote costs in ("1 task", "20 tasks"), so a change
// made in Admin → Money → Task costs never reached them. They now say {{tasks.<cost key>}}, filled by
// fillTaskCostTokens on every path that sends that text out. Static pages tag each figure with
// data-task-cost for /task-costs.js. These checks keep the two ends joined.
// Run:  npx tsx tests/task-cost-tokens.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COST_KEYS, DEFAULT_TASK_COSTS, fillTaskCostTokens, fillTaskCostTokensDeep, taskCostLabel } from '../src/config/task-weights';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const withSwitch = (v: string | undefined, fn: () => void) => {
    const was = process.env.AI_VIDEO_PRICED_BY_SECOND;
    if (v === undefined) delete process.env.AI_VIDEO_PRICED_BY_SECOND; else process.env.AI_VIDEO_PRICED_BY_SECOND = v;
    try { fn(); } finally { if (was === undefined) delete process.env.AI_VIDEO_PRICED_BY_SECOND; else process.env.AI_VIDEO_PRICED_BY_SECOND = was; }
};
const costs = { ...DEFAULT_TASK_COSTS, weights: { ...DEFAULT_TASK_COSTS.weights, ai_image: 2, ai_video: 25 } };

check('a placeholder becomes today\'s figure, worded as the Task costs page words it', () => {
    withSwitch(undefined, () => {
        assert.strictEqual(fillTaskCostTokens('An AI image uses {{tasks.ai_image}}.', costs), 'An AI image uses 2 tasks.');
        assert.strictEqual(fillTaskCostTokens('{{ tasks.social_post }}', costs), '1 task');
        assert.strictEqual(fillTaskCostTokens('{{tasks.ai_video}}', costs), '25 tasks', 'flat while per-second is off');
        assert.strictEqual(fillTaskCostTokens('{{tasks.chat_messages_per_task}}', costs), 'every 10 messages');
        assert.strictEqual(fillTaskCostTokens('{{tasks.ai_music_shared}}', { ...costs, weights: { ...costs.weights, ai_music_shared: 0 } }), 'no tasks');
    });
});

check('AI video follows the per-second switch, like aiVideoTasks()', () => {
    withSwitch('on', () => {
        assert.strictEqual(taskCostLabel('ai_video', costs), '4 tasks a second');
        assert.strictEqual(taskCostLabel('ai_video_per_second', costs), '4 tasks a second');
    });
});

check('an unknown key is left showing, never silently blank', () => {
    assert.strictEqual(fillTaskCostTokens('uses {{tasks.ai_imagee}}', costs), 'uses {{tasks.ai_imagee}}');
    assert.strictEqual(fillTaskCostTokens('price {{plans.saver_price}}', costs), 'price {{plans.saver_price}}', 'plan price tokens are not ours');
    assert.strictEqual(taskCostLabel('nope', costs), null);
});

check('a showcase is filled all the way down, and its shape is kept', () => {
    const out = fillTaskCostTokensDeep({ faqs: [{ q: 'Cost?', a: 'An AI image is {{tasks.ai_image}}.' }], n: 3, on: true, none: null }, costs);
    assert.deepStrictEqual(out, { faqs: [{ q: 'Cost?', a: 'An AI image is 2 tasks.' }], n: 3, on: true, none: null });
});

check('every placeholder in stored copy names a real cost', () => {
    const sources = {
        'help SQL': read('db/help-articles-task-cost-tokens-2026-11-11.sql'),
        'showcase JSON': read('db/assistant-showcases.json'),
        'team features': read('src/config/team-features.ts'),
    };
    let seen = 0;
    for (const [name, text] of Object.entries(sources)) {
        for (const m of text.matchAll(/\{\{\s*tasks\.([a-z_]+)\s*\}\}/g)) {
            seen++;
            assert.ok((COST_KEYS as readonly string[]).includes(m[1]), `${name}: {{tasks.${m[1]}}} is not a cost key`);
        }
    }
    assert.ok(seen > 40, `expected many placeholders, found ${seen}`);
});

check('the showcase SQL is regenerated from the JSON (placeholders included)', () => {
    assert.ok(read('db/z-assistant-showcases.sql').includes('{{tasks.footage_review}}'));
    assert.ok(!read('db/assistant-showcases.json').match(/\b\d+ tasks?\b/), 'no written-in cost left in the showcase JSON');
});

check('every path that sends stored copy out fills the placeholders', () => {
    assert.match(read('netlify/functions/get-help-articles.ts'), /fillTaskCostTokens\(fillPlanPriceTokens\(/);
    assert.match(read('src/utils/help-knowledge.ts'), /fillTaskCostTokens\(fillPlanPriceTokens\(/);
    assert.match(read('netlify/functions/get-plans.ts'), /fillTaskCostTokensDeep\(\{ plans:/);
    assert.match(read('netlify/functions/assistant-showcase.ts'), /fillTaskCostTokensDeep\(row\.content, await getTaskCosts\(\)\)/);
    assert.match(read('src/utils/mentor-snapshot.ts'), /fillTaskCostTokens\(f\.text, d\.costs\)/);
});

check('pages that tag a cost load /task-costs.js', () => {
    for (const page of ['terms_of_service.html', 'checkout.html', 'faq.html', 'pricing.html', 'be-more-swan-vs-website-builders.html', 'website-builder-for-small-business.html']) {
        const html = read(page);
        assert.ok(html.includes('data-task-cost='), `${page} tags no cost`);
        assert.match(html, /<script src="\/task-costs\.js"/, `${page} tags costs but never loads the script that fills them`);
    }
    for (const page of ['assistant.html', 'assistant-setup.html']) assert.match(read(page), /<script src="\/task-costs\.js"/, page);
});

check('terms 5.2 states each weight through the live figure', () => {
    const t = read('terms_of_service.html');
    const c52 = t.slice(t.indexOf('5.2 — Weighted outputs'), t.indexOf('5.3 — Bonus tasks'));
    for (const k of ['ai_image', 'ai_video_per_second', 'ai_music', 'ai_music_shared', 'x_link_post']) assert.ok(c52.includes(`data-task-cost="${k}"`), k);
    assert.match(c52, /data-task-seconds="5">20 tasks<\/span>/, 'the 5-second example is computed');
    assert.match(c52, /data-task-seconds="10">40 tasks<\/span>/);
});

check('/task-costs.js words the extra keys as the server does', () => {
    const js = read('task-costs.js');
    assert.match(js, /kind === 'ai_video_per_second'[^\n]*\+ ' a second'/);
    assert.match(js, /kind === 'chat_messages_per_task'/);
    assert.match(js, /data-task-seconds/);
});

check('app copy and chat instructions no longer write a cost in', () => {
    for (const f of ['src/components/assistant-site-editor.js', 'src/components/assistant-videos.js', 'netlify/functions/chat-orchestrator.ts']) {
        const code = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        assert.doesNotMatch(code, /\b(uses?|for|\() ?1 task\b(?! —)/, `${f} still writes "1 task" in`);
    }
});

console.log(`\n${passed} checks passed`);
