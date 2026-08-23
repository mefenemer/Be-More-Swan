// tests/assistant-surface-gaps.test.ts
// Four defects found by reviewing the Blog Writer and Newsletter Assistant end to end, all of the
// same family: a surface that LOOKS wired because the registry entry, the toggle or the button is
// there, over a pipeline that never reaches it. None of them threw, none logged, and all four were
// invisible from the code that declares them.
//
//   1. THE TUNING PICKER READ THE WRONG TABLE. The Learned Directives card is ungated on
//      reviewQueue.kind === 'posts', which correctly includes the Blog Writer — blueprint §4 does
//      steer blog drafting. But the picker fetched get-social-drafts, which only ever selects from
//      scheduledPosts, so a Blog Writer with a full approval queue was told it had nothing to tune.
//   2. A GOAL METRIC WITH NO POLLER. Declaring a metric in goal-metrics.ts is half the job; without
//      a case in poll-goal-telemetry.ts it falls to `default: { value: null }`, which is reported as
//      'unmeasured' — no telemetry, no progress, and deliberately no alert.
//   3. A NOTIFICATION CATEGORY OVER AN EMPTY EVENT STREAM. newsletter_editor is in
//      PUBLISHING_ROLE_KEYS, so the Content & Publishing toggles render on it — while nothing in
//      the newsletter pipeline called createNotification at all.
//   4. A CALENDAR THAT COULD NOT SHOW THE ASSISTANT'S ONLY ARTEFACT. Every assistant gets a
//      Calendar tab and a Calendar quick action; calendar.js fetched posts, blogs, records and
//      follow-ups, and never newsletter issues.
//
// The shared lesson, and why these are worth a test rather than a comment: in this codebase a
// role's surfaces are declared in one file and served from another, and NOTHING checks that the
// two agree. Each check below pins one of those seams.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOAL_METRICS } from '../src/config/goal-metrics';
import { categoryOf } from '../src/utils/notification-actions';
import { PREF_CATEGORIES } from '../src/utils/notification-prefs';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { landmark } from './landmark';

/**
 * Source with comment-only lines and block comments removed.
 *
 * ⚠️ Needed wherever a check asserts a phrase does NOT appear, because the comments in these files
 * deliberately NAME the thing being avoided ("nothing short of delivered may count", "'sending' is
 * blue like 'publishing'"). Asserting over raw source makes the explanation that prevents the bug
 * indistinguishable from the bug, and the only way to pass would be to delete the explanation.
 * Only whole-line `//` comments go, so a `//` inside a string or URL is left alone.
 */
function withoutComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const ASSISTANTS = read('assistants.js');
const TUNE = read('netlify/functions/tune-assistant.ts');
const POLLER = read('netlify/functions/poll-goal-telemetry.ts');
const AUTOPILOT = read('netlify/functions/draft-newsletter-issues.ts');
const SEND = read('src/utils/newsletter-send.ts');
const CALENDAR = read('calendar.js');
const CALENDAR_HTML = read('calendar.html');
const ISSUES_FN = read('netlify/functions/newsletter-issues.ts');
const CATEGORISATION = read('db/notifications-categorization.sql');

async function main() {

// ── 1. The tuning picker reaches whichever table holds this role's drafts ────

await check('the tuning picker branches on the review queue SOURCE, not its kind', () => {
    const picker = ASSISTANTS.slice(
        landmark(ASSISTANTS, 'window._openTuningPicker = async function'),
        landmark(ASSISTANTS, 'window._openTuningPicker = async function') + 3200,
    );
    // kind is 'posts' for BOTH the SMM and the Blog Writer, so it cannot be the discriminator.
    assert.match(picker, /_detailReviewQueue \|\| \{\}\)\.source === 'blog_posts'/,
        'source is what says which table the drafts are in');
    assert.match(picker, /functions\/blog-posts\?assistantId=/, 'a Blog Writer must be offered its blogs');
    assert.match(picker, /functions\/get-social-drafts\?status=pending_approval/, 'and a social role its posts');
    // Both arms have to reach the SAME session opener, or one of them is a dead row.
    assert.match(picker, /window\._openTuningSession\(\{ \$\{r\.arg\}:\$\{r\.id\} \}\)/);
});

