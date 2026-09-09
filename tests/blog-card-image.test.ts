// tests/blog-card-image.test.ts
// Which picture represents a post in a list — the ladder, and the surfaces that must agree on it.
//
// The bug this replaces was a confident wrong answer. The Swan Index front page drew its "TSI"
// plate on every card, which read as "these authors do not add pictures". They do; the card query
// simply never selected an image, so a post with a perfectly good feature image showed the same
// placeholder as an empty one. Nothing was broken enough to notice.
//
// Run:  npx tsx tests/blog-card-image.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    pickCardImage, firstBodyImage, cardImageColumns, cardImageRef,
} from '../src/utils/blog-card-image';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── the ladder ──────────────────────────────────────────────────────────────
console.log('\nThe ladder: feature image → first body image → nothing\n');

check('the author\'s feature image wins', () => {
    const ref = pickCardImage({
        featureImage: { assetId: 42, alt: 'A swan' },
        html: '<p>x</p><img data-bms-asset="99">',
    });
    assert.deepEqual(ref, { kind: 'asset', assetId: 42, alt: 'A swan' });
});

check('with no feature image, the first body image is used', () => {
    // This is the tier that actually earns its keep. On the live Swan Index today NOT ONE post has
    // a feature image, and one of the three has two body images — so without this tier the fix
    // would have changed nothing visible at all.
    const ref = pickCardImage({ html: '<p>intro</p><img src="https://images.pexels.com/photos/1.jpeg" alt="Care">' });
    assert.deepEqual(ref, { kind: 'url', url: 'https://images.pexels.com/photos/1.jpeg', alt: 'Care' });
});

check('a post with no usable image gets nothing — and that is an answer', () => {
    // Tier 3 is not a failure. A text-only essay has no photograph, and the surface's own plate
    // says so better than a stretched stock image nobody chose.
    assert.equal(pickCardImage({ html: '<p>Just words.</p>' }), null);
    assert.equal(pickCardImage({}), null);
    assert.equal(pickCardImage(null), null);
    assert.equal(pickCardImage('not an object'), null);
});

check('an uploaded asset in the body beats an external one lower down', () => {
    const ref = pickCardImage({ html: '<img data-bms-asset="7" alt="Ours"><img src="https://x.test/a.jpg">' });
    assert.deepEqual(ref, { kind: 'asset', assetId: 7, alt: 'Ours' });
});

check('⚠️ the FIRST image wins even when a later one is a different kind', () => {
    // The trap this closes: searching for data-bms-asset and for src= separately, then preferring
    // the asset. That picks an illustration from halfway down the article while the photograph at
    // the top goes unused — and it looks entirely reasonable in code review.
    const ref = pickCardImage({ html: '<img src="https://x.test/top.jpg" alt="Top"><img data-bms-asset="7">' });
    assert.deepEqual(ref, { kind: 'url', url: 'https://x.test/top.jpg', alt: 'Top' },
        'the image at the top of the article is the one the piece is about');
});

check('an unusable image does not end the search', () => {
    // A src-less placeholder or an http image is skipped, not treated as "this post has no image".
    const ref = firstBodyImage('<img><img src="http://x.test/insecure.jpg"><img src="https://x.test/ok.jpg">');
    assert.deepEqual(ref, { kind: 'url', url: 'https://x.test/ok.jpg', alt: null });
});

// ── what may become an <img src> ────────────────────────────────────────────
console.log('\nWhat is allowed to become a src attribute\n');

check('⚠️ http is refused — mixed content is worse than no image', () => {
    // Every surface is served over https, so an http image is blocked by the browser and the card
    // shows a broken-image glyph: strictly worse than the placeholder, because it reads as our bug
    // rather than as an article without a picture.
    assert.equal(firstBodyImage('<img src="http://x.test/a.jpg">'), null);
});

check('⚠️ nothing but https gets through', () => {
    // This text becomes an src on a page carrying a third party's byline, so the list of schemes
    // worth the risk is exactly one item long.
    const refused = [
        'javascript:alert(1)',
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        '//x.test/a.jpg',            // protocol-relative
        '/local/path.jpg',
        'ftp://x.test/a.jpg',
        'https://x.test/a b.jpg',    // unescaped whitespace
        '',
    ];
    const survived = refused.filter((bad) => firstBodyImage(`<img src="${bad}">`) !== null);
    // Collected and asserted once, rather than failing on the first: a loop that throws on entry
    // one never checks entries two through seven, and the gap looks like a pass.
    assert.deepEqual(survived, [], `these must be refused: ${JSON.stringify(survived)}`);
});

