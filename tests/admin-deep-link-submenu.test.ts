// tests/admin-deep-link-submenu.test.ts
// A direct link — admin.html?view=send-notification, ?view=product-updates, every reminder email —
// opened the category's sub-menu (title "COMMS") over an EMPTY list. Clicking the rail icon twice
// filled it. bootAdmin() runs synchronously at the end of the script and calls adminGoTo() →
// adminCatNav(), while the permissions are still being fetched in a DOMContentLoaded handler; until
// they arrive _can() denies everything, so _visibleChildren() returned [] and nothing repainted the
// list afterwards (reported 2026-10-03).
//
// The rule these checks lock: once permissions load, the open category's sub-menu is re-rendered —
// through a render helper, NOT adminCatNav(), whose repeat call is a toggle that would close it.
// Run:  npx tsx tests/admin-deep-link-submenu.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = readFileSync(join(root, 'admin.html'), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const permBoot = A.slice(
    landmark(A, 'await _loadAdminPermissions();'),
    landmark(A, 'let _activeCategory = null;'),
);
const catNav = A.slice(landmark(A, 'function adminCatNav('), landmark(A, 'function _renderSecondaryItems('));
const render = A.slice(landmark(A, 'function _renderSecondaryItems('), landmark(A, 'function adminCatClose('));

check('the sub-menu list is rendered by one helper, filtered by permission', () => {
    assert.match(render, /getElementById\('admin-secondary-items'\)/);
    assert.match(render, /_visibleChildren\(cat\)/);
    assert.match(render, /itemsEl\.innerHTML = kids\.map/);
});

check('the current view is highlighted when the list is rendered', () => {
    assert.match(render, /_activeView === c\.view \? ' active' : ''/);
});

check('adminCatNav renders through the helper and keeps its toggle', () => {
    assert.match(catNav, /_renderSecondaryItems\(cat\);/);
    assert.doesNotMatch(catNav, /itemsEl\.innerHTML\s*=/, 'adminCatNav must not keep its own copy of the list render');
    assert.match(catNav, /if \(_activeCategory === cat && secondary\.classList\.contains\('open'\)\) \{\s*adminCatClose\(\);/);
});

check('once permissions load, the open category is re-rendered — not re-toggled', () => {
    const reRender = landmark(permBoot, '_renderSecondaryItems(_activeCategory)');
    assert.ok(landmark(permBoot, 'await _loadAdminPermissions();') < reRender, 're-render must come after permissions resolve');
    assert.match(permBoot, /if \(_activeCategory && _activeCategory !== 'dashboard'\) _renderSecondaryItems\(_activeCategory\);/);
    assert.doesNotMatch(permBoot, /adminCatNav\(\w/, 'calling adminCatNav() again would read as a toggle and close the panel');
});

check('boot still navigates the deep link before permissions arrive', () => {
    const boot = A.slice(landmark(A, '(function bootAdmin()'));
    assert.match(boot, /adminGoTo\(initialView\)/);
});

console.log(`\n${passed} checks passed`);
