// tests/site-social-feed.test.ts
// The social posts section (owner 2026-10-20): hosted sites only, and ONLY posts published through
// Be More Swan, read when the page is drawn. The section holds platforms, a count, an on/off switch —
// and its page is configurable (move_section toPageId), in the editor and in chat alike.
//
// Run:  npx tsx tests/site-social-feed.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySiteOperation, normaliseSiteDefinition, type SiteDefinition, type SocialFeedProps } from '../src/utils/site-definition';
import { feedPostsFor, renderSitePage } from '../src/utils/site-render';
import { groupFeedPosts, type SiteRenderSocialFeed } from '../src/utils/site-social-feed';
import { siteFromDraftReply } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const site = (props: Record<string, unknown>) => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Florist' },
    pages: [
        { title: 'Home', slug: '', sections: [{ id: 'h1', type: 'hero', props: { headline: 'Flowers' } }, { id: 'sf', type: 'social_feed', props }] },
        { title: 'About', slug: 'about', sections: [{ id: 't1', type: 'text', props: { body: 'Us.' } }] },
    ],
});
const feedOf = (d: SiteDefinition) => d.pages.flatMap((p) => p.sections).find((s) => s.type === 'social_feed')?.props as SocialFeedProps | undefined;
const live = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, assetUrl: (id: number) => `https://media.example/a/${id}` };

const row = (o: Partial<Parameters<typeof groupFeedPosts>[0][number]>) => ({
    id: 1, platform: 'instagram', caption: 'Hello', publishedAt: '2026-10-19T10:00:00Z', platformPostUrl: null, contentAssetIds: [], crosspostGroupId: null, ...o,
});
const feed: SiteRenderSocialFeed = { posts: groupFeedPosts([
    row({ id: 3, platform: 'instagram', caption: 'Autumn wreaths are in', platformPostUrl: 'https://www.instagram.com/p/abc/', contentAssetIds: [41], crosspostGroupId: 'g1' }),
    row({ id: 4, platform: 'facebook', caption: 'Autumn wreaths are in', platformPostUrl: 'https://www.facebook.com/1/posts/2', contentAssetIds: [41], crosspostGroupId: 'g1' }),
    row({ id: 2, platform: 'linkedin', caption: 'We are hiring', publishedAt: '2026-10-10T10:00:00Z', platformPostUrl: 'javascript:alert(1)' }),
], new Map([[41, 'image']])) };

console.log('\nThe gate');

