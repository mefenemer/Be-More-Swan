// tests/inspo-links.test.ts
// Adding a LINK to Inspo (AC2): "use this page to inspire my posts".
//
// The server half shipped long ago — inspo-items.ts accepts kind:'url', and
// process-inspo-background.ts fetches the page (SSRF-guarded), extracts its text and indexes it —
// but nothing in the tab could send one, so the feature was unreachable. This pins the UI half.
//
// Run:  npx tsx tests/inspo-links.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/components/assistant-inspo.js'), 'utf8');

const sandbox: any = { window: {}, document: {}, fetch: () => {}, setTimeout, clearTimeout, console, URL };
createContext(sandbox);
runInContext(src, sandbox);
const t = sandbox.window.AssistantInspo && sandbox.window.AssistantInspo._test;

console.log('\nThe helpers');

check('the component exposes the link helpers', () => {
    assert.ok(t && typeof t.itemBadge === 'function' && typeof t.linkHref === 'function' && typeof t.normaliseLink === 'function');
});

check('a pasted link without a scheme gets https://; one with a scheme is left for the server to judge', () => {
    assert.strictEqual(t.normaliseLink('  example.com/post '), 'https://example.com/post');
    assert.strictEqual(t.normaliseLink('http://example.com'), 'http://example.com');
    assert.strictEqual(t.normaliseLink('ftp://example.com'), 'ftp://example.com');
    assert.strictEqual(t.normaliseLink(''), '');
});

check('only http(s) ever becomes an href on the card', () => {
    assert.strictEqual(t.linkHref('https://example.com/a'), 'https://example.com/a');
    assert.strictEqual(t.linkHref('javascript:alert(1)'), null);
    assert.strictEqual(t.linkHref('not a url'), null);
    assert.strictEqual(t.linkHref(null), null);
});

check('a link\'s badge reports the READ while it matters, then falls back to indexing', () => {
    assert.strictEqual(t.itemBadge({ kind: 'url', ingestStatus: 'pending', embeddingStatus: 'pending' }).label, 'Reading link…');
    assert.strictEqual(t.itemBadge({ kind: 'url', ingestStatus: 'failed', embeddingStatus: 'failed' }).label, "Couldn't read link");
    assert.strictEqual(t.itemBadge({ kind: 'url', ingestStatus: 'unsupported', embeddingStatus: 'embedded' }).label, 'Note only');
    assert.strictEqual(t.itemBadge({ kind: 'url', ingestStatus: 'ready', embeddingStatus: 'embedded' }).label, 'Indexed');
    // Notes never had a read step, so nothing about them changes.
    assert.strictEqual(t.itemBadge({ kind: 'text', ingestStatus: 'ready', embeddingStatus: 'embedded' }).label, 'Indexed');
});

check('"Write a post from this" on a link hands the assistant the link too', () => {
    const seed = t.buildSeed({ kind: 'url', title: 'example.com', sourceUrl: 'https://example.com/a', body: 'Page text' }, 'social_media_manager');
    assert.ok(seed.includes('Link: https://example.com/a'), seed);
    const note = t.buildSeed({ kind: 'text', title: 'T', body: 'B' }, 'social_media_manager');
    assert.ok(!note.includes('Link:'), 'a note must not grow a Link line');
});

console.log('\nThe wiring');

check('the composer offers Note / Link, and a link is POSTed as kind:url with its sourceUrl', () => {
    assert.ok(src.includes('data-inspo-mode="note"') && src.includes('data-inspo-mode="link"'));
    assert.ok(src.includes("querySelectorAll('[data-inspo-mode]')"), 'the mode buttons must be bound');
    assert.ok(/api\('POST', \{ assistantId: state\.assistantId, kind: 'url', sourceUrl, userNote \}\)/.test(src));
});

check('editing a link sends the note only — never typed text that would replace the page\'s', () => {
    assert.ok(/if \(editingLink\) \{\s*await api\('PUT', \{ id: state\.editingId, userNote \}\);/.test(src));
});

check('the list keeps re-reading while a link is pending, and stops', () => {
    assert.ok(/const POLL_MAX = \d+;/.test(src), 'polling must be bounded');
    assert.ok((src.match(/schedulePoll\(true\)/g) || []).length >= 2, 'poll after a link save AND on tab load');
});

check('file upload is still not advertised (no R2 wiring yet)', () => {
    assert.ok(!/kind: 'file'/.test(src), 'the composer must not send files until upload is wired');
});

console.log(`\n${passed} passed`);
