// tests/first-draft-on-hire.test.ts
// Two failures that both present as "I hired an assistant and it does nothing".
//
// 1. NOTHING STARTED THE WORK.
//    Completing onboarding wrote the cadence and the horizon and enqueued nothing, so the first
//    drafts waited for the next gap-fill cron. blog-horizon-fill runs ONCE A DAY at 05:00 UTC, so a
//    Blog Writer hired at 07:57 (prod assistant 6, Lyra, 2026-08-18) sat idle for 21 hours with
//    nothing in the product explaining the silence. Indistinguishable from a broken pipeline.
//
// 2. THE SCHEDULE UI PROMISED MORE THAN THE ENGINE DELIVERS.
//    Ticked days are ELIGIBLE days; the FREQUENCY sets the rate and selectWeeklySlots picks which
//    ticked days carry it. "Weekly" across Mon-Fri is ONE post, on Wednesday. The Autopilot card
//    rendered the ticked days verbatim ("once a week · weekdays"), which reads as five.
//
// Pure: no network, no DB.
// Run:  npx tsx tests/first-draft-on-hire.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { selectWeeklySlots, postsPerWeekFor } from '../src/config/posting-cadence';
import { landmark } from './landmark';

let passed = 0;
const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const saveFn = read('../netlify/functions/update-assistant-context.ts');

console.log('\nCompleting onboarding starts the work\n');

check('update-assistant-context enqueues a gap-fill, so the first drafts do not wait for cron', () => {
    assert.ok(saveFn.includes('enqueueBlogGapFill'), 'blog engine is never reached from the save path');
    assert.ok(saveFn.includes('enqueueScheduleGapFill'), 'social engine is never reached from the save path');
});

check('the fill is ROLE-ROUTED — blog and social keep separate queues and draft tables', () => {
    // Sending a Blog Writer through the social engine builds a scheduled_post from a blueprint the
    // job does not have; sending a social assistant through the blog one writes to blog_posts.
    const start = landmark(saveFn, 'const result = BLOG_WRITER_ROLE_KEYS.includes(');
    const slice = saveFn.slice(start, start + 400);
    assert.ok(slice.includes('enqueueBlogGapFill'), 'the blog branch is not on the role test');
    assert.ok(slice.includes('enqueueScheduleGapFill'), 'the social branch is not on the role test');
});

check('the fill runs only for an ACTIVE assistant', () => {
    // A paused or provisioning-blocked assistant must not start drafting because its context saved.
    assert.ok(/if \(target && target\.isActive\)/.test(saveFn), 'isActive is not gating the fill');
});

check('a fill failure never fails the save', () => {
    // The write is already committed and the cron is still the backstop; throwing here would show
    // the user a failed save for work that actually succeeded.
    const start = landmark(saveFn, 'let draftsQueued = 0;');
    const slice = saveFn.slice(start, landmark(saveFn, 'return { statusCode: 200', start));
    assert.ok(slice.includes('try {') && slice.includes('catch'), 'the gap-fill call is not wrapped');
    assert.ok(/console\.warn\(/.test(slice), 'a swallowed failure leaves no trace at all');
});

check('the enqueued count is returned, so the UI can prove the assistant started', () => {
    assert.ok(/JSON\.stringify\(\{ success: true, draftsQueued \}\)/.test(saveFn),
        'draftsQueued is not in the response body');
    const shell = read('../src/components/assistant-onboarding-shell.js');
    assert.ok(shell.includes('renderSuccess(data.draftsQueued)'),
        'the success screen ignores the count and keeps promising work it cannot evidence');
});

console.log('\nThe schedule UI states what the engine will actually do\n');

// Lyra's real configuration, prod assistant 6.
const LYRA_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;

check('Weekly across five ticked days is ONE post, on Wednesday', () => {
    const pattern = selectWeeklySlots([...LYRA_DAYS], ['09:00'], postsPerWeekFor('Weekly'));
    assert.equal(pattern.length, 1);
    assert.deepEqual(pattern[0], { day: 'wed', time: '09:00' });
});

check('the browser gets the scheduler’s OWN day-picker, not a second implementation', () => {
    // The card had a private cadence regex once; it disagreed with the engine and a live tenant's
    // autopilot read as Active while nothing was drafted. One parser, stringified, or this recurs.
    const generated = read('../src/generated/platform-constants.js');
    assert.ok(generated.includes('var selectWeeklySlots = function selectWeeklySlots('),
        'selectWeeklySlots is not stringified into the client bundle');
    for (const freeVar of ['var MONDAY_FIRST =', 'var DEFAULT_POSTING_DAYS =', 'var DEFAULT_POSTING_TIMES =']) {
        assert.ok(generated.includes(freeVar), `${freeVar} missing — the stringified copy cannot resolve it`);
    }
    assert.ok(generated.includes('weeklyPattern:'), 'weeklyPattern is not exposed on window.PostingCadence');
});

check('the browser copy AGREES with the server for Lyra’s exact settings', () => {
    // Evaluate the generated bundle the way a page does, then compare against the real function.
    const generated = read('../src/generated/platform-constants.js');
    const win: any = {};
    new Function('window', generated)(win);
    const fromBrowser = win.PostingCadence.weeklyPattern([...LYRA_DAYS], ['09:00'], 'Weekly');
    const fromServer = selectWeeklySlots([...LYRA_DAYS], ['09:00'], postsPerWeekFor('Weekly'));
    assert.deepEqual(fromBrowser, fromServer);
});

check('the Autopilot card names the days it will USE, not the days that were ticked', () => {
    const js = read('../assistants.js');
    const start = landmark(js, 'function _autopilotSummary(ctx)');
    const slice = js.slice(start, landmark(js, 'function _syncAutopilotPending', start));
    assert.ok(slice.includes('weeklyPattern'), 'the summary still derives days from raw posting_days');
    // daysLabel must be built from the pattern's days, not the ticked set.
    const daysLabelAt = landmark(slice, 'const daySet = new Set(usedDays)');
    assert.ok(daysLabelAt > landmark(slice, 'const usedDays ='),
        'daySet is computed before the pattern narrows it');
    assert.ok(slice.includes('narrowed'), 'the card cannot tell the user their extra days are unused');
});

check('the days control shows the resulting plan, and the old misleading hint is gone', () => {
    const html = read('../assistant-detail.html');
    assert.ok(html.includes('id="posting-days-outcome"'), 'no live outcome line under the day checkboxes');
    assert.ok(html.includes('id="posting-days-narrowed"'), 'no place to say which ticked days go unused');
    assert.ok(!html.includes('Posts are only scheduled on the days you select.'),
        'the old hint still implies every ticked day gets a post');
});

check('the outcome line asks the shared parser rather than counting ticked boxes', () => {
    const js = read('../assistants.js');
    const start = landmark(js, 'window._syncScheduleOutcome = function ()');
    const slice = js.slice(start, start + 3200);
    assert.ok(slice.includes('cadence.weeklyPattern('), 'the outcome line does not use the scheduler');
    assert.ok(slice.includes("reading.kind === 'on_demand'"), 'on-demand is not distinguished');
    assert.ok(slice.includes("reading.kind === 'unrecognised'"),
        'an unparseable cadence renders as a working schedule — the exact bug that hid for weeks');
});

console.log(`\n${passed} checks passed\n`);