check('defaults: on, 6 posts, every platform, a heading', () => {
    const f = feedOf(site({}).definition)!;
    assert.deepStrictEqual(f, { heading: 'Latest from us', intro: null, platforms: [], count: 6, enabled: true });
});
check('platforms: only real ones, twitter read as x, in a fixed order; count 1–12', () => {
    const f = feedOf(site({ platforms: ['linkedin', 'twitter', 'myspace', 'instagram'], count: 40, enabled: false }).definition)!;
    assert.deepStrictEqual(f.platforms, ['instagram', 'linkedin', 'x']);
    assert.strictEqual(f.count, 6, 'out of range falls back');
    assert.strictEqual(f.enabled, false);
});
check('a draft never adds one — they ask for it', () => {
    const r = siteFromDraftReply({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Hi' } }, { type: 'social_feed', props: {} }] }] }, normaliseSiteDefinition({ settings: { siteName: 'X' } }).definition, 5);
    assert.ok(r, 'the draft itself is usable');
    assert.ok(r.definition.pages[0].sections.some((s) => s.type === 'hero'));
    assert.ok(!r.definition.pages.some((p) => p.sections.some((s) => s.type === 'social_feed')));
});

console.log('\nThe posts');

check('a crosspost is one card with a link per platform', () => {
    assert.strictEqual(feed.posts.length, 2);
    assert.deepStrictEqual(feed.posts[0].links.map((l) => l.platform), ['instagram', 'facebook']);
    assert.deepStrictEqual(feed.posts[0].media, { assetId: 41, video: false });
});
check('only https post addresses are linked', () => {
    assert.strictEqual(feed.posts[1].links[0].url, null);
});
check("a picture that isn't the workspace's own is not drawn", () => {
    const g = groupFeedPosts([row({ contentAssetIds: [99] })], new Map());
    assert.strictEqual(g[0].media, null);
});
check('platform filter keeps only matching posts and links; count caps', () => {
    const li = feedPostsFor(feed, ['facebook'], 6);
    assert.strictEqual(li.length, 1);
    assert.deepStrictEqual(li[0].links.map((l) => l.platform), ['facebook']);
    assert.strictEqual(feedPostsFor(feed, [], 1).length, 1);
});

console.log('\nOn the page');

check('live: cards with the words, picture and a link to the post', () => {
    const html = renderSitePage(site({}).definition, '/', { ...live, socialFeed: feed }).html;
    assert.match(html, /Autumn wreaths are in/);
    assert.match(html, /href="https:\/\/www\.instagram\.com\/p\/abc\/" rel="noopener">See it on Instagram/);
    assert.match(html, /src="https:\/\/media\.example\/a\/41"/);
    assert.ok(!/javascript:/.test(html));
});
check('switched off: gone from the live site, explained in the preview', () => {
    const d = site({ enabled: false }).definition;
    assert.ok(!/Autumn wreaths/.test(renderSitePage(d, '/', { ...live, socialFeed: feed }).html));
    assert.match(renderSitePage(d, '/', { ...live, preview: true, socialFeed: feed }).html, /switched off/);
});
check('nothing published: no empty section on the live site', () => {
    assert.ok(!/id="sf"/.test(renderSitePage(site({}).definition, '/', { ...live, socialFeed: { posts: [] } }).html));
});

console.log('\nWhich page');

check('move_section toPageId moves it onto another page, keeping its settings', () => {
    const d = site({ count: 3 }).definition;
    const home = d.pages[0], about = d.pages[1];
    const sf = home.sections.find((s) => s.type === 'social_feed')!;
    const r = applySiteOperation(d, { op: 'move_section', pageId: home.id, sectionId: sf.id, toPageId: about.id, toIndex: 99 });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(!r.definition.pages[0].sections.some((s) => s.type === 'social_feed'));
    const moved = r.definition.pages[1].sections.at(-1)!;
    assert.strictEqual(moved.type, 'social_feed');
    assert.strictEqual((moved.props as SocialFeedProps).count, 3);
});
check('a page that does not exist is refused', () => {
    const d = site({}).definition;
    const sf = d.pages[0].sections.find((s) => s.type === 'social_feed')!;
    const r = applySiteOperation(d, { op: 'move_section', pageId: d.pages[0].id, sectionId: sf.id, toPageId: 'nope', toIndex: 0 });
    assert.ok(!r.ok);
});

console.log('\nGUI and chat parity');

check('the editor offers platforms, count, on/off and the page', () => {
    const ed = read('src/components/assistant-site-editor.js');
    for (const k of ["k: 'enabled'", "k: 'platforms', kind: 'platformPick'", "k: 'count'", "k: '_page', kind: 'pagePick'"]) assert.ok(ed.includes(k), k);
    assert.match(ed, /op: 'move_section', pageId: ed\.pageId, sectionId: ed\.sectionId, toPageId/);
});
check('the chat knows the section, the op and what has been published', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.match(chat, /social_feed \{heading, intro, platforms:/);
    assert.match(chat, /"toPageId":"<optional: another pageId/);
    assert.match(read('src/utils/site-store.ts'), /socialFeedForPrompt\(db, orgId\)/);
});
check('live site and preview both read the posts', () => {
    assert.match(read('netlify/functions/site-serve.ts'), /socialFeed: await loadSiteSocialFeed\(db, site\.organisationId, definition\)/);
    assert.match(read('netlify/functions/site-preview.ts'), /socialFeed: await loadSiteSocialFeed\(db, ctx\.organisationId, definition\)/);
});
check('only published posts, only this workspace, never a platform fetch', () => {
    const src = read('src/utils/site-social-feed.ts');
    assert.match(src, /eq\(scheduledPosts\.organisationId, orgId\), eq\(scheduledPosts\.status, 'published'\)/);
    assert.match(src, /eq\(contentAssets\.organisationId, orgId\)/);
    assert.ok(!/fetch\(/.test(src));
});

console.log(`\n${passed}/${total} passed`);
