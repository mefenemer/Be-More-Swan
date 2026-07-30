// src/config/goal-metrics.ts
//
// Epic: AI-Driven SMART Goals — Feature 1 / metric catalog (the keystone).
//
// SINGLE SOURCE OF TRUTH for which Target Metrics a goal can be set against (AC1.1.2),
// what data source feeds each one, and which third-party connection it requires (AC1.1.3).
// The Goal Builder dropdown, the connection-gating, and the Phase-2 telemetry poller all
// read this catalog — add a new metric HERE, never inline at a call site.
//
// v1 scope: Instagram + LinkedIn + internal metrics (the data we can actually measure today —
// see [[smm-golive-readiness]]). HubSpot / Shopify / Salesforce etc. are added later as new
// catalog entries once their pollers exist.

// 'connection' — polled from a third-party API.  'internal' — counted from our own tables.
// 'manual'     — the user types the figure in periodically, because nothing we can reach measures it.
//
// WHY 'manual' EXISTS. A goal is only offered when the platform can measure it (`available`), which
// is right — an unmeasurable metric that silently never moves is worse than no metric. But
// "measurable" and "attributable" are different questions, and conflating them left a real gap: a
// business whose actual objective is revenue or subscription uptake had nothing to set a goal
// against, because we cannot see either number. The precedent for the fix already shipped —
// manual_follower_counts (save-follower-count.ts) accepts a user-typed LinkedIn follower count for
// exactly this reason ("the API can't supply this, so it's entered manually").
//
// A manual metric is USER-SUPPLIED TRUTH on a cadence, and that changes three behaviours it would
// otherwise inherit, each of which would actively misfire:
//   1. Staleness. RUN_RATE_THRESHOLDS.staleDataHours (48h) would rot a monthly figure to
//      data_disconnected on day three and fire a critical "reconnect your account" alert about a
//      connection that does not exist. Manual metrics use `updateCadenceDays` instead — see
//      staleWindowHoursFor() / staleStatusFor().
//   2. Run-rate. Between entries the value is flat only because nobody has typed a number, so
//      letting elapsed time run on would decay actualRunRate toward zero and drive the goal
//      off_track on the user's silence. goal-progress.ts measures the trend as of the last ENTRY
//      (rateAsOfLastEntry) and needs two of them before judging at all.
//   3. Attribution. Nothing a Social Media Manager drafts can be credited with moving revenue, so a
//      manual goal must not become the target a drafting prompt is told to chase — there is no
//      per-post lever for it in DRAFTING_FOCUS, and pointing the model at one invites it to invent
//      an offer. It steers as CONTEXT only (goal-directive.ts) and can never be the primary goal.
export type MetricSource = 'connection' | 'internal' | 'manual';
export type MetricDirection = 'increase' | 'decrease';

// US-01 AC1.1/AC1.2 — the funnel objective a metric serves. The Goal Builder shows an Objective
// dropdown first, then populates the Metric dropdown with the metrics for the chosen objective.
//   awareness  → top of funnel  (Followers, Reach, Impressions…)
//   engagement → middle         (Engagement rate, Saves, Shares…)
//   action     → bottom         (Leads, Link clicks, Profile visits…)
//   outcome    → the business result a non-social assistant is measured on (invoices chased,
//                tickets resolved, records enriched, meetings summarised). These roles have no
//                marketing funnel, so their metrics group under a single plain "Business Outcome".
export type GoalObjective = 'awareness' | 'engagement' | 'action' | 'outcome';

export interface GoalObjectiveDef { key: GoalObjective; label: string; }

export const GOAL_OBJECTIVES: readonly GoalObjectiveDef[] = [
    { key: 'awareness',  label: 'Grow my Audience (Awareness)' },
    { key: 'engagement', label: 'Increase Interaction (Engagement)' },
    { key: 'action',     label: 'Drive Traffic (Action)' },
    { key: 'outcome',    label: 'Business Outcome' },
];

/**
 * Attainability guardrails for a metric (the "A" in SMART). These keep a goal from being set to
 * something physically impossible (e.g. "+10,000,000 Instagram followers in 1 day"). The ceilings
 * are deliberately GENEROUS — we only want to block the egregiously impossible, never a merely
 * ambitious target. Tunable here as the single source of truth.
 */
export interface MetricRealism {
    /** Hard ceiling on the target value itself (e.g. a percentage can't exceed 100). */
    maxValue?: number;
    /** Largest plausible increase per day, in absolute units. Sanity-checks the required run-rate
     *  ((target − baseline) ÷ days). When the baseline is unknown we treat it as 0 (conservative). */
    maxDailyDelta?: number;
    /** Largest plausible increase per day as a fraction of the baseline (e.g. 0.25 = 25%/day). Only
     *  applied when a baseline is known, so large accounts can set proportionally larger targets. */
    maxDailyGrowthPct?: number;
}

