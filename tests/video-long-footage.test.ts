// tests/video-long-footage.test.ts
// Phase 4b (docs/video-producer-screen-walkthrough-plan.md §12): 2, 5 and 10-minute videos from the owner's own
// footage in its own sound. Long lengths only there; up to 20 scenes; never past the render's 10 minutes; footage
// up to 10 minutes; 200 pieces; music looped under a long video; the form, chat card and planner follow.
//
// Run:  npx tsx tests/video-long-footage.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    enforceStoryboard, capTotalLength, isVideoLength, isLongLength, allowsLongLength, maxScenesFor, lengthLabel,
    storyboardUserPrompt, MAX_VIDEO_S, MAX_SCENES, MAX_LONG_SCENES, type VideoBrief, type Scene,
} from '../src/lib/storyboard';
import { readBrief } from '../src/utils/video-producer';
import { musicTracks, MUSIC_LOOP_XFADE_S } from '../src/lib/video-music';
import { MAX_FOOTAGE_S, MAX_PROJECT_CLIPS, transcriptText } from '../src/lib/footage';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const brief = (o: Partial<VideoBrief> = {}): VideoBrief => ({ purpose: 'walkthrough', lengthS: 600, message: 'A tour of our booking system', voiceover: false, allowAi: 'stock_only', footageAssetIds: [7], ...o });
const own = (o: Record<string, unknown>) => ({ beat: 'value', voiceover: '', source: 'own_video', assetId: 7, targetS: 30, ...o });

console.log('lengths');

check('2, 5 and 10 minutes are lengths; only own footage in its own sound with no presenter may use them', () => {
    for (const n of [15, 30, 60, 120, 300, 600]) assert.ok(isVideoLength(n), String(n));
    for (const n of [45, 90, 900]) assert.ok(!isVideoLength(n), String(n));
    assert.ok(isLongLength(600) && !isLongLength(60));
    assert.ok(allowsLongLength({ voiceover: false, footageAssetIds: [1] }));
    assert.ok(!allowsLongLength({ voiceover: true, footageAssetIds: [1] }), 'a voiceover needs the AI voice (4c)');
    assert.ok(!allowsLongLength({ voiceover: false, footageAssetIds: [] }), 'stock videos stay short');
    assert.ok(!allowsLongLength({ voiceover: false, footageAssetIds: [1], presenter: { id: 'amara' } }));
    assert.strictEqual(lengthLabel(600), '10 minutes');
    assert.strictEqual(lengthLabel(30), '30 seconds');
});

check('readBrief keeps a long length only for own sound; anything else becomes 60 s', () => {
    const ok = (b: Record<string, unknown>) => { const r = readBrief({ message: 'A tour of our booking system', ...b }); assert.ok('brief' in r); return r.brief; };
    assert.strictEqual(ok({ lengthS: 600, voiceover: false, footageAssetIds: [7] }).lengthS, 600);
    assert.strictEqual(ok({ lengthS: 300, voiceover: true, footageAssetIds: [7] }).lengthS, 60);
    assert.strictEqual(ok({ lengthS: 120 }).lengthS, 60, 'a script video with no footage');
    assert.strictEqual(ok({ lengthS: 30, voiceover: false, footageAssetIds: [7] }).lengthS, 30);
});

console.log('scenes and the 10-minute ceiling');

check('a long video keeps up to 20 scenes; a short one 8', () => {
    assert.strictEqual(maxScenesFor({ lengthS: 600 }), MAX_LONG_SCENES);
    assert.strictEqual(maxScenesFor({ lengthS: 60 }), MAX_SCENES);
    const scenes = Array.from({ length: 24 }, (_, i) => own({ inS: i * 25, outS: i * 25 + 24, targetS: 24 }));
    const long = enforceStoryboard({ title: 'T', caption: 'C', scenes }, brief(), [], [{ id: 7, name: 'take', durationS: 600 }]);
    assert.strictEqual(long.storyboard.scenes.length, 20);
    const short = enforceStoryboard({ title: 'T', caption: 'C', scenes }, brief({ lengthS: 60 }), [], [{ id: 7, name: 'take', durationS: 600 }]);
    assert.ok(short.storyboard.scenes.length <= MAX_SCENES);
});

