// tests/crosspost-grouping.test.ts
// Cross-post grouping: every route that can produce sibling posts must give them a shared
// crosspost_group_id, or the Review Queue renders one card per platform.
//
// Run:  npx tsx tests/crosspost-grouping.test.ts
//
// This is a SOURCE-level invariant test, which is unusual here and deliberate. The bug it exists
// for was a single missing field in netlify/functions/generate-post.ts: it set `platforms` (which
// makes process-content-jobs fan one idea out across platforms) but not `crosspostGroupId`. Nothing
// failed. No error was logged. The posts were correct in every respect except that
// workspace.html's _rqGroupKey() fell back to `id:<post id>`, so an on-demand post to four
// platforms appeared as four separate review cards — while Autopilot, gap-fill, manual and chat
// all collapsed correctly, because those four creators happened to set the field.
//
// A behavioural test cannot catch that class of bug cheaply: it needs a queued job, a drained
// worker and a rendered queue. What actually went wrong is a rule about the code — "if you enqueue
// a multi-platform job, stamp the group" — so that is what is asserted.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const SEARCH_DIRS = ['netlify/functions', 'src/utils'];

/** Every source file that enqueues a content-generation job. */
function jobCreatorFiles(): string[] {
    const out: string[] = [];
    for (const dir of SEARCH_DIRS) {
        const abs = path.join(ROOT, dir);
        if (!fs.existsSync(abs)) continue;
        for (const f of fs.readdirSync(abs)) {
            if (!f.endsWith('.ts')) continue;
            const p = path.join(abs, f);
            if (fs.readFileSync(p, 'utf8').includes('insert(contentGenerationJobs)')) out.push(path.join(dir, f));
        }
    }
    return out;
}

/** The `.values({ ... })` object of each contentGenerationJobs insert in a file. */
function insertBodies(src: string): string[] {
    const bodies: string[] = [];
    const marker = 'insert(contentGenerationJobs)';
    let from = 0;
    for (;;) {
        const i = src.indexOf(marker, from);
        if (i === -1) break;
        from = i + marker.length;
        const open = src.indexOf('{', landmark(src, '.values(', i));
        if (open === -1) continue;
        // Walk braces so a nested object inside the values literal doesn't end it early.
        let depth = 0;
        let end = open;
        for (let j = open; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
        bodies.push(src.slice(open, end + 1));
    }
    return bodies;
}

const files = jobCreatorFiles();

check('the job creators are discoverable (the scan itself still works)', () => {
    assert.ok(files.length >= 5, `only found ${files.length} job creators — the scan is probably broken, not the code`);
    assert.ok(files.some((f) => f.endsWith('generate-post.ts')), 'generate-post.ts not among the creators');
});

check('every multi-platform job carries a crosspost group id', () => {
    const offenders: string[] = [];
    for (const rel of files) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const body of insertBodies(src)) {
            // `platforms:` (plural) is what turns on the fan-out in process-content-jobs; a job
            // without it produces exactly one post and needs no group.
            if (!/\bplatforms\s*:/.test(body)) continue;
            if (!/\bcrosspostGroupId\s*:/.test(body)) offenders.push(rel);
        }
    }
    assert.deepEqual(
        offenders, [],
        `these enqueue a multi-platform job without a crosspostGroupId, so their posts will render as separate Review Queue cards: ${offenders.join(', ')}`,
    );
});

check('generate-post stamps the group only for genuine cross-posts', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/generate-post.ts'), 'utf8');
    const body = insertBodies(src)[0] ?? '';
    assert.match(body, /crosspostGroupId:\s*platforms\.length\s*>\s*1\s*\?\s*randomUUID\(\)\s*:\s*null/,
        'a single-platform on-demand post must stay ungrouped (null), not get a pointless group id');
    // Same predicate as `platforms`, so the group id exists exactly when the fan-out runs.
    assert.match(body, /platforms:\s*platforms\.length\s*>\s*1/);
});

console.log(`\n${passed}/${total} passed`);
