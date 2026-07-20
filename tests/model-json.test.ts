// tests/model-json.test.ts
// Locks the model-reply JSON extraction that feeds post captions. The regression this guards:
// a ```json-fenced or truncated reply used to fail JSON.parse and get persisted verbatim, so
// the dashboard's "Requires your attention" cards showed `` ```json { "caption": "…\n\n… ``.
// Pure string handling — no network or DB.
// Run:  npx tsx tests/model-json.test.ts

import assert from 'node:assert';
import { parseModelJson, salvageStringField, toCaptionText, displayCaption, stripCodeFences } from '../src/utils/model-json';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── stripCodeFences ─────────────────────────────────────────────────────────
check('strips a ```json fence', () => {
    assert.equal(stripCodeFences('```json\n{"a":1}\n```'), '{"a":1}');
});
check('strips a bare ``` fence', () => {
    assert.equal(stripCodeFences('```\n{"a":1}\n```'), '{"a":1}');
});
check('leaves unfenced text alone', () => {
    assert.equal(stripCodeFences('  hello  '), 'hello');
});

// ── parseModelJson ──────────────────────────────────────────────────────────
check('parses a clean object', () => {
    assert.deepEqual(parseModelJson('{"caption":"hi"}'), { caption: 'hi' });
});
check('parses a fenced object (the reported failure)', () => {
    const raw = '```json\n{ "caption": "You didn\'t start a business to become a software expert.\\n\\nYet here you are." }\n```';
    assert.equal(parseModelJson<{ caption: string }>(raw)!.caption.includes('\n\nYet here you are.'), true);
});
check('parses an object wrapped in prose', () => {
    assert.deepEqual(parseModelJson('Sure! Here you go:\n{"caption":"hi"}\nHope that helps.'), { caption: 'hi' });
});
check('a brace inside a caption does not truncate the object', () => {
    const parsed = parseModelJson<{ caption: string; hashtags: string }>('{"caption":"use {braces} here","hashtags":"#a"}');
    assert.equal(parsed!.caption, 'use {braces} here');
    assert.equal(parsed!.hashtags, '#a');
});
check('returns null for an array reply', () => {
    assert.equal(parseModelJson('[1,2,3]'), null);
});
check('returns null for a truncated object', () => {
    assert.equal(parseModelJson('{"caption":"half a sen'), null);
});

// ── salvageStringField ──────────────────────────────────────────────────────
check('salvages a caption from a truncated reply', () => {
    assert.equal(salvageStringField('```json\n{ "caption": "Half a thought', 'caption'), 'Half a thought');
});
check('salvages and unescapes newlines', () => {
    assert.equal(salvageStringField('{ "caption": "one\\ntwo", "hashtags":', 'caption'), 'one\ntwo');
});
check('returns null when the field is absent', () => {
    assert.equal(salvageStringField('{"hashtags":"#a"}', 'caption'), null);
});

// ── toCaptionText ───────────────────────────────────────────────────────────
check('prefers the parsed caption', () => {
    assert.equal(toCaptionText('```json\n{"caption":"clean copy","hashtags":"#a"}\n```'), 'clean copy');
});
check('falls back to salvage when the JSON is truncated', () => {
    assert.equal(toCaptionText('{"caption":"salvaged copy'), 'salvaged copy');
});
check('passes plain prose through', () => {
    assert.equal(toCaptionText('just a caption'), 'just a caption');
});
check('never returns JSON scaffolding as copy', () => {
    assert.equal(toCaptionText('{"hashtags":"#a","pillar":null}'), '');
});

// ── displayCaption (read-time repair of rows already stored) ────────────────
check('leaves an already-clean stored caption untouched', () => {
    const stored = 'You didn\'t start a business to spend your Tuesday afternoon…';
    assert.equal(displayCaption(stored), stored);
});
check('unwraps a stored raw reply', () => {
    const stored = '```json\n{ "caption": "You didn\'t start a business to become a software expert.\\n\\nYet here you are.", "hashtags": "#founders" }\n```';
    assert.equal(displayCaption(stored), 'You didn\'t start a business to become a software expert.\n\nYet here you are.');
});
check('handles null / empty', () => {
    assert.equal(displayCaption(null), '');
    assert.equal(displayCaption('   '), '');
});
check('unrecoverable JSON falls back to the stored text rather than blanking', () => {
    assert.equal(displayCaption('{"hashtags":"#a"}'), '{"hashtags":"#a"}');
});

console.log(`\n${passed} checks passed.`);
