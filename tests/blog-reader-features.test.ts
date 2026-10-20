// tests/blog-reader-features.test.ts
// Four owner asks for published blogs (2026-10-20), each a quiet regression if undone:
//   1. Blog Studio asks for a feature image before Publish / Approve / Schedule — a nudge, not a gate
//   2. a post with no feature image shows a placeholder plate (customer blog + The Swan Index)
//   3. readers can filter by category and by month (customer blog + The Swan Index)
//   4. readers can share a post (customer blog + The Swan Index)
//
// Run:  npx tsx tests/blog-reader-features.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlogFilter, parseMonth, parseTag, filterQuery, monthLabel, isFiltered } from '../src/utils/blog-filters';
import { shareBarHtml, shareLinks, plateInitial } from '../src/utils/blog-share';
import { renderBlogPage, renderBlogIndexPage, type BlogIndexPageData } from '../src/utils/blog-seo';
import { renderArticle, renderList } from '../src/utils/swan-index/render';
import { buildBlogReaders, renderReadersForChat } from '../src/utils/blog-readers';
import { parseSwanRead } from '../src/utils/swan-index/reads';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

console.log('\nFilters');

check('a month is YYYY-MM with a real month, anything else is no filter', () => {
    assert.strictEqual(parseMonth('2026-10'), '2026-10');
    for (const bad of ['2026-13', '2026-1', '26-10', "2026-10' OR 1=1", '', undefined, 42]) assert.strictEqual(parseMonth(bad), null, String(bad));
});

check('a tag is trimmed, one line, bounded', () => {
    assert.strictEqual(parseTag('  Marketing   tips '), 'Marketing tips');
    assert.strictEqual(parseTag(''), null);
    assert.strictEqual(parseTag('x'.repeat(81)), null);
});

check('the query string round-trips, and "no filter" is an empty string', () => {
    const f = parseBlogFilter({ tag: 'SEO & ads', month: '2026-09' });
    assert.ok(isFiltered(f));
    assert.strictEqual(filterQuery(f, { cursor: '12' }), '?tag=SEO+%26+ads&month=2026-09&cursor=12');
    assert.strictEqual(filterQuery(parseBlogFilter({})), '');
    assert.strictEqual(monthLabel('2026-10'), 'October 2026');
});

check('the shared list query applies both filters, bound not interpolated', () => {
    const q = read('src/utils/blog-list-query.ts');
    assert.match(q, /\$\{blogPosts\.tags\} @> \$\{JSON\.stringify\(\[filter\.tag\]\)\}::jsonb/);
    assert.match(q, /to_char\(\$\{listSortKey\}, 'YYYY-MM'\) = \$\{filter\.month\}/);
    assert.match(q, /\.\.\.filterClauses\(filter\)/);
});

check('the widget API serves facets and passes the filter to the list', () => {
    const api = read('netlify/functions/widget-api.ts');
    assert.match(api, /resource === 'facets'/);
    assert.match(api, /const filter = parseBlogFilter\(qs\)/);
});

const indexData = (over: Partial<BlogIndexPageData> = {}): BlogIndexPageData => ({
    siteName: 'Acme', pageUrl: 'https://x.test/b/k', canonicalUrl: 'https://x.test/b/k', robots: 'index,follow',
    posts: [{ title: 'Sourdough', slug: 's', excerpt: '', publishedAt: null, imageUrl: null, imageAlt: null }],
    postHref: (s) => `/b/k/${s}`, olderHref: null, firstHref: null,
    facets: { categories: [{ value: 'Baking', label: 'Baking', count: 3 }, { value: 'News', label: 'News', count: 1 }], months: [{ value: '2026-10', label: 'October 2026', count: 4 }] },
    filter: { tag: 'Baking', month: null },
    indexPath: '/b/k',
    ...over,
});

check('the hosted index has a GET filter form with the reader\'s choice selected, and a way out', () => {
    const html = renderBlogIndexPage(indexData());
    assert.match(html, /<form class="filters" method="get" action="\/b\/k"/);
    assert.match(html, /<option value="Baking" selected>Baking \(3\)<\/option>/);
    assert.match(html, /<option value="2026-10">October 2026 \(4\)<\/option>/);
    assert.match(html, /Clear filters/);
});