export interface GoalMetric {
    /** Stable key persisted on goals.metric_key — never rename once shipped. */
    key: string;
    /** Human label shown in the builder dropdown. */
    label: string;
    /** Unit suffix for display, e.g. 'followers', '%'. */
    unit: string;
    /** Where the value comes from: a third-party connection, our own DB, or the user (see MetricSource). */
    source: MetricSource;
    /** For source==='connection': the system_connections.serviceName that must be active (AC1.1.3). */
    connectionService?: string;
    /**
     * For source==='manual' ONLY (required there, meaningless elsewhere): how often we expect the
     * user to enter a fresh figure. Drives the "time to update this" nudge and the staleness window
     * — NOT the 48h connection-staleness rule, which would rot a monthly figure in three days.
     */
    updateCadenceDays?: number;
    /**
     * Offer this metric to EVERY assistant role, not just the ones named in `roles` (and not just the
     * social default). Business outcomes the user reports themselves — revenue, subscriptions — are
     * not owned by any one role, so they are offered everywhere. A role-specific metric must never
     * set this: it exists so a manual metric doesn't need `roles` listing all 27 catalog entries.
     */
    allRoles?: boolean;
    /** Whether progress = value going up or down. */
    direction: MetricDirection;
    /** US-01 AC1.2 — the funnel objective this metric measures (drives the Objective→Metric dropdown). */
    objective: GoalObjective;
    /**
     * roleKeys (db/seed-catalog.ts) this metric is offered to. Omit for the general marketing
     * metrics that apply to any content assistant — those default to the Social Media Manager and
     * the legacy fallback. A metric with `roles` is ONLY shown to assistants of those roles, so an
     * Accounts Receivable Clerk never sees "Instagram Followers" and vice-versa.
     */
    roles?: string[];
    /** One-line helper shown under the dropdown. */
    description: string;
    /**
     * Whether a telemetry poller can actually fetch this metric today.
     *
     * This flag is LOAD-BEARING: `false` removes the metric from every builder dropdown and makes
     * manage-goals reject it. It originally meant "listed but not yet pollable — users can still
     * plan against it", but nothing ever read it, so an unmeasurable metric was fully selectable
     * and the resulting goal just never moved off 'pending'. A goal the platform cannot measure is
     * not a goal, so an unavailable metric is now hidden rather than offered with a caveat.
     */
    available: boolean;
    /** Attainability ceilings (AC: goals must be realistic). Omit to skip the realism check. */
    realism?: MetricRealism;
}

