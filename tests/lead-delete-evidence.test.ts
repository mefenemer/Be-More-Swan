// tests/lead-delete-evidence.test.ts
// Deleting a lead must not throw away what it taught us, or leave the discovery row lying.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// A prod assistant held 35 discovered leads, all marked `status='promoted'`, but only 14 still
// linked to an assistant_record. The other 21 had been deleted by hand — and every one of them
// was a junk hit (podcasts, news articles, job boards), which is to say every one was evidence
// that the search was aimed wrong. Reject files that evidence into lead_reject_feedback. Delete
// filed nothing, and Delete is the button that makes a screenful of noise disappear fastest.
//
// Two defects, both fixed in the DELETE handler:
//   1. No reason was ever captured, so the most reliable targeting signal we have was destroyed
//      by the most tempting action on the screen.
//   2. The discovery row kept `status='promoted'` with a null assistant_record_id — a state the
//      lifecycle vocabulary (discovered → qualified → promoted → discarded) cannot describe.
//
// ⚠️ THE INVARIANT WORTH DEFENDING — ORDERING.
// `discovered_leads.assistant_record_id` is ON DELETE SET NULL, and recordLeadRejection()
// resolves the lead, its campaign and its domain BY that id. So both the feedback write and the
// status update must happen BEFORE the delete. Move either one after it and they silently write
// nothing: no error, no row, no clue. That is precisely the failure mode this file exists to
// catch, and it cannot be caught by reading behaviour — only by reading order.
//
// Run:  npx tsx tests/lead-delete-evidence.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAD_REJECT_REASONS } from '../src/config/lead-reject-reasons';
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

// ── 1. The ordering that makes any of this work ──────────────────────────────

check('the feedback write happens BEFORE the delete', () => {
    const iFeedback = DELETE_BLOCK.indexOf('recordLeadRejection');
    const iDelete = DELETE_BLOCK.indexOf('db.delete(assistantRecords)');
    assert.ok(iFeedback !== -1, 'DELETE no longer records a rejection reason at all');
    assert.ok(iDelete !== -1, 'the delete itself has gone');
    assert.ok(iFeedback < iDelete,
        'recordLeadRejection runs AFTER the delete — ON DELETE SET NULL will have severed the link, so it silently records nothing');
});

check('the discovery row is marked discarded BEFORE the delete', () => {
    const iUpdate = DELETE_BLOCK.indexOf('db.update(discoveredLeads)');
    const iDelete = landmark(DELETE_BLOCK, 'db.delete(assistantRecords)');
    assert.ok(iUpdate !== -1, 'the discovery row is no longer moved to its terminal state');
    assert.ok(iUpdate < iDelete,
        'the status update runs AFTER the delete — assistant_record_id is already NULL, so it matches nothing');
    assert.ok(/status: 'discarded'/.test(DELETE_BLOCK),
        "the row should move to 'discarded', not stay at 'promoted' with a dangling link");
});

check('the FK really is ON DELETE SET NULL — the premise of the ordering rule', () => {
    // If this ever became CASCADE or RESTRICT the ordering above would still be correct, but the
    // reasoning in the comments would be wrong and the next reader would be misled.
    // ⚠️ discoveryJobs is declared BEFORE discoveredLeads, so slicing between those two names
    // yields an empty string and the assertion "passes" on nothing. Slice to the NEXT export
    // after discoveredLeads instead, whatever it happens to be.
    const start = SCHEMA.indexOf('export const discoveredLeads');
    assert.ok(start !== -1, 'the discoveredLeads table is gone');
    const next = SCHEMA.indexOf('\nexport const ', start + 1);
    const block = SCHEMA.slice(start, next === -1 ? undefined : next);
    assert.ok(block.includes('assistant_record_id'), 'the slice missed the column — check the table boundaries');
    assert.ok(/assistantRecordId: integer\("assistant_record_id"\).*onDelete: "set null"/.test(block),
        'discovered_leads.assistant_record_id no longer sets null on delete — revisit the ordering comments');
});

check("'discarded' is a legal status, so the update cannot violate the CHECK", () => {
    assert.ok(/discovered_leads_status_check[\s\S]{0,160}'discarded'/.test(SCHEMA),
        "the status CHECK no longer permits 'discarded' — the update would throw");
});

// ── 2. The reason is optional, and scoped to leads ───────────────────────────

check('a missing reason still deletes, and still discards the discovery row', () => {
    // Someone clearing twenty junk rows must never be blocked on an explanation. The status
    // change is a fact about the row; only the feedback write is conditional.
    assert.ok(/if \(reason\) \{/.test(DELETE_BLOCK), 'the reason is no longer optional');
    const iIfReason = landmark(DELETE_BLOCK, 'if (reason) {');
    const iUpdate = landmark(DELETE_BLOCK, 'db.update(discoveredLeads)');
    assert.ok(iUpdate > iIfReason && !DELETE_BLOCK.slice(iIfReason, iUpdate).includes('return'),
        'the discarded update must sit outside the reason branch — it applies either way');
});

check('non-lead records are untouched by any of it', () => {
    assert.ok(/existing\.recordType === 'lead'/.test(DELETE_BLOCK),
        'the lead-only guard is gone — meetings, invoices and tickets would take the lead path');
});

check('a record belonging to another tenant is still a 404, before anything is written', () => {
    const iLookup = landmark(DELETE_BLOCK, 'const [existing]');
    const iNotFound = landmark(DELETE_BLOCK, "return json(404, { error: 'Record not found.' })");
    const iFeedback = landmark(DELETE_BLOCK, 'recordLeadRejection');
    assert.ok(/eq\(assistantRecords\.organisationId, orgId\)/.test(DELETE_BLOCK.slice(iLookup, iFeedback)),
        'the pre-delete lookup is not tenant-scoped — an IDOR would now also write feedback rows');
    assert.ok(iNotFound < iFeedback, 'the ownership check must short-circuit before any write');
});

// ── 3. The client asks before destroying the link ────────────────────────────

check('deleting a lead opens the reason strip instead of deleting immediately', () => {
    assert.ok(/function deleteReasonStrip/.test(HUB), 'the delete confirmation strip is gone');
    const btn = HUB.slice(landmark(HUB, "buttons.push({ label: 'Delete'"), landmark(HUB, 'const status = document.createElement'));
    assert.ok(/state\.hub\.recordType === 'lead'/.test(btn),
        'the lead branch is gone — deleting a lead would again destroy its provenance silently');
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

check('the strip names Reject as the non-destructive alternative', () => {
    const strip = HUB.slice(landmark(HUB, 'function deleteReasonStrip'), landmark(HUB, '// ── Rejecting a lead'));
    assert.ok(/<strong>Reject<\/strong>/.test(strip),
        'the strip no longer points at Reject — the whole point is that Delete stops being the silent default');
});

check('the reason reaches the server', () => {
    const fn = HUB.slice(landmark(HUB, 'async function deleteRecord'), landmark(HUB, '// ── Deleting a lead'));
    assert.ok(/reason \? \{ id, reason \} : \{ id \}/.test(fn),
        'deleteRecord no longer forwards the reason — the strip would collect it and drop it');
    assert.ok(/credentials: 'same-origin'/.test(fn), 'the DELETE lost its credentials — it would 401');
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
