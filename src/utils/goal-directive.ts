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
// NOT EVERY GOAL IS A TARGET. Goals on user-reported metrics (revenue, subscriptions — see
// MetricSource in goal-metrics.ts) are carried in `context`, not `goals`: the model is told what the
// business is trying to achieve, and told explicitly not to chase it, because no single post moves
// revenue and a model asked to move one anyway will invent an offer to do it with.
//
// Two consumers, deliberately duplicated at the call site: social generation
// (process-content-jobs.ts) and blog generation (blog-generate.ts) have SEPARATE generation seams,
// so an injection added to one does NOT reach the other. Adding a third content role means adding a
// third call — see [[inspo-tab-build]].

import {
    getGoalMetric,
    funnelDiagnosticFor,
    draftingFocusFor,
    isManualMetric,
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

/** One goal as it appears in the prompt. Shared by the steerable and the context lists. */
export interface RenderedGoal {
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
}

/** The blueprint-section shape (section 12) and the input to `renderGoalDirective`. */
export interface GoalDirective {
    /**
     * The goals this assistant's own output can move: the primary first, then the rest — the order
     * the model reads them in. User-reported metrics are NOT here; they are in `context`.
     */
    goals: RenderedGoal[];
    /**
     * User-reported goals (`source: 'manual'` — revenue, subscriptions, bookings). Present so the
     * model understands what the business is actually trying to achieve, and DELIBERATELY SEPARATE
     * so it is never told to hit them.
     *
     * A drafting call cannot move revenue. DRAFTING_FOCUS holds no lever for it — draftingFocusFor()
     * returns nothing for a manual metric on purpose — and a model instructed to chase a number it
     * has no honest route to reaches for the dishonest ones: an invented offer, a discount nobody
     * authorised, a claim about results. What these goals genuinely contribute is the `rationale`,
     * which is the one line that tells the model WHY the business cares, and that is worth having.
     */
    context: RenderedGoal[];
    /** Funnel stage of the PRIMARY steerable goal — labels the playbook the model should pull from. */
    stage: string | null;
    /**
     * The per-post levers for that stage, from DRAFTING_FOCUS — NOT from FUNNEL_DIAGNOSTICS.
     * The advisory playbook is written for a human strategist and contains calendar-, format- and
     * operations-level advice a single drafting call cannot act on. See DRAFTING_FOCUS for the three
     * tests every item here has to pass.
     */
    focus: readonly string[];
    /** True when the primary goal is at_risk/off_track — the model is told to lean harder. */
    urgent: boolean;
}

const DAY_MS = 86_400_000;

const fmt = (n: number): string =>
    Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { maximumFractionDigits: 2 });

/**
 * Value + unit, written the way a person would write it. Currency prefixes, percentages suffix
 * tight, everything else takes a space. The user-reported metrics made this matter: a revenue
 * target read "250,000 £" to the model, which is not a figure anyone writes.
 */
const withUnit = (n: number, unit: string): string => {
    if (unit === '%') return `${fmt(n)}%`;
    if (/^[£$€]$/.test(unit)) return `${unit}${fmt(n)}`;
    return `${fmt(n)} ${unit}`;
};

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

    const render = (g: DirectiveGoal): RenderedGoal => {
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
    };

    // Split by whether this assistant's output is what moves the number. Everything downstream —
    // which goal sets the funnel stage, which levers are offered, whether the directive escalates —
    // is derived from the STEERABLE list only. See GoalDirective.context.
    const steerable = ordered.filter(g => !isManualMetric(g.metricKey));
    const contextOnly = ordered.filter(g => isManualMetric(g.metricKey));

    // The primary for steering purposes is the first goal we can actually act on. A manual goal can
    // never be isPrimary (manage-goals rejects it), but this must not depend on that: a legacy row,
    // a direct DB edit or a metric later reclassified as manual would otherwise hand the funnel
    // stage and the urgency escalation to a goal with no levers behind it.
    const primary = steerable[0] ?? null;

    return {
        goals: steerable.map(render),
        context: contextOnly.map(render),
        // The stage LABEL comes from the advisory map (it is just a name for the funnel position),
        // but the levers come from DRAFTING_FOCUS — see the `focus` doc comment.
        stage: primary ? (funnelDiagnosticFor(primary.metricKey)?.stage ?? null) : null,
        focus: primary ? draftingFocusFor(primary.metricKey) : [],
        // Only a goal the content owns can make the directive lean harder. A revenue goal slipping
        // is not evidence that this post should be written more aggressively.
        urgent: primary ? URGENT_STATUSES.includes(primary.status) : false,
    };
}

