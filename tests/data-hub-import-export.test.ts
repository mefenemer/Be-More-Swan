// tests/data-hub-import-export.test.ts
// The Leads tab's two CSV doors: Import CSV and Export.
//
// Both used to be explained by permanent grey paragraphs under the toolbar — instructions shown to
// every user on every visit about buttons pressed rarely, with the CRM one carrying its own inline
// controls. The instructions now live inside the modal for the button they describe. What this file
// defends is that they still EXIST: copy that moves is copy that can be dropped, and the two
// sentences here each prevent a specific failure (a CSV shaped wrongly; a Salesforce import that
// silently rejects every company row).
//
// Source-scan only — this is vanilla DOM in an IIFE, with no import graph to load it through.
// Run:  npx tsx tests/data-hub-import-export.test.ts

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
const REGISTRY = read('src/components/assistant-dashboard-registry.js');

/** A named function's body, from its declaration to the first close at one indent level. */
function fn(name: string): string {
    const start = landmark(HUB, `function ${name}(`);
    return HUB.slice(start, landmark(HUB, '\n  }', start));
}

console.log('\n──── the CSV instructions travel with the import button ────');

check('the import modal carries the hint and the suggested columns', () => {
    const body = fn('openImportModal');
    assert.ok(/hub\.importHint/.test(body),
        'the modal must state what shape of file to upload. That sentence is role-specific (leads, '
        + 'invoices, tickets) and comes from the registry — hardcoding lead copy here breaks the '
        + 'other three hubs that share this component.');
    assert.ok(/hub\.importColumns/.test(body),
        'the suggested column list must be in the modal — it is the difference between an import '
        + 'that maps itself and one that lands every field in "notes"');
});

check('the registry still supplies a hint and columns for every hub that imports', () => {
    // The modal renders whatever the registry gives it, so an empty hint would render an empty
    // paragraph rather than fail — the coupling has to be checked here.
    assert.ok(/importHint: 'Upload a CSV of inbound leads/.test(REGISTRY),
        'the lead hub lost its import hint');
    assert.ok(/File → Download → CSV/.test(REGISTRY),
        'the Excel/Sheets export instruction is the one thing users actually get stuck on');
});

check('nothing explains the CSV on the page any more', () => {
    // The point of the move: the toolbar states what is happening (the status line), not how to
    // use a button nobody has pressed. If the paragraph comes back, the modal is redundant.
    const toolbar = fn('renderToolbar');
    assert.ok(!/importHint/.test(toolbar),
        'the import hint is back under the toolbar — it belongs in the modal it explains');
    assert.ok(!/Already using a CRM/.test(toolbar),
        'the CRM paragraph is back under the toolbar — it belongs in the export modal');
});

console.log('\n──── the picker opens after the instructions, not before ────');

check('Import CSV opens the modal, and the file dialog waits for a click inside it', () => {
    const wiring = HUB.slice(landmark(HUB, "importBtn.addEventListener('click'"));
    assert.ok(/openImportModal\(/.test(wiring.slice(0, 200)),
        'the toolbar button must open the modal. It used to call fileInput.click() directly, which '
        + 'threw up an OS file dialog before the user had been told what the file should contain.');
    const body = fn('openImportModal');
    assert.ok(/data-import-choose/.test(body) && /fileInput\.click\(\)/.test(body),
        'the modal needs its own button to open the picker');
});

check('the file input is re-armed by assignment, never by another listener', () => {
    // ⚠️ The input lives in the toolbar and outlives every modal. addEventListener here would stack
    // one handler per modal ever opened, and a single file choice would import N times.
    const body = fn('openImportModal');
    assert.ok(/fileInput\.onchange = /.test(body),
        'assign onchange — a stacked listener re-imports the same file once per modal opened');
    assert.ok(!/fileInput\.addEventListener/.test(body),
        'addEventListener on the shared input is the duplicate-import bug');
});

console.log('\n──── the CRM offer became a connection, not just a download ────');

check('the export modal offers a live push beside the files', () => {
    const body = fn('openExportModal');
    assert.ok(/data-export-plain/.test(body), 'the generic CSV must still be one click');
    assert.ok(/data-recipes/.test(body), 'the modal must offer the CRM connection, not only files');
    assert.ok(/every lead you approve is pushed/.test(body),
        'say what connecting actually does — "integration available" is not an outcome');
});

check('the recipes come from the scenario library, not from a hardcoded list', () => {
    const body = fn('loadCrmRecipes');
    assert.ok(/scenarioType === 'handoff_push'/.test(body),
        'filter to the recipes that send a lead OUT; a hardcoded provider list goes stale the day a '
        + 'connector is added');
    assert.ok(/s\.active \|\|/.test(body),
        'a recipe the user has already switched on must be listed even if it would otherwise be '
        + 'filtered out — otherwise the thing doing the pushing is invisible here');
});

check('activation is deferred to the surface that owns it', () => {
    // Turning a recipe on takes a field mapping, and that form exists on the Connections tab. A
    // second copy here would be two config surfaces writing one active_scenarios row.
    const body = fn('openExportModal');
    assert.ok(/_openBriefDrawer\?\.\('platforms'\)/.test(body),
        '"Set it up" must open the Connections drawer rather than reimplement its configure form');
    const row = fn('recipeRow');
    assert.ok(/data-recipe-toggle/.test(row) && /Connect \$\{esc\(s\.providerName\)\}/.test(row),
        'the three states — connect, set up, on/off — must each get their own control');
});

check('toggling here re-reads the tab that shows the same recipes', () => {
    const body = fn('openExportModal');
    assert.ok(/AssistantIntegrations\?\.refresh\?\.\(\)/.test(body),
        'the Connections tab renders these same rows; without a refresh the two disagree about '
        + 'whether the push is on');
});

console.log(`\n${passed} checks passed.`);
