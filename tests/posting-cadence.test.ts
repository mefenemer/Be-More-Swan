// tests/posting-cadence.test.ts
// Locks postsPerWeekFor() — the parser the periodic conversion-post scheduler relies on to turn a
// stored posting_frequency (canonical label/key OR legacy free text) into posts-per-week.
// Run:  npx tsx tests/posting-cadence.test.ts

import assert from 'node:assert';
import { POSTING_CADENCES, postsPerWeekFor, intervalHoursFor } from '../src/config/posting-cadence';

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

console.log(`\n${passed} checks passed.`);
