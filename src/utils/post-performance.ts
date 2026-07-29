// US-SMM-PERF: the aggregation behind the assistant-detail "Performance Metrics" KPI cards.
//
// Pure — takes post_insights rows and a clock, returns the exact JSON body the renderer
// (_loadAssistantMetrics in assistants.js) reads. The DB query and tenant guard live in
// netlify/functions/get-assistant-performance.ts; everything decision-making lives here so
// it can be exercised against synthetic rows (tests/post-performance.test.ts) without a DB.
//
// Rates are computed over posts whose reach the platform actually REPORTED (see `reachable`),
// so a platform returning null reach can't quietly deflate the denominator. Every metric the
// data can't support is returned as null — the renderer shows "—" rather than inventing a zero.

// Sparkline buckets across the current window. 6 × 5 days at the default 30.
const SERIES_BUCKETS = 6;
// A "win" is a post that converted on saves/shares despite modest reach. Both thresholds are
// relative to this assistant's own posts, so a small account isn't judged against a large one.
const LOW_REACH_RATIO = 0.75;   // reach below 75% of the median
const HIGH_VALUE_RATIO = 1.5;   // value rate at least 1.5× the window average
const MIN_POSTS_FOR_WINS = 4;   // below this there is no meaningful distribution to compare against
const MAX_TOP_VALUE_POSTS = 5;

export type InsightRow = {
    id: number;
    platform: string;
    publishedAt: Date | null;
    createdAt: Date;
    reach: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
    totalInteractions: number | null;
    linkClicks: number | null;
};

/** Sum that preserves "not reported": null when EVERY row is null, a number as soon as one isn't. */
function sumOrNull(rows: InsightRow[], pick: (r: InsightRow) => number | null): number | null {
    let total = 0;
    let seen = false;
    for (const r of rows) {
        const v = pick(r);
        if (v === null || v === undefined) continue;
        total += v;
        seen = true;
    }
    return seen ? total : null;
}

/** numerator / denominator, or null when either side can't support a rate. */
function rate(numerator: number | null, denominator: number): number | null {
    if (numerator === null || denominator <= 0) return null;
    return numerator / denominator;
}

/** Period-over-period change as a signed fraction. Null without a previous baseline to grow from. */
function growth(current: number | null, previous: number | null): number | null {
    if (current === null || previous === null || previous <= 0) return null;
    return (current - previous) / previous;
}

/** saves + shares + comments — the signals that outrank likes and views. */
function valueSignals(rows: InsightRow[]): number | null {
    const saves = sumOrNull(rows, (r) => r.saves);
    const shares = sumOrNull(rows, (r) => r.shares);
    const comments = sumOrNull(rows, (r) => r.comments);
    if (saves === null && shares === null && comments === null) return null;
    return (saves ?? 0) + (shares ?? 0) + (comments ?? 0);
}

