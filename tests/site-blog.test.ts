// tests/site-blog.test.ts
// The Blog Assistant's posts on a hosted site (site-blog.ts): /blog, /blog/<slug> and the blog_posts
// section, drawn by our renderer in the site's look — the Blog Studio embed can't run on a hosted page
// (no script), so it is never what puts the blog there. The switch lives in settings.blog; the editor
// and the chat both send set_settings / add_section for it.
//
// Run:  npx tsx tests/site-blog.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySiteOperation, menuOf, normaliseSiteDefinition, type BlogPostsProps, type SiteDefinition } from '../src/utils/site-definition';
import { renderSiteBlogIndex, renderSiteBlogPost, renderSitemap, renderSitePage } from '../src/utils/site-render';
import { siteBlogCanonical, siteBlogRoute, type SiteBlogPost, type SiteRenderBlog } from '../src/utils/site-blog';
import { siteFromDraftReply } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const site = (extra: Record<string, unknown> = {}, sections: unknown[] = []) => normaliseSiteDefinition({
    settings: { siteName: 'Restorative Futures', ...extra },
    pages: [
        { title: 'Home', slug: '', sections: [{ id: 'h1', type: 'hero', props: { headline: 'Restorative practice' } }, ...sections] },
        { title: 'About', slug: 'about', sections: [{ id: 't1', type: 'text', props: { body: 'Us.' } }] },
    ],
});
const ORIGIN = 'https://www.restorativefutures.co.uk';
const live = { origin: ORIGIN, preview: false, reportUrl: '#', creditUrl: null };
const blog: SiteRenderBlog = { posts: [
    { title: 'Circles in schools', slug: 'circles-in-schools', excerpt: 'How circles work.', publishedAt: '2026-10-20T09:00:00Z', imageUrl: 'https://media.example/c.jpg', imageAlt: 'A circle' },
    { title: 'Repairing harm', slug: 'repairing-harm', excerpt: '', publishedAt: '2026-10-10T09:00:00Z', imageUrl: null, imageAlt: '' },
] };
const postsOf = (d: SiteDefinition) => d.pages.flatMap((p) => p.sections).find((s) => s.type === 'blog_posts')?.props as BlogPostsProps | undefined;

console.log('\nSettings and the gate');

