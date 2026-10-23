// tests/calendar-review-ux.test.ts — the Calendar + Review fixes from the UX/UI review (2026-10-23).
//
// Each check pins one behaviour a person relies on, where the old code did the opposite silently:
//   • a post dragged onto a past day went out immediately (no refusal, client or server)
//   • a failed load read as an empty, all-clear page on both screens
//   • "Needs attention" meant different posts on the two pages
//   • the two pages used different words for the same state
//   • Review cards never said when a post goes out, and were ordered by when the AI wrote them
//   • (second pass) approve said "Let Nova choose the time" beside a card saying "Goes out Tue 09:00",
//     the Calendar sent you to Review to approve what it could open itself, "Posted" was ~2.5:1 ink,
//     and the whole Review list was a live region that screen readers re-read on every refresh
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
const blogPostsFn = read('netlify/functions/blog-posts.ts');
const sidebar = read('components/sidebar.html');
const manualPost = read('netlify/functions/create-manual-post.ts');
const dialogs = read('dialogs.js');
const inputCss = read('input.css');
const styleCss = read('style.css');

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
    assert.match(card, /Suggested for \$\{fmt\(draft\.publishDate\)\}/, 'an unapproved draft must say its date is a suggestion');
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

// ── 6. Second pass (2026-10-23) ──────────────────────────────────────────────
console.log('Approving says what happens, and the two pages agree');

check('the approve option names the suggested time, not "let the assistant choose"', () => {
    assert.ok(!workspace.includes('>Publishes at the next good slot<'), 'the old approve subtitle is back');
    assert.match(workspace, /textContent = `Approve for \$\{at\}`/, 'approve no longer names the time it lands on');
});

check('an assistant draft opens on the decision step, unless it is locked', () => {
    const fn = slice(workspace, 'function _railOpenDecisionForDraft(');
    assert.match(fn, /'pending_approval', 'in_review'/);
    assert.match(fn, /step\.enabled && !step\.enabled\(post\)/, 'a locked step must not be opened');
    assert.match(slice(workspace, 'async function openPostReview('), /if \(freshOpen\) _railOpenDecisionForDraft\(\)/);
});

check('the Calendar draft chip no longer sends you to Review to approve', () => {
    assert.ok(!calendar.includes('approve it in Review'), 'the chip opens the editor; it must say so');
});

check('the reject toast can take you to the archive it names', () => {
    assert.match(dialogs, /opts\.action && opts\.action\.label/);
    const fn = slice(workspace, 'async function rqReviewReject(');
    assert.match(fn, /_assistantDetailInitialRqStatus = 'archived'/);
});

check('failed articles say why, on the Review card and the Calendar chip', () => {
    assert.match(slice(workspace, 'function rqRenderBlogCard('), /post\.failureReason/);
    assert.match(slice(calendar, 'function _blogChip('), /post\.failureReason/);
    const range = slice(blogPostsFn, 'if (fromParam && toParam)', 'return { statusCode: 200');
    assert.match(range, /failureReason: blogPosts\.failureReason/, 'the calendar range query must return the reason');
});

