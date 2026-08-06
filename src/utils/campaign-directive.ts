// src/utils/campaign-directive.ts
// Turn a live campaign into the instruction that steers what other assistants write.
//
// ── This file is the whole point of the Campaign Assistant ───────────────────
// Without it, a "campaign" is a list of rows: the user sets an objective, watches a progress bar,
// and every post the Social Media Assistant drafts is byte-identical to having no campaign at all.
// That is not hypothetical — SMART Goals shipped exactly like that, with seven functions, three
// crons and a metric catalog, and `grep -i goal` over the generation path returned nothing. The
// maths was fine; the wiring never existed.
//
// So: PURE, no I/O, so the steering is locked by tests rather than by hoping a call site is right.
// `tests/campaign-directive.test.ts` asserts that a campaign changes the rendered prompt.
//
// ── Two seams, both must be fed ──────────────────────────────────────────────
// Social goes through `renderBlueprintPrompt()` (so process-content-jobs and admin-test-generate
// get it for free). Blog assembles its OWN prompt in `buildBlueprintGuardrailsBlock()` and needs a
// separate injection. Feeding one and not the other is the same bug the Inspo tab shipped with.
//
// ── ⚠️ Never put a fast-moving value in here ─────────────────────────────────
// Blueprint rows de-dupe by section CONTENT. A live count in this section would make every
// unrelated recompile — a profile autosave on a 1.2s debounce, a content-rule edit, a post
// rejection — emit a new blueprint row because a number ticked by one. Pace is therefore a BUCKET
// ('ahead' | 'on_track' | 'behind'), never a percentage and never a raw count.

import { renderCampaignConstraints, type CampaignConstraints } from '../config/campaign-reject-reasons';
import { CAMPAIGN_OUTCOME_LABELS, type CampaignOutcomeMetric } from '../config/campaign-vocab';

/** How the campaign is tracking. Deliberately coarse — see the fast-moving-value warning above. */
export type CampaignPace = 'ahead' | 'on_track' | 'behind' | 'unknown';

export interface DirectiveCampaign {
    id: number;
    /** The founder's own sentence. Quoted, never paraphrased. */
    objective: string;
    outcomeMetric: CampaignOutcomeMetric;
    /** The angle the orchestrator wants taken, if `adjust_messaging` has set one. */
    angle?: string | null;
    /** Free-text audience description from the strategy, if any. */
    audience?: string | null;
    pace: CampaignPace;
    /** Days left, bucketed to a week so a daily tick cannot churn the blueprint. */
    weeksRemaining?: number | null;
    constraints?: CampaignConstraints | null;
}

export interface CampaignDirective {
    campaignId: number;
    objective: string;
    outcome: string;
    pace: CampaignPace;
    angle: string | null;
    audience: string | null;
    /** Pre-rendered prose. This is the ONLY thing emitted into the prompt. */
    directive: string;
}

/**
 * Build the directive for the campaign a piece of work belongs to.
 *
 * Takes ONE campaign, not a list. An assistant serving two campaigns at once would otherwise get
 * two competing objectives in the same prompt and satisfy neither — the caller picks which
 * campaign this draft is for, and that decision belongs upstream where the job is created.
 *
 * Returns null when there is nothing to say, so the section serialises to nothing at all. An empty
 * `--- 13-CAMPAIGN ---` header reads to a model as "a campaign exists but its details are
 * unknown", which is worse than silence.
 */
export function buildCampaignDirective(campaign: DirectiveCampaign | null | undefined): CampaignDirective | null {
    if (!campaign?.objective?.trim()) return null;
    const objective = campaign.objective.trim();
    const outcome = CAMPAIGN_OUTCOME_LABELS[campaign.outcomeMetric] ?? 'results';

    return {
        campaignId: campaign.id,
        objective,
        outcome,
        pace: campaign.pace,
        angle: campaign.angle?.trim() || null,
        audience: campaign.audience?.trim() || null,
        directive: renderCampaignDirective(campaign, objective, outcome),
    };
}

