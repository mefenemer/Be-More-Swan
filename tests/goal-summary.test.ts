// tests/goal-summary.test.ts
// SMART Goals — how an assistant's goals collapse into one line on a card (src/utils/goal-summary.ts).
// Run:  npx tsx tests/goal-summary.test.ts
//
// Two things are locked here, both of which had a live bug behind them:
//   1. `awaiting_update` and `data_disconnected` are NOT performance verdicts. get-assistants.ts
//      swept every non-pending, non-on_track status into the red "Off Track" count, so a lapsed
//      Instagram token — and, once user-reported metrics shipped, a revenue goal simply waiting for
//      this month's figure — rendered on the dashboard as a failing goal.
//   2. Which goal becomes the headline when there is no primary. A user-reported metric can never be
//      primary, so an assistant tracking only revenue has none at all, and the old
//      `find(isPrimary) || goals[0]` silently showed whichever was newest.

import assert from 'node:assert';
import {
    summariseGoals,
    pickHeadlineGoal,
    isAttentionStatus,
    ATTENTION_STATUSES,
    PERFORMANCE_STATUSES,
} from '../src/utils/goal-summary';
import { GOAL_STATUSES } from '../src/config/goal-metrics';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// `any` return: the tests tag goals with an `id` to assert WHICH one came back, and a literal
// spread of Record<string, any> doesn't carry that through to the inferred type.
const g = (status: string, over: Record<string, any> = {}): any =>
    ({ status, isPrimary: false, createdAt: new Date('2026-01-01'), ...over });

check('a measurement gap is never counted as off track', () => {
    const s = summariseGoals([g('awaiting_update'), g('data_disconnected'), g('on_track')]);
    assert.equal(s.offTrack, 0, 'neither attention status may reach the red bucket');
    assert.equal(s.atRisk, 0);
    assert.equal(s.awaitingUpdate, 1);
    assert.equal(s.dataDisconnected, 1);
    assert.equal(s.needsAttention, 2);
    assert.equal(s.total, 3);
});

check('the two attention states stay distinct from each other', () => {
    // They need different fixes — type a number in vs re-authenticate an integration — so a merged
    // "2 need attention" would tell the user nothing actionable.
    const s = summariseGoals([g('awaiting_update'), g('awaiting_update'), g('data_disconnected')]);
    assert.equal(s.awaitingUpdate, 2);
    assert.equal(s.dataDisconnected, 1);
});

check('performance counts are exactly the three verdicts', () => {
    const s = summariseGoals([g('on_track'), g('on_track'), g('at_risk'), g('off_track'), g('pending')]);
    assert.deepEqual(
        { onTrack: s.onTrack, atRisk: s.atRisk, offTrack: s.offTrack, pending: s.pending },
        { onTrack: 2, atRisk: 1, offTrack: 1, pending: 1 },
    );
});

check('assessed is false until something has an actual verdict', () => {
    // Drives "Awaiting first progress check-in" instead of a misleading "0 on track" (issue #135).
    assert.equal(summariseGoals([g('pending'), g('pending')]).assessed, false);
    // An overdue figure is not an assessment either — it is the absence of one.
    assert.equal(summariseGoals([g('awaiting_update'), g('data_disconnected')]).assessed, false);
    assert.equal(summariseGoals([g('pending'), g('at_risk')]).assessed, true);
});

check('an unknown or legacy status falls to pending, never to a verdict', () => {
    const s = summariseGoals([g('some_status_from_the_future')]);
    assert.equal(s.pending, 1);
    assert.equal(s.offTrack + s.onTrack + s.atRisk + s.needsAttention, 0);
});

check('every catalog status is classified, and the two sets never overlap', () => {
    for (const status of GOAL_STATUSES) {
        const s = summariseGoals([g(status)]);
        const counted = s.onTrack + s.atRisk + s.offTrack + s.pending + s.awaitingUpdate + s.dataDisconnected;
        assert.equal(counted, 1, `${status} was not counted exactly once`);
    }
    for (const s of PERFORMANCE_STATUSES) {
        assert.ok(!isAttentionStatus(s), `${s} cannot be both a verdict and a measurement gap`);
    }
    for (const s of ATTENTION_STATUSES) {
        assert.ok(GOAL_STATUSES.includes(s), `${s} must be a real status`);
    }
});

// ── Headline selection ───────────────────────────────────────────────────────

check('an explicit primary always wins, however it is tracking', () => {
    // The user said which goal this assistant is measured on; a card must not quietly disagree.
    const primary = g('on_track', { isPrimary: true, id: 'p' });
    const head = pickHeadlineGoal([g('off_track', { id: 'x' }), primary, g('at_risk', { id: 'y' })]);
    assert.equal((head as any).id, 'p');
});

check('with no primary, the most urgent goal leads', () => {
    const head = pickHeadlineGoal([g('on_track', { id: 'a' }), g('off_track', { id: 'b' }), g('at_risk', { id: 'c' })]);
    assert.equal((head as any).id, 'b');
    assert.equal((pickHeadlineGoal([g('on_track', { id: 'a' }), g('at_risk', { id: 'c' })]) as any).id, 'c');
});

check('a measurement gap does not outrank a goal that is genuinely tracking', () => {
    // Promoting an overdue figure to the headline would contradict the whole point of giving those
    // states a quieter row of their own.
    const head = pickHeadlineGoal([g('awaiting_update', { id: 'stale' }), g('on_track', { id: 'live' })]);
    assert.equal((head as any).id, 'live');
    // …but it beats 'pending', which has no figure to draw at all.
    assert.equal((pickHeadlineGoal([g('pending', { id: 'new' }), g('awaiting_update', { id: 'stale' })]) as any).id, 'stale');
});

check('an all-manual assistant still gets a headline', () => {
    // THE CASE THE OLD CODE GOT WRONG. A user-reported metric can never be primary, so nothing here
    // has isPrimary — the fallback has to do real work rather than defaulting to goals[0].
    const goals = [
        g('on_track', { id: 'revenue', createdAt: new Date('2026-07-01') }),
        g('off_track', { id: 'bookings', createdAt: new Date('2026-01-01') }),
    ];
    assert.equal((pickHeadlineGoal(goals) as any).id, 'bookings', 'urgency beats recency');
    // goals[0] would have been the on-track one — the old behaviour.
    assert.notEqual((pickHeadlineGoal(goals) as any).id, goals[0].id);
});

check('ties break on recency, and an empty list yields nothing', () => {
    const head = pickHeadlineGoal([
        g('at_risk', { id: 'old', createdAt: new Date('2026-01-01') }),
        g('at_risk', { id: 'new', createdAt: new Date('2026-07-01') }),
    ]);
    assert.equal((head as any).id, 'new');
    assert.equal(pickHeadlineGoal([]), null);
});

check('picking a headline does not reorder the caller\'s array', () => {
    // get-assistants and manage-goals both pass the array they then render from.
    const goals = [g('on_track', { id: 'a' }), g('off_track', { id: 'b' })];
    pickHeadlineGoal(goals);
    assert.deepEqual(goals.map((x: any) => x.id), ['a', 'b']);
});

console.log(`\n${passed} checks passed.`);
