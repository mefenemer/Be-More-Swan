// tests/x-quota-pause.test.ts
//
// 'paused_credits' — the X quota park — and the chain of places that all have to agree about it.
//
// This status is a one-way door if any link is missing, and every link failed independently:
//
//   • The LIVE DATABASE always allowed it (constraint introspected 2026-07-31) — the drift ran
//     DB-ahead-of-code, which is the direction that hides itself. The writes succeeded and the rows
//     then went invisible, rather than erroring where anyone would notice. Every file below carried
//     a stale copy of the constraint, including db/scheduled-posts-status-check.sql itself.
//   • It was absent from PostStatus and from BOTH lists in src/config/post-status.ts, so nothing
//     could reason about it — a parked post fell off the calendar entirely.
//   • It had no STATUS_META entry in calendar.js, where every lookup falls back to
//     STATUS_META.draft — a committed post rendered as "Draft".
//   • A 402 from X's API (quota, not failure) went to handleFailure → 'failed', which NEITHER
//     resume sweep can select. Real consequence, prod, 2026-07-23: an X post died permanently
//     while its LinkedIn sibling in the same cross-post published fine.
//
// The sweeps are the reason all of this matters. Two of them resurrect a parked post — the monthly
// reset in publish-social-posts.ts and the credit-pack top-up in stripe-webhook.ts — and both
// select `status = 'paused_credits' AND platform = 'x'`. A post that never reaches that status, or
// reaches 'failed' instead, is invisible to both forever.
//
// NOT COVERED: the live publish path (needs a DB). These prove the wiring the path depends on.
//
// Run:  npx tsx tests/x-quota-pause.test.ts

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
    SCHEDULE_ACTIVE_STATUSES,
    SCHEDULE_INACTIVE_STATUSES,
    isScheduleActive,
    type PostStatus,
} from '../src/config/post-status';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const publisher = read('netlify/functions/publish-social-posts.ts');
const stripeWebhook = read('netlify/functions/stripe-webhook.ts');
const calendarJs = read('calendar.js');
const schemaTs = read('db/schema.ts');
const constraintSql = read('db/scheduled-posts-status-check.sql');
const clientConstants = read('src/generated/platform-constants.js');

console.log('\nThe status exists everywhere it has to\n');

check('paused_credits is a real PostStatus, and is schedule-ACTIVE', () => {
    // Typed, so a rename cannot silently pass: this line stops compiling if it leaves the union.
    const s: PostStatus = 'paused_credits';
    assert.equal(isScheduleActive(s), true,
        'a post parked on quota is committed work — hiding it from the calendar loses it silently');
    assert.ok((SCHEDULE_ACTIVE_STATUSES as readonly string[]).includes(s));
    assert.ok(!(SCHEDULE_INACTIVE_STATUSES as readonly string[]).includes(s),
        'it must not be in both lists — they partition the status space');
});