export const GOAL_METRICS: readonly GoalMetric[] = [
    {
        key: 'instagram_followers',
        label: 'Instagram Followers',
        unit: 'followers',
        source: 'connection',
        connectionService: 'instagram',
        direction: 'increase',
        objective: 'awareness',
        description: 'Total follower count on the connected Instagram account.',
        available: true,
        // Even viral organic growth rarely exceeds a few thousand new followers a day.
        realism: { maxDailyDelta: 5000, maxDailyGrowthPct: 0.25 },
    },
    {
        key: 'instagram_engagement_rate',
        label: 'Instagram Engagement Rate',
        unit: '%',
        source: 'connection',
        connectionService: 'instagram',
        direction: 'increase',
        objective: 'engagement',
        description: 'Interactions ÷ reach across recent Instagram posts.',
        available: true,
        // A rate, not a count — it simply can't exceed 100%.
        realism: { maxValue: 100 },
    },
    {
        key: 'instagram_reach',
        label: 'Instagram Reach (30-day)',
        unit: 'accounts',
        source: 'connection',
        connectionService: 'instagram',
        direction: 'increase',
        objective: 'awareness',
        description: 'Unique accounts reached by Instagram posts in the trailing 30 days.',
        available: true,
        realism: { maxDailyDelta: 500000, maxDailyGrowthPct: 0.5 },
    },
    {
        key: 'linkedin_followers',
        label: 'LinkedIn Followers',
        unit: 'followers',
        source: 'connection',
        connectionService: 'linkedin',
        direction: 'increase',
        objective: 'awareness',
        description: 'Total followers of your connected LinkedIn organisation.',
        // ⚠️ NOT MEASURABLE TODAY, and this is a permanent platform limit, not a missing poller.
        // poll-goal-telemetry.ts reads it via /v2/organizationAcls + /v2/networkSizes, both of which
        // need ORGANISATION scopes. We are approved for member-only posting and request exactly
        // `openid profile email w_member_social` (social-oauth-callback.ts), so those calls always
        // 403 — a goal set on this metric sits 'pending' and then rots to 'data_disconnected'.
        // Offering an unmeasurable metric is worse than not offering it: the user sets a goal in good
        // faith and it silently never moves. Flip to true only if organisation scopes are approved.
        available: false,
        // B2B follower growth is steadier than IG, but keep the ceiling generous, not blocking.
        realism: { maxDailyDelta: 5000, maxDailyGrowthPct: 0.25 },
    },
    // ── Facebook ────────────────────────────────────────────────────────────────
    // Facebook was absent from this catalog for no better reason than that nothing filled
    // post_insights for it. The table was designed multi-platform from the start (its `platform`
    // column is documented `instagram | facebook | linkedin | x`), but ingest-instagram-insights.ts
    // was its only writer, so every derived metric could only ever be an Instagram one.
    // ingest-facebook-insights.ts now fills the same table for Page posts.
    {
        key: 'facebook_followers',
        label: 'Facebook Followers',
        unit: 'followers',
        source: 'connection',
        connectionService: 'facebook',
        direction: 'increase',
        objective: 'awareness',
        description: 'Total followers of your connected Facebook Page.',
        // Offered on stronger evidence than a written poller: this EXACT call
        // (`/{page-id}?fields=followers_count,fan_count`) is already made in production by
        // get-follower-counts.ts for the workspace Audience block, on the same Graph token
        // Instagram uses. goal-metric-selftest.ts probes it; flip to false if it reports otherwise.
        available: true,
        realism: { maxDailyDelta: 5000, maxDailyGrowthPct: 0.25 },
    },
    {
        key: 'facebook_reach',
        label: 'Facebook Reach (30-day)',
        unit: 'people',
        source: 'connection',
        connectionService: 'facebook',
        direction: 'increase',
        objective: 'awareness',
        description: 'People who saw your Facebook posts in the trailing 30 days.',
        available: true,
        realism: { maxDailyDelta: 500000, maxDailyGrowthPct: 0.5 },
    },
    {
        key: 'facebook_engagement_rate',
        label: 'Facebook Engagement Rate',
        unit: '%',
        source: 'connection',
        connectionService: 'facebook',
        direction: 'increase',
        objective: 'engagement',
        description: 'Reactions, comments and shares ÷ reach across recent Facebook posts.',
        available: true,
        realism: { maxValue: 100 },
    },
    {
        key: 'facebook_link_clicks',
        label: 'Facebook Link Clicks (30-day)',
        unit: 'clicks',
        source: 'connection',
        connectionService: 'facebook',
        direction: 'increase',
        objective: 'action',
        description: 'Clicks on links in your Facebook posts over the trailing 30 days.',
        // ⚠️ THIS CLOSES THE SOCIAL MEDIA MANAGER'S ACTION-METRIC GAP, which had stood open because
        // Instagram genuinely cannot supply one — ingest-instagram-insights.ts hardcodes
        // `linkClicks: null` with the note "IG organic feed exposes no per-post link clicks", and
        // `search_clicks` measures SEARCH traffic so it is correctly scoped to the blog roles.
        // Facebook Page posts DO expose it (`post_clicks_by_type` → "link clicks"), which is why the
        // Facebook ingester was the highest-value piece of this work rather than a fourth follower
        // count. Note the gate: an SMM only gets an action metric if Facebook is connected.
        available: true,
        realism: { maxDailyDelta: 100000, maxDailyGrowthPct: 0.5 },
    },

    // ── Other connected platforms ───────────────────────────────────────────────
    {
        key: 'youtube_subscribers',
        label: 'YouTube Subscribers',
        unit: 'subscribers',
        source: 'connection',
        // YouTube is a workspace_integrations row (provider 'youtube'), not a system_connections
        // one. manage-goals' connectedServices() unions both stores, so this gates correctly —
        // see the note on search_clicks for the bug that union fixed.
        connectionService: 'youtube',
        direction: 'increase',
        objective: 'awareness',
        description: 'Subscribers on your connected YouTube channel.',
        // Same provenance as facebook_followers: `channels?part=statistics&mine=true` already runs
        // in get-follower-counts.ts. One real caveat the poller handles — a channel can HIDE its
        // subscriber count, in which case the API returns hiddenSubscriberCount and no number, and
        // the goal will sit unmeasured until the channel unhides it.
        available: true,
        realism: { maxDailyDelta: 5000, maxDailyGrowthPct: 0.25 },
    },
    {
        key: 'x_followers',
        label: 'X (Twitter) Followers',
        unit: 'followers',
        source: 'connection',
        connectionService: 'x',
        direction: 'increase',
        objective: 'awareness',
        description: 'Followers of your connected X account.',
        // VERIFIED against the live API on 2026-07-30 — goal-metric-selftest.ts, run on prod org 37
        // with a connected X account, returned `ok` with a real follower count. That settled the one
        // open question: `/2/users/me?user.fields=public_metrics` 403s on API tiers that don't
        // include it, and whether OURS does could not be answered by reading our own source.
        // It does. Shipped false until the probe said otherwise, which is the discipline
        // linkedin_followers taught — re-run the selftest before changing this.
        available: true,
        realism: { maxDailyDelta: 5000, maxDailyGrowthPct: 0.25 },
    },

    {
        key: 'content_published',
        label: 'Content Published',
        unit: 'posts',
        source: 'internal',
        direction: 'increase',
        objective: 'awareness',
        description: 'Posts this assistant has published.',
        available: true,
        // Bounded by posting cadence — dozens a day is already aggressive.
        realism: { maxDailyDelta: 50 },
    },

    // ── Traffic / Action ────────────────────────────────────────────────────────
    // The 'action' objective had ZERO metrics, so "Drive Traffic (Action)" was advertised in
    // GOAL_OBJECTIVES, filtered out by objectivesWithMetrics(), and unreachable — nobody could set a
    // traffic goal at all.
    {
        key: 'search_clicks',
        label: 'Search Clicks',
        unit: 'clicks',
        source: 'connection',
        // Google Search Console lives in workspace_integrations (provider 'searchconsole'), not in
        // system_connections. manage-goals' connectedServices() unions both, so this gates correctly.
        connectionService: 'searchconsole',
        direction: 'increase',
        objective: 'action',
        roles: ['blog_writer', 'seo_content_strategist'],
        description: 'Clicks to your site from Google search results over the last 28 days.',
        // MEASURABLE TODAY, and verifiably so — this is not a new API surface. ingest-gsc-metrics.ts
        // already queries searchAnalytics/query daily in production and reads `impressions` from the
        // response; `clicks` is returned by that SAME call, for every row, with no extra scope and no
        // API-version risk. The poller reuses the identical request shape.
        available: true,
        // Search traffic compounds slowly; keep the ceiling generous but bounded.
        realism: { maxDailyDelta: 20000, maxDailyGrowthPct: 0.5 },
    },
    {
        key: 'instagram_profile_views',
        label: 'Instagram Profile Visits',
        unit: 'visits',
        source: 'connection',
        connectionService: 'instagram',
        direction: 'increase',
        objective: 'action',
        description: 'Times people opened your Instagram profile — the step before they click through.',
        // ⚠️ NOT YET VERIFIED AGAINST THE LIVE API, so deliberately NOT offered.
        //
        // This is the natural traffic metric for a Social Media Manager, and the poller for it is
        // implemented and ready. What is missing is evidence: it needs an account-level Graph call
        // (`{ig-user-id}/insights`) that this codebase has never made — every existing Instagram read
        // is either media-level insights or the `followers_count` field. Meta has churned these
        // account metrics repeatedly (`impressions` was replaced by `views`; `website_clicks` appears
        // to have given way to `profile_links_taps`), and which names a given Graph version accepts
        // cannot be settled by reading our own source.
        //
        // We have been here before: `linkedin_followers` shipped `available: true` on the assumption
        // that a written poller meant a working one, and users set goals that could never move.
        // So: run `netlify/functions/goal-metric-selftest.ts` against a real connected account. It
        // reports exactly which metric names return data. If profile views come back, flip this single
        // flag to true — nothing else needs to change.
        available: false,
        realism: { maxDailyDelta: 100000, maxDailyGrowthPct: 0.5 },
    },

    // ── Non-social role outcomes (objective: 'outcome') ─────────────────────────
    // Counted from assistant_records (db/schema.ts) — the local database each Data Hub role
    // builds as it works. See poll-goal-telemetry.ts for the measurement queries.
    {
        key: 'qualified_leads',
        label: 'Qualified Leads',
        unit: 'leads',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['lead_qualifier'],
        description: 'Leads that converted to a won state in your Be More Swan workspace.',
        available: true,
        realism: { maxDailyDelta: 1000, maxDailyGrowthPct: 1 },
    },
    {
        key: 'leads_scored',
        label: 'Leads Scored',
        unit: 'leads',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['lead_qualifier'],
        description: 'Inbound leads this assistant has researched and scored.',
        available: true,
        realism: { maxDailyDelta: 2000, maxDailyGrowthPct: 1 },
    },
    {
        key: 'records_enriched',
        label: 'Records Enriched',
        unit: 'records',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['crm_enricher'],
        description: 'CRM records this assistant has researched and brought up to date.',
        available: true,
        realism: { maxDailyDelta: 2000, maxDailyGrowthPct: 1 },
    },
    {
        key: 'tickets_resolved',
        label: 'Tickets Resolved',
        unit: 'tickets',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['tier1_support_agent'],
        description: 'Support queries this assistant resolved end-to-end without escalation.',
        available: true,
        realism: { maxDailyDelta: 2000, maxDailyGrowthPct: 1 },
    },
    {
        key: 'meetings_summarized',
        label: 'Meetings Summarised',
        unit: 'meetings',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['meeting_note_taker'],
        description: 'Transcripts and notes this assistant has turned into structured summaries.',
        available: true,
        realism: { maxDailyDelta: 200 },
    },
    {
        key: 'invoices_chased',
        label: 'Invoices Chased',
        unit: 'invoices',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['accounts_receivable_clerk'],
        description: 'Overdue invoices this assistant has followed up on your behalf.',
        available: true,
        realism: { maxDailyDelta: 1000 },
    },
    {
        key: 'cash_recovered',
        label: 'Cash Recovered',
        unit: '£',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['accounts_receivable_clerk'],
        description: 'Value of overdue invoices settled after this assistant chased them.',
        available: true,
        // No sensible daily ceiling on £ recovered — depends entirely on invoice sizes.
        realism: { maxDailyGrowthPct: 5 },
    },
    {
        // Blog Writer's content lives in blog_posts (NOT assistant_records), so this is counted
        // from published blog_posts by poll-goal-telemetry.ts, mirroring 'content_published' for social.
        key: 'posts_published',
        label: 'Posts Published',
        unit: 'posts',
        source: 'internal',
        direction: 'increase',
        objective: 'outcome',
        roles: ['blog_writer'],
        description: 'Long-form blog posts this assistant has drafted, had approved, and published.',
        available: true,
        realism: { maxDailyDelta: 100 },
    },

    // ── User-reported business outcomes (source: 'manual') ──────────────────────
    // The numbers that are the actual point of the business but sit outside every system we can
    // reach. See the MetricSource doc comment for the three behaviours these deliberately do NOT
    // inherit from polled metrics.
    //
    // `available: true` is honest here for a different reason than everywhere else in this file: the
    // measurement is the user, and the user is always connected. The linkedin_followers failure mode
    // (a goal that can never move) cannot occur — the value moves the moment someone types one.
    //
    // ⚠️ Every metric in this block MUST be objective 'outcome'. Manual figures are not attributable
    // to an assistant's output, so one must never be able to satisfy a funnel objective — in
    // particular it must not close the Social Media Manager's open 'action' coverage gap, which is
    // waiting on evidence from goal-metric-selftest.ts, not on a workaround. A test asserts this.
    //
    // ⚠️ Realism ceilings are proportional only (maxDailyGrowthPct, no maxDailyDelta). We have no
    // idea what scale a given business trades at — £500/day is absurd for one and a rounding error
    // for another — and an absolute ceiling here would reject legitimate targets.
    {
        key: 'manual_revenue',
        label: 'Revenue (you report)',
        unit: '£',
        source: 'manual',
        direction: 'increase',
        objective: 'outcome',
        allRoles: true,
        updateCadenceDays: 30,
        description: 'Total revenue for the period, entered by you each month from your own accounts.',
        available: true,
        realism: { maxDailyGrowthPct: 5 },
    },
    {
        key: 'manual_subscriptions',
        label: 'Subscribers (you report)',
        unit: 'subscribers',
        source: 'manual',
        direction: 'increase',
        objective: 'outcome',
        allRoles: true,
        updateCadenceDays: 30,
        description: 'Active paying subscribers, entered by you each month from your billing system.',
        available: true,
        realism: { maxDailyGrowthPct: 5 },
    },
    {
        key: 'manual_enquiries',
        label: 'Enquiries (you report)',
        unit: 'enquiries',
        source: 'manual',
        direction: 'increase',
        objective: 'outcome',
        allRoles: true,
        updateCadenceDays: 7,
        description: 'Inbound enquiries from every channel, entered by you each week.',
        available: true,
        realism: { maxDailyGrowthPct: 5 },
    },
    {
        key: 'manual_bookings',
        label: 'Bookings & Orders (you report)',
        unit: 'bookings',
        source: 'manual',
        direction: 'increase',
        objective: 'outcome',
        allRoles: true,
        updateCadenceDays: 7,
        description: 'Confirmed bookings or orders taken, entered by you each week.',
        available: true,
        realism: { maxDailyGrowthPct: 5 },
    },
];

