// tests/calendar-review-ux.test.ts — the Calendar + Review fixes from the UX/UI review (2026-10-23).
//
// Each check pins one behaviour a person relies on, where the old code did the opposite silently:
//   • a post dragged onto a past day went out immediately (no refusal, client or server)
//   • a failed load read as an empty, all-clear page on both screens
//   • "Needs attention" meant different posts on the two pages
//   • the two pages used different words for the same state
//   • Review cards never said when a post goes out, and were ordered by when the AI wrote them
//
// No database: pure-function checks plus source-consistency checks, like the rest of tests/.
// Run:  npx tsx tests/calendar-review-ux.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    NEEDS_ATTENTION_STATUSES, POST_STATUS_LABELS, REVIEW_QUEUE_STATUS_FAMILIES, ATTENTION_STATUSES,
    CREATED_STATUSES, BOOKED_STATUSES,
} from '../src/config/post-status';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const calendar = read('calendar.js');
const calendarHtml = read('calendar.html');
const workspace = read('workspace.html');
const reviewHtml = read('review-queue.html');
const scheduledPosts = read('netlify/functions/scheduled-posts.ts');
const socialDrafts = read('netlify/functions/get-social-drafts.ts');
const generated = read('src/generated/platform-constants.js');

/** Text from `start` up to the next top-level function (or `end`), asserting the marker exists. */
function slice(src: string, start: string, end = '\nfunction '): string {
    const at = src.indexOf(start);
    assert.notEqual(at, -1, `marker not found: ${start} — an empty slice would pass every check`);
    const rest = src.slice(at + start.length);
    const stop = rest.indexOf(end);
    return stop === -1 ? rest : rest.slice(0, stop);
}

// ── 1. The past is refused, on both halves ───────────────────────────────────
console.log('A post cannot be moved into the past');

check('the server refuses a past publishDate on a committed post (code PAST_DATE)', () => {
    const patch = slice(scheduledPosts, "if (event.httpMethod === 'PATCH')", '// ── POST');
    assert.match(patch, /if \(body\.publishDate\)[\s\S]{0,1200}Date\.now\(\) - 60_000[\s\S]{0,300}PAST_DATE/,
        'scheduled-posts PATCH no longer refuses a past time — a dragged chip would publish at once');
    assert.match(patch, /\['draft', 'pending_approval', 'in_review'\]\.includes/,
        'drafts must stay free to carry any proposed date (approving re-checks it)');
});

check('the calendar refuses a past instant BEFORE it sends anything', () => {
    const move = slice(calendar, 'async function _movePost(');
    const guard = move.indexOf('_refusePast(');
    const send = move.indexOf('fetch(');
    assert.ok(guard !== -1 && send !== -1 && guard < send, '_movePost must call _refusePast before its PATCH');
    assert.match(slice(calendar, 'async function _refusePast('), /newDate\.getTime\(\) > Date\.now\(\)[\s\S]{0,400}alertModal/,
        '_refusePast must compare instants and explain the refusal in a dialog');
});

check('a drop and "Move…" reach the same move function', () => {
    const drop = slice(calendar, 'window._calDrop = function', '\n};');
    assert.match(drop, /_movePost\(post, _dropTarget\(dateKey, post\.publishDate\), \{ confirm: true \}\)/,
        'a post drop must go through _movePost with a confirmation');
    const move = slice(calendar, 'window._calMove = async function', '\n};');
    for (const fn of ['_movePost', '_moveBlog', '_moveRecord', '_moveFollowUp']) {
        assert.ok(move.includes(fn), `"Move…" no longer routes to ${fn}`);
    }
    assert.match(move, /inputType: 'datetime-local'/, '"Move…" must ask for a date AND time');
});

check('the bespoke reschedule modal is gone; dialogs.js confirms instead', () => {
    assert.ok(!calendarHtml.includes('modal-reschedule'), '#modal-reschedule is back in calendar.html');
    assert.ok(!/_calConfirmReschedule|_pendingReschedule/.test(calendar), 'the old modal plumbing is back');
    assert.match(read('dialogs.js'), /inputType/, 'promptModal lost its inputType option');
});

// ── 2. A failure is never an all-clear ───────────────────────────────────────
console.log('A failed load is said, with a retry');

check('the calendar tracks a failed feed separately from an empty one', () => {
    const load = slice(calendar, 'async function _loadAndRender(');
    assert.match(load, /let failed = false/, '_loadAndRender no longer tracks failure');
    assert.match(load, /_loadError = failed/, 'the failure is not committed to state');
    assert.match(slice(calendar, 'function _render('), /role="alert"[\s\S]{0,600}_calRetry\(\)/,
        'the calendar no longer shows an error with a Try again');
    assert.match(slice(calendar, 'function _renderList('), /if \(_loading\)[\s\S]{0,400}if \(_loadError\)/,
        'the List view must not show its empty message while loading or after a failure');
});

check('Review treats a non-OK answer as a failure, not as "no posts"', () => {
    const render = slice(workspace, 'async function rqRenderGroups(');
    assert.match(render, /if \(!pRes\.ok\) throw new Error/, 'a 500 would render the empty "nothing to approve" state');
    assert.match(render, /_rqRenderLoadError\(container\)/, 'no error state with a retry');
    assert.match(slice(workspace, 'function _rqRenderLoadError('), /Try again/, 'the error state lost its retry');
});

