// tests/review-link-image-regen-stock-more.test.ts
// Three post-editor fixes from one report (2026-09-30):
//
//  1. The chat's "Drafted this post — review & approve" link was a plain href to the assistant
//     detail page: a full page load, just to pop the post editor. It now opens the editor in place
//     — and closes the chat modal first, because both share z-[90] and the chat sits later in the
//     DOM, so the editor would otherwise open BEHIND it and the click would look dead.
//  2. "Generate with AI" in the post editor (regenerate-post-media) ran on Netlify's 10s default
//     against a 22s Fal poll budget, and recorded nothing about a failure — every cause read as
//     "Could not regenerate the image. Please try again."
//  3. Stock search could only ever offer page 1's top five (the query is cached), so there was no
//     way to see different photos for the same words. "Show different photos" now excludes what
//     was shown and pages deeper.
//
// Run:  npx tsx tests/review-link-image-regen-stock-more.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ── 3. Stock search paging, for real against a fake Pexels ─────────────────────
process.env.PEXELS_API_KEY = 'test-key';
const PAGES = 3;               // the fake account has 3 pages of 15 photos, then nothing
let fetches: number[] = [];
(globalThis as any).fetch = async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    fetches.push(page);
    const photos = page > PAGES ? [] : Array.from({ length: 15 }, (_, i) => {
        const id = (page - 1) * 15 + i + 1;
        return { id, alt: `photo ${id}`, photographer: 'p', src: { large: `https://img/${id}.jpg` }, width: 1, height: 1 };
    });
    return new Response(JSON.stringify({ photos }), { status: 200 });
};
// Cache always misses; posted_assets (dedup) is empty. Every chain resolves to [].
const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? (res: (v: unknown) => void) => res([]) : chain),
    apply: () => chain,
});
const ids = (xs: Array<{ providerAssetId: string }>) => xs.map((c) => Number(c.providerAssetId));

async function main() {
    const { searchUniqueImages } = await import('../src/utils/pexels');
    const kw = { keywords: 'coffee shop' };

    await check('a first search is unchanged: page 1, top five, one request', async () => {
        fetches = [];
        const r = await searchUniqueImages(chain, 1, 'ctx', kw);
        assert.deepStrictEqual(ids(r.candidates), [1, 2, 3, 4, 5]);
        assert.deepStrictEqual(fetches, [1]);
    });

    await check('"different photos" skips everything already shown', async () => {
        const r = await searchUniqueImages(chain, 1, 'ctx', { ...kw, exclude: ['1', '2', '3', '4', '5'] });
        assert.deepStrictEqual(ids(r.candidates), [6, 7, 8, 9, 10]);
    });

    await check('when page 1 is used up it pages deeper, never repeating', async () => {
        const shown = Array.from({ length: 15 }, (_, i) => String(i + 1));
        const r = await searchUniqueImages(chain, 1, 'ctx', { ...kw, exclude: shown });
        assert.deepStrictEqual(ids(r.candidates), [16, 17, 18, 19, 20]);
    });

    await check('past the last page it returns nothing (the UI says so) rather than repeats', async () => {
        const shown = Array.from({ length: 45 }, (_, i) => String(i + 1));
        fetches = [];
        const r = await searchUniqueImages(chain, 1, 'ctx', { ...kw, exclude: shown });
        assert.deepStrictEqual(r.candidates, []);
        assert.deepStrictEqual(fetches, [1, 2, 3, 4], 'stops at the first empty page');
    });

    await check('dedup:false callers (blog heroes) still take page 1 as-is', async () => {
        fetches = [];
        const r = await searchUniqueImages(chain, 1, 'ctx', { ...kw, dedup: false });
        assert.deepStrictEqual(ids(r.candidates), [1, 2, 3, 4, 5]);
        assert.deepStrictEqual(fetches, [1]);
    });

    await check('the endpoint passes keywords + exclude through, and the editor sends them', () => {
        const fn = read('netlify/functions/pexels-search.ts');
        assert.match(fn, /const opts = \{ dedup, exclude, \.\.\.\(keywordsGiven/);
        const ws = read('workspace.html');
        assert.match(ws, /id="gp-ai-find-more" onclick="gpAiRunFind\(true\)"/);
        assert.match(ws, /exclude: _gpAiFindState\.shown/);
        assert.match(ws, /_gpAiFindState\.shown\.push\(/, 'shown ids must accumulate, or the second "more" repeats the first');
    });

    // ── 1. Chat review link ───────────────────────────────────────────────────
    await check('the chat review link opens the post editor in place, above the chat', () => {
        const src = read('src/components/chat-session.js');
        const a = src.indexOf('function renderHubLink');
        assert.notStrictEqual(a, -1, 'renderHubLink is gone — update this test');
        const body = src.slice(a, src.indexOf('\n    }\n', a));
        assert.match(body, /e\.preventDefault\(\)/);
        assert.match(body, /window\.openPostReview\(Number\(hubLink\.postId\)\)/);
        assert.match(body, /closeAssistantChatModal/, 'without closing the chat the editor opens BEHIND it (same z-index, later in the DOM)');
        assert.ok(body.indexOf('closeAssistantChatModal') < body.indexOf('window.openPostReview(Number'), 'close the chat BEFORE opening the editor');
        assert.match(body, /cursor = 'progress'/);
        assert.match(body, /a\.href = /, 'keep the href as the fallback outside the workspace shell');
    });

    // ── 2. Image regeneration ─────────────────────────────────────────────────
    await check('regenerate-post-media has the synchronous max timeout', () => {
        assert.match(read('netlify.toml'), /\[functions\.regenerate-post-media\]\s*\n\s*timeout = 26/);
    });

    await check('regenerate-post-media records WHY it failed and names a dead provider honestly', () => {
        const src = read('netlify/functions/regenerate-post-media.ts');
        assert.match(src, /insert\(mediaGenerationJobs\)[\s\S]{0,300}status: 'failed'/);
        assert.match(src, /instanceof FalServiceError[\s\S]{0,300}statusCode: 503/);
    });

    console.log(`\n${passed} checks passed`);
}

main();