// Proper-cased display names for the services a metric can be backed by — used in user-facing copy
// (e.g. the "we lost connection to X" alert) so casing like "LinkedIn" survives. Falls back to a
// capitalised serviceName for anything not listed.
const SERVICE_DISPLAY_NAMES: Record<string, string> = {
    instagram: 'Instagram',
    linkedin: 'LinkedIn',
    facebook: 'Facebook',
    x: 'X',
    youtube: 'YouTube',
    threads: 'Threads',
    searchconsole: 'Search Console',
};

/** Proper-cased display name for a connection service, or undefined when none is given. */
export function connectionDisplayName(service: string | null | undefined): string | undefined {
    if (!service) return undefined;
    return SERVICE_DISPLAY_NAMES[service.toLowerCase()] ?? service.replace(/^\w/, c => c.toUpperCase());
}

const METRIC_BY_KEY: ReadonlyMap<string, GoalMetric> = new Map(GOAL_METRICS.map(m => [m.key, m]));

/** Look up a metric definition by its persisted key. */
export function getGoalMetric(key: string): GoalMetric | undefined {
    return METRIC_BY_KEY.get(key);
}

/** True if the metric key is in the catalog. */
export function isValidMetricKey(key: string): boolean {
    return METRIC_BY_KEY.has(key);
}

