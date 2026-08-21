// tests/swan-index.test.ts
// The Swan Index — pure units: route parsing, handle allocation rules, the render layer's
// crawler-facing output, and the adapter's registration. No network, no DB.
// Run:  npx tsx tests/swan-index.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { parseSwanRoute } from '../src/utils/swan-index/route';
import { slugifyHandle, HANDLE_RE, RESERVED_HANDLES, monthStart } from '../src/utils/swan-index/profile';
import {
    renderHome, renderArticle, renderAuthor, renderList,
    articlePath, authorPath, bylineText, formatDate, hostOf,
    type SwanCard, type SwanSection,
} from '../src/utils/swan-index/render';
import { guessSection, toDek } from '../src/utils/blog-destinations/swanindex';
import { BLOG_DESTINATION_IDS, getBlogAdapter, isBlogDestinationId } from '../src/utils/blog-destinations';
import { swanIndexBaseUrl, SWAN_INDEX_DEFAULT_ORIGIN } from '../src/utils/swan-index/base-url';
import { resolveOrigin, robotsFor } from '../netlify/functions/swan-index-page';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const sections: SwanSection[] = [
    { key: 'operations', label: 'Operations', standfirst: 'How the work gets done.' },
    { key: 'growth', label: 'Growth', standfirst: null },
];

const card = (over: Partial<SwanCard> = {}): SwanCard => ({
    slug: 'cutting-churn',
    title: 'How we cut churn by a third',
    dek: 'A year of unglamorous work.',
    section: 'growth',
    sectionLabel: 'Growth',
    liveAt: '2026-08-20T09:00:00.000Z',
    imageUrl: null,
    author: { handle: 'acme', displayName: 'Jane Smith', roleTitle: 'Founder', companyName: 'Acme', siteUrl: 'https://www.acme.com' },
    ...over,
});

// ── routing ─────────────────────────────────────────────────────────────────
console.log('\nRoute parsing');

check('root, latest, authors, feed, sitemap, robots', () => {
    assert.deepEqual(parseSwanRoute('/'), { kind: 'home' });
    assert.deepEqual(parseSwanRoute('/latest'), { kind: 'latest' });
    assert.deepEqual(parseSwanRoute('/authors'), { kind: 'authors' });
    assert.deepEqual(parseSwanRoute('/feed.xml'), { kind: 'feed' });
    assert.deepEqual(parseSwanRoute('/sitemap.xml'), { kind: 'sitemap' });
    assert.deepEqual(parseSwanRoute('/robots.txt'), { kind: 'robots' });
});

check('author and article, handles lowercased', () => {
    assert.deepEqual(parseSwanRoute('/@Acme'), { kind: 'author', handle: 'acme' });
    assert.deepEqual(parseSwanRoute('/@acme/cutting-churn'), { kind: 'article', handle: 'acme', slug: 'cutting-churn' });
});

check('slug case is PRESERVED — only the handle is case-insensitive', () => {
    // The handle has a lower() unique index behind it; the slug does not, and lowercasing it here
    // would 404 every post whose stored slug has a capital in it.
    const r = parseSwanRoute('/@acme/Cutting-Churn');
    assert.deepEqual(r, { kind: 'article', handle: 'acme', slug: 'Cutting-Churn' });
});

check('trailing slashes tolerated', () => {
    assert.deepEqual(parseSwanRoute('/latest/'), { kind: 'latest' });
    assert.deepEqual(parseSwanRoute('/@acme/'), { kind: 'author', handle: 'acme' });
});

check('the /index-preview prefix resolves to the same routes', () => {
    assert.deepEqual(parseSwanRoute('/index-preview'), { kind: 'home' });
    assert.deepEqual(parseSwanRoute('/index-preview/'), { kind: 'home' });
    assert.deepEqual(parseSwanRoute('/index-preview/latest'), { kind: 'latest' });
    assert.deepEqual(parseSwanRoute('/index-preview/@acme/x'), { kind: 'article', handle: 'acme', slug: 'x' });
});

check('the prefix is anchored — it is not stripped mid-path', () => {
    // Otherwise "/@acme/index-preview" would silently become a different page.
    assert.deepEqual(parseSwanRoute('/@acme/index-preview'), { kind: 'article', handle: 'acme', slug: 'index-preview' });
    assert.equal(parseSwanRoute('/index-previewer'), null);
});

