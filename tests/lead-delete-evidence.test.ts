// tests/lead-delete-evidence.test.ts
// Deleting a lead must not throw away what it taught us, or leave the discovery row lying.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// A prod assistant held 35 discovered leads, all marked `status='promoted'`, but only 14 still
// linked to an assistant_record. The other 21 had been deleted by hand — and every one of them
// was a junk hit (podcasts, news articles, job boards), which is to say every one was evidence
// that the search was aimed wrong. Delete filed nothing, and Delete is the button that makes a
// screenful of noise disappear fastest.
//
// ── The shape of the fix CHANGED on 2026-08-15 ───────────────────────────────
// It used to be "capture a reason before the row is destroyed". The row is no longer destroyed:
// deleting a LEAD marks it rejected, banks the reason, discards the discovery row, and stamps
// `data.retention.deletedAt` so it appears in the Deleted section instead of vanishing. Delete
// and Reject were two names for one act with an invisible difference, so one of them went and the
// survivor does the careful thing.
//
// ⚠️ THE INVARIANT WORTH DEFENDING NOW — THE ROW SURVIVES.
// `discovered_leads.assistant_record_id` is ON DELETE SET NULL. That FK is why a hard delete
// silently severed provenance, and why the ordering rule used to exist. The rule is discharged by
// there being no delete at all on this path — so what has to be defended is that no `db.delete`
// can reach a lead, and that the four writes which replace it all happen.
//
// Everything below is a source-consistency check: no database, no DOM.
// Run:  npx tsx tests/lead-delete-evidence.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAD_REJECT_REASONS } from '../src/config/lead-reject-reasons';
import {
    RETENTION_REASONS, RETENTION_REASON_LABELS, RETENTION_REASON_NOTES, RETENTION_REASON_USER_DELETE,
} from '../src/config/lead-retention';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const RECORDS = read('netlify/functions/assistant-records.ts');
const HUB = read('src/components/assistant-data-hub.js');
const SCHEMA = read('db/schema.ts');

/**
 * Strip comments before asserting on ORDER.
 *
 * ⚠️ Not optional. The first draft of this file checked `indexOf('recordLeadRejection') <
 * indexOf('db.delete')` against the raw source and passed — by matching the name inside the block
 * comment ABOVE the code, which sits earlier in the file than either statement. The assertion was
 * green while proving nothing, and would have stayed green if the call moved after the delete,
 * which is the exact regression it exists to catch. Any positional assertion has to run against
 * code alone.
 *
 * Only whole-line `//` comments and `/* *\/` blocks are removed, so a `//` inside a string (a URL,
 * say) is left alone.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

/** The DELETE branch only — assertions about ordering must not match code from other verbs. */
const DELETE_BLOCK = stripComments(RECORDS).slice(
    stripComments(RECORDS).indexOf("if (event.httpMethod === 'DELETE')"),
    stripComments(RECORDS).indexOf('return { statusCode: 405'),
);

// ── 1. A lead is retained, not dropped ───────────────────────────────────────

check('the lead path never reaches db.delete — the row survives the delete', () => {
    // The whole fix. The FK below is ON DELETE SET NULL, so a db.delete on this path would sever
    // the provenance recordLeadRejection resolves BY, empty the Deleted section of the one thing
    // it exists to hold, and re-open the re-discovery hole (see the FK check further down).
    const lead = DELETE_BLOCK.slice(
        landmark(DELETE_BLOCK, "existing.recordType === 'lead'"),
        landmark(DELETE_BLOCK, 'const [row] = await db.delete(assistantRecords)'),
    );
    assert.ok(!/db\.delete\(assistantRecords\)/.test(lead),
        'a lead is being hard-deleted again — the record IS the verdict, and deleting it destroys '
        + 'the only thing stopping a second search re-finding the same company');
    assert.ok(/continue;/.test(lead),
        'the lead branch must return to the loop, or it falls through into the non-lead delete below');
});

