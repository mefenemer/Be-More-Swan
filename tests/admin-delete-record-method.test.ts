// tests/admin-delete-record-method.test.ts
// Admin "Delete" sheet → the function that actually deletes.
//
// 2026-10-20: every delete from the cascade sheet failed with "Delete failed: Method Not Allowed".
// The page sent POST and admin-delete-record accepts only DELETE. Fixing the verb alone would have
// exposed a second bug for users: the soft path runs `UPDATE users SET is_active = false` on a table
// with no is_active column, and would orphan a workspace only that user belonged to. Users now go to
// admin-api DELETE ?resource=user (deleteUserAndSoleOrgs), and admin-delete-record refuses them.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const UI = read('admin.html');
const FN = read('netlify/functions/admin-delete-record.ts');
const API = read('netlify/functions/admin-api.ts');

console.log('\nadmin-delete-record-method');

const confirm = UI.slice(landmark(UI, 'async function confirmCascadeDelete()'), landmark(UI, "window.showToast?.('Delete failed: '"));

check('the server accepts only DELETE', () => {
    assert.match(FN, /if \(event\.httpMethod !== 'DELETE'\)/);
});

check('the sheet sends DELETE to admin-delete-record, never POST', () => {
    const call = confirm.slice(landmark(confirm, "api('/.netlify/functions/admin-delete-record'"));
    assert.match(call.slice(0, 200), /method: 'DELETE'/);
    assert.ok(!/method: 'POST'/.test(confirm), 'a POST from this sheet is a 405');
});

check('a user is deleted through admin-api, which removes their sole workspaces', () => {
    const userBranch = confirm.slice(landmark(confirm, "if (_cascadeTable === 'users')"), landmark(confirm, '} else {'));
    assert.match(userBranch, /admin-api\?resource=user&id=/);
    assert.match(userBranch, /method: 'DELETE'/);
    const del = API.slice(landmark(API, "event.httpMethod === 'DELETE' && resource === 'user'"));
    assert.match(del.slice(0, 1500), /deleteUserAndSoleOrgs\(db, uid\)/);
});

check('admin-delete-record refuses users before it reaches the soft-delete UPDATE', () => {
    assert.ok(landmark(FN, "if (table === 'users')") < landmark(FN, 'UPDATE ${tableId} SET is_active = false'));
});

console.log(`\n${passed} checks passed.`);
