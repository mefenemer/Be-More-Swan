// tests/reviews.test.ts
// Business Information ▸ Reviews and the website's reviews section: the customers' words kept word
// for word, an average that hiding can't improve, and a section that quotes only what is recorded.
// src/utils/reviews.ts, org-reviews.ts, site-render.ts.
//
// Run:  npx tsx tests/reviews.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanReview, reviewSummary, SOURCE_LABEL, type SiteRenderReviews } from '../src/utils/reviews';
import { normaliseSiteDefinition, type ReviewsProps, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { siteFromDraftReply } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nSaving a review');

check('keeps the words exactly, tidying only spacing at the ends', () => {
    const r = cleanReview({ authorName: '  Sarah   K. ', body: '  Brilliant service!!\r\n\r\n\r\nwould recomend  \n', rating: '5', source: 'google', reviewedOn: '2026-09-01' }, false, new Date('2026-10-15'));
    assert.ok(r.ok);
    if (r.ok) assert.deepStrictEqual(r.value, { authorName: 'Sarah K.', body: 'Brilliant service!!\n\nwould recomend', rating: 5, source: 'google', reviewedOn: '2026-09-01' });
});
check('needs a name and the words; stars 1–5 or none; a known source; a past date; https links', () => {
    const t = new Date('2026-10-15');
    assert.ok(!cleanReview({ body: 'Great' }, false, t).ok);
    assert.ok(!cleanReview({ authorName: 'A' }, false, t).ok);
    assert.ok(!cleanReview({ authorName: 'A', body: 'x', rating: 6 }, false, t).ok);
    assert.ok(!cleanReview({ authorName: 'A', body: 'x', rating: 4.5 }, false, t).ok);
    const none = cleanReview({ authorName: 'A', body: 'x', rating: '' }, false, t);
    assert.ok(none.ok && none.value.rating === null && none.value.source === 'direct');
    assert.ok(!cleanReview({ authorName: 'A', body: 'x', source: 'yelp' }, false, t).ok);
    const future = cleanReview({ authorName: 'A', body: 'x', reviewedOn: '2026-12-01' }, false, t);
    assert.ok(!future.ok && /future/.test(future.error));
    assert.ok(!cleanReview({ sourceUrl: 'http://g.co/x' }, true, t).ok);
    assert.ok(cleanReview({ sourceUrl: 'https://g.co/x' }, true, t).ok);
});
check('an edit changes only what is sent; status is only shown or hidden', () => {
    const r = cleanReview({ status: 'hidden' }, true);
    assert.ok(r.ok && JSON.stringify(r.value) === '{"status":"hidden"}');
    assert.ok(!cleanReview({ status: 'pending' }, true).ok);
});

console.log('\nThe average');

check('hiding a review never improves the score; pending / declined never count', () => {
    const rows = [
        { rating: 5, status: 'published' }, { rating: 5, status: 'published' }, { rating: 1, status: 'hidden' },
        { rating: 1, status: 'pending' }, { rating: 1, status: 'declined' }, { rating: null, status: 'published' },
    ];
    assert.deepStrictEqual(reviewSummary(rows), { average: 3.7, count: 4, rated: 3 });
});
check('no stars anywhere → no average', () => {
    assert.strictEqual(reviewSummary([{ rating: null, status: 'published' }]), null);
});

console.log('\nThe section');

const reviews: SiteRenderReviews = {
    summary: { average: 4.7, count: 4, rated: 3 },
    byId: {
        7: { id: 7, authorName: 'Sarah K.', authorDetail: 'Leeds', rating: 5, body: 'Brilliant service.\nWould recommend.', sourceLabel: SOURCE_LABEL.google, sourceUrl: 'https://g.co/r/7', reviewedOn: '2026-09-01' },
        8: { id: 8, authorName: 'Tom', authorDetail: null, rating: null, body: 'Lovely <b>people</b>.', sourceLabel: SOURCE_LABEL.direct, sourceUrl: null, reviewedOn: null },
        9: { id: 9, authorName: 'Ana', authorDetail: null, rating: 4, body: 'Good.', sourceLabel: SOURCE_LABEL.facebook, sourceUrl: null, reviewedOn: '2026-08-10' },
    },
    latest: [7, 9, 8],
};
const site = (props: Record<string, unknown>): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Salon' },
    pages: [{ title: 'Home', slug: '', sections: [{ id: 'r1', type: 'reviews', props }] }],
}).definition;
const live = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, reviews };

