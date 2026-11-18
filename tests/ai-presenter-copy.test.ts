// tests/ai-presenter-copy.test.ts
// Phase A5 (docs/video-producer-screen-walkthrough-plan.md §11): the AI presenter's help, FAQ and public copy,
// and the "upcoming" price that lets a page say "no tasks until 19 December 2026, then 2 tasks a second" from
// the live figures (task cost change 3) instead of a typed date.
//
// Run:  npx tsx tests/ai-presenter-copy.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { upcomingTaskCosts, resolveTaskCosts, type CostRow } from '../src/utils/task-costs';
import { presenterPriceWords } from '../src/utils/video-producer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    return Promise.resolve().then(fn).then(
        () => { passed++; console.log(`  ✓ ${name}`); },
        (err) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; },
    );
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
// Prod's rows on 18 November 2026: the starting 2, the free baseline, the announced rise.
const ROWS: CostRow[] = [
    { changeId: 1, key: 'ai_presenter', units: 2, effectiveFrom: day('2026-10-17') },
    { changeId: 2, key: 'ai_presenter', units: 0, effectiveFrom: day('2026-11-18') },
    { changeId: 3, key: 'ai_presenter', units: 2, effectiveFrom: day('2026-12-19') },
    { changeId: 1, key: 'ai_image', units: 1, effectiveFrom: day('2026-10-17') },
];

(async () => {
    console.log('upcoming costs');

    await check('before 19 December: free now, 2 a second announced for 19 December', () => {
        const now = new Date('2026-11-20T10:00:00Z');
        assert.strictEqual(resolveTaskCosts(ROWS, now).weights.ai_presenter, 0);
        assert.deepStrictEqual(upcomingTaskCosts(ROWS, now), { ai_presenter: { units: 2, from: '2026-12-19' } });
    });

    await check('from 19 December: nothing upcoming, 2 in force', () => {
        const now = new Date('2026-12-19T00:00:00Z');
        assert.strictEqual(resolveTaskCosts(ROWS, now).weights.ai_presenter, 2);
        assert.deepStrictEqual(upcomingTaskCosts(ROWS, now), {});
    });

    await check('the soonest change wins, and unknown keys or bad units are ignored', () => {
        const now = new Date('2026-11-20T00:00:00Z');
        const rows: CostRow[] = [
            ...ROWS,
            { changeId: 4, key: 'ai_presenter', units: 3, effectiveFrom: day('2027-02-01') },
            { changeId: 4, key: 'not_a_cost', units: 9, effectiveFrom: day('2027-02-01') },
            { changeId: 4, key: 'ai_image', units: -1, effectiveFrom: day('2027-02-01') },
        ];
        assert.deepStrictEqual(upcomingTaskCosts(rows, now), { ai_presenter: { units: 2, from: '2026-12-19' } });
    });

    await check('the public endpoint sends the upcoming figures', () => {
        const fn = read('netlify/functions/task-costs.ts');
        assert.match(fn, /upcoming: await getUpcomingTaskCosts\(\),/);
    });

    console.log('pages and chat');

    // task-costs.js run in a sandbox with a fake page: one span with data-task-cost-next, one without.
    await check('task-costs.js: "no tasks until 19 December 2026, then 2 tasks a second" on a -next span only', async () => {
        const mk = (attrs: Record<string, string>, text: string) => ({
            textContent: text,
            getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
            hasAttribute: (k: string) => k in attrs,
        });
        const withNext = mk({ 'data-task-cost': 'ai_presenter', 'data-task-cost-next': '' }, '2 tasks a second');
        const plain = mk({ 'data-task-cost': 'ai_presenter' }, '2 tasks a second');
        const figures = { weights: { ai_presenter: 0 }, upcoming: { ai_presenter: { units: 2, from: '2026-12-19' } } };
        const sandbox: Record<string, unknown> = {
            sessionStorage: { getItem: () => null, setItem: () => {} },
            fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(figures) }),
            document: {
                readyState: 'complete',
                querySelectorAll: (q: string) => (q === '[data-task-cost]' ? [withNext, plain] : []),
                addEventListener: () => {},
            },
        };
        sandbox.window = sandbox;
        vm.runInNewContext(read('task-costs.js'), sandbox);
        await (sandbox.TaskCosts as { ready: Promise<void> }).ready;
        assert.strictEqual(withNext.textContent, 'no tasks until 19 December 2026, then 2 tasks a second');
        assert.strictEqual(plain.textContent, 'no tasks');
    });

    await check('the New video form and the FAQ use the -next span for the presenter', () => {
        assert.match(read('src/components/assistant-videos.js'), /Price: <span data-task-cost="ai_presenter" data-task-cost-next>2 tasks a second<\/span> while they're on screen/);
        assert.match(read('src/components/assistant-videos.js'), /if \(window\.TaskCosts\) \{ window\.TaskCosts\.apply\(el\);/);
        assert.match(read('faq.html'), /An AI presenter uses <span data-task-cost="ai_presenter" data-task-cost-next>2 tasks a second<\/span> while they're on screen\./);
    });

    await check('the chat hears the free period and the price after it', () => {
        assert.strictEqual(presenterPriceWords(0, { units: 2, from: '2026-12-19' }), 'no tasks until 19 December 2026, then 2 tasks a second');
        assert.strictEqual(presenterPriceWords(2), '2 tasks a second');
        assert.strictEqual(presenterPriceWords(1), '1 task a second');
    });

    console.log('help and public copy');

    await check('help SQL: two guarded edits, the price written out (no token), bodies without doubled apostrophes', () => {
        const s = read('db/help-articles-2026-11-18-ai-presenter.sql');
        assert.match(s, /AND content_md NOT LIKE '%## An AI presenter%';/);
        assert.match(s, /AND content_md NOT LIKE '%An AI presenter in a video%';/);
        assert.ok(s.includes('From then, it counts as 2 tasks for each second the presenter is on screen'));
        const bodies = s.match(/\$\$[\s\S]*?\$\$/g) ?? [];
        assert.ok(bodies.length >= 3);
        for (const b of bodies) {
            assert.ok(!b.includes('{{tasks.ai_presenter}}'), 'a token would read "no tasks" until 19 December');
            assert.ok(!b.includes("''"), 'apostrophes are literal inside $$');
            assert.ok(!b.includes(';'), 'no semicolons inside a body');
        }
    });

    await check('the Video Producer showcase names the presenter and its price, and the SQL was regenerated', () => {
        const vp = JSON.parse(read('db/assistant-showcases.json')).video_producer;
        assert.ok(vp.features.some((f: { title: string }) => f.title === 'An AI presenter, if you want one'));
        assert.ok(vp.faqs.find((f: { q: string }) => f.q === 'Does it use tasks?').a.includes('An AI presenter uses {{tasks.ai_presenter}} while they\'re on screen.'));
        assert.ok(read('db/z-assistant-showcases.sql').includes('An AI presenter, if you want one'));
    });

    await check('fal.ai rows say it makes the presenter clips', () => {
        assert.ok(read('privacy.html').includes('including AI presenter clips (a made-up person speaking the AI voiceover)'));
        assert.ok(read('trust.html').includes('AI image and video generation from your prompts, including AI presenter clips'));
    });
    console.log(`\n${passed} checks passed.`);
})();
