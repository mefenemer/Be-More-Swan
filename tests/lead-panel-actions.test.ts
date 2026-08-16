// tests/lead-panel-actions.test.ts
// The Enrichment tab's expanded lead: which buttons exist, where, and exactly once.
//
// The complaints this came from, all on one panel:
//   • TWO Approve buttons, four inches apart, doing the same thing — the next-step footer PRESSES
//     the action bar's button, so promoting an action drew a second copy of it.
//   • Research — the one control on this tab that can change a lead's rating — was not offered as
//     the next step on a lead nobody had researched.
//   • Record outcome sat here as well as on the conversation the outcome is a judgement about.
//   • notes could be written (Edit lead ▸ Notes) and were rendered by NOTHING, on any screen.
//
// The fix makes the footer own the promoted action and the bar hide its copy, which introduced the
// sharpest trap in this file: the footer is not always drawn. It used to be nested inside the
// card's `suggestedNextStep` box, so it existed only when the model wrote that sentence, and a
// lead whose `data` carries no recognised card type renders a plain key/value list with no footer
// at all. Hiding the bar's copy on one of those left Approve with no button ANYWHERE.
//
// Run:  npx tsx tests/lead-panel-actions.test.ts

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

const HUB = read('src/components/assistant-data-hub.js');
const REGISTRY = read('src/components/disruptive-ui-registry.js');
const SHELL = read('assistants.js');
const LEADGEN = read('netlify/functions/lead-generation.ts');
const WORKSPACE = read('workspace.html');

console.log('\n──── one button per action ────');

check('the bar hides exactly the action the footer promotes', () => {
    const loop = HUB.slice(landmark(HUB, 'const promoted = '));
    assert.match(loop, /const promotedKey = promoted && promoted\.action \? promoted\.action\.key : null/,
        'the promoted key comes from the same guidance the footer was built from, or the two can '
        + 'disagree about which button is the duplicate');
    assert.match(loop.slice(0, 1600), /b\.key === promotedKey[\s\S]{0,200}style\.display = 'none'/,
        'and the bar must hide its copy. `hidden` alone loses to the flex display on these buttons, '
        + 'so the inline style is what actually hides it');
});

check('a button is only hidden when the footer was actually drawn', () => {
    const promoted = HUB.slice(landmark(HUB, 'const promoted = ')).slice(0, 200);
    assert.match(promoted, /opts && opts\.hasNextStepFooter/,
        'THE trap in this file. The footer is not guaranteed to exist — a lead whose data carries '
        + 'no recognised card type falls back to a key/value list that has none — and hiding the '
        + 'promoted button on one of those leaves the action with no button anywhere in the panel');
});

check('the flag is read off the rendered DOM, not off the guidance', () => {
    const mount = HUB.slice(landmark(HUB, 'const rendered = body || keyValueFallback')).slice(0, 800);
    assert.match(mount, /hasNextStepFooter: !!rendered\.querySelector\?\.\('\[data-next-step-footer\]'\)/,
        'asking the guidance whether a footer exists assumes the card honoured it. Only the '
        + 'produced element knows whether the renderer declined or fell back');
});

check('the footer survives a lead with no suggested-next-step sentence', () => {
    const card = REGISTRY.slice(landmark(REGISTRY, '${ui.suggestedNextStep ? `'));
    const block = card.slice(0, landmark(card, '${contactEmail ? `'));
    // The `: nextStepFooter(...)` branch is the whole point: the else-arm has to draw it too.
    assert.match(block, /:\s*nextStepFooter\(opts && opts\.nextStep, esc\)}/,
        'the footer was nested inside the suggestedNextStep box, so who-owns-the-next-step and its '
        + 'button appeared only when the drafter happened to write that sentence — a property of '
        + 'the model output, not of the lead');
});

console.log('\n──── which action is the next step ────');

