// tests/swanjira-2026-11-01.test.ts
// Source checks for the first batch of SwanJira tickets raised by the browser tester on staging
// (2026-11-01). Each check names its ticket; the fix is described in the code it reads.
//
// Run:  npx tsx tests/swanjira-2026-11-01.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(p, 'utf8');

// ── SWAN-4 / SWAN-10: one rule for "waiting for review", archived assistants excluded ──────────
const awaiting = read('src/utils/awaiting-review.ts');
const drafts = read('netlify/functions/get-social-drafts.ts');
const assistants = read('netlify/functions/get-assistants.ts');
const scheduled = read('netlify/functions/scheduled-posts.ts');

check('SWAN-4: Review and the per-assistant count share one definition', () => {
    assert.match(awaiting, /export function awaitingReview\(\)/);
    assert.match(drafts, /contentfulDraft\(\)/);
    assert.match(assistants, /awaitingReview\(\),/);
});

check('SWAN-4: the per-assistant count is one per card, not one per platform row', () => {
    assert.match(awaiting, /coalesce\('g:' \|\| \$\{scheduledPosts\.crosspostGroupId\}, 'id:' \|\| \$\{scheduledPosts\.id\}::text\)/);
    assert.match(assistants, /count\(DISTINCT \$\{reviewCardKey\}\)::int/);
    assert.ok(!/if \(r\.status === 'pending_approval'\) \{\s*pendingReviewCount\.set\(aId/.test(assistants),
        'the old pending_approval-rows count is still there');
});

check('SWAN-4: blog and email waiting counts use the To approve statuses', () => {
    assert.match(assistants, /blog: new Set\(\['draft', 'pending_approval', 'in_review'\]\)/);
    assert.match(assistants, /newsletter: new Set\(\['pending_approval', 'in_review'\]\)/);
});

check('SWAN-10: an archived assistant\'s drafts leave Review and the Calendar', () => {
    assert.match(read('src/utils/archived-assistant-drafts.ts'), /lifecycle_status = 'archived'/);
    assert.match(drafts, /awaitingReview && !assistantIdFilter \? \[notFromArchivedAssistant\(\)\]/);
    assert.match(scheduled, /AWAITING_REVIEW_STATUSES\]\), notFromArchivedAssistant\(\)\)/);
});

check('SWAN-10: the calendar legend and picker list live assistants only', () => {
    const cal = read('calendar.js');
    assert.match(cal, /function _liveAssistants\(\)/);
    assert.match(cal, /const sorted = _liveAssistants\(\)\.sort/);
    assert.match(cal, /legend\.innerHTML = live\.map/);
});

// ── SWAN-5: the YouTube checklist no longer says Meta ────────────────────────────────────────
check('SWAN-5: the pre-flight heading comes from the platform', () => {
    const integ = read('integrations.js');
    assert.match(integ, /heading: 'Check these before you go to Google'/);
    assert.match(integ, /headingEl\.textContent = pc\.heading \|\| 'Set this up in Meta first'/);
    assert.match(read('assistant-detail.html'), /<h3 id="preconnect-heading"/);
});

// ── SWAN-8: Brand Designer pill and allowance numbers ────────────────────────────────────────
check('SWAN-8: the status pill counts the Briefs waiting, and re-renders when they arrive', () => {
    const js = read('assistants.js');
    assert.match(js, /Math\.max\(Number\(sig\.pendingReview\) \|\| 0, Number\(window\._detailNeedsYouOverride\) \|\| 0\)/);
    const i = js.indexOf('window._setNeedsYouCount = function');
    assert.ok(js.slice(i, i + 200).includes('_renderStatusPill'));
});

check('SWAN-8: the allowance strip names bonus tasks; Briefs formats its number', () => {
    assert.match(read('assistants.js'), /plus \$\{n\(bonus\)\} bonus task/);
    assert.match(read('src/components/assistant-briefs.js'), /Number\(state\.credits\)\.toLocaleString\('en-GB'\)/);
});

