// tests/feature-request-delete.test.ts — FR#24 (owner 2026-11-14): a feature request can be deleted from the
// Board, not only from the List. The Board opens the edit panel, so the panel has the Delete button.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'admin.html'), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const fnBody = (sig: string) => { const i = html.indexOf(sig); assert.ok(i > 0, sig); return html.slice(i, html.indexOf('\n}', i)); };
console.log('feature-request-delete');

check('the edit panel has a Delete button wired to the same delete as the List', () => {
    const form = html.slice(html.indexOf('<div id="fr-form"'), html.indexOf('<!-- Board pane'));
    assert.ok(/id="fr-form-delete"[^>]*onclick="deleteRoadmapFromForm\(\)"/.test(form), 'Delete button in fr-form');
    const del = fnBody('async function deleteRoadmapFromForm()');
    assert.ok(del.includes('deleteRoadmapItem(id)') && del.includes('closeRoadmapForm()'), 'confirms, deletes, closes');
});

check('Delete shows when editing a request, never on + Add request', () => {
    assert.ok(fnBody('function openRoadmapEdit(id)').includes("getElementById('fr-form-delete').classList.remove('hidden')"));
    const i = html.indexOf("document.getElementById('fr-form-status-wrap').classList.add('hidden');");
    assert.ok(html.slice(i, i + 200).includes("getElementById('fr-form-delete').classList.add('hidden')"));
});

check('the delete still asks first and reports whether it happened', () => {
    const d = fnBody('async function deleteRoadmapItem(id)');
    assert.ok(d.includes('confirmModal(') && d.includes('return false') && d.includes('return true'));
});

console.log(`\n${passed} passed`);
