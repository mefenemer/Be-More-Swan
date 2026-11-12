// tests/blog-studio-open-throw.test.ts
// Issue #41: "Blog Studio does not open when I open an article". A failed RESPONSE already showed the
// open error (e2e/blog-studio-open-error.spec.ts), but anything that THREW while the editor was being
// built was swallowed by a catch that only cleared the status line, leaving a blank panel. Both open
// paths must now hide the half-built workspace and show the error with Try again.
//
// Run:  npx tsx tests/blog-studio-open-throw.test.ts

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
const bs = readFileSync(join(root, 'src/components/blog-studio-modal.js'), 'utf8');
const slice = (a: string, b: string) => {
    const i = bs.indexOf(a); assert.notStrictEqual(i, -1, `marker gone: ${a}`);
    const j = bs.indexOf(b, i); assert.notStrictEqual(j, -1, `marker gone: ${b}`);
    return bs.slice(i, j);
};

check('openFailed hides the workspace and shows the open error', () => {
    const fn = slice('function openFailed(', '// ── Widget config');
    assert.match(fn, /el\('bs-workspace'\)\.classList\.add\('bs-hidden'\)/);
    assert.match(fn, /showOpenError\(msg, retry\)/);
});

check('loadExistingPost: a throw shows "Could not open this article" with a retry', () => {
    const fn = slice('function loadExistingPost(', 'function openFailed(');
    assert.match(fn, /\.catch\(function \(\) \{ openFailed\('Could not open this article[^']*', function \(\) \{ loadExistingPost\(id\); \}\); \}\)/);
});

check('startBlankPost: a throw shows the error, and Try again reopens the created draft', () => {
    const fn = slice('function startBlankPost(', '// Inline "AI draft"');
    assert.match(fn, /\.catch\(function \(\) \{/);
    assert.match(fn, /openFailed\('Could not start a new draft/);
    assert.match(fn, /made \? function \(\) \{ loadExistingPost\(made\); \} : startBlankPost/);
});

// Issue #42: "Blog Studio opens to a blank page when an article is clicked from the Blogs tab". The
// post is only requested once blog-tone answers; until then nothing was on screen (or the previous
// article was), and a throw in that step was not caught at all.
check('openBlogStudio: the opening line shows at once and the old editor is hidden', () => {
    const fn = slice('function openBlogStudio(', 'function notifyChanged(');
    const opening = fn.indexOf("showOpening(opts.postId ? 'Opening your article");
    assert.notStrictEqual(opening, -1, 'opening line not shown on open');
    assert.ok(opening < fn.indexOf('loadAssistants()'), 'opening line must show before waiting on blog-tone');
    assert.match(fn, /el\('bs-workspace'\)\.classList\.add\('bs-hidden'\);/);
});

check('openBlogStudio: a throw while starting the load shows the open error with a retry', () => {
    const fn = slice('function openBlogStudio(', 'function notifyChanged(');
    assert.match(fn, /\}\)\.catch\(function \(\) \{[\s\S]*openFailed\(/);
    assert.match(fn, /openBlogStudio\(opts\)/);
});

console.log(`\n${passed} passed`);