check('never past 10 minutes: scenes before the last are dropped first, then the last clip is shortened', () => {
    const s = (targetS: number, o: Partial<Scene> = {}): Scene => ({ id: 'x', beat: 'value', voiceover: '', source: 'own_video', assetId: 7, inS: 0, outS: targetS, targetS, ...o });
    const changes: string[] = [];
    const out = capTotalLength([s(200), s(200), s(200), s(100), s(10, { source: 'brand_card', assetId: undefined, inS: undefined, outS: undefined })], changes);
    assert.ok(out.reduce((a, x) => a + x.targetS, 0) <= MAX_VIDEO_S + 0.05);
    assert.strictEqual(out[out.length - 1].source, 'brand_card', 'the call to action stays');
    assert.match(changes[0], /at most 10 minutes/);
    // One scene alone too long: its end is cut (pieces kept up to the limit).
    const one = capTotalLength([s(700, { cuts: [{ inS: 0, outS: 400 }, { inS: 401, outS: 701 }] })], []);
    assert.strictEqual(one[0].targetS, 600);
    assert.deepStrictEqual(one[0].cuts, [{ inS: 0, outS: 400 }, { inS: 401, outS: 601 }]);
    assert.strictEqual(one[0].outS, 601);
    // Inside the limit: untouched.
    const fine = [s(300), s(200)];
    assert.strictEqual(capTotalLength(fine, []), fine);
});

check('a long length is a ceiling: less footage than the length never stretches a card or stock scene (review of #749)', () => {
    const card = { beat: 'cta', voiceover: '', source: 'brand_card', targetS: 5 };
    const footage = [{ id: 7, name: 'take', durationS: 600 }];
    for (const [lengthS, scenes] of [
        [600, [own({ inS: 0, outS: 120, targetS: 120 }), own({ inS: 120, outS: 240, targetS: 120 }), card]],
        [600, [own({ inS: 0, outS: 20, targetS: 20 }), card]],
        [120, [own({ inS: 0, outS: 20, targetS: 20 }), card]],
    ] as const) {
        const sb = enforceStoryboard({ title: 'T', caption: 'C', scenes }, brief({ lengthS: lengthS as never }), [], footage).storyboard;
        const last = sb.scenes[sb.scenes.length - 1];
        assert.strictEqual(last.source, 'brand_card');
        assert.ok(last.targetS <= 15, `${lengthS} s brief: the card came back at ${last.targetS} s`);
    }
    // A card the planner made too long is brought down to 15 s.
    const sb = enforceStoryboard({ title: 'T', caption: 'C', scenes: [own({ inS: 0, outS: 300, targetS: 300 }), { ...card, targetS: 90 }] }, brief(), [], footage).storyboard;
    assert.strictEqual(sb.scenes[1].targetS, 15);
    // Short videos keep filling their length as before.
    const short = enforceStoryboard({ title: 'T', caption: 'C', scenes: [own({ inS: 0, outS: 20, targetS: 20 }), card] }, brief({ lengthS: 30 }), [], footage).storyboard;
    assert.ok(short.scenes[1].targetS > 5);
});

check('long videos read "10 min", not "600s"; every word Edit the words shows can be struck', () => {
    assert.match(read('src/components/assistant-videos.js'), /const lengthShort = \(n\) => \(Number\(n\) >= 120 \? `\$\{Number\(n\) \/ 60\} min` : `\$\{n\}s`\);/);
    assert.match(read('src/utils/video-producer.ts'), /brief\.lengthS >= 120 \? `\$\{brief\.lengthS \/ 60\} min`/);
    assert.match(read('src/lib/storyboard.ts'), /for \(const w of raw\.slice\(0, 2000\)\)/);
    assert.match(read('netlify/functions/video-projects.ts'), /\.slice\(0, 2000\)/);
});

check('the help SQL sorts after the video articles whose lines it replaces (review of #749)', () => {
    const files = readdirSync(join(root, 'db')).filter((f) => f.startsWith('help-articles-')).sort();
    const mine = files.findIndex((f) => f.endsWith('-video-long-own-footage.sql'));
    assert.ok(mine >= 0);
    for (const dep of ['-video-producer.sql', '-video-screen-recordings.sql']) {
        const i = files.findIndex((f) => f.endsWith(dep));
        assert.ok(i >= 0 && i < mine, `${dep} must come first`);
    }
});