check('"Posted" uses the readable ink, and Scheduled is blue on both pages', () => {
    assert.ok(inputCss.includes('.status-posted { color: #0a6b30; }') && styleCss.includes('.status-posted { color: #0a6b30; }'),
        'the .status-posted component must be in input.css AND the compiled style.css');
    assert.ok(!/text-green-700/.test(calendar), 'calendar.js went back to the ~2.5:1 neon green');
    assert.match(workspace, /published:\s+\{ cls: '[^']*status-posted/);
    assert.match(calendar, /scheduled:\s+\{ label: 'Scheduled',\s+badge: 'bg-blue-100/);
});

check('the Review list is not a live region; a short summary is announced instead', () => {
    assert.ok(!/id="rq-groups"[^>]*aria-live/.test(reviewHtml), '#rq-groups is a live region again');
    assert.match(reviewHtml, /id="rq-status"[^>]*aria-live="polite"/);
    const fn = slice(workspace, 'async function rqRenderGroups(');
    assert.match(fn, /if \(!quiet\)[\s\S]{0,200}rq-status/, 'the summary must not be announced on the quiet refresh');
    assert.match(fn, /refocusSel/, 'a refresh must put keyboard focus back');
});

check('Month view is not offered on a phone', () => {
    assert.match(calendarHtml, /id="view-month"[\s\S]{0,120}phone-hidden/);
    assert.match(slice(calendar, 'function _setView('), /v === 'week' \|\| v === 'month'\) && _isPhone\(\)/);
});

// ── 7. Third pass (2026-10-23) ───────────────────────────────────────────────
console.log('Empty states, confirmations and announcements');

check('"Publish again now" confirms first; "Re-queue for then" does not', () => {
    const fn = slice(workspace, 'async function rqFailedRetry(');
    assert.match(fn, /if \(!publishDate\)[\s\S]{0,400}confirmModal/, 'an immediate republish must confirm');
});

check('the "Ready? Open Schedule & publish" hint hides while that step is open', () => {
    assert.match(slice(workspace, 'function _railRender('), /post-review-draft-hint'\)\?\.classList\.toggle\('hidden', _railOpen === 'when'/);
});

check('the Calendar grids say when there is nothing on them, and Review has one all-clear', () => {
    assert.match(slice(calendar, 'function _render('), /_gridIsEmpty\(\)/);
    assert.match(slice(workspace, 'async function rqRenderGroups('), /allEmpty[\s\S]{0,200}rqAllClear\(statusKey\)/);
    assert.match(slice(workspace, 'function rqAllClear('), /You’re all caught up/);
});

check('error toasts are announced and stay up longer', () => {
    const fn = slice(dialogs, 'window.showToast = function', '\n};');
    assert.match(fn, /isError \? 'alert' : 'status'/);
    assert.match(fn, /isError \? 8000 : 4000/);
});

check("the Calendar's Needs attention tab states its scope and links to Review's", () => {
    assert.match(slice(calendar, 'function _renderList('), /_rqInitialStatus='attention'/);
    assert.match(reviewHtml, /window\._rqInitialStatus === 'attention'/);
});

check('the Calendar list tabs rove, with arrow keys', () => {
    assert.match(slice(calendar, 'function _renderList('), /tabindex="\$\{active \? 0 : -1\}"/);
    assert.match(calendar, /closest\('\[data-cal-list-tab\]'\)/);
});

check('pulsing markers respect reduced motion', () => {
    for (const css of [inputCss, styleCss]) assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]{0,80}animation: none !important/);
});

// ── 8. Fourth pass (2026-10-23) ──────────────────────────────────────────────
console.log('Badge, creating and moving from the calendar, deciding on a phone, Review all');

check('the sidebar Review pill is readable, labelled, and counts articles like the tab', () => {
    assert.match(sidebar, /pending-badge bg-amber-400 text-gray-900/);
    assert.match(slice(workspace, 'function _rqSetPendingBadge('), /aria-label', `\$\{n\} to approve`/);
    assert.match(slice(workspace, 'async function refreshPendingBadge('), /_rqBlogReviewCount\(\)/);
    assert.match(slice(workspace, 'async function _rqBlogReviewCount('), /blog-posts\?countReview=1/);
    assert.match(blogPostsFn, /countReview === '1'[\s\S]{0,400}'draft', 'pending_approval', 'in_review'/);
});

check('the Calendar can start a post, for a clicked future day', () => {
    assert.match(calendarHtml, /id="cal-new-post"/);
    assert.match(slice(calendar, 'window._calNewPost = function'), /_gpPrefillPublishDate/);
    assert.match(workspace, /window\._gpPrefillPublishDate \? \{ publishDate: window\._gpPrefillPublishDate \}/);
    assert.match(manualPost, /asked > now/, 'a past date must not become the draft\'s time');
    // No hand-written ?v= on any local script: scripts/stamp-view-version.mjs stamps every one with
    // the deploy's commit, but SKIPS a src that already has a query — so a manual pin froze
    // calendar.js on 20261012 through two releases (and assistants.js on 20261021).
    assert.ok(!/<script\b[^>]*\bsrc="\/[^"]+\.js\?v=/.test(workspace), 'a manual ?v= pin stops the build stamping that script');
});

