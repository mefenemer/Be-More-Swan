// tests/screen-record-followups.test.ts
// After "Record my screen" (docs/video-producer-screen-walkthrough-plan.md §13, owner 2026-11-21): the footage review
// flags private details it can read on screen (D-R2), and the Help Centre explains recording the screen.
//
// Run:  npx tsx tests/screen-record-followups.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { shotListSystemPrompt, reviewSystemPrompt } from '../src/lib/footage';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

check('the shot list marks private details it can read, without copying them', () => {
    const p = shotListSystemPrompt();
    assert.match(p, /PRIVATE DETAILS\./);
    assert.match(p, /an email address, a phone number, a password, a card or bank number, or a customer's name or details/);
    assert.match(p, /"private details on screen: <which kind/);
    assert.match(p, /Never copy the details themselves/);
    assert.match(p, /give it strength 0, so it isn't chosen/);
});

check('the review suggests cutting that stretch first, and never quotes the details', () => {
    const p = reviewSystemPrompt();
    assert.match(p, /When a shot's problems say "private details on screen", your FIRST suggestion is a cut \(or trim\) of exactly that stretch/);
    assert.match(p, /never the details themselves/);
    // It can't blur, so it must not promise to.
    assert.match(p, /It can't blur or cover part of the picture, so cutting is the only fix/);
    assert.match(p, /crop and reframe a clip — never suggest those/);   // the existing "can NOT" list still stands
});

const dir = new URL('../db/', import.meta.url);
const file = readdirSync(dir).find((f) => /^help-articles-2026-12z+-video-record-screen\.sql$/.test(f));

check('the help SQL sorts after every other 2026-12z… help file', () => {
    assert.ok(file, 'the file exists');
    const others = readdirSync(dir).filter((f) => f.startsWith('help-articles-2026-12z') && f !== file);
    assert.ok(others.length > 5);
    for (const o of others) assert.ok(o < file!, `${o} sorts before ${file}`);
});

check('the help SQL is guarded, quoted right, and says what the recorder does', () => {
    const sql = readFileSync(new URL(file!, dir), 'utf8');
    assert.match(sql, /AND content_md NOT LIKE '%## Record your screen%';/);
    assert.match(sql, /AND \(content_md LIKE '%up to 5 minutes and 500 MB%' OR content_md LIKE '%longer than 60 seconds\.%'\);/);
    const bodies = [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
    assert.strictEqual(bodies.length, 5, 'four replace() strings and the section');
    for (const b of bodies) {
        assert.ok(!b.includes(';'), 'no semicolons inside a body');
        assert.ok(!b.includes("''"), 'apostrophes NOT doubled inside $$');
    }
    const section = bodies[4];
    for (const words of ['Record my screen', 'Record my voice too', 'Choose what to share', 'Stop sharing', 'up to 10 minutes',
        'Only share what you need', 'Keep the screen\'s sound', 'phone or tablet', 'Recording and saving are free',
        'may point out private details', 'It can miss small text', 'Screen recordings for an AI presenter aren\'t reviewed',
        'Record my voice too** is left unticked']) assert.ok(section.includes(words), `section says: ${words}`);
    // The stale Phase 0 lines are replaced word for word.
    assert.ok(bodies[0] === 'Each recording can be up to 5 minutes and 500 MB, and you can use up to 10.');
    assert.ok(bodies[2] === "It can't yet put a separate camera recording in a bubble over a separate screen recording, or make videos longer than 60 seconds.");
    const phase0 = readFileSync(new URL('help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-screen-recordings.sql', dir), 'utf8');
    assert.ok(phase0.includes(bodies[0]) && phase0.includes(bodies[2]), 'the old text matches what Phase 0 published');
    // The camera-bubble limitation is still true (D-R1 not built), so it stays.
    assert.ok(bodies[3].startsWith("It can't yet put a separate camera recording in a bubble over a separate screen recording."));
});

console.log(`\n${passed} passed`);
