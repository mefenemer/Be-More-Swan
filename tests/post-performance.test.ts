// tests/post-performance.test.ts
// US-SMM-PERF: the aggregation behind the assistant-detail "Performance Metrics" cards.
// These four cards were blank for every assistant because the renderer read a shape
// (hasData / metrics / series / current / topValuePosts) that no endpoint produced. This
// locks the contract in both directions: the payload the renderer expects, and the honest
// nulls it relies on to keep showing "—" instead of inventing a zero.
// Run:  npx tsx tests/post-performance.test.ts

import assert from 'node:assert';
import { buildPerformancePayload, type InsightRow } from '../src/utils/post-performance';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-29T12:00:00Z').getTime();

let nextId = 1;
function row(daysAgo: number, o: Partial<InsightRow> = {}): InsightRow {
    const at = new Date(NOW - daysAgo * DAY);
    return {
        id: nextId++,
        platform: 'instagram',
        publishedAt: at,
        createdAt: at,
        reach: 1000,
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        totalInteractions: 0,
        linkClicks: null,
        ...o,
    };
}

// ── no rows at all → the honest empty payload, not a wall of zeros ──────────
const empty = buildPerformancePayload([], 30, NOW);
assert.strictEqual(empty.hasData, false);
assert.strictEqual(empty.periodDays, 30);
assert.strictEqual(empty.metrics.engagementRate, null);
assert.strictEqual(empty.current.posts, 0);
assert.deepStrictEqual(empty.topValuePosts, []);

// Rows exist but ALL fall outside the window (they were fetched only as a growth baseline).
// hasData must stay false — there is nothing to report for the period on screen.
const staleOnly = buildPerformancePayload([row(45), row(50)], 30, NOW);
assert.strictEqual(staleOnly.hasData, false, 'baseline-only rows are not "data for this period"');

// ── engagement rate = interactions / reach, over reported-reach posts only ──
const basic = buildPerformancePayload([
    row(5,  { reach: 1000, totalInteractions: 50 }),
    row(10, { reach: 1000, totalInteractions: 150 }),
], 30, NOW);
assert.strictEqual(basic.hasData, true);
assert.strictEqual(basic.metrics.engagementRate, 200 / 2000, '10% engagement');
assert.strictEqual(basic.current.posts, 2);

// A post whose reach the platform never reported must not deflate the denominator:
// adding it leaves the rate identical, but it still counts as a post.
const withNullReach = buildPerformancePayload([
    row(5,  { reach: 1000, totalInteractions: 50 }),
    row(10, { reach: 1000, totalInteractions: 150 }),
    row(12, { reach: null, totalInteractions: 999 }),
], 30, NOW);
assert.strictEqual(withNullReach.metrics.engagementRate, 200 / 2000,
    'null-reach post must not enter either side of the rate');
assert.strictEqual(withNullReach.current.posts, 3, 'but it is still a post');

// ── click-through: null everywhere (IG organic) must stay null, never 0 ─────
assert.strictEqual(basic.metrics.clickThroughRate, null,
    'unreported CTR is "—", not 0% — the renderer prints "Not tracked on Instagram"');
const withClicks = buildPerformancePayload([
    row(5, { reach: 500, linkClicks: 25 }),
], 30, NOW);
assert.strictEqual(withClicks.metrics.clickThroughRate, 25 / 500);
// One reporting platform among several is enough to produce a rate.
const mixedClicks = buildPerformancePayload([
    row(5,  { reach: 500, linkClicks: 25 }),
    row(6,  { reach: 500, linkClicks: null }),
], 30, NOW);
assert.strictEqual(mixedClicks.metrics.clickThroughRate, 25 / 1000,
    'a reported click count survives alongside unreported ones');

// ── meaningful engagement = (saves + shares + comments) / reach ─────────────
const value = buildPerformancePayload([
    row(5, { reach: 1000, saves: 10, shares: 5, comments: 5 }),
], 30, NOW);
assert.strictEqual(value.metrics.meaningfulEngagementRate, 20 / 1000);
assert.strictEqual(value.current.saves, 10);
assert.strictEqual(value.current.shares, 5);

// All three value signals unreported → null, not 0.
const noValue = buildPerformancePayload([
    row(5, { reach: 1000, saves: null, shares: null, comments: null }),
], 30, NOW);
assert.strictEqual(noValue.metrics.meaningfulEngagementRate, null);
assert.strictEqual(noValue.current.saves, null);

