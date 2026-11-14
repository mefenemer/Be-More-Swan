// tests/blog-to-social.test.ts — FR#12 (owner 2026-11-14): the Social Media Assistant reads the article, not just
// its title — in the automatic hand-off from a blog publish and in its chat.

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    console.log('blog-to-social');
    const path = join(root, 'src/utils/blog-to-social.ts');
    await check('the module exists', () => assert.ok(existsSync(path)));
    const m: any = existsSync(path) ? await import('../src/utils/blog-to-social') : {};
    const body = '---\ntitle: x\n---\n# Spring planting\n\n:::media{asset=12 alt="a"}\n:::\n\nPlant [garlic](https://e.test) in October.\n\n![p](asset://3)\n\nWater weekly.';

    await check('article words keep the text and drop media directives, pictures and link addresses', () => {
        assert.strictEqual(m.articleText(body), '# Spring planting\n\nPlant garlic in October.\n\nWater weekly.');
    });

    await check('the hand-off context carries the article, its summary and link — not just the title', () => {
        const c = m.blogHandoffContext('Promote it', 'Blog Writer', { title: 'Spring planting', summary: 'When to plant.', body, url: 'https://shop.test/blog/spring' });
        assert.ok(c.startsWith('Promote it. Write the post about this article that Blog Writer has just published'));
        assert.ok(c.includes('Title: Spring planting') && c.includes('Summary: When to plant.'));
        assert.ok(c.includes('Plant garlic in October.') && c.includes('Water weekly.'), 'the words');
        assert.ok(c.includes('Link to the article: https://shop.test/blog/spring'));
        assert.ok(!c.includes(':::media') && !c.includes('asset://'));
    });

    await check('a long article is clipped at a paragraph break and marked', () => {
        const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} has some words in it to fill space.`).join('\n\n');
        const c = m.blogHandoffContext('Promote it', 'B', { title: 'T', summary: null, body: long, url: null });
        assert.ok(c.length < 3000, `length ${c.length}`);
        assert.ok(/\n\[…\]$/.test(c), 'marked as clipped');
    });

    await check('no words → the old one-line context', () => {
        assert.strictEqual(m.blogHandoffContext('Promote it', 'B', { title: 'T', summary: null, body: '', url: null }), 'Promote it. Context from B\'s post: "T".');
    });

    await check('the chat block shows each recent article\'s words, and says so when there are none', () => {
        const t = m.renderRecentArticlesForChat([{ title: 'Spring planting', summary: 'When to plant.', body, url: 'https://shop.test/b', publishedAt: '2026-11-10T09:00:00Z' }], 45);
        assert.ok(t.includes('- Article "Spring planting" (published 2026-11-10) — link https://shop.test/b'));
        assert.ok(t.includes('Its words: # Spring planting Plant garlic in October. Water weekly.'));
        assert.ok(m.renderRecentArticlesForChat([], 45).includes('None published in that time'));
    });

    await check('wired: the hand-off reads the article, and the Social chat snapshot carries the block', () => {
        const o = read('src/utils/orchestration.ts');
        assert.ok(o.includes("sourcePostKind === 'blog_post' && sourcePostId") && o.includes('blogHandoffContext(link.targetAction, sourceName, article)'));
        const c = read('netlify/functions/chat-orchestrator.ts');
        const i = c.indexOf("const contentSnapshot = route.contentSnapshot === 'posts'");
        assert.ok(c.slice(i, i + 900).includes('renderRecentArticlesForChat(a, RECENT_ARTICLE_DAYS)'));
    });

    console.log(`\n${passed} passed`);
})();