check('a grid chip that can be dragged can be moved with M, and on touch with a button', () => {
    for (const fn of ['function _postChip(', 'function _blogChip(', 'function _recordChip(', 'function _followUpChip(']) {
        assert.match(slice(calendar, fn), /data-cal-move="/, `${fn} lost its move hook`);
    }
    assert.match(calendar, /e\.key !== 'm' && e\.key !== 'M'[\s\S]{0,400}window\._calMove\(kind, Number\(id\)\)/);
    assert.match(slice(calendar, 'function _render('), /\(hover: none\)[\s\S]{0,400}_moveButton\(kind/);
});

check('on a narrow screen the decision is pinned in the editor footer', () => {
    assert.match(workspace, /id="post-review-decide-bar"/);
    const fn = slice(workspace, 'function _rqSyncDecisionBar(');
    assert.match(fn, /max-width: 1023px/);
    assert.match(fn, /_pceNotReadyReason\(post\)/, 'a locked decision must say why, not show a dead button');
});

check('Review all goes through the waiting posts in a fixed order, each decision moving on', () => {
    assert.match(reviewHtml, /id="rq-review-all-btn"[^>]*onclick="rqReviewAll\(\)"/);
    assert.match(slice(workspace, 'function _rqNextDraftId('), /_rqSessionAdvance/);
    assert.match(slice(workspace, 'async function rqReviewReject('), /_rqSessionContinue\(/);
    assert.match(slice(workspace, 'async function rqReviewDiscardDraft('), /_rqSessionContinue\(/);
    assert.match(slice(workspace, 'function _rqSyncSessionProgress('), /Post \$\{i \+ 1\} of/);
});

// ── 9. Polish pass (2026-10-23) ──────────────────────────────────────────────
console.log('Polish: list rows, previews, phone filters, busy days, undo, cards, wording');

check('list rows are not buttons with a button inside', () => {
    for (const fn of ['function _listRow(', 'function _listFollowUpRow(', 'function _listRecordRow(']) {
        const body = slice(calendar, fn);
        assert.ok(!/role="button"/.test(body), `${fn} is a role=button again, with Move… inside it`);
        assert.match(body, /_rowOpener\(/);
    }
    assert.match(slice(calendar, 'function _moveButton('), /relative z-10/);
});

check('the preview opens on keyboard focus and not on a tap', () => {
    assert.match(calendar, /addEventListener\('focusin'[\s\S]{0,300}_calShowPreview/);
    assert.match(calendar, /event\.type === 'mouseenter' && window\.matchMedia[\s\S]{0,80}\(hover: none\)/);
});

check('phone filters fold behind one button, month cells cap at three', () => {
    assert.match(calendarHtml, /id="cal-filter-toggle"[\s\S]{0,400}id="cal-filters" class="phone-hidden/);
    assert.match(calendar, /const _MONTH_CELL_MAX = 3/);
    assert.match(calendar, /\+\$\{more\} more/);
});

check('every move can be undone, and logos come from one sprite', () => {
    for (const fn of ['async function _movePost(', 'async function _moveBlog(', 'async function _moveRecord(', 'async function _moveFollowUp(']) {
        assert.match(slice(calendar, fn), /_undoMove\(/, `${fn} has no Undo`);
    }
    assert.match(slice(calendar, 'function _platAvatar('), /<use href="#cal-logo-/);
});

check('Review cards: colour means state, the caption gets two lines, rows line up', () => {
    assert.match(workspace, /const RQ_ORIGIN_CLS = 'bg-gray-100 text-gray-700'/);
    const card = slice(workspace, 'function rqRenderSocialCard(');
    assert.match(card, /line-clamp-2/);
    assert.match(card, /sm:hidden inline-flex[^']*Media deleted/);
    assert.match(slice(workspace, 'function rqRenderBlogCard('), /-mx-4 px-4/);
    assert.match(slice(workspace, 'function rqRenderEmailCard('), /-mx-4 px-4/);
    assert.ok(!/function rqRenderCard\(/.test(workspace), 'the dead pending-action card is back');
});

check('the Review page asks for each list once as it opens', () => {
    assert.match(reviewHtml, /refreshPendingBadge\(\{ attentionOnly: true \}\)/);
    assert.equal((workspace.match(/fetch\('\/\.netlify\/functions\/newsletter-issues\?review=1'\)/g) || []).length, 1,
        'newsletter-issues?review=1 must go through _rqNewsletterReviewRes only');
});

check('two verbs for saying no, everywhere', () => {
    assert.ok(!/Reject &amp; archive|Reject & archive|Discard this draft|Archive this post/.test(workspace), 'an old reject/discard wording is back');
    assert.match(workspace, /Reject and redraft/);
    assert.match(workspace, /Remove \(no redraft\)/);
    assert.match(sidebar, /id="nav-review-queue"[\s\S]*id="nav-calendar"/, 'Review sits above Calendar');
});

check('chat cards, the notification, the assistant tab and Blog Studio use the same words', () => {
    const registry = read('src/components/disruptive-ui-registry.js');
    assert.equal((registry.match(/reject: \{ head: 'Reject and redraft', button: 'Reject and redraft'/g) || []).length, 2,
        'the post and article chat cards must both say Reject and redraft');
    assert.match(registry, /A replacement is written either way/, 'the post card must not imply the checkbox controls the redraft');
    const catalog = read('src/utils/notification-templates-catalog.ts');
    assert.ok(!/conversion post/i.test(catalog.replace(/\/\/.*$/gm, '')), 'the notification still says conversion post');
    assert.match(read('assistants.js'), /btn\('delete', 'Remove', danger\)/);
    const studio = read('src/components/blog-studio-modal.js');
    assert.match(studio, /Remove draft/);
    assert.match(studio, /'Reject and redraft' : 'Reject \(no redraft\)'/);
});

console.log(`\n${passed} checks passed`);