check('the planner is told a long video is in chapters, and is given room to write 20 scenes', () => {
    const p = storyboardUserPrompt({ brief: brief(), businessName: 'B', library: [], today: '2026-11-18', footageBlock: 'FOOTAGE' } as never);
    assert.match(p, /a 10 minutes walkthrough video \(600 seconds at most, never more\), 2–20 scenes/);
    assert.match(p, /told in CHAPTERS/);
    const vp = read('src/utils/video-producer.ts');
    assert.match(vp, /maxTokens: isLongLength\(brief\.lengthS\) \? 8000 : 2500,/);
});

console.log('footage, pieces and music');

check('footage up to 10 minutes on the server and in the browser; 200 pieces; the transcript holds 10 minutes', () => {
    assert.strictEqual(MAX_FOOTAGE_S, 600);
    assert.match(read('src/components/footage-reader.js'), /const MAX_S = 10 \* 60;/);
    assert.strictEqual(MAX_PROJECT_CLIPS, 200);
    assert.match(read('src/lib/footage.ts'), /capPieces\(tight\.map\(\(t\) => t\.pieces\), MAX_PROJECT_CLIPS, fixedCount\)/);
    const words = Array.from({ length: 1500 }, (_, i) => ({ word: 'word', start: i * 0.4, end: i * 0.4 + 0.3 }));
    assert.ok(transcriptText(words).length > 6000, 'a 10-minute talker is not cut at 6000 characters');
});

check('music shorter than the video loops, each pass faded across, duck windows on each pass\'s own clock', () => {
    const base = { assetId: 5, title: 'Calm', durationS: 400, gap: 0.5, under: 0.2, windows: [{ startS: 10, endS: 20 }, { startS: 185, endS: 200 }] };
    const passes = musicTracks({ ...base, trackS: 190 });
    assert.strictEqual(passes.length, 3);
    assert.deepStrictEqual(passes.map((p) => [p.startS, p.endS]), [[0, 190], [188, 378], [376, 400]]);
    assert.strictEqual(passes[0].id, 'vp_music_5');
    assert.strictEqual(passes[1].fadeInS, MUSIC_LOOP_XFADE_S);
    assert.strictEqual(passes[0].fadeOutS, MUSIC_LOOP_XFADE_S);
    assert.strictEqual(passes[2].fadeOutS, 1.5, 'the last pass ends as a single track does');
    // The window at 185–200 s lands on pass 1 (its end clipped) and on pass 2 at 0–12 s.
    assert.deepStrictEqual(passes[0].duck?.windows, [{ startS: 10, endS: 20 }, { startS: 185, endS: 190 }]);
    assert.deepStrictEqual(passes[1].duck?.windows, [{ startS: 0, endS: 12 }]);
    // Long enough, or of unknown length: one track, as before.
    assert.strictEqual(musicTracks({ ...base, trackS: 500 }).length, 1);
    assert.strictEqual(musicTracks({ ...base, trackS: null }).length, 1);
});

console.log('form and chat');

check('the footage form offers 2, 5 and 10 minutes, closed unless "Keep the sound in my videos"', () => {
    const v = read('src/components/assistant-videos.js');
    assert.match(v, /const FOOTAGE_LENGTHS = \['15', '30', '60', \.\.\.LONG_LENGTHS\];/);
    assert.match(v, /if \(t && t\.name === 'sound' && host\(\) && host\(\)\.contains\(t\) && t\.form\) paintLongLengths\(t\.form\);/);
    assert.match(v, /if \(!own && LONG_LENGTHS\.includes\(select\.value\)\) select\.value = '60';/);
    assert.match(v, /v\.durationS > 600 \? 'Over 10 minutes'/);
});

check('the chat footage card carries a long length only in own sound, and the chat says when long is possible', () => {
    const r = read('src/components/disruptive-ui-registry.js');
    assert.match(r, /\[120, 300, 600\]\.includes\(Number\(ui\.lengthS\)\) && ui\.voiceover !== true/);
    const c = read('netlify/functions/chat-orchestrator.ts');
    assert.match(c, /except from their OWN FOOTAGE in its own sound, or an AI PRESENTER walking through their screen recordings: those can be 2, 5 or 10 minutes/);
    assert.match(c, /"lengthS": 15 \| 30 \| 60 \| 120 \| 300 \| 600, "voiceover": true \| false/);
});

console.log(`\n${passed} checks passed.`);
