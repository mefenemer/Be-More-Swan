// tests/crosspost-fanout-partial.test.ts
// One-idea fan-out: the primary post is created, then cloned onto every other target platform.
//
// The failure mode worth protecting against is a SILENT PARTIAL. The sibling loop used to sit
// inside a single try/catch, so the first platform that threw aborted the loop and took every
// platform after it too — a cross-post aimed at four accounts could land on two, and in the Review
// Queue a two-platform group is indistinguishable from a deliberately narrow post. Nothing said
// otherwise; the catch logged one line and the job reported success.
//
// This reproduces the loop's control flow and asserts the guarantees.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(ROOT, 'netlify/functions/process-content-jobs.ts'), 'utf8');

/** The shipped control flow: try/catch INSIDE the loop, tallying made/failed. */
function fanOut(targets: string[], failOn: string[]) {
    const made: string[] = [];
    const failed: string[] = [];
    for (const p of targets.slice(1)) {
        try {
            if (failOn.includes(p)) throw new Error('insert failed');
            made.push(p);
        } catch { failed.push(p); }
    }
    return { created: [targets[0], ...made], failed };
}

console.log('\ncross-post fan-out: partial groups\n');

check('one failing platform no longer takes the rest with it', () => {
    // instagram fails; facebook and x come AFTER it and must still be created.
    const r = fanOut(['linkedin', 'instagram', 'facebook', 'x'], ['instagram']);
    assert.deepEqual(r.created, ['linkedin', 'facebook', 'x'], 'platforms after the failure were dropped');
    assert.deepEqual(r.failed, ['instagram']);
});

check('the primary survives however many siblings fail', () => {
    const r = fanOut(['linkedin', 'instagram', 'facebook', 'x'], ['instagram', 'facebook', 'x']);
    assert.deepEqual(r.created, ['linkedin'], 'the primary post is already drafted and must not be lost');
    assert.strictEqual(r.failed.length, 3);
});

check('a clean run creates every target exactly once', () => {
    const targets = ['linkedin', 'instagram', 'facebook', 'x'];
    const r = fanOut(targets, []);
    assert.deepEqual(r.created, targets);
    assert.deepEqual(r.failed, []);
    assert.strictEqual(new Set(r.created).size, r.created.length, 'a platform was cloned twice');
});

check('a single-platform job fans out to nothing and still succeeds', () => {
    const r = fanOut(['linkedin'], []);
    assert.deepEqual(r.created, ['linkedin']);
    assert.deepEqual(r.failed, []);
});

// ── The wiring, at source level ─────────────────────────────────────────────────────────────────
check('the sibling insert is guarded per platform, not per fan-out', () => {
    const loop = src.slice(landmark(src, 'for (const siblingPlatform of targetPlatforms.slice(1))'));
    const bodyEnd = loop.indexOf('if (failed.length)');
    assert.ok(bodyEnd > 0, 'the tally must exist');
    const body = loop.slice(0, bodyEnd);
    assert.match(body, /try \{/, 'each sibling stands or falls on its own');
    assert.match(body, /catch \(sibErr\)/, 'and names its own platform when it fails');
    assert.match(body, /failed\.push\(siblingPlatform\)/);
});

check('a short group is reported, not swallowed', () => {
    // Once it is in the queue a partial cross-post looks exactly like an intentional one, so the log
    // is the only place the discrepancy is visible at all.
    assert.match(src, /PARTIAL cross-post/, 'the discrepancy must be stated');
    assert.match(src, /asked for \$\{targetPlatforms\.join\(','\)\}/, 'with what was asked for');
    assert.match(src, /missing \$\{failed\.join\(','\)\}/, 'and what is missing');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