check('no filter bar when there is nothing to choose between', () => {
    const html = renderBlogIndexPage(indexData({ facets: { categories: [{ value: 'A', label: 'A', count: 1 }], months: [{ value: '2026-10', label: '', count: 1 }] }, filter: null }));
    assert.ok(!html.includes('class="filters"'));
});

check('a filtered hosted index is noindex and canonical to the full list; the pager keeps the filter', () => {
    const fn = read('netlify/functions/blog-page.ts');
    assert.match(fn, /canonicalUrl: isFiltered\(filter\) \? firstUrl : pageUrl/);
    assert.match(fn, /olderHref: nextCursor \? `\$\{indexPath\}\$\{filterQuery\(filter, \{ cursor: nextCursor \}\)\}`/);
});

check('the widget shows category and month menus and sends them with every page', () => {
    const w = read('widget.js');
    assert.match(w, /API \+ '\/facets'/);
    assert.match(w, /'&tag=' \+ encodeURIComponent\(filter\.tag\)/);
    assert.match(w, /'&month=' \+ encodeURIComponent\(filter\.month\)/);
    assert.match(w, /No posts match these filters\./);
});

const sections = [{ key: 'growth', label: 'Growth', standfirst: null }, { key: 'money', label: 'Money', standfirst: null }] as any;

