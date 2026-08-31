// tests/blog-destinations.test.ts
// Locks the pure request builders for the blog connectors (US 3.2 — Dev.to, Hashnode): tag
// normalisation, canonical/cover mapping, publish-vs-update shape. No network or DB.
// Run:  npx tsx tests/blog-destinations.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { landmark } from './landmark';
import { buildDevtoArticle, normaliseDevtoTags } from '../src/utils/blog-destinations/devto';
import { buildHashnodeInput, buildHashnodeTags } from '../src/utils/blog-destinations/hashnode';
import { buildWordpressPost, normaliseSiteUrl } from '../src/utils/blog-destinations/wordpress';
import { buildGhostPost, ghostAdminBase, signGhostToken } from '../src/utils/blog-destinations/ghost';
import { buildWordpresscomPost } from '../src/utils/blog-destinations/wordpresscom';
import { buildLinkedInShare, markdownToPlain, toHashtag, shareUrl, LINKEDIN_TEXT_LIMIT } from '../src/utils/blog-destinations/linkedin';
import { BLOG_AI_NOTICE } from '../src/utils/blog-ai-assisted';
import {
    BLOG_DESTINATION_IDS, AVAILABLE_BLOG_DESTINATION_IDS, WITHHELD_BLOG_DESTINATIONS,
    getBlogAdapter, isBlogDestinationId, isBlogDestinationAvailable,
} from '../src/utils/blog-destinations';
import { projectPost, summariseSyndication } from '../src/utils/blog-destinations/syndicate';
import { DEFAULT_PUBLISH_MODE } from '../src/utils/blog-destinations/store';
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

