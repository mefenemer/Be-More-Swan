// tests/discovery-schedule.test.ts
// Scheduling a saved search — the "Schedule" control on the Searches tab.
//
// Two things are pinned here, because neither is enforceable by types:
//   1. computeNextRun must HONOUR days_of_week. That column has existed since
//      db/lead-discovery.sql and nothing read it: "weekly" meant "seven days after the last run",
//      so a search set to run on Mondays ran on whatever day it happened to be started. The UI now
//      names the day it will run, and a promise the dispatcher does not keep is worse than the
//      generic copy it replaced.
//   2. Saving a schedule must NOT start a search. A draft has never been read or started and a
//      paused search was stopped on purpose — enabling either from the schedule form would let a
//      search nobody has approved begin spending money on a timer.
//
// No database — the pure function for real, plus a source scan for the two rules that live in SQL
// and in a handler branch.
// Run:  npx tsx tests/discovery-schedule.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { computeNextRun, normaliseDaysOfWeek, normaliseHourUtc } from '../src/utils/discovery-schedule';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const API = read('netlify/functions/discovery-campaigns.ts');
const DISPATCHER = read('netlify/functions/dispatch-discovery-runs.ts');
const UI = read('src/components/assistant-discovery-campaigns.js');

// A fixed Wednesday, so "next Monday" is a fact rather than a moving target.
// 2026-08-12T09:30:00Z is a Wednesday (getUTCDay() === 3).
const WED = new Date('2026-08-12T09:30:00.000Z');
assert.equal(WED.getUTCDay(), 3, 'fixture drift: the base date is meant to be a Wednesday');

console.log('\n──── the next run lands on a day the user chose ────');

check('a weekly search on Mondays runs on the next Monday, not seven days from now', () => {
    const next = computeNextRun('weekly', 8, [1], WED);
    assert.ok(next, 'weekly must produce a next run');
    assert.equal(next!.toISOString(), '2026-08-17T08:00:00.000Z');
    assert.equal(next!.getUTCDay(), 1, 'Monday');
});

check('several days a week each get their own run', () => {
    // Mon + Thu. From Wednesday morning the next one is TOMORROW, and the run after that is Monday.
    const thu = computeNextRun('weekly', 8, [1, 4], WED);
    assert.equal(thu!.toISOString(), '2026-08-13T08:00:00.000Z');
    const mon = computeNextRun('weekly', 8, [1, 4], thu!);
    assert.equal(mon!.toISOString(), '2026-08-17T08:00:00.000Z');
});

check('today still counts when its hour has not passed', () => {
    // Wednesday 09:30, scheduled for Wednesdays at 18:00 — that is today, not next week. Getting
    // this wrong makes every schedule saved in the morning silently skip a week.
    const next = computeNextRun('weekly', 18, [3], WED);
    assert.equal(next!.toISOString(), '2026-08-12T18:00:00.000Z');
});

check("today's slot is not re-offered once it has passed", () => {
    // The dispatcher calls this with `from` = the moment it just fired, so a candidate equal to now
    // is the run that has already happened. Returning it would re-fire the same run every hour.
    const fired = new Date('2026-08-12T08:00:00.000Z');
    const next = computeNextRun('weekly', 8, [3], fired);
    assert.equal(next!.toISOString(), '2026-08-19T08:00:00.000Z');
});

check('a weekly search with no chosen days keeps the old +7 behaviour', () => {
    // Every row that predates the Schedule control has days_of_week NULL. Pinning them to the day
    // of a deploy would move every scheduled search in the estate at once.
    const next = computeNextRun('weekly', 8, null, WED);
    assert.equal(next!.toISOString(), '2026-08-19T08:00:00.000Z');
});

check('daily rolls to tomorrow only once the hour has gone', () => {
    assert.equal(computeNextRun('daily', 18, null, WED)!.toISOString(), '2026-08-12T18:00:00.000Z');
    assert.equal(computeNextRun('daily', 8, null, WED)!.toISOString(), '2026-08-13T08:00:00.000Z');
});

check('a one-off search has no next run at all', () => {
    // The default cadence, so this is most searches. Inventing a time here is the same class of lie
    // as the fixed cadence string the UI used to print.
    assert.equal(computeNextRun('one_off', 8, [1], WED), null);
});

