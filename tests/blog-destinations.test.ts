// tests/blog-destinations.test.ts
// Locks the pure request builders for the blog connectors (US 3.2 — Dev.to, Hashnode): tag
// normalisation, canonical/cover mapping, publish-vs-update shape. No network or DB.
// Run:  npx tsx tests/blog-destinations.test.ts

import assert from 'node:assert';
import { buildDevtoArticle, normaliseDevtoTags } from '../src/utils/blog-destinations/devto';
import { buildHashnodeInput, buildHashnodeTags } from '../src/utils/blog-destinations/hashnode';
import type { BlogDestinationPost } from '../src/utils/blog-destinations/types';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const post: BlogDestinationPost = {
    title: 'Hello World',
    bodyMarkdown: '# Hi\n\nBody text.',
    canonicalUrl: 'https://blog.example.com/hello-world',
    tags: ['Web Dev', 'type-script', 'AI', 'Web Dev', 'node.js', 'extra'],
    coverImageUrl: null,
    metaDescription: 'A short intro.',
};

// ── Dev.to ──────────────────────────────────────────────────────────────────
check('devto tags: lowercased, alphanumeric-only, deduped, capped at 4', () => {
    assert.deepEqual(normaliseDevtoTags(post.tags), ['webdev', 'typescript', 'ai', 'nodejs']);
});

check('devto article maps body_markdown + canonical + published flag', () => {
    const { article } = buildDevtoArticle(post, { publish: true });
    assert.equal(article.title, 'Hello World');
    assert.equal(article.body_markdown, post.bodyMarkdown);
    assert.equal(article.published, true);
    assert.equal(article.canonical_url, post.canonicalUrl);
    assert.equal(article.description, 'A short intro.');
    assert.ok(!('main_image' in article), 'no cover URL → no main_image key');
});

check('devto draft flag flows through', () => {
    assert.equal(buildDevtoArticle(post, { publish: false }).article.published, false);
});

check('devto omits canonical when absent', () => {
    const { article } = buildDevtoArticle({ ...post, canonicalUrl: null }, { publish: true });
    assert.ok(!('canonical_url' in article));
});

// ── Hashnode ────────────────────────────────────────────────────────────────
check('hashnode tags: slug+name objects, deduped, capped at 5', () => {
    assert.deepEqual(buildHashnodeTags(post.tags), [
        { slug: 'web-dev', name: 'Web Dev' },
        { slug: 'type-script', name: 'type-script' },
        { slug: 'ai', name: 'AI' },
        { slug: 'node-js', name: 'node.js' },
        { slug: 'extra', name: 'extra' },
    ]);
});

check('hashnode publish input carries publicationId, not id', () => {
    const input = buildHashnodeInput(post, 'pub_123');
    assert.equal(input.publicationId, 'pub_123');
    assert.equal(input.contentMarkdown, post.bodyMarkdown);
    assert.equal(input.originalArticleURL, post.canonicalUrl);
    assert.ok(!('id' in input), 'fresh publish has no id');
});

check('hashnode update input carries id, not publicationId', () => {
    const input = buildHashnodeInput(post, 'pub_123', 'post_abc');
    assert.equal(input.id, 'post_abc');
    assert.ok(!('publicationId' in input), 'update omits publicationId');
});

check('hashnode maps cover image when present', () => {
    const input = buildHashnodeInput({ ...post, coverImageUrl: 'https://img.example.com/c.jpg' }, 'pub_123');
    assert.deepEqual(input.coverImageOptions, { coverImageURL: 'https://img.example.com/c.jpg' });
});

console.log(`\n${passed} checks passed.`);
