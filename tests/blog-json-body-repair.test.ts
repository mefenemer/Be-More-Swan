// tests/blog-json-body-repair.test.ts
// scripts/repair-json-blog-bodies.ts converts blog posts saved as raw layout JSON (before d1fd5db4)
// into readable Markdown. Pins the pure conversion (src/utils/blog-json-body-repair.ts) and the
// script's safety rails: dry run by default, conditional write, snapshot rebuilt for live posts.
//
// Run:  npx tsx tests/blog-json-body-repair.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairJsonBody, looksLikeLayoutJson } from '../src/utils/blog-json-body-repair';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(join(root, 'scripts/repair-json-blog-bodies.ts'), 'utf8');

const para = 'Restorative circles and conferences are powerful tools for accountability and healing — but only when safety comes first. ';
// Shaped like the saved Restorative Futures body: a real line break inside a string, an image node,
// and an invented link.
const saved = `{
  "layout": [
    { "kind": "heading", "text": "Restorative Practice with Gang-Involved Young People: Safety and Belonging", "level": 1 },
    { "kind": "prose", "markdown": "${para.repeat(2)}\n\nSee [our guide](https://example.invalid/guide) for more." },
    { "kind": "image", "alt": "A circle of chairs in a quiet room", "caption": "", "query": "restorative circle chairs" },
    { "kind": "heading", "text": "De-escalation Language & Trauma-Informed Crisis Response", "level": 2 },
    { "kind": "prose", "markdown": "${para}" }
  ]
}`;

check('the saved JSON body converts to readable Markdown with its headings and wording', () => {
    const r = repairJsonBody(saved)!;
    assert.ok(r, 'should convert');
    assert.match(r.markdown, /^# Restorative Practice with Gang-Involved Young People/m);
    assert.match(r.markdown, /^## De-escalation Language & Trauma-Informed Crisis Response/m);
    assert.match(r.markdown, /Restorative circles and conferences are powerful tools/);
    assert.doesNotMatch(r.markdown, /"kind"|"markdown"|^\s*\{/m);
    assert.strictEqual(r.salvaged, false);
});

check('pictures it never sourced are dropped and counted, not faked', () => {
    const r = repairJsonBody(saved)!;
    assert.strictEqual(r.droppedImages, 1);
    assert.doesNotMatch(r.markdown, /:::media|circle of chairs/);
});

check('an unverifiable link keeps its words and loses its address', () => {
    const r = repairJsonBody(saved)!;
    assert.match(r.markdown, /our guide/);
    assert.doesNotMatch(r.markdown, /example\.invalid/);
    assert.ok(r.unlinkedLinks >= 1);
});

check('a body cut off mid-section keeps the complete sections and says so', () => {
    const cut = saved.slice(0, saved.indexOf('"kind": "prose", "markdown": "Restorative circles and conferences are powerful tools for accountability and healing — but only when safety comes first. "'));
    const r = repairJsonBody(cut)!;
    assert.ok(r, 'the complete sections should survive');
    assert.strictEqual(r.salvaged, true);
    assert.match(r.markdown, /^## De-escalation/m);
});

check('an ordinary Markdown post is never touched', () => {
    const md = '# A normal post\n\nWritten in plain Markdown, with a {curly} word.';
    assert.strictEqual(looksLikeLayoutJson(md), false);
    assert.strictEqual(repairJsonBody(md), null);
});

check('the script is a dry run unless --apply, and never names a fallback database', () => {
    assert.match(script, /const apply = args\.includes\('--apply'\)/);
    assert.match(script, /if \(apply\) \{/);
    assert.doesNotMatch(script, /process\.env\.DATABASE_URL\b/, 'no implicit fallback to prod (see seed-scripts-no-prod-fallback)');
});

check('the write is conditional on the body being unchanged since it was read', () => {
    assert.match(script, /\.where\(and\(eq\(blogPosts\.id, post\.id\), eq\(blogPosts\.bodyMarkdown, post\.body\)\)\)/);
});

check('a published post gets its served snapshot rebuilt, and originals are backed up first', () => {
    assert.match(script, /html: await renderMarkdown\(result\.markdown\)/);
    assert.match(script, /publishedPayload: payload/);
    assert.ok(script.indexOf('backup.push(') < script.indexOf('await db.update(blogPosts)'), 'back up before writing');
    assert.match(script, /\.tmp-blog-json-repair-backup-/, 'backup name must match the .tmp-* gitignore rule');
});

console.log(`\n${passed} checks passed`);