check('the gate keeps chosen ids, a sensible limit and the summary on by default', () => {
    const p = site({ reviewIds: [9, '7', 9, -1], limit: 40 }).pages[0].sections[0].props as ReviewsProps;
    assert.deepStrictEqual(p, { heading: 'What our customers say', intro: null, reviewIds: [9, 7], limit: 6, showSummary: true });
    const typed = site({ reviewIds: [], items: [{ quote: 'Made up', name: 'Nobody' }] }).pages[0].sections[0].props;
    assert.ok(!('items' in typed));
});
check('quotes the chosen reviews in order, with stars, name, source link and month', () => {
    const html = renderSitePage(site({ reviewIds: [9, 7] }), '/', live).html;
    assert.ok(html.indexOf('Ana') < html.indexOf('Sarah K.'));
    assert.ok(html.includes('<span class="stars" role="img" aria-label="5 out of 5 stars">★★★★★<span class="off"></span></span>'));
    assert.ok(html.includes('<strong>Sarah K.</strong>, Leeds'));
    assert.ok(html.includes('<a href="https://g.co/r/7" rel="noopener">Google review</a> · September 2026'));
    assert.ok(!html.includes('Tom'));
});
check('no ids → the newest, up to the limit; the words are escaped, never HTML', () => {
    const html = renderSitePage(site({ limit: 2 }), '/', live).html;
    assert.ok(html.includes('Sarah K.') && html.includes('Ana') && !html.includes('Tom'));
    const all = renderSitePage(site({ limit: 3 }), '/', live).html;
    assert.ok(all.includes('Lovely &lt;b&gt;people&lt;/b&gt;.') && all.includes('Sent to us directly'));
});
check('the honest average, and in the search data as an AggregateRating', () => {
    const html = renderSitePage(site({}), '/', live).html;
    assert.ok(html.includes('<strong>4.7 out of 5</strong> <span class="fine">from 3 rated reviews</span>'));
    assert.ok(html.includes('"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.7","reviewCount":3,"bestRating":5,"worstRating":1}'));
    assert.ok(!renderSitePage(site({ showSummary: false }), '/', live).html.includes('out of 5</strong>'));
});
check('with no reviews it is absent live and explained in the preview', () => {
    const empty = { ...live, reviews: { summary: null, byId: {}, latest: [] } };
    assert.ok(!renderSitePage(site({}), '/', empty).html.includes('id="r1"'));
    assert.ok(renderSitePage(site({}), '/', { ...empty, preview: true }).html.includes('Business Information ▸ Reviews'));
});

console.log('\nDrafts and wiring');

check('a whole-site draft never adds a reviews section', () => {
    const d = siteFromDraftReply({ pages: [{ title: 'Home', slug: '', sections: [
        { type: 'hero', props: { headline: 'Hair you love' } }, { type: 'reviews', props: { reviewIds: [7] } },
    ] }] }, site({}), 5);
    assert.ok(d && !d.definition.pages.some((p) => p.sections.some((s) => s.type === 'reviews')));
});
check('Business Information, the API, the editor, the chat and both renderers are wired', () => {
    const ui = read('assets.html');
    assert.ok(ui.includes('data-tab="reviews">Reviews</button>') && ui.includes("const API = '/.netlify/functions/org-reviews'") && ui.includes('id="rv-body"'));
    const api = read('netlify/functions/org-reviews.ts');
    assert.ok(api.includes('requireTenant') && api.includes('eq(orgReviews.organisationId, orgId)'));
    const editor = read('src/components/assistant-site-editor.js');
    assert.ok(editor.includes("reviews: 'Reviews'") && editor.includes("kind: 'reviewPick'") && editor.includes('data-site-open-reviews'));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('"type":"reviews_add"') && chat.includes('WORD FOR WORD'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('reviews_add', renderReviewsAddCard)"));
    assert.ok(read('src/components/chat-session.js').includes("container.addEventListener('site:reviewsAdd', onReviewsAdd)"));
    assert.ok(read('netlify/functions/site-serve.ts').includes('reviews: await loadSiteReviews(db, site.organisationId, definition)'));
    assert.ok(read('netlify/functions/site-preview.ts').includes('reviews: await loadSiteReviews(db, ctx.organisationId, definition)'));
});

console.log(`\n${passed}/${total} passed\n`);
