// tests/blog-destinations.test.ts
// Locks the pure request builders for the blog connectors (US 3.2 — Dev.to, Hashnode): tag
// normalisation, canonical/cover mapping, publish-vs-update shape. No network or DB.
// Run:  npx tsx tests/blog-destinations.test.ts

import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { buildDevtoArticle, normaliseDevtoTags } from '../src/utils/blog-destinations/devto';
import { buildHashnodeInput, buildHashnodeTags } from '../src/utils/blog-destinations/hashnode';
import { buildWordpressPost, normaliseSiteUrl } from '../src/utils/blog-destinations/wordpress';
import { buildGhostPost, ghostAdminBase, signGhostToken } from '../src/utils/blog-destinations/ghost';
import type { BlogDestinationPost } from '../src/utils/blog-destinations/types';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const post: BlogDestinationPost = {
    title: 'Hello World',
    bodyMarkdown: '# Hi\n\nBody text.',
    bodyHtml: '<h1>Hi</h1><p>Body text.</p>',
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

// ── WordPress ─────────────────────────────────────────────────────────────
check('wordpress uses HTML body + publish status + resolved tag IDs', () => {
    const body = buildWordpressPost(post, { publish: true, tagIds: [11, 22] });
    assert.equal(body.title, 'Hello World');
    assert.equal(body.content, post.bodyHtml, 'HTML body, not markdown');
    assert.equal(body.status, 'publish');
    assert.equal(body.excerpt, 'A short intro.');
    assert.deepEqual(body.tags, [11, 22]);
});

check('wordpress omits tags key when none resolved; draft flag', () => {
    const body = buildWordpressPost(post, { publish: false, tagIds: [] });
    assert.ok(!('tags' in body));
    assert.equal(body.status, 'draft');
});

check('wordpress falls back to markdown when no HTML snapshot', () => {
    assert.equal(buildWordpressPost({ ...post, bodyHtml: null }, { publish: true, tagIds: [] }).content, post.bodyMarkdown);
});

check('normaliseSiteUrl trims trailing slashes', () => {
    assert.equal(normaliseSiteUrl('https://x.com/'), 'https://x.com');
    assert.equal(normaliseSiteUrl('  https://x.com///  '), 'https://x.com');
});

// ── Ghost ─────────────────────────────────────────────────────────────────
check('ghost wraps HTML in posts[] with published status + tag objects', () => {
    const payload = buildGhostPost(post, { publish: true });
    assert.equal(payload.posts.length, 1);
    const p = payload.posts[0] as Record<string, unknown>;
    assert.equal(p.html, post.bodyHtml);
    assert.equal(p.status, 'published');
    assert.deepEqual((p.tags as { name: string }[])[0], { name: 'Web Dev' });
    assert.equal(p.canonical_url, post.canonicalUrl);
    assert.equal(p.custom_excerpt, 'A short intro.');
});

check('ghost custom_excerpt capped at 300 chars', () => {
    const long = 'x'.repeat(400);
    const p = buildGhostPost({ ...post, metaDescription: long }, { publish: true }).posts[0] as Record<string, unknown>;
    assert.equal((p.custom_excerpt as string).length, 300);
});

check('ghostAdminBase appends the admin path', () => {
    assert.equal(ghostAdminBase('https://blog.example.com/'), 'https://blog.example.com/ghost/api/admin');
});

check('signGhostToken signs an HS256 JWT with kid + /admin/ audience', () => {
    const token = signGhostToken('abc123:deadbeef');
    const decoded = jwt.decode(token, { complete: true }) as { header: { kid?: string; alg?: string }; payload: { aud?: string } };
    assert.equal(decoded.header.kid, 'abc123');
    assert.equal(decoded.header.alg, 'HS256');
    assert.equal(decoded.payload.aud, '/admin/');
});

console.log(`\n${passed} checks passed.`);