check('patterns are anchored and depth-limited', () => {
    assert.equal(parseSwanRoute('/foo/@acme/x'), null, 'unanchored match would find an author mid-path');
    assert.equal(parseSwanRoute('/@acme/x/y'), null, 'three segments is not an article');
    assert.equal(parseSwanRoute('/section/a/b'), null);
    assert.equal(parseSwanRoute('/nope'), null);
});

check('malformed percent-encoding is a 404, not a 500', () => {
    assert.equal(parseSwanRoute('/@%E0%A4%A'), null);
    assert.equal(parseSwanRoute('/@acme/%E0%A4%A'), null);
});

// ── handles ─────────────────────────────────────────────────────────────────
console.log('\nHandles');

check('slugify strips accents, punctuation and edge hyphens', () => {
    assert.equal(slugifyHandle('Café Ltd.'), 'cafe-ltd');
    assert.equal(slugifyHandle('  --Acme & Co--  '), 'acme-co');
    assert.equal(slugifyHandle('北京'), '', 'nothing usable survives → empty, so the caller falls back');
});

check('slugify never returns a value the DB CHECK would reject', () => {
    for (const input of ['a', 'ab', '-', '!!!', 'x'.repeat(60), 'Ünïcödé Çø']) {
        const out = slugifyHandle(input);
        assert.ok(out === '' || HANDLE_RE.test(out), `"${input}" → "${out}" must be empty or valid`);
    }
});

check('reserved handles cover every top-level route the site serves', () => {
    // A profile holding one of these would shadow a real page — /latest is the live example.
    for (const r of ['latest', 'authors', 'section', 'feed', 'sitemap', 'about']) {
        assert.ok(RESERVED_HANDLES.has(r), `"${r}" must be reserved`);
    }
});

check('monthStart is UTC and the first of the month', () => {
    const m = monthStart(new Date('2026-08-21T23:30:00.000Z'));
    assert.equal(m.toISOString(), '2026-08-01T00:00:00.000Z');
});

// ── adapter registration ────────────────────────────────────────────────────
console.log('\nAdapter');

check('swanindex is a registered destination', () => {
    assert.ok(BLOG_DESTINATION_IDS.includes('swanindex'));
    assert.ok(isBlogDestinationId('swanindex'));
});

check('it is first-party: no cred fields, no paste form', () => {
    const a = getBlogAdapter('swanindex');
    assert.equal(a.authKind, 'firstparty');
    assert.deepEqual(a.credFields, []);
    assert.equal(a.supportsDraft, true);
    assert.equal(a.parseCreds({}).ok, false, 'there are no credentials to parse');
});

check('every other adapter still declares a cred path', () => {
    // Guards the union widening: adding 'swanindex' must not have made credFields optional in
    // practice for the platforms that genuinely need them.
    for (const id of BLOG_DESTINATION_IDS) {
        const a = getBlogAdapter(id);
        if (a.authKind === 'firstparty') continue;
        const hasPath = a.credFields.length > 0 || a.authKind === 'oauth';
        assert.ok(hasPath, `${id} must collect creds or use OAuth`);
    }
});

check('section guessing matches on the key, and declines rather than guessing wrong', () => {
    const keys = ['operations', 'growth', 'capital'];
    assert.equal(guessSection(['Growth', 'saas'], keys), 'growth');
    assert.equal(guessSection(['growth-marketing'], keys), 'growth');
    assert.equal(guessSection(['hiring', 'culture'], keys), null, 'no match → an editor decides');
    assert.equal(guessSection([], keys), null);
});

check('dek truncates on a word boundary and keeps short text intact', () => {
    assert.equal(toDek('Short one.'), 'Short one.');
    assert.equal(toDek(null), null);
    assert.equal(toDek('   '), null);
    const long = toDek('word '.repeat(80), 40)!;
    assert.ok(long.length <= 41, `got ${long.length}`);
    assert.ok(long.endsWith('…'));
    assert.ok(!long.includes('  '));
});

