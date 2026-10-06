// tests/admin-music-bulk-delete.test.ts
// Admin → Music Library can delete tracks in bulk (2026-10-06). The library promised that removing
// a track never silences a post that already uses it. Delete keeps that promise only if:
//   · the AUDIO FILE is kept whenever any content_assets row still carries its storage key
//   · the row goes before the file (a crash then leaves an unlisted file, not a silent listed track)
//   · it needs a reason and is audit-logged, like a withdrawal
//
// Source scans. Run:  npx tsx tests/admin-music-bulk-delete.test.ts

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
const fn = readFileSync(join(root, 'netlify/functions/admin-music-library.ts'), 'utf8');
const admin = readFileSync(join(root, 'admin.html'), 'utf8');
const del = fn.slice(fn.indexOf('async function deleteTracks('));

check('delete is dispatched before the single-id lookup (it takes ids, not id)', () => {
    assert.ok(fn.indexOf("if (body.action === 'delete') return deleteTracks(") < fn.indexOf('const id = Number(body.id);'));
});

check('a file still carried by any content_assets row is never deleted', () => {
    assert.match(del, /selectDistinct\(\{ key: contentAssets\.storageKey \}\)[\s\S]*?inArray\(contentAssets\.storageKey, keys\)/);
    assert.match(del, /const keep = inUse\.has\(r\.storageKey\);\s*const removed = keep \? false : await deleteR2Object\(r\.storageKey\);/);
});

check('rows are deleted before any file', () => {
    assert.ok(del.indexOf('db.delete(musicTracks)') >= 0);
    assert.ok(del.indexOf('db.delete(musicTracks)') < del.indexOf('deleteR2Object(r.storageKey)'));
});

check('a reason is required, the batch is bounded, and every track is audit-logged', () => {
    assert.match(del, /if \(!reason\) return json\(400/);
    assert.match(del, /ids\.length > DELETE_MAX/);
    assert.match(del, /action: 'music_library_delete'/);
    assert.match(readFileSync(join(root, 'src/utils/admin-audit.ts'), 'utf8'), /\| 'music_library_delete'/);
});

check('the admin list has per-row ticks, select-all and a bulk Delete', () => {
    assert.match(admin, /onchange="mlToggleSelect\(\$\{t\.id\}, this\.checked\)"/);
    assert.match(admin, /id="ml-select-all" onchange="mlSelectAll\(this\.checked\)"/);
    assert.match(admin, /id="ml-delete-selected" onclick="mlDeleteSelected\(\)"/);
    assert.match(admin, /JSON\.stringify\(\{ action: 'delete', ids, reason \}\)/);
    // A filter change must not leave hidden tracks ticked.
    assert.match(admin, /_ml\.selected = new Set\(\[\.\.\._ml\.selected\]\.filter\(\(id\) => shownIds\.has\(id\)\)\);/);
});

console.log(`\n${passed} checks passed`);