// ── SWAN-9: re-rendering a post must not empty an open "Schedule & publish" ───────────────────
check('SWAN-9: the reset leaves the reschedule block alone while the rail shows it as step 7', () => {
    const html = read('workspace.html');
    const i = html.indexOf('function rqReviewToggle(which)');
    assert.ok(i !== -1, 'rqReviewToggle not found');
    const body = html.slice(i, html.indexOf('\n}\n', i));
    assert.match(body, /if \(!which && k === 'reschedule' && el\?\.closest\('#pce-rail'\)\) return;/);
    // ...and the re-render really does end with that reset, which is why the guard is needed.
    const r = html.indexOf('function _rqReviewRenderActive()');
    const render = html.slice(r, html.indexOf('\n}\n', r));
    assert.match(render, /rqReviewToggle\(\);\s*$/);
});

// ── SWAN-11: Change Plan wording ─────────────────────────────────────────────────────────────
check('SWAN-11: plan lines say what is unlimited, with singular/plural and separators', () => {
    const billing = read('billing.html');
    assert.match(billing, /'Unlimited assistants'/);
    assert.match(billing, /assistant\$\{Number\(assistants\) === 1 \? '' : 's'\}/);
    assert.ok(!billing.includes("t.assistantLimit + ' assistants' : 'Unlimited'"), 'old plan line still present');
    assert.ok(!billing.includes("'unlimited'}-assistant limit"), 'old impact sentence still present');
    assert.match(billing, /type="button" aria-label="Close" onclick="window\._closeChangePlanModal\(\)"/);
});

// ── SWAN-12: phone width (375px) ─────────────────────────────────────────────────────────────
check('SWAN-12: on a phone the post comes before the setup steps', () => {
    assert.match(read('workspace.html'), /@media \(max-width: 1023px\) \{ #pce-stage-wrap > #pce-stage-main \{ order: -1; \} \}/);
});

check('SWAN-12: header — menu button named, title off phones, breadcrumbs on one line', () => {
    const html = read('workspace.html');
    assert.match(html, /<button id="mobile-menu-btn" type="button" aria-label="Open menu"/);
    assert.match(html, /<span id="header-title" class="hidden sm:inline whitespace-nowrap/);
    assert.match(html, /data-pr-crumb="\$\{act\}" class="[^"]*whitespace-nowrap/);
    assert.match(html, /<span class="sm:hidden">Platform<\/span><span class="hidden sm:inline">Change platform &amp; format<\/span>/);
});

check('SWAN-12: the calendar card keeps its pill in the header row, not a side column', () => {
    const cal = read('calendar.js');
    const i = cal.indexOf('function _awaitingChip(');
    const list = cal.slice(i, cal.indexOf("return `<div role=\"button\" tabindex=\"0\" data-cal-activate\n        onclick", i));
    assert.match(list, /ml-auto text-xs font-bold px-2\.5 py-1 rounded-full/);
    assert.ok(!/shrink-0 mt-1">\$\{label\}<\/span>\s*<\/div>`;/.test(list), 'the pill is still a column of its own');
});

check('SWAN-12: the free-months count is not right-aligned in a wrapped block', () => {
    const ref = read('referral-content.html');
    const i = ref.indexOf('id="vault-token-count"');
    assert.ok(!ref.slice(Math.max(0, i - 200), i).includes('<div class="text-right">'));
});

// ── SWAN-13: referral CTAs reach the referral dashboard ──────────────────────────────────────
check('SWAN-13: members go to the referral view, logins keep that destination', () => {
    const ref = read('referral.html');
    assert.match(ref, /const REFERRAL_VIEW = '\/workspace\.html\?view=referral'/);
    assert.match(ref, /\/login\.html\?redirect=\$\{encodeURIComponent\(REFERRAL_VIEW\)\}/);
    assert.match(read('workspace.html'), /'referral': \{ file: 'referral-content\.html'/);
});

console.log(`\n${passed} passed`);
