// tests/lead-bulk-reject.test.ts
// Clearing a queue of leads that can never leave it — without lying to the targeting signal.
//
// ── What this is defending ───────────────────────────────────────────────────
// A discovery run files EVERY scored company as pending_approval when the campaign requires
// review — hot, warm and cold alike (process-discovery-jobs.ts → promoteOne). But the scorer writes
// no outreach draft for a cold lead and enrichment only scrapes hot/warm, so a cold lead enters a
// queue with no exit: it cannot be approved-and-sent, because there is nothing to send. On one
// staging assistant that left 151 of 165 pending rows stuck.
//
// The fix is a bulk REJECT, and four properties make it the right one rather than a mass delete:
//
//   1. REJECT, NOT DELETE. promoteOne's update path does not touch approval_status, so a rejected
//      lead that a later run re-finds STAYS rejected. A deleted one comes back as
//      pending_approval on the next run, and the user clears the same company forever.
//   2. REJECTION ONLY. The bulk branch refuses every other field, and refuses them LOUDLY.
//      Approving in bulk would be the dangerous one: approval is what sends the email.
//   3. ONE TRANSITION, ONE LEDGER ROW. Re-rejecting an already-decided lead must not write a
//      second lead_rejected event — the Strategy Agent clusters on the count.
//   4. THE REASON IS A CLOSED VOCABULARY, VALIDATED UP FRONT. `bad_contact` is the honest reason
//      for this particular clear-out, and lead-reject-reasons.ts already excludes it from
//      targeting — so emptying the queue cannot retarget the search to fix a problem that lives
//      in enrichment.
//
// No database, no DOM: source-consistency checks, like every other suite here.
// Run:  npx tsx tests/lead-bulk-reject.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import {
    LEAD_REJECT_REASONS,
    LEAD_REJECT_REASONS_FOR_TARGETING,
    LEAD_REJECT_REASON_LABELS,
} from '../src/config/lead-reject-reasons';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const RECORDS = read('netlify/functions/assistant-records.ts');
const HUB = read('src/components/assistant-data-hub.js');
const CSS = read('style.css');

/** The PATCH handler's bulk branch: everything before the single-record path picks up `body.id`. */
const BULK = RECORDS.slice(
    landmark(RECORDS, "if (event.httpMethod === 'PATCH')"),
    landmark(RECORDS, 'const id = Number(body.id);'),
);

console.log('\n──── the bulk PATCH is a rejection and nothing else ────');

check('only "rejected" can be set in bulk — approval is what sends the email', () => {
    assert.ok(/String\(body\.approvalStatus\) !== 'rejected'/.test(BULK),
        'the bulk branch must pin the target status. A bulk approve would send an outreach email to '
        + 'every selected lead from one click on a hundred rows.');
    assert.ok(/Only approvalStatus "rejected" can be set in bulk/.test(BULK),
        'and it must SAY so — a caller told only "400" will retry the same body');
});

check('every other field is refused, never silently dropped', () => {
    for (const field of ['title', 'status', 'data', 'scheduledFor']) {
        assert.ok(new RegExp(`'${field}'`).test(BULK),
            `${field} is not refused by the bulk branch. Ignoring a field the caller sent is how a `
            + 'client ends up believing a bulk edit happened.');
    }
    assert.ok(/cannot be set in bulk — reject only/.test(BULK),
        'the refusal must name the rule, not just the field');
});

check('the cap is shared with DELETE, and going over is a 400 rather than a truncation', () => {
    const cap = Number((/const MAX_BULK = (\d+)/.exec(RECORDS) || [])[1]);
    assert.ok(cap > 0, 'the shared bulk cap has gone');
    assert.ok(/idList\.length > MAX_BULK/.test(BULK), 'the cap is not enforced on the reject path');
    assert.ok(/Reject up to \$\{MAX_BULK\}/.test(BULK),
        'over the cap must 400. Rejecting 100 of the 150 someone selected and reporting success is '
        + 'the worst answer available.');
    assert.ok(!/\.slice\(0, MAX_BULK\)/.test(BULK), 'the id list is being truncated to the cap');
    // ⚠️ ONE cap for both ways of clearing the same selection. Two different limits would be
    // arbitrary to the user who just ticked 120 rows and is choosing between two buttons.
    assert.ok(!/MAX_BULK_REJECT|MAX_BULK_DELETE/.test(RECORDS),
        'the reject and delete caps have diverged — they clear the same selection');
});