check('ghost draft flag flows through to status', () => {
    const p = buildGhostPost(post, { publish: false }).posts[0] as Record<string, unknown>;
    assert.equal(p.status, 'draft');
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

// ── WordPress.com (OAuth) ───────────────────────────────────────────────────
check('wordpress.com uses HTML body, publish status, comma-joined tag names', () => {
    const body = buildWordpresscomPost(post, { publish: true });
    assert.equal(body.content, post.bodyHtml, 'HTML body, not markdown');
    assert.equal(body.status, 'publish');
    assert.equal(body.tags, 'Web Dev,type-script,AI,Web Dev,node.js,extra', 'v1.1 takes comma-separated names');
    assert.equal(body.excerpt, 'A short intro.');
});

check('wordpress.com omits tags when none; draft flag', () => {
    const body = buildWordpresscomPost({ ...post, tags: [] }, { publish: false });
    assert.ok(!('tags' in body));
    assert.equal(body.status, 'draft');
});

// ── LinkedIn (social destination) ───────────────────────────────────────────
check('markdownToPlain strips the markup LinkedIn renders as literal text', () => {
    const plain = markdownToPlain(
        '## A heading\n\nSome **bold** and _italic_ and `code` and a [link](https://x.test).\n\n'
        + '- one\n- two\n\n> quoted\n\n---\n\n```js\nconst a = 1;\n```\n',
    );
    assert.ok(!/[#*_`>]/.test(plain), `no markup left: ${JSON.stringify(plain)}`);
    assert.ok(plain.includes('A heading') && plain.includes('bold') && plain.includes('link'));
    assert.ok(plain.includes('• one'), 'list items become bullets');
    assert.ok(!plain.includes('const a = 1'), 'code fences are dropped, not flattened');
});

check('markdownToPlain leaves ordinary underscores and asterisks in prose alone', () => {
    assert.equal(markdownToPlain('a_b_c and 2 * 3 = 6'), 'a_b_c and 2 * 3 = 6');
});

check('hashtags are title-cased, cased words preserved, numerics dropped', () => {
    assert.equal(toHashtag('Web Dev'), '#WebDev');
    assert.equal(toHashtag('type-script'), '#TypeScript');
    assert.equal(toHashtag('AI'), '#AI');
    assert.equal(toHashtag('…'), null);
    assert.equal(toHashtag('2024'), null);
});

check('the share carries the title, a lede, the link and up to 3 hashtags', () => {
    const built = buildLinkedInShare(post);
    assert.ok(built.ok);
    const text = (built as { ok: true; text: string }).text;
    assert.ok(text.startsWith('Hello World'), 'title leads');
    assert.ok(text.includes('Body text.'), 'the lede is the post, de-marked-up');
    assert.ok(text.includes(`Read the full post: ${post.canonicalUrl}`), 'the canonical link is present');
    assert.equal((text.match(/#/g) || []).length, 3, 'three hashtags, no more');
    assert.ok(text.includes('#WebDev') && text.includes('#TypeScript') && text.includes('#AI'));
});

check('a post with no public URL is refused rather than shared as a fragment', () => {
    const built = buildLinkedInShare({ ...post, canonicalUrl: null });
    assert.equal(built.ok, false);
    assert.match((built as { ok: false; error: string }).error, /no public URL/);
});

check('the AI disclosure survives the trim, and is not duplicated in the lede', () => {
    const body = `Intro paragraph.\n\n*${BLOG_AI_NOTICE}*`;
    const built = buildLinkedInShare({ ...post, bodyMarkdown: body });
    assert.ok(built.ok);
    const text = (built as { ok: true; text: string }).text;
    assert.equal(text.split(BLOG_AI_NOTICE).length - 1, 1, 'stated exactly once');
    assert.ok(text.indexOf(BLOG_AI_NOTICE) > text.indexOf('Intro paragraph.'), 'after the lede, not inside it');
});

check('an over-long post loses body, never the link, the disclosure or the tags', () => {
    const long = ('A sentence about the thing. '.repeat(400)) + `\n\n*${BLOG_AI_NOTICE}*`;
    const built = buildLinkedInShare({ ...post, bodyMarkdown: long });
    assert.ok(built.ok);
    const text = (built as { ok: true; text: string }).text;
    assert.ok(text.length <= LINKEDIN_TEXT_LIMIT, `within ${LINKEDIN_TEXT_LIMIT}: got ${text.length}`);
    assert.ok(text.includes(`Read the full post: ${post.canonicalUrl}`));
    assert.ok(text.includes(BLOG_AI_NOTICE));
    assert.ok(text.includes('#WebDev'));
    assert.ok(text.includes('…'), 'the lede is the part that was trimmed');
});

check('a budget too small for a lede still yields a valid title + link share', () => {
    const built = buildLinkedInShare(post, { maxChars: 120 });
    assert.ok(built.ok);
    const text = (built as { ok: true; text: string }).text;
    assert.ok(text.includes(post.canonicalUrl!), 'the link is never what gets dropped');
    assert.ok(!text.includes('Body text.'), 'no room for a lede, so none is attempted');
});

check('LinkedIn is a social destination with no paste fields', () => {
    const a = getBlogAdapter('linkedin');
    assert.equal(a.authKind, 'social');
    assert.equal(a.socialPlatform, 'linkedin');
    assert.deepEqual(a.credFields, [], 'the workspace connection IS the credential');
});

check('share URLs are built from the returned URN', () => {
    assert.equal(shareUrl('urn:li:share:123'), 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A123/');
    // A 201 with no id still posted; a made-up permalink would be a link to a 404.
    assert.equal(shareUrl('posted'), 'https://www.linkedin.com/feed/');
});

// ── Withheld destinations (2026-08-31) ──────────────────────────────────────
check('only the proven destinations are offered', () => {
    // Built, unit-tested, but never run against a live account — so not offered until each is.
    assert.deepEqual([...WITHHELD_BLOG_DESTINATIONS].sort(), ['devto', 'ghost', 'hashnode', 'wordpress', 'wordpresscom']);
    assert.deepEqual(AVAILABLE_BLOG_DESTINATION_IDS.sort(), ['linkedin', 'swanindex']);
});

check('withholding hides a destination without unregistering it', () => {
    // The adapter must still resolve: summariseSyndication names it, getBlogPublishModes keeps its
    // stored mode, and releasing it is meant to be deleting one line — not rebuilding it.
    for (const id of WITHHELD_BLOG_DESTINATIONS) {
        assert.ok(BLOG_DESTINATION_IDS.includes(id), `${id} must stay registered`);
        assert.ok(getBlogAdapter(id), `${id} must still resolve to an adapter`);
        assert.equal(isBlogDestinationAvailable(id), false);
    }
});

check('a withheld id is still a VALID id', () => {
    // save-blog-draft filters `destinations.selected` through this. If it started rejecting withheld
    // ids, the next autosave would silently rewrite an author's saved distribution choice.
    for (const id of WITHHELD_BLOG_DESTINATIONS) assert.ok(isBlogDestinationId(id), `${id} must stay a valid id`);
});

check('a post keeps the history of where it was already published', () => {
    // The one thing withholding must not do is erase what a post already did. This row is what a
    // pre-gate publish to Dev.to looks like in blog_posts.destinations.
    const summary = summariseSyndication({
        widget: 'published',
        selected: ['devto'],
        devto: { status: 'published', externalId: '42', url: 'https://dev.to/x/y' },
    });
    assert.deepEqual(summary, [{ id: 'devto', label: 'Dev.to', status: 'published', url: 'https://dev.to/x/y' }]);
});

// ── Wiring the social destination cannot be typechecked (US 3.2) ────────────
// integrations.js is vanilla browser JS and store.ts's branches need a live DB, so the two
// invariants that would fail SILENTLY in production are asserted against the source itself.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

check('the connections grid routes a social destination to its own card', () => {
    const src = read('../integrations.js');
    const fn = src.slice(landmark(src, 'function _blogDestCard('), landmark(src, 'window._blogDestToggleForm'));
    // Order matters: the paste-form card below would otherwise render a "Connect LinkedIn" button
    // that opens an EMPTY credentials form — the exact failure the first-party card was split out
    // to fix. Both early returns must come before anything else in the function.
    assert.ok(fn.includes('if (d.social) return _socialDestCard(d);'), 'social dispatch is missing');
    assert.ok(
        landmark(fn, 'if (d.social) return _socialDestCard(d);') < landmark(fn, 'const primaryBtn'),
        'the social dispatch must precede the paste-form card body',
    );
});

check('the social card tells "connected" and "enabled" apart', () => {
    const src = read('../integrations.js');
    const card = src.slice(landmark(src, 'function _socialDestCard('), landmark(src, 'function _blogDestCard('));
    // A workspace that connected LinkedIn for its Social Media Manager has NOT asked for its blog
    // posts to go there. If this card ever reads its pill off socialConnected, it promises a
    // syndication that syndicate.ts will not perform.
    assert.ok(card.includes('const enabled = !!d.connected;'), 'the pill must read the opt-in');
    assert.ok(card.includes('const linked = !!d.socialConnected;'), 'the third state must be read');
    assert.ok(card.includes('✓ Enabled'), 'an opted-in destination says so');
    assert.ok(card.includes('Not enabled'), 'connected-but-not-opted-in needs its own wording');
});

check('the connect endpoint refuses a withheld destination, but never traps one', () => {
    const src = read('../netlify/functions/connect-blog-destination.ts');
    const gate = src.slice(landmark(src, 'if (!isBlogDestinationAvailable('), landmark(src, "if (body.action === 'disconnect')"));
    // Hidden from the UI is not enough — a stale tab can still POST. And disconnect must stay open,
    // or a workspace that connected one before the gate went up could never detach it.
    assert.ok(gate.includes("body.action !== 'disconnect'"), 'disconnect must stay allowed');
    assert.ok(
        landmark(src, 'if (!isBlogDestinationAvailable(') < landmark(src, "if (body.action === 'connect')"),
        'the gate must sit above the connect handler',
    );
});

check('turning a social destination off never revokes the shared connection', () => {
    const src = read('../src/utils/blog-destinations/store.ts');
    const fn = src.slice(
        landmark(src, 'export async function deleteBlogDestination'),
        landmark(src, 'export interface BlogDestinationStatus'),
    );
    // Bounded at the paste-destination fall-through below it, so "the branch does not do X" is a
    // claim about the BRANCH and not about the rest of the function.
    const social = fn.slice(
        landmark(fn, "if (adapter.authKind === 'social')"),
        landmark(fn, 'await deleteSecret('),
    );
    // The branch must RETURN. Falling through would delete the blog vault secret and the
    // workspace_integrations row — and the branch above it, for OAuth destinations, calls
    // deleteIntegration, which is how a Social Media Manager would silently stop posting.
    assert.ok(social.includes('setSocialBlogDestinationEnabled(db, organisationId, id, false)'));
    assert.ok(social.includes('return;'), 'the social branch must return, not fall through');
    assert.ok(!social.includes('deleteIntegration('), 'the social branch must not revoke the OAuth grant');
});

// ── Draft support (US 3.2 AC4) ──────────────────────────────────────────────
check('every adapter declares whether it can draft; Hashnode and LinkedIn cannot', () => {
    const undraftable = BLOG_DESTINATION_IDS.filter((id) => {
        const a = getBlogAdapter(id);
        assert.equal(typeof a.supportsDraft, 'boolean', `${id} must declare supportsDraft`);
        return !a.supportsDraft;
    });
    // Hashnode's publishPost has no draft path; a LinkedIn feed post has no draft state at all.
    assert.deepEqual(undraftable.sort(), ['hashnode', 'linkedin']);
});

// ── Auto-syndication projection + publish mode (US 3.2) ─────────────────────
check('publish mode defaults to draft (AC4-safe: never surprise-publish live)', () => {
    assert.equal(DEFAULT_PUBLISH_MODE, 'draft');
});


// `check` is sync-only — an async fn handed to it would never be awaited and would pass silently.
async function checkAsync(name: string, fn: () => Promise<void>) { await fn(); console.log(`  ✓ ${name}`); passed++; }

void (async () => {
    await checkAsync('projectPost maps a published row to the text-only payload', async () => {
        const projected = await projectPost({
            id: 1,
            title: 'Hello World',
            bodyMarkdown: '# Hi\n\nBody text.',
            canonicalUrl: 'https://blog.example.com/hello-world',
            tags: ['Web Dev', 'AI'],
            metaDescription: 'A short intro.',
            destinations: {},
        });
        assert.ok(projected, 'a post with text projects');
        assert.equal(projected!.title, 'Hello World');
        assert.equal(projected!.bodyMarkdown, '# Hi\n\nBody text.');
        assert.ok(/<h1[ >]/.test(projected!.bodyHtml || ''), 'bodyHtml is rendered from the markdown');
        assert.equal(projected!.canonicalUrl, 'https://blog.example.com/hello-world');
        assert.deepEqual(projected!.tags, ['Web Dev', 'AI']);
        assert.equal(projected!.coverImageUrl, null, 'media is never handed to external platforms');
    });

    await checkAsync('projectPost returns null for an empty / whitespace-only body', async () => {
        assert.equal(await projectPost({ id: 1, title: 'X', bodyMarkdown: '   ' }), null);
        assert.equal(await projectPost({ id: 1, title: 'X', bodyMarkdown: null }), null);
    });

    await checkAsync('hashnode refuses a draft push rather than publishing live', async () => {
        // Must reject before any network call — the creds below are never used.
        await assert.rejects(
            () => getBlogAdapter('hashnode').publish(post, { token: 't', publicationId: 'p' } as never, { asDraft: true }),
            /cannot receive drafts/,
        );
    });

    await checkAsync('linkedin refuses a draft push — a feed post has no draft state', async () => {
        await assert.rejects(
            () => getBlogAdapter('linkedin').publish(post, { accessToken: 't', authorUrn: 'urn:li:person:1' } as never, { asDraft: true }),
            /cannot receive drafts/,
        );
    });

    await checkAsync('re-publishing reports the ORIGINAL share instead of posting again', async () => {
        // No network: LinkedIn cannot edit a ugcPost, so an externalId short-circuits before any
        // fetch. If this ever starts making a call, a corrected post would appear in the feed twice.
        const out = await getBlogAdapter('linkedin').publish(
            post,
            { accessToken: 'unused', authorUrn: 'urn:li:person:1' } as never,
            { externalId: 'urn:li:share:999' },
        );
        assert.equal(out.externalId, 'urn:li:share:999');
        assert.equal(out.status, 'published');
        assert.equal(out.url, shareUrl('urn:li:share:999'));
    });

    console.log(`\n${passed} checks passed.`);
})();
