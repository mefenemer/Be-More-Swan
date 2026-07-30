// tests/goal-directive.test.ts
//
// Locks the seam that makes a SMART goal actually change generated content.
//
// This is the regression that matters most here: goals shipped with a full metric catalog, a
// run-rate engine, three crons and a Goals tab, and NOTHING read them at generation time — a user
// could set a goal, watch the bar move, and every post was identical to having no goal. These tests
// assert the directive reaches the prompt, that it steers by funnel stage, and — critically — that
// it never claims authority over the guardrails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoalDirective, renderGoalDirective, goalPromptBlock, type DirectiveGoal } from '../src/utils/goal-directive';
import { renderBlueprintPrompt } from '../src/utils/blueprint-prompt';
import {
    GOAL_METRICS, GOAL_AI_TIERS, DRAFTING_FOCUS, FUNNEL_DIAGNOSTICS,
    pollCadenceHours, tierAllows, availableMetricsForRole,
} from '../src/config/goal-metrics';

const NOW = new Date('2026-07-30T12:00:00Z');

const goal = (over: Partial<DirectiveGoal> = {}): DirectiveGoal => ({
    metricKey: 'instagram_followers',
    title: null,
    rationale: null,
    targetValue: 20000,
    latestValue: 8000,
    targetDate: new Date('2026-10-30T00:00:00Z'),
    status: 'on_track',
    isPrimary: true,
    ...over,
});

// ── The directive exists and carries the SMART content ──────────────────────────

test('no goals → null directive, and an empty prompt block', () => {
    assert.equal(buildGoalDirective([], NOW), null);
    assert.equal(goalPromptBlock([], NOW), '');
});

test('a goal reaches the prompt with its target, deadline and status', () => {
    const out = goalPromptBlock([goal()], NOW);
    assert.match(out, /Instagram Followers/);
    assert.match(out, /20,000/);
    assert.match(out, /2026-10-30/);
    assert.match(out, /status: on_track/);
});

test('the user-authored title and rationale are both injected', () => {
    const out = goalPromptBlock([goal({
        title: 'Reach wholesale buyers',
        rationale: 'Launching a wholesale range in Q4; current followers are direct consumers.',
    })], NOW);
    assert.match(out, /"Reach wholesale buyers"/);
    assert.match(out, /Why this matters: Launching a wholesale range in Q4/);
});

test('progress is coarse (nearest 10%) so blueprint dedup keeps working', () => {
    // 8,437/20,000 = 42.2% → 40%. The raw value must NOT appear: a fast-moving number in blueprint
    // content would make every unrelated recompile (profile autosave, rule edit) emit a new row.
    const d = buildGoalDirective([goal({ latestValue: 8437 })], NOW)!;
    assert.equal(d.goals[0].progressPct, 40);
    const out = renderGoalDirective(d);
    assert.match(out, /roughly 40% of the way/);
    assert.doesNotMatch(out, /8,?437/, 'raw telemetry value must not reach the prompt');
});

test('nearby raw values collapse to the same directive (dedup safety)', () => {
    const a = renderGoalDirective(buildGoalDirective([goal({ latestValue: 8000 })], NOW));
    const b = renderGoalDirective(buildGoalDirective([goal({ latestValue: 8399 })], NOW));
    assert.equal(a, b, 'a small telemetry tick must not change the directive');
});

test('no telemetry yet → progress omitted rather than reported as 0%', () => {
    const out = goalPromptBlock([goal({ latestValue: null, status: 'pending' })], NOW);
    assert.doesNotMatch(out, /of the way/);
    assert.match(out, /target 20,000/);
});

// ── Funnel steering (the "helpful" part) ────────────────────────────────────────

test('an awareness goal pulls the top-of-funnel drafting levers', () => {
    const out = goalPromptBlock([goal({ metricKey: 'instagram_followers' })], NOW);
    assert.match(out, /top of funnel \(Awareness\)/);
    assert.match(out, /specific, concrete hook/i);
});

test('an engagement goal pulls the mid-funnel levers, not the awareness ones', () => {
    const out = goalPromptBlock([goal({ metricKey: 'instagram_engagement_rate', targetValue: 5 })], NOW);
    assert.match(out, /middle of funnel \(Interaction\)/);
    assert.match(out, /invite a genuine reply/i);
    assert.doesNotMatch(out, /concrete hook/i);
});

