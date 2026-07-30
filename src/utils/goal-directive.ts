// src/utils/goal-directive.ts
//
// SMART Goals → content generation. The seam that makes a goal actually DO something.
//
// WHY THIS EXISTS: goals shipped with a metric catalog, a run-rate engine, three crons, a Goals tab
// and an autonomous optimizer — and zero connection to generation. `grep -i goal` over
// assemble-blueprint.ts / process-content-jobs.ts / blog-generate.ts returned nothing, so a user
// could set "reach 20,000 Instagram followers by December", watch the progress bar move, and every
// generated post would be byte-for-byte identical to having no goal at all. The goal was a
// dashboard ornament.
//
// This module is PURE (no I/O, no db, no model calls) so the steering behaviour is locked by tests
// rather than by whatever the live model happens to do. Callers load goals, call
// buildGoalDirective(), and splice the returned string into their prompt.
//
// Two consumers, deliberately duplicated at the call site: social generation
// (process-content-jobs.ts) and blog generation (blog-generate.ts) have SEPARATE generation seams,
// so an injection added to one does NOT reach the other. Adding a third content role means adding a
// third call — see [[inspo-tab-build]].

import {
    getGoalMetric,
    funnelDiagnosticFor,
    type GoalObjective,
    type GoalStatus,
} from '../config/goal-metrics';

/** A goal as the directive builder needs it — the persisted row, narrowed and already numeric. */
export interface DirectiveGoal {
    metricKey: string;
    /** SMART "Specific": user-authored short name. Optional (nullable column). */
    title?: string | null;
    /** SMART "Specific": the user's own reason the goal matters. Optional (nullable column). */
    rationale?: string | null;
    targetValue: number;
    latestValue?: number | null;
    targetDate: Date;
    status: GoalStatus;
    isPrimary: boolean;
}

/** The blueprint-section shape (section 12) and the input to `renderGoalDirective`. */
export interface GoalDirective {
    /** The primary goal first, then the rest — the order the model reads them in. */
    goals: Array<{
        label: string;
        metricKey: string;
        objective: GoalObjective;
        title: string | null;
        rationale: string | null;
        target: number;
        /**
         * Progress toward target as a percentage, DELIBERATELY COARSE (nearest 10%).
         *
         * The raw `latestValue` is not carried. Blueprint rows are de-duplicated by section CONTENT
         * (src/utils/blueprint.ts), so a fast-moving number in here would make every unrelated
         * recompile trigger — the profile autosave on a 1.2s debounce, a content-rule edit, a post
         * rejection — produce a brand-new blueprint row just because a follower count ticked by 3.
         * Rounding to 10% conveys the distance the model actually needs ("about 40% of the way")
         * while changing rarely enough that dedup keeps working.
         */
        progressPct: number | null;
        unit: string;
        targetDate: string;
        daysRemaining: number;
        status: GoalStatus;
        isPrimary: boolean;
    }>;
    /** Funnel stage of the PRIMARY goal — the tactical playbook the model should pull from. */
    stage: string | null;
    /** The specific levers for that stage (from FUNNEL_DIAGNOSTICS). */
    focus: readonly string[];
    /** True when the primary goal is at_risk/off_track — the model is told to lean harder. */
    urgent: boolean;
}

const DAY_MS = 86_400_000;

const fmt = (n: number): string =>
    Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { maximumFractionDigits: 2 });

/** Statuses that mean "the current approach is not working" → escalate the directive's firmness. */
const URGENT_STATUSES: readonly GoalStatus[] = ['at_risk', 'off_track'];

/**
 * Progress toward target as a percentage rounded to the nearest 10 — see `progressPct` above for
 * why the raw value is deliberately discarded. Null when there is no telemetry yet, or when the
 * target is 0 (nothing meaningful to express as a fraction of it).
 */
function coarseProgressPct(latest: number | null | undefined, target: number): number | null {
    if (latest == null || !Number.isFinite(latest) || target === 0) return null;
    const pct = (latest / target) * 100;
    return Math.max(0, Math.min(100, Math.round(pct / 10) * 10));
}

/**
 * Build the structured directive from an assistant's active goals.
 *
 * Only goals whose metric is still in the catalog are included — a metric that was retired (or
 * turned out to be unmeasurable, like `linkedin_followers`) must not steer generation, because the
 * status attached to it is meaningless. Returns null when there is nothing to say, so callers can
 * omit the block entirely rather than emitting an empty "GOALS:" header the model has to interpret.
 */
