// tests/blog-picture-use.test.ts — FR#28 (owner 2026-11-14): the Blog Writing Assistant's chat can see which
// articles use which picture, so "has this picture been used already?" has a real answer.

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
console.log('blog-picture-use');
const path = join(root, 'src/utils/blog-picture-use.ts');

(async () => {
await check('the module exists', () => assert.ok(existsSync(path), 'src/utils/blog-picture-use.ts'));
const m: any = existsSync(path) ? await import('../src/utils/blog-picture-use') : {};

await check('pictures in the text: :::media (any attribute order, columns) and asset:// markdown, once each', () => {
    const body = 'Intro\n:::media{asset=12 alt="a"}\n:::\n:::columns\n:::media{alt="b" asset="30"}\n:::\n![x](asset://12) ![y](asset://7) ![z](https://e.test/p.jpg)';
    assert.deepStrictEqual(m.bodyPictureIds(body), [12, 30, 7]);
    assert.deepStrictEqual(m.bodyPictureIds(null), []);
});

await check('a picture used by two articles lists both, with how each uses it', () => {
    const list = m.collectPictureUse([
        { id: 5, title: 'Spring', status: 'published', featureAssetId: 12, cardImageAssetId: null, linkedAssetIds: [12, 40], body: ':::media{asset=12}' },
        { id: 9, title: 'Summer', status: 'draft', featureAssetId: null, cardImageAssetId: 12, linkedAssetIds: [], body: '' },
    ], new Map([[12, 'beach.jpg']]));
    assert.strictEqual(list[0].assetId, 12);
    assert.strictEqual(list[0].uses.length, 2);
    assert.deepStrictEqual(list[0].uses[0].roles, ['feature picture', 'in the text']);
    assert.deepStrictEqual(list[0].uses[1].roles, ['card picture']);
    assert.ok(list.find((p: any) => p.assetId === 40).uses[0].roles.includes('attached'));
    const text = m.renderPictureUseForChat(list);
    assert.ok(text.includes('picture #12 "beach.jpg" — used in 2 articles: #5 "Spring" (published; feature picture, in the text); #9 "Summer" (draft; card picture)'), text);
    assert.ok(/not listed is in none/.test(text), 'unlisted = unused, said plainly');
});

await check('no pictures yet is said, not left blank', () => {
    assert.ok(m.renderPictureUseForChat([]).includes('No article uses a picture yet'));
});

await check('the Blog chat snapshot carries the block, and a read failure is admitted', () => {
    const s = readFileSync(join(root, 'src/utils/content-snapshot.ts'), 'utf8');
    const fn = s.slice(s.indexOf('export async function buildBlogSnapshot'), s.indexOf('// ── Email Marketing assistant'));
    assert.ok(fn.includes('loadBlogPictureUse(db, organisationId, aiAssistantId)') && fn.includes('renderPictureUseForChat'));
    assert.ok(fn.includes('never guess whether a picture was used'));
    assert.ok(/\$\{keywords\}\\n\\n\$\{pictures\}/.test(fn), 'appended to the snapshot');
});

console.log(`\n${passed} passed`);
})();
