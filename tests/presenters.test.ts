// tests/presenters.test.ts
// The AI presenter roster (docs/video-producer-screen-walkthrough-plan.md §11.3, Phase A1; decision D-A2): one
// catalogue for the server and the picker, 6 female and 6 male, every file made, an English voice of their own
// and a voice for every language that follows their gender.
//
// Run:  npx tsx tests/presenters.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { PRESENTERS, PRESENTER_MODEL, presenterById, presenterFiles, presenterLanguages, presenterVoice } from '../src/lib/presenters';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const voices = JSON.parse(read('src/public/voice-catalogue.json')) as { languages: Array<{ code: string }>; voices: Array<{ id: string; lang: string; gender: string; legacy?: boolean }> };
const offered = voices.voices.filter((v) => !v.legacy);

check('12 presenters to start: 6 female and 6 male, unique ids and names (D-A2)', () => {
    assert.strictEqual(PRESENTERS.length, 12);
    assert.strictEqual(PRESENTERS.filter((p) => p.gender === 'female').length, 6);
    assert.strictEqual(PRESENTERS.filter((p) => p.gender === 'male').length, 6);
    assert.strictEqual(new Set(PRESENTERS.map((p) => p.id)).size, 12);
    assert.strictEqual(new Set(PRESENTERS.map((p) => p.name)).size, 12);
    for (const p of PRESENTERS) assert.match(p.id, /^[a-z]+$/, `${p.id} is a safe file name`);
    // Mixed ages, not twelve thirty-somethings.
    assert.ok(new Set(PRESENTERS.map((p) => p.age)).size >= 4);
    assert.strictEqual(PRESENTER_MODEL, 'fal-ai/kling-video/ai-avatar/v2/standard', 'the samples were made with the chosen model (D-A1)');
});

check('a presenter is never named like a voice, so "Amara" and the voice "Pepper" are never confused', () => {
    const voiceNames = new Set(voices.voices.map((v) => (v as { name?: string }).name));
    for (const p of PRESENTERS) assert.ok(!voiceNames.has(p.name), `${p.name} is also a voice name`);
});

check('every presenter has its face, thumbnail and sample on disk, small enough to serve', () => {
    for (const p of PRESENTERS) {
        const f = presenterFiles(p.id);
        for (const [kind, path] of Object.entries(f)) assert.ok(existsSync(new URL(`..${path}`, import.meta.url)), `${p.id} ${kind}: ${path}`);
        assert.ok(statSync(new URL(`..${f.thumb}`, import.meta.url)).size < 60_000, `${p.id} thumbnail stays small`);
        assert.ok(statSync(new URL(`..${f.sample}`, import.meta.url)).size < 900_000, `${p.id} sample stays small`);
        assert.ok(statSync(new URL(`..${f.face}`, import.meta.url)).size < 500_000, `${p.id} face stays small`);
    }
});

check('each presenter\'s own English voice is an offered English voice of their gender', () => {
    for (const p of PRESENTERS) {
        const v = offered.find((x) => x.id === p.voices.en);
        assert.ok(v, `${p.id}: ${p.voices.en} is offered`);
        assert.strictEqual(v!.lang, 'en');
        assert.strictEqual(v!.gender, p.gender, `${p.id} speaks with a ${p.gender} voice`);
    }
    // Twelve different English voices: a roster, not one voice twelve times.
    assert.strictEqual(new Set(PRESENTERS.map((p) => p.voices.en)).size, 12);
});

check('one face speaks every language the voice list has, in a voice of their gender', () => {
    const langs = voices.languages.map((l) => l.code);
    for (const p of PRESENTERS) {
        for (const lang of langs) {
            const id = presenterVoice(p, lang);
            const v = offered.find((x) => x.id === id);
            assert.ok(v && v.lang === lang, `${p.id} has a ${lang} voice`);
            assert.strictEqual(v!.gender, p.gender, `${p.id} in ${lang}`);
        }
        assert.deepStrictEqual(new Set(presenterLanguages(p)), new Set(langs));
    }
    assert.strictEqual(presenterVoice(presenterById('amara')!, 'en'), 'british_woman');
    assert.strictEqual(presenterVoice(presenterById('amara')!, 'xx'), null, 'a language with no voice');
    assert.strictEqual(presenterById('nobody'), null);
});

check('the picker reads the one catalogue and plays the static samples (watching is free)', () => {
    const js = read('src/components/presenter-picker.js');
    assert.ok(js.includes("const URL = '/src/public/presenter-catalogue.json';"));
    assert.ok(js.includes("`/presenters/${encodeURIComponent(id)}"));
    for (const p of PRESENTERS) assert.ok(!js.includes(`'${p.name}'`) && !js.includes(`"${p.name}"`), `no presenter hard-coded in the picker (${p.name})`);
    assert.ok(/isn't a real person/.test(js), 'the picker says they are made up');
    // Cards clip their picture (overflow-hidden), so without explicit row sizing the grid squashed every card to a
    // sliver inside the modal's max height (browser check, 2026-11-17).
    assert.ok(js.includes('style="grid-auto-rows:max-content"') && js.includes('overflow-y-auto min-h-0 flex-1'));
    // A pre-filled field is repainted with the presenter's name once the catalogue arrives (review of #715).
    assert.ok(/load\(\)\.then\(\(\) => \{\s*document\.querySelectorAll\('\[data-ppf\]'\)/.test(js));
    // The same file names the server uses.
    assert.ok(js.includes("kind === 'thumb' ? '-thumb.jpg' : kind === 'face' ? '.jpg' : '.mp4'"));
});

check('the make script has a written description for every presenter and never a real person', () => {
    const src = read('scripts/make-presenters.mjs');
    for (const p of PRESENTERS) assert.ok(src.includes(`    ${p.id}: '`), `${p.id} is described in LOOKS`);
    assert.ok(src.includes('a made-up person'));
});

console.log(`\npresenters: ${passed} passed`);
