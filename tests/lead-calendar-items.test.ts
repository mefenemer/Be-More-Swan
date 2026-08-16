// tests/lead-calendar-items.test.ts
// The Lead Generator's Calendar tab draws TWO kinds of item that mean nearly opposite things, and
// this file exists to stop them merging back into one.
//
//   🗓 record chip   — a lead whose outreach ALREADY went out. `assistant_records.scheduled_for` is
//                      the chase reminder left behind for a human. Nothing sends on that date.
//   ✉ follow-up chip — an email the cadence WILL deliver on that date
//                      (`sequence_enrolments.next_send_at`, the worker's own queue).
//
// WHY THIS EXISTS. The distinction is invisible to the compiler: both are a title and a timestamp
// rendered into a chip, and code that swapped one for the other would typecheck, render and look
// right. What it would actually do is either promise a send that never happens, or show a stranger's
// unsent email under a heading saying it was already delivered. The registry's own comment has
// carried a ⚠️ about this pair since the day it was written, and a ⚠️ in a comment is not a test.
//
// Four drift directions are guarded:
//   1. The past-date rule stops being enforced on the SERVER and survives only as a client dialog.
//   2. The record chip goes inert again (it was, for months — "records open from the Data Hub").
//   3. `_calDragStart` loses the bare-post-id call form, silently breaking the global calendar.
//   4. get-lead-activity emits an icon name the client's icon map does not know, which falls back
//      to a grey cog rather than failing — a silent, permanent, wrong-icon feed.
//
// No database: source-consistency checks only, like every other file in tests/ except
// rls-enforcement.
// Run:  npx tsx tests/lead-calendar-items.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Blank out comments, preserving length and newlines so line numbers stay exact.
 *
 * Load-bearing, not hygiene: every file this test scans EXPLAINS the record-vs-follow-up
 * distinction in prose, naming both phrases repeatedly. A scan that counted comment text would
 * find everything it looks for inside the explanation of why it is needed.
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The source span between `start` and `end`, or a failure naming what moved. */
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone. Update this test's anchors.`);
    const b = text.indexOf(end, a);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone. Update this test's anchors.`);
    return text.slice(a, b);
}

const calendarJs = stripComments(read('calendar.js'));
const leadThreadsTs = stripComments(read('netlify/functions/lead-threads.ts'));
const recordsTs = stripComments(read('netlify/functions/assistant-records.ts'));
const activityTs = stripComments(read('netlify/functions/get-lead-activity.ts'));
const registryJs = stripComments(read('src/components/assistant-dashboard-registry.js'));
const modalJs = stripComments(read('src/components/lead-calendar-modal.js'));
const assistantsJs = stripComments(read('assistants.js'));

console.log('\nLead Generator — Calendar items\n');

// ── 1. The past-date rule is enforced where it counts ────────────────────────

check('the server refuses a follow-up scheduled in the past — the dialog is not the enforcement', () => {
    const action = span(
        leadThreadsTs,
        "if (action === 'reschedule_follow_up')",
        "if (action === 'get')",
        'the reschedule_follow_up handler',
    );
    assert.ok(
        /PAST_DATE/.test(action),
        'reschedule_follow_up no longer returns a PAST_DATE refusal. next_send_at IS the worker\'s queue: '
        + 'a date behind now() means "send on the next tick", so a past date accepted here turns a '
        + 'mis-aimed drag into an immediate cold email. The client dialog cannot be the only guard.',
    );
    assert.ok(
        /Date\.now\(\)/.test(action),
        'reschedule_follow_up no longer compares the requested date against now().',
    );
});

check('the client refuses a past drop BEFORE any network call, for both chip kinds', () => {
    assert.ok(
        /function _isPastDateKey/.test(calendarJs),
        'calendar.js has lost _isPastDateKey — the shared past-date predicate for dropped chips.',
    );
    for (const [fn, endAnchor, what] of [
        ['async function _dropFollowUp', 'async function _dropRecord', 'the follow-up drop handler'],
        ['async function _dropRecord', 'function _attachDragDrop', 'the record drop handler'],
    ] as const) {
        const body = span(calendarJs, fn, endAnchor, what);
        const guardAt = body.indexOf('_isPastDateKey');
        const fetchAt = body.indexOf('fetch(');
        assert.notStrictEqual(guardAt, -1, `${what} no longer calls _isPastDateKey.`);
        assert.notStrictEqual(fetchAt, -1, `${what} no longer issues a request — has the drop become a no-op?`);
        assert.ok(
            guardAt < fetchAt,
            `${what} checks the past-date rule AFTER it has already sent the request. `
            + 'The guard exists so a mis-drop never reaches the server at all.',
        );
        assert.ok(
            /alertModal/.test(body.slice(guardAt, fetchAt)),
            `${what} no longer explains the refusal with a dialog. A silent snap-back reads as a broken drag.`,
        );
    }
});