check('deleting a lead marks it rejected and clears its due date', () => {
    assert.ok(/approvalStatus: 'rejected'/.test(DELETE_BLOCK),
        "promoteOne's update path does not touch approval_status, so only a REJECTED lead stays "
        + 'rejected when a later run re-finds it. Without this the delete is undone by the next run.');
    assert.ok(/scheduledFor: null/.test(DELETE_BLOCK),
        'a deleted lead with a chase date is a row the Calendar still believes in');
});

check('it is stamped into the retained Deleted section, by the shared vocabulary', () => {
    assert.ok(/RETENTION_REASON_USER_DELETE/.test(RECORDS),
        'the reason is hand-typed instead of coming from src/config/lead-retention.ts — a value '
        + 'outside RETENTION_REASONS renders as "Waited 30 days without a decision", which is a lie '
        + 'about how the lead got there');
    assert.ok(RETENTION_REASONS.includes(RETENTION_REASON_USER_DELETE),
        'the manual-delete reason is not in the closed vocabulary, so retentionReasonOf() will '
        + 'silently fall back to unreviewed');
    assert.ok(RETENTION_REASON_LABELS[RETENTION_REASON_USER_DELETE]?.trim()
        && RETENTION_REASON_NOTES[RETENTION_REASON_USER_DELETE]?.trim(),
        'a lead in the Deleted section with no sentence explaining how it got there is just a lead '
        + 'that vanished');
    assert.ok(/jsonb_set\(/.test(DELETE_BLOCK) && /RETENTION_FIELD/.test(DELETE_BLOCK),
        'the stamp must be a jsonb_set on the retention key alone. A wholesale rewrite of `data` '
        + 'races the enrichment worker and drops enrichAttemptedAt / dealOutcome / the draft.');
    assert.ok(/deletedAt/.test(DELETE_BLOCK),
        'deletedAt is the presence test isRetentionDeleted() uses — without it the lead stays in '
        + 'the live table, now silently rejected, which is the worst of both designs');
});

check('the discovery row still moves to its terminal state', () => {
    assert.ok(/db\.update\(discoveredLeads\)/.test(DELETE_BLOCK),
        'the discovery row is no longer moved to its terminal state');
    assert.ok(/status: 'discarded'/.test(DELETE_BLOCK),
        "the row should move to 'discarded', not stay at 'promoted'");
});

check('the FK really is ON DELETE SET NULL — the premise of the whole design', () => {
    // If this became CASCADE the retained record would still be right, but a future hard delete
    // would take the discovery row with it and the comments here would be wrong.
    // ⚠️ discoveryJobs is declared BEFORE discoveredLeads, so slicing between those two names
    // yields an empty string and the assertion "passes" on nothing. Slice to the NEXT export
    // after discoveredLeads instead, whatever it happens to be.
    const start = SCHEMA.indexOf('export const discoveredLeads');
    assert.ok(start !== -1, 'the discoveredLeads table is gone');
    const next = SCHEMA.indexOf('\nexport const ', start + 1);
    const block = SCHEMA.slice(start, next === -1 ? undefined : next);
    assert.ok(block.includes('assistant_record_id'), 'the slice missed the column — check the table boundaries');
    assert.ok(/assistantRecordId: integer\("assistant_record_id"\).*onDelete: "set null"/.test(block),
        'discovered_leads.assistant_record_id no longer sets null on delete — revisit the comments');
});

check("'discarded' is a legal status, so the update cannot violate the CHECK", () => {
    assert.ok(/discovered_leads_status_check[\s\S]{0,160}'discarded'/.test(SCHEMA),
        "the status CHECK no longer permits 'discarded' — the update would throw");
});

// ── 2. The rejection is recorded where the Strategy Agent reads it ───────────

check('a delete writes the same ledger event a reject does, under the same guard', () => {
    // Delete IS the rejection now. If it skipped the ledger, every rejection made through the
    // button most people reach for would be invisible to the cluster the Strategy Agent retargets
    // on — and the count would silently under-report.
    assert.ok(/recordEvent\(db, 'lead_rejected'/.test(DELETE_BLOCK),
        'the delete path writes no ledger event at all');
    assert.ok(/const wasDecided = LIVE_APPROVAL\.has\(existing\.approvalStatus \?\? ''\)/.test(DELETE_BLOCK),
        'without the wasDecided guard, deleting an already-rejected lead writes a second '
        + 'lead_rejected row and inflates the count the Strategy Agent clusters on');
    assert.ok(/blueprintVersion: await getBlueprintVersion/.test(DELETE_BLOCK)
        && /icpSnapshot: await getIcpSnapshot/.test(DELETE_BLOCK),
        'neither attribution key can be backfilled — an event without them is permanently '
        + 'unattributable');
    assert.ok(/actor: 'user'/.test(DELETE_BLOCK),
        'this is the human gate; recording it as the assistant would corrupt the autonomy baseline');
});

// ── 3. The reason is optional, and scoped to leads ───────────────────────────

check('a missing reason still deletes, and still discards the discovery row', () => {
    // Someone clearing twenty junk rows must never be blocked on an explanation. The status
    // change is a fact about the row; only the feedback write is conditional.
    assert.ok(/if \(reason\) \{/.test(DELETE_BLOCK), 'the reason is no longer optional');
    const iIfReason = landmark(DELETE_BLOCK, 'if (reason) {');
    const iUpdate = landmark(DELETE_BLOCK, 'db.update(discoveredLeads)');
    assert.ok(iUpdate > iIfReason && !DELETE_BLOCK.slice(iIfReason, iUpdate).includes('return'),
        'the discarded update must sit outside the reason branch — it applies either way');
    assert.ok(/recordLeadRejection\(db, \{/.test(DELETE_BLOCK),
        'the reason must go through the shared writer, not a second insert');
});

check('non-lead records really are deleted', () => {
    assert.ok(/existing\.recordType === 'lead'/.test(DELETE_BLOCK),
        'the lead-only guard is gone — meetings, invoices and tickets would be retained forever in '
        + 'a Deleted section none of them has');
    assert.ok(/db\.delete\(assistantRecords\)/.test(DELETE_BLOCK),
        'the hard delete has gone entirely; the other five record types have nowhere to be retained');
});

check('a record belonging to another tenant is still a 404, before anything is written', () => {
    const iLookup = landmark(DELETE_BLOCK, 'const [existing]');
    const iNotFound = landmark(DELETE_BLOCK, "return json(404, { error: 'Record not found.' })");
    const iWrite = landmark(DELETE_BLOCK, 'recordEvent(');
    assert.ok(/eq\(assistantRecords\.organisationId, orgId\)/.test(DELETE_BLOCK.slice(iLookup, iWrite)),
        'the pre-write lookup is not tenant-scoped — an IDOR would now also write ledger rows');
    assert.ok(iNotFound < iWrite, 'the ownership check must short-circuit before any write');
});

// ── 4. The client asks why, and says where the lead went ─────────────────────

check('deleting a lead opens the reason strip instead of deleting immediately', () => {
    assert.ok(/function deleteReasonStrip/.test(HUB), 'the delete confirmation strip is gone');
    const btn = HUB.slice(landmark(HUB, "buttons.push({ label: 'Delete'"), landmark(HUB, 'const status = document.createElement'));
    assert.ok(/state\.hub\.recordType === 'lead'/.test(btn),
        'the lead branch is gone — deleting a lead would again skip the reason capture');
    assert.ok(/deleteReasonStrip\(record\)/.test(btn), 'the strip is never shown');
});

check('the strip offers the real reason vocabulary, and an escape from it', () => {
    const strip = HUB.slice(landmark(HUB, 'function deleteReasonStrip'), landmark(HUB, '// ── Rejecting a lead'));
    assert.ok(/RC\.leadRejectReasons/.test(strip),
        'the strip no longer reads the shared vocabulary — a retyped list would drift from the CHECK constraint');
    assert.ok(/data-hub-del-plain/.test(strip),
        'there is no way to delete without a reason — that turns a destructive action into a hostage negotiation');
    assert.ok(/data-hub-del-cancel/.test(strip), 'a confirmation with no cancel is not a confirmation');
});

check('the strip says where the lead goes, since it no longer offers a second button', () => {
    // ⚠️ Was: "the strip names Reject as the non-destructive alternative". Reject is gone; the
    // copy's job is now to state the destination, which is the ONLY thing that stops a user
    // believing they destroyed the record.
    const strip = HUB.slice(landmark(HUB, 'function deleteReasonStrip'), landmark(HUB, '// ── Rejecting a lead'));
    assert.ok(/<strong>Deleted<\/strong>/.test(strip),
        'the confirmation must name the Deleted section the lead is filed into');
    assert.ok(/marked rejected/.test(strip),
        'and say it is marked rejected — that is what stops a later search putting it back');
    assert.ok(!/<strong>Reject<\/strong>/.test(strip),
        'the strip still points at a Reject button that no longer exists on this tab');
});

check('the Reject button and its strip are really gone from this tab', () => {
    const code = stripComments(HUB);
    assert.ok(!/buttons\.push\(\{ label: 'Reject'/.test(code),
        'the row action bar still offers Reject beside Delete — the two are one act now');
    assert.ok(!/function rejectReasonStrip/.test(code), 'rejectReasonStrip survived as dead code');
    assert.ok(!/data-hub-bulkreject/.test(code), 'the bulk bar still carries a Reject button');
});

check('the domain-exclusion follow-up survived the merge', () => {
    // It used to hang off Reject. Removing Reject without moving it would have quietly removed the
    // one follow-up that changes what the NEXT run finds.
    const strip = HUB.slice(landmark(HUB, 'function deleteReasonStrip'), landmark(HUB, '// ── Rejecting a lead'));
    assert.ok(/offerDomainExclusion\(strip, data\.domain, data\.campaignId/.test(strip),
        'the delete path no longer offers to exclude the domain');
    assert.ok(/canExcludeDomain/.test(RECORDS),
        'the server no longer tells the client whether the domain can be excluded — that verdict '
        + 'needs the reason vocabulary AND the discovery provenance, and the browser has neither');
    // The offer is drawn inside the row's own panel, which the repaint destroys.
    assert.ok(/\{ defer: true \}/.test(strip),
        'the repaint is not deferred — renderTable would tear the offer off the screen before it '
        + 'could be answered');
});

check('the reason reaches the server', () => {
    const fn = HUB.slice(landmark(HUB, 'async function deleteRecord'), landmark(HUB, 'async function finishDelete'));
    assert.ok(/reason \? \{ id, reason \} : \{ id \}/.test(fn),
        'deleteRecord no longer forwards the reason — the strip would collect it and drop it');
    assert.ok(/credentials: 'same-origin'/.test(fn), 'the DELETE lost its credentials — it would 401');
});

check('the Deleted section is refetched, not just re-rendered', () => {
    // The row has MOVED. A repaint alone shows it leaving the table and arriving nowhere, which is
    // the exact question ("where did my lead go?") this change exists to answer.
    const fn = HUB.slice(landmark(HUB, 'async function finishDelete'), landmark(HUB, '// ── Deleting a lead'));
    assert.ok(/fetchDeletedRecords\(\)/.test(fn), 'finishDelete does not refetch the Deleted section');
    assert.ok(/renderTable\(\)/.test(fn), 'and it must still repaint the table');
});

check('every reason the strip can send is one the server will accept', () => {
    // The strip renders RC.leadRejectReasons (generated from LEAD_REJECT_REASONS) and the server
    // validates against the same closed list via isLeadRejectReason. Assert the vocabulary is
    // non-empty and shared, so a chip can never post a value that is silently dropped.
    assert.ok(LEAD_REJECT_REASONS.length > 0, 'the reject vocabulary is empty');
    const GENERATED = read('src/generated/platform-constants.js');
    for (const reason of LEAD_REJECT_REASONS) {
        assert.ok(GENERATED.includes(`"${reason}"`),
            `${reason} is missing from the generated client constants — run npm run gen:constants`);
    }
});

console.log(`\n${passed} checks passed.`);
