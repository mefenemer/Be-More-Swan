// tests/swan-index-backfill.test.ts
// scripts/submit-missing-swan-index.ts submits published posts that never reached The Swan Index
// (sent only at publish time, and profiles only became default-on on 2026-09-29). Used on PROD
// 2026-09-30: 10 posts across Be More Swan, love cat studio and Kudzu.
//
// Pins: it sends to The Swan Index ONLY (never re-pushes LinkedIn etc.), respects the author's
// per-post exclusion and a withdrawn profile, skips anything already on the desk, and is a dry run
// unless --apply.
//
// Run:  npx tsx tests/swan-index-backfill.test.ts

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
const script = readFileSync(join(root, 'scripts/submit-missing-swan-index.ts'), 'utf8');
const syndicate = readFileSync(join(root, 'src/utils/blog-destinations/syndicate.ts'), 'utf8');

check('syndicatePublishedPost can be restricted to named destinations', () => {
    assert.match(syndicate, /opts: \{ only\?: string\[\] \} = \{\}/);
    assert.match(syndicate, /\.filter\(\(d\) => !opts\.only \|\| opts\.only\.includes\(d\.id\)\)/);
    assert.ok(syndicate.indexOf('selected.includes(d.id)') < syndicate.indexOf('opts.only.includes(d.id)'),
        "the author's per-post choice still applies first");
});

check('the backfill sends to The Swan Index only', () => {
    assert.match(script, /syndicatePublishedPost\(db, r\.organisation_id, post, \{ only: \['swanindex'\] \}\)/);
});

check('it never resubmits, and respects the author and a withdrawn profile', () => {
    assert.match(script, /NOT EXISTS \(SELECT 1 FROM swan_index_posts sp WHERE sp\.blog_post_id = bp\.id\)/,
        'a withdrawn or rejected piece has a row — an editorial decision, left alone');
    assert.match(script, /NOT \(bp\.destinations->'selected'\) \? 'swanindex'/);
    assert.match(script, /r\.profile_status === 'active' && !r\.excluded/);
    assert.match(script, /bp\.status = 'published'/);
});

check('dry run unless --apply, and no fallback database', () => {
    assert.match(script, /const apply = args\.includes\('--apply'\)/);
    assert.ok(script.indexOf('if (!apply)') < script.indexOf('syndicatePublishedPost(db'), 'nothing is sent before the apply check');
    assert.doesNotMatch(script, /process\.env\.DATABASE_URL\b/);
});

console.log(`\n${passed} checks passed`);
