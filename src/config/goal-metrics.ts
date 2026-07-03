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

export type MetricSource = 'connection' | 'internal';
export type MetricDirection = 'increase' | 'decrease';

// US-01 AC1.1/AC1.2 — the funnel objective a metric serves. The Goal Builder shows an Objective
// dropdown first, then populates the Metric dropdown with the metrics for the chosen objective.
//   awareness  → top of funnel  (Followers, Reach, Impressions…)
//   engagement → middle         (Engagement rate, Saves, Shares…)
//   action     → bottom         (Leads, Link clicks, Profile visits…)
export type GoalObjective = 'awareness' | 'engagement' | 'action';

export interface GoalObjectiveDef { key: GoalObjective; label: string; }

export const GOAL_OBJECTIVES: readonly GoalObjectiveDef[] = [
    { key: 'awareness',  label: 'Grow my Audience (Awareness)' },
    { key: 'engagement', label: 'Increase Interaction (Engagement)' },
    { key: 'action',     label: 'Drive Traffic (Action)' },
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
    /** Where the value comes from: a third-party connection, or our own DB. */
    source: MetricSource;
    /** For source==='connection': the system_connections.serviceName that must be active (AC1.1.3). */
    connectionService?: string;
    /** Whether progress = value going up or down. */
    direction: MetricDirection;
    /** US-01 AC1.2 — the funnel objective this metric measures (drives the Objective→Metric dropdown). */
    objective: GoalObjective;
    /** One-line helper shown under the dropdown. */
    description: string;
    /**
     * Whether a Phase-2 telemetry poller can actually fetch this yet. Listed-but-not-yet-pollable
     * metrics still appear (so users can plan) but newly-created goals stay 'pending' until a poller
     * lands. Everything in v1 is wired to an existing data path, so all are true.
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
        available: true,
        // B2B follower growth is steadier than IG, but keep the ceiling generous, not blocking.
        realism: { maxDailyDelta: 5000, maxDailyGrowthPct: 0.25 },
    },
    {
        key: 'qualified_leads',
        label: 'Qualified Leads',
        unit: 'leads',
        source: 'internal',
        direction: 'increase',
        objective: 'action',
        description: 'Qualified leads captured in your Be More Swan workspace.',
        available: true,
        realism: { maxDailyDelta: 1000, maxDailyGrowthPct: 1 },
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
];

// Proper-cased display names for the services a metric can be backed by — used in user-facing copy
// (e.g. the "we lost connection to X" alert) so casing like "LinkedIn" survives. Falls back to a
// capitalised serviceName for anything not listed.
const SERVICE_DISPLAY_NAMES: Record<string, string> = {
    instagram: 'Instagram',
    linkedin: 'LinkedIn',
    facebook: 'Facebook',
    x: 'X',
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

/**
 * AC1.1.3 — the metrics a workspace may actually pick: internal metrics are always available;
 * connection-backed metrics only when that service is currently connected.
 * @param connectedServices lowercased system_connections.serviceName values that are active
 */
export function availableMetricsForConnections(connectedServices: readonly string[]): GoalMetric[] {
    const connected = new Set(connectedServices.map(s => s.toLowerCase()));
    return GOAL_METRICS.filter(m =>
        m.source === 'internal' || (m.connectionService != null && connected.has(m.connectionService)),
    );
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
};

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
export type GoalStatus = 'pending' | 'on_track' | 'at_risk' | 'off_track' | 'data_disconnected';

export const GOAL_STATUSES: readonly GoalStatus[] = [
    'pending', 'on_track', 'at_risk', 'off_track', 'data_disconnected',
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
// Tier prices: trial=free, buster=£20, saver=£50, employee=£100 → saver+employee are the
// premium tiers that get hourly telemetry; trial+buster get daily.
export const POLL_CADENCE_HOURS_BY_TIER: Record<string, number> = {
    employee: 1,
    saver: 1,
    buster: 24,
    trial: 24,
};
export const DEFAULT_POLL_CADENCE_HOURS = 24;

export function pollCadenceHours(tierKey: string | null | undefined): number {
    return (tierKey && POLL_CADENCE_HOURS_BY_TIER[tierKey]) || DEFAULT_POLL_CADENCE_HOURS;
}

// Feature 3 (premium AI) tier gates. saver+employee unlock AI recommendations + magic-wand
// rewrite (US3.1/3.2) and autonomous optimization (US3.3); buster/trial are base tier and get
// the padlock → upgrade modal (AC3.1.1). Editable here as the gating SoT.
export type GoalAiFeature = 'recommendations' | 'magicWand' | 'autonomous';
export const GOAL_AI_TIERS: Record<GoalAiFeature, readonly string[]> = {
    recommendations: ['saver', 'employee'],
    magicWand:       ['saver', 'employee'],
    autonomous:      ['saver', 'employee'],
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