check('an unresearched lead is told to research it', () => {
    const guidance = HUB.slice(landmark(HUB, 'function nextStepGuidance(record)'));
    const branch = guidance.slice(landmark(guidance, 'if (!d.intel) {')).slice(0, 500);
    assert.match(branch, /key: 'enrich'/,
        'Research is the one control here that can change a lead\'s rating, so on a lead nobody '
        + 'has looked at it is the next step — the approve decision below depends on it');
    // Ordering: research must be asked BEFORE the plain approve fallback, or it is never reached.
    assert.ok(
        landmark(guidance, "if (!d.intel) {") < landmark(guidance, "action: { key: 'approve'"),
        'and it must come before the approve fallback, which returns unconditionally',
    );
});

check('a researched lead is told to approve it, naming the tab as the role labels it', () => {
    const guidance = HUB.slice(landmark(HUB, 'function nextStepGuidance(record)'));
    const tail = guidance.slice(landmark(guidance, "action: { key: 'approve'")).slice(0, 400);
    assert.match(tail, /\$\{reviewTabLabel\(\)\} tab/,
        'this role renames Review to "Outreach", and copy naming a tab the user cannot see is the '
        + 'same dead end as naming a tool that does not exist');
});

console.log('\n──── approving something already sent ────');

check('a sent lead is not offered Approve', () => {
    const fn = HUB.slice(landmark(HUB, 'function isPastApprovalGate(record)')).slice(0, 400);
    assert.match(fn, /s === 'approved' \|\| s === 'scheduled'/,
        'a successful send leaves the record `scheduled` — that state is the chase reminder, not a '
        + 'pending send — so testing "approved" alone offered to clear a lead for an outreach its '
        + 'recipient had already received');
    assert.match(fn, /return !!\(record\.data \|\| \{\}\)\.outreachSentAt/,
        'and an email that has left cannot be un-sent, whatever the approval column says');
});

check('a rejected lead can still be re-approved', () => {
    const fn = HUB.slice(landmark(HUB, 'function isPastApprovalGate(record)')).slice(0, 400);
    assert.doesNotMatch(fn, /'rejected'/,
        'reversing a rejection is a legitimate correction. Folding rejected into "past the gate" '
        + 'would make a mis-rejected lead unrecoverable from this panel');
});

check('the bar and the footer read the SAME gate', () => {
    // Both call sites, or the footer promotes a button the bar no longer draws — which is not a
    // duplicate button, it is a button that does nothing when pressed.
    const calls = HUB.split('isPastApprovalGate(record)').length - 1;
    assert.ok(calls >= 3,
        `nextStepGuidance and detailActions must both consult it (found ${calls} references incl. `
        + 'the definition). A rule applied in one and not the other strands the footer button');
});

console.log('\n──── the outcome belongs to the conversation ────');

check('Record outcome is dropped here only when a thread owns it', () => {
    const gate = HUB.slice(landmark(HUB, "if (!hasConversationThread(record) || !conversationsTabAvailable()) {")).slice(0, 500);
    assert.match(gate, /key: 'record-outcome'/,
        'a lead with no thread — never contacted, or contacted by hand — is never shown in '
        + 'Conversations, so removing the button outright leaves its outcome unrecordable');
});

check('"we sent it" is what proves a thread exists, not "it is stamped sent"', () => {
    const fn = HUB.slice(landmark(HUB, 'function hasConversationThread(record)')).slice(0, 400);
    assert.match(fn, /via === 'google' \|\| via === 'microsoft'/,
        'openLeadThread runs immediately before a REAL send. "Mark outreach sent" writes the same '
        + '`outreachSentAt` and mints nothing, so keying on the timestamp would send those users '
        + 'to a Conversations tab that has no row for their lead');
});

check('a hand-marked lead is not told its follow-ups are handled', () => {
    const guidance = HUB.slice(landmark(HUB, 'function nextStepGuidance(record)'));
    const manual = guidance.slice(landmark(guidance, "if (d.outreachSentVia === 'manual') {")).slice(0, 600);
    assert.match(manual, /owner: 'you'/,
        'nothing about a lead the user contacted themselves is the assistant\'s to do');
    assert.match(manual, /no follow-ups are scheduled/,
        'enrolInSequence runs only on a confirmed send, so promising a cadence here describes '
        + 'enrolments that were never written');
});

console.log('\n──── notes ────');

