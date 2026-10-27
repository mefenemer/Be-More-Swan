// tests/lead-outreach-stages.test.ts
// The Lead Generator's Outreach tab in stages, with the Conversations tab folded in —
// docs/lead-outreach-restructure-plan.md, Phase 2.
//
// What is pinned, and why each one would fail silently:
//   1. the markup has one place for each surface, and no Conversations tab left to strand a link on;
//   2. every old route in — the tab name, a notification, the All leads button, the mailbox-connect
//      return — still lands somewhere true;
//   3. the "send it yourself" pill and the stage counts are placed by the SAME phase function as the
//      board, never by a hand-written approval-status test;
//   4. the conversations list reads `board`, draws one stage, and never asks for a thread a hand-sent
//      lead does not have;
//   5. what the chat, the notification and the Help Centre say matches the new tab.
//
// Run:  npx tsx tests/lead-outreach-stages.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const DETAIL = read('assistant-detail.html');
const WORKSPACE = read('workspace.html');
const SHELL = read('assistants.js');
const OUTREACH = read('src/components/assistant-lead-outreach.js');
const THREADS = read('src/components/assistant-lead-threads.js');
const HUB = read('src/components/assistant-data-hub.js');
const NOTIFS = read('notifications.js');
const REGISTRY = read('src/components/assistant-dashboard-registry.js');
const CHAT = read('netlify/functions/chat-orchestrator.ts');
const TEMPLATES = read('src/utils/notification-templates-catalog.ts');
const HELP = read('db/help-articles-2026-12zzzzzzzzzz-outreach-stages.sql');

// ── 1. markup ───────────────────────────────────────────────────────────────
console.log('\n──── 1. one tab, one place for each surface ────');

check('the Conversations tab and its panel are gone', () => {
    assert.ok(!DETAIL.includes('id="maintab-btn-conversations"'), 'the retired tab button is still in the strip');
    assert.ok(!DETAIL.includes('id="maintab-conversations"'), 'the retired panel is still on the page');
});

check('the stage strip, the review card and the conversations list all live in the Outreach panel', () => {
    const panel = DETAIL.slice(landmark(DETAIL, 'id="maintab-review-queue"'), landmark(DETAIL, '<!-- /maintab-review-queue -->'));
    for (const id of ['lead-outreach-stages', 'detail-rq-card', 'detail-rq-colstrip', 'detail-rq-groups', 'lead-threads-host']) {
        assert.ok(panel.includes(`id="${id}"`), `#${id} must be inside the Outreach panel`);
    }
    assert.ok(panel.indexOf('id="lead-outreach-stages"') < panel.indexOf('id="detail-rq-card"'),
        'the strip sits above what it switches between');
});

check('the stage component loads after the list it mounts and the constants it reads', () => {
    const constants = landmark(WORKSPACE, 'platform-constants.js');
    const threads = landmark(WORKSPACE, '<script src="/src/components/assistant-lead-threads.js">');
    const outreach = landmark(WORKSPACE, '<script src="/src/components/assistant-lead-outreach.js">');
    assert.ok(constants < outreach && threads < outreach, 'assistant-lead-outreach.js must load after platform-constants.js and assistant-lead-threads.js');
});

