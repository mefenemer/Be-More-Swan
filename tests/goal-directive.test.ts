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
import { GOAL_METRICS, GOAL_AI_TIERS, pollCadenceHours, tierAllows, availableMetricsForRole } from '../src/config/goal-metrics';

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

test('an awareness goal pulls the top-of-funnel playbook', () => {
    const out = goalPromptBlock([goal({ metricKey: 'instagram_followers' })], NOW);
    assert.match(out, /top of funnel \(Awareness\)/);
    assert.match(out, /short-form video/i);
});

test('an engagement goal pulls the mid-funnel playbook, not the awareness one', () => {
    const out = goalPromptBlock([goal({ metricKey: 'instagram_engagement_rate', targetValue: 5 })], NOW);
    assert.match(out, /middle of funnel \(Interaction\)/);
    assert.match(out, /conversational prompts/i);
    assert.doesNotMatch(out, /short-form video/i);
});

test('the PRIMARY goal decides the playbook, whatever order goals arrive in', () => {
    const out = goalPromptBlock([
        goal({ metricKey: 'instagram_followers', isPrimary: false }),
        goal({ metricKey: 'instagram_engagement_rate', targetValue: 5, isPrimary: true }),
    ], NOW);
    assert.match(out, /middle of funnel/);
    assert.match(out, /\[PRIMARY\] Instagram Engagement Rate/);
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
