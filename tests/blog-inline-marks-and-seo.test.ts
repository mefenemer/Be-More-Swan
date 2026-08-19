// tests/blog-inline-marks-and-seo.test.ts
// Reported 2026-08-19: "I cannot underline text", "I cannot highlight text", and "why do I need to
// click to generate SEO".
//
// UNDERLINE / HIGHLIGHT — neither existed. The editor knew three inline marks (bold, italic, code)
// and Markdown has no syntax for either of the new ones, so they are raw <u> / <mark>. That makes
// the SERVER allowlist load-bearing: markdown-render.ts's sanitize-html produces the immutable
// published_payload, so a tag missing there renders in the Studio preview and is stripped from the
// live post — the preview lying about the published result is the exact failure that file warns of.
//
// SEO — the derivation sat inline in generate-seo.ts behind requireTenant, reachable only from a
// browser session. Every autopilot draft therefore had no meta title, description, tags or slug
// until a human opened Blog Studio and clicked a button.
//
// Pure: real toggle logic + the real sanitiser. No DB, no network, no model calls.
// Run:  npx tsx tests/blog-inline-marks-and-seo.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../src/utils/markdown-render';
import { landmark } from './landmark';

let passed = 0;
/**
 * ⚠️ AWAITS the body, exactly as tests/markdown-editor-blocks.test.ts does — renderMarkdown is async
 * (marked is ESM-only, reached via dynamic import). Without the await an async body returns a
 * pending promise, the tick prints, and the assertions inside never run.
 */
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const editorSrc = read('../src/components/markdown-editor.js');
// The editor is UMD-ish and sets module.exports; require it the way the sibling suite does.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Editor = require('../src/components/markdown-editor.js');
const { toggleInlineMark, INLINE_MARKS } = Editor;

async function main() {

console.log('\nUnderline and highlight exist, and toggle like every other mark\n');

await check('the editor knows both new marks, as asymmetric HTML pairs', () => {
    assert.deepEqual(INLINE_MARKS.underline, ['<u>', '</u>']);
    assert.deepEqual(INLINE_MARKS.highlight, ['<mark>', '</mark>']);
});

await check('wrapping a selection produces the tags', () => {
    const out = toggleInlineMark('make this bold', 5, 9, INLINE_MARKS.underline);
    assert.equal(out.text, 'make <u>this</u> bold');
    // The selection must still cover the words, not the markup, or typing replaces the tag.
    assert.equal(out.text.slice(out.selStart, out.selEnd), 'this');
});

await check('toggling twice returns the original text exactly', () => {
    for (const mark of [INLINE_MARKS.underline, INLINE_MARKS.highlight]) {
        const on = toggleInlineMark('make this bold', 5, 9, mark);
        const off = toggleInlineMark(on.text, on.selStart, on.selEnd, mark);
        assert.equal(off.text, 'make this bold', `${mark[0]} did not round-trip`);
    }
});

await check('a selection INCLUDING the tags strips them', () => {
    const out = toggleInlineMark('make <mark>this</mark> bold', 5, 22, INLINE_MARKS.highlight);
    assert.equal(out.text, 'make this bold');
});

await check('the symmetric marks are untouched by the pair support', () => {
    // Bold/italic/code still pass a bare string; this is the regression that would break every
    // existing shortcut.
    const out = toggleInlineMark('make this bold', 5, 9, INLINE_MARKS.bold);
    assert.equal(out.text, 'make **this** bold');
    assert.equal(INLINE_MARKS.italic, '_');
});

await check('the toolbar and the Ctrl/Cmd+U shortcut are wired', () => {
    assert.ok(/fbButton\('U',/.test(editorSrc), 'no underline button on the format bar');
    assert.ok(/fbButton\('H',/.test(editorSrc), 'no highlight button on the format bar');
    assert.ok(/k === 'u'/.test(editorSrc), 'Ctrl/Cmd+U is not bound');
});

console.log('\nThe formatting SURVIVES the publish sanitiser\n');

await check('u and mark reach published_payload instead of being stripped', async () => {
    // The whole point. renderMarkdown is what freezes the published snapshot.
    const html = await renderMarkdown('Plain <u>underlined</u> and <mark>highlighted</mark> words.');
    assert.ok(html.includes('<u>underlined</u>'), `<u> was stripped: ${html}`);
    assert.ok(html.includes('<mark>highlighted</mark>'), `<mark> was stripped: ${html}`);
});

await check('the sanitiser is still hostile to everything else', async () => {
    // Adding tags to an allowlist is exactly where an XSS foothold gets introduced.
    const html = await renderMarkdown('<script>alert(1)</script><u onclick="alert(1)">x</u><iframe src="x"></iframe>');
    assert.ok(!/<script/i.test(html), 'script survived');
    assert.ok(!/<iframe/i.test(html), 'iframe survived');
    assert.ok(!/onclick/i.test(html), 'an event handler survived on the newly allowed tag');
});

console.log('\nSEO is generated with the draft, not by a button click\n');

const worker = read('../netlify/functions/process-blog-jobs.ts');
const handler = read('../netlify/functions/generate-seo.ts');
const util = read('../src/utils/blog-seo-generate.ts');
const modal = read('../src/components/blog-studio-modal.js');

await check('the core is extracted, so something other than a browser session can call it', () => {
    assert.ok(/export async function generateBlogSeo/.test(util), 'no shared core');
    // Check the IMPORT, not the word — the file's header explains what it was extracted from and
    // names requireTenant in prose, which a bare substring match reads as a dependency.
    assert.ok(!/^import .*requireTenant/m.test(util), 'the core still imports the session guard');
    assert.ok(!/requireTenant\(/.test(util), 'the core still calls the session guard');
    assert.ok(/generateBlogSeo\(db, \{/.test(handler), 'the handler no longer delegates');
});

await check('the worker generates SEO as soon as the body is written', () => {
    const start = landmark(worker, 'await generateBlogBody(');
    const slice = worker.slice(start, landmark(worker, "status: 'completed'", start));
    assert.ok(slice.includes('generateBlogSeo('), 'autopilot drafts still land with no metadata');
});

await check('a SEO failure never costs the draft', () => {
    // The body is the expensive artifact and it is already saved; a retry would redraft the whole
    // post to fix a title tag.
    const call = landmark(worker, 'await generateBlogSeo(db, {');
    const slice = worker.slice(Math.max(0, call - 1400), landmark(worker, "status: 'completed'", call));
    assert.ok(/try \{[\s\S]*generateBlogSeo\(/.test(slice), 'the SEO call is not wrapped');
    assert.ok(/console\.warn/.test(slice), 'a swallowed failure leaves no trace');
});

await check('the button relabels once metadata exists', () => {
    assert.ok(/function syncSeoButton\(\)/.test(modal), 'no relabelling at all');
    assert.ok(/'Regenerate SEO' : 'Generate SEO'/.test(modal), 'the two labels are not both present');
    // Derived from the field values, so it must run AFTER they are populated.
    const gen = modal.slice(landmark(modal, "api('generate-seo'"), landmark(modal, "api('generate-seo'") + 900);
    assert.ok(gen.indexOf('refreshSeoCounts()') < gen.indexOf('syncSeoButton()'),
        'syncSeoButton runs before the fields are set, so the label reads the old values');
});

console.log(`\n${passed} checks passed\n`);

}

void main();
