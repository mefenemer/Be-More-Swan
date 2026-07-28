// tests/new-post-platform-defaults.test.ts
// A new post should target every connected account by default.
//
// The job table showed the symptom plainly: content_generation_jobs rows with `platforms` NULL and
// `platform` = 'instagram', on a workspace with four accounts connected — beside two rows that DID
// carry ["instagram","facebook","linkedin","x"]. The column and the fan-out both work; the callers
// were not asking for a fan-out.
//
// Two independent causes, both fixed here:
//   1. The command bar's "delegate" path sent `platform` alone and never `platforms`, so
//      generate-post stored a legacy single-platform job.
//   2. The Create Post sheet preselected only the FIRST connected platform.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');
const gen = readFileSync(path.join(ROOT, 'netlify/functions/generate-post.ts'), 'utf8');

console.log('\nnew post platform defaults\n');

check('the Create Post sheet preselects every connected platform', () => {
    const block = ws.slice(ws.indexOf('gpUpdateConnectedPlatforms(_gpCap?.connectedPlatforms || [])'));
    const body = block.slice(0, 1400);
    assert.match(body, /_gpSelectedPlatforms = all\.length \? all : \['instagram'\]/,
        'selecting only the first connected platform is how four accounts became one Instagram draft');
    // The fallback must be reachable ONLY when nothing is connected.
    assert.match(body, /const all = _GP_PLATFORMS\.map\(p => p\.id\)\.filter\(/, 'ordered by the catalogue, not a second list');
    assert.ok(!/\.find\(p => connected\.some/.test(body), 'find() returns one platform — filter() is the fix');
});

check('the command bar asks for a fan-out, not one network', () => {
    const block = ws.slice(ws.indexOf("if (d.type === 'delegate' && d.assistantId)"));
    const body = block.slice(0, 2200);
    assert.match(body, /platforms: platforms\.length \? platforms : undefined/,
        'sending `platform` alone stores a legacy single-platform job');
    assert.match(body, /cap\?\.connectedPlatforms/, 'the list comes from live connections');
    // A platform the router named must still lead, so "post this to LinkedIn" leads with LinkedIn.
    assert.match(body, /platforms\.unshift\(d\.platform\)/, 'a named platform stays primary');
});

check('generate-post only fans out when 2+ targets are named', () => {
    // The server side was already correct — worth pinning, because it is what makes the client fix
    // meaningful: one platform stays on the legacy column and does NOT get a crosspost group.
    assert.match(gen, /platforms: platforms\.length > 1 \? platforms : null/,
        'a single-platform job must stay legacy, or it gets a crosspost group of one');
});

check('the seeding block keeps exactly one Instagram fallback', () => {
    // Scoped to the block that DECIDES the default, not the whole file: the module-level initial
    // value and the `[0] || 'instagram'` primary-platform fallback are both legitimate and are
    // overwritten on open. What must not come back is a literal used as a PRESELECTION.
    const start = ws.indexOf('gpUpdateConnectedPlatforms(_gpCap?.connectedPlatforms || [])');
    const block = ws.slice(start, ws.indexOf('gpRenderPlatformSelection();', start));
    const hits = block.match(/'instagram'/g) || [];
    assert.strictEqual(hits.length, 1, 'one fallback, reachable only when nothing is connected');
    assert.match(block, /all\.length \? all : \['instagram'\]/, 'and it is the else branch, not the default');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
