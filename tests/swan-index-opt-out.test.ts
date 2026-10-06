// tests/swan-index-opt-out.test.ts
// The Swan Index became Be More Swan-managed (2026-10-06): every workspace syndicates by default,
// the workspace has no control for it, and opting out is by email — recorded by an editor on
// Admin ▸ The Swan Index ▸ Opt-outs. What must hold:
//   · no customer surface lists it (Connections, Blog Studio's per-post list)
//   · the server refuses a customer connect / disconnect / mode change
//   · a stale per-post selection cannot silently exclude it
//   · the admin opt-out withdraws exactly as an author's Disconnect did, and needs a reason
//   · the Terms say so
//
// Run:  npx tsx tests/swan-index-opt-out.test.ts

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

check('no customer surface lists The Swan Index', () => {
    assert.match(read('integrations.js'), /_blogDestinations = all\.filter\(d => !d\.firstParty\);/);
    assert.match(read('src/components/blog-studio-modal.js'), /return d\.connected && !d\.firstParty;/);
});

check('the server refuses a customer connect / disconnect / mode change', () => {
    const fn = read('netlify/functions/connect-blog-destination.ts');
    assert.match(fn, /adapter\.authKind === 'firstparty' && \['disconnect', 'connect', 'setmode'\]\.includes\(String\(body\.action\)\)\) \{\s*return json\(403/);
    assert.ok(fn.indexOf("['disconnect', 'connect', 'setmode']") < fn.indexOf("if (body.action === 'disconnect')"), 'the refusal must come first');
});

check('a per-post selection cannot exclude it', () => {
    assert.match(read('src/utils/blog-destinations/syndicate.ts'), /\.filter\(\(d\) => d\.firstParty \|\| selected === null \|\| selected\.includes\(d\.id\)\)/);
});

check('the admin opt-out withdraws like Disconnect did, provisions first, and needs a reason', () => {
    const fn = read('netlify/functions/admin-swan-index.ts');
    const block = fn.slice(fn.indexOf("resource === 'optout'"), fn.indexOf("resource === 'contributors'"));
    assert.match(block, /if \(optOut && !reason\) return json\(400/);
    assert.match(block, /await ensureProfile\(db, orgId\);\s*await deleteBlogDestination\(db, orgId, 'swanindex'\);/);
    assert.match(block, /action: 'swan_index_profile_change'/);
    const admin = read('admin.html');
    assert.match(admin, /view: 'swan-optouts'/);
    assert.match(admin, /if \(view === 'swan-optouts'\)\s+loadSwanOptouts\(\);/);
});

check('the Terms describe the default and the email opt-out', () => {
    const t = read('terms_of_service.html');
    assert.match(t, /id="swan-index"><strong>11\.9 — The Swan Index\.<\/strong>/);
    assert.match(t, /To opt out, email <a href="mailto:support@bemoreswan\.com">/);
});

console.log(`\n${passed} checks passed`);
