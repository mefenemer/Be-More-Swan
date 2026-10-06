// tests/content-pillars.test.ts
// One pillar splitter for the profile chips and the post writer (2026-10-06). Be More Swan's five
// pillars separated by "·" were treated as ONE pillar by drafting; a customer's four pillars
// separated by spaces likewise — so a pillar could never get its turn.
//
// Run:  npx tsx tests/content-pillars.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePillars, pillarWarnings } from '../src/public/content-pillars.js';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

check('the list characters people paste all split', () => {
    assert.deepStrictEqual(parsePillars("Hire don't learn · Founder stories · Calm over chaos"), ["Hire don't learn", 'Founder stories', 'Calm over chaos']);
    assert.deepStrictEqual(parsePillars('A • B | C; D\nE'), ['A', 'B', 'C', 'D', 'E']);
    assert.deepStrictEqual(parsePillars(['Fitness', 'Mindset', 'Food']), ['Fitness', 'Mindset', 'Food']);
    assert.deepStrictEqual(parsePillars('Food, food, FOOD'), ['Food']);
    // A hyphen inside a pillar is part of it.
    assert.deepStrictEqual(parsePillars('Restorative practice - conferencing, Training'), ['Restorative practice - conferencing', 'Training']);
});

check('at most five; warnings name the problem', () => {
    assert.strictEqual(parsePillars('a,b,c,d,e,f').length, 5);
    assert.match(pillarWarnings('a,b,c,d,e,f').join(' '), /Only the first 5 pillars are used — you have 6/);
    assert.match(pillarWarnings('x'.repeat(80)).join(' '), /reads as one long pillar/);
    assert.deepStrictEqual(pillarWarnings('Fitness, Mindset, Food'), []);
});

check('the profile and the post writer use the same splitter', () => {
    assert.match(read('netlify/functions/process-content-jobs.ts'), /const pillarList = parsePillars\(rawPillars\);/);
    assert.match(read('assistants.js'), /if \(window\.ContentPillars\) return window\.ContentPillars\.parsePillars\(raw\);/);
    const w = read('workspace.html');
    assert.ok(w.indexOf('/src/public/content-pillars.js') < w.indexOf('/assistants.js'), 'the splitter must load before assistants.js');
});

console.log(`\n${passed} checks passed`);
