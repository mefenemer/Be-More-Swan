// tests/schedule-visibility.test.ts
// A draft's publish_date is a PROPOSAL; only pressing Schedule makes it an appointment.
//
// Run:  npx tsx tests/schedule-visibility.test.ts
//
// Two bugs came from ignoring that distinction, and both were silent — nothing threw, nothing was
// logged, the data was correct:
//   • the Content Calendar rendered unapproved drafts next to genuinely scheduled work, so it
//     stopped answering "what is going out"
//   • check-review-urgency emailed "post due in 3h" about drafts nobody had committed, then
//     expired them to 'missed'
//
// src/config/post-status.ts is now the single answer to "is this post's schedule live", and this
// file guards the three ways that answer can quietly stop being single:
//   1. a new status is added to the DB constraint and nobody classifies it
//   2. the browser's generated mirror drifts from the server's list
//   3. the calendar's range query stops filtering on it

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
    SCHEDULE_ACTIVE_STATUSES,
    SCHEDULE_INACTIVE_STATUSES,
    isScheduleActive,
} from '../src/config/post-status';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('\nSchedule visibility\n');

// ── 1. The classification covers the real status vocabulary ─────────────────────────────────────
// Parsed from the CHECK constraint rather than retyped, so adding a status to the database without
// deciding whether it belongs on the calendar fails here instead of defaulting to "hidden".
check('every status the database allows is classified exactly once', () => {
    const sql = read('db/scheduled-posts-status-check.sql');
    const body = sql.slice(sql.lastIndexOf('CHECK (status IN ('));
    const dbStatuses = [...body.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    assert.ok(dbStatuses.length > 5, `expected to parse the status list, got ${JSON.stringify(dbStatuses)}`);

    const classified = [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES];
    for (const s of dbStatuses) {
        const hits = classified.filter(c => c === s).length;
        assert.strictEqual(hits, 1,
            `status '${s}' is allowed by scheduled_posts_status_check but appears ${hits} times in src/config/post-status.ts — decide whether it belongs on the calendar`);
    }
    for (const s of classified) {
        assert.ok(dbStatuses.includes(s), `src/config/post-status.ts classifies '${s}', which the database no longer allows`);
    }
});

check('an uncommitted draft is never treated as scheduled', () => {
    for (const s of ['draft', 'pending_approval', 'in_review']) {
        assert.strictEqual(isScheduleActive(s), false, `'${s}' must not count as a live schedule`);
    }
    // Rejected/cancelled/missed were turned down or expired; admin_test is a dry run.
    for (const s of ['rejected', 'cancelled', 'missed', 'admin_test']) {
        assert.strictEqual(isScheduleActive(s), false, `'${s}' must not count as a live schedule`);
    }
    assert.strictEqual(isScheduleActive(null), false);
    assert.strictEqual(isScheduleActive(undefined), false);
    assert.strictEqual(isScheduleActive(''), false);
});

check('committed work stays visible, including the states that need attention', () => {
    for (const s of ['approved', 'scheduled', 'publishing', 'published']) {
        assert.strictEqual(isScheduleActive(s), true, `'${s}' is committed and must stay on the calendar`);
    }
    // These WERE scheduled and now need a human — hiding them would lose the work silently.
    for (const s of ['failed', 'paused']) {
        assert.strictEqual(isScheduleActive(s), true, `'${s}' was scheduled and must stay visible`);
    }
});

// ── 2. The browser's mirror agrees with the server ──────────────────────────────────────────────
// calendar.js filters client-side too (so a post rejected in the panel leaves the grid without a
// reload). It reads the generated mirror instead of its own list — this proves the two agree.
check('window.PlatformConstants.isScheduleActive matches the server', () => {
    const src = read('src/generated/platform-constants.js');
    const sandbox: { PlatformConstants?: any } = {};
    // The generated file is a plain IIFE that assigns to `window`.
    new Function('window', src)(sandbox);
    const pc = sandbox.PlatformConstants;
    assert.ok(pc, 'platform-constants.js did not define window.PlatformConstants');
    assert.deepStrictEqual(pc.scheduleActiveStatuses, [...SCHEDULE_ACTIVE_STATUSES]);

    for (const s of [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES]) {
        assert.strictEqual(pc.isScheduleActive(s), isScheduleActive(s),
            `the browser and the server disagree about '${s}' — run \`npm run gen:constants\``);
    }
    assert.strictEqual(pc.isScheduleActive(null), false);
    assert.strictEqual(pc.isScheduleActive(undefined), false);
});

// ── 3. The calendar's own queries still apply it ────────────────────────────────────────────────
// Source-level, like tests/crosspost-grouping.test.ts: what went wrong was a missing filter, and a
// behavioural test for it needs a database, a session and a rendered grid.
check('the calendar range query filters on the shared status list', () => {
    const src = read('netlify/functions/scheduled-posts.ts');
    assert.match(src, /from\s+'\.\.\/\.\.\/src\/config\/post-status'/,
        'scheduled-posts.ts must import the status rule rather than inlining a status list');
    const rangeQuery = src.slice(src.indexOf('const posts = await db.select()'));
    assert.match(rangeQuery.slice(0, 500), /inArray\(scheduledPosts\.status,\s*\[\.\.\.SCHEDULE_ACTIVE_STATUSES\]\)/,
        'the GET ?from&to range query must exclude posts whose schedule is not live');
});

check('calendar.js asks the generated mirror instead of hardcoding statuses', () => {
    const src = read('calendar.js');
    assert.match(src, /window\.PlatformConstants\.isScheduleActive\(status\)/,
        'calendar.js must read the generated rule');
    const onDate = src.slice(src.indexOf('function _postsOnDate'));
    assert.match(onDate.slice(0, 900), /_scheduleActive\(p\.status\)/,
        '_postsOnDate must drop posts whose schedule is not live');
});

// ── 4. No deadline may be measured against an uncommitted draft ─────────────────────────────────
check('nothing schedules publish-deadline chasing for drafts', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'netlify/functions/check-review-urgency.ts')),
        'check-review-urgency measured a red-zone deadline and a "missed" expiry against a DRAFT publish_date — it was removed deliberately, do not restore it without re-reading src/config/post-status.ts');
    assert.ok(!read('netlify.toml').includes('[functions.check-review-urgency]'),
        'netlify.toml still schedules check-review-urgency');

    // Nothing else may expire a draft to 'missed' on its proposed date either.
    const fnDir = path.join(ROOT, 'netlify/functions');
    const offenders = fs.readdirSync(fnDir)
        .filter(f => f.endsWith('.ts'))
        .filter(f => /status:\s*'missed'/.test(fs.readFileSync(path.join(fnDir, f), 'utf8')));
    assert.deepStrictEqual(offenders, [],
        `these expire posts to 'missed', which only ever applied to uncommitted drafts: ${offenders.join(', ')}`);
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