// ── growth compares the window against the one before it ───────────────────
const growing = buildPerformancePayload([
    row(5,  { reach: 1500 }),   // current window: 1500
    row(40, { reach: 1000 }),   // prior window:   1000
], 30, NOW);
assert.strictEqual(growing.metrics.reachGrowth, 0.5, '+50%');

const shrinking = buildPerformancePayload([
    row(5,  { reach: 500 }),
    row(40, { reach: 1000 }),
], 30, NOW);
assert.strictEqual(shrinking.metrics.reachGrowth, -0.5, 'growth can be negative');

// No baseline to grow from → null. A first-ever period is not "+100%".
assert.strictEqual(basic.metrics.reachGrowth, null, 'no prior window → no growth figure');

// ── sparkline series ───────────────────────────────────────────────────────
// Two populated buckets is the minimum for a curve.
const sparked = buildPerformancePayload([
    row(2,  { reach: 1000, totalInteractions: 100 }),
    row(12, { reach: 1000, totalInteractions: 50 }),
    row(22, { reach: 1000, totalInteractions: 20 }),
], 30, NOW);
assert.ok(Array.isArray(sparked.series.engagement), 'three spread-out posts produce a curve');
assert.strictEqual((sparked.series.engagement as number[]).length, 3);
// Empty buckets are omitted, not sent as zero — a quiet fortnight is missing data, not a crash.
assert.ok((sparked.series.engagement as number[]).every((v) => v > 0),
    'no synthetic zero points for the weeks with no posts');
// A single bucket cannot be a trend.
const oneBucket = buildPerformancePayload([
    row(3, { reach: 1000, totalInteractions: 100 }),
    row(4, { reach: 1000, totalInteractions: 100 }),
], 30, NOW);
assert.strictEqual(oneBucket.series.engagement, null, 'one populated bucket draws no curve');
// CTR series stays null when no platform reports clicks.
assert.strictEqual(sparked.series.ctr, null);

// ── low-reach / high-value wins ────────────────────────────────────────────
// Below the 4-post floor there is no distribution to judge "modest" against.
const tooFew = buildPerformancePayload([
    row(3, { reach: 100, saves: 50 }),
    row(4, { reach: 5000, saves: 1 }),
], 30, NOW);
assert.deepStrictEqual(tooFew.topValuePosts, [], 'under 4 posts, no wins are claimed');

const wins = buildPerformancePayload([
    row(3,  { reach: 5000, saves: 50 }),   // big reach, ordinary rate (1%)
    row(4,  { reach: 5000, saves: 50 }),
    row(5,  { reach: 4000, saves: 40 }),
    row(6,  { reach: 4000, saves: 40 }),
    row(7,  { reach: 200,  saves: 40 }),   // tiny reach, 20% — the win
], 30, NOW);
const flagged = wins.topValuePosts.filter((p) => p.lowReachHighValue);
assert.strictEqual(flagged.length, 1, 'exactly the low-reach/high-value post is flagged');
assert.strictEqual(flagged[0].reach, 200);
// Sorted by value rate, best first — the renderer takes the head of this list.
assert.strictEqual(wins.topValuePosts[0].reach, 200);
assert.ok(wins.topValuePosts.length <= 5, 'capped at 5');
// A high-reach post is never mistaken for a win.
assert.ok(wins.topValuePosts.filter((p) => p.reach === 5000).every((p) => !p.lowReachHighValue));

// ── published_at is optional; created_at is the fallback clock ──────────────
// A published post with no recorded publish time must still land in the window.
const nullPublished = buildPerformancePayload([
    { ...row(5, { reach: 1000, totalInteractions: 100 }), publishedAt: null },
], 30, NOW);
assert.strictEqual(nullPublished.hasData, true, 'null published_at falls back to created_at');
assert.strictEqual(nullPublished.metrics.engagementRate, 0.1);

// ── the period is honoured, not assumed ────────────────────────────────────
// A post 20 days old is inside a 30-day window and outside a 7-day one.
const rows20 = [row(20, { reach: 1000, totalInteractions: 100 })];
assert.strictEqual(buildPerformancePayload(rows20, 30, NOW).hasData, true);
assert.strictEqual(buildPerformancePayload(rows20, 7, NOW).hasData, false);
assert.strictEqual(buildPerformancePayload(rows20, 7, NOW).periodDays, 7,
    'the empty payload still reports the period it was asked for');

console.log('post-performance.test.ts: all assertions passed');
