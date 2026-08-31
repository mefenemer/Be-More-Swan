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
    renderHome, renderArticle, renderAuthor, renderList, renderAbout, renderFeedStylesheet,
    articlePath, authorPath, bylineText, creditParts, socialRow, formatDate, hostOf,
    type SwanCard, type SwanSection,
} from '../src/utils/swan-index/render';
import { normaliseSocial, parseSocials, readSocials, socialEntries, SWAN_SOCIAL_ORDER } from '../src/utils/swan-index/socials';
import {
    SEVERE_CATEGORIES, PUBLICATION_SEVERE_CATEGORIES, PUBLICATION_EXTRA_SEVERE,
} from '../src/config/moderation-severity';
import { guessSection, toDek, SECTION_TAG_ALIASES } from '../src/utils/blog-destinations/swanindex';
import {
    runSafetyScreen, readSafetyReport, summariseSafety, textOf, imagesOf, linksOf, SAFETY_VERSION,
    type Moderator, type ModerationOutcome,
} from '../src/utils/swan-index/safety';
import { BLOG_DESTINATION_IDS, getBlogAdapter, isBlogDestinationId } from '../src/utils/blog-destinations';
import { swanIndexBaseUrl, SWAN_INDEX_DEFAULT_ORIGIN } from '../src/utils/swan-index/base-url';
import { resolveOrigin, robotsFor } from '../netlify/functions/swan-index-page';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
/** The async twin. Must be AWAITED at the call site: an un-awaited async fn passed to check()
 *  prints its tick before the assertions run, and a failure surfaces as an unhandled rejection
 *  after the "N checks passed" line — a green suite over a red test. */
async function acheck(name: string, fn: () => Promise<void>) { await fn(); console.log(`  ✓ ${name}`); passed++; }

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
        // 'social' (LinkedIn) collects nothing here either — the workspace's existing social OAuth
        // connection IS the credential — but it must say WHICH connection, or store.ts cannot find
        // one and the destination would sit permanently "not connected".
        if (a.authKind === 'social') {
            assert.ok(a.socialPlatform, `${id} must name the social platform holding its token`);
            continue;
        }
        const hasPath = a.credFields.length > 0 || a.authKind === 'oauth';
        assert.ok(hasPath, `${id} must collect creds or use OAuth`);
    }
});

const SECTION_KEYS = ['operations', 'growth', 'money', 'people', 'technology', 'culture', 'lifestyle'];

check('section guessing matches on the key, and declines rather than guessing wrong', () => {
    assert.equal(guessSection(['Growth', 'saas'], SECTION_KEYS), 'growth');
    assert.equal(guessSection(['growth-marketing'], SECTION_KEYS), 'growth');
    assert.equal(guessSection(['quarterly-review', 'thoughts'], SECTION_KEYS), null, 'no match → an editor decides');
    assert.equal(guessSection([], SECTION_KEYS), null);
});

check('the tags an AI actually writes now reach a section', () => {
    // The reason this exists: key-substring matching alone fired almost never, because "hiring"
    // does not contain "people" and "cashflow" does not contain "money". Nearly everything arrived
    // unsectioned and an editor placed it by hand.
    assert.equal(guessSection(['hiring'], SECTION_KEYS), 'people');
    assert.equal(guessSection(['cashflow'], SECTION_KEYS), 'money');
    assert.equal(guessSection(['automation'], SECTION_KEYS), 'technology');
    assert.equal(guessSection(['burnout'], SECTION_KEYS), 'lifestyle');
    // The retired keys are aliases of their successors, so old tags still land.
    assert.equal(guessSection(['capital'], SECTION_KEYS), 'money');
    assert.equal(guessSection(['systems'], SECTION_KEYS), 'technology');
    // Whole words only — an alias must never match as a substring.
    assert.equal(guessSection(['aisle'], SECTION_KEYS), null, '"ai" must not match inside another word');
});

