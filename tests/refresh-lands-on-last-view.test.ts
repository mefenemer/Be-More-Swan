// tests/refresh-lands-on-last-view.test.ts
// A refresh must reopen the page you were on — or the Dashboard when nothing is remembered — in both
// the admin portal and the workspace (user report 2026-10-06: the admin portal always reopened on
// Bias Audit). The admin cause: the quarterly bias email links with ?section=bias-audit, adminNav
// only ever rewrote ?view=, and the boot read section BEFORE view — so the stale alias won forever.
//
// Run:  npx tsx tests/refresh-lands-on-last-view.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const admin = read('admin.html');
const ws = read('workspace.html');

check('admin: ?view= beats a stale ?section=, then the remembered page, then the Dashboard', () => {
    assert.match(admin, /const initialView = params\.get\('view'\) \|\| params\.get\('section'\) \|\| remembered \|\| 'dashboard';/);
});

check('admin: every navigation drops ?section= and remembers the page', () => {
    const nav = admin.slice(admin.indexOf('function adminNav(view) {'), admin.indexOf('// Lazy-load section data'));
    assert.match(nav, /newUrl\.searchParams\.delete\('section'\);/);
    assert.match(nav, /localStorage\.setItem\(ADMIN_LAST_VIEW_KEY, view\)/);
});

check('workspace: every successful view load is remembered', () => {
    assert.match(ws, /window\._currentViewKey = routeKey;[\s\S]{0,200}_rememberView\(routeKey, param\);/);
});

check('workspace: boot reopens it unless the load is a deep link or the Stripe return', () => {
    assert.doesNotMatch(ws, /\/\/ Fire the initial landing layout\n\s*await loadView\('dashboard'\);/);
    assert.match(ws, /const restore = !bootQs\.has\('view'\) && !bootQs\.has\('payment'\) \? _rememberedView\(\) : null;/);
    assert.match(ws, /if \(!v \|\| !routes\[v\.key\] \|\| v\.key === 'assistant-setup'\) return null;/);
});

console.log(`\n${passed} checks passed`);
