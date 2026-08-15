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

check('the client chunks to that cap rather than being 400ed by it', () => {
    const fn = HUB.slice(landmark(HUB, 'async function rejectRecords'), landmark(HUB, 'function bulkRejectStrip'));
    const clientChunk = Number((/const CHUNK = (\d+)/.exec(fn) || [])[1]);
    const serverCap = Number((/const MAX_BULK = (\d+)/.exec(RECORDS) || [])[1]);
    assert.ok(clientChunk > 0 && serverCap > 0, 'the chunk size or the server cap has gone');
    assert.ok(clientChunk <= serverCap,
        `the client sends ${clientChunk} at a time but the server accepts ${serverCap} — every bulk `
        + 'reject over the cap would 400');
    assert.ok(/credentials: 'same-origin'/.test(fn), 'the bulk PATCH lost its credentials — it would 401');
    assert.ok(/approvalStatus: 'rejected'/.test(fn) && /reason \? \{ reason \}/.test(fn),
        'the reason must reach the server on every chunk, or the evidence is banked for the first '
        + 'chunk only');
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

console.log('\n──── the client rejects, and says what it did ────');

check('the rows stay — that is the whole difference from delete', () => {
    const fn = HUB.slice(landmark(HUB, 'async function rejectRecords'), landmark(HUB, 'function bulkRejectStrip'));
    assert.ok(/r\.approvalStatus = 'rejected'/.test(fn),
        'the table must patch the Approval chip in place. Removing the rows would tell the user '
        + 'their leads were deleted.');
    assert.ok(/state\.selected\.delete\(id\)/.test(fn),
        'the selection must clear as rows are decided, or the bar still offers to act on them');
    assert.ok(!/state\.records = state\.records\.filter/.test(fn),
        'rejectRecords is dropping records from the table — reject keeps them, on purpose');
});

check('a partial bulk reject reports what really happened', () => {
    const fn = HUB.slice(landmark(HUB, 'async function rejectRecords'), landmark(HUB, 'function bulkRejectStrip'));
    assert.ok(/rejected, then it stopped/.test(fn),
        'a chunk failing after earlier chunks succeeded must not report a flat failure — those '
        + 'leads really are rejected, and "it failed" invites a second press on a changed list');
    assert.ok(/for \(const id of ids\.slice\(0, i\)\)/.test(fn),
        'and the table must mark the rows that DID go through');
});

check('the confirmation asks once, for the whole selection, BEFORE anything is rejected', () => {
    const strip = HUB.slice(landmark(HUB, 'function bulkRejectStrip'), landmark(HUB, '/** The confirmation for a bulk delete'));
    assert.ok(/RC\.leadRejectReasons/.test(strip),
        'the strip must offer the shared vocabulary — a retyped list drifts from the CHECK constraint');
    assert.ok(/data-hub-bulkreject-plain/.test(strip),
        'there must be a way to reject without a reason. Blocking the clear-out on a vocabulary '
        + 'choice just pushes the user to Delete, which throws the evidence away entirely.');
    assert.ok(/data-hub-bulkreject-cancel/.test(strip), 'a confirmation with no cancel is not a confirmation');
    assert.ok(landmark(strip, 'strip.innerHTML') < landmark(strip, 'rejectRecords('),
        'rejectRecords runs before the confirmation is even drawn');
});

check('the confirmation states the two things a user cannot guess', () => {
    const strip = HUB.slice(landmark(HUB, 'function bulkRejectStrip'), landmark(HUB, '/** The confirmation for a bulk delete'));
    assert.ok(/nothing is emailed/.test(strip),
        'the reader is one click from a bulk decision on a hundred leads — say that it sends nothing');
    assert.ok(/it stays rejected rather than coming back for approval/.test(strip),
        'the reason to prefer this over Delete is that a re-found lead stays rejected. If the copy '
        + 'does not say it, the user has no way to know it.');
    assert.ok(new RegExp(LEAD_REJECT_REASON_LABELS.bad_contact).test(strip),
        'the strip must point at the honest reason for this clear-out by its real label');
});

check('Reject is offered for leads only, and does not disturb the bar when it is absent', () => {
    const bar = HUB.slice(landmark(HUB, 'function paintSelectionBar'), landmark(HUB, 'function renderTable'));
    assert.ok(/state\.hub\.recordType === 'lead'/.test(bar),
        'the other five record types have no rejection vocabulary and no discovery to teach');
    assert.ok(/reject\.style\.display/.test(bar),
        '`hidden` loses to a class that sets display — pin the inline style too');
    assert.ok(/Reject \$\{n\}/.test(bar),
        'the button must carry the count: it is the last thing read before a hundred leads are decided');

    const controls = HUB.slice(landmark(HUB, 'function controlsHtml'), landmark(HUB, 'function wireControls'));
    const wrapper = controls.slice(landmark(controls, 'ml-auto'));
    assert.ok(/data-hub-bulkreject/.test(wrapper) && /data-hub-bulkdelete/.test(wrapper),
        'ml-auto must ride the WRAPPER holding both buttons. On the first button it would drop '
        + 'Delete back against the Clear-selection link the moment Reject is hidden.');
});

check('the two bulk confirmations cannot stack', () => {
    const wire = HUB.slice(landmark(HUB, 'function wireControls'), landmark(HUB, 'function paintRows'));
    const opens = wire.split("strip.innerHTML = ''").length - 1;
    assert.strictEqual(opens, 2,
        'each bulk button must clear the shared strip host first. Two open confirmations above one '
        + 'selection is how someone presses Delete believing they are confirming the Reject they '
        + 'just asked for.');
});

console.log('\n──── no Tailwind rebuild ────');

check('every class the reject strip uses is already compiled into style.css', () => {
    // A rebuild churns unrelated selectors across the whole app.
    const escapeSel = (t: string) => t.replace(/([:[\].\/])/g, '\\$1');
    const strip = HUB.slice(landmark(HUB, 'function bulkRejectStrip'), landmark(HUB, '/** The confirmation for a bulk delete'));
    const tokens = new Set<string>();
    for (const m of strip.matchAll(/class="([^"]*)"/g)) {
        for (const raw of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (raw) tokens.add(raw);
    }
    // The chip palette and the strip's own className live in string literals, not class attributes.
    for (const m of strip.matchAll(/(?:const chip|strip\.className) = '([^']+)'/g)) {
        for (const raw of m[1].split(/\s+/)) if (raw) tokens.add(raw);
    }
    assert.ok(tokens.size > 15, `expected a real class list, parsed ${tokens.size}`);
    const missing = [...tokens].filter((t) => !CSS.includes('.' + escapeSel(t)));
    assert.deepStrictEqual(missing, [], `not compiled into style.css: ${missing.join(', ')}`);
});

console.log(`\n${passed} checks passed.`);
