// tests/help-seed-retired.test.ts
// The old help-article seed must never run again (owner, 2026-10-22).
//
// WHY THIS EXISTS. db/seed-help-articles.sql upserted every article by title. It was DRIFTED, and the
// migrate runner re-runs drifted files in alphabetical order — it sorted after the dated
// db/help-articles-2026-10*.sql rewrites, so the next pass would have put its older bodies back over
// them. An admin "Apply Seed" button ran it too. It is now db/_retired-seed-help-articles.sql (the
// runner skips "_" files) and the admin action refuses.
//
// Run:  npx tsx tests/help-seed-retired.test.ts

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

check('the seed is not a managed migration any more', () => {
    assert.ok(!existsSync(path.join(ROOT, 'db/seed-help-articles.sql')),
        'db/seed-help-articles.sql is back — the migrate runner would re-run it over newer help copy');
    assert.ok(existsSync(path.join(ROOT, 'db/_retired-seed-help-articles.sql')));
    assert.match(read('scripts/db-migrate.mjs'), /!f\.startsWith\('_'\)/, 'the runner no longer skips "_" files');
});

check('the admin seed action refuses, and its buttons are gone', () => {
    const api = read('netlify/functions/admin-api.ts');
    const at = api.indexOf("if (resource === 'help-articles-seed')");
    assert.ok(at > 0);
    assert.match(api.slice(at, at + 400), /statusCode: 410/);
    assert.ok(!api.includes("'db', 'seed-help-articles.sql'"), 'admin-api still reads the old seed file');
    assert.ok(!/mdApplyHelpSeed|mdPreviewHelpSeed/.test(read('admin.html')));
});

console.log(`\n${passed} checks passed.`);