test('the PRIMARY goal decides the playbook, whatever order goals arrive in', () => {
    const out = goalPromptBlock([
        goal({ metricKey: 'instagram_followers', isPrimary: false }),
        goal({ metricKey: 'instagram_engagement_rate', targetValue: 5, isPrimary: true }),
    ], NOW);
    assert.match(out, /middle of funnel/);
    assert.match(out, /\[PRIMARY\] Instagram Engagement Rate/);
});

// ── Playbook review (2026-07-30): the drafting prompt must never carry advisory-only levers ─────
// FUNNEL_DIAGNOSTICS is written for a human strategist reading an off-track diagnosis, so it reaches
// for calendar-, format- and operations-level advice. It was briefly used as the generation-time
// playbook, which put instructions into every post that the model cannot act on or that contradict
// other parts of the same prompt. These tests pin the separation.

test('the drafting prompt never instructs a FORMAT change (format is fixed before generation)', () => {
    // process-content-jobs.ts sets format from job.post_format / answers.preferred_format and states
    // it flatly ("This is an IMAGE post"), so "pivot to Reels" is self-contradictory in-prompt.
    for (const metricKey of GOAL_METRICS.filter(m => m.available).map(m => m.key)) {
        const out = goalPromptBlock([goal({ metricKey, targetValue: 5 })], NOW);
        assert.doesNotMatch(out, /reels?|shorts|short-form video|format pivot/i, `${metricKey} leaks a format instruction`);
    }
});

test('the drafting prompt never instructs an episodic series (contradicts the variety block)', () => {
    // buildVarietyBlock: "Bring a genuinely DIFFERENT angle. Do NOT reuse the opening hook, core
    // premise, or overall structure" — a series requires exactly the continuity that forbids.
    for (const metricKey of GOAL_METRICS.filter(m => m.available).map(m => m.key)) {
        const out = goalPromptBlock([goal({ metricKey, targetValue: 5 })], NOW);
        assert.doesNotMatch(out, /episodic|\bseries\b/i, `${metricKey} leaks a series instruction`);
    }
});

test('the action levers do not invite inventing a lead magnet, and forbid invented offers', () => {
    // The advisory playbook says "lead-magnet promotion". With no lead magnet the model invents one,
    // and content-quality.ts's anti-fabrication rule covers invented STATISTICS only.
    //
    // Asserted against DRAFTING_FOCUS directly rather than through a goal, because the 'action'
    // objective is currently UNREACHABLE — no catalog metric maps to it (see the test below), so no
    // goal can carry it. These levers are staged for when a traffic metric lands.
    const levers = DRAFTING_FOCUS.action.join(' ');
    assert.doesNotMatch(levers, /lead magnet|lead-magnet/i);
    assert.match(levers, /never invent an offer, guide, discount or download/i);
});

test('KNOWN GAP — "Drive Traffic (Action)" has no measurable metric, so it can never be chosen', () => {
    // GOAL_OBJECTIVES advertises action, and assistant-detail.html has a placeholder <option> for it,
    // but zero metrics carry objective:'action' — there is no link-clicks or profile-visits metric in
    // the catalog. objectivesWithMetrics() therefore filters it out and the dropdown never shows it,
    // so an SMM user cannot set a traffic goal at all. This test DOCUMENTS the gap rather than
    // asserting it is fine: when a traffic metric is added, this test should start failing and be
    // replaced by a real coverage assertion.
    assert.equal(GOAL_METRICS.filter(m => m.objective === 'action').length, 0,
        'a traffic metric now exists — delete this test and assert real action coverage instead');
    // The levers are nonetheless written and reviewed, so nothing has to be invented under time
    // pressure the day a metric lands.
    assert.ok(DRAFTING_FOCUS.action.length > 0);
});

test('an outcome goal gets drafting levers, not operations advice aimed at the user', () => {
    // Blog Writer's posts_published is objective 'outcome' AND it drafts content, so this path is
    // live. "Import more source data so the assistant has more to process" is meaningless mid-draft.
    const out = goalPromptBlock([goal({ metricKey: 'posts_published', targetValue: 40 })], NOW);
    assert.doesNotMatch(out, /import(ing)? more source data|queue|unactioned|escalated/i);
    assert.match(out, /publishable draft|tightly scoped/i);
});