check('base URL falls back to the real domain when unset', () => {
    const prev = process.env.SWAN_INDEX_BASE_URL;
    delete process.env.SWAN_INDEX_BASE_URL;
    assert.equal(swanIndexBaseUrl(), SWAN_INDEX_DEFAULT_ORIGIN);
    process.env.SWAN_INDEX_BASE_URL = 'https://staging.example.com/';
    assert.equal(swanIndexBaseUrl(), 'https://staging.example.com', 'trailing slash stripped');
    if (prev === undefined) delete process.env.SWAN_INDEX_BASE_URL; else process.env.SWAN_INDEX_BASE_URL = prev;
});

// ── helpers ─────────────────────────────────────────────────────────────────
console.log('\nRender helpers');

check('paths encode, and carry the base prefix when given one', () => {
    assert.equal(articlePath('acme', 'a b'), '/@acme/a%20b');
    assert.equal(articlePath('acme', 'x', '/index-preview'), '/index-preview/@acme/x');
    assert.equal(authorPath('acme', '/index-preview'), '/index-preview/@acme');
});

check('byline degrades cleanly as fields go missing', () => {
    assert.equal(bylineText({ handle: 'a', displayName: 'Jane', roleTitle: 'Founder', companyName: 'Acme' }), 'Jane, Founder at Acme');
    assert.equal(bylineText({ handle: 'a', displayName: 'Jane', roleTitle: 'Founder' }), 'Jane, Founder');
    assert.equal(bylineText({ handle: 'a', displayName: 'Jane' }), 'Jane');
});

check('dates are long-form en-GB; an unparseable one renders as nothing, not "Invalid Date"', () => {
    assert.equal(formatDate('2026-08-20T09:00:00.000Z'), '20 August 2026');
    assert.equal(formatDate('not a date'), '');
    assert.equal(formatDate(null), '');
});

check('hostOf strips www and survives junk', () => {
    assert.equal(hostOf('https://www.acme.com/blog/x'), 'acme.com');
    assert.equal(hostOf('not a url'), null);
    assert.equal(hostOf(null), null);
});

// ── crawler-facing output ───────────────────────────────────────────────────
console.log('\nRendered pages');

const articleBase = {
    sections, base: '',
    author: { handle: 'acme', displayName: 'Jane Smith', roleTitle: 'Founder', companyName: 'Acme', siteUrl: 'https://acme.com' },
    title: 'How we cut churn by a third',
    dek: 'A year of unglamorous work.',
    sectionKey: 'growth', sectionLabel: 'Growth',
    liveAt: '2026-08-20T09:00:00.000Z',
    bodyHtml: '<p>Body.</p>',
    imageUrl: null, imageAlt: null,
    pageUrl: 'https://theswanindex.com/@acme/cutting-churn',
    robots: 'noindex,follow',
    aiAssisted: true, aiNotice: 'Drafted with AI assistance.',
    more: [], baseUrl: 'https://theswanindex.com',
};

check("an article canonicalises to the AUTHOR'S site, not to us", () => {
    const html = renderArticle({ ...articleBase, authorCanonicalUrl: 'https://acme.com/blog/cutting-churn' });
    assert.ok(html.includes('<link rel="canonical" href="https://acme.com/blog/cutting-churn">'),
        'the whole syndication promise is this one tag');
    assert.ok(html.includes('"@id":"https://acme.com/blog/cutting-churn"'),
        'JSON-LD mainEntityOfPage must agree with rel=canonical');
});

check('and says so in words the reader can see, naming the host', () => {
    const html = renderArticle({ ...articleBase, authorCanonicalUrl: 'https://www.acme.com/blog/x' });
    assert.ok(html.includes('First published on'));
    assert.ok(html.includes('>acme.com<'), 'the credit names the domain, not a bare "their site"');
});

check('with no author URL it self-canonicalises rather than emitting nothing', () => {
    const html = renderArticle({ ...articleBase, authorCanonicalUrl: null });
    assert.ok(html.includes(`<link rel="canonical" href="${articleBase.pageUrl}">`));
    assert.ok(!html.includes('First published on'), 'no claim we cannot support');
});

check('the article honours its stored robots value', () => {
    const off = renderArticle({ ...articleBase, authorCanonicalUrl: null });
    assert.ok(off.includes('<meta name="robots" content="noindex,follow">'));
    const on = renderArticle({ ...articleBase, authorCanonicalUrl: null, robots: 'index,follow' });
    assert.ok(on.includes('<meta name="robots" content="index,follow">'));
});

