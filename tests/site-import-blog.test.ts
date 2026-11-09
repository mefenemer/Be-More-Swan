// tests/site-import-blog.test.ts
// "Import my current site" meets a blog on another platform (site-import-blog.ts, site-import.ts
// runImport, site-import-store.ts acceptImport / importBlogDrafts). Saved pages only — no network:
// tests/fixtures/site-import-blog/ is a small WordPress site (Oakleaf Gardens) with a "Journal".
//
//   1. Finding the blog: a WordPress posts page is an index; a services page of cards is not.
//   2. The list: the feed first, topped up from wp-json and the page's links; capped.
//   3. Each post: title, date, body as Markdown (no share buttons, comments or emoji), picture, old URL.
//   4. runImport: the Journal page isn't copied, the blog is switched on, the posts wait in the report.
//   5. Accepting: drafts (never published), free slugs, no doubles, old addresses → /blog/<slug>.
//   6. GUI and chat: the review card lists the posts; the chat's line says what "use" does.
//
// Run:  npx tsx tests/site-import-blog.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    BLOG_IMPORT_MAX_POSTS, blogSummary, findBlogIndex, htmlToMarkdown, isPostUrl, postSlug, readBlogPost, readFeed, readImportedBlog, readWpPosts,
    type ImportedBlog,
} from '../src/utils/site-import-blog';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { describeImportForChat, freeBlogSlug, importBlogDrafts, importView } from '../src/utils/site-import-store';
import { normaliseSiteDefinition, redirectFor } from '../src/utils/site-definition';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack?.split('\n').slice(0, 3).join('\n    ')}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fx = (f: string) => read(`tests/fixtures/site-import-blog/${f}`);
const SITE = 'https://oakleaf.example';
const current = () => starterSite({ name: 'Oakleaf Gardens', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@account.example' }, themeFromBrandKit(null));

const PAGES: Record<string, string> = {
    [`${SITE}/`]: fx('wp-home.html'),
    [`${SITE}/about/`]: fx('wp-about.html'),
    [`${SITE}/journal/`]: fx('wp-journal.html'),
    [`${SITE}/contact/`]: fx('wp-contact.html'),
    [`${SITE}/feed/`]: fx('wp-feed.xml'),
    [`${SITE}/2026/03/planting-for-clay-soil/`]: fx('wp-post-clay.html'),
    [`${SITE}/2026/02/a-pond-in-a-weekend/`]: fx('wp-post-pond.html'),
    // /2025/11/winter-jobs/ is not saved: it fails to fetch, and the API's copy is used.
};
const JSON_PAGES: Record<string, string> = {
    [`${SITE}/wp-json/wp/v2/posts?per_page=${BLOG_IMPORT_MAX_POSTS}&_fields=link,title,date,date_gmt,content,excerpt`]: fx('wp-posts.json'),
};
function makeDeps(fetched: string[] = []): ImportDeps {
    let asset = 500;
    return {
        async fetchHtml(url) { fetched.push(url); const h = PAGES[url]; return h ? { ok: true, html: h, finalUrl: url } : { ok: false, message: 'Not found (404).' }; },
        async fetchJson(url) { fetched.push(url); const h = JSON_PAGES[url]; return h ? { ok: true, html: h, finalUrl: url } : { ok: false, message: 'Not found (404).' }; },
        async plan() { return null; },
        async savePicture() { return ++asset; },
    };
}

async function main(): Promise<void> {
    console.log('\n1. Finding the blog');

    await check('a WordPress posts page is a blog index: its feed (not the comments feed), its API and its post links', () => {
        const s = findBlogIndex(fx('wp-journal.html'), `${SITE}/journal/`, [`${SITE}/`, `${SITE}/about/`, `${SITE}/contact/`]);
        assert.ok(s);
        assert.strictEqual(s!.kind, 'wordpress');
        assert.strictEqual(s!.feedUrl, `${SITE}/feed/`);
        assert.strictEqual(s!.wpApi, `${SITE}/wp-json/`);
        assert.deepStrictEqual(s!.postLinks, [`${SITE}/2026/03/planting-for-clay-soil/`, `${SITE}/2026/02/a-pond-in-a-weekend/`, `${SITE}/2025/11/winter-jobs/`]);
    });

    await check('ordinary pages are not blogs: home, about, a single post, a services page of cards', () => {
        assert.strictEqual(findBlogIndex(fx('wp-home.html'), `${SITE}/`), null);
        assert.strictEqual(findBlogIndex(fx('wp-about.html'), `${SITE}/about/`), null);
        assert.strictEqual(findBlogIndex(fx('wp-post-clay.html'), `${SITE}/2026/03/planting-for-clay-soil/`), null);
        const services = `<html><body class="page"><main><h1>Services</h1>
            <article><h2><a href="/services/design">Design</a></h2></article><article><h2><a href="/services/build">Build</a></h2></article>
            <article><h2><a href="/services/care">Care</a></h2></article></main></body></html>`;
        assert.strictEqual(findBlogIndex(services, `${SITE}/services`), null);
    });

    await check('a Squarespace blog page with no feed link: its children are posts, and its own feed address is guessed', () => {
        const html = `<html><head><meta name="generator" content="Squarespace"></head><body class="collection-type-blog view-list"><main>
            <article class="blog-item"><h1><a href="/thoughts/first-steps">First steps</a></h1></article>
            <article class="blog-item"><h1><a href="/thoughts/second-steps">Second steps</a></h1></article></main></body></html>`;
        const s = findBlogIndex(html, 'https://willow.example/thoughts');
        assert.ok(s);
        assert.strictEqual(s!.kind, 'squarespace');
        assert.strictEqual(s!.feedUrl, 'https://willow.example/thoughts?format=rss');
        assert.strictEqual(s!.postLinks.length, 2);
    });

    await check('post addresses: dated, /blog/, /post/ (Wix); never tags, categories, pages or other sites', () => {
        const idx = `${SITE}/journal/`;
        for (const u of ['/2026/03/x/', '/blog/my-post', '/post/hello-world', '/news/2024/03/x']) assert.ok(isPostUrl(`${SITE}${u}`, idx), u);
        for (const u of ['/category/advice/', '/tag/clay', '/journal/page/2/', '/feed/', '/journal/', '/blog/my-post?replytocom=3']) assert.ok(!isPostUrl(`${SITE}${u}`, idx), u);
        assert.ok(!isPostUrl('https://elsewhere.example/2026/03/x/', idx));
        assert.ok(isPostUrl(`${SITE}/journal/a-post`, idx), 'beneath a blog-named index');
        assert.ok(!isPostUrl(`${SITE}/services/design`, `${SITE}/services`), 'beneath a services page is a page');
    });

    console.log('\n2. The list');

    await check('RSS: titles decoded, dates, categories, content; Atom too', () => {
        const items = readFeed(fx('wp-feed.xml'), SITE);
        assert.strictEqual(items.length, 2);
        assert.strictEqual(items[0].title, 'Planting for clay soil');
        assert.strictEqual(items[0].date, '2026-03-04T09:00:00.000Z');
        assert.deepStrictEqual(items[0].tags, ['Advice', 'Uncategorized']);
        assert.strictEqual(items[0].contentHtml, '<p>Clay is heavy.</p>');
        assert.strictEqual(items[1].summary, 'You do not need a digger…');
        const atom = readFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Hello &amp; welcome</title><link rel="alternate" href="https://ghosty.example/hello/"/><published>2025-01-02T10:00:00Z</published><content type="html">&lt;p&gt;Hi there&lt;/p&gt;</content><category term="News"/></entry></feed>`, 'https://ghosty.example');
        assert.deepStrictEqual([atom[0].title, atom[0].url, atom[0].contentHtml, atom[0].tags[0]], ['Hello & welcome', 'https://ghosty.example/hello/', '<p>Hi there</p>', 'News']);
    });

    await check('wp-json posts: link, decoded title, GMT date, rendered content', () => {
        const items = readWpPosts(fx('wp-posts.json'), SITE);
        assert.strictEqual(items[1].title, 'Winter jobs & how to do them');
        assert.strictEqual(items[1].date, '2025-11-20T08:00:00.000Z');
        assert.ok(items[1].contentHtml!.includes('Mulch the borders'));
        assert.deepStrictEqual(readWpPosts('not json', SITE), []);
    });

    console.log('\n3. Each post');

    await check('Markdown: headings from ##, lists, quotes, links, figures as picture tokens; no scripts', () => {
        const { markdown, images } = htmlToMarkdown('<h1>Big</h1><p>Hello <em>there</em> <a href="/x">link</a>.</p><ul><li>One</li><li>Two</li></ul><blockquote><p>Quote</p></blockquote><figure><img src="/a.jpg" alt="A"><figcaption>Cap</figcaption></figure><script>alert(1)</script><p>snake_case *star*</p>', SITE);
        assert.strictEqual(markdown, `## Big\n\nHello *there* [link](${SITE}/x).\n\n- One\n- Two\n\n> Quote\n\n![A](bms-import-image:0)\n\n*Cap*\n\nsnake\\_case \\*star\\*`);
        assert.deepStrictEqual(images, [{ src: `${SITE}/a.jpg`, alt: 'A' }]);
    });

    await check('a post page: its own words without share buttons, comments, meta or emoji; date, picture, old address', () => {
        const listed = readFeed(fx('wp-feed.xml'), SITE)[0];
        const p = readBlogPost(fx('wp-post-clay.html'), `${SITE}/2026/03/planting-for-clay-soil/`, listed)!;
        assert.ok(p);
        assert.strictEqual(p.title, 'Planting for clay soil');
        assert.strictEqual(p.date, '2026-03-04T09:00:00.000Z');
        assert.strictEqual(p.fromPath, '/2026/03/planting-for-clay-soil');
        assert.strictEqual(p.slug, 'planting-for-clay-soil');
        assert.ok(p.bodyMarkdown.startsWith('Clay is heavy, but it is **rich**.'), 'the page body beats the feed\'s one-line copy; the h1 is not repeated');
        assert.ok(p.bodyMarkdown.includes('## Plants that thrive\n\n- Hardy geraniums'));
        assert.ok(p.bodyMarkdown.includes(`[pond guide](${SITE}/2026/02/a-pond-in-a-weekend/)`));
        for (const gone of ['Share this', 'Tweet', 'Posted by', 'comments', 'Lovely', 'Previous', '🙂']) assert.ok(!p.bodyMarkdown.includes(gone), gone);
        assert.deepStrictEqual(p.images.map((i) => i.alt), ['A border of geraniums on clay']);
        assert.strictEqual(p.featureImage?.src, `${SITE}/wp-content/uploads/planting-for-clay-soil.jpg`);
        assert.strictEqual(p.excerpt, 'Notes from the Oakleaf team: Planting for clay soil.');
        assert.deepStrictEqual(p.tags, ['Advice'], 'WordPress\'s "Uncategorized" is not a tag');
        assert.strictEqual(p.mentionsPrice, true, 'a price in a post is flagged for the owner to check, not cut');
    });

    await check('slugs from the old address; a bare number or ?p= falls back to the title', () => {
        assert.strictEqual(postSlug(`${SITE}/2026/03/planting-for-clay-soil/`, 'x'), 'planting-for-clay-soil');
        assert.strictEqual(postSlug(`${SITE}/2026/03/`, 'Café & Cake'), 'cafe-and-cake');
        assert.strictEqual(postSlug(`${SITE}/news/story.html`, 'x'), 'story');
    });

    console.log('\n4. runImport');

    await check('the Journal page becomes the blog: not copied, blog on as "Journal", posts in the report, every read through the fetcher', async () => {
        const fetched: string[] = [];
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: current(), maxPages: 10 }, makeDeps(fetched));
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.ok(!r.definition.pages.some((p) => p.slug === 'journal'), 'no Journal page');
        assert.deepStrictEqual(r.definition.settings.blog, { enabled: true, menuLabel: 'Journal' });
        assert.deepStrictEqual(redirectFor(r.definition, '/journal/'), '/blog');
        const blog = r.report.blog!;
        assert.strictEqual(blog.source, 'feed');
        assert.deepStrictEqual(blog.posts.map((p) => p.title), ['Planting for clay soil', 'A pond in a weekend', 'Winter jobs & how to do them']);
        assert.ok(blog.posts[2].bodyMarkdown.includes('## 1. Mulch the borders'), 'a post page that failed uses the API\'s copy');
        assert.ok(blog.posts[0].bodyMarkdown.includes('](asset://'), 'inline picture copied (they chose to copy pictures)');
        assert.ok(blog.posts[0].featureAssetId && blog.pictures.copied >= 2);
        assert.ok(r.report.pages.some((p) => p.title === 'Journal' && /3 posts come across as drafts/.test(p.note ?? '')));
        assert.ok(fetched.includes(`${SITE}/feed/`) && fetched.some((u) => u.includes('/wp-json/wp/v2/posts')));
        assert.ok(!fetched.some((u) => /comments\/feed|category/.test(u)));
    });

    await check('pictures left out (their choice): no picture copied, no picture token or hot-link left in a body', async () => {
        const saved: string[] = [];
        const deps = { ...makeDeps(), async savePicture(src: string) { saved.push(src); return 1; } };
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 10 }, deps);
        assert.ok(r.ok && r.report.blog);
        if (!r.ok) return;
        assert.deepStrictEqual(saved, []);
        for (const p of r.report.blog!.posts) {
            assert.strictEqual(p.featureAssetId, null);
            assert.ok(!/bms-import-image|wp-content\/uploads|!\[/.test(p.bodyMarkdown), p.title);
        }
    });

    await check('a "blog" whose posts can\'t be read is imported as an ordinary page, in its menu place', async () => {
        const deps = { ...makeDeps(), async fetchHtml(url: string) { const h = /\/(20\d\d|feed)\//.test(url) ? undefined : PAGES[url]; return h ? { ok: true as const, html: h, finalUrl: url } : { ok: false as const, message: '404' }; }, fetchJson: undefined };
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 10 }, deps);
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.ok(!r.report.blog);
        assert.deepStrictEqual(r.definition.pages.map((p) => p.slug), ['', 'about', 'journal', 'contact']);
        assert.ok(!r.definition.settings.blog?.enabled);
    });

    await check('at most BLOG_IMPORT_MAX_POSTS posts are read, and "more" says so', async () => {
        const links = Array.from({ length: 45 }, (_, i) => `<article><h2><a href="/blog/post-${i}">Post ${i}</a></h2></article>`).join('');
        const index = `<html><body class="blog"><main>${links}</main></body></html>`;
        const body = `<p>${'Words of the post that make it worth keeping. '.repeat(10)}</p>`;
        const asked: string[] = [];
        const s = findBlogIndex(index, 'https://many.example/blog')!;
        const blog = await readImportedBlog({ ...s, feedUrl: null }, 'Blog', {
            async fetchHtml(url) { asked.push(url); return { ok: true, html: `<html><head><title>T ${url}</title></head><body><article><h1>T</h1>${body}</article></body></html>`, finalUrl: url }; },
        });
        assert.strictEqual(blog.posts.length, BLOG_IMPORT_MAX_POSTS);
        assert.strictEqual(asked.length, BLOG_IMPORT_MAX_POSTS);
        assert.strictEqual(blog.more, true);
        assert.strictEqual(blog.source, 'page');
    });

    console.log('\n5. Accepting');

    await check('old post addresses forward to /blog/<slug> only while the blog is on; ordinary redirects unchanged', () => {
        const base = current();
        const on = normaliseSiteDefinition({ ...base, settings: { ...base.settings, blog: { enabled: true, menuLabel: 'Journal' } }, redirects: [{ from: '/2026/03/planting-for-clay-soil/', to: '/blog/planting-for-clay-soil' }, { from: '/x', to: '/blog/Bad Slug' }] }, { maxPages: 10 }).definition;
        assert.strictEqual(redirectFor(on, '/2026/03/planting-for-clay-soil'), '/blog/planting-for-clay-soil');
        assert.strictEqual(redirectFor(on, '/x'), null);
        const off = normaliseSiteDefinition({ ...base, redirects: [{ from: '/2026/03/planting-for-clay-soil/', to: '/blog/planting-for-clay-soil' }] }, { maxPages: 10 }).definition;
        assert.strictEqual(redirectFor(off, '/2026/03/planting-for-clay-soil'), null);
    });

    await check('free slugs: the post\'s own, else -2, -3…', () => {
        assert.strictEqual(freeBlogSlug('pond', new Set()), 'pond');
        assert.strictEqual(freeBlogSlug('pond', new Set(['pond', 'pond-2'])), 'pond-3');
    });

    await check('importBlogDrafts: drafts owned by the accepting user, on the Blog Assistant, no AI reason; a post already there isn\'t added twice', async () => {
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: current(), maxPages: 10 }, makeDeps());
        assert.ok(r.ok);
        if (!r.ok) return;
        const blog = r.report.blog as ImportedBlog;
        const inserted: Array<Record<string, unknown>> = [];
        // Reads in order: the Blog Assistant, the workspace's posts, its pictures.
        const reads: unknown[][] = [
            [{ id: 77, name: 'Bella' }],
            [{ slug: 'planting-for-clay-soil', canonicalUrl: 'https://elsewhere.example/x', status: 'published' },
             { slug: 'a-pond-in-a-weekend-old', canonicalUrl: `${SITE}/2026/02/a-pond-in-a-weekend/`, status: 'draft' }],
            blog.posts.filter((p) => p.featureAssetId).map((p) => ({ id: p.featureAssetId })),
        ];
        const chain = (): any => {
            const rows = reads.shift() ?? [];
            const c: any = { then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, bad) };
            for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) c[m] = () => c;
            return c;
        };
        const db = { select: () => chain(), insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }) } as never;
        const out = await importBlogDrafts(db, 9, 42, blog);
        assert.strictEqual(out.added, 2);
        assert.strictEqual(out.already, 1, 'the pond post was imported before');
        assert.strictEqual(out.assistant, 'Bella');
        assert.ok(inserted.every((v) => v.status === 'draft' && v.userId === 42 && v.ownerId === 42 && v.assistantId === 77 && v.organisationId === 9 && !('generationReason' in v)));
        assert.strictEqual(inserted[0].slug, 'planting-for-clay-soil-2', 'a published post holds the address');
        assert.strictEqual(inserted[0].canonicalUrl, `${SITE}/2026/03/planting-for-clay-soil/`);
        assert.ok(typeof inserted[0].featureAssetId === 'number');
        assert.deepStrictEqual(out.redirects, [
            { from: '/2026/03/planting-for-clay-soil', to: '/blog/planting-for-clay-soil-2' },
            { from: '/2026/02/a-pond-in-a-weekend', to: '/blog/a-pond-in-a-weekend-old' },
            { from: '/2025/11/winter-jobs', to: '/blog/winter-jobs' },
        ]);
    });

    await check('acceptImport makes the drafts, switches the blog on and adds the redirects; sites.ts passes who pressed it', () => {
        const store = read('src/utils/site-import-store.ts');
        const accept = store.slice(store.indexOf('export async function acceptImport'), store.indexOf('function blogAcceptNote'));
        assert.ok(accept.includes('importBlogDrafts(db, site.organisationId, owner, report.blog)'));
        assert.ok(accept.includes('...(posts?.redirects ?? [])'));
        assert.ok(accept.includes('enabled: true'));
        assert.ok(read('netlify/functions/sites.ts').includes('acceptImport(db, site, maxPages, userId)'));
        assert.ok(read('netlify/functions/site-serve.ts').includes('const movedPost = post ? null : redirectFor(definition, path);'), 'an old /blog/<old-slug> forwards too');
    });

    console.log('\n6. GUI and chat');

    await check('the view and the chat see the posts\' titles, never their bodies; the chat says what "use" does', async () => {
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 10 }, makeDeps());
        assert.ok(r.ok);
        if (!r.ok) return;
        const view = importView({ siteId: 1, organisationId: 9, sourceUrl: `${SITE}/`, pictures: 'skip', status: 'ready', definition: r.definition, report: r.report, message: null, requestedBy: 42, updatedAt: new Date(), createdAt: new Date(), id: 1 } as never)!;
        assert.strictEqual(view.report!.blog!.posts.length, 3);
        assert.ok(!JSON.stringify(view).includes('Mulch the borders'), 'no body in the view');
        assert.deepStrictEqual(blogSummary(null), null);
        const line = describeImportForChat(view, false);
        assert.ok(line.includes('OLD BLOG') && line.includes('"Planting for clay soil"') && line.includes('DRAFTS') && line.includes('site_import_decision'));
    });

    await check('the review card lists the posts and says they become Blog Assistant drafts; the confirm counts them', () => {
        const ed = read('src/components/assistant-site-editor.js');
        const card = ed.slice(ed.indexOf('function importReviewCard'), ed.indexOf('// ── Publish'));
        assert.ok(card.includes('${importBlogList(r.blog)}'));
        const list = ed.slice(ed.indexOf('function importBlogList'), ed.indexOf('function importReviewCard'));
        assert.ok(list.includes('become drafts in your Blog Assistant') && list.includes('mentions a price'));
        assert.ok(ed.includes('from your old blog go${importBlogCount() === 1'));
    });

    await check('a post\'s text can never become HTML or a script link (main session review, 2026-11-09)', () => {
        const { markdown } = htmlToMarkdown('<p>Use &lt;script&gt;alert(1)&lt;/script&gt; and <a href="javascript:alert(1)">bad</a> <a href="/ok">ok</a>.</p>', 'https://b.example/post');
        assert.strictEqual(markdown, 'Use \\<script\\>alert(1)\\</script\\> and bad [ok](https://b.example/ok).');
    });

    console.log(`\n${passed}/${total} passed`);
}

main();