check('the DB constraint and db/schema.ts agree that paused_credits is allowed', () => {
    // These two disagreeing is precisely the original bug — in the DB-ahead direction: the live
    // constraint allowed the status while every checked-in copy of it omitted it, so nothing
    // errored and the rows simply went missing from the surfaces that filter on status.
    //
    // tests/schedule-visibility.test.ts already proves the constraint file and src/config are a
    // one-to-one match; what it does NOT check is db/schema.ts, which carries its own copy of the
    // same CHECK and is the copy drizzle would generate from. That third copy is the one left to
    // drift, so it is what this asserts.
    assert.match(constraintSql, /'paused_credits'/, 'the canonical constraint file must allow it');
    // Anchor on the check() CALL, not the name — db/schema.ts also mentions the constraint by name
    // in a comment above it, and matching that proves nothing.
    const schemaCheck = schemaTs.match(/check\("scheduled_posts_status_check"[^\n]*/)?.[0] ?? '';
    assert.ok(schemaCheck, 'could not find the scheduled_posts_status_check definition in db/schema.ts');
    const schemaStatuses = [...schemaCheck.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    const known = [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES] as readonly string[];
    for (const s of known) {
        assert.ok(schemaStatuses.includes(s), `the app can write '${s}' but db/schema.ts's CHECK omits it`);
    }
    for (const s of schemaStatuses) {
        assert.ok(known.includes(s), `db/schema.ts allows '${s}' but src/config/post-status.ts has no such status`);
    }
});

check('the generated client constants carry it, so the browser agrees with the server', () => {
    assert.match(clientConstants, /paused_credits/,
        'run `npm run gen:constants` — workspace.html and calendar.js read isScheduleActive from here');
});

console.log('\nA 402 is quota, not failure\n');

check('a 402 from X routes to pauseForXCredits, never to handleFailure', () => {
    assert.match(publisher, /result\.status === 402[\s\S]{0,200}?pauseForXCredits/,
        'a 402 must reach the pause path; falling through to handleFailure writes an unrecoverable \'failed\'');
});

check('the pause happens AFTER the credit settle, so the hold is refunded', () => {
    // settleXHold(success:false) refunds. Pausing first returns early and leaks the hold on every
    // 402 — the org would be charged for a post that never went out.
    const xArm = publisher.slice(landmark(publisher, "post.platform === 'x'"), landmark(publisher, "post.platform === 'linkedin'"));
    const settleAt = xArm.indexOf('settleXHold');
    const pauseAt = xArm.indexOf('result.status === 402');
    assert.ok(settleAt > -1 && pauseAt > -1, 'both the settle and the 402 branch must be in the X arm');
    assert.ok(settleAt < pauseAt, 'the refund must run before the early return');
});

check('the two pause sources are distinguishable from the row alone', () => {
    // One is fixed by upgrading here, the other only at X. A single generic reason string cannot
    // tell the reviewer which, and sending them to buy an upgrade that cannot help is worse than
    // saying nothing.
    assert.match(publisher, /'x_api_quota_exhausted'/);
    assert.match(publisher, /'x_credits_exhausted'/);
    assert.match(publisher, /httpStatus: 402/, 'the API-detected pause should record the status it saw');
});

check('both pause notifications resolve to real templates', () => {
    for (const key of ['x_credits_exhausted', 'x_api_quota_exhausted']) {
        const tpl = getNotificationDefault(key);
        assert.ok(tpl, `no catalog default for '${key}' — createNotification would have no copy to render`);
        assert.ok((tpl!.message ?? '').length > 0);
    }
    const ledger = getNotificationDefault('x_credits_exhausted')!;
    const api = getNotificationDefault('x_api_quota_exhausted')!;
    assert.notEqual(ledger.message, api.message, 'the two causes need different remediation copy');
    assert.doesNotMatch(api.message, /upgrade your plan/i,
        'an X-side quota cannot be fixed by upgrading here — do not send the user to buy that');
});

console.log('\nA parked post can always be resurrected\n');

check('the monthly reset sweep selects paused_credits', () => {
    assert.match(publisher, /status = 'paused_credits' AND platform = 'x'/);
});

check('a credit-pack purchase also selects paused_credits', () => {
    assert.match(stripeWebhook, /status = 'paused_credits' AND platform = 'x'/,
        'stripe-webhook.ts is the other way out of the park');
});

check('the pause never burns a publish attempt', () => {
    const fn = publisher.slice(landmark(publisher, 'async function pauseForXCredits'));
    const body = fn.slice(0, landmark(fn, '\n}\n'));
    assert.ok(!/attempt_count/.test(body),
        'a quota pause is not a failed attempt — counting it would eventually exhaust MAX_ATTEMPTS');
});

console.log('\nThe calendar can render it\n');

check('calendar.js has a STATUS_META entry, so it is not labelled "Draft"', () => {
    // Every lookup is `STATUS_META[status] || STATUS_META.draft`, so a missing entry does not throw
    // — it quietly mislabels a committed post as an uncommitted one.
    assert.match(calendarJs, /paused_credits:\s*\{[^}]*label:/,
        'a missing entry falls back to STATUS_META.draft');
    const meta = calendarJs.match(/paused_credits:\s*\{[^}]*\}/)?.[0] ?? '';
    assert.doesNotMatch(meta, /label: 'Draft'/);
    assert.match(meta, /badge:/);
    assert.match(meta, /chipBorder:/);
    assert.match(meta, /dot:/);
});

check('a mixed cross-post group reports the parked sibling, not the published one', () => {
    const priority = calendarJs.match(/_GROUP_STATUS_PRIORITY = \[([^\]]+)\]/)?.[1] ?? '';
    assert.match(priority, /paused_credits/, 'otherwise the group falls through to members[0].status');
    const order = priority.split(',').map(s => s.trim().replace(/'/g, ''));
    assert.ok(landmark(order, 'paused_credits') < landmark(order, 'published'),
        'a group is never "done" while a sibling is still parked on quota');
});

console.log(`\n${passed} passed\n`);