check('a background refresh keeps the pages on screen and does not flash "Loading…"', () => {
    const render = slice(workspace, 'async function rqRenderGroups(');
    assert.match(render, /const quiet = !!opts\.quiet/, 'rqRenderGroups lost its quiet mode');
    assert.match(render, /Math\.max\(RQ_PAGE_SIZE, shownGroups\)/, 'a quiet refresh must re-read every page already shown');
    assert.match(workspace, /rqRefreshVisibleReviewSurface\(\{ quiet: true \}\)/, 'the 60s poll no longer refreshes quietly');
});

// ── 3. One vocabulary ────────────────────────────────────────────────────────
console.log('Both pages mean the same thing by the same words');

check('Needs attention = failed + both paused states, on both pages', () => {
    assert.deepEqual([...NEEDS_ATTENTION_STATUSES].sort(), ['failed', 'paused', 'paused_credits']);
    assert.deepEqual(REVIEW_QUEUE_STATUS_FAMILIES.attention, NEEDS_ATTENTION_STATUSES);
    assert.match(workspace, /attention: \{ label: 'Needs attention', postStatus: 'attention'/,
        "Review's Needs attention tab must request the family, not status=failed alone");
    assert.match(slice(calendar, 'function _renderList('), /needsAttentionStatuses/,
        "the Calendar's Needs attention tab must read the same generated list");
});

check('the tiles still count a paused post once', () => {
    // NEEDS_ATTENTION is for TABS. The Created tile is a union; paused is already BOOKED.
    assert.deepEqual([...ATTENTION_STATUSES], ['failed']);
    const created = CREATED_STATUSES as readonly string[];
    assert.equal(created.filter(s => s === 'paused').length, 1, 'paused is counted twice in Created');
    assert.ok((BOOKED_STATUSES as readonly string[]).includes('paused'));
});

check('one set of labels, mirrored to the browser, read by both pages', () => {
    assert.equal(POST_STATUS_LABELS.published, 'Posted');
    assert.equal(POST_STATUS_LABELS.failed, 'Failed to post');
    assert.equal(POST_STATUS_LABELS.paused, 'Paused · reconnect');
    assert.equal(POST_STATUS_LABELS.pending_approval, POST_STATUS_LABELS.in_review);
    assert.match(generated, /postStatusLabel: function/, 'regenerate src/generated/platform-constants.js (npm run gen:constants)');
    assert.match(generated, new RegExp(JSON.stringify(POST_STATUS_LABELS).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'the generated labels are stale — npm run gen:constants');
    assert.match(calendar, /pc\.postStatusLabel\(status\)/, 'the calendar no longer reads the shared labels');
    assert.match(slice(workspace, 'function _rqStateChip('), /pc\.postStatusLabel\(post\.status\)/, 'the Review chip no longer reads the shared labels');
});

check('"posted" is green, never emerald (which is the brand pink here)', () => {
    const meta = slice(calendar, 'const STATUS_META = {', '\n};');
    assert.match(meta, /published:\s*\{[^}]*bg-green-100/, 'the posted badge is not green');
    assert.ok(!/emerald-[3-6]00/.test(calendar), 'calendar.js uses emerald-300..600, which render GREEN beside pink');
    assert.ok(!/class="[^"]*border-emerald-600/.test(reviewHtml) && !/'border-emerald-600', 'text-emerald-700'\); active/.test(workspace),
        'the Review tab underline is back on emerald-600 (green under pink text)');
});

// ── 4. Review says when, and in that order ───────────────────────────────────
console.log('Review cards say when they go out, soonest first');

check('the server can order by go-out time, for the page keys AND the rows', () => {
    assert.match(socialDrafts, /sort === 'publish'/, 'get-social-drafts lost sort=publish');
    assert.equal((socialDrafts.match(/\.orderBy\(\.\.\.pageOrder\)/g) || []).length, 2,
        'the page keys and the rows must be ordered the same way, or a page boundary drifts');
});

check('the To approve tab asks for that order and the card states the date', () => {
    assert.match(workspace, /review:\s*\{ label: 'To approve', postStatus: 'pending_approval', sort: 'publish' \}/);
    const card = slice(workspace, 'function rqRenderSocialCard(');
    assert.match(card, /Goes out \$\{fmt\(draft\.publishDate\)\}/, 'the card no longer says when it goes out');
    assert.match(card, /Was due/, 'a failed post must not claim it "goes out"');
    assert.match(card, /<button type="button" onclick="openPostReview/, 'the card is no longer a keyboard-reachable button');
});

// ── 5. Reachable without a mouse ─────────────────────────────────────────────
console.log('Everything opens from the keyboard');

check('calendar chips are focusable buttons, activated by one delegated listener', () => {
    const chip = slice(calendar, 'function _postChip(');
    assert.match(chip, /role="button" tabindex="0" data-cal-activate/, 'the post chip is not keyboard-reachable');
    assert.match(calendar, /document\.addEventListener\('keydown'[\s\S]{0,300}\[data-cal-activate\][\s\S]{0,120}el\.click\(\)/,
        'Enter/Space no longer open a chip');
});

check('the Review tabs are tabs', () => {
    assert.match(reviewHtml, /role="tablist"/);
    assert.match(slice(workspace, 'function rqOpenStatus('), /setAttribute\('aria-selected', 'true'\)/);
});

console.log(`\n${passed} checks passed`);