check('a site that never touched the blog keeps its shape (no blog key)', () => {
    assert.ok(!('blog' in site().definition.settings));
});
check('blog setting: enabled + menu label, label clamped, default "Blog"', () => {
    assert.deepStrictEqual(site({ blog: { enabled: true } }).definition.settings.blog, { enabled: true, menuLabel: 'Blog' });
    assert.deepStrictEqual(site({ blog: { enabled: true, menuLabel: 'News & insights' } }).definition.settings.blog, { enabled: true, menuLabel: 'News & insights' });
    assert.strictEqual(site({ blog: { enabled: true, menuLabel: 'x'.repeat(80) } }).definition.settings.blog!.menuLabel.length <= 30, true);
});
check('set_settings with only menuLabel keeps it on; enabled false turns it off', () => {
    const on = site({ blog: { enabled: true } }).definition;
    const renamed = applySiteOperation(on, { op: 'set_settings', settings: { blog: { menuLabel: 'News' } } });
    assert.ok(renamed.ok && renamed.definition.settings.blog!.enabled && renamed.definition.settings.blog!.menuLabel === 'News');
    const off = applySiteOperation(on, { op: 'set_settings', settings: { blog: { enabled: false } } });
    assert.ok(off.ok && off.definition.settings.blog!.enabled === false);
});
check('other set_settings leave the blog as it was', () => {
    const on = site({ blog: { enabled: true, menuLabel: 'News' } }).definition;
    const r = applySiteOperation(on, { op: 'set_settings', settings: { phone: '01234 567890' } });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.definition.settings.blog, { enabled: true, menuLabel: 'News' });
});
check('while the blog is on, a page cannot take /blog (it moves, with a warning)', () => {
    const r = normaliseSiteDefinition({ settings: { siteName: 'X', blog: { enabled: true } }, pages: [{ title: 'Home', slug: '' }, { title: 'Blog', slug: 'blog' }] });
    assert.strictEqual(r.definition.pages[1].slug, 'blog-page');
    assert.ok(r.warnings.some((w) => /blog-page/.test(w)));
    const off = normaliseSiteDefinition({ settings: { siteName: 'X' }, pages: [{ title: 'Home', slug: '' }, { title: 'Blog', slug: 'blog' }] });
    assert.strictEqual(off.definition.pages[1].slug, 'blog', 'blog off: the page keeps its address');
});
check('a button may link to /blog only while the blog is on', () => {
    const cta = { id: 'c', type: 'cta', props: { heading: 'Read', button: { label: 'Our blog', href: '/blog' } } };
    assert.ok(site({ blog: { enabled: true } }, [cta]).definition.pages[0].sections.some((s) => s.type === 'cta'));
    assert.ok(!site({}, [cta]).definition.pages[0].sections.some((s) => s.type === 'cta'));
});
check('blog_posts section: defaults, count 1–12', () => {
    assert.deepStrictEqual(postsOf(site({}, [{ id: 'b', type: 'blog_posts', props: {} }]).definition), { heading: 'From our blog', intro: null, count: 3, enabled: true });
    assert.strictEqual(postsOf(site({}, [{ id: 'b', type: 'blog_posts', props: { count: 99 } }]).definition)!.count, 3);
    assert.strictEqual(postsOf(site({}, [{ id: 'b', type: 'blog_posts', props: { count: 6, enabled: false } }]).definition)!.enabled, false);
});
check('adding a blog_posts section switches the blog on (its links need /blog)', () => {
    const d = site().definition;
    const r = applySiteOperation(d, { op: 'add_section', pageId: d.pages[0].id, section: { type: 'blog_posts', props: {} } });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.definition.settings.blog, { enabled: true, menuLabel: 'Blog' });
});
check('an AI draft never adds blog posts, nor changes the blog switch', () => {
    const current = site({ blog: { enabled: true, menuLabel: 'News' } }).definition;
    const r = siteFromDraftReply({ settings: { blog: { enabled: false } }, pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Hi' } }, { type: 'blog_posts', props: {} }] }] }, current, 5);
    assert.ok(r);
    assert.ok(!r.definition.pages.some((p) => p.sections.some((s) => s.type === 'blog_posts')));
    assert.deepStrictEqual(r.definition.settings.blog, { enabled: true, menuLabel: 'News' });
});

console.log('\nMenu');

check('the blog is the last menu entry, with its label, only while on', () => {
    const on = menuOf(site({ blog: { enabled: true, menuLabel: 'News' } }).definition);
    assert.deepStrictEqual(on[on.length - 1], { label: 'News', path: '/blog', pageId: '_blog' });
    assert.ok(!menuOf(site().definition).some((m) => m.path === '/blog'));
});
check('a full menu still fits the blog (it takes the last place)', () => {
    const pages = [{ title: 'Home', slug: '' }, ...Array.from({ length: 9 }, (_, i) => ({ title: `P${i}`, slug: `p${i}` }))];
    const m = menuOf(normaliseSiteDefinition({ settings: { siteName: 'X', blog: { enabled: true } }, pages }).definition);
    assert.strictEqual(m.length, 7);
    assert.strictEqual(m[6].path, '/blog');
});
check('one-page sites get the blog in the menu too', () => {
    const d = normaliseSiteDefinition({ structure: 'one_page', settings: { siteName: 'X', blog: { enabled: true } }, pages: [{ title: 'Home', slug: '', sections: [{ type: 'text', props: { body: 'a' }, look: { menuLabel: 'About' } }] }] }).definition;
    assert.deepStrictEqual(menuOf(d).map((x) => x.path), ['#s1', '/blog']);
});

console.log('\nRoutes and canonicals');

check('siteBlogRoute: /blog, /blog/, /blog/<slug>; never /blog/a/b or /blogs', () => {
    assert.deepStrictEqual(siteBlogRoute('/blog'), { kind: 'index' });
    assert.deepStrictEqual(siteBlogRoute('/blog/'), { kind: 'index' });
    assert.deepStrictEqual(siteBlogRoute('/blog/circles-in-schools'), { kind: 'post', slug: 'circles-in-schools' });
    assert.deepStrictEqual(siteBlogRoute('/blog/caf%C3%A9'), { kind: 'post', slug: 'café' });
    assert.strictEqual(siteBlogRoute('/blog/a/b'), null);
    assert.strictEqual(siteBlogRoute('/blogs'), null);
    assert.strictEqual(siteBlogRoute('/blog/%E0%A4%A'), null, 'malformed encoding is a 404, not a throw');
});
check('canonical: stamped at this site (either www form) is kept', () => {
    assert.strictEqual(siteBlogCanonical('https://www.restorativefutures.co.uk/blog/x', 'x', ORIGIN), 'https://www.restorativefutures.co.uk/blog/x');
    assert.strictEqual(siteBlogCanonical('https://restorativefutures.co.uk/blog/x', 'x', ORIGIN), 'https://restorativefutures.co.uk/blog/x');
});
check('canonical: our own /b/<key> permalink or none → the hosted page', () => {
    assert.strictEqual(siteBlogCanonical('https://bemoreswan.com/b/wgt_1/x', 'x', ORIGIN), `${ORIGIN}/blog/x`);
    assert.strictEqual(siteBlogCanonical(null, 'x', ORIGIN), `${ORIGIN}/blog/x`);
    assert.strictEqual(siteBlogCanonical('not a url', 'x', ORIGIN), `${ORIGIN}/blog/x`);
});
check('canonical: stamped at another site is kept (published there first)', () => {
    assert.strictEqual(siteBlogCanonical('https://medium.com/@rf/x', 'x', ORIGIN), 'https://medium.com/@rf/x');
});
check('canonical: before the domain moves, a post stamped at the real domain still points there', () => {
    assert.strictEqual(siteBlogCanonical('https://www.restorativefutures.co.uk/blog/x', 'x', 'https://rf.bemoreswan.site', ['https://rf.bemoreswan.site']), 'https://www.restorativefutures.co.uk/blog/x');
});

console.log('\nRendering');

const on = site({ blog: { enabled: true } }, [{ id: 'bp', type: 'blog_posts', props: { count: 2 } }]).definition;
check('blog_posts section: cards link to /blog/<slug>, plus "See all posts"', () => {
    const html = renderSitePage(on, '/', { ...live, blog }).html;
    assert.ok(html.includes('href="/blog/circles-in-schools"'));
    assert.ok(html.includes('href="/blog/repairing-harm"'));
    assert.ok(html.includes('See all posts'));
    assert.ok(html.includes('<a href="/blog"'), 'the menu has the blog');
});
check('blog_posts section: nothing on the live site when off, empty, or the blog is off; a note in the preview', () => {
    const off = site({ blog: { enabled: true } }, [{ id: 'bp', type: 'blog_posts', props: { enabled: false } }]).definition;
    assert.ok(!renderSitePage(off, '/', { ...live, blog }).html.includes('circles-in-schools'));
    assert.ok(!renderSitePage(on, '/', { ...live, blog: { posts: [] } }).html.includes('From our blog'));
    const blogOff = applySiteOperation(on, { op: 'set_settings', settings: { blog: { enabled: false } } });
    assert.ok(blogOff.ok && !renderSitePage(blogOff.definition, '/', { ...live, blog }).html.includes('circles-in-schools'));
    assert.ok(renderSitePage(on, '/', { ...live, preview: true, blog: { posts: [] } }).html.includes('nothing published by your Blog Assistant yet'));
});
check('/blog: one h1, the cards, indexable, the Blog menu entry current, no script but JSON-LD', () => {
    const html = renderSiteBlogIndex(on, live, { posts: blog.posts, olderCursor: 'abc', cursor: null });
    assert.strictEqual((html.match(/<h1/g) || []).length, 1);
    assert.ok(html.includes('href="/blog/circles-in-schools"'));
    assert.ok(!/name="robots"/.test(html));
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/blog">`));
    assert.ok(/<a href="\/blog" aria-current="page">Blog<\/a>/.test(html));
    assert.ok(html.includes('Older posts'));
    assert.ok(!/<script(?! type="application\/ld\+json")/.test(html));
    assert.ok(html.includes('"@type":"Blog"'));
});
check('/blog older pages: noindex, follow', () => {
    const html = renderSiteBlogIndex(on, live, { posts: blog.posts, olderCursor: null, cursor: 42 });
    assert.ok(html.includes('<meta name="robots" content="noindex, follow">'));
});
const post: SiteBlogPost = {
    title: 'Circles in schools', slug: 'circles-in-schools', metaTitle: 'Restorative circles in schools', description: 'How circles work.',
    bodyHtml: '<p>Body text</p><h2>Why</h2>', imageUrl: 'https://media.example/c.jpg', imageAlt: 'A circle', tags: ['schools', 'circles'],
    publishedAt: '2026-10-20T09:00:00Z', modifiedAt: '2026-10-21T09:00:00Z', canonicalUrl: `${ORIGIN}/blog/circles-in-schools`, robots: 'index,follow',
};
check('/blog/<slug>: article in the site look — title, body, canonical, og:article, BlogPosting', () => {
    const html = renderSiteBlogPost(on, live, post);
    assert.strictEqual((html.match(/<h1/g) || []).length, 1);
    assert.ok(html.includes('<title>Restorative circles in schools | Restorative Futures</title>'));
    assert.ok(html.includes('<p>Body text</p><h2>Why</h2>'));
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/blog/circles-in-schools">`));
    assert.ok(html.includes('<meta property="og:type" content="article">'));
    assert.ok(html.includes('<meta property="og:image" content="https://media.example/c.jpg">'));
    assert.ok(html.includes('"@type":"BlogPosting"'));
    assert.ok(html.includes('class="hd'), 'the site header');
    assert.ok(html.includes('Report this site'), 'the site footer');
});
check('/blog/<slug>: a noindex post stays noindex; titles are escaped', () => {
    const html = renderSiteBlogPost(on, live, { ...post, robots: 'noindex,follow', title: '<b>x</b>', metaTitle: null });
    assert.ok(html.includes('<meta name="robots" content="noindex, follow">'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});
check('sitemap: /blog and each post only while the blog is on', () => {
    const xml = renderSitemap(on, ORIGIN, [{ slug: 'circles-in-schools', lastmod: '2026-10-21T09:00:00Z' }]);
    assert.ok(xml.includes(`<loc>${ORIGIN}/blog</loc>`));
    assert.ok(xml.includes(`<loc>${ORIGIN}/blog/circles-in-schools</loc><lastmod>2026-10-21</lastmod>`));
    assert.ok(!renderSitemap(site().definition, ORIGIN, [{ slug: 'x', lastmod: null }]).includes('/blog'));
});

console.log('\nWiring (source)');

check('site-serve answers /blog routes, redirects /blogs, passes the latest posts and sitemap entries', () => {
    const src = read('netlify/functions/site-serve.ts');
    assert.ok(src.includes('siteBlogRoute(path)'));
    assert.ok(src.includes("path === '/blogs'"));
    assert.ok(src.includes('blog: await loadSiteBlogLatest('));
    assert.ok(src.includes('siteBlogSlugs(db, site.organisationId, origin, origins)'));
});
check('the preview draws the blog pages and the section', () => {
    const src = read('netlify/functions/site-preview.ts');
    assert.ok(src.includes('renderSiteBlogIndex(') && src.includes('renderSiteBlogPost(') && src.includes('loadSiteBlogLatest('));
});
check('GUI and chat both offer it (assistant-gui-chat-parity)', () => {
    const editor = read('src/components/assistant-site-editor.js');
    assert.ok(editor.includes("blog_posts: 'Latest blog posts'"));
    assert.ok(editor.includes('data-site-blog-save'));
    assert.ok(editor.includes("settings: { blog: {"));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('"blog":{"enabled":true|false'));
    assert.ok(chat.includes('blog_posts {heading, intro, count'));
    assert.ok(read('src/utils/site-store.ts').includes('siteBlogForPrompt(db, orgId, d)'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("blog_posts: 'latest blog posts'"));
});
check('site-render only imports types from site-blog (keeps the renderer free of DB code)', () => {
    assert.ok(/import type \{[^}]+\} from '\.\/site-blog'/.test(read('src/utils/site-render.ts')));
});

console.log(`\n${passed}/${total} passed`);