check('The Swan Index lists carry a section + month filter form', () => {
    const html = renderList({
        sections, base: '', heading: 'Growth', currentSection: 'growth', items: [],
        pageUrl: 'https://t.test/section/growth?month=2026-10', canonicalUrl: 'https://t.test/section/growth',
        baseUrl: 'https://t.test', robots: 'noindex,follow',
        filters: { months: [{ value: '2026-10', count: 2 }], section: 'growth', month: '2026-10' },
    });
    assert.match(html, /action="\/latest"/);
    assert.match(html, /<option value="growth" selected>Growth<\/option>/);
    assert.match(html, /<option value="2026-10" selected>October 2026 \(2\)<\/option>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/t\.test\/section\/growth">/);
    assert.match(html, /Nothing matches these filters\./);
});

check('the Swan Index page reads ?month= and ?section= and keeps filtered views out of the index', () => {
    const fn = read('netlify/functions/swan-index-page.ts');
    assert.match(fn, /const month = parseMonth\(qs\.month\)/);
    assert.match(fn, /getLatest\(db, 60, key, month\)/);
    assert.match(fn, /robotsFor\(origin, filtered \? 'noindex,follow' : 'index,follow'\)/);
});

console.log('\nShare');

check('share links go to each network with the URL encoded, and only for http(s) URLs', () => {
    const links = shareLinks('https://a.test/p?x=1', 'Hi & bye');
    assert.deepStrictEqual(links.map((l) => l.key), ['linkedin', 'facebook', 'x', 'email']);
    assert.ok(links[0].href.endsWith('url=https%3A%2F%2Fa.test%2Fp%3Fx%3D1'));
    assert.ok(links[2].href.includes('text=Hi%20%26%20bye'));
    assert.strictEqual(shareBarHtml('javascript:alert(1)', 't'), '');
    assert.match(shareBarHtml('https://a.test/p', 't'), /data-share-copy>Copy link</);
});

const pageBase = {
    title: 'Post', description: 'D', pageUrl: 'https://app.test/b/k/s', canonicalUrl: 'https://acme.test/blog/s',
    robots: 'index,follow', imageUrl: null, imageAlt: null, tags: [], publishedAt: null, modifiedAt: null,
    authorName: null, publisher: { name: 'P', logoUrl: null }, siteName: 'S', bodyHtml: '<p>x</p>',
    aiAssisted: false, badgeEnabled: false,
};

check('the hosted post shares its canonical address, with the copy/native script', () => {
    const html = renderBlogPage(pageBase);
    assert.match(html, /data-share-url="https:\/\/acme\.test\/blog\/s"/);
    assert.match(html, /navigator\.share/);
});

const article = {
    sections, base: '',
    author: { handle: 'acme', displayName: 'Jane', roleTitle: null, companyName: null, siteUrl: null },
    title: 'Cutting churn', liveAt: null, bodyHtml: '<p>Body.</p>', imageUrl: null, imageAlt: null,
    authorCanonicalUrl: null, pageUrl: 'https://theswanindex.com/@acme/cutting-churn', robots: 'noindex,follow',
    aiAssisted: false, aiNotice: '', more: [], baseUrl: 'https://theswanindex.com',
};

check('a Swan Index article has a share row for the page being read', () => {
    assert.match(renderArticle(article), /data-share-url="https:\/\/theswanindex\.com\/@acme\/cutting-churn"/);
});

check('the widget post view has a share row', () => {
    const w = read('widget.js');
    assert.match(w, /shareHtml\(shareUrl, h1\)/);
    assert.match(w, /bindShare\(view, shareUrl, h1\)/);
});

console.log('\nPlaceholder');

check('the plate shows the title\'s first letter or digit, never blank', () => {
    assert.strictEqual(plateInitial('  why sourdough?'), 'W');
    assert.strictEqual(plateInitial('2026 plans'), '2');
    assert.strictEqual(plateInitial('🚀🚀'), '✦');
});

check('a hosted post with no feature image gets the plate; with one, the image', () => {
    assert.match(renderBlogPage(pageBase), /class="hero hero--plate bms-plate" aria-hidden="true"><span>P<\/span>/);
    const withImg = renderBlogPage({ ...pageBase, imageUrl: 'https://cdn.test/a.jpg' });
    assert.ok(!withImg.includes('class="hero hero--plate'));
    assert.match(withImg, /<img class="hero" src="https:\/\/cdn\.test\/a\.jpg"/);
});

check('a Swan Index article with no feature image gets the TSI plate', () => {
    assert.match(renderArticle(article), /class="article__hero--empty" data-label="TSI"/);
});

check('the widget uses the plate for an image-less card and post', () => {
    const w = read('widget.js');
    assert.match(w, /: plateHtml\(p\.title, 'bms-thumb'\);/);
    assert.match(w, /: plateHtml\(h1, 'bms-hero'\);/);
});

console.log('\nThe nudge in Blog Studio');

check('Publish, Approve and Schedule each ask about a missing feature image first', () => {
    const s = read('src/components/blog-studio-modal.js');
    for (const id of ['bs-publish', 'bs-approve', 'bs-schedule']) {
        const i = s.indexOf(`el('${id}').addEventListener('click'`);
        assert.notEqual(i, -1, id);
        assert.match(s.slice(i, i + 600), /if \(!\(await confirmFeatureImage\(\)\)\) return;/, id);
    }
});

check('it only asks when the post is KNOWN to have no image, and "continue" carries on', () => {
    const s = read('src/components/blog-studio-modal.js');
    assert.match(s, /if \(state\.hasFeature !== false \|\| typeof window\.choiceModal !== 'function'\) return Promise\.resolve\(true\);/);
    assert.match(s, /return choice === 'skip';/);
    assert.match(s, /state\.hasFeature = null;/, 'reset per post, so one post\'s image never answers for another');
});

console.log('\nThe Swan Index needs a section');

check('every public Swan Index read hides a piece with no section', () => {
    const q = read('src/utils/swan-index/queries.ts');
    assert.match(q, /const HAS_SECTION = isNotNull\(swanIndexPosts\.section\);/);
    assert.match(q, /const VISIBLE = and\([\s\S]{0,200}HAS_SECTION,\s*\);/, 'lists, feed, sitemap, months');
    assert.match(q, /eq\(swanIndexPosts\.status, 'featured'\), eq\(swanIndexProfiles\.status, 'active'\), HAS_SECTION\)/, 'front page');
    const art = q.slice(q.indexOf('export async function getArticle('), q.indexOf('export interface AuthorListRow'));
    assert.match(art, /HAS_SECTION/, 'article page');
    const authors = q.slice(q.indexOf('export async function listAuthors('), q.indexOf('export async function getIndexableUrls('));
    assert.match(authors, /HAS_SECTION/, 'contributor counts');
});