await check('a blog tuning files NO origin_post_id, because that column means a social post', () => {
    // content-rules.ts joins origin_post_id against scheduledPosts to show "the post this rule came
    // from". A blog id there resolves to nothing, or to an unrelated post with the same number.
    const session = ASSISTANTS.slice(
        landmark(ASSISTANTS, 'window._openTuningSession = async function'),
        landmark(ASSISTANTS, 'window._closeTuningSession'),
    );
    assert.match(session, /blogPostId: ctx\.blogPostId \|\| null/, 'carried separately from postId');
    assert.doesNotMatch(session, /postId: ctx\.blogPostId|blogPostId: ctx\.postId/, 'never merged into one field');
    // And the join it would corrupt is still there, so this is not a stale worry.
    assert.match(read('netlify/functions/content-rules.ts'), /eq\(scheduledPosts\.id, rule\.originPostId\)/);
    // The submit path must not smuggle it across either.
    const submit = ASSISTANTS.slice(
        landmark(ASSISTANTS, 'window._submitTuning = async function'),
        landmark(ASSISTANTS, 'window._tuningRevisePost'),
    );
    assert.match(submit, /postId: _tuningCtx\.postId/, 'the social id is still sent');
    assert.doesNotMatch(submit, /postId: _tuningCtx\.blogPostId/);
});

await check('the directive prompt names the artefact, and only from a closed list', () => {
    assert.doesNotMatch(TUNE, /You turn a social media manager's correction/,
        'the prompt is shared by every role whose work reads blueprint §4');
    assert.match(TUNE, /\$\{contentKind\}/, 'the noun is parametrised');
    // ⚠️ The value lands inside a system prompt, so a free-text passthrough would be prompt
    // injection carrying a session cookie.
    assert.match(TUNE, /body\.contentKind === 'blog post' \? 'blog post' : 'post'/,
        'a closed list, never the raw request value');
});

// ── 2. Every internal metric in the catalogue can actually be measured ───────

await check('every non-manual internal goal metric has a case in the poller', () => {
    // The generalisation of the bug rather than a spot-check of the two that were missing: the
    // catalogue is the promise, this function is the delivery, and nothing else compares them.
    const body = POLLER.slice(landmark(POLLER, 'async function fetchMetric'));
    // source 'internal' is exactly "this function has to compute it": 'connection' metrics come
    // from an integration and 'manual' ones from the user, and both have their own branch in
    // pollOneGoal before fetchMetric is ever reached.
    const missing = GOAL_METRICS
        .filter((m) => m.source === 'internal' && m.available)
        .map((m) => m.key)
        .filter((key) => !body.includes(`case '${key}'`));
    assert.deepStrictEqual(missing, [],
        `declared in goal-metrics.ts but never polled — these read 0% for ever: ${missing.join(', ')}`);
});

await check('subscribers count the ORG, issues count the ASSISTANT', () => {
    const subs = POLLER.slice(
        landmark(POLLER, "case 'newsletter_subscribers'"),
        landmark(POLLER, "case 'newsletter_issues_sent'"),
    );
    // audience_contacts has no assistant_id — the list is shared, so two Newsletter Assistants in
    // one workspace must report the same number.
    assert.match(subs, /audienceContacts\.organisationId, goal\.organisationId/);
    assert.doesNotMatch(subs, /audienceContacts\.assistantId/);
    // ⚠️ Only 'subscribed'. Counting rows would make the goal RISE on an unsubscribe.
    assert.match(subs, /audienceContacts\.status, 'subscribed'/);

    const sent = POLLER.slice(
        landmark(POLLER, "case 'newsletter_issues_sent'"),
        landmark(POLLER, 'Non-social role outcomes'),
    );
    assert.match(sent, /newsletterIssues\.assistantId, goal\.assistantId/, 'assistant-scoped, like posts_published');
    assert.match(sent, /newsletterIssues\.organisationId, goal\.organisationId/, 'and still tenant-filtered');
    // Nothing short of delivered counts — a cadence that drafts and never sends is the failure
    // this metric exists to show.
    assert.match(sent, /newsletterIssues\.status, 'sent'/);
    assert.doesNotMatch(withoutComments(sent), /'sending'|'approved'|'scheduled'/);
});