/** True when a metric's value comes from the user rather than from a poll or a query. */
export function isManualMetric(key: string): boolean {
    return getGoalMetric(key)?.source === 'manual';
}

/**
 * How long a goal's data may go without a fresh point before it counts as stale.
 *
 * Connection- and internal-backed metrics use the 48h AC4.3.2 rule: they refresh on a cron, so two
 * days of nothing means something is broken. A manual metric refreshes when a human remembers, so
 * it gets its own cadence plus a grace period — applying 48h to a monthly revenue figure would flag
 * it on day three, every month, forever.
 */
export const MANUAL_UPDATE_GRACE_DAYS = 7;

export function staleWindowHoursFor(metricKey: string): number {
    const m = getGoalMetric(metricKey);
    if (m?.source !== 'manual') return RUN_RATE_THRESHOLDS.staleDataHours;
    return ((m.updateCadenceDays ?? 30) + MANUAL_UPDATE_GRACE_DAYS) * 24;
}

/**
 * What a stale goal becomes. These are two genuinely different situations and must not share copy:
 * `data_disconnected` is "we lost the connection, go re-authenticate" (critical, and there is
 * nothing the user can type to fix it), while `awaiting_update` is "we're waiting on your number"
 * (informational, and typing one fixes it immediately). Reusing the first for the second would send
 * a red re-authentication alert about an integration that was never connected.
 */
export function staleStatusFor(metricKey: string): GoalStatus {
    return isManualMetric(metricKey) ? 'awaiting_update' : 'data_disconnected';
}

/** When the next manual entry is due, given the last one. Null for non-manual metrics. */
export function nextUpdateDue(metricKey: string, lastEnteredAt: Date | null): Date | null {
    const m = getGoalMetric(metricKey);
    if (m?.source !== 'manual' || !lastEnteredAt) return null;
    return new Date(lastEnteredAt.getTime() + (m.updateCadenceDays ?? 30) * 86_400_000);
}

/**
 * AC1.1.3 — the metrics a workspace may actually pick: internal and manual metrics are always
 * available (we hold the data, or the user does); connection-backed metrics only when that service
 * is currently connected.
 * @param connectedServices lowercased system_connections.serviceName values that are active
 */
export function availableMetricsForConnections(connectedServices: readonly string[]): GoalMetric[] {
    const connected = new Set(connectedServices.map(s => s.toLowerCase()));
    return GOAL_METRICS.filter(m =>
        m.available
        && (m.source !== 'connection' || (m.connectionService != null && connected.has(m.connectionService))),
    );
}

// roleKeys treated as the generic "social content" assistant: the marketing metrics (Instagram /
// LinkedIn / Content Published) are offered to these and to legacy assistants (no roleKey), which
// are all Social Media Managers. Everything else only sees metrics that name its role in `roles`.
const SOCIAL_DEFAULT_ROLES = new Set(['social_media_manager']);

/**
 * The metrics a specific assistant may pick, filtered by BOTH its role and its active connections.
 *   - A metric with `allRoles` is offered to every role (the user-reported business outcomes).
 *   - A metric with `roles` is offered only to assistants of those roles.
 *   - A metric without either is a general marketing metric, offered to the Social Media Manager
 *     and to legacy assistants (roleKey null/unknown → treated as social).
 *   - Connection-backed metrics still require that service to be connected (AC1.1.3).
 */
export function availableMetricsForRole(
    roleKey: string | null | undefined,
    connectedServices: readonly string[],
): GoalMetric[] {
    const connected = new Set(connectedServices.map(s => s.toLowerCase()));
    const isSocialDefault = !roleKey || SOCIAL_DEFAULT_ROLES.has(roleKey);
    return GOAL_METRICS.filter(m => {
        if (!m.available) return false;   // never offer a metric we cannot measure
        const roleOk = m.allRoles ? true : (m.roles ? m.roles.includes(roleKey as string) : isSocialDefault);
        if (!roleOk) return false;
        return m.source !== 'connection' || (m.connectionService != null && connected.has(m.connectionService));
    });
}