/**
 * The prose the model actually reads.
 *
 * Written as constraints on THIS piece of work, not as a briefing on the campaign. A model told
 * "the campaign is behind target" will write about the campaign; one told "this post must ask the
 * reader to do one specific thing" will write a better post. Everything here has to be something
 * the model controls in a single piece of content.
 */
function renderCampaignDirective(c: DirectiveCampaign, objective: string, outcome: string): string {
    const lines: string[] = [];

    lines.push(`This piece of work is part of an active campaign: "${objective}"`);
    lines.push(`What the campaign is trying to produce: ${outcome.toLowerCase()}.`);

    if (c.audience) lines.push(`Who it is for: ${c.audience}`);
    if (c.angle) lines.push(`The angle this campaign is taking: ${c.angle}`);

    // Pace changes emphasis, not truthfulness. "Behind" makes the call to action more direct; it
    // never licenses a stronger claim, and the standards below say so explicitly.
    if (c.pace === 'behind') {
        lines.push('The campaign is behind where it needs to be, so make the single action you want the reader to take unmistakable and easy. Do not add urgency by overstating anything.');
    } else if (c.pace === 'ahead') {
        lines.push('The campaign is ahead of target, so prioritise depth and credibility over conversion pressure.');
    }

    if (typeof c.weeksRemaining === 'number' && c.weeksRemaining > 0 && c.weeksRemaining <= 2) {
        lines.push('The campaign ends soon. Prefer content that stands on its own immediately over anything that needs a series to make sense.');
    }

    // What the human has already refused. This is what makes the Reject button a feedback loop.
    const constraints = renderCampaignConstraints(c.constraints);
    if (constraints) lines.push(constraints);

    // ⚠️ LOAD-BEARING, and the reason this block can be appended safely.
    //
    // Two collisions have to be settled explicitly or this directive quietly fights the rest of
    // the prompt. First: the content standards say "do not optimise for likes or follower count",
    // which reads as the opposite of a campaign target unless the relationship is stated. Second:
    // the assistant's own onboarding renders a "Primary objective for this account: …" line
    // independently, so without a precedence rule the model gets two objectives and picks one.
    //
    // Resolved as means-and-ends: the campaign says WHAT outcome is needed, the standards say the
    // only acceptable route to it. Neither side is weakened.
    lines.push(
        'The campaign does not relax any other rule. Your content rules, brand voice, knowledge base and disclosure requirements all still apply in full, and the quality standards still govern HOW you write — the campaign only says what this work is FOR. Never use engagement bait, follow-for-follow, manufactured controversy or invented statistics to move a campaign number. Where this campaign and the account\'s standing primary objective disagree, the campaign wins for this piece of work.',
    );

    // The model must never talk about the campaign. A reader seeing "as part of our Q3 campaign"
    // is being shown the machinery, and the machinery is not the content.
    lines.push('Never mention the campaign, its target, its progress or the fact that a campaign exists. It changes what you write, not what you say about yourself.');

    return lines.join('\n');
}

/**
 * Bucket a raw progress percentage into a pace.
 *
 * Exported so the two call sites cannot disagree about where the boundaries are, and so the
 * bucketing is testable independently of the prose.
 *
 * The bands are wide on purpose: a campaign that crosses 100% of run-rate on a Tuesday and dips
 * below it on a Wednesday has not changed strategy, and a directive that flips with it would churn
 * the blueprint and confuse the drafter.
 */
export function paceFromProgress(actual: number, expected: number): CampaignPace {
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return 'unknown';
    const ratio = actual / expected;
    if (ratio >= 1.15) return 'ahead';
    if (ratio <= 0.85) return 'behind';
    return 'on_track';
}

/**
 * The blog seam's block.
 *
 * Blog assembles its own prompt rather than going through `renderBlueprintPrompt`, so it needs the
 * directive handed to it directly. Same text, wrapped in the heading style that file uses.
 * Returns '' when there is no campaign, so the caller can concatenate unconditionally.
 */
export function campaignPromptBlock(campaign: DirectiveCampaign | null | undefined): string {
    const d = buildCampaignDirective(campaign);
    if (!d) return '';
    return `\nCAMPAIGN\n${d.directive}\n`;
}