console.log('\n──── the loop keeps every guard the single path has ────');

check('every id is tenant-scoped, inside the loop', () => {
    const loop = BULK.slice(landmark(BULK, 'for (const rid of idList)'));
    const reads = loop.split('eq(assistantRecords.organisationId, orgId)').length - 1;
    assert.ok(reads >= 2,
        `the org scope appears ${reads} time(s) in the loop — both the read and the update must be `
        + 'scoped, or one tenant can reject another tenant\'s leads by guessing ids');
    assert.ok(/if \(!prev\) \{ notFound\+\+; continue; \}/.test(loop),
        'a missing record must be counted, not thrown — otherwise one stale id fails the other 99 '
        + 'rows the user selected');
});

check('only a genuine transition writes a ledger row', () => {
    assert.ok(/const wasDecided = LIVE_APPROVAL\.has\(prev\.approvalStatus \?\? ''\) \|\| prev\.approvalStatus === 'rejected'/.test(BULK),
        'the bulk path must use the same wasDecided guard as the single one');
    assert.ok(/prev\.recordType === 'lead' && !wasDecided/.test(BULK),
        're-rejecting an already-decided lead would inflate the rejection count the Strategy Agent '
        + 'clusters on — and a bulk press over a list that already contains rejected rows is '
        + 'exactly how that happens');
});

