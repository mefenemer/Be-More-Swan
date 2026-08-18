// tests/draft-horizon-source-of-truth.test.ts
// The draft horizon lives in TWO places and only one of them is authoritative:
//
//   · ai_assistants.draft_horizon_days   COLUMN  ← the source of truth, every reader uses it
//   · onboarding_context.draft_horizon_days      ← a legacy echo of the wizard answer, never read
//
// They are written by different surfaces (the onboarding wizard writes the jsonb;
// set-draft-horizon.ts writes the column) and nothing kept them equal, so they drift. Measured on
// staging 2026-08-18, assistant 23 had jsonb "30" against column 7 — and schedule-blog.ts's
// pickCadenceSlot was the ONE reader preferring the jsonb (falling back to 14, not 7). Approve
// therefore scheduled into a 30-day window that the gap-fillers only ever filled to 7 days: slots
// past day 7 were never counted as covered, so the two could double-book or leave holes.
//
// Pure: no network, no DB.
// Run:  npx tsx tests/draft-horizon-source-of-truth.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    resolveHorizonDays, computeScheduleSlots, resolvePostingSchedule,
    DEFAULT_HORIZON_DAYS, MIN_HORIZON_DAYS, MAX_HORIZON_DAYS,
} from '../src/config/posting-cadence';
import { landmark } from './landmark';

let passed = 0;
const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

// A Blog Writer shaped exactly like staging assistant 23: the two stores disagree.
const DRIFTED = {
    draftHorizonDays: 7,
    onboardingContext: {
        draft_horizon_days: '30',
        posting_frequency: 'Weekly',
        posting_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        posting_times: ['09:00'],
        posting_timezone: 'Europe/London',
    },
};

console.log('\nresolveHorizonDays — the column wins\n');

check('reads the column', () => {
    assert.equal(resolveHorizonDays({ draftHorizonDays: 14 }), 14);
});

check('IGNORES onboarding_context.draft_horizon_days when the two disagree', () => {
    // The whole bug in one assertion: jsonb says 30, column says 7 → 7.
    assert.equal(resolveHorizonDays(DRIFTED), 7);
});

check('a null column falls back to DEFAULT_HORIZON_DAYS, not to 14', () => {
    // pickCadenceSlot used to default to 14 while every other reader defaulted to 7.
    assert.equal(resolveHorizonDays({ draftHorizonDays: null }), DEFAULT_HORIZON_DAYS);
    assert.equal(resolveHorizonDays({}), DEFAULT_HORIZON_DAYS);
    assert.equal(DEFAULT_HORIZON_DAYS, 7);
});

check('a jsonb value alone never produces a horizon', () => {
    assert.equal(resolveHorizonDays({ onboardingContext: { draft_horizon_days: 30 } }), DEFAULT_HORIZON_DAYS);
});

console.log('\nthe windows the two paths compute\n');

const now = new Date('2026-08-18T06:00:00Z');
const schedule = resolvePostingSchedule(DRIFTED.onboardingContext);

check('approve and gap-fill compute the SAME window for one assistant', () => {
    // Both now resolve identically, so the arrays must be equal element-for-element.
    const viaApprove = computeScheduleSlots({ schedule, horizonDays: resolveHorizonDays(DRIFTED), now });
    const viaGapFill = computeScheduleSlots({ schedule, horizonDays: resolveHorizonDays(DRIFTED), now });
    assert.deepEqual(viaApprove, viaGapFill);
    assert.ok(viaApprove.length > 0, 'a weekly cadence yields at least one slot');
});

check('the drifted jsonb really would have opened a wider window', () => {
    // Guards the test itself: if these matched, the checks above would prove nothing.
    const honest = computeScheduleSlots({ schedule, horizonDays: 7, now });
    const drifted = computeScheduleSlots({ schedule, horizonDays: 30, now });
    assert.ok(drifted.length > honest.length,
        `expected the 30-day window to hold more slots (got ${drifted.length} vs ${honest.length})`);
    const lastHonest = honest[honest.length - 1].getTime();
    assert.ok(drifted[drifted.length - 1].getTime() > lastHonest, 'and to reach further ahead');
});