await check('a missing newsletter migration leaves the goal unmeasured, never a rejected promise', () => {
    // pollGoalTelemetry runs goals under Promise.allSettled, so a 42P01 from an un-migrated
    // environment would drop the goal out of every counter and log nothing at all.
    assert.match(POLLER, /function countOrUnmeasured/);
    assert.match(POLLER, /code !== '42P01' && code !== '42703'\) throw err/, 'any other error is a real fault');
    const subs = POLLER.slice(landmark(POLLER, "case 'newsletter_subscribers'"), landmark(POLLER, 'Non-social role outcomes'));
    assert.strictEqual((subs.match(/countOrUnmeasured/g) || []).length, 2, 'both newsletter cases use it');
});

// ── 3. The newsletter pipeline actually emits the notifications it offers ────

const NL_TYPES = ['newsletter_issue_ready', 'newsletter_issue_sent'];

await check('a newsletter notification type is declared everywhere a type has to be declared', () => {
    for (const type of NL_TYPES) {
        // ⚠️ Through the accessor, not the private map — categoryOf() DEFAULTS to 'informational'
        // for an unknown type, which is the exact silence being tested for. Reading the map would
        // pass the day someone deleted the entry and the accessor started defaulting.
        assert.strictEqual(categoryOf(type), 'state_change', `${type} must be categorised in notification-actions.ts`);
        // A type in no preference category is unreachable from the matrix — the user cannot mute it.
        const cats = PREF_CATEGORIES.filter((c) => (c.types as readonly string[]).includes(type));
        assert.strictEqual(cats.length, 1, `${type} must sit in exactly one preference category`);
        assert.strictEqual(cats[0].key, 'content_calendar');
        // Copy. This catalogue is also the FALLBACK, so the feed can never render blank.
        const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === type);
        assert.ok(tpl, `${type} needs a template`);
        assert.strictEqual(tpl!.type, type);
        // Every variable the copy interpolates must be one the call site declares.
        const declared = new Set(tpl!.variables.map((v) => v.key));
        for (const [, path] of `${tpl!.title} ${tpl!.message}`.matchAll(/\{\{([^}]+)\}\}/g)) {
            assert.ok(declared.has(path.trim()), `${type} renders {{${path.trim()}}} but does not declare it`);
        }
        // The DB mirror, so a fresh apply and the backfill agree with the code map.
        assert.match(CATEGORISATION, new RegExp(`WHEN '${type}' THEN 'state_change'`));
    }
});

await check('both call sites pass category explicitly, so they are right on an un-migrated database', () => {
    // The BEFORE INSERT trigger only stamps when category IS NULL, and an unknown type falls to the
    // 'informational' ELSE — which is how a type ends up sorted as a low-priority notice while the
    // server counts it as an action item. Passing it removes the dependency on re-running the SQL.
    for (const src of [AUTOPILOT, SEND]) {
        assert.match(src, /category: 'state_change'/);
    }
});

await check('the autopilot tells somebody it drafted — it is the whole point of the cron', () => {
    assert.match(AUTOPILOT, /createNotification\(db, 'newsletter_issue_ready'/);
    // ⚠️ Non-fatal. A notification failing must not roll back a draft that was written.
    assert.match(AUTOPILOT, /'newsletter_issue_ready'[\s\S]{0,600}?\}\)\.catch\(/, 'never fatal to the draft');
    // Emitted AFTER the row reaches pending_approval — announcing a bare 'draft' would point at
    // something that does not read as waiting for a decision.
    assert.ok(
        landmark(AUTOPILOT, "status: 'pending_approval'") < landmark(AUTOPILOT, "'newsletter_issue_ready'"),
        'announced only once it is actually waiting for a human',
    );
    // And it still never sends — the structural promise this cron is built on.
    assert.doesNotMatch(AUTOPILOT, /newsletterSends|sendDueIssues/);
});