check('no alias is claimed by two sections', () => {
    // A duplicate would make the result depend on section ORDER, which is a display decision — the
    // masthead reordering its nav must not silently re-file the next submission.
    const seen = new Map<string, string>();
    for (const [section, aliases] of Object.entries(SECTION_TAG_ALIASES)) {
        for (const alias of aliases) {
            assert.ok(!seen.has(alias), `"${alias}" is claimed by both ${seen.get(alias)} and ${section}`);
            seen.set(alias, section);
        }
    }
});

check('a re-publish never demotes a piece that is already published', () => {
    // The bug: the destination's mode defaults to 'draft' (the editorial queue), so an author
    // adding an image to a LIVE article and re-publishing sent it back to 'pending' — off the
    // public site — and cleared liveAt, re-dating the piece. Only 'featured' was protected.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
        'src/utils/blog-destinations/swanindex.ts'), 'utf8');
    const decide = src.slice(
        landmark(src, 'const nextStatus ='),
        landmark(src, 'const shared = {'),
    );
    assert.ok(decide.length > 0, 'the status decision must still be findable');
    assert.match(decide, /existing\?\.status === 'featured' \|\| existing\?\.status === 'live'/,
        'live must be carried through untouched, exactly as featured is');
    // And the liveAt reset must not reach either of them.
    assert.match(src, /nextStatus === 'live' \|\| nextStatus === 'featured' \? \{\} : \{ liveAt: null \}/);
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

check('a company that just repeats the name is dropped, not printed twice', () => {
    // The bug this exists for: ensureProfile() seeded BOTH from organisations.name, so an unedited
    // profile published as "Be More Swan, Be More Swan" — and "Be More Swan at Be More Swan" in the
    // admin contributor list, which is where someone finally saw it.
    assert.equal(bylineText({ handle: 'a', displayName: 'Be More Swan', companyName: 'Be More Swan' }), 'Be More Swan');
    assert.equal(bylineText({ handle: 'a', displayName: 'Be More Swan', companyName: ' be more swan ' }), 'Be More Swan');
    // A role still reads, and a genuinely different company is untouched.
    assert.equal(bylineText({ handle: 'a', displayName: 'Acme', roleTitle: 'Founder', companyName: 'Acme' }), 'Acme, Founder');
    assert.equal(bylineText({ handle: 'a', displayName: 'Jane', companyName: 'Acme' }), 'Jane, Acme');
    assert.deepEqual(creditParts({ handle: 'a', displayName: 'Acme', roleTitle: 'Founder', companyName: 'Acme' }), ['Founder']);
});