/**
 * Serialise the directive into the prompt block.
 *
 * Deliberately framed as STEERING, not as a guardrail: it biases topic, angle, hook and CTA toward
 * the goal's funnel stage, and it never overrides content rules, brand knowledge or the compliance
 * disclosure. Those are strict rules elsewhere in the brief and a goal must not be able to argue
 * with them — an off-track follower target is not a licence to ignore a prohibited-claims rule.
 * (It does not bias FORMAT: format is fixed before generation, so an instruction to change it would
 * contradict the prompt's own "This is an IMAGE post" line.)
 *
 * MEANS-NOT-ENDS RECONCILIATION. CONTENT_QUALITY_STANDARDS says "Do NOT optimise for Likes or
 * follower count. Meaningful engagement (saves, shares, comments, DMs) is the goal." A follower or
 * reach goal says the literal opposite, and — because the standards are appended AFTER this block in
 * process-content-jobs.ts — the contradiction lands later in the prompt and would partly cancel the
 * goal out. Rather than weakening either side, the block below tells the model HOW the two fit
 * together: the target is legitimate, and the route to it is real value, never engagement bait or a
 * vanity format. That keeps the standards' actual intent (no cheap tactics) intact while honouring
 * what the user explicitly asked for.
 */
export function renderGoalDirective(d: GoalDirective | null): string {
    if (!d) return '';
    if (!d.goals.length && !d.context.length) return '';

    const goalLine = (g: RenderedGoal, opts: { statusSuffix: boolean }): string[] => {
        const out: string[] = [];
        const name = g.title ? `"${g.title}" — ` : '';
        const value = withUnit(g.target, g.unit);
        const progress = g.progressPct != null
            ? `target ${value} (roughly ${g.progressPct}% of the way there)`
            : `target ${value}`;
        const when = g.daysRemaining >= 0
            ? `${g.daysRemaining} day${g.daysRemaining === 1 ? '' : 's'} remaining`
            : `deadline passed ${Math.abs(g.daysRemaining)} day${Math.abs(g.daysRemaining) === 1 ? '' : 's'} ago`;
        const tag = g.isPrimary ? '[PRIMARY] ' : '';
        const tail = opts.statusSuffix ? `${when}; status: ${g.status}` : when;
        out.push(`- ${tag}${name}${g.label}: ${progress} by ${g.targetDate} (${tail})`);
        // The rationale is the highest-value line in this block — it is the only place the model
        // learns WHY the number matters, which is what lets it choose a relevant topic.
        if (g.rationale) out.push(`  Why this matters: ${g.rationale}`);
        return out;
    };

    const lines: string[] = [];

    if (d.goals.length) {
        lines.push('ACTIVE BUSINESS GOALS — steer this content toward them:');
        for (const g of d.goals) lines.push(...goalLine(g, { statusSuffix: true }));
    }

    // User-reported goals, kept visibly apart from the steerable ones. The status is omitted on
    // purpose: 'awaiting_update' means the user hasn't typed this month's figure in yet, which says
    // nothing whatsoever about the content and would read to the model as a problem to fix.
    if (d.context.length) {
        if (lines.length) lines.push('');
        lines.push(
            'BUSINESS CONTEXT — targets the business tracks by hand, which this assistant\'s work does ' +
            'NOT directly move:',
        );
        for (const g of d.context) lines.push(...goalLine(g, { statusSuffix: false }));
        lines.push(
            'Use these only to understand what the business is trying to achieve, and let that inform ' +
            'which topics and angles are worth its audience\'s attention. They are NOT a target for ' +
            'this post: do not try to drive them directly, do not promise or imply results against ' +
            'them, and never invent an offer, discount, guarantee or claim in pursuit of them.',
        );
    }

    if (d.stage && d.focus.length) {
        lines.push('', `The primary goal sits at the ${d.stage}. In THIS post:`);
        for (const f of d.focus) lines.push(`- ${f}`);
    }

    if (d.urgent) {
        lines.push(
            '',
            'This goal is NOT on track. Apply the points above decisively in this post rather than ' +
            'playing it safe — a more specific hook and one clearer call to action. Do not compensate ' +
            'by reaching for engagement bait, outrage, false urgency or clickbait.',
        );
    }

    // The means-not-ends reconciliation only makes sense when there is something to pursue. With
    // only user-reported goals present, "HOW to pursue these goals" would directly contradict the
    // "NOT a target for this post" instruction three lines above it.
    if (d.goals.length) {
        lines.push(
            '',
            // Reconciles this block with CONTENT_QUALITY_STANDARDS' "do NOT optimise for follower count".
            // Named explicitly so the model treats the two as one instruction, not as a conflict to pick
            // a side in — see the means-not-ends note in this function's doc comment.
            'HOW to pursue these goals: through genuinely useful, on-brand content that earns saves, ' +
            'shares, comments and DMs. The standing quality standards below still apply in full — the ' +
            'goal above tells you WHAT outcome the business needs, and those standards tell you the only ' +
            'acceptable way to get there. Never chase the number with engagement bait, follow-for-follow ' +
            'appeals, vanity formats, manufactured controversy or clickbait.',
        );
    }

    lines.push(
        '',
        // Finding 5: answers.primary_objective renders a second, independent statement of intent
        // ("Primary objective for this account: …") that can disagree with the live goal. Nothing
        // previously said which won, so state it.
        'Where any other stated objective in this brief disagrees with the goals above, the goals ' +
        'above win — they are the live, user-maintained target.',
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