/** US-01 AC1.2 — the objectives that actually have at least one measurable metric for this workspace. */
export function objectivesWithMetrics(connectedServices: readonly string[]): GoalObjective[] {
    const have = new Set(availableMetricsForConnections(connectedServices).map(m => m.objective));
    return GOAL_OBJECTIVES.filter(o => have.has(o.key)).map(o => o.key);
}

// US-02 AC2.2–AC2.4 — when an off-track metric is diagnosed, the tactical recommendations are
// steered by the metric's funnel stage. `focus` is the playbook the evaluation model must draw
// from for that stage. SoT here so the playbook stays tunable + testable (never inlined in the
// prompt at the call site).
//
// ⚠️ THIS IS THE ADVISORY PLAYBOOK — read by the DIAGNOSTIC path, where the audience is a human
// strategist reading "your goal is off track, here's what to change". That is why it legitimately
// reaches for calendar-level, format-level and operations-level levers ("pivot to Reels", "run a
// series", "import more source data") — all sensible advice for a person, none of it executable by
// a single drafting call.
//
// Do NOT feed this to a content-generation prompt. Use DRAFTING_FOCUS below. Doing otherwise put
// three unexecutable instructions into every generated post: a format pivot the drafting job cannot
// make (format is fixed before generation from job.post_format), an episodic-series instruction that
// contradicts the anti-repetition variety block, and — for a Blog Writer, whose posts_published
// metric is objective 'outcome' — an instruction to go and import more source data mid-draft.
export interface FunnelDiagnostic {
    /** Human label of the funnel position, e.g. "top of funnel (Awareness)". */
    stage: string;
    /** The tactical levers the recommendations should pull for this stage. */
    focus: readonly string[];
}

export const FUNNEL_DIAGNOSTICS: Record<GoalObjective, FunnelDiagnostic> = {
    // AC2.2 — Awareness (Reach / Impressions / Followers)
    awareness: {
        stage: 'top of funnel (Awareness)',
        focus: [
            'short-form video format pivots (Reels / Shorts)',
            'stronger hook optimisation in the first few seconds',
            'series / episodic content to build return viewership',
            'tighter niche alignment so the content reaches the right audience',
        ],
    },
    // AC2.3 — Interaction (Engagements / Saves / Shares)
    engagement: {
        stage: 'middle of funnel (Interaction)',
        focus: [
            'conversational prompts that invite replies and DMs',
            'utility / educational value (how-tos, tips, saveable posts)',
            'relatable, industry-specific formatting that prompts shares',
        ],
    },
    // AC2.4 — Traffic / Action (Link clicks / Profile visits / Leads)
    action: {
        stage: 'bottom of funnel (Traffic / Action)',
        focus: [
            'clearer call-to-action placement',
            'stronger, more compelling call-to-action wording',
            'lead-magnet promotion to give viewers a reason to click',
        ],
    },
    // Business outcome (non-social roles — invoices chased, tickets resolved, records enriched…).
    // There is no marketing funnel to pull; recovery is about throughput and coverage of the queue.
    outcome: {
        stage: 'business outcome (throughput)',
        focus: [
            'increasing the volume of items worked through the queue',
            'reducing the share of items left unactioned or escalated',
            'importing more source data so the assistant has more to process',
        ],
    },
};

// ── Per-post drafting playbook (the generation-time counterpart) ─────────────────
//
// What a SINGLE drafting call can actually change. Every item here has to pass three tests, because
// each was failed by at least one FUNNEL_DIAGNOSTICS item when that map was briefly used here:
//
//   1. The drafting model CONTROLS it. Format is not a lever — process-content-jobs.ts fixes it from
//      job.post_format / answers.preferred_format and states it flatly ("This is an IMAGE post"), so
//      "pivot to Reels" is an instruction the same prompt forbids.
//   2. It applies to ONE post. "Run an episodic series" spans a calendar, and it contradicts the
//      variety block's "do NOT reuse the opening hook, core premise, or overall structure".
//   3. It cannot be satisfied by INVENTING something. "Promote a lead magnet" presumes one exists;
//      with no lead magnet the model makes one up, and the anti-fabrication rule in
//      content-quality.ts covers invented STATISTICS only — not an invented free guide.
//
// Wording is imperative and post-scoped so it reads as a directive, not as strategy advice.
export const DRAFTING_FOCUS: Record<GoalObjective, readonly string[]> = {
    // Reach / impressions / followers. Levers that survive: relevance and specificity of the hook
    // and the angle. Format and cadence are decided elsewhere, so they are deliberately absent.
    awareness: [
        'open with a specific, concrete hook rather than a general statement — the first line decides whether the rest is read',
        'aim the post squarely at the target audience\'s own words and problems, not at a general audience',
        'make the angle distinctive enough to be worth sharing onward to someone who does not follow this account yet',
    ],
    // Saves / shares / comments / DMs. This set came through the review unchanged — every item is
    // already post-scoped and executable.
    engagement: [
        'invite a genuine reply — ask something specific the audience actually has an opinion about',
        'give practical, self-contained value the reader would save to come back to (a how-to, a checklist, a concrete tip)',
        'frame it so the reader recognises their own situation and wants to send it to a colleague',
    ],
    // Link clicks / profile visits / leads. CTA levers stay; lead-magnet promotion is gone — see
    // test 3 above. The last item is what replaces it safely.
    action: [
        'end on ONE unambiguous call to action, not a list of options',
        'word the call to action around what the reader gets, not what the business wants',
        'point only at something that genuinely exists in the provided business context — never invent an offer, guide, discount or download to click toward',
    ],
    // Non-marketing roles (Blog Writer's posts_published is the one that reaches a drafting prompt).
    // The advisory version of this was pure operations advice aimed at the USER, which is meaningless
    // mid-draft; these are the equivalent levers a drafting call actually holds.
    outcome: [
        'keep the piece tightly scoped and finishable rather than sprawling — a complete, publishable draft beats an ambitious unfinished one',
        'lead with the single most useful thing the reader came for',
        'stay strictly within the provided business context; where information is missing, write around the gap rather than filling it with invention',
    ],
};

