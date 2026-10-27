// tests/quality-reviewer-copy.test.ts
// The `quality_reviewer` plan feature is called The Quality Reviewer everywhere we sell it (owner, 2026-10-27).
//
// WHY THIS EXISTS. Marketing called it "the In-House Editor" and "an editor that checks the work", so the
// owner read the homepage and concluded we sold a feature we don't have. And it checks SOCIAL posts only
// (process-content-jobs.ts is its one automatic caller), so no surface may say it checks "every draft".
//
// Run:  npx tsx tests/quality-reviewer-copy.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const SURFACES = ['index.html', 'pricing.html', 'checkout.html', 'netlify/functions/churn-detection.ts', 'db/seed.ts'];

console.log('quality-reviewer-copy');

check('no selling surface calls it an editor', () => {
    for (const f of SURFACES) {
        assert.doesNotMatch(read(f), /in-house editor|an editor that checks|<strong>An editor<\/strong>/i, f);
    }
});

check('each one names The Quality Reviewer, and none claims it checks every draft', () => {
    for (const f of SURFACES) {
        const src = read(f);
        assert.ok(src.includes('The Quality Reviewer'), f);
        assert.doesNotMatch(src, /Quality Reviewer[^.<'"]{0,40}every draft/i, f);
    }
});

check('the live rows are renamed by a dated SQL file', () => {
    const sql = read('db/z-quality-reviewer-copy-2026-10-27.sql');
    assert.match(sql, /UPDATE master_plans[\s\S]*tier_key = 'buster'/);
    assert.match(sql, /UPDATE org_products[\s\S]*bemoreswan\.com/);
});

console.log(`\n${passed} checks passed.`);
