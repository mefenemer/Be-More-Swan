// tests/platform-tab-removal.test.ts
// A post must be narrowable to one platform.
//
// It stopped being possible without anything noticing, which is the point of this file. "Create
// Post" seeds a draft on EVERY connected account (openGeneratePostSheet), the editor's Platforms
// step was deleted as redundant, and approve, reject and discard all act on the whole cross-post
// group — so "this clip is a Reel, Instagram only" had no answer anywhere in the product. The
// server side never went away: set-post-platforms.ts was sitting there, tested, unreachable.
//
// So these checks are about the CONTROL still existing and still being wired, not about the
// endpoint. The endpoint was never the part that broke.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
const css = readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const server = readFileSync(path.join(ROOT, 'netlify/functions/set-post-platforms.ts'), 'utf8');

// The tab strip's renderer, isolated so a × somewhere else in the file cannot satisfy these.
const tabs = ws.slice(
    ws.indexOf('function _rqReviewRenderTabs()'),
    ws.indexOf('\n/**\n * Why this platform cannot publish'),
);

console.log('\nplatform tab removal\n');

check('every platform tab carries a × that removes that platform', () => {
    assert.ok(tabs.includes('onclick="rqReviewRemovePlatform(${p.id})"'),
        'no × on the tabs means a post cannot be narrowed to one platform anywhere in the product');
    assert.match(tabs, /aria-label="Stop posting this to \$\{_rqEsc\(rqPlatformLabel\(p\.platform\)\)\}"/,
        'the × is a bare glyph — without a label it is unreadable to a screen reader');
});

check('the × is a sibling of the tab, never nested inside it', () => {
    // A <button> inside a <button> is invalid HTML, and browsers reparent it — the × would end up
    // outside the strip, or its click would be swallowed by the tab switch underneath.
    const opensTab = tabs.indexOf('onclick="rqReviewSwitchPlatform(${p.id})"');
    const closesTab = tabs.indexOf('</button>', opensTab);
    const opensX = tabs.indexOf('onclick="rqReviewRemovePlatform(${p.id})"');
    assert.ok(opensTab > -1 && closesTab > -1 && opensX > -1, 'both buttons must be in the tab template');
    assert.ok(opensX > closesTab, 'the × must come after the tab button closes, not inside it');
});

check('removal is offered only where the server would allow it', () => {
    assert.match(tabs, /const removable = group\.length > 1 && _RQ_PLATFORM_REMOVABLE\.includes\(p\.status\)/,
        'a × on the last platform, or on a scheduled one, is a button that argues with the server');
});

check('the removable statuses match the server\'s own list', () => {
    // set-post-platforms.ts refuses to delete anything else and reports it back as `locked`. A
    // client list that has drifted wider offers a × that cannot work; narrower hides a legitimate one.
    const clientList = /_RQ_PLATFORM_REMOVABLE = \[([^\]]+)\]/.exec(ws)?.[1] ?? '';
    const serverList = /const MUTABLE = \[([^\]]+)\]/.exec(server)?.[1] ?? '';
    const norm = (s: string) => s.split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean).sort();
    assert.ok(serverList, 'MUTABLE not found in set-post-platforms.ts — has it been renamed?');
    assert.deepStrictEqual(norm(clientList), norm(serverList),
        'the editor and the endpoint disagree about which rows may be deleted');
});

check('the surviving set is derived from the group, not from the tab clicked', () => {
    const fn = ws.slice(ws.indexOf('async function rqReviewRemovePlatform('), ws.indexOf('\n/**\n * Why this platform cannot publish'));
    assert.match(fn, /const remaining = \[\.\.\.new Set\(group\.map\(p => p\.platform\)\.filter\(p => p && p !== post\.platform\)\)\]/,
        'sending anything other than "the group minus this one" can drop a platform the user never touched');
    assert.match(fn, /if \(!remaining\.length\)/, 'the last platform must be refused before the request, not by a 400');
    assert.match(fn, /confirm\(/, 'removal deletes that platform\'s caption, media and overlays — it has to ask');
});

check('set-post-platforms is called from exactly one place', () => {
    // Two surfaces ask for the same change (the tab × and the parked chip picker). Two copies of the
    // in-flight state, the refetch and the `locked` answer is how one of them quietly stops matching.
    const calls = ws.match(/functions\/set-post-platforms/g) || [];
    assert.strictEqual(calls.length, 1, `expected 1 fetch of set-post-platforms, found ${calls.length}`);
    assert.ok(ws.includes('async function _pceApplyPlatforms('), 'the shared commit helper is gone');
    assert.match(ws, /const d = await _pceApplyPlatforms\(remaining\)/, 'the tab × must go through the helper');
    assert.match(ws, /const d = await _pceApplyPlatforms\(\[\.\.\.current\]\)/, 'the chip picker must go through the helper too');
});

check('the busy flag clears before the reopen, not after', () => {
    const fn = ws.slice(ws.indexOf('async function _pceApplyPlatforms('), ws.indexOf('async function _pceTogglePostPlatform('));
    const clears = fn.indexOf('_pcePlatformBusy = false');
    const reopens = fn.indexOf('await openPostReview(');
    assert.ok(clears > -1 && reopens > -1, 'both steps must be present');
    assert.ok(clears < reopens,
        'openPostReview repaints the tabs — repainting while still "busy" leaves the whole strip disabled');
});

check('the strike-through stays off the wrapper', () => {
    // text-decoration does not propagate into an inline-block child, so `line-through` on the div
    // that holds the label and the × would leave the label unstruck: a platform that cannot publish
    // would silently look like one that can.
    assert.match(tabs, /const borderTone = .*'border-transparent' : 'border-emerald-600'/,
        'the wrapper carries the BORDER only');
    assert.ok(!/const borderTone = [^;]*line-through/s.test(tabs), 'line-through must not be on the wrapper');
    assert.match(tabs, /const textTone = \s*blocked\s*\?\s*'text-gray-300 line-through'/,
        'the label carries the text tone, including the strike-through');
});

check('every utility the × uses is in the compiled stylesheet', () => {
    // Tailwind is compiled ahead of time here and rebuilding it churns unrelated selectors across
    // style.css, so a class invented in markup is simply a class that does nothing.
    const used = ['px-1.5', 'pl-3', 'text-sm', 'leading-none', 'text-gray-300',
                  'hover:text-red-600', 'cursor-not-allowed', 'opacity-40',
                  'items-stretch', 'text-left', 'inline-flex', 'border-transparent'];
    // Tailwind escapes '.' and ':' in the selector it emits, so `px-1.5` is written `.px-1\.5` in
    // the file. Compared as a literal rather than a regex: an unescaped '.' would match any
    // character and quietly pass for a class that is not there.
    const present = (cls: string) => {
        const sel = '.' + cls.replace(/([.:])/g, '\\$1');
        for (let i = css.indexOf(sel); i > -1; i = css.indexOf(sel, i + 1)) {
            if (' ,{:'.includes(css[i + sel.length])) return true;   // a whole class, not a prefix
        }
        return false;
    };
    const missing = used.filter(c => !present(c));
    assert.deepStrictEqual(missing, [], `not compiled into style.css: ${missing.join(', ')}`);
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