check('the admin contributor line agrees with the public byline', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'admin.html'), 'utf8');
    // Two renderers, one rule. The admin list is where the duplication was reported from, so a
    // future edit that inlines the concatenation again has to fail here.
    assert.match(src, /function _swanCredit\(c\)/, 'admin.html must keep the shared credit helper');
    assert.ok(!/\$\{c\.companyName \? ` at /.test(src), 'the raw " at company" concatenation must stay gone');
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

// ── contributor social links ────────────────────────────────────────────────
console.log('\nSocial links');

check('a bare username becomes that platform\u2019s canonical profile URL', () => {
    assert.deepEqual(normaliseSocial('x', '@janesmith'), { ok: true, url: 'https://x.com/janesmith' });
    assert.deepEqual(normaliseSocial('linkedin', 'janesmith'), { ok: true, url: 'https://www.linkedin.com/in/janesmith' });
    assert.deepEqual(normaliseSocial('youtube', 'acme'), { ok: true, url: 'https://www.youtube.com/@acme' });
});

check('a pasted URL is accepted, cleaned, and forced to https', () => {
    assert.deepEqual(normaliseSocial('linkedin', 'uk.linkedin.com/in/jane?trk=share'),
        { ok: true, url: 'https://uk.linkedin.com/in/jane' });
    assert.deepEqual(normaliseSocial('x', 'http://twitter.com/jane/'), { ok: true, url: 'https://twitter.com/jane' });
    assert.deepEqual(normaliseSocial('instagram', ''), { ok: true, url: '' });
});

check('a link that is not the platform it claims is refused', () => {
    // The masthead is indexable and carries other people's names. An unchecked URL field here is a
    // link farm, which is the exact thing the publication's noindex default exists to avoid.
    const wrongHost = normaliseSocial('linkedin', 'https://spam.example.com/jane');
    assert.equal(wrongHost.ok, false);
    assert.equal(normaliseSocial('x', 'javascript:alert(1)').ok, false);
    assert.equal(normaliseSocial('facebook', 'https://linkedin.com/in/jane').ok, false);
    // Look-alike domains must not pass the suffix check.
    assert.equal(normaliseSocial('x', 'https://x.com.evil.test/jane').ok, false);
});

check('every bad field is reported, and stored blobs are re-validated on read', () => {
    const bad = parseSocials({ linkedin: 'https://evil.test/a', x: 'https://evil.test/b' });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.errors.length, 2, 'one save should surface both problems');

    const good = parseSocials({ linkedin: 'jane', instagram: '', unknown: 'https://evil.test' });
    assert.deepEqual(good.ok && good.socials, { linkedin: 'https://www.linkedin.com/in/jane' });
    // A row written before the host check existed must not render.
    assert.deepEqual(readSocials({ x: 'https://evil.test/x', linkedin: 'https://www.linkedin.com/in/jane' }),
        { linkedin: 'https://www.linkedin.com/in/jane' });
    assert.deepEqual(readSocials(null), {});
});

check('icons render as nofollow me links with an accessible name, and nothing at all when empty', () => {
    const html = socialRow({ handle: 'a', displayName: 'Jane Smith', socials: { linkedin: 'https://www.linkedin.com/in/jane' } });
    assert.match(html, /rel="nofollow me noopener"/, 'contributor links must not pass authority');
    assert.match(html, /Jane Smith on LinkedIn/, 'a screen reader needs more than "link"');
    assert.match(html, /<svg viewBox="0 0 24 24"[^>]*aria-hidden="true"/);
    assert.equal(socialRow({ handle: 'a', displayName: 'Jane' }), '', 'no links, no empty row');
    assert.equal(socialEntries({}).length, 0);
});

check('display order is the publication\u2019s, and every platform has a spec', () => {
    assert.equal(SWAN_SOCIAL_ORDER[0], 'linkedin', 'business readers follow authors on LinkedIn first');
    const all = parseSocials(Object.fromEntries(SWAN_SOCIAL_ORDER.map((p) => [p, 'jane'])));
    assert.ok(all.ok && Object.keys(all.socials).length === SWAN_SOCIAL_ORDER.length,
        'a platform added to SWAN_SOCIAL_ORDER without a spec must not silently vanish');
});

check('the author page publishes the links as schema.org sameAs', () => {
    const html = renderAuthor({
        sections, base: '',
        author: {
            handle: 'acme', displayName: 'Jane Smith', roleTitle: 'Founder', companyName: 'Acme',
            siteUrl: 'https://acme.com', bio: 'Writes about churn.',
            socials: { linkedin: 'https://www.linkedin.com/in/jane', x: 'https://x.com/jane' },
        },
        items: [card()],
        pageUrl: 'https://theswanindex.com/@acme',
        baseUrl: 'https://theswanindex.com',
        robots: 'index,follow',
    });
    // sameAs is what ties the profile to the author's own accounts — the entity credit accrues to
    // them, which is the promise the network is sold on.
    assert.match(html, /"sameAs":\["https:\/\/www\.linkedin\.com\/in\/jane","https:\/\/x\.com\/jane"\]/);
    assert.match(html, /class="socials socials--author"/);
});

check('a profile created on connect no longer copies the org name into the company field', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
        'src/utils/swan-index/profile.ts'), 'utf8');
    const insert = src.slice(
        landmark(src, 'await db.insert(swanIndexProfiles).values({'),
        landmark(src, 'const created = await getProfileByOrg(db, organisationId);'),
    );
    assert.ok(insert.length > 0, 'the ensureProfile insert must still be findable');
    assert.ok(!/companyName:/.test(insert),
        'seeding companyName from the org name is what produced "Acme, Acme" on every unedited profile');
});

// ── routes, about and the feed ──────────────────────────────────────────────
console.log('\nAbout, feed and SEO');

check('the new top-level routes parse, prefix and all', () => {
    assert.deepEqual(parseSwanRoute('/about'), { kind: 'about' });
    assert.deepEqual(parseSwanRoute('/about/'), { kind: 'about' });
    assert.deepEqual(parseSwanRoute('/index-preview/about'), { kind: 'about' });
    assert.deepEqual(parseSwanRoute('/feed.xsl'), { kind: 'feedStyle' });
    assert.deepEqual(parseSwanRoute('/index-preview/feed.xsl'), { kind: 'feedStyle' });
    // Still anchored — the new patterns must not match inside a path.
    assert.equal(parseSwanRoute('/x/about'), null);
});

check('the about page states the two promises the code actually keeps', () => {
    const html = renderAbout({
        sections, base: '', pageUrl: 'https://theswanindex.com/about',
        baseUrl: 'https://theswanindex.com', robots: 'index,follow',
    });
    assert.match(html, /<h1 class="serif section__title">The Swan Index<\/h1>/);
    // The canonical credit and the human review are what a contributor decides on. If either stops
    // being true in the code, this page is a false claim, so it is asserted rather than trusted.
    assert.match(html, /rel="canonical"/);
    assert.match(html, /editors.{0,4} queue/i);
    assert.match(html, /"@type":"AboutPage"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/theswanindex\.com\/about">/);
    assert.equal((html.match(/<h1/g) || []).length, 1, 'one h1 per page');
});

check('the feed stylesheet is a stylesheet, not a page', () => {
    const xsl = renderFeedStylesheet('');
    assert.match(xsl, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xsl, /<xsl:stylesheet version="1\.0"/);
    assert.match(xsl, /xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\/"/, 'dc:creator is read from the feed');
    // It must never invite indexing: it is the same content as /latest, at a URL nobody should land on.
    assert.match(xsl, /name="robots" content="noindex,follow"/);
    // The staging prefix has to reach the internal links, same as every other surface.
    assert.match(renderFeedStylesheet('/index-preview'), /href="\/index-preview"/);
});

check('the feed itself points at the stylesheet, at one place in the function', () => {
    const fn = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
        'netlify/functions/swan-index-page.ts'), 'utf8');
    assert.match(fn, /<\?xml-stylesheet type="text\/xsl" href="\$\{base\}\/feed\.xsl"\?>/);
    // text/xsl, not application/xml: a browser ignores a stylesheet served as anything else, and
    // the feed silently falls back to the raw document tree — the bug this fixes.
    assert.match(fn, /'Content-Type': 'text\/xsl; charset=utf-8'/);
});

check('an article carries a publisher, a breadcrumb and its section', () => {
    const html = renderArticle({
        ...articleBase,
        authorCanonicalUrl: 'https://acme.com/blog/cutting-churn',
        title: 'How we cut churn by a third',
        sectionKey: 'growth', sectionLabel: 'Growth',
        tags: ['churn', 'pricing'],
        modifiedAt: '2026-08-21T09:00:00.000Z',
    });
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, /"@id":"https:\/\/theswanindex\.com#publisher"/, 'one publisher node, referenced by @id');
    assert.match(html, /"articleSection":"Growth"/);
    assert.match(html, /<meta property="article:section" content="Growth">/);
    assert.match(html, /<meta property="article:tag" content="churn">/);
    assert.match(html, /<meta property="og:locale" content="en_GB">/);
    assert.match(html, /"dateModified":"2026-08-21T09:00:00\.000Z"/);
});

check('a modified time equal to the publish time is not emitted', () => {
    // Claiming an edit that did not happen is a freshness signal we have not earned.
    const html = renderArticle({
        ...articleBase, authorCanonicalUrl: null, modifiedAt: articleBase.liveAt,
    });
    assert.ok(!/article:modified_time/.test(html));
    assert.ok(!/"dateModified"/.test(html));
});

check('the credit line reads co-written, not autonomous', () => {
    const html = renderArticle({ ...articleBase, authorCanonicalUrl: null });
    assert.match(html, /Co-written and published with/);
    assert.ok(!/autonomously/.test(html), 'every piece here is submitted and reviewed by a person');
    // The Art. 50 disclosure is a SEPARATE line and must survive the copy change.
    assert.match(html, /Drafted with AI assistance/, 'the Art. 50 notice is a separate line and survives');
});

// ── the editorial safety screen ─────────────────────────────────────────────
console.log('\nSafe Content Benchmark');

const safeInput = {
    title: 'How we cut churn by a third',
    dek: 'A year of unglamorous work.',
    bodyHtml: '<p>We stopped guessing. <a href="https://acme.com/pricing">Our pricing page</a> explains it.</p>'
        + '<img src="https://media.example.com/a.png" alt="The churn dashboard">',
    featureImageUrl: null,
    featureImageAlt: null,
    authorCanonicalUrl: 'https://acme.com/blog/churn',
    publicationOrigin: 'https://theswanindex.com',
    aiAssisted: true,
    profileStatus: 'active',
    monthlyPostCap: 8,
    monthlyPostCount: 2,
};

check('the editorial bar is never lower than the product gate', () => {
    // The drift this replaced: `violence` was severe to the product gate and merely amber on the
    // masthead, so one sentence blocked a customer's prompt and showed an editor "worth a look".
    // A publication is the STRICTER surface — refusing to draft something costs one person an
    // afternoon; running it puts it beside other people's bylines on a domain we own.
    for (const category of SEVERE_CATEGORIES) {
        assert.ok(PUBLICATION_SEVERE_CATEGORIES.includes(category),
            `"${category}" blocks a prompt but would not fail an editorial review`);
    }
    assert.ok(PUBLICATION_SEVERE_CATEGORIES.includes('violence'), 'the category this alignment was for');
    // The extras are additions, never substitutions.
    for (const extra of PUBLICATION_EXTRA_SEVERE) {
        assert.ok(!SEVERE_CATEGORIES.includes(extra), `"${extra}" is listed twice`);
    }
    assert.equal(PUBLICATION_SEVERE_CATEGORIES.length, SEVERE_CATEGORIES.length + PUBLICATION_EXTRA_SEVERE.length);
    // One list, not two. A second hand-written copy is what produced the drift.
    const mod = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/utils/moderation.ts'), 'utf8');
    assert.match(mod, /import \{ SEVERE_CATEGORIES \} from '\.\.\/config\/moderation-severity'/);
    assert.ok(!/const SEVERE_CATEGORIES = \[/.test(mod), 'the product gate must not keep its own copy');
});

check('a stored report from before the alignment is re-screened, not trusted', () => {
    // A version-1 report could say "confirmed" about a piece that now fails on `violence`.
    assert.equal(SAFETY_VERSION, 2);
    const stale = {
        version: 1, ranAt: '2026-08-22T00:00:00.000Z', confirmed: true,
        checks: [{ id: 'text-safety', label: 'Text', status: 'pass', detail: 'ok' }],
    };
    assert.equal(readSafetyReport(stale), null, 'an older check version must read as not screened');
});

check('an unreachable image does not take the text check down with it', () => {
    // Measured against the live API 2026-08-22: text and images used to go in ONE call, and the
    // endpoint fails the WHOLE request with `image_url_unavailable` if it cannot fetch even one
    // picture — so a single expired presigned URL silently reported the TEXT as unchecked too.
    // The text is always checkable; losing it to an unrelated image failure is precisely the
    // false negative this screen exists to prevent.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
        'src/utils/swan-index/safety.ts'), 'utf8');
    assert.match(src, /const textMod = await moderate\(\{/);
    assert.match(src, /const imageMod = imageUrls\.length \? await moderate\(\{ imageUrls \}\) : null;/);
    assert.ok(landmark(src, 'const textMod = await moderate({') < landmark(src, 'const imageMod = imageUrls.length'),
        'two calls, in that order');
});

check('a stored report cannot claim an all-clear its own checks do not support', () => {
    const forged = {
        version: SAFETY_VERSION, ranAt: '2026-08-22T00:00:00.000Z', confirmed: true,
        checks: [
            { id: 'a', label: 'A', status: 'pass', detail: 'ok' },
            { id: 'b', label: 'B', status: 'unchecked', detail: 'no key' },
        ],
    };
    assert.equal(readSafetyReport(forged)!.confirmed, false, 'confirmed is recomputed, never trusted');
    // A report written against an older CHECK LIST is treated as absent — "5/5" against yesterday's
    // five checks is exactly the false green this feature exists to prevent.
    assert.equal(readSafetyReport({ ...forged, version: SAFETY_VERSION - 1 }), null);
    assert.equal(readSafetyReport(null), null);
    assert.equal(summariseSafety(null), 'Not screened yet');
});

check('the body parsers read what is actually in the markup', () => {
    assert.equal(textOf('<p>Hello <em>there</em></p><script>evil()</script>'), 'Hello there');
    assert.deepEqual(imagesOf('<img src="a.png" alt="A"><img src="b.png">'),
        [{ src: 'a.png', alt: 'A' }, { src: 'b.png', alt: null }]);
    assert.deepEqual(linksOf('<a href="https://x.test">x</a><a>none</a>'), ['https://x.test']);
});

check('the admin drawer runs the screen and never reads a verdict about an older draft', () => {
    const fn = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
        'netlify/functions/admin-swan-index.ts'), 'utf8');
    assert.match(fn, /const stale = !row\.safetyCheckedAt \|\| \(row\.updatedAt && row\.safetyCheckedAt < row\.updatedAt\)/,
        'a re-published piece must be re-screened, not shown its old report');
    assert.match(fn, /if \(!safety \|\| stale \|\| qs\.recheck === '1'\)/);
    // The verdict at the moment of the decision is what an audit asks for.
    assert.match(fn, /metadata: \{ title: current\.title, safety: summariseSafety\(readSafetyReport\(current\.safetyCheck\)\) \}/);
});

check('the admin UI cannot show green for a screen that did not run', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'admin.html'), 'utf8');
    // Green is gated on safety.confirmed, which is every check passing — not on a count, and not on
    // "no failures", either of which would let an unchecked item through as an all-clear.
    assert.match(src, /safety\.confirmed\s*\n?\s*\? `<div class="flex items-center gap-2">/);
    assert.match(src, /Not screened<\/span>/, 'an unscreened piece must say so in the queue');
});