await check('the send notification rides the once-per-issue guard, not the status update', () => {
    // `finished` is the returning() of a status-guarded UPDATE: it is the one place in the worker
    // that runs exactly once per issue, which is why the webhook already lives there.
    const block = SEND.slice(landmark(SEND, 'if (finished) {'), landmark(SEND, 'if (finished) {') + 1400);
    assert.match(block, /createNotification\(db, 'newsletter_issue_sent'/);
    assert.match(block, /event: 'newsletter\.sent'/, 'beside the webhook, under the same guard');
    // ⚠️ A resolved noun phrase, not a bare count — the merge engine has no plural rules, and
    // "1 subscribers" lands on the first test send a tenant ever does.
    assert.match(block, /delivered === 1 \? 'subscriber' : 'subscribers'/);
});

// ── 4. A scheduled issue reaches the calendar ────────────────────────────────

await check('the calendar has a feed that does not drag the whole Studio payload with it', () => {
    assert.match(CALENDAR, /functions\/newsletter-issues\?from=/);
    const feed = ISSUES_FN.slice(landmark(ISSUES_FN, 'Calendar feed'), landmark(ISSUES_FN, 'if (idParam) {'));
    assert.match(feed, /json\(200, \{ issues: rows \}\)/);
    // ⚠️ Only what is going to happen or has happened. A draft has no agreed date, and plotting one
    // states a send date nobody committed to.
    assert.match(feed, /\['scheduled', 'sending', 'sent'\]/);
    assert.doesNotMatch(withoutComments(feed), /'pending_approval'|'draft'/);
    assert.match(feed, /newsletterIssues\.organisationId, orgId/, 'tenant-filtered like every other read here');
});

await check('a sent issue is not rendered as a Draft', () => {
    // Every status a chip can carry needs a STATUS_META entry: the fallback is STATUS_META.draft,
    // so a SENT issue would render labelled "Draft" — the failure paused_credits documents.
    for (const status of ['sending', 'sent']) {
        assert.match(CALENDAR, new RegExp(`\\n\\s{4}${status}:\\s+\\{ label:`), `STATUS_META needs ${status}`);
    }
});

await check('issues render in all three views, and can be filtered like any other destination', () => {
    // A gap in any ONE of these is the shape of the original bug: present where it was added,
    // absent where it was not.
    assert.strictEqual((CALENDAR.match(/_issueChip/g) || []).length >= 4, true,
        'declared plus month, week and list');
    assert.match(CALENDAR, /dayIssues\.map\(_issueChip\)/, 'month');
    assert.match(CALENDAR, /_newsletterIssuesOnDate\(d\)\.map\(_issueChip\)/, 'week');
    assert.match(CALENDAR, /\(issues \|\| \[\]\)\.map\(_issueChip\)/, 'list');
    // The list tabs span three vocabularies for the same two moments.
    assert.match(CALENDAR, /scheduled: new Set\(\[[^\]]*'sending'\]\)/);
    assert.match(CALENDAR, /published: new Set\(\['published', 'sent'\]\)/);
    // The filter is only usable if the option exists.
    assert.match(CALENDAR, /_matchesPlatformFilter\('newsletter'\)/);
    assert.match(CALENDAR_HTML, /<option value="newsletter">Newsletter<\/option>/);
});

await check('a sending issue is plotted on its due date, not on an unstamped sentAt', () => {
    // sentAt is not written until the LAST recipient is done, so a local-time send spread over 24h
    // would vanish from the calendar for the whole day it is being sent.
    const on = CALENDAR.slice(
        landmark(CALENDAR, 'function _newsletterIssuesOnDate'),
        landmark(CALENDAR, 'function _issueChip'),
    );
    assert.match(on, /i\.status === 'sent' \? \(i\.sentAt \|\| i\.scheduledFor\) : i\.scheduledFor/);
    assert.match(on, /_matchesAssistantFilter\(i\.assistantId\)/, 'the per-assistant Calendar tab depends on it');
});

await check('clicking an issue opens the Studio through the existing deep link', () => {
    assert.match(CALENDAR, /window\._newsletterInitialIssueId = id/);
    // The hook has to still be consumed at the other end, or the chip opens an empty Studio.
    assert.match(read('newsletter.js'), /window\._newsletterInitialIssueId;\n\s*window\._newsletterInitialIssueId = null;/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