function median(values: number[]): number {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The timestamp a row is bucketed by. Some published posts carry no published_at (the
 *  publisher didn't record one); the insight row's own created_at is the closest proxy. */
export function rowTime(r: InsightRow): number {
    return (r.publishedAt ?? r.createdAt).getTime();
}

/** One metric set over an arbitrary slice of posts. */
function summarise(rows: InsightRow[]) {
    // Rates need a denominator. Only posts whose reach the platform actually reported can
    // contribute — mixing null-reach posts into the numerator would overstate every rate.
    const reachable = rows.filter((r) => r.reach !== null && r.reach > 0);
    const reach = reachable.reduce((s, r) => s + (r.reach as number), 0);

    return {
        posts: rows.length,
        reach: reachable.length ? reach : null,
        engagementRate: rate(sumOrNull(reachable, (r) => r.totalInteractions), reach),
        clickThroughRate: rate(sumOrNull(reachable, (r) => r.linkClicks), reach),
        meaningfulEngagementRate: rate(valueSignals(reachable), reach),
        saves: sumOrNull(rows, (r) => r.saves),
        shares: sumOrNull(rows, (r) => r.shares),
        comments: sumOrNull(rows, (r) => r.comments),
    };
}

/** Sparkline points. Empty buckets are OMITTED rather than sent as zero — a week with no posts
 *  is missing data, not a crash to zero. Fewer than two real points means no curve at all:
 *  _setKpiCard hides the decorative one rather than drawing an invented trend under a real number. */
function buildSeries(rows: InsightRow[], windowStartMs: number, windowMs: number) {
    const bucketMs = windowMs / SERIES_BUCKETS;
    const buckets: InsightRow[][] = Array.from({ length: SERIES_BUCKETS }, () => []);
    for (const r of rows) {
        const i = Math.min(SERIES_BUCKETS - 1, Math.max(0, Math.floor((rowTime(r) - windowStartMs) / bucketMs)));
        buckets[i].push(r);
    }

    const points = buckets.filter((b) => b.length).map(summarise);
    const pick = (get: (p: ReturnType<typeof summarise>) => number | null) => {
        const vals = points.map(get).filter((v): v is number => v !== null);
        return vals.length >= 2 ? vals : null;
    };

    return {
        engagement: pick((p) => p.engagementRate),
        reach: pick((p) => p.reach),
        ctr: pick((p) => p.clickThroughRate),
        value: pick((p) => p.meaningfulEngagementRate),
    };
}

/** Posts that earned strong saves/shares/comments on modest reach — surfaced as wins so success
 *  isn't judged on reach alone. Needs enough posts for "modest" and "strong" to mean anything. */
function topValuePosts(rows: InsightRow[], windowValueRate: number | null) {
    const reachable = rows.filter((r) => r.reach !== null && r.reach > 0);
    if (reachable.length < MIN_POSTS_FOR_WINS) return [];

    const medianReach = median(reachable.map((r) => r.reach as number));

    return reachable
        .map((r) => {
            const signals = valueSignals([r]);
            const valueRate = rate(signals, r.reach as number);
            return {
                id: r.id,
                platform: r.platform,
                publishedAt: r.publishedAt ?? r.createdAt,
                reach: r.reach,
                saves: r.saves,
                shares: r.shares,
                comments: r.comments,
                valueRate,
                lowReachHighValue:
                    valueRate !== null &&
                    windowValueRate !== null &&
                    (r.reach as number) < medianReach * LOW_REACH_RATIO &&
                    valueRate >= windowValueRate * HIGH_VALUE_RATIO,
            };
        })
        .filter((p) => p.valueRate !== null)
        .sort((a, b) => (b.valueRate as number) - (a.valueRate as number))
        .slice(0, MAX_TOP_VALUE_POSTS);
}

export function emptyPayload(periodDays: number) {
    return {
        hasData: false,
        periodDays,
        metrics: {
            engagementRate: null,
            reachGrowth: null,
            clickThroughRate: null,
            meaningfulEngagementRate: null,
            valueScoreGrowth: null,
        },
        series: { engagement: null, reach: null, ctr: null, value: null },
        current: { posts: 0, saves: null, shares: null },
        topValuePosts: [] as ReturnType<typeof topValuePosts>,
    };
}

/**
 * `rows` must cover TWO windows — the current `periodDays` and the one before it, which supplies
 * the growth baseline. The split happens here, not in SQL, so one query serves both.
 */
export function buildPerformancePayload(rows: InsightRow[], periodDays: number, nowMs: number) {
    const windowMs = periodDays * 24 * 60 * 60 * 1000;
    const windowStartMs = nowMs - windowMs;

    const current = rows.filter((r) => rowTime(r) >= windowStartMs);
    const previous = rows.filter((r) => rowTime(r) < windowStartMs);

    if (!current.length) return emptyPayload(periodDays);

    const cur = summarise(current);
    const prev = summarise(previous);

    return {
        hasData: true,
        periodDays,
        metrics: {
            engagementRate: cur.engagementRate,
            reachGrowth: growth(cur.reach, prev.reach),
            clickThroughRate: cur.clickThroughRate,
            meaningfulEngagementRate: cur.meaningfulEngagementRate,
            valueScoreGrowth: growth(cur.meaningfulEngagementRate, prev.meaningfulEngagementRate),
        },
        series: buildSeries(current, windowStartMs, windowMs),
        current: { posts: cur.posts, saves: cur.saves, shares: cur.shares },
        topValuePosts: topValuePosts(current, cur.meaningfulEngagementRate),
    };
}