export function buildGoalDirective(goals: readonly DirectiveGoal[], now: Date = new Date()): GoalDirective | null {
    // Primary first; the model weights earlier instructions more heavily, and a single clear
    // objective steers better than a flat list of five.
    const ordered = [...goals]
        .filter(g => getGoalMetric(g.metricKey) != null)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

    if (ordered.length === 0) return null;

    const rendered = ordered.map(g => {
        const metric = getGoalMetric(g.metricKey)!;
        return {
            label: metric.label,
            metricKey: g.metricKey,
            objective: metric.objective,
            title: g.title?.trim() || null,
            rationale: g.rationale?.trim() || null,
            target: g.targetValue,
            progressPct: coarseProgressPct(g.latestValue, g.targetValue),
            unit: metric.unit,
            targetDate: g.targetDate.toISOString().slice(0, 10),
            // Negative when the deadline has passed; the renderer says "overdue" rather than "-3 days".
            daysRemaining: Math.ceil((g.targetDate.getTime() - now.getTime()) / DAY_MS),
            status: g.status,
            isPrimary: g.isPrimary,
        };
    });

    const primary = ordered[0];
    const diagnostic = funnelDiagnosticFor(primary.metricKey);

    return {
        goals: rendered,
        stage: diagnostic?.stage ?? null,
        focus: diagnostic?.focus ?? [],
        urgent: URGENT_STATUSES.includes(primary.status),
    };
}

/**
 * Serialise the directive into the prompt block.
 *
 * Deliberately framed as STEERING, not as a guardrail: it biases topic, format, hook and CTA toward
 * the goal's funnel stage, and it never overrides content rules, brand knowledge or the compliance
 * disclosure. Those are strict rules elsewhere in the brief and a goal must not be able to argue
 * with them — an off-track follower target is not a licence to ignore a prohibited-claims rule.
 */
export function renderGoalDirective(d: GoalDirective | null): string {
    if (!d) return '';

    const lines: string[] = ['ACTIVE BUSINESS GOALS — steer this content toward them:'];

    for (const g of d.goals) {
        const name = g.title ? `"${g.title}" — ` : '';
        const unit = g.unit === '%' ? '%' : ` ${g.unit}`;
        const progress = g.progressPct != null
            ? `target ${fmt(g.target)}${unit} (roughly ${g.progressPct}% of the way there)`
            : `target ${fmt(g.target)}${unit}`;
        const when = g.daysRemaining >= 0
            ? `${g.daysRemaining} day${g.daysRemaining === 1 ? '' : 's'} remaining`
            : `deadline passed ${Math.abs(g.daysRemaining)} day${Math.abs(g.daysRemaining) === 1 ? '' : 's'} ago`;
        const tag = g.isPrimary ? '[PRIMARY] ' : '';
        lines.push(`- ${tag}${name}${g.label}: ${progress} by ${g.targetDate} (${when}; status: ${g.status})`);
        // The rationale is the highest-value line in this block — it is the only place the model
        // learns WHY the number matters, which is what lets it choose a relevant topic.
        if (g.rationale) lines.push(`  Why this matters: ${g.rationale}`);
    }

    if (d.stage) {
        lines.push('', `The primary goal sits at the ${d.stage}. Favour these tactics:`);
        for (const f of d.focus) lines.push(`- ${f}`);
    }

    if (d.urgent) {
        lines.push(
            '',
            'This goal is NOT on track. Apply the tactics above decisively in this post rather than ' +
            'playing it safe — a stronger hook, a clearer single call to action, and a format suited ' +
            'to the stage above.',
        );
    }

    lines.push(
        '',
        'These goals steer WHAT you talk about and HOW you frame the call to action. They never ' +
        'override the content rules, business knowledge, or required disclosure above — if a goal ' +
        'would require breaking one of those, follow the rule and pursue the goal another way. ' +
        'Never mention the goal, its numbers, or its status in the content itself.',
    );

    return lines.join('\n');
}

/** Convenience: load-shaped goals → prompt block in one call. Returns '' when there are no goals. */
export function goalPromptBlock(goals: readonly DirectiveGoal[], now?: Date): string {
    return renderGoalDirective(buildGoalDirective(goals, now));
}