test('every objective has at least one drafting lever, so no goal steers with an empty list', () => {
    for (const objective of Object.keys(DRAFTING_FOCUS) as Array<keyof typeof DRAFTING_FOCUS>) {
        assert.ok(DRAFTING_FOCUS[objective].length > 0, `${objective} has no drafting levers`);
    }
});

test('the two playbooks stay separate — the advisory one keeps its strategy-level advice', () => {
    // The advisory playbook is CORRECT for its own audience (a human deciding what to change after a
    // goal goes off track), so the fix was to stop feeding it to the drafting prompt, NOT to strip
    // the calendar/format advice out of it. Guard against a well-meaning "cleanup" merging the two.
    assert.ok(FUNNEL_DIAGNOSTICS.awareness.focus.some(f => /Reels/i.test(f)),
        'the advisory playbook should still recommend format pivots to a human');
    assert.ok(FUNNEL_DIAGNOSTICS.outcome.focus.some(f => /source data/i.test(f)),
        'the advisory playbook should still recommend importing source data to a human');
    // ...and the drafting playbook must share no item with it.
    for (const objective of Object.keys(DRAFTING_FOCUS) as Array<keyof typeof DRAFTING_FOCUS>) {
        const advisory = new Set(FUNNEL_DIAGNOSTICS[objective].focus);
        for (const lever of DRAFTING_FOCUS[objective]) {
            assert.ok(!advisory.has(lever), `"${lever}" is copied verbatim from the advisory playbook`);
        }
    }
});

// ── The vanity-metric reconciliation ───────────────────────────────────────────
// CONTENT_QUALITY_STANDARDS: "Do NOT optimise for Likes or follower count." A follower goal says the
// opposite, and the standards are appended AFTER this block, so the contradiction would land later
// in the prompt and partly cancel the goal. The block must reconcile the two, not pick a side.

test('a follower goal reconciles with the no-vanity-metrics standard instead of contradicting it', () => {
    const out = goalPromptBlock([goal({ metricKey: 'instagram_followers' })], NOW);
    assert.match(out, /standing quality standards below still apply in full/i);
    assert.match(out, /saves, shares, comments and DMs/i);
    assert.match(out, /Never chase the number with engagement bait/i);
});

test('an off-track goal is told not to compensate with bait', () => {
    // The escalation ("apply the tactics decisively") is the most likely place for the model to reach
    // for a cheap tactic, so the prohibition has to be attached to the escalation itself.
    const out = goalPromptBlock([goal({ status: 'off_track' })], NOW);
    assert.match(out, /Do not compensate by reaching for engagement bait, outrage, false urgency or clickbait/i);
});

test('the live goal is declared to win over any other stated objective', () => {
    // answers.primary_objective renders "Primary objective for this account: …" independently, and
    // the two can disagree. Precedence has to be stated or the model arbitrates silently.
    const out = goalPromptBlock([goal()], NOW);
    assert.match(out, /any other stated objective in this brief disagrees.*the goals above win/is);
});

// ── Escalation ─────────────────────────────────────────────────────────────────

for (const status of ['at_risk', 'off_track'] as const) {
    test(`${status} escalates the directive`, () => {
        const d = buildGoalDirective([goal({ status })], NOW)!;
        assert.equal(d.urgent, true);
        assert.match(renderGoalDirective(d), /NOT on track/);
    });
}

test('on_track does not escalate', () => {
    const d = buildGoalDirective([goal({ status: 'on_track' })], NOW)!;
    assert.equal(d.urgent, false);
    assert.doesNotMatch(renderGoalDirective(d), /NOT on track/);
});

// ── Guardrail subordination — the safety property ───────────────────────────────

test('the directive subordinates itself to rules and forbids leaking the goal', () => {
    const out = goalPromptBlock([goal({ status: 'off_track' })], NOW);
    // A goal must never be able to argue with a content rule or the required disclosure.
    assert.match(out, /never override the content rules/i);
    // Nor should the goal's numbers end up in the published caption.
    assert.match(out, /Never mention the goal, its numbers, or its status in the content/i);
});

