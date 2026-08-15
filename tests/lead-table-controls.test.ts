// tests/lead-table-controls.test.ts
// The Leads tab as a table you can WORK: filter, sort, group, select, and clear out in bulk.
//
// ── What this is defending ───────────────────────────────────────────────────
// The Data Hub table rendered every record in whatever order the API returned, with no way to
// narrow it and no way to remove more than one row at a time. Fine at twelve rows; two discovery
// runs make it four hundred, at which point the three questions people actually arrive with —
// "which need me?", "which are best?", "which are junk?" — have no answer on the screen, and the
// junk stays forever because clearing it costs one open-delete-refind cycle per row.
//
// Four properties are worth pinning, and every one of them is invisible to the compiler:
//
//   1. THE CONTROLS ARE GENERIC. They are built from hub.columns, so the Ledger and the ticket
//      hubs get them too. A lead-specific column name in the control code is the bug.
//   2. FILTERS AND THE TABLE AGREE. Everything compares the RENDERED cell value, and a filter
//      whose value has vanished from the data keeps its dropdown — otherwise the strip reads
//      "All" over a table reading "0 of 22".
//   3. SELECT-ALL SAYS ITS NUMBER. "Select all" that quietly takes in four hundred rows behind a
//      filter showing twelve is how someone deletes their pipeline.
//   4. BULK DELETE IS THE SAME DELETE. One implementation, looped — the ownership check, the
//      evidence write and the discovery-row status, in that order, per record. A bulk path that
//      skipped any of it would destroy exactly the targeting signal the single path preserves
//      (see lead-delete-evidence.test.ts, which owns that ordering rule).
//
// Plus the two smaller changes that ride with them: the next step now says WHO performs it, and
// the address no longer announces which data supplier found it.
//
// No database, no DOM: source-consistency checks, like every other suite here.
// Run:  npx tsx tests/lead-table-controls.test.ts

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
const CARD = read('src/components/disruptive-ui-registry.js');
const RECORDS = read('netlify/functions/assistant-records.ts');
const CSS = read('style.css');