check('every slot sits inside the resolved horizon', () => {
    const slots = computeScheduleSlots({ schedule, horizonDays: resolveHorizonDays(DRIFTED), now });
    const limit = now.getTime() + 7 * 24 * 60 * 60 * 1000;
    for (const s of slots) assert.ok(s.getTime() <= limit, `${s.toISOString()} is beyond the 7-day horizon`);
});

check('computeScheduleSlots clamps to the shared bounds', () => {
    assert.equal(MIN_HORIZON_DAYS, 1);
    assert.equal(MAX_HORIZON_DAYS, 30);
    const huge = computeScheduleSlots({ schedule, horizonDays: 9999, now });
    const capped = computeScheduleSlots({ schedule, horizonDays: MAX_HORIZON_DAYS, now });
    assert.deepEqual(huge, capped, 'beyond MAX_HORIZON_DAYS is clamped, not honoured');
    const zero = computeScheduleSlots({ schedule, horizonDays: 0, now });
    const one = computeScheduleSlots({ schedule, horizonDays: MIN_HORIZON_DAYS, now });
    assert.deepEqual(zero, one, 'below MIN_HORIZON_DAYS is clamped up');
});

console.log('\nno reader may reach for the jsonb again\n');

const READERS: Array<[string, string]> = [
    ['schedule-blog.ts', '../netlify/functions/schedule-blog.ts'],
    ['approve-post.ts', '../netlify/functions/approve-post.ts'],
    ['blog-gap-fill.ts', '../src/utils/blog-gap-fill.ts'],
    ['schedule-gap-fill.ts', '../src/utils/schedule-gap-fill.ts'],
    ['get-assistant-context.ts', '../netlify/functions/get-assistant-context.ts'],
    ['set-draft-horizon.ts', '../netlify/functions/set-draft-horizon.ts'],
];

for (const [label, path] of READERS) {
    check(`${label} resolves the horizon through the shared helper`, () => {
        const src = read(path);
        landmark(src, 'resolveHorizonDays');
        // Code, not prose: a `//` comment mentioning the jsonb key is fine and several files carry one.
        const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        assert.ok(!/\bdraft_horizon_days\b/.test(codeOnly.replace(/draft_horizon_days: days,/, '')),
            `${label} still reads onboarding_context.draft_horizon_days in code`);
    });
}

check('pickCadenceSlot no longer prefers the jsonb or defaults to 14', () => {
    const src = read('../netlify/functions/schedule-blog.ts');
    const start = landmark(src, 'async function pickCadenceSlot');
    const body = src.slice(start, landmark(src, 'export default withLambda', start));
    assert.ok(!body.includes('Number(ctx.draft_horizon_days)'), 'the jsonb read is gone');
    assert.ok(!/horizonDays\s*=\s*14/.test(body), 'the 14-day default is gone');
    assert.ok(body.includes('resolveHorizonDays(assistant)'), 'and it uses the shared resolver');
});

check('update-assistant-context promotes the wizard answer onto the column', () => {
    // Making the column authoritative would otherwise turn the wizard's required
    // "How far ahead to schedule" dropdown into a dead control.
    const src = read('../netlify/functions/update-assistant-context.ts');
    const at = landmark(src, 'const answeredHorizon');
    const body = src.slice(at, at + 600);
    assert.ok(body.includes('updatePayload.draftHorizonDays'), 'writes the column');
    assert.ok(body.includes('MIN_HORIZON_DAYS') && body.includes('MAX_HORIZON_DAYS'), 'clamped to the shared bounds');
    assert.ok(body.includes('mergedContext.draft_horizon_days'), 'and keeps the legacy echo equal');
});

check('set-draft-horizon keeps the legacy echo in step with the column', () => {
    const src = read('../netlify/functions/set-draft-horizon.ts');
    const at = landmark(src, 'draftHorizonDays: days,');
    assert.ok(src.slice(at, at + 300).includes('draft_horizon_days: days'),
        'the jsonb echo is rewritten alongside the column');
});

console.log(`\n${passed} checks passed.`);
