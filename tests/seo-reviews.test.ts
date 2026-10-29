// tests/seo-reviews.test.ts
// Job 9 of scripts/build-seo-html.mjs: published reviews of Be More Swan on the home and pricing
// pages (scripts/seo/reviews.mjs, get-reviews.ts). Nothing until three; newest first, never by stars;
// the visible average equals the marked-up one; every quote keeps its incentive note.
//
// Run:  npx tsx tests/seo-reviews.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore — plain .mjs build helper, no declaration file
import { llmsReviewsLine, MIN_TO_SHOW, reviewsJsonLd, showable, testimonialsHtml } from '../scripts/seo/reviews.mjs';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const review = (over: Record<string, unknown> = {}) => ({
    name: 'Sarah K.', detail: 'Florist, Leeds', rating: 4, body: 'Saved me hours.', incentiveNote: 'Received free access during beta', date: '2026-10-20', ...over,
});
const data = (reviews: unknown[], count = reviews.length, average = 4.2) => ({ reviews, summary: { count, average } });

console.log('\nWhen there is something to show');

check(`nothing at all below ${MIN_TO_SHOW} published reviews`, () => {
    const two = data([review(), review({ name: 'Tom' })]);
    assert.strictEqual(testimonialsHtml(two), '');
    assert.strictEqual(reviewsJsonLd(two), '');
    assert.strictEqual(llmsReviewsLine(two), '');
    assert.strictEqual(testimonialsHtml(null), '', 'a failed fetch shows nothing rather than throwing');
});

check('newest first, never sorted by stars', () => {
    const s = showable(data([
        review({ name: 'Old five', rating: 5, date: '2026-09-01' }),
        review({ name: 'New one', rating: 1, date: '2026-10-25' }),
        review({ name: 'Mid three', rating: 3, date: '2026-10-01' }),
    ]));
    assert.deepStrictEqual(s.reviews.map((r: { name: string }) => r.name), ['New one', 'Mid three', 'Old five']);
});

console.log('\nWhat the page says');

const three = data([review(), review({ name: 'Tom <b>', body: 'Good\n\n<script>x</script>', date: '2026-10-21' }), review({ name: 'Ann', incentiveNote: null })], 7, 4.25);

check('shows the same average and count as the markup, including hidden reviews', () => {
    const html = testimonialsHtml(three);
    assert.ok(html.includes('4.3 out of 5'), 'average rounded to one place');
    assert.ok(html.includes('from 7 reviews'), 'count is every counted review, not just the quoted');
    const ld = JSON.parse(reviewsJsonLd(three).replace(/<\/?script[^>]*>/g, ''));
    assert.strictEqual(ld.aggregateRating.ratingValue, '4.3');
    assert.strictEqual(ld.aggregateRating.reviewCount, 7);
    assert.strictEqual(ld.review.length, 3);
});

check('every quote keeps its incentive note', () => {
    const html = testimonialsHtml(three);
    assert.strictEqual(html.split('Received free access during beta').length - 1, 2);
});

check('escapes the reviewer\'s words', () => {
    const html = testimonialsHtml(three);
    assert.ok(!html.includes('<script>x'));
    assert.ok(html.includes('Tom &lt;b&gt;'));
    assert.ok(!reviewsJsonLd(three).includes('<script>x'), 'JSON-LD escapes < too');
});

check('the markup hangs off the SoftwareApplication node, not Organization', () => {
    const ld = JSON.parse(reviewsJsonLd(three).replace(/<\/?script[^>]*>/g, ''));
    assert.strictEqual(ld['@type'], 'SoftwareApplication');
    assert.strictEqual(ld['@id'], 'https://bemoreswan.com/#software');
});

console.log('\nThe wiring');

check('both pages carry the marker region exactly once', () => {
    for (const page of ['index.html', 'pricing.html']) {
        const html = read(page);
        assert.strictEqual(html.split('<!-- BUILD:TESTIMONIALS -->').length - 1, 1, page);
        assert.ok(html.indexOf('<!-- /BUILD:TESTIMONIALS -->') > html.indexOf('<!-- BUILD:TESTIMONIALS -->'), page);
    }
});

check('the build runs Job 9 and never fails a deploy for want of reviews', () => {
    const b = read('scripts/build-seo-html.mjs');
    assert.ok(b.includes('await bakeReviews();'));
    const fetchFn = b.slice(b.indexOf('async function fetchReviews'), b.indexOf('async function bakeReviews'));
    assert.ok(fetchFn.length > 50 && !fetchFn.includes('handleFetchFailure') && !fetchFn.includes('fail('));
});

check('get-reviews returns only published, consented reviews, newest first', () => {
    const f = read('netlify/functions/get-reviews.ts');
    assert.ok(/eq\(platformReviews\.status, 'published'\), eq\(platformReviews\.consentToPublish, true\)/.test(f));
    assert.ok(f.includes('desc(platformReviews.createdAt)'));
    assert.ok(!/authorEmail|users\.email|userId:/.test(f), 'nothing identifying beyond the typed name');
});

check('publishing or hiding a review rebuilds the site', () => {
    assert.ok(read('netlify/functions/admin-platform-reviews.ts').includes('triggerSiteRebuild('));
});

console.log(`\n${passed}/${total} passed`);