console.log('\n──── the inputs are normalised, never trusted ────');

check('day lists are de-duplicated, sorted, and rid of nonsense', () => {
    assert.deepEqual(normaliseDaysOfWeek([4, 1, 1, 9, -2, 'x', null]), [1, 4]);
    // Empty is not "never run": it means no day constraint, which is the legacy weekly behaviour.
    // A weekly schedule that matched no day would silently stop firing forever.
    assert.equal(normaliseDaysOfWeek([]), null);
    assert.equal(normaliseDaysOfWeek('mon'), null);
});

check('the hour is clamped rather than rejected', () => {
    assert.equal(normaliseHourUtc(0), 0);
    assert.equal(normaliseHourUtc(23), 23);
    assert.equal(normaliseHourUtc(99), 23);
    assert.equal(normaliseHourUtc(-4), 0);
    assert.equal(normaliseHourUtc('nope'), 8);
});

console.log('\n──── one implementation, not two ────');

check('the dispatcher uses the shared helper instead of its own arithmetic', () => {
    assert.ok(/from '\.\.\/\.\.\/src\/utils\/discovery-schedule'/.test(DISPATCHER),
        'dispatch-discovery-runs.ts must import the shared schedule helper.');
    assert.ok(!/function computeNextRun\(/.test(DISPATCHER),
        'a local computeNextRun has come back — that copy is what ignored days_of_week, so the UI '
        + 'would promise a day the dispatcher never honoured.');
    assert.ok(/daysOfWeek: discoverySchedules\.daysOfWeek/.test(DISPATCHER),
        'the due query must select days_of_week, or the helper is called with null every time.');
});

check('the dispatcher will not fire on a day the schedule excludes', () => {
    // next_run_at is seeded to now() at creation, so a brand-new weekly search is due immediately —
    // on whatever day it was created. Firing it there would contradict the day the user picked.
    const loop = DISPATCHER.slice(landmark(DISPATCHER, 'for (const s of due)'));
    assert.ok(/!daysOfWeek\.includes\(now\.getUTCDay\(\)\)/.test(loop),
        'the loop must skip a due row whose day is not one of the chosen ones.');
    assert.ok(landmark(loop, 'getUTCDay()') < landmark(loop, 'discoveryJobs).values'),
        'the day check has to come BEFORE the enqueue, or it skips nothing.');
});

console.log('\n──── saving a schedule never starts a search ────');

check('a draft or paused campaign keeps a disabled schedule', () => {
    const branch = API.slice(landmark(API, "action === 'schedule'"), landmark(API, "action === 'cancel_run'"));
    assert.ok(/campaign\.status === 'active'/.test(branch),
        'isEnabled must require an ACTIVE campaign. Enabling a draft here starts a search nobody '
        + 'has read on a timer; enabling a paused one silently undoes a human decision.');
    assert.ok(/nextRunAt = isEnabled \?/.test(branch),
        'a disabled schedule must store no next run — a date nothing will act on is a promise.');
    assert.ok(/blockedBy/.test(branch),
        'the response must say WHY nothing is scheduled, or the client reports a bare "Saved" for a '
        + 'schedule that will never fire.');
});

check('weekly cannot be saved without a day', () => {
    const branch = API.slice(landmark(API, "action === 'schedule'"), landmark(API, "action === 'cancel_run'"));
    assert.ok(/cadence === 'weekly' && !daysOfWeek/.test(branch),
        'a weekly schedule with no days matches nothing and would never fire.');
    assert.ok(/cadence === 'weekly' \? normaliseDaysOfWeek/.test(branch),
        'days belong to weekly only — stored against daily they are dead data the next reader has '
        + 'to guess the meaning of.');
});

check('the client states the outcome the server reported, not a bare success', () => {
    assert.ok(/blockedBy === 'draft'/.test(UI) && /blockedBy === 'paused'/.test(UI),
        'the Schedule modal must translate blockedBy into what will actually happen.');
    assert.ok(/starts repeating once you start the search/.test(UI),
        'a schedule saved on a draft has to say that it is not running yet.');
});

console.log(`\n${passed} checks passed.`);