// The screen's own checks are async (they call, or decline to call, a moderation API). Wrapped in
// a function because tsx compiles this suite to CJS, where top-level await is a build error — and
// awaited inside it, because an un-awaited assertion failure lands after the summary line as an
// unhandled rejection, which reads as a passing suite.
async function main() {
    await acheck('a check that could not run reports unchecked, and unchecked is never confirmed', async () => {
        // THE rule this module exists for. With no API key the moderation calls cannot run, and an
        // editor told "all clear" by a screen that never ran stops looking — which is worse than being
        // told nothing. Asserted with the key explicitly removed so the suite does not depend on env.
        const key = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            const report = await runSafetyScreen(safeInput);
            const text = report.checks.find((c) => c.id === 'text-safety')!;
            const image = report.checks.find((c) => c.id === 'image-safety')!;
            assert.equal(text.status, 'unchecked');
            assert.equal(image.status, 'unchecked');
            assert.equal(report.confirmed, false, 'an unrun check must never read as confirmed');
            assert.match(summariseSafety(report), /^\d+\/\d+ confirmed/);
            // The deterministic half still ran and still reports.
            assert.equal(report.checks.find((c) => c.id === 'author-credit')!.status, 'pass');
            assert.equal(report.checks.find((c) => c.id === 'image-alt-text')!.status, 'pass');
            assert.equal(report.checks.find((c) => c.id === 'link-integrity')!.status, 'pass');
        } finally {
            if (key !== undefined) process.env.OPENAI_API_KEY = key;
        }
    });

    await acheck('the promise the network is built on is a hard fail when it is missing', async () => {
        const key = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            const none = await runSafetyScreen({ ...safeInput, authorCanonicalUrl: null });
            assert.equal(none.checks.find((c) => c.id === 'author-credit')!.status, 'fail');
            // A canonical pointing back at US is the worse version of the same bug: it looks set.
            const self = await runSafetyScreen({ ...safeInput, authorCanonicalUrl: 'https://theswanindex.com/@acme/churn' });
            assert.equal(self.checks.find((c) => c.id === 'author-credit')!.status, 'fail');
        } finally {
            if (key !== undefined) process.env.OPENAI_API_KEY = key;
        }
    });

    await acheck('script URLs and unlabelled images are caught without any API', async () => {
        const key = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            const report = await runSafetyScreen({
                ...safeInput,
                bodyHtml: '<p><a href="javascript:alert(1)">click</a></p><img src="https://m.example.com/a.png">',
            });
            assert.equal(report.checks.find((c) => c.id === 'link-integrity')!.status, 'fail');
            assert.equal(report.checks.find((c) => c.id === 'image-alt-text')!.status, 'warn');
            assert.equal(report.confirmed, false);
        } finally {
            if (key !== undefined) process.env.OPENAI_API_KEY = key;
        }
    });

    await acheck('an image the API cannot fetch degrades ONLY the image check', async () => {
        // The injected moderator reproduces the real failure exactly: text succeeds, the image call
        // 400s with image_url_unavailable. Injected because the real one calls OpenAI, which makes
        // this path unreachable in a test — and it is the path that was silently wrong.
        const moderate: Moderator = async (i): Promise<ModerationOutcome> => (
            i.imageUrls?.length
                ? { ran: false, flagged: [], severe: [], error: 'Moderation API returned 400 (image_url_unavailable).' }
                : { ran: true, flagged: [], severe: [] }
        );
        const report = await runSafetyScreen({
            ...safeInput,
            bodyHtml: '<p>Clean prose.</p><img src="https://media.example.com/gone.png" alt="A chart">',
        }, moderate);
        const text = report.checks.find((c) => c.id === 'text-safety')!;
        const image = report.checks.find((c) => c.id === 'image-safety')!;
        assert.equal(text.status, 'pass', 'the text was checkable and must report its real verdict');
        assert.equal(image.status, 'unchecked');
        // The editor is told it is a FETCH problem, not a safety verdict — otherwise they go
        // looking for something wrong with the picture.
        assert.match(image.detail, /could not download/i);
        assert.match(image.detail, /re-run the screen/i);
        assert.equal(report.confirmed, false, 'one unchecked item still withholds the all-clear');
    });

    await acheck('a flagged image fails on its own, without touching the text verdict', async () => {
        const moderate: Moderator = async (i): Promise<ModerationOutcome> => (
            i.imageUrls?.length
                ? { ran: true, flagged: ['sexual'], severe: ['sexual'] }
                : { ran: true, flagged: [], severe: [] }
        );
        const report = await runSafetyScreen({
            ...safeInput,
            bodyHtml: '<p>Clean prose.</p><img src="https://media.example.com/a.png" alt="A chart">',
        }, moderate);
        assert.equal(report.checks.find((c) => c.id === 'text-safety')!.status, 'pass');
        assert.equal(report.checks.find((c) => c.id === 'image-safety')!.status, 'fail');
    });

    await acheck('a violent flag now FAILS the editorial screen, as it blocks a prompt', async () => {
        const moderate: Moderator = async (): Promise<ModerationOutcome> => (
            { ran: true, flagged: ['violence'], severe: ['violence'] }
        );
        const report = await runSafetyScreen(safeInput, moderate);
        assert.equal(report.checks.find((c) => c.id === 'text-safety')!.status, 'fail');
        assert.equal(report.confirmed, false);
    });

    await acheck('a suspended contributor fails the screen whatever the writing is like', async () => {
        const key = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            const report = await runSafetyScreen({ ...safeInput, profileStatus: 'suspended' });
            assert.equal(report.checks.find((c) => c.id === 'contributor-standing')!.status, 'fail');
        } finally {
            if (key !== undefined) process.env.OPENAI_API_KEY = key;
        }
    });
}

main().then(() => {
    console.log(`\n${passed} checks passed.`);
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