/** Whole-line `//` and `/* *\/` comments only, so a `//` inside a URL survives. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
}

console.log('\n──── filter, sort and group work on the columns that are there ────');

check('the controls are built from hub.columns, not from a lead-specific list', () => {
    const controls = HUB.slice(landmark(HUB, 'function controlsHtml'), landmark(HUB, 'function wireControls'));
    assert.ok(/hub\.columns\.map/.test(controls),
        'the group-by list must enumerate the hub\'s own columns — a hardcoded list strands every '
        + 'other records hub with controls that describe the Leads tab');
    assert.ok(/filterableColumns\(\)/.test(controls), 'the per-column filters are no longer derived from the columns');
    // A column key written into the control code is the tell that this stopped being generic.
    for (const leadOnly of ['approvalStatus', 'suggestedNextStep', 'contactEmail']) {
        assert.ok(!controls.includes(`'${leadOnly}'`),
            `controlsHtml names the lead column ${leadOnly} — the strip must not know what a lead is`);
    }
});

check('filtering, grouping and search all compare the RENDERED cell', () => {
    // One definition, so a filter offering "Awaiting you" selects the rows that say "Awaiting you".
    // If any of the three drifts onto the raw record, the control and the cell disagree and there
    // is nothing on screen to explain why.
    for (const [fn, end] of [
        ['function matchesView', 'function visibleRecords'],
        ['function groupVisible', 'function selectable'],
        ['function distinctValues', 'MAX_FILTER_OPTIONS'],
    ] as Array<[string, string]>) {
        const body = HUB.slice(landmark(HUB, fn), landmark(HUB, end));
        assert.ok(/cellValue\(/.test(body), `${fn} no longer reads the rendered value`);
    }
});

check('sorting departs from the rendered value only where the alphabet is wrong', () => {
    const sort = HUB.slice(landmark(HUB, 'function sortValue'), landmark(HUB, 'function compareRecords'));
    assert.ok(/ORDERED_VALUES/.test(sort), 'the vocabulary ranks are gone — Rating would sort cold, hot, warm');
    assert.ok(/updatedAt/.test(sort) && /getTime\(\)/.test(sort),
        'dates must sort as dates; the rendered "9 Aug 2026" sorts alphabetically');
    assert.ok(/Number\.isFinite/.test(sort),
        'a numeric column must sort numerically, or Score puts 9 after 100');

    const vocab = HUB.slice(landmark(HUB, 'const ORDERED_VALUES'), landmark(HUB, 'function sortValue'));
    // These are the rendered chip labels, not the stored values — see APPROVAL_CHIP / CONTACT_CHIP.
    // A rank naming a stored value would silently rank nothing and sort every row equal.
    for (const shown of ['hot', 'Awaiting you', 'Role inbox']) {
        assert.ok(vocab.includes(`'${shown}'`), `the ordered vocabulary lost ${shown}`);
    }
    assert.ok(!/'pending_approval'/.test(vocab),
        'the approval ranks name STORED values — the column renders "Awaiting you", so nothing would match');
});

check('an active filter keeps its dropdown even when nothing has that value any more', () => {
    // Filter to "hot", delete every hot lead: the option leaves distinctValues, the select falls
    // back to "All", and the strip then reads "All" above a table reading "0 of 22".
    const cols = HUB.slice(landmark(HUB, 'function filterableColumns'), landmark(HUB, 'function matchesView'));
    assert.ok(/state\.view\.filters\[c\.key\]\) return true/.test(cols),
        'a column being filtered on must keep its control whatever the data has become');
    const controls = HUB.slice(landmark(HUB, 'function controlsHtml'), landmark(HUB, 'function wireControls'));
    assert.ok(/options\.includes\(chosen\)\) options\.push\(chosen\)/.test(controls),
        'the chosen value must survive in the option list, or the select lies about what is filtered');
});

check('the search box is not rebuilt on every keystroke', () => {
    // controlsHtml holds the input. Re-rendering it per keystroke takes the caret with it.
    const paint = HUB.slice(landmark(HUB, 'function paintRows'), landmark(HUB, 'function paintSelectionBar'));
    assert.ok(!/controlsHtml\(\)/.test(paint),
        'paintRows rebuilds the controls — typing in the search box would lose focus after one letter');
    assert.ok(/data-hub-tbody/.test(paint), 'paintRows must repaint the body only');
});

check('an over-filtered table offers the way out', () => {
    const paint = HUB.slice(landmark(HUB, 'function paintRows'), landmark(HUB, 'function paintSelectionBar'));
    assert.ok(/Nothing matches these filters/.test(paint),
        'an empty filtered table must say it is empty BECAUSE of the filters, not look broken');
    assert.ok(/data-hub-clear-inline/.test(paint), 'and it must offer to clear them from where the user is looking');
});

check('the view survives a refresh, and does not survive a different assistant', () => {
    const init = HUB.slice(landmark(HUB, 'async function init('), landmark(HUB, 'async function refresh('));
    assert.ok(/state\.view = \{/.test(init) && /state\.selected\.clear\(\)/.test(init),
        'init() must reset the view — a different assistant is a different table, with different columns');
    const refresh = HUB.slice(landmark(HUB, 'async function refresh('));
    assert.ok(!/state\.view = \{/.test(refresh.slice(0, 600)),
        'refresh() must NOT reset the view: the tab re-reads on every open, and a filter that '
        + 'clears itself when you come back to it is the tab losing your place');
});

console.log('\n──── selecting rows, and clearing them out ────');

check('selection is state, not DOM — it survives a repaint', () => {
    assert.ok(/selected: new Set\(\)/.test(HUB),
        'the selection must be a Set of ids; rows are re-rendered on every keystroke and after '
        + 'every PATCH, so a checked attribute left in the DOM clears itself');
    const row = HUB.slice(landmark(HUB, 'function rowHtml'), landmark(HUB, 'function refreshRow'));
    assert.ok(/state\.selected\.has\(record\.id\) \? 'checked'/.test(row),
        'the checkbox must render FROM the set, or refreshRow silently unticks the row it refreshes');
});

check('ticking a row does not also open it', () => {
    const paint = HUB.slice(landmark(HUB, 'function paintRows'), landmark(HUB, 'function paintSelectionBar'));
    const click = paint.slice(landmark(paint, "tr.addEventListener('click'"));
    assert.ok(/data-hub-select/.test(click) && /return;/.test(click),
        'the row click handler must short-circuit on the checkbox — otherwise selecting twelve rows '
        + 'unfurls twelve detail panels down the page');
});

check('select-all is scoped to the filter, and says how many that is', () => {
    const bar = HUB.slice(landmark(HUB, 'function paintSelectionBar'), landmark(HUB, 'function renderTable'));
    assert.ok(/visibleRecords\(\)\.length/.test(bar),
        'select-all must count the FILTERED rows, not every record');
    assert.ok(/Select all \$\{matching\} matching/.test(bar),
        'the button must state the number it is about to select — an unlabelled select-all behind a '
        + 'filter is how a pipeline gets deleted');
    assert.ok(/Delete \$\{n\}/.test(bar),
        'the delete button must carry the count: it is the last thing read before the records go');
    assert.ok(/bar\.style\.display/.test(bar),
        'the bar is a flex row, so `hidden` alone loses — pin the inline style too');

    const wire = HUB.slice(landmark(HUB, 'function wireControls'), landmark(HUB, 'function paintRows'));
    assert.ok(/for \(const r of visibleRecords\(\)\) state\.selected\.add/.test(wire),
        'select-all must add exactly the visible rows');
});

check('the reason is asked once, for the whole selection, BEFORE anything is deleted', () => {
    const strip = HUB.slice(landmark(HUB, 'function bulkDeleteStrip'), landmark(HUB, '// ── Who performs the suggested next step'));
    assert.ok(/RC\.leadRejectReasons/.test(strip),
        'the bulk strip must offer the shared vocabulary — a retyped list drifts from the CHECK constraint');
    assert.ok(/data-hub-bulk-plain/.test(strip),
        'there must be a way to delete without a reason; a destructive action is not a hostage negotiation');
    assert.ok(/data-hub-bulk-cancel/.test(strip), 'a confirmation with no cancel is not a confirmation');
    assert.ok(/<strong>Reject<\/strong>/.test(strip),
        'the strip must name Reject as the non-destructive alternative, exactly as the single-row one does');

    // Ordering: the strip is built and shown; the delete only runs from a button inside it.
    const code = stripComments(strip);
    assert.ok(landmark(code, 'strip.innerHTML') < landmark(code, 'deleteRecords('),
        'deleteRecords runs before the confirmation is even drawn');
});

check('the client chunks to the server cap rather than being truncated by it', () => {
    const fn = HUB.slice(landmark(HUB, 'async function deleteRecords'), landmark(HUB, 'function bulkDeleteStrip'));
    const clientChunk = Number((/const CHUNK = (\d+)/.exec(fn) || [])[1]);
    // ⚠️ `= ` in the pattern, so this cannot drift onto MAX_BULK_RECORDS (the 500-row import cap).
    const serverCap = Number((/const MAX_BULK = (\d+)/.exec(RECORDS) || [])[1]);
    assert.ok(clientChunk > 0 && serverCap > 0, 'the chunk size or the server cap has gone');
    assert.ok(clientChunk <= serverCap,
        `the client sends ${clientChunk} at a time but the server accepts ${serverCap} — every bulk `
        + 'delete over the cap would 400');
    assert.ok(/credentials: 'same-origin'/.test(fn), 'the bulk DELETE lost its credentials — it would 401');
    assert.ok(/reason \? \{ ids: slice, reason \} : \{ ids: slice \}/.test(fn),
        'the reason must reach the server for every chunk, or the evidence is banked for the first 100 only');
});

check('a partial bulk delete reports what really happened', () => {
    const fn = HUB.slice(landmark(HUB, 'async function deleteRecords'), landmark(HUB, 'function bulkDeleteStrip'));
    assert.ok(/deleted, then it stopped/.test(fn),
        'a chunk failing after earlier chunks succeeded must not report a flat failure — those '
        + 'records really are gone, and "delete failed" invites a second press on a changed list');
    assert.ok(/state\.records = state\.records\.filter\(\(r\) => !ids\.slice\(0, i\)/.test(fn),
        'and the table must drop the rows that DID go, or it shows records the server no longer has');
});

console.log('\n──── the bulk path IS the single path ────');

const DELETE_BLOCK = (() => {
    const src = stripComments(RECORDS);
    return src.slice(landmark(src, "if (event.httpMethod === 'DELETE')"), landmark(src, 'return { statusCode: 405'));
})();

check('ids are a loop over the one-record body, not a second implementation', () => {
    assert.ok(/for \(const id of ids\)/.test(DELETE_BLOCK), 'the bulk path is not a loop over the single path');
    // Exactly one of each. Two would mean the bulk branch grew its own copy, and copies drift.
    for (const once of ['recordLeadRejection(', 'db.update(discoveredLeads)', 'db.delete(assistantRecords)']) {
        const n = DELETE_BLOCK.split(once).length - 1;
        assert.strictEqual(n, 1,
            `${once} appears ${n} times in the DELETE handler — the bulk path must reuse the single `
            + 'path, not fork it. lead-delete-evidence.test.ts guards the ORDER of these three; a '
            + 'second copy is a second order to get wrong.');
    }
});

check('going over the cap is refused, never silently truncated', () => {
    assert.ok(/idList\.length > MAX_BULK/.test(DELETE_BLOCK), 'the cap is not enforced');
    assert.ok(/return json\(400, \{ error: `Delete up to \$\{MAX_BULK\}/.test(DELETE_BLOCK),
        'over the cap must 400. Deleting 100 of the 500 someone selected and reporting success is '
        + 'the worst answer available.');
    assert.ok(!/\.slice\(0, MAX_BULK\)/.test(DELETE_BLOCK), 'the id list is being truncated to the cap');
});

check('a missing record still 404s on the single path, and is only counted on the bulk one', () => {
    assert.ok(/if \(!bulk\) return json\(404/.test(DELETE_BLOCK),
        'the single path must still 404 — callers depend on it');
    assert.ok(/notFound\+\+/.test(DELETE_BLOCK),
        'a bulk run must count what was already gone rather than failing the other 49 rows the user selected');
});

check('every id is still tenant-scoped, inside the loop', () => {
    const loop = DELETE_BLOCK.slice(landmark(DELETE_BLOCK, 'for (const id of ids)'));
    const scoped = loop.split('eq(assistantRecords.organisationId, orgId)').length - 1;
    assert.ok(scoped >= 2,
        'both the lookup and the delete must be organisation-scoped inside the loop — one unscoped '
        + 'id in a list of a hundred is an IDOR that deletes another tenant\'s record');
});

console.log('\n──── the next step says who performs it ────');

check('the owner is read from the lead\'s state, never from the model\'s sentence', () => {
    const fn = HUB.slice(landmark(HUB, 'function nextStepGuidance'), landmark(HUB, 'function syncNextStepFooter'));
    assert.ok(/outreachSentAt/.test(fn),
        'the only honest marker that mail has left is the send stamp lead-generation.ts writes');
    assert.ok(/contactEmailOf\(record\)/.test(fn), 'a lead with no address is inert whatever else is true');
    assert.ok(/approvalStatus === 'rejected'/.test(fn) && /dealOutcome/.test(fn),
        'a decided lead has no next step worth chasing');
    // Matching the SENTENCE would be guessing dressed as logic, and getting it wrong tells someone
    // their assistant is handling a phone call it cannot make.
    assert.ok(!/suggestedNextStep/.test(fn),
        'the guidance is parsing the model\'s prose — decide from the record\'s state instead');
});

check('the assistant is only credited with what it actually does', () => {
    const fn = HUB.slice(landmark(HUB, 'function nextStepGuidance'), landmark(HUB, 'function syncNextStepFooter'));
    const assistantBranch = fn.slice(landmark(fn, "owner: 'assistant'"), landmark(fn, "owner: 'assistant'") + 400);
    assert.ok(/is yours/.test(assistantBranch),
        'even on a sent lead the note must say the rest of the step belongs to the user — the '
        + 'platform sends email and nothing else');
    assert.ok(/approvalStatus === 'approved'/.test(fn) && /nothing has been sent yet/i.test(fn),
        'approving in the Leads tab sends nothing, and the footer must say so — the Review tab is '
        + 'where the email goes out');
});

check('the button presses the real control instead of repeating it', () => {
    const wire = HUB.slice(landmark(HUB, 'function wireNextStepAction'), landmark(HUB, '// Meetings:'));
    assert.ok(/data-hub-action="\$\{key\}"/.test(wire) && /target\.click\(\)/.test(wire),
        'the next-step button must press the action-bar button. A second copy of approve/delete is '
        + 'a second place for the status line, the disabled state and the chip refresh to disagree.');
    assert.ok(/if \(!target\) return;/.test(wire),
        'if the state moved on and the control is gone, do nothing — never a button that pretends');
    // And the bar has to carry the handles.
    assert.ok(/if \(b\.key\) btn\.setAttribute\('data-hub-action', b\.key\)/.test(HUB),
        'the action bar no longer exposes its buttons by key');
});

check('the footer is re-stated when a decision changes the answer', () => {
    const approve = HUB.slice(landmark(HUB, "buttons.push({ label: 'Approve'"), landmark(HUB, "buttons.push({ label: 'Reject'"));
    assert.ok(/syncNextStepFooter\(/.test(approve),
        '"Approving clears this lead for outreach" is false the instant it has been approved');
});

check('only the surface holding the action bar may render a button', () => {
    const panel = HUB.slice(landmark(HUB, 'DisruptiveUIRegistry.render(record.data'), landmark(HUB, 'DisruptiveUIRegistry.render(record.data') + 300);
    assert.ok(/nextStep: nextStepGuidance\(record\)/.test(panel),
        'the Leads tab must supply the guidance');
    const footer = CARD.slice(landmark(CARD, 'function nextStepFooter'), landmark(CARD, 'function renderLeadScoringCard'));
    assert.ok(/if \(!owner\) return '';/.test(footer),
        'without guidance the card must render the step exactly as before — chat and the Review '
        + 'Queue have no action bar for a button to press');
});

console.log('\n──── the address stops naming the data supplier ────');

check('the "Found on <provider>" line is gone', () => {
    // ⚠️ Comment-stripped, and it has to be: the block comment where the line USED to be quotes it
    // verbatim while explaining why it went. A raw scan finds the phrase in its own obituary and
    // fails on documentation — the same trap lead-prompt-surfaces.test.ts and icp-snapshot.test.ts
    // both learned.
    const card = stripComments(CARD);
    assert.ok(!/published by the company, not verified/.test(card),
        'the provenance line is back. On a paid-provider hit emailFoundOn is the provider name, so '
        + 'the card announced "Found on hunter" to a user who has never heard of Hunter.');
    assert.ok(!/emailFoundOn/.test(card), 'the card is still rendering where the address came from');
});

check('the personal-inbox warning stays — it is a different question', () => {
    const card = CARD.slice(landmark(CARD, 'function renderLeadScoringCard'), landmark(CARD, "register('lead_scoring_card'"));
    assert.ok(/isPersonalInbox/.test(card) && /Personal inbox/.test(card),
        'the warning that this is a named individual is the one provenance fact the reader acts on');
});

check('the provenance itself is still recorded, and still gates the send', () => {
    // Not rendering it is a UI decision. Dropping it would disarm needsPersonalInboxConfirmation.
    assert.ok(/emailSource = 'manual'/.test(HUB) && /LeadEmailKind\.classify/.test(HUB),
        'the Edit form must still stamp where a typed address came from');
    const send = read('netlify/functions/lead-generation.ts');
    assert.ok(/needsPersonalInboxConfirmation\(emailKind, emailSource\)/.test(send),
        'the send seam must still read the provenance — that is the gate the card never was');
});

console.log('\n──── no Tailwind rebuild ────');

check('every class the new controls use is already compiled into style.css', () => {
    // A rebuild churns unrelated selectors across the whole app.
    const escapeSel = (t: string) => t.replace(/([:[\].\/])/g, '\\$1');
    const region = HUB.slice(landmark(HUB, 'function controlsHtml'), landmark(HUB, 'function renderTable'))
        + CARD.slice(landmark(CARD, 'const NEXT_STEP_OWNER'), landmark(CARD, 'function renderLeadScoringCard'));
    const tokens = new Set<string>();
    for (const m of region.matchAll(/class="([^"]*)"/g)) {
        for (const raw of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (raw) tokens.add(raw);
    }
    // The conditional palettes live in string literals rather than a class attribute.
    for (const m of region.matchAll(/cls: '([^']+)'/g)) for (const raw of m[1].split(/\s+/)) tokens.add(raw);
    assert.ok(tokens.size > 20, `expected a real class list, parsed ${tokens.size}`);
    const missing = [...tokens].filter((t) => !CSS.includes('.' + escapeSel(t)));
    assert.deepStrictEqual(missing, [], `not compiled into style.css: ${missing.join(', ')}`);
});

console.log(`\n${passed} checks passed.`);
