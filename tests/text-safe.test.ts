// tests/text-safe.test.ts
// A half-emoji in a prompt made every social draft fail on prod (2026-10-14): Anthropic answered
// "The request body is not valid JSON: unexpected end of hex escape". See src/utils/text-safe.ts.
//
// Run:  npx tsx tests/text-safe.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeSlice, sanitizeForModel, stripLoneSurrogates } from '../src/utils/text-safe';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const lone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

console.log('text safe');

check('the bug: a plain slice through an emoji leaves half of it, and JSON keeps the orphan', () => {
    const caption = 'x'.repeat(139) + '🚀 launch';
    assert.ok(lone(caption.slice(0, 140)));
    assert.match(JSON.stringify(caption.slice(0, 140)), /\\ud83d"$/);
});

check('safeSlice never cuts a character in half, and is a plain slice otherwise', () => {
    const caption = 'x'.repeat(139) + '🚀 launch';
    assert.strictEqual(safeSlice(caption, 140), 'x'.repeat(139));
    assert.strictEqual(safeSlice(caption, 141), 'x'.repeat(139) + '🚀');
    assert.strictEqual(safeSlice('hello', 3), 'hel');
    assert.strictEqual(safeSlice('hi', 10), 'hi');
});

check('stripping removes only orphans; whole emoji survive', () => {
    assert.strictEqual(stripLoneSurrogates('a\uD83Db🚀c\uDE80'), 'ab🚀c');
});

check('sanitizeForModel cleans every string in a nested prompt', () => {
    const out = sanitizeForModel({ system: 'ok\uD83D', messages: [{ role: 'user', content: [{ type: 'text', text: 'x\uD83D' }] }] });
    assert.ok(!lone(JSON.stringify(out).replace(/\\u/g, '')) && !lone(out.system) && !lone(out.messages[0].content[0].text));
});

check('the drafting gateway, the chat and the known cut points are protected', () => {
    const gw = read('src/lib/ai-gateway.ts');
    assert.strictEqual((gw.match(/system: sanitizeForModel\(req\.system\)/g) || []).length, 2, 'both gateway calls');
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('system: sanitizeForModel(system),') && chat.includes('system: sanitizeForModel(shadowSystem),'));
    assert.ok(read('src/utils/draft-variety.ts').includes('safeSlice((s || \'\').replace(/\\s+/g, \' \').trim(), max)'), 'the variety cut (the actual culprit)');
    assert.ok(read('src/utils/team-activity.ts').includes('safeSlice(s.replace(/\\s+/g, \' \').trim(), max)'));
});

console.log(`\n${passed} passed`);