check('add_note merges server-side instead of replacing data', () => {
    const action = LEADGEN.slice(landmark(LEADGEN, "if (action === 'add_note') {"));
    const body = action.slice(0, landmark(action, "if (action === 'set_outcome') {"));
    assert.match(body, /data: \{ \.\.\.data, notes \}/,
        'the generic records PATCH replaces `data` wholesale. A note taken from a surface that does '
        + 'not hold a full copy of the lead would otherwise drop its score, intel and draft');
    assert.match(body, /\$\{stamp\} — \$\{note\}\$\{previous \? `\\n\\n\$\{previous\}` : ''\}/,
        'and notes append, newest first. A box that replaced yesterday\'s note with today\'s '
        + 'destroys the one thing contemporaneous notes are for');
});

check('the note is dated by the server', () => {
    const action = LEADGEN.slice(landmark(LEADGEN, "if (action === 'add_note') {")).slice(0, 2200);
    assert.match(action, /const stamp = new Date\(\)\.toLocaleDateString\('en-GB'/,
        'a date taken from the browser clock is the one field on the record a user could get wrong '
        + 'without trying');
});

check('both surfaces render notes, and both can write them', () => {
    assert.match(HUB, /data-lead-notes-banner/,
        'the Enrichment panel must SHOW notes — `data.notes` was write-only, which is '
        + 'indistinguishable from a field that discards what you type');
    assert.match(HUB, /key: 'notes'/, 'and offer the control');
    assert.match(SHELL, /function _rqLeadNotes\(r\)/, 'the Outreach card must show them too');
    assert.match(SHELL, /btn\(r\.data && r\.data\.notes \? 'Notes' : 'Add a note', 'notes', secondary\)/,
        'and offer the same control, so a note can be taken at whatever stage the lead is at');
});

check('the notes modal is loaded before the surfaces that open it', () => {
    // ⚠️ Matched on the SCRIPT TAG, not the bare filename. "assistant-data-hub.js" appears first in
    // the comment above lead-outcome-modal.js, so a filename search compares against prose and the
    // ordering it reports is not the ordering the browser sees.
    assert.ok(
        landmark(WORKSPACE, '<script src="/src/components/lead-notes-modal.js">')
        < landmark(WORKSPACE, '<script src="/src/components/assistant-data-hub.js">'),
        'the hub calls window.LeadNotesModal.open — a script tag ordered after it would leave the '
        + 'button silently inert, since the call is optional-chained',
    );
});

check('the Outreach card writes through the action, never through the wholesale PATCH', () => {
    const branch = SHELL.slice(landmark(SHELL, "if (action === 'notes') {")).slice(0, 1200);
    assert.match(branch, /return;/, 'and returns before reaching the PATCH machinery below it');
    assert.match(branch, /window\.LeadNotesModal\?\.open/, 'it opens the shared modal');
    assert.doesNotMatch(branch, /patch\.data/,
        'assembling a `data` patch on this card would send back a partial copy of the lead');
});

console.log('\n──── the tab states one number ────');

check('a records queue gets no amber pill beside its parenthetical', () => {
    const fn = SHELL.slice(landmark(SHELL, 'function _setDetailRqTabBadge(count)')).slice(0, 1400);
    assert.match(fn, /const isRecordsQueue = \(window\._detailReviewQueue \|\| \{\}\)\.kind === 'records'/,
        '"Outreach (23) 12" put two different quantities on one button with nothing saying which '
        + 'was which, so the available reading was that one of them was wrong');
    assert.match(fn, /const shown = isRecordsQueue \? 0 : count/,
        'posts queues keep the pill — nothing sets a parenthetical for them, so it is their only count');
});

check('the overlap that makes the columns exceed the total is stated on screen', () => {
    const paint = SHELL.slice(landmark(SHELL, 'const _overlap = ')).slice(0, 1400);
    assert.match(paint, /statusKey === 'approved' \|\| statusKey === 'scheduled'/,
        'only the two columns that actually double-count a sent lead');
    assert.match(paint, /records\.some\(\(r\) => \(r\.data \|\| \{\}\)\.outreachSentAt\)/,
        'and only when such a lead is present — otherwise it explains a discrepancy that is not there');
});

console.log(`\n${passed} checks passed.\n`);