check('the editor desk refuses to put a piece live, or keep it live, without a section', () => {
    const fn = read('netlify/functions/admin-swan-index.ts');
    assert.match(fn, /const nextSection = 'section' in patch \? patch\.section : current\.section;/);
    assert.match(fn, /\(nextStatus === 'live' \|\| nextStatus === 'featured'\) && !nextSection/);
    const admin = read('admin.html');
    assert.match(admin, /\(status === 'live' \|\| status === 'featured'\) && payload\.section === ''/);
});

console.log('\nReaders');

const readerRow = (o: Record<string, unknown> = {}) => ({
    id: 1, title: 'A', publishedAt: '2026-10-01T09:00:00Z', views: 4, dwellMs: 480_000,
    swanStatus: 'live', swanSection: 'growth', swanViews: 10, swanReads: 3, handle: 'acme', swanSlug: 'a', ...o,
}) as any;

check('own blog and The Swan Index are counted separately, never summed', () => {
    const r = buildBlogReaders([readerRow(), readerRow({ id: 2, views: 0, dwellMs: 0, swanStatus: null, swanViews: null, swanReads: null })], 'https://t.test');
    assert.deepStrictEqual(r.totals, { blogReads: 4, swanViews: 10, swanReads: 3, postsOnSwan: 1 });
    assert.strictEqual(r.posts[0].avgReadSeconds, 120);
    assert.strictEqual(r.posts[1].avgReadSeconds, null, 'no reads is "—", not 0s');
    assert.strictEqual(r.posts[1].swan, null);
    assert.strictEqual(r.posts[0].swan!.url, 'https://t.test/@acme/a');
});

check('a Swan piece readers cannot open (pending, or no section) is not linked', () => {
    const r = buildBlogReaders([readerRow({ swanStatus: 'pending' }), readerRow({ id: 2, swanSection: null })], 'https://t.test');
    assert.strictEqual(r.posts[0].swan!.url, null);
    assert.strictEqual(r.posts[1].swan!.url, null);
});

check('the chat gets the same figures, with the do-not-sum rule spelled out', () => {
    const text = renderReadersForChat(buildBlogReaders([readerRow()], 'https://t.test'));
    assert.match(text, /On the user's own blog: 4 measured reads\./);
    assert.match(text, /On The Swan Index: 10 views, 3 of them engaged/);
    assert.match(text, /never add the two together/);
    assert.match(read('src/utils/content-snapshot.ts'), /loadBlogReaders\(db, organisationId, aiAssistantId\)/);
});

check('the Blog Writer endpoint returns readers, and the panel is hidden for every other role', () => {
    assert.match(read('netlify/functions/get-blog-performance.ts'), /return json\(\{ \.\.\.buildBlogPerformance\(counts, periodDays\), readers \}\)/);
    const a = read('assistants.js');
    assert.match(a, /_renderBlogReaders\(data\.readers\);/);
    const i = a.indexOf('async function _loadAssistantMetrics(');
    assert.match(a.slice(i, i + 1400), /getElementById\('blog-readers-panel'\)\?\.classList\.add\('hidden'\)/);
    assert.match(read('assistant-detail.html'), /id="blog-readers-panel" class="hidden/);
});

check('Swan Index articles count their readers: beacon in the page, POST /_read in the function', () => {
    assert.match(renderArticle({ ...article, readBeacon: { handle: 'acme', slug: 'cutting-churn' } }), /sendBeacon\(c\.endpoint/);
    assert.ok(!renderArticle(article).includes('sendBeacon'), 'no beacon unless asked');
    const fn = read('netlify/functions/swan-index-page.ts');
    assert.match(fn, /event\.httpMethod === 'POST' && \/\\\/_read\\\/\?\$\/\.test\(pathname\)/);
    assert.match(fn, /readBeacon: \{ handle: profile\.handle, slug: route\.slug \}/);
    assert.deepStrictEqual(parseSwanRead('{"handle":"ACME","slug":"x","engaged":true}'), { handle: 'acme', slug: 'x', engaged: true });
    assert.strictEqual(parseSwanRead('not json'), null);
    assert.strictEqual(parseSwanRead('{"slug":"x"}'), null);
});

console.log(`\n${passed} checks passed.`);
