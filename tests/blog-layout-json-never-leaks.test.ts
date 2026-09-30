// tests/blog-layout-json-never-leaks.test.ts
// A blog post's body must never be the raw layout JSON.
//
// Reported 2026-09-30 on PROD (Restorative Futures, "Restorative Practice with Gang-Involved Young
// People: Safety and Belonging"): the post read `{"kind": "prose", "markdown": "…"}` top to bottom.
// The Blog Writer returns a JSON layout; when that reply failed to parse whole, blog-generate took
// it for plain Markdown and saved it verbatim. The usual trigger is a REAL line break inside a
// prose string — legal in Markdown, forbidden in JSON — or a reply cut off at max_tokens.
//
// Run:  npx tsx tests/blog-layout-json-never-leaks.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModelJson, salvageArrayElements, escapeControlCharsInStrings } from '../src/utils/model-json';
import { normaliseLayoutIr, irToBlogMarkdown } from '../src/utils/layout-ir';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const para = 'Once stabilisation has happened and relational trust is rebuilding, you can begin to gently widen the circle. '.repeat(3);
// A real line break INSIDE the prose string — the failure seen on prod.
const withRawNewline = `{"layout":[
  {"kind":"heading","text":"Restorative Practice with Gang-Involved Young People","level":1},
  {"kind":"prose","markdown":"${para}\n\nA second paragraph after a real line break."},
  {"kind":"heading","text":"Rebuilding Safety","level":2},
  {"kind":"prose","markdown":"${para}"}
]}`;
// Cut off part-way through the last node, as a max_tokens stop leaves it.
const truncated = `{"layout":[
  {"kind":"heading","text":"De-escalation Language","level":2},
  {"kind":"prose","markdown":"${para}"},
  {"kind":"heading","text":"Rebuilding Safety: Conversations Post-Crisis","level":2},
  {"kind":"prose","markdown":"${para}"},
  {"kind":"prose","markdown":"The language you use in the immediate aftermath of disclosure or crisis shapes whether the`;

check('the prod failure is real: strict JSON.parse rejects a raw line break in a string', () => {
    assert.throws(() => JSON.parse(withRawNewline));
});

check('parseModelJson now recovers it, and the post compiles to readable Markdown', () => {
    const parsed = parseModelJson<{ layout?: unknown }>(withRawNewline);
    assert.ok(parsed, 'should parse after escaping control characters inside strings');
    const md = irToBlogMarkdown(normaliseLayoutIr(parsed!.layout)!);
    assert.match(md, /^# Restorative Practice/m);
    assert.match(md, /A second paragraph after a real line break\./);
    assert.doesNotMatch(md, /"kind"|"markdown"|\{/);
});

check('escaping touches only whitespace INSIDE strings, never structure or existing escapes', () => {
    assert.strictEqual(escapeControlCharsInStrings('{\n  "a": "x\ny",\n  "b": "p\\nq"\n}'), '{\n  "a": "x\\ny",\n  "b": "p\\nq"\n}');
});

check('a truncated reply keeps every section that closed and drops the unfinished one', () => {
    assert.strictEqual(parseModelJson(truncated), null, 'cannot parse whole — this is the salvage case');
    const nodes = salvageArrayElements(truncated, 'layout');
    assert.strictEqual(nodes?.length, 4);
    const md = irToBlogMarkdown(normaliseLayoutIr(nodes)!);
    assert.match(md, /## Rebuilding Safety: Conversations Post-Crisis/);
    assert.doesNotMatch(md, /shapes whether the/, 'the half-written node must not appear');
    assert.doesNotMatch(md, /"kind"/);
});

check('nothing salvageable → null, so the caller fails the run instead of saving JSON', () => {
    assert.strictEqual(salvageArrayElements('{"layout":[{"kind":"prose","markdown":"cut', 'layout'), null);
    assert.strictEqual(salvageArrayElements('Just a Markdown post.\n\n## A heading', 'layout'), null);
});

check('blog-generate salvages layout JSON and never falls through to the Markdown branch with it', () => {
    const src = readFileSync(join(root, 'src/utils/blog-generate.ts'), 'utf8');
    const guard = src.slice(src.indexOf('const looksLikeLayoutJson'), src.indexOf('let bodyMarkdown'));
    assert.match(guard, /if \(!layout && !parsed && looksLikeLayoutJson\)/);
    assert.match(guard, /salvageArrayElements\(raw, 'layout'\)/);
    assert.match(guard, /if \(!layout\) throw new Error/);
    assert.ok(src.indexOf('const looksLikeLayoutJson') < src.indexOf('} else {\n        // Plain Markdown'),
        'the guard must run before the plain-Markdown branch');
});

check('genuine plain Markdown is still taken as-is (the escape hatch the prompt offers)', () => {
    const src = readFileSync(join(root, 'src/utils/blog-generate.ts'), 'utf8');
    const re = new RegExp(src.match(/const looksLikeLayoutJson = (.+);/)![1].split(' || ')[0].replace(/^\//, '').replace(/\/i\.test\(raw\)$/, ''), 'i');
    assert.ok(!re.test('# My post\n\nSome prose.'), 'a Markdown reply must not be mistaken for JSON');
});

console.log(`\n${passed} checks passed`);