/**
 * The per-post drafting levers for the metric a goal tracks (generation-time; see DRAFTING_FOCUS).
 *
 * Returns nothing for a MANUAL metric, and that is the point: a single post cannot be told how to
 * move revenue. The 'outcome' levers exist for Blog Writer's posts_published — an objective the
 * assistant genuinely owns — and handing them to a revenue goal would tell the model its draft is
 * the thing that closes sales. Manual goals reach the prompt as context instead (goal-directive.ts).
 */
export function draftingFocusFor(metricKey: string): readonly string[] {
    const m = getGoalMetric(metricKey);
    if (!m || m.source === 'manual') return [];
    return DRAFTING_FOCUS[m.objective];
}

/** US-02 — the funnel diagnostic playbook for the metric a goal tracks. */
export function funnelDiagnosticFor(metricKey: string): FunnelDiagnostic | undefined {
    const m = getGoalMetric(metricKey);
    return m ? FUNNEL_DIAGNOSTICS[m.objective] : undefined;
}

// ── Goal attainability (the "A" in SMART) ───────────────────────────────────────
// Rejects clearly-impossible targets up front (e.g. "+10,000,000 followers in 1 day"). Pure and
// deterministic so it runs identically on the server (manage-goals create/update) and can be unit
// tested. Baseline (the current value) is optional: when known we also allow proportional growth
// for large accounts; when unknown we assume 0 (the conservative choice — it only ever blocks
// targets that are impossible even starting from nothing).
export interface RealismVerdict {
    ok: boolean;
    /** User-facing explanation of why the target is unrealistic. */
    reason?: string;
    /** A concrete, attainable alternative the UI can suggest. */
    suggestion?: string;
    /** The largest target that would pass for the chosen date (for prefilling a fix). */
    attainableTarget?: number;
}

const fmtNum = (n: number) => Math.round(n).toLocaleString('en-GB');
const unitSuffix = (m: GoalMetric) => (m.unit === '%' ? '%' : ` ${m.unit}`);

export function assessGoalRealism(args: {
    metricKey: string;
    targetValue: number;
    targetDate: Date | string;
    baseline?: number | null;
    now?: Date;
}): RealismVerdict {
    const metric = getGoalMetric(args.metricKey);
    if (!metric?.realism) return { ok: true };
    const r = metric.realism;
    const target = Number(args.targetValue);
    const due = new Date(args.targetDate);
    const now = args.now ?? new Date();
    // Leave shape/positivity/future-date validation to the dedicated validators.
    if (!Number.isFinite(target) || Number.isNaN(due.getTime())) return { ok: true };

    // 1. Hard ceiling on the value itself (e.g. an engagement RATE can't exceed 100%).
    if (r.maxValue != null && target > r.maxValue) {
        return {
            ok: false,
            reason: `${metric.label} can't exceed ${fmtNum(r.maxValue)}${unitSuffix(metric)}.`,
            suggestion: `Set a target at or below ${fmtNum(r.maxValue)}${unitSuffix(metric)}.`,
            attainableTarget: r.maxValue,
        };
    }

    // 2. Run-rate sanity for count metrics: the required gain per day must be plausible.
    if (r.maxDailyDelta != null) {
        const days = Math.max(1, Math.ceil((due.getTime() - now.getTime()) / 86_400_000));
        const baseline = (args.baseline != null && Number.isFinite(args.baseline)) ? Number(args.baseline) : null;
        const required = (baseline != null ? target - baseline : target);
        if (required <= 0) return { ok: true }; // already met, or not a growth target — not our concern
        const requiredDaily = required / days;
        const allowedDaily = Math.max(
            r.maxDailyDelta,
            (baseline != null && r.maxDailyGrowthPct) ? baseline * r.maxDailyGrowthPct : 0,
        );
        if (requiredDaily > allowedDaily) {
            const attainable = Math.floor((baseline ?? 0) + allowedDaily * days);
            return {
                ok: false,
                reason: `That target needs about ${fmtNum(requiredDaily)} ${metric.unit} per day — beyond what's realistically attainable.`,
                suggestion: `Try about ${fmtNum(attainable)} ${metric.unit} by that date, or keep ${fmtNum(target)} ${metric.unit} and pick a later date.`,
                attainableTarget: attainable,
            };
        }
    }

    return { ok: true };
}

// ── Goal status model (AC1.2.3 / AC4.3.2) ───────────────────────────────────────
// Phase 1 only persists 'pending' (no telemetry yet); the run-rate engine in Phase 2 assigns the
// rest. Thresholds live here so they stay tunable without touching the engine.
//
// `awaiting_update` is the manual-metric counterpart of `data_disconnected`: the figure is overdue
// and the user is the only one who can supply it. Kept separate because the two need opposite
// treatment everywhere — copy ("we lost connection" vs "time to update your number"), notification
// severity (critical_action vs informational), and the autonomous optimizer (which must not read
// either as a signal that the CONTENT is failing).
export type GoalStatus = 'pending' | 'on_track' | 'at_risk' | 'off_track' | 'data_disconnected' | 'awaiting_update';

export const GOAL_STATUSES: readonly GoalStatus[] = [
    'pending', 'on_track', 'at_risk', 'off_track', 'data_disconnected', 'awaiting_update',
];