check('an attribute broken out of the src cannot ride along', () => {
    // A body containing <img src="https://x.test/a.jpg" onerror="alert(1)"> yields the CLEAN url
    // and nothing else — extraction is delimited by the quotes, so it carries the URL forward and
    // leaves the rest of the tag behind. (The tag itself is already sanitised at publish; this is
    // about what this module propagates.) Asserting null here would have been wrong, and would
    // have hidden that the real guarantee is "only the URL survives".
    const ref = firstBodyImage('<img src="https://x.test/a.jpg" onerror="alert(1)">');
    assert.deepEqual(ref, { kind: 'url', url: 'https://x.test/a.jpg', alt: null });
    assert.ok(!JSON.stringify(ref).includes('onerror'), 'nothing but the URL may be carried forward');
});

check('a feature image given as a plain URL is honoured over the body', () => {
    const ref = pickCardImage({
        featureImage: { url: 'https://x.test/chosen.jpg', alt: 'Chosen' },
        html: '<img src="https://x.test/body.jpg">',
    });
    assert.deepEqual(ref, { kind: 'url', url: 'https://x.test/chosen.jpg', alt: 'Chosen' });
});

check('a bad feature image falls through rather than blocking the ladder', () => {
    const ref = pickCardImage({
        featureImage: { url: 'javascript:alert(1)' },
        html: '<img src="https://x.test/body.jpg">',
    });
    assert.deepEqual(ref, { kind: 'url', url: 'https://x.test/body.jpg', alt: null });
});

// ── storing and reading back ────────────────────────────────────────────────
console.log('\nStoring the choice\n');

check('⚠️ all three columns are always written — a removed image must CLEAR', () => {
    // Merging only the non-null fields is the obvious shortcut and it is wrong: an author who
    // deletes the picture and re-publishes would leave the old thumbnail in place, so the magazine
    // would keep showing a photograph the post no longer contains.
    const cleared = cardImageColumns(null);
    assert.deepEqual(cleared, { cardImageAssetId: null, cardImageUrl: null, cardImageAlt: null });
    assert.equal(Object.keys(cleared).length, 3, 'every write must name all three columns');
    for (const ref of [
        { kind: 'asset' as const, assetId: 5, alt: 'a' },
        { kind: 'url' as const, url: 'https://x.test/a.jpg', alt: null },
    ]) {
        assert.equal(Object.keys(cardImageColumns(ref)).length, 3);
    }
});

check('only ever one source — the DB CHECK says the same thing', () => {
    const asAsset = cardImageColumns({ kind: 'asset', assetId: 5, alt: null });
    assert.equal(asAsset.cardImageUrl, null, 'an asset row must not also carry a URL');
    const asUrl = cardImageColumns({ kind: 'url', url: 'https://x.test/a.jpg', alt: null });
    assert.equal(asUrl.cardImageAssetId, null, 'a URL row must not also carry an asset id');
});

check('a stored row reads back as the reference it was written from', () => {
    for (const ref of [
        { kind: 'asset' as const, assetId: 5, alt: 'a' },
        { kind: 'url' as const, url: 'https://x.test/a.jpg', alt: 'b' },
        null,
    ]) {
        assert.deepEqual(cardImageRef(cardImageColumns(ref)), ref, 'round trip must be lossless');
    }
});

check('a stored http URL is refused on the way OUT too', () => {
    // Belt and braces: rows predating the rule, or written by a future caller that forgot it,
    // must not reach an <img src> just because they are already in the database.
    assert.equal(cardImageRef({ cardImageAssetId: null, cardImageUrl: 'http://x.test/a.jpg', cardImageAlt: null }), null);
});

// ── the surfaces agree ──────────────────────────────────────────────────────
console.log('\nOne derivation, shared by every surface\n');

check('the choice is made once, at publish', () => {
    const publish = readFileSync(join(root, 'src/utils/blog-publish.ts'), 'utf8');
    assert.match(publish, /cardImageColumns\(pickCardImage\(publishedPayload\)\)/,
        'blog-publish must derive the thumbnail from the payload it is freezing');
});

check('⚠️ The Swan Index COPIES the choice — it does not re-derive it', () => {
    // Re-deriving would be a second implementation of the ladder, and the two would eventually
    // disagree: the same post showing one picture on the author's blog and another on the magazine
    // that syndicated it, which reads as two different articles.
    const adapter = readFileSync(join(root, 'src/utils/blog-destinations/swanindex.ts'), 'utf8');
    assert.ok(!/pickCardImage/.test(adapter), 'the adapter must not choose an image of its own');
    assert.match(adapter, /cardImageAssetId: source\.cardImageAssetId/, 'it copies the derived value');
    assert.match(adapter, /cardImageUrl: source\.cardImageUrl/);
    assert.match(adapter, /cardImageAlt: source\.cardImageAlt/);
});

