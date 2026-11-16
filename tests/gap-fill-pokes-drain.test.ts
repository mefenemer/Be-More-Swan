// tests/gap-fill-pokes-drain.test.ts
// A settings save that queues a batch of drafts must start the drain itself.
//
// Staging 2026-11-15: five scheduled jobs for one assistant were queued at 11:40:50Z by a gap-fill
// and nothing looked at them until an unrelated on-demand draft poked the queue at 11:42:36Z. On
// staging the only other drain is staging-crons.yml, which GitHub runs every few hours.
//
// Run:  npx tsx tests/gap-fill-pokes-drain.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

async function main(): Promise<void> {
    console.log('\n──── user-facing gap-fills start the drain ────');

    for (const [file, enqueuedVar] of [
        ['netlify/functions/set-draft-horizon.ts', 'gapFillEnqueued'],
        ['netlify/functions/update-assistant-context.ts', 'draftsQueued'],
    ] as const) {
        await check(`${file} pokes after its gap-fill`, () => {
            const s = read(file);
            const enq = s.indexOf(`${enqueuedVar} = result.enqueued;`);
            assert.ok(enq > 0, 'gap-fill assignment not found');
            const poke = s.indexOf('await triggerGapFillDrain(', enq);
            assert.ok(poke > enq && poke - enq < 600, 'triggerGapFillDrain must follow the gap-fill directly');
            assert.match(s.slice(poke, poke + 300), new RegExp(`enqueued: ${enqueuedVar}`));
        });
    }

    await check('every caller of enqueueScheduleGapFill / enqueueBlogGapFill is a cron, or pokes', () => {
        const callers: Record<string, string> = {
            'netlify/functions/set-draft-horizon.ts': 'poke',
            'netlify/functions/update-assistant-context.ts': 'poke',
            'netlify/functions/draft-horizon-fill.ts': 'cron',
            'src/utils/redraft-upcoming.ts': 'caller pokes (redraft-upcoming-posts.ts)',
        };
        for (const [f, why] of Object.entries(callers)) {
            const s = read(f);
            assert.ok(/enqueue(Schedule|Blog)GapFill\(/.test(s), `${f} no longer calls a gap-fill — update this list`);
            if (why === 'poke') assert.ok(s.includes('triggerGapFillDrain('), `${f} must poke`);
        }
        assert.ok(read('netlify/functions/redraft-upcoming-posts.ts').includes('triggerContentDrain('));
    });

    console.log('\n──── triggerGapFillDrain picks the right drain ────');
    process.env.CRON_TRIGGER_SECRET = 's';
    process.env.BASE_URL = 'https://staging.example.test';
    const { triggerGapFillDrain } = await import('../src/utils/trigger-drain');
    const realFetch = globalThis.fetch;
    let urls: string[] = [];
    globalThis.fetch = (async (u: unknown) => { urls.push(String(u)); return new Response(null, { status: 202 }); }) as typeof fetch;

    await check('nothing queued → no poke', async () => {
        urls = [];
        assert.strictEqual(await triggerGapFillDrain(undefined, { enqueued: 0, blog: false, assistantId: 1 }, 't'), false);
        assert.deepStrictEqual(urls, []);
    });
    await check('social batch → content drain', async () => {
        urls = [];
        assert.strictEqual(await triggerGapFillDrain(undefined, { enqueued: 5, blog: false, assistantId: 17 }, 't'), true);
        assert.deepStrictEqual(urls, ['https://staging.example.test/.netlify/functions/run-content-jobs-background']);
    });
    await check('blog batch → blog drain', async () => {
        urls = [];
        await triggerGapFillDrain(undefined, { enqueued: 2, blog: true, assistantId: 9 }, 't');
        assert.deepStrictEqual(urls, ['https://staging.example.test/.netlify/functions/run-blog-jobs-background']);
    });
    globalThis.fetch = realFetch;

    console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