export const RUN_RATE_THRESHOLDS = {
    /** actual ÷ required run-rate at or above this = on_track. */
    onTrack: 0.9,
    /** between offTrack and onTrack = at_risk; below offTrack = off_track. */
    offTrack: 0.7,
    /** hours without fresh telemetry before the goal flips to data_disconnected (AC4.3.2). */
    staleDataHours: 48,
    /** a goal younger than this many days stays 'pending' — too little signal to judge a trend. */
    minObservationDays: 1,
} as const;

// AC4.1.1 — polling cadence by subscription tier. The cron runs hourly; each goal is polled
// at most once per its tier's cadence. Higher tiers get near-real-time tracking.
//
// ⚠️ TIER KEYS READ BACKWARDS — the ordering is `saver` (£29, entry) → `buster` (£99) →
// `employee` (£349) → `enterprise`. See db/seed.ts. The previous version of this block was written
// against a dead price list ("buster=£20, saver=£50, employee=£100") and so gave the £29 ENTRY plan
// hourly telemetry while the £99 plan got daily. Always derive gates from the seed ordering, never
// from a remembered price. Entry tier gets daily; paid-up tiers get hourly.
export const POLL_CADENCE_HOURS_BY_TIER: Record<string, number> = {
    enterprise: 1,
    employee: 1,
    buster: 1,
    saver: 24,
};
export const DEFAULT_POLL_CADENCE_HOURS = 24;

export function pollCadenceHours(tierKey: string | null | undefined): number {
    return (tierKey && POLL_CADENCE_HOURS_BY_TIER[tierKey]) || DEFAULT_POLL_CADENCE_HOURS;
}

// Feature 3 (premium AI) tier gates — AI recommendations + magic-wand rewrite (US3.1/3.2) and
// autonomous optimization (US3.3). `saver` (£29 entry) is the base tier and gets the padlock →
// upgrade modal (AC3.1.1); everything above it unlocks.
//
// ⚠️ These gates were inverted, and the inversion contradicted our own sales copy: db/seed.ts
// sells `buster` (£99) on "autonomous goal tracking, advanced analytics" while this map locked
// `buster` OUT of all three features and handed them to the £29 plan instead. If a tier is added,
// add it here explicitly — and check what master_plans.description promises it.
export type GoalAiFeature = 'recommendations' | 'magicWand' | 'autonomous';
export const GOAL_AI_TIERS: Record<GoalAiFeature, readonly string[]> = {
    recommendations: ['buster', 'employee', 'enterprise'],
    magicWand:       ['buster', 'employee', 'enterprise'],
    autonomous:      ['buster', 'employee', 'enterprise'],
};

export function tierAllows(feature: GoalAiFeature, tierKey: string | null | undefined): boolean {
    return !!tierKey && GOAL_AI_TIERS[feature].includes(tierKey);
}

// The "soft" brief fields the Magic Wand (US3.2) may rewrite. These are free-text fields in
// aiAssistants.onboardingContext that feed content generation (see assemble-blueprint.ts); hard
// rules / guardrails are deliberately excluded. onboardingContext key → display label.
export const TUNABLE_BRIEF_FIELDS: Record<string, string> = {
    tone_of_voice: 'Brand Voice',
    target_audience: 'Target Audience',
    content_pillars: 'Content Strategy',
};

// US-03 One-Click Fix — a single changed strategy field, ready for the side-by-side diff.
export interface StrategyFieldChange {
    /** onboardingContext key, e.g. 'tone_of_voice'. */
    field: string;
    /** Display label, e.g. 'Brand Voice'. */
    label: string;
    /** The current brief text (trimmed; '' when unset). */
    current: string;
    /** The AI-suggested replacement (trimmed). */
    suggested: string;
}

/**
 * US-03 AC3.3/AC3.4 — diff the current strategy fields against an AI-suggested set, returning only
 * the TUNABLE_BRIEF_FIELDS that genuinely changed (a non-empty suggestion that differs from the
 * current text). Unchanged fields have nothing to diff and nothing to apply, so they're dropped.
 * Pure + deterministic so the One-Click Fix behaviour is locked by tests, not the live model.
 */
export function strategyChanges(
    current: Record<string, string | null | undefined>,
    suggested: Record<string, unknown> | null | undefined,
): StrategyFieldChange[] {
    return Object.keys(TUNABLE_BRIEF_FIELDS)
        .map(k => ({
            field: k,
            label: TUNABLE_BRIEF_FIELDS[k],
            current: String(current?.[k] ?? '').trim(),
            suggested: String(suggested?.[k] ?? '').trim(),
        }))
        .filter(c => c.suggested && c.suggested !== c.current);
}

// Fields a user may rewrite with the Magic Wand on the assistant detail page. This is the
// strategy set PLUS the foundational message/problem fields. Kept separate from
// AUTONOMOUS_TUNABLE_FIELDS so autonomous mode never auto-edits the core message or bottleneck —
// those stay user-driven and are only ever rewritten on an explicit wand click.
export const WAND_REWRITABLE_FIELDS: Record<string, string> = {
    ...TUNABLE_BRIEF_FIELDS,
    core_message: 'Core Message',
    problem_statement: 'Your Bottleneck',
    service_offerings: 'Products & Services',
};

// Fields Autonomous mode (US3.3) may auto-adjust: the Magic Wand set PLUS posting frequency.
// posting_frequency is a free-text cadence directive in the brief (e.g. "3 times a week") — the
// content worker interprets it, so it's safe to tune as text, not a hard scheduler flip.
export const AUTONOMOUS_TUNABLE_FIELDS: Record<string, string> = {
    ...TUNABLE_BRIEF_FIELDS,
    posting_frequency: 'Posting Frequency',
};
