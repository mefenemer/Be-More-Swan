// tests/blog-performance.test.ts
// The Blog Writer's four "Performance Metrics" KPI cards. Locks the presentation rules that keep
// these cards from claiming things we did not measure.
//
// Context: the Blog Writer's cards were fed by get-assistant-performance.ts, which reads
// `post_insights` — the Instagram per-post table. A Blog Writer writes to `blog_posts` and never to
// that table, so hasData was false permanently and the grid told every Blog Writer user "nothing
// has been published in the last 30 days". src/utils/blog-performance.ts is the replacement source.
//
// Run:  npx tsx tests/blog-performance.test.ts

import assert from 'node:assert';
import {
    BLOG_PERFORMANCE_DAYS, buildBlogPerformance, emptyBlogPerformance, publishedGrowth,
    type BlogPerformanceCounts,
} from '../src/utils/blog-performance';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const counts = (over: Partial<BlogPerformanceCounts> = {}): BlogPerformanceCounts => ({
    publishedCurrent: 0, publishedPrior: 0, awaitingApproval: 0,
    searchImpressions: null, trackedPosts: 0, searchClicks: null, clickedPosts: 0,
    engagementViews: 0, engagementSeconds: null, hoursSaved: 0, ...over,
});

console.log('\nhasData — what counts as "this assistant has done something"');

check('a genuinely idle assistant reports no data', () => {
    assert.strictEqual(buildBlogPerformance(counts()).hasData, false);
});

// The old endpoint's whole failure was hiding a working assistant behind "nothing published".
// Drafts in review ARE activity, and card 4 reports them — so the grid must not be hidden.
check('drafts waiting in review count as data, even with nothing published', () => {
    const out = buildBlogPerformance(counts({ awaitingApproval: 3 }));
    assert.strictEqual(out.hasData, true);
    assert.strictEqual(out.metrics.awaitingApproval, 3);
    assert.strictEqual(out.trends.awaitingApproval, 'Waiting on you');
});

check('publishing only in the PRIOR window still counts — the assistant has a history', () => {
    assert.strictEqual(buildBlogPerformance(counts({ publishedPrior: 4 })).hasData, true);
});

check('hours saved alone counts', () => {
    assert.strictEqual(buildBlogPerformance(counts({ hoursSaved: 6.5 })).hasData, true);
});

console.log('\ngrowth — the divide-by-zero that would fake a headline number');

// +100% on a first-ever post, then a "crash" to 0% next period, is a growth figure invented from
// no baseline. Null is the only honest answer, and the trend line says so in words instead.
check('no prior window yields null growth, never +100%', () => {
    assert.strictEqual(publishedGrowth(5, 0), null);
    const out = buildBlogPerformance(counts({ publishedCurrent: 5, publishedPrior: 0 }));
    assert.strictEqual(out.metrics.publishedGrowth, null);
    assert.strictEqual(out.trends.postsPublished, 'First in this window');
});

check('a real baseline yields a signed percentage', () => {
    const up = buildBlogPerformance(counts({ publishedCurrent: 6, publishedPrior: 4 }));
    assert.strictEqual(up.metrics.publishedGrowth, 0.5);
    assert.strictEqual(up.trends.postsPublished, '+50% vs previous');

    const down = buildBlogPerformance(counts({ publishedCurrent: 2, publishedPrior: 4 }));
    assert.strictEqual(down.trends.postsPublished, '-50% vs previous');
});

check('a quiet current window against a busy prior one reads as -100%, not as no data', () => {
    const out = buildBlogPerformance(counts({ publishedCurrent: 0, publishedPrior: 3 }));
    assert.strictEqual(out.hasData, true);
    assert.strictEqual(out.trends.postsPublished, '-100% vs previous');
});

console.log('\nsearch impressions — null and 0 are different answers');

// This is the linkedin_followers class of bug: reporting a measured 0 for something we never
// looked at. Search Console not connected must stay null all the way to the renderer, which
// prints "Not tracked" rather than a zero the user would read as "nobody found me".
check('not connected stays null and says so', () => {
    const out = buildBlogPerformance(counts({ publishedCurrent: 3, searchImpressions: null }));
    assert.strictEqual(out.metrics.searchImpressions, null);
    assert.strictEqual(out.trends.searchImpressions, 'Connect Search Console');
});

check('connected with a genuine zero is reported as zero, not as unknown', () => {
    const out = buildBlogPerformance(counts({ publishedCurrent: 3, searchImpressions: 0, trackedPosts: 3 }));
    assert.strictEqual(out.metrics.searchImpressions, 0);
    assert.strictEqual(out.trends.searchImpressions, '3 posts tracked');
});

// The same impression count over 2 posts and over 40 means very different things, and the card has
// no room to explain — so the denominator goes in the trend line.
check('the trend names how many posts the figure covers, plural-safely', () => {
    assert.strictEqual(
        buildBlogPerformance(counts({ publishedCurrent: 1, searchImpressions: 9, trackedPosts: 1 })).trends.searchImpressions,
        '1 post tracked');
    assert.strictEqual(
        buildBlogPerformance(counts({ publishedCurrent: 9, searchImpressions: 900, trackedPosts: 7 })).trends.searchImpressions,
        '7 posts tracked');
});

