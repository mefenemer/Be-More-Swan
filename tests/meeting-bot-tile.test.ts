// The Note Taker's picture in a call, drawn for each workspace (src/utils/meeting-bot-tile.ts; owner 2026-11-21):
// the company large, "Hi, I'm ⟨assistant⟩ from ⟨company⟩" above, "Note Taker" + status below, "Powered by Be More Swan".
// Run: npx tsx tests/meeting-bot-tile.test.ts
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { MAX_JPEG_BYTES, canDraw, drawBotTiles, drawTile, drawableName, fitLines, fontHas, tileWords, type Measure } from '../src/utils/meeting-bot-tile';
import { TILE_FONT_WOFF2_B64 } from '../src/utils/meeting-bot-tile-assets';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';

let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`✓ ${name}`); } catch (err) { failed++; console.error(`✗ ${name}\n  ${err instanceof Error ? err.stack : err}`); }
}
const read = (p: string) => readFileSync(p, 'utf8');

/** JPEG width × height from the SOF0/SOF2 header. */
function jpegSize(jpg: Buffer): [number, number] | null {
    let i = 2;
    while (i < jpg.length) {
        const marker = jpg[i + 1], len = jpg.readUInt16BE(i + 2);
        if (marker === 0xc0 || marker === 0xc2) return [jpg.readUInt16BE(i + 7), jpg.readUInt16BE(i + 5)];
        i += 2 + len;
    }
    return null;
}