check('⚠️ no list surface re-reads published_payload to find an image', () => {
    // The whole reason these are columns. published_payload holds the entire article body; reading
    // it per card means dragging 50 full articles out of the heap to draw one page of a blog.
    const api = readFileSync(join(root, 'netlify/functions/widget-api.ts'), 'utf8');
    const list = api.slice(landmark(api, "if (resource === 'posts' && !slug)"), landmark(api, "if (resource === 'posts' && slug)"));
    assert.ok(!/publishedPayload/.test(list), 'the list query must not select the payload');
    assert.match(list, /cardImageAssetId: blogPosts\.cardImageAssetId/);

    const queries = readFileSync(join(root, 'src/utils/swan-index/queries.ts'), 'utf8');
    const cols = queries.slice(landmark(queries, 'const CARD_COLUMNS'), landmark(queries, 'type CardRow'));
    assert.ok(!/publishedPayload/.test(cols), 'the card projection must not select the payload');
    assert.match(cols, /cardImageAssetId: swanIndexPosts\.cardImageAssetId/);
});

check('⚠️ every Swan Index list producer resolves its own images', () => {
    // Leaving resolution to the callers means a new list surface ships silently pictureless — the
    // exact failure this whole change is fixing, reintroduced by omission.
    const queries = readFileSync(join(root, 'src/utils/swan-index/queries.ts'), 'utf8');
    const producers = ['getFeatured', 'getLatest', 'getByAuthor'];
    for (const p of producers) {
        const start = landmark(queries, `export async function ${p}(`);
        const body = queries.slice(start, landmark(queries, '\n}', start));
        assert.match(body, /attachCardImages\(db,/, `${p} must resolve its cards' images`);
    }
    assert.equal(
        (queries.match(/attachCardImages\(db,/g) || []).length, producers.length,
        'every producer, and only the producers',
    );
});

check('⚠️ image resolution is batched, not per card', () => {
    // A list legitimately spans contributors, so the naive fix is a resolveFeatureImageUrl call per
    // card — seven round trips on the page whose stated design is one indexed scan.
    const media = readFileSync(join(root, 'src/utils/blog-media-resolve.ts'), 'utf8');
    const fn = media.slice(landmark(media, 'export async function resolveCardImageUrls'));
    assert.equal((fn.match(/await db$|\.from\(contentAssets\)/g) || []).length, 1, 'exactly one query');
    assert.match(fn, /inArray\(contentAssets\.id, ids\)/, 'ids fetched together');
});

check('⚠️ a batched asset is only handed to the org that OWNS it', () => {
    // There is no `where organisationId = X` here, because the cards span organisations. Without
    // the per-item check that omission would let one contributor's post display another org's
    // private asset by referencing its id.
    const media = readFileSync(join(root, 'src/utils/blog-media-resolve.ts'), 'utf8');
    const fn = media.slice(landmark(media, 'export async function resolveCardImageUrls'));
    assert.match(fn, /hit\.organisationId === i\.orgId/, 'per-item tenant check is the only scoping here');
});

// ── the renderers ───────────────────────────────────────────────────────────
console.log('\nThe renderers\n');

check('the Swan Index card still falls back to its plate', () => {
    const render = readFileSync(join(root, 'src/utils/swan-index/render.ts'), 'utf8');
    const fn = render.slice(landmark(render, 'export function card('), landmark(render, 'export function indexRow('));
    assert.match(fn, /card__figure--empty/, 'a post with no image keeps the TSI plate');
    assert.match(fn, /c\.imageUrl/, 'and one with an image renders it');
});

check('the widget card renders a thumbnail only when there is one', () => {
    const widget = readFileSync(join(root, 'widget.js'), 'utf8');
    const fn = widget.slice(landmark(widget, 'function cardHtml(p)'), landmark(widget, 'function paintList()'));
    assert.match(fn, /p\.imageUrl\s*\?/, 'the thumbnail must be conditional');
    assert.match(fn, /: ''/, 'and its absence renders nothing, not a placeholder box');
    assert.match(fn, /loading="lazy"/, 'a long list of images should not block the read');
    assert.match(fn, /esc\(p\.imageUrl\)/, 'the URL is escaped into the attribute');
});

check('⚠️ the linked-card form gets the row layout too', () => {
    // `.bms a.bms-card{display:block}` is specificity (0,2,1); a bare `.bms .bms-card` is (0,2,0)
    // and loses. Every embed that opts into data-bms-post-url — which is what bemoreswan.com/blog
    // does — would have stacked the thumbnail while unlinked embeds got the row.
    const widget = readFileSync(join(root, 'widget.js'), 'utf8');
    assert.match(widget, /'\.bms \.bms-card,\.bms a\.bms-card\{display:flex/,
        'the flex rule must name the anchor form explicitly');
});

console.log(`\n${passed} checks passed.`);