// ── 2. The chips stay interactive, and stay distinguishable ──────────────────

check('the record chip is clickable AND draggable — it used to be inert', () => {
    const chip = span(calendarJs, 'function _recordChip(', 'function _followUpsOnDate(', 'the record chip');
    assert.ok(/_calOpenRecord/.test(chip), 'The record chip no longer opens its detail modal.');
    assert.ok(/draggable="true"/.test(chip), 'The record chip is no longer draggable.');
    assert.ok(/_calDragStart/.test(chip), 'The record chip no longer starts a drag.');
});

check('a follow-up on a replied thread is drawn but NOT draggable', () => {
    const chip = span(calendarJs, 'function _followUpChip(', 'function _listFollowUpRow(', 'the follow-up chip');
    assert.ok(/_followUpBlocked/.test(chip), 'The follow-up chip no longer distinguishes a blocked cadence.');
    assert.ok(
        /blocked \? '' :/.test(chip),
        'The follow-up chip no longer withholds `draggable` when the thread has replied. '
        + 'The worker refuses to send into a thread that is not "open", so moving that date is busywork '
        + 'that implies a send which will not happen.',
    );
});

check('the two chip kinds cannot be told apart only by their text', () => {
    const followUp = span(calendarJs, 'function _followUpChip(', 'function _listFollowUpRow(', 'the follow-up chip');
    const record = span(calendarJs, 'function _recordChip(', 'function _followUpsOnDate(', 'the record chip');
    assert.ok(/indigo/.test(followUp), 'The follow-up chip has lost its indigo tint.');
    assert.ok(/yellow/.test(record), 'The record chip has lost its yellow tint.');
    assert.ok(
        !/indigo/.test(record) && !/yellow-\d/.test(followUp),
        'The record and follow-up chips now share a colour. A user who cannot tell them apart at a '
        + 'glance cannot tell "you owe this lead a call" from "we email this stranger on Thursday".',
    );
});

// ── 3. The global calendar's post drag still works ───────────────────────────

check('_calDragStart still accepts the bare post-id form', () => {
    const fn = span(calendarJs, 'window._calDragStart = function', 'window._calDragOver', '_calDragStart');
    assert.ok(
        /typeof arg === 'object'/.test(fn),
        '_calDragStart no longer normalises its second argument. The post chips call it as '
        + '`_calDragStart(event, 123)` and the record/follow-up chips as `_calDragStart(event, {kind, id})`; '
        + 'dropping the bare form silently breaks dragging on the global Content Calendar, which has no '
        + 'record or follow-up chips to reveal the bug.',
    );
    const postChip = span(calendarJs, 'function _postChip(', 'const _previewCache', 'the post chip');
    assert.ok(
        /_calDragStart\(event, \$\{post\.id\}\)/.test(postChip),
        'The post chip no longer passes a bare id — if this is deliberate, drop the normalisation above too.',
    );
});

check('pending outreach is opt-IN, so an unknown role never inherits a send queue', () => {
    const init = span(calendarJs, 'window.initCalendar = async function', 'function _navRefresh', 'initCalendar');
    assert.ok(
        /opts\.leadOutreach === true/.test(init),
        'calendar.js no longer opts IN to lead outreach. An unknown roleKey resolves to '
        + 'social_media_manager, so a `!== false` default would hand every unrecognised assistant a '
        + 'calendar of emails it does not have.',
    );
    const cal = stripComments(read('src/components/assistant-calendar.js'));
    assert.ok(
        /hasLeadOutreach === true/.test(cal),
        'assistant-calendar.js no longer opts IN to modules.hasLeadOutreach.',
    );
    const leadEntry = span(registryJs, 'lead_qualifier: {', 'hubTab: {', 'the lead_qualifier registry entry');
    assert.ok(/hasLeadOutreach: true/.test(leadEntry), 'lead_qualifier no longer declares hasLeadOutreach.');
});

// ── 4. Rescheduling a record does not walk through the approval gate ─────────

check('a bare scheduledFor PATCH moves the date without touching the approval gate', () => {
    const patch = span(recordsTs, "if (event.httpMethod === 'PATCH')", "if (event.httpMethod === 'DELETE')", 'the PATCH branch');
    assert.ok(
        /dueDateOnly/.test(patch),
        'assistant-records.ts has lost the due-date-only PATCH path. Routing a calendar drag through '
        + '`approvalStatus: \'scheduled\'` instead puts a handoff push and an append-only revenue-ledger '
        + 'write one `wasDecided` regression away from firing on every drag.',
    );
    assert.ok(
        /body\.approvalStatus === undefined/.test(patch),
        'The due-date-only path no longer requires approvalStatus to be absent, so it can now collide '
        + 'with a gate transition in the same request.',
    );
    assert.ok(
        /dueDateOnly \? \[eq\(assistantRecords\.approvalStatus, 'scheduled'\)\]/.test(patch),
        'The due-date-only path no longer restricts itself to records that are already scheduled. '
        + 'A due date on a pending or rejected record is a date nothing reads.',
    );
});

