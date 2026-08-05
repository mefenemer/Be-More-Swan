// tests/posting-cadence.test.ts
// Locks postsPerWeekFor() — the parser the periodic conversion-post scheduler relies on to turn a
// stored posting_frequency (canonical label/key OR legacy free text) into posts-per-week.
// Run:  npx tsx tests/posting-cadence.test.ts

import assert from 'node:assert';
import {
    POSTING_CADENCES, postsPerWeekFor, intervalHoursFor, readCadence, DEFAULT_POSTING_FREQUENCY,
} from '../src/config/posting-cadence';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

check('canonical labels resolve to their declared rate', () => {
    for (const c of POSTING_CADENCES) assert.equal(postsPerWeekFor(c.label), c.postsPerWeek, c.label);
});

check('canonical keys resolve too', () => {
    assert.equal(postsPerWeekFor('daily'), 7);
    assert.equal(postsPerWeekFor('3x_week'), 3);
    assert.equal(postsPerWeekFor('on_demand'), 0);
});

check('free-text per-week phrasing', () => {
    assert.equal(postsPerWeekFor('3 times a week'), 3);
    assert.equal(postsPerWeekFor('4x week'), 4);
    assert.equal(postsPerWeekFor('post 2 times per week'), 2);
    assert.equal(postsPerWeekFor('three times a week'), 3);
});

check('free-text per-day phrasing multiplies by 7', () => {
    assert.equal(postsPerWeekFor('twice a day'), 14);
    assert.equal(postsPerWeekFor('2 times a day'), 14);
    assert.equal(postsPerWeekFor('every day'), 7);
});

check('on-demand / fortnightly / unknown', () => {
    assert.equal(postsPerWeekFor('on demand'), 0);
    assert.equal(postsPerWeekFor('as needed'), 0);
    assert.equal(postsPerWeekFor('fortnightly'), 0.5);
    assert.equal(postsPerWeekFor('every two weeks'), 0.5);
    assert.equal(postsPerWeekFor(''), 0);
    assert.equal(postsPerWeekFor(undefined), 0);
    assert.equal(postsPerWeekFor('whenever I feel like it'), 0);
});

check('bare number treated as per week', () => {
    assert.equal(postsPerWeekFor('5'), 5);
});

check('intervalHoursFor spaces posts evenly; null when not periodic', () => {
    assert.equal(intervalHoursFor('weekly'), 168);
    assert.equal(intervalHoursFor('daily'), 24);
    assert.equal(intervalHoursFor('3 times a week'), 56);
    assert.equal(intervalHoursFor('on demand'), null);
});

// ── readCadence: telling "off on purpose" apart from "we didn't understand you" ────────────────
// The bug this locks: a prod tenant's posting_frequency was the sentence below. postsPerWeekFor
// returned 0, so draft-horizon-fill skipped them on every hourly tick and NOTHING was ever drafted
// — while the Autopilot card, which tested the text with its own regex for the words "on demand"/
// "manual", reported autopilot as Active. Weeks of silence with a green light on the dashboard.
//
// A rate of 0 alone cannot distinguish the two, which is why readCadence exists. Any surface that
// tells a human about the schedule must branch on `kind`, never on the rate.
check('readCadence separates a real cadence, a deliberate on-demand, and an unreadable one', () => {
    assert.deepEqual(readCadence('3 times a week'), { postsPerWeek: 3, kind: 'scheduled' });
    assert.deepEqual(readCadence('Daily'), { postsPerWeek: 7, kind: 'scheduled' });
    assert.deepEqual(readCadence('4x per week and at different times'), { postsPerWeek: 4, kind: 'scheduled' });

    // Chosen from the picker, and free text that plainly says the same thing.
    assert.deepEqual(readCadence('On demand'), { postsPerWeek: 0, kind: 'on_demand' });
    assert.deepEqual(readCadence('on_demand'), { postsPerWeek: 0, kind: 'on_demand' });
    assert.deepEqual(readCadence('as needed'), { postsPerWeek: 0, kind: 'on_demand' });

    // THE regression. A schedule, unmistakably — and we cannot read it. Never report as on_demand.
    const theSentence = 'Every Monday, Tuesday, Wednesday, and Thursday at 8 am.';
    assert.equal(postsPerWeekFor(theSentence), 0, 'precondition: the parser still cannot read it');
    assert.deepEqual(readCadence(theSentence), { postsPerWeek: 0, kind: 'unrecognised' });
    assert.deepEqual(readCadence('whenever I feel like it'), { postsPerWeek: 0, kind: 'unrecognised' });
});

check('an unset frequency is the default cadence, not a failure to parse', () => {
    // resolvePostingSchedule substitutes DEFAULT_POSTING_FREQUENCY, so the reading must agree —
    // an assistant with no frequency set does draft, and must not be flagged as broken.
    for (const empty of ['', '   ', null, undefined]) {
        const r = readCadence(empty);
        assert.equal(r.kind, 'scheduled', JSON.stringify(empty));
        assert.equal(r.postsPerWeek, postsPerWeekFor(DEFAULT_POSTING_FREQUENCY), JSON.stringify(empty));
    }
});

check('every catalogue entry reads back as the kind its rate implies', () => {
    for (const c of POSTING_CADENCES) {
        const r = readCadence(c.label);
        assert.equal(r.postsPerWeek, c.postsPerWeek, c.label);
        assert.equal(r.kind, c.postsPerWeek > 0 ? 'scheduled' : 'on_demand', c.label);
    }
});

console.log(`\n${passed} checks passed.`);