check('the AI disclosure renders when the source post is machine-drafted', () => {
    assert.ok(renderArticle({ ...articleBase, authorCanonicalUrl: null }).includes('Drafted with AI assistance.'));
    assert.ok(!renderArticle({ ...articleBase, authorCanonicalUrl: null, aiAssisted: false }).includes('Drafted with AI assistance.'));
});

check('the body HTML is inserted as markup; everything else is escaped', () => {
    const html = renderArticle({
        ...articleBase, authorCanonicalUrl: null,
        title: 'Churn & <script>alert(1)</script>',
        bodyHtml: '<p>Real <em>markup</em>.</p>',
    });
    assert.ok(html.includes('<p>Real <em>markup</em>.</p>'), 'sanitised snapshot stays markup');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'the title must not become a script tag');
    assert.ok(html.includes('&lt;script&gt;'));
});

check('every internal link carries the preview prefix when one is set', () => {
    const html = renderHome({ sections, base: '/index-preview', lead: card(), featured: [card({ slug: 'b' })], latest: [card({ slug: 'c' })], baseUrl: 'https://x.test/index-preview', robots: 'noindex,nofollow' });
    assert.ok(html.includes('href="/index-preview/@acme/cutting-churn"'));
    assert.ok(html.includes('href="/index-preview/section/growth"'), 'the nav too');
    assert.ok(html.includes('href="/index-preview/latest"'), 'and the footer');
    assert.ok(!/href="\/@acme/.test(html), 'no bare root link may escape the prefix');
});

check('the front page indexes; it is our own editorial work, not a syndicated copy', () => {
    const html = renderHome({ sections, base: '', lead: card(), featured: [], latest: [], baseUrl: 'https://theswanindex.com', robots: 'index,follow' });
    assert.ok(html.includes('<meta name="robots" content="index,follow">'));
    assert.ok(html.includes('How we cut churn by a third'));
});

check('an empty publication renders a front page rather than a broken one', () => {
    const html = renderHome({ sections, base: '', lead: null, featured: [], latest: [], baseUrl: 'https://theswanindex.com', robots: 'index,follow' });
    assert.ok(html.includes('The first issue is in preparation.'));
    assert.ok(html.includes('<html lang="en">'));
});

check('list and author pages render and stay self-canonical', () => {
    const list = renderList({
        sections, base: '', heading: 'Growth', standfirst: 'Demand and pricing.',
        currentSection: 'growth', items: [card()],
        pageUrl: 'https://theswanindex.com/section/growth', baseUrl: 'https://theswanindex.com', robots: 'index,follow',
    });
    assert.ok(list.includes('<link rel="canonical" href="https://theswanindex.com/section/growth">'));
    assert.ok(list.includes('aria-current="page"'), 'the active section is marked in the nav');

    const author = renderAuthor({
        sections, base: '',
        author: { handle: 'acme', displayName: 'Jane Smith', roleTitle: 'Founder', companyName: 'Acme', siteUrl: 'https://acme.com', bio: 'Runs Acme.' },
        items: [card()], pageUrl: 'https://theswanindex.com/@acme', baseUrl: 'https://theswanindex.com', robots: 'index,follow',
    });
    assert.ok(author.includes('Jane Smith'));
    assert.ok(author.includes('<link rel="canonical" href="https://theswanindex.com/@acme">'));
    assert.ok(author.includes('rel="nofollow"'), "an unvetted author's outbound link is nofollowed");
    // The name is in the masthead above; repeating it on every row is noise. Scope the assertion to
    // the list itself — the head, the <h1> and the JSON-LD all legitimately carry the name.
    const rows = author.slice(author.indexOf('<ul class="index-list">'));
    assert.ok(rows.includes('index-row'), 'marker found and the list is non-empty');
    assert.ok(!rows.includes('Jane Smith'), 'no row repeats the author name');

    // …but a network-wide list must still attribute every piece.
    assert.ok(renderList({
        sections, base: '', heading: 'The Index', items: [card()],
        pageUrl: 'u', baseUrl: 'b', robots: 'index,follow',
    }).includes('Jane Smith'), 'cross-author lists keep the byline');
});

check('the reveal animation cannot hide content when its script does not run', () => {
    // The CSS that hides .reveal is gated on [data-reveal="on"], which only the script sets.
    const html = renderHome({ sections, base: '', lead: card(), featured: [], latest: [], baseUrl: 'https://x.test', robots: 'index,follow' });
    assert.ok(html.includes('[data-reveal="on"] .reveal { opacity: 0'), 'hiding rule is gated');
    assert.ok(!/\n\s*\.reveal \{ opacity: 0/.test(html), 'no ungated rule may hide content');
    assert.ok(html.includes("document.documentElement.setAttribute('data-reveal', 'on')"));
});

check('one <h1> per page', () => {
    const pages = [
        renderArticle({ ...articleBase, authorCanonicalUrl: null }),
        renderAuthor({ sections, base: '', author: { handle: 'a', displayName: 'Jane' }, items: [], pageUrl: 'u', baseUrl: 'b', robots: 'index,follow' }),
        renderList({ sections, base: '', heading: 'The Index', items: [], pageUrl: 'u', baseUrl: 'b', robots: 'index,follow' }),
    ];
    for (const p of pages) {
        assert.equal((p.match(/<h1[\s>]/g) || []).length, 1, 'exactly one <h1>');
    }
});

// ── the indexability gate ───────────────────────────────────────────────────
// This section exists because the bug it describes reached PRODUCTION on 2026-08-21. With the code
// deployed and DNS mid-cutover, the front page answered on both theswanindex.com/ and
// bemoreswan.com/index-preview — each 200, each `index,follow`, each self-canonical. Two indexable
// copies of one page on two domains: the exact duplicate-content failure this publication exists
// to avoid inflicting on its authors, inflicted on itself.
console.log('\nIndexability is gated on the host');

const CANON = 'https://theswanindex.com';

check('the publication is indexable on its own domain, at the root', () => {
    const o = resolveOrigin('/', `${CANON}/`);
    assert.equal(o.indexable, true);
    assert.equal(o.onCanonicalHost, true);
    assert.equal(o.isPreview, false);
    assert.equal(o.base, '');
    assert.equal(o.baseUrl, CANON);
    assert.equal(robotsFor(o, 'index,follow'), 'index,follow');
});

check('⚠️ the preview prefix on the APP domain is never indexable', () => {
    const o = resolveOrigin('/index-preview', 'https://bemoreswan.com/index-preview');
    assert.equal(o.indexable, false, 'this is the exact URL that went live indexable');
    assert.equal(robotsFor(o, 'index,follow'), 'noindex,nofollow');
    assert.equal(o.baseUrl, 'https://bemoreswan.com/index-preview', 'links still work — only indexing is refused');
});

check('nor is it indexable on a deploy-preview host', () => {
    const o = resolveOrigin('/', 'https://deploy-preview-42--bemoreswan.netlify.app/');
    assert.equal(o.indexable, false);
    assert.equal(robotsFor(o, 'index,follow'), 'noindex,nofollow');
});

check('nor on the publication host under the preview prefix', () => {
    // Belt and braces: the function 404s this route, but the gate must refuse it regardless.
    const o = resolveOrigin('/index-preview/latest', `${CANON}/index-preview/latest`);
    assert.equal(o.onCanonicalHost, true);
    assert.equal(o.isPreview, true);
    assert.equal(o.indexable, false, 'a preview is never indexable, even at home');
});

check('www is treated as the same host, not a different one', () => {
    // netlify.toml 301s www to apex so this should never arrive — but a comparison that would
    // silently de-index the whole publication if that rule were removed is not one to leave sharp.
    assert.equal(resolveOrigin('/', 'https://www.theswanindex.com/').indexable, true);
});

check('an unparseable or absent URL fails CLOSED', () => {
    for (const raw of [undefined, '', 'not a url', '://broken']) {
        assert.equal(resolveOrigin('/', raw).indexable, false, `${raw} must not be indexable`);
    }
});

check('the gate downgrades an article\'s own robots too, never upgrades it', () => {
    const off = resolveOrigin('/index-preview/@a/b', 'https://bemoreswan.com/index-preview/@a/b');
    // A featured piece carries index,follow in the database. Off-host it still must not.
    assert.equal(robotsFor(off, 'index,follow'), 'noindex,nofollow');
    const on = resolveOrigin('/@a/b', `${CANON}/@a/b`);
    // …and on-host the gate is a pass-through: it must never make a noindex piece indexable.
    assert.equal(robotsFor(on, 'noindex,follow'), 'noindex,follow');
    assert.equal(robotsFor(on, 'index,follow'), 'index,follow');
});

check('the gate honours SWAN_INDEX_BASE_URL rather than a hardcoded host', () => {
    const prev = process.env.SWAN_INDEX_BASE_URL;
    process.env.SWAN_INDEX_BASE_URL = 'https://staging-index.example.com';
    try {
        assert.equal(resolveOrigin('/', 'https://staging-index.example.com/').indexable, true);
        assert.equal(resolveOrigin('/', `${CANON}/`).indexable, false, 'the old host is no longer canonical');
    } finally {
        if (prev === undefined) delete process.env.SWAN_INDEX_BASE_URL; else process.env.SWAN_INDEX_BASE_URL = prev;
    }
});

check('robots is threaded into renderHome, not hardcoded inside it', () => {
    // It WAS hardcoded, which is why the caller's host check could not reach the front page.
    const off = renderHome({ sections, base: '/index-preview', lead: null, featured: [], latest: [], baseUrl: 'https://x.test/index-preview', robots: 'noindex,nofollow' });
    assert.ok(off.includes('<meta name="robots" content="noindex,nofollow">'));
    const on = renderHome({ sections, base: '', lead: null, featured: [], latest: [], baseUrl: CANON, robots: 'index,follow' });
    assert.ok(on.includes('<meta name="robots" content="index,follow">'));
});

check('⚠️ staging lives AT the preview prefix — the dedupe rule must not 404 it', () => {
    // Staging has no domain of its own: SWAN_INDEX_BASE_URL is
    // https://staging--bemoreswan.netlify.app/index-preview, so the request host DOES match the
    // configured host and the path IS a preview. A dedupe rule keyed on those two facts alone
    // refuses the only way into staging — which is exactly what the first version of it did.
    const prev = process.env.SWAN_INDEX_BASE_URL;
    process.env.SWAN_INDEX_BASE_URL = 'https://staging--bemoreswan.netlify.app/index-preview';
    try {
        const o = resolveOrigin('/index-preview/latest', 'https://staging--bemoreswan.netlify.app/index-preview/latest');
        assert.equal(o.onCanonicalHost, true, 'staging IS its own canonical host');
        assert.equal(o.isPreview, true, 'and the path IS the preview prefix');
        assert.equal(o.indexable, false, 'staging must never be indexable');
        assert.equal(o.base, '/index-preview', 'links keep the prefix');
    } finally {
        if (prev === undefined) delete process.env.SWAN_INDEX_BASE_URL; else process.env.SWAN_INDEX_BASE_URL = prev;
    }
});

check('the noindex header is stamped by the FUNCTION, at one exit point', () => {
    // The first version of this test asserted netlify.toml contained a [[headers]] rule. It did —
    // and the rule was inert, because Netlify header rules do not reach a response produced by a
    // function behind a status-200 rewrite. A source-scan that checks a guard EXISTS rather than
    // that it DOES anything is the false-green trap tests/landmark.ts documents; this one asserts
    // the mechanism that was measured working.
    const fn = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
        'netlify/functions/swan-index-page.ts'), 'utf8');
    assert.match(fn, /'X-Robots-Tag': 'noindex, nofollow'/, 'the function must set the header itself');
    // One exit point, so a page added later cannot forget it.
    assert.match(fn, /return origin\.indexable \? res : noindexHeader\(res\);/,
        'every response must pass through the same gate');
    assert.ok(
        landmark(fn, 'const res = await serve(') < landmark(fn, 'return origin.indexable ? res'),
        'the header is applied after the response is built, not per call site',
    );

    const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'netlify.toml'), 'utf8');
    assert.ok(!/for = "\/index-preview\*"/.test(toml),
        'the inert [[headers]] rule must stay removed — it reads as a guard and is not one');
});

console.log(`\n${passed} checks passed.`);