check('the calendar sends a bare scheduledFor, never an approvalStatus', () => {
    const drop = span(calendarJs, 'async function _dropRecord', 'function _attachDragDrop', 'the record drop handler');
    assert.ok(/scheduledFor:/.test(drop), 'The record drop no longer sends a scheduledFor.');
    assert.ok(
        !/approvalStatus/.test(drop),
        'The record drop now sends an approvalStatus. Dragging a chip is not an approval, and the '
        + 'server treats those two shapes very differently.',
    );
});

// ── 5. The modal tells the truth about what will be sent ─────────────────────

check('a pending follow-up is never illustrated with the stored outreach draft', () => {
    const panel = span(modalJs, 'function followUpEmailPanel(', 'function leadPanel(', 'the follow-up email panel');
    assert.ok(
        !/outreachDraft/.test(panel),
        'The follow-up panel now reads `outreachDraft`. That field holds the email ALREADY sent to this '
        + 'lead; showing it under "what will be sent" asserts a stranger is about to receive a second '
        + 'copy of a message they already have. Each chaser is written by the worker at send time and '
        + 'does not exist yet.',
    );
    assert.ok(
        /written when it goes out/.test(read('src/components/lead-calendar-modal.js')),
        'The follow-up panel no longer says the chaser is written at send time, which is the one fact '
        + 'that explains why there is nothing to read.',
    );
});

check('the record panel names the outreach state rather than assuming a send', () => {
    const panel = span(modalJs, 'function recordEmailPanel(', 'function followUpEmailPanel(', 'the record email panel');
    for (const needle of ['outreachState', 'outreachSentVia']) {
        assert.ok(
            panel.includes(needle),
            `The record email panel no longer reads ${needle}. Three different things live in `
            + '`outreachDraft` depending on the outreach state, and "manual" means the user contacted the '
            + 'lead some other way — that text was never emailed from here and must not be described as '
            + 'what the contact read.',
        );
    }
});

// ── 6. The Activity feed routes, and its icons exist ─────────────────────────

check('lead_qualifier routes Activity to the lead feed, and nothing else does', () => {
    const leadEntry = span(registryJs, 'lead_qualifier: {', 'hubTab: {', 'the lead_qualifier registry entry');
    assert.ok(/activitySource: 'lead'/.test(leadEntry), 'lead_qualifier no longer declares activitySource.');
    // Everything EXCEPT the lead_qualifier entry. Cut by removing that exact span rather than by
    // re-splitting on a marker that occurs in every role — `hubTab: {` appears eight times, and
    // splitting on it puts lead_qualifier straight back into the "other roles" text.
    const others = registryJs.replace(leadEntry, '');
    assert.ok(
        !/activitySource:/.test(others),
        'A second role now declares activitySource. That is fine in principle — but get-lead-activity '
        + 'reads the LEAD ledger, so a non-lead role pointed at it gets an empty feed, which is the '
        + 'exact failure this routing was added to end.',
    );
    assert.ok(
        /get-lead-activity/.test(assistantsJs) && /get-assistant-activity/.test(assistantsJs),
        'assistants.js no longer holds both activity URLs — the routing has collapsed to one feed.',
    );
});

// The icon-map cross-check and the "a lost deal is not an alarm" guard used to live here as source
// scans over get-lead-activity.ts. The wording they were scanning now lives in the pure module
// src/config/lead-activity-events.ts, so tests/lead-activity-projection.test.ts asserts both by
// CALLING describeLeadEvent() instead of matching its source — §2 and §3 there. That suite also
// pins the function to keep delegating, so the two cannot drift apart unnoticed.

check('the calendar feed only returns enrolments that can still send', () => {
    const action = span(leadThreadsTs, "if (action === 'calendar')", "if (action === 'reschedule_follow_up')", 'the calendar feed');
    assert.ok(
        /eq\(sequenceEnrolments\.state, 'active'\)/.test(action),
        'The calendar feed no longer filters to active enrolments. A halted or completed enrolment '
        + 'drawn on a calendar is a send that is never coming.',
    );
    assert.ok(
        /nextSendAt} IS NOT NULL/.test(action),
        'The calendar feed no longer excludes NULL next_send_at rows.',
    );
    assert.ok(
        /innerJoin\(leadThreads/.test(action),
        'The calendar feed no longer INNER JOINs lead_threads. The ASSISTANT scope lives on the thread — '
        + 'without the join, another assistant\'s enrolments would appear on this calendar.',
    );
});

console.log(`\n${passed} checks passed\n`);
