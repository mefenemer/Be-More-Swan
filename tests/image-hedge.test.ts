// tests/image-hedge.test.ts
// The hedged image draw in src/lib/fal-gateway.ts (generateImages → drawOneHedged).
//
// What goes wrong silently if this drifts:
//   · FLUX.2 Pro takes 9–17 s with a long tail (65 s once in the 2026-11-02 bake-off). The editor's
//     functions give it 18 s inside a 26 s limit, so without the FLUX 1.1 Pro hedge a slow draw is a
//     refunded "try again" for the customer.
//   · A hedge that fires on every call doubles the image bill; one whose loser isn't cancelled keeps
//     billing at fal after we've stopped waiting.
//   · The cost log must name the model that actually drew the picture — they're priced differently.
// No network (fetch is faked), no database. Takes ~15 s: it waits on the real 1.5 s poll.
//
// Run:  npx tsx tests/image-hedge.test.ts

import assert from 'node:assert';

process.env.FAL_KEY = 'test-key';
delete process.env.FAL_IMAGE_MODEL;
delete process.env.FAL_FAST_IMAGE_MODEL;

const MAIN = 'fal-ai/flux-2-pro';
const FAST = 'fal-ai/flux-pro/v1.1';

/** Fake fal queue: each model finishes `doneAfterMs` after it is submitted (Infinity = never). */
function fakeFal(doneAfterMs: Record<string, number>) {
    const submitted: string[] = [];
    const cancelled: string[] = [];
    const startedAt: Record<string, number> = {};
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const u = String(url);
        const model = [MAIN, FAST].find((m) => u.includes(m));
        if (!model) throw new Error(`unexpected fetch ${u}`);
        if (init?.method === 'POST') {
            submitted.push(model);
            startedAt[model] = Date.now();
            const base = `https://queue.fal.run/${model}/requests/1`;
            return json({ request_id: '1', status_url: `${base}/status`, response_url: base });
        }
        if (init?.method === 'PUT') { cancelled.push(model); return json({}); }
        if (u.endsWith('/status')) {
            return json({ status: Date.now() - startedAt[model] >= doneAfterMs[model] ? 'COMPLETED' : 'IN_PROGRESS' });
        }
        return json({ images: [{ url: `https://img/${model}`, width: 1024, height: 1024, content_type: 'image/png' }] });
    }) as typeof fetch;
    return { submitted, cancelled };
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

async function main(): Promise<void> {
const { generateImages } = await import('../src/lib/fal-gateway');
console.log('\nHedged image draw — FLUX.2 Pro first, FLUX 1.1 Pro only when it runs long');

await check('a quick FLUX.2 Pro draw never starts the hedge', async () => {
    const fal = fakeFal({ [MAIN]: 1_000, [FAST]: 0 });
    const [img] = await generateImages({ prompt: 'a cafe', aspectRatio: '1:1', numImages: 1, timeoutMs: 22_000 });
    assert.strictEqual(img.url, `https://img/${MAIN}`);
    assert.deepStrictEqual(fal.submitted, [MAIN], 'no FLUX 1.1 request when FLUX.2 finishes in time');
});

await check('a slow FLUX.2 Pro draw is overtaken by FLUX 1.1 Pro, and the slow one is cancelled', async () => {
    const fal = fakeFal({ [MAIN]: Infinity, [FAST]: 500 });
    const [img] = await generateImages({ prompt: 'a cafe', aspectRatio: '1:1', numImages: 1, timeoutMs: 9_000 });
    assert.strictEqual(img.url, `https://img/${FAST}`);
    assert.deepStrictEqual(fal.submitted, [MAIN, FAST]);
    assert.deepStrictEqual(fal.cancelled, [MAIN], 'the abandoned FLUX.2 request must be cancelled or it keeps billing');
});

await check('when neither finishes, both are cancelled and it throws a clean timeout', async () => {
    const fal = fakeFal({ [MAIN]: Infinity, [FAST]: Infinity });
    await assert.rejects(
        generateImages({ prompt: 'a cafe', aspectRatio: '1:1', numImages: 1, timeoutMs: 8_500 }),
        /timed out/,
    );
    assert.deepStrictEqual([...fal.cancelled].sort(), [FAST, MAIN].sort());
});

await check('several images are several requests — FLUX.2 Pro has no num_images', async () => {
    const fal = fakeFal({ [MAIN]: 0, [FAST]: 0 });
    const images = await generateImages({ prompt: 'a cafe', aspectRatio: '1:1', numImages: 3, timeoutMs: 22_000 });
    assert.strictEqual(images.length, 3);
    assert.deepStrictEqual(fal.submitted, [MAIN, MAIN, MAIN]);
});

console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