check('only the Lead Generator is staged, and every other role is reset', () => {
    assert.equal((REGISTRY.match(/staged: true/g) || []).length, 1);
    const apply = SHELL.slice(landmark(SHELL, '(cfg.reviewQueue || {}).staged'), landmark(SHELL, '(cfg.reviewQueue || {}).staged') + 500);
    assert.match(apply, /AssistantLeadOutreach\?\.init\(/);
    assert.match(apply, /AssistantLeadThreads\?\.init\(/);
    // The view is reused across assistant switches: without reset() a social role opened after a
    // Lead Generator would have its lifecycle columns hidden behind a lead stage strip.
    assert.match(apply, /else \{\s*window\.AssistantLeadOutreach\?\.reset\(\)/);
    const reset = OUTREACH.slice(landmark(OUTREACH, 'reset() {'), landmark(OUTREACH, 'isStaged()'));
    for (const id of ['detail-rq-colstrip', 'detail-rq-card', 'lead-threads-host', 'lead-outreach-stages']) {
        assert.ok(reset.includes(`'${id}'`), `reset() must restore #${id}`);
    }
});

// ── 2. every old route in ───────────────────────────────────────────────────
console.log('\n──── 2. old links still land ────');

check("_activateMainTab('conversations') opens the staged Outreach tab", () => {
    const fn = SHELL.slice(landmark(SHELL, 'window._activateMainTab = function(name)'), landmark(SHELL, 'window._activateMainTab = function(name)') + 900);
    assert.match(fn, /name === 'conversations' && window\.AssistantLeadOutreach\?\.isStaged\(\)/);
    assert.match(fn, /name = 'review-queue'/);
});

check('?tab=conversations on a deep link is aliased before the visible-tab check', () => {
    const at = landmark(SHELL, "if (wanted === 'conversations' && window.AssistantLeadOutreach?.isStaged())");
    const visible = landmark(SHELL, '.main-tab-btn[data-maintab="${wanted}"]:not(.hidden)', at);
    assert.ok(at < visible, 'the alias must run before the tab-is-visible test, or the link falls to the default tab');
});

check('opening the Outreach tab hands the requested column/stage to the stage component', () => {
    const branch = SHELL.slice(landmark(SHELL, "if (name === 'review-queue') {"), landmark(SHELL, "if (name === 'review-queue') {") + 1200);
    assert.match(branch, /AssistantLeadOutreach\.activate\(wantedCol\)/);
    // The legacy column names still understood: the mailbox-connect return comes back on 'approved'.
    for (const key of ['review', 'approved', 'scheduled', 'archived', 'conversations']) {
        assert.match(OUTREACH, new RegExp(`\\b${key}: \\{ stage:`), `legacy '${key}' must map to a stage`);
    }
});

check('the reply notification opens Replied on the right thread', () => {
    const handler = NOTIFS.slice(landmark(NOTIFS, "notif.type === 'lead_reply_received'"), landmark(NOTIFS, "notif.type === 'lead_reply_received'") + 700);
    assert.match(handler, /_assistantDetailInitialTab = 'review-queue'/);
    assert.match(handler, /_assistantDetailInitialRqStatus = 'replied'/);
    assert.match(handler, /_assistantDetailFocusThreadId = meta\.threadId/);
    // A link to a row wins over the stage it named — the lead may have moved on since.
    assert.match(OUTREACH, /pendingFocusPhase/);
});

check("All leads' Open in Outreach goes to THAT lead, not the top of a list", () => {
    const handler = HUB.slice(landmark(HUB, "if (key === 'open-conversations')"), landmark(HUB, "if (key === 'open-conversations')") + 500);
    assert.match(handler, /AssistantLeadOutreach\.openRecord\(record\.id\)/);
    assert.match(HUB, /wireNextStepAction\(panel, record\)/);
});

// ── 3. one placement rule ───────────────────────────────────────────────────
console.log('\n──── 3. the same function places every lead ────');

check('"Approved — send it yourself" is decided by leadOutreachPhase', () => {
    const fn = SHELL.slice(landmark(SHELL, 'function _rqIsSendYourself('), landmark(SHELL, 'async function _detailRqRefreshRecordCounts('));
    assert.match(fn, /P\.of\(\{ approvalStatus: r\.approvalStatus, data: r\.data, threadState: null, enrolment: null \}\)\.group === 'send_yourself'/);
    // The pill's list and its count both use it.
    assert.match(SHELL, /records = records\.filter\(_rqIsSendYourself\)/);
    assert.match(SHELL, /sendYourself: restRecords\.filter\(_rqIsSendYourself\)\.length/);
});

check('a write that moves a lead re-places it with the browser copy of the same function', () => {
    const fn = THREADS.slice(landmark(THREADS, 'function rephase(t)'), landmark(THREADS, 'function recount()'));
    assert.match(fn, /window\.LeadOutreachPhase/);
    assert.match(fn, /P\.of\(/);
    for (const site of ['Outcome recorded', 'Follow-ups stopped', "Moved to ${phaseLabel(t.phase)}"]) {
        assert.ok(THREADS.includes(site), `missing the stage move after: ${site}`);
    }
});

// ── 4. the list ─────────────────────────────────────────────────────────────
console.log('\n──── 4. the conversations list, one stage at a time ────');

check('the list reads `board`, not the old paged `list`', () => {
    const load = THREADS.slice(landmark(THREADS, 'async function load()'), landmark(THREADS, '// ── Public API'));
    assert.match(load, /call\('board'\)/);
    assert.ok(!/call\('list'/.test(THREADS), 'nothing should page the old list any more');
});

check('only stages 2–4 are drawn here — To approve belongs to the review cards', () => {
    const load = THREADS.slice(landmark(THREADS, 'async function load()'), landmark(THREADS, '// ── Public API'));
    assert.match(load, /r\.phase === 'following_up' \|\| r\.phase === 'replied' \|\| r\.phase === 'finished'/);
});

check('a lead marked sent by hand never asks the server for a thread', () => {
    const toggle = THREADS.slice(landmark(THREADS, 'async function toggleRow('), landmark(THREADS, 'function repaintDetail('));
    const guard = toggle.indexOf('if (t.threadId == null)');
    const get = toggle.indexOf("call('get'");
    assert.ok(guard > -1 && get > -1 && guard < get, 'the no-thread branch must return before the get call');
    assert.match(THREADS, /if \(t\.threadId == null\) return recordOnlyHtml\(t\)/);
});

check('the fixed column list is gone — every control reads the stage\'s columns', () => {
    assert.ok(!/\bCOLUMNS\.(map|filter|length)/.test(THREADS), 'something still reads the old fixed COLUMNS');
    assert.match(THREADS, /function columns\(\)/);
});

// ── 5. what is said about it ────────────────────────────────────────────────
console.log('\n──── 5. the words match the tab ────');

check('the chat describes the stages and knows the old names', () => {
    const surfaces = CHAT.slice(landmark(CHAT, 'function leadGeneratorSurfaces'), landmark(CHAT, 'function leadActionsPrompt'));
    for (const stage of ['"1 To approve"', '"2 Following up"', '"3 Replied"', '"4 Finished"', '"Archived"']) {
        assert.ok(surfaces.includes(stage), `the chat does not name ${stage}`);
    }
    assert.ok(!/- "Conversations" tab/.test(surfaces), 'the chat still lists a Conversations tab');
    assert.match(surfaces, /"Conversations" tab/, 'it must still recognise the old name when a user says it');
});

check('the reply notification no longer sends people to a tab that does not exist', () => {
    const tpl = TEMPLATES.slice(landmark(TEMPLATES, "templateKey: 'lead_reply_received'"), landmark(TEMPLATES, "templateKey: 'lead_reply_received'") + 600);
    assert.ok(!tpl.includes('Conversations tab'), 'the notification copy still names the Conversations tab');
    assert.match(tpl, /Outreach › Replied/);
});

check('the Help Centre file is safe to paste and finds what it left behind', () => {
    // The Neon editor splits pasted scripts on semicolons — none may sit inside a body or literal.
    const bodies = HELP.split('$$').filter((_, i) => i % 2 === 1);
    assert.ok(bodies.length >= 1, 'expected a dollar-quoted article body');
    for (const b of bodies) assert.ok(!b.includes(';'), 'a semicolon inside a $$ body breaks the Neon editor');
    assert.match(HELP, /ON CONFLICT \(title\) DO UPDATE SET/);
    assert.match(HELP, /'Sending Outreach and Handling Replies'/);
    assert.match(HELP, /WHERE is_published\s+AND \(content_md LIKE '%Conversations%'/);
});

console.log(`\n${passed} checks passed.`);