check('the ledger row is attributable — blueprint version and ICP snapshot', () => {
    // Neither can be backfilled: an event written without them is permanently unattributable.
    // tests/lead-outcomes.test.ts owns the repo-wide count of recordEvent sites.
    assert.ok(/recordEvent\(db, 'lead_rejected'/.test(BULK), 'the bulk reject writes no ledger event at all');
    assert.ok(/blueprintVersion: await getBlueprintVersion\(db, prev\.aiAssistantId\)/.test(BULK),
        'the event must carry the blueprint version it was decided against');
    assert.ok(/icpSnapshot: await getIcpSnapshot\(db, \{/.test(BULK),
        'the event must carry the ICP snapshot — campaign-first, assistant otherwise');
    assert.ok(/actor: 'user'/.test(BULK),
        'this is the human gate; recording it as the assistant\'s decision would corrupt the '
        + 'autonomy baseline every later increase is measured against');
});

check('rejecting clears the due date, exactly as the single path does', () => {
    assert.ok(/approvalStatus: 'rejected', scheduledFor: null/.test(BULK),
        'leaving the scheduled state must clear scheduled_for — a rejected lead with a due date is '
        + 'a row the calendar still believes in');
});

console.log('\n──── the reason is banked, and only where it means something ────');

check('the reason is validated up front, against the shared vocabulary', () => {
    assert.ok(/isLeadRejectReason\(rawReason\)/.test(BULK),
        'the reason must be narrowed by the shared guard — the DB CHECK is the other half of it');
    assert.ok(landmark(BULK, 'isLeadRejectReason(rawReason)') < landmark(BULK, 'for (const rid of idList)'),
        'a bad vocabulary value must fail the whole request BEFORE anything is written, not reject '
        + 'a hundred leads and then decline to explain itself once per row');
});

check('evidence is banked for leads only', () => {
    assert.ok(/rawReason && prev\.recordType === 'lead'/.test(BULK),
        'assistant_records is shared by six roles, and a rejected invoice says nothing about who a '
        + 'discovery search should look for');
    assert.ok(/recordLeadRejection\(db, \{/.test(BULK),
        'the bulk path must use the shared writer, not its own insert');
});

check('bad_contact is a real reason AND is withheld from targeting', () => {
    // This is what makes clearing an uncontactable queue safe: the reason is recorded, the count is
    // visible in Profile ▸ Rules, and nothing retargets the search over it.
    assert.ok(LEAD_REJECT_REASONS.includes('bad_contact'), 'the vocabulary lost bad_contact');
    assert.ok(!LEAD_REJECT_REASONS_FOR_TARGETING.includes('bad_contact'),
        'bad_contact has been admitted to the targeting cluster. Clearing 150 leads nobody could '
        + 'reach would then argue the search is aimed at the wrong companies — the problem is in '
        + 'enrichment, not in who was looked for.');
});

console.log('\n──── the CLIENT reaches the same outcome through Delete ────');

// ⚠️ The bulk Reject BUTTON is gone (2026-08-15). Everything above still holds — the PATCH branch
// is unchanged and still the right shape — but nothing on the Leads tab calls it any more, because
// bulk DELETE now performs the rejection itself AND files the leads under Deleted. Two buttons on
// one bar, the scarier-sounding one being the safer act, was a choice no user could make correctly.
//
// So the checks below moved from "the reject button does X" to "the thing that replaced it does X",
// and the properties being defended are identical: the reason reaches every chunk, a re-found lead
// stays rejected, and the confirmation states what a user cannot guess.

check('bulk delete carries the reason to every chunk, and chunks to the shared cap', () => {
    const fn = HUB.slice(landmark(HUB, 'async function deleteRecords'), landmark(HUB, '/** The confirmation for a bulk delete'));
    const clientChunk = Number((/const CHUNK = (\d+)/.exec(fn) || [])[1]);
    const serverCap = Number((/const MAX_BULK = (\d+)/.exec(RECORDS) || [])[1]);
    assert.ok(clientChunk > 0 && serverCap > 0, 'the chunk size or the server cap has gone');
    assert.ok(clientChunk <= serverCap,
        `the client sends ${clientChunk} at a time but the server accepts ${serverCap} — every bulk `
        + 'clear-out over the cap would 400');
    assert.ok(/credentials: 'same-origin'/.test(fn), 'the bulk DELETE lost its credentials — it would 401');
    assert.ok(/reason \? \{ ids: slice, reason \} : \{ ids: slice \}/.test(fn),
        'the reason must reach the server on every chunk, or the evidence is banked for the first '
        + 'chunk only');
});

check('a partial bulk clear-out reports what really happened', () => {
    const fn = HUB.slice(landmark(HUB, 'async function deleteRecords'), landmark(HUB, '/** The confirmation for a bulk delete'));
    assert.ok(/deleted, then it stopped/.test(fn),
        'a chunk failing after earlier chunks succeeded must not report a flat failure — those '
        + 'leads really are gone, and "it failed" invites a second press on a changed list');
});

check('the confirmation asks once, for the whole selection, BEFORE anything is deleted', () => {
    const strip = HUB.slice(landmark(HUB, 'function bulkDeleteStrip'), landmark(HUB, '// ── Who performs the suggested next step'));
    assert.ok(/RC\.leadRejectReasons/.test(strip),
        'the strip must offer the shared vocabulary — a retyped list drifts from the CHECK constraint');
    assert.ok(/data-hub-bulk-plain/.test(strip),
        'there must be a way to clear the queue without a reason. Blocking it on a vocabulary '
        + 'choice buys worse answers, not better ones.');
    assert.ok(/data-hub-bulk-cancel/.test(strip), 'a confirmation with no cancel is not a confirmation');
    assert.ok(landmark(strip, 'strip.innerHTML') < landmark(strip, 'deleteRecords('),
        'deleteRecords runs before the confirmation is even drawn');
});

check('the confirmation states the two things a user cannot guess', () => {
    const strip = HUB.slice(landmark(HUB, 'function bulkDeleteStrip'), landmark(HUB, '// ── Who performs the suggested next step'));
    assert.ok(/Nothing is emailed/.test(strip),
        'the reader is one click from a bulk decision on a hundred leads — say that it sends nothing');
    assert.ok(/leaves them rejected instead of putting them back in front of you/.test(strip),
        'the reason this is safe over a hundred rows is that a re-found lead stays rejected. If the '
        + 'copy does not say it, the user has no way to know it.');
    // ⚠️ Asserted as the CALL, not the literal string. The reject strip used to hardcode "No usable
    // contact" in its prose, which would silently disagree with the chip beside it the day the
    // label changed. Reading it back through leadRejectReasonLabel makes that impossible.
    assert.ok(/leadRejectReasonLabel\('bad_contact'\)/.test(strip),
        'the strip must point at the honest reason for an uncontactable clear-out, by its real label');
    assert.ok(LEAD_REJECT_REASON_LABELS.bad_contact?.trim(),
        'bad_contact has no label to render — the sentence would name an empty chip');
});

check('the bulk bar is one action, and the Reject button is really gone', () => {
    const bar = HUB.slice(landmark(HUB, 'function paintSelectionBar'), landmark(HUB, 'function renderTable'));
    assert.ok(/Delete \$\{n\}/.test(bar),
        'the button must carry the count: it is the last thing read before a hundred leads are decided');
    assert.ok(!/data-hub-bulkreject/.test(HUB), 'the bulk Reject button survived');
    assert.ok(!/function bulkRejectStrip/.test(HUB), 'bulkRejectStrip survived as dead code');
    assert.ok(!/async function rejectRecords/.test(HUB), 'rejectRecords survived as dead code');

    const controls = HUB.slice(landmark(HUB, 'function controlsHtml'), landmark(HUB, 'function wireControls'));
    const wrapper = controls.slice(landmark(controls, 'ml-auto'));
    assert.ok(/data-hub-bulkdelete/.test(wrapper),
        'ml-auto must ride the WRAPPER holding the action, so a second button added back beside it '
        + 'does not push the first off the bar');
});

check('selecting everything does not require selecting something first', () => {
    // The complaint that started this: "Select all" only ever lived INSIDE the bulk bar, and the
    // bar is hidden until a row is already ticked. A select-all reachable only by hand-ticking one
    // row is not a select-all.
    const table = HUB.slice(landmark(HUB, 'function renderTable'), landmark(HUB, '// ── The Deleted section'));
    assert.ok(/data-hub-selectall-head/.test(table),
        'the table heading has no select-all checkbox — the only one left is inside the hidden bar');
    const wire = HUB.slice(landmark(HUB, 'function wireControls'), landmark(HUB, 'function paintRows'));
    assert.ok(/data-hub-selectall-head/.test(wire), 'the heading checkbox is never wired up');
    assert.ok(/for \(const r of visibleRecords\(\)\) state\.selected\.add\(r\.id\)/.test(wire),
        'it must take in every row matching the FILTERS. Stopping at the current page silently '
        + 'leaves 112 of 137 behind after the user has said "select all".');

    const bar = HUB.slice(landmark(HUB, 'function paintSelectionBar'), landmark(HUB, 'function renderTable'));
    assert.ok(/head\.indeterminate/.test(bar),
        'without the indeterminate leg the heading reads "all selected" over three ticked rows');
    assert.ok(/Select all \$\{matching\}/.test(bar),
        'the count must be stated — a bare tick in a heading gives no clue whether it means this '
        + 'page or all 137');
});

console.log('\n──── no Tailwind rebuild ────');

check('every class the bulk delete strip uses is already compiled into style.css', () => {
    // A rebuild churns unrelated selectors across the whole app.
    const escapeSel = (t: string) => t.replace(/([:[\].\/])/g, '\\$1');
    const strip = HUB.slice(landmark(HUB, 'function bulkDeleteStrip'), landmark(HUB, '// ── Who performs the suggested next step'));
    const tokens = new Set<string>();
    for (const m of strip.matchAll(/class="([^"]*)"/g)) {
        for (const raw of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (raw) tokens.add(raw);
    }
    for (const m of strip.matchAll(/(?:const chip|strip\.className) = '([^']+)'/g)) {
        for (const raw of m[1].split(/\s+/)) if (raw) tokens.add(raw);
    }
    assert.ok(tokens.size > 15, `expected a real class list, parsed ${tokens.size}`);
    const missing = [...tokens].filter((t) => !CSS.includes('.' + escapeSel(t)));
    assert.deepStrictEqual(missing, [], `not compiled into style.css: ${missing.join(', ')}`);
});

console.log(`\n${passed} checks passed.`);