test('a retired or unmeasurable metric key is ignored, not rendered', () => {
    // A goal whose metric left the catalog has a meaningless status, so it must not steer.
    const d = buildGoalDirective([goal({ metricKey: 'metric_that_no_longer_exists' })], NOW);
    assert.equal(d, null);
});

// ── Deadline wording ───────────────────────────────────────────────────────────

test('a passed deadline reads as overdue, not as negative days', () => {
    const out = goalPromptBlock([goal({ targetDate: new Date('2026-07-27T12:00:00Z') })], NOW);
    assert.match(out, /deadline passed 3 days ago/);
    assert.doesNotMatch(out, /-3 days/);
});

// ── Blueprint → prompt plumbing ────────────────────────────────────────────────

test('section 12 is emitted verbatim, without its structured JSON beside it', () => {
    const directive = goalPromptBlock([goal({ title: 'Q4 wholesale push' })], NOW);
    const out = renderBlueprintPrompt({
        '12-goals': { content: { directive, goals: [{ metricKey: 'instagram_followers', target: 20000 }], focus: ['a', 'b'] } },
    });
    assert.match(out, /--- 12-GOALS ---/);
    assert.match(out, /Q4 wholesale push/);
    // The structured copy must not be dumped as JSON — the model would read the target twice.
    assert.doesNotMatch(out, /"metricKey"/);
    assert.doesNotMatch(out, /\bfocus:/);
});

test('a goal-less assistant emits no 12-GOALS header at all', () => {
    // An empty header would read to the model as "goals exist but are unknown".
    const out = renderBlueprintPrompt({ '12-goals': { content: {} } });
    assert.doesNotMatch(out, /12-GOALS/);
});

// ── Catalog integrity ──────────────────────────────────────────────────────────

test('every catalog metric has a funnel objective, so none can steer nothing', () => {
    for (const m of GOAL_METRICS) {
        assert.ok(m.objective, `${m.key} has no objective`);
    }
});

test('unavailable metrics are never offered to a user', () => {
    // linkedin_followers needs LinkedIn ORGANISATION scopes we are not approved for, so a goal set
    // against it can never move off 'pending'. `available:false` must actually hide it.
    const li = GOAL_METRICS.find(m => m.key === 'linkedin_followers')!;
    assert.equal(li.available, false, 'linkedin_followers is not measurable with member-only scopes');
    const offered = availableMetricsForRole('social_media_manager', ['instagram', 'linkedin']);
    assert.ok(!offered.some(m => m.key === 'linkedin_followers'), 'an unmeasurable metric must not be offered');
    // ...but the connected, measurable ones still are.
    assert.ok(offered.some(m => m.key === 'instagram_followers'));
});

// ── Tier gating (the inverted-plan-keys trap) ──────────────────────────────────

test('premium goal AI is gated ABOVE the entry tier, matching the price ladder', () => {
    // saver=£29 entry, buster=£99, employee=£349 (db/seed.ts). These gates were written against a
    // dead price list and handed every premium feature to the £29 plan while padlocking the £99 one.
    for (const feature of Object.keys(GOAL_AI_TIERS) as Array<keyof typeof GOAL_AI_TIERS>) {
        assert.equal(tierAllows(feature, 'saver'), false, `${feature} must be locked on the £29 entry tier`);
        assert.equal(tierAllows(feature, 'buster'), true, `${feature} must be unlocked on the £99 tier`);
        assert.equal(tierAllows(feature, 'employee'), true, `${feature} must be unlocked on the £349 tier`);
    }
});

test('buster gets the autonomous goal tracking its own plan description sells', () => {
    // master_plans.description for buster promises "autonomous goal tracking, advanced analytics".
    assert.equal(tierAllows('autonomous', 'buster'), true);
});

test('telemetry polling is faster on paid-up tiers than on the entry tier', () => {
    assert.ok(pollCadenceHours('buster') < pollCadenceHours('saver'), 'the £99 tier must poll at least as often as the £29 one');
    assert.equal(pollCadenceHours('saver'), 24);
    assert.equal(pollCadenceHours('buster'), 1);
    assert.equal(pollCadenceHours('employee'), 1);
    assert.equal(pollCadenceHours(null), 24, 'unknown tier falls back to daily');
});
