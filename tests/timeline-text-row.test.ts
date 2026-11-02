// tests/timeline-text-row.test.ts
// SWAN-7 (2026-11-01): the post editor's timeline shows each text box as an EDITABLE one-line field,
// and that field held the first 22 characters of the box. Changing one letter and leaving the field
// saved "True stories. Real fil" over "True stories. Real films." — and wrote the field's value over
// the whole text, so a two-line box lost its second line too.
//
// Run:  npx tsx tests/timeline-text-row.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const html = readFileSync('workspace.html', 'utf8');

// The helper itself, lifted out of the page and run.
const start = html.indexOf('function _rqTimelineTextEdit(');
assert.ok(start !== -1, '_rqTimelineTextEdit is missing from workspace.html');
const end = html.indexOf('\n}\n', start);
// eslint-disable-next-line no-new-func
const edit = new Function(`${html.slice(start, end + 2)}; return _rqTimelineTextEdit;`)() as (p: unknown, l: unknown) => string;

check('editing a one-line box replaces it', () => {
    assert.equal(edit('True stories. Real films.', 'True stories. Real films!'), 'True stories. Real films!');
});

check('editing the first line keeps the lines after it', () => {
    assert.equal(edit('Is your boiler\nwinter-ready?', 'Is YOUR boiler'), 'Is YOUR boiler\nwinter-ready?');
});

check('a box with no text yet takes the typed line', () => {
    assert.equal(edit(undefined, 'Hello'), 'Hello');
});

check('the timeline row shows the whole first line, not 22 characters of it', () => {
    const i = html.indexOf("return row('text', ov.id || String(i),");
    assert.ok(i !== -1, 'text row call not found');
    const call = html.slice(i, html.indexOf('\n', i));
    assert.ok(!/\.slice\(0,\s*\d+\)/.test(call), `the row still truncates: ${call}`);
});

check('both edit handlers go through the helper', () => {
    assert.equal((html.match(/ov\.text = _rqTimelineTextEdit\(ov\.text, el\.value\);/g) || []).length, 2);
    assert.ok(!html.includes('ov.text = el.value;'), 'a handler still writes the field over the whole text');
});

console.log(`\n${passed} passed`);