console.log('\nshape + defaults');

check('the empty payload never claims a measured zero for search', () => {
    const e = emptyBlogPerformance();
    assert.strictEqual(e.hasData, false);
    assert.strictEqual(e.metrics.searchImpressions, null);
    assert.strictEqual(e.metrics.publishedGrowth, null);
    for (const v of Object.values(e.trends)) assert.strictEqual(v, '—');
});

// 30 days on a fortnightly blog cadence reports "2" and makes an ordinary month look like a
// collapse. The window is a deliberate departure from the social endpoint's 30.
check('the default window is 90 days, not the social 30', () => {
    assert.strictEqual(BLOG_PERFORMANCE_DAYS, 90);
    assert.strictEqual(buildBlogPerformance(counts({ publishedCurrent: 1 })).periodDays, 90);
    assert.strictEqual(buildBlogPerformance(counts({ publishedCurrent: 1 }), 180).periodDays, 180);
});

check('the raw counts are echoed back, so the renderer never has to re-derive them', () => {
    const c = counts({ publishedCurrent: 4, publishedPrior: 2, awaitingApproval: 1, hoursSaved: 3.5 });
    assert.deepStrictEqual(buildBlogPerformance(c).counts, c);
    // ...including on the no-data path, where the empty payload's own counts would otherwise lie.
    assert.deepStrictEqual(buildBlogPerformance(counts()).counts, counts());
});

check('"All clear" is only said when the queue is genuinely empty', () => {
    assert.strictEqual(buildBlogPerformance(counts({ publishedCurrent: 2 })).trends.awaitingApproval, 'All clear');
    assert.strictEqual(buildBlogPerformance(counts({ awaitingApproval: 1 })).trends.awaitingApproval, 'Waiting on you');
});

console.log('\nOrganic Clicks — the partner card to Search Impressions');

check('no Search Console connection reports null, not a measured zero', () => {
    const out = buildBlogPerformance(counts({ publishedCurrent: 3, searchClicks: null }));
    assert.strictEqual(out.metrics.searchClicks, null);
    assert.strictEqual(out.trends.searchClicks, 'Connect Search Console');
});

check('connected-but-nobody-clicked is a real 0, and says so', () => {
    const out = buildBlogPerformance(counts({ publishedCurrent: 3, searchClicks: 0, clickedPosts: 3 }));
    assert.strictEqual(out.metrics.searchClicks, 0);
    assert.strictEqual(out.trends.searchClicks, '3 posts tracked');
});

check('the clicks trend names its OWN denominator, not the impressions one', () => {
    // The two populations genuinely differ — a post ingested before search_clicks existed has
    // impressions and no clicks row — so the card must not borrow trackedPosts.
    const out = buildBlogPerformance(counts({
        publishedCurrent: 9, searchImpressions: 900, trackedPosts: 7, searchClicks: 40, clickedPosts: 2,
    }));
    assert.strictEqual(out.trends.searchImpressions, '7 posts tracked');
    assert.strictEqual(out.trends.searchClicks, '2 posts tracked');
});

check('a single tracked post is not pluralised', () => {
    const out = buildBlogPerformance(counts({ publishedCurrent: 1, searchClicks: 9, clickedPosts: 1 }));
    assert.strictEqual(out.trends.searchClicks, '1 post tracked');
});

check('the empty payload carries clicks as null, never 0', () => {
    assert.strictEqual(emptyBlogPerformance().metrics.searchClicks, null);
});

console.log('\nAverage Read Time — the quality counterweight');

check('nothing measured reports null, not a zero-second read', () => {
    const out = buildBlogPerformance(counts({ publishedCurrent: 3 }));
    assert.strictEqual(out.metrics.engagementSeconds, null);
    assert.strictEqual(out.trends.engagementSeconds, 'No reads measured yet');
});

check('the trend names the sample size, plural-safely', () => {
    assert.strictEqual(
        buildBlogPerformance(counts({ publishedCurrent: 2, engagementViews: 1, engagementSeconds: 95 })).trends.engagementSeconds,
        '1 read measured');
    assert.strictEqual(
        buildBlogPerformance(counts({ publishedCurrent: 2, engagementViews: 340, engagementSeconds: 160 })).trends.engagementSeconds,
        '340 reads measured');
});

check('live readers alone keep the grid open, even with nothing published in the window', () => {
    // Reads are lifetime, publishedCurrent is windowed — a blog being read but not freshly
    // published to must not fall back to the "you have done nothing" empty state.
    const out = buildBlogPerformance(counts({ engagementViews: 12, engagementSeconds: 143 }));
    assert.strictEqual(out.hasData, true);
    assert.strictEqual(out.metrics.engagementSeconds, 143);
});

check('the empty payload carries read time as null, never 0', () => {
    assert.strictEqual(emptyBlogPerformance().metrics.engagementSeconds, null);
    assert.strictEqual(emptyBlogPerformance().counts.engagementViews, 0);
});

console.log(`\n${passed} checks passed.\n`);