(async () => {
await test('the words: greeting with assistant and company, the company, Note Taker, status, Powered by', () => {
    const w = tileWords({ assistantName: 'Orbit Scribe', businessName: 'Marmalade Productions' }, 'recording');
    assert.equal(w.greeting, "Hi, I'm Orbit Scribe from Marmalade Productions");
    assert.equal(w.shortGreeting, "Hi, I'm Orbit Scribe");
    assert.equal(w.business, 'Marmalade Productions');
    assert.equal(w.noteTaker, 'Note Taker');
    assert.deepEqual(w.status, ['Taking notes', '& recording'], 'two lines, so a portrait Meet tile doesn\'t cut it (e6499d91)');
    assert.equal(w.poweredBy, 'Powered by Be More Swan');
    assert.deepEqual(tileWords({ assistantName: 'X', businessName: 'Y' }, 'not-recording').status, ['In the call', 'not recording']);
});

await test('the words: no assistant name, spaces tidied; no company = Be More Swan\'s own tile', () => {
    assert.equal(tileWords({ assistantName: '  ', businessName: ' Acme \n Ltd ' }, 'recording').greeting, "Hi, I'm the Note Taker from Acme Ltd");
    const none = tileWords({ assistantName: 'Orbit', businessName: null }, 'recording');
    assert.equal(none.business, 'Be More Swan');
    assert.equal(none.greeting, null);
    assert.equal(none.poweredBy, null, 'no "Powered by Be More Swan" under "Be More Swan"');
});

// 10 units a character at size 10: width = chars × size.
const mono: Measure = (text, size) => text.length * size;

await test('fitLines: the largest size that fits on one line', () => {
    assert.deepEqual(fitLines('Marmalade', [20, 10], 200, 2, mono), { size: 20, lines: ['Marmalade'], cut: false });
});

await test('fitLines: wraps at spaces before going smaller than allowed, keeps within maxLines', () => {
    const r = fitLines('Marmalade Productions', [20, 10], 220, 2, mono);
    assert.equal(r.size, 20);
    assert.deepEqual(r.lines, ['Marmalade', 'Productions']);
    assert.ok(r.lines.every((l) => mono(l, r.size) <= 220));
});

await test('fitLines: too long even at the smallest size → cut with "…", never wider than the line', () => {
    const r = fitLines('The Northumberland Coastal Wedding Photography Company', [20, 10], 200, 2, mono);
    assert.equal(r.cut, true);
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines[1].endsWith('…'));
    assert.ok(r.lines.every((l) => mono(l, r.size) <= 200), JSON.stringify(r.lines));
});

await test('fitLines: cut at whole words — "The Northumberland Coastal…", never a word split across the cut', () => {
    const r = fitLines('The Northumberland Coastal Wedding Photography Company', [10], 200, 2, mono);
    assert.deepEqual(r.lines, ['The Northumberland', 'Coastal Wedding…']);
});

await test('the safe zone is a centred PORTRAIT 3:4 crop (a phone Meet tile), and every line is checked against it', () => {
    const src = read('src/utils/meeting-bot-tile.ts');
    assert.ok(src.includes('TILE_SAFE_WIDTH = Math.round(TILE_H * 0.75) - 60'));
    assert.ok(src.includes("if (lead + tw > TILE_SAFE_WIDTH + 1) throw new Error("));
});

await test('fitLines: one unbreakable word wider than the line is cut too', () => {
    const r = fitLines('Supercalifragilisticexpialidocious', [10], 100, 1, mono);
    assert.equal(r.cut, true);
    assert.ok(mono(r.lines[0], 10) <= 100 && r.lines[0].endsWith('…'));
});

for (const [label, names] of [
    ['Marmalade', { assistantName: 'Orbit Scribe', businessName: 'Marmalade Productions' }],
    ['a very long name', { assistantName: 'Penelope the Meeting Scribe', businessName: 'The Northumberland Coastal Wedding & Events Photography Company Ltd' }],
    ['emoji and accents', { assistantName: 'Zoë 🦢', businessName: 'Café Ñandú 🍊 & Søn' }],
    ['no names', { assistantName: null, businessName: null }],
] as const) {
    await test(`drawTile (${label}): a 1280×720 JPEG under Recall's 1.3 MB, different for each state`, async () => {
        const rec = await drawTile(names, 'recording');
        const not = await drawTile(names, 'not-recording');
        for (const jpg of [rec, not]) {
            assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
            assert.deepEqual(jpegSize(jpg), [1280, 720]);
            assert.ok(jpg.length < MAX_JPEG_BYTES);
        }
        assert.notDeepEqual(rec, not);
    });
}

await test('a different company gives a different picture', async () => {
    const a = await drawTile({ assistantName: 'Orbit', businessName: 'Marmalade Productions' }, 'recording');
    const b = await drawTile({ assistantName: 'Orbit', businessName: 'Jam Factory' }, 'recording');
    assert.notDeepEqual(a, b);
});

await test('drawBotTiles: both pictures as plain base64 (no data: prefix), as Recall takes them', async () => {
    const t = await drawBotTiles({ assistantName: 'Orbit Scribe', businessName: 'Marmalade Productions' });
    for (const b64 of [t.recordingJpegB64, t.notRecordingJpegB64]) {
        assert.ok(/^[A-Za-z0-9+/]+=*$/.test(b64));
        assert.deepEqual(jpegSize(Buffer.from(b64, 'base64')), [1280, 720]);
    }
});

// ── Characters the font can't draw (review of #800: "Łukasz" was drawn as "▯ukasz" in the call) ──────────────────

await test('the font list is right: drawn and compared with the font\'s own "missing" box', () => {
    assert.ok(GlobalFonts.register(Buffer.from(TILE_FONT_WOFF2_B64, 'base64'), 'TileTest'));
    const c = createCanvas(80, 80), ctx = c.getContext('2d');
    const snap = (ch: string) => { ctx.clearRect(0, 0, 80, 80); ctx.font = '48px TileTest'; ctx.fillStyle = '#000'; ctx.fillText(ch, 10, 60); return Buffer.from(ctx.getImageData(0, 0, 80, 80).data).toString('base64'); };
    const missing = snap('\uE000');
    for (const ch of ['a', 'Z', 'é', 'ß', 'ñ', 'ø', '&', '’', '—', '…', '€', '·']) {
        assert.equal(fontHas(ch.codePointAt(0)!), true, `${ch} listed`);
        assert.notEqual(snap(ch), missing, `${ch} really drawn`);
    }
    for (const ch of ['Ł', 'ł', 'Ž', 'ğ', 'Ж', 'Ω', '東', '🍊']) {
        assert.equal(fontHas(ch.codePointAt(0)!), false, `${ch} not listed`);
        if (ch.codePointAt(0)! < 0x3000) assert.equal(snap(ch), missing, `${ch} really missing`);
    }
});

await test('drawableName: emoji removed; a name with a letter the font lacks counts as no name', () => {
    assert.equal(drawableName('Café 🍊 & Søn', 80), 'Café & Søn');
    assert.equal(drawableName('👩🏽‍💻 Ada', 80), 'Ada');
    assert.equal(drawableName('Łukasz', 80), '');
    assert.equal(drawableName('Москва Design', 80), '');
    assert.equal(drawableName('東京デザイン', 80), '');
    assert.equal(drawableName('🦢', 80), '');
});

await test('tileWords: never a word the font can\'t draw, whatever the names', () => {
    const w = tileWords({ assistantName: 'Łucja', businessName: 'Marmalade' }, 'recording');
    assert.equal(w.greeting, "Hi, I'm the Note Taker from Marmalade");
    const ru = tileWords({ assistantName: 'Orbit', businessName: 'Москва Design' }, 'recording');
    assert.equal(ru.business, 'Be More Swan', 'company can\'t be drawn → Be More Swan\'s own tile');
    assert.equal(ru.greeting, null);
    for (const names of [
        { assistantName: 'Żółć', businessName: 'Řeka Ğüş' }, { assistantName: '東京', businessName: 'Ελλάδα' },
        { assistantName: 'Zoë 🦢', businessName: 'Café Ñandú 🍊 & Søn' }, { assistantName: '', businessName: '\u0000\u0007' },
    ]) {
        for (const state of ['recording', 'not-recording'] as const) {
            const t = tileWords(names, state);
            for (const line of [t.greeting, t.shortGreeting, t.business, t.noteTaker, ...t.status, t.poweredBy]) {
                if (line) assert.ok(canDraw(line), `${JSON.stringify(names)} → ${line}`);
            }
        }
    }
});

await test('drawTile refuses to draw a character the font lacks, and a font that didn\'t register (→ fallback)', () => {
    const src = read('src/utils/meeting-bot-tile.ts');
    assert.ok(src.includes("if (!canDraw(line)) throw new Error("), 'checked line by line before drawing');
    assert.ok(src.includes("throw new Error('tile font not registered')"), 'register() returning null is a failure');
});

await test('bundles: the drawing code and its font/swan reach ONLY the send function; canvas is never a static import', () => {
    const importers = (mod: string) => execSync(`grep -rlE "${mod}['\\"]" src netlify || true`, { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    assert.deepEqual(importers('utils/meeting-bot-tile'), ['netlify/functions/meeting-bots.ts']);
    assert.deepEqual(importers('meeting-bot-tile-assets'), ['src/utils/meeting-bot-tile.ts']);
    const src = read('src/utils/meeting-bot-tile.ts');
    assert.ok(!/^import [^t].*@napi-rs\/canvas/m.test(src), 'only a type import at the top');
    assert.ok(src.includes("await import('@napi-rs/canvas')"), 'loaded on the first picture');
    const fn = read('netlify/functions/meeting-bots.ts');
    assert.ok(fn.includes('tileFor: drawBotTiles'), 'the send function draws the workspace\'s own picture');
    assert.ok(fn.includes('videoTile: { recordingJpegB64: BOT_TILE_RECORDING_JPEG_B64'), 'with the fixed picture as the fallback');
});

await test('netlify.toml ships @napi-rs/canvas unbundled with meeting-bots (a native module)', () => {
    const toml = read('netlify.toml');
    const m = toml.match(/\[functions\.meeting-bots\]([\s\S]*?)(?=\n\[|\n#|$)/);
    assert.ok(m, '[functions.meeting-bots] block');
    assert.ok(m[1].includes('external_node_modules = ["@napi-rs/canvas"]'));
    assert.ok(m[1].includes('"node_modules/@napi-rs/canvas/**"') && m[1].includes('"node_modules/@napi-rs/canvas-*/**"'));
});

await test('sendMeetingBot: the own picture is drawn with the assistant + company names, timed out to the fallback, never fatal', () => {
    const db = read('src/utils/meeting-bot-db.ts');
    assert.ok(db.includes('name: aiAssistants.name'), 'reads the assistant\'s name');
    assert.ok(db.includes('i.tileFor({ assistantName: assistant.name ?? null, businessName: org?.name ?? null })'));
    assert.ok(db.includes('TILE_DRAW_TIMEOUT_MS'), 'a slow draw falls back');
    const call = db.indexOf('i.tileFor(');
    const send = db.indexOf('createRecallBot(region');
    assert.ok(call > 0 && send > call, 'drawn before the bot is sent');
    assert.ok(db.slice(call, send).includes('catch (err)'), 'a failed draw is caught (the fallback goes)');
    assert.ok(db.slice(send, send + 400).includes('videoTile,'), 'the picture goes in the Recall request');
});

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
})();
