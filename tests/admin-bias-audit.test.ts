// tests/admin-bias-audit.test.ts
// The quarterly bias reminder links to admin.html?section=bias-audit — and admin.html had no Bias
// Audit section at all, so the link landed on the dashboard (reported 2026-10-03).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const A = read('admin.html');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('the section exists, is in the nav, and loads its data', () => {
    assert.match(A, /<section id="view-bias-audit" class="admin-view hidden/);
    assert.match(A, /\{ view: 'bias-audit',\s+icon: '⚖️', label: 'Bias Audit'/);
    assert.match(A, /'bias-audit': 'Bias Audit'/);
    assert.match(A, /if \(view === 'bias-audit'\)\s+loadBiasAudit\(\);/);
});

check('it reads and writes through the existing bias-audit API', () => {
    for (const r of ['reviews', 'incidents', 'reports']) assert.match(A, new RegExp(`get\\('${r}'\\)`));
    assert.match(A, /\$\{BA_API\}\?resource=review`/);
    assert.match(A, /\$\{BA_API\}\?resource=resolve`/);
    assert.match(A, /resource=report-csv&reportId=/);
});

check('?section= lands on the view, so links already sent still work', () => {
    // The email link carries ONLY ?section=, so it still lands here. ?view= is read first because a
    // stale ?section= used to outlive every navigation and reopen Bias Audit on each refresh
    // (2026-10-06) — see tests/refresh-lands-on-last-view.test.ts.
    assert.match(A, /const initialView = params\.get\('view'\) \|\| params\.get\('section'\) \|\| remembered \|\| 'dashboard';/);
});

check('the reminder email now links with ?view=', () => {
    const r = read('netlify/functions/quarterly-bias-reminder.ts');
    assert.match(r, /admin\.html\?view=bias-audit/);
    assert.doesNotMatch(r, /section=bias-audit/);
});

console.log(`\n${passed} checks passed`);
