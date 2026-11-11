// tests/video-own-voice.test.ts
// The owner's own voice on a Video Producer video, and filming yourself (docs/video-producer-manual-controls-plan.md
// Phase 3, 2026-11-10): line-by-line recordings (or one whole-script recording), never mixed with an AI voice,
// never charged; "Record a video" into the owner's footage.
//
// Run:  npx tsx tests/video-own-voice.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { saysSomethingElse, keepRecordings, linesToRecord, recordedDurations, isOwnVoice, LINE_GAP_S } from '../src/utils/own-voice';
import { buildTasks, readBrief } from '../src/utils/video-producer';
import type { Scene, Storyboard, VideoBrief } from '../src/lib/storyboard';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sc = (id: string, voiceover: string, o: Partial<Scene> = {}): Scene => ({ id, beat: 'value', voiceover, source: 'stock_video', targetS: 4, ...o });
const sb = (scenes: Scene[]): Storyboard => ({ title: 't', caption: 'c', scenes });

check('the brief keeps ownVoice only with a voiceover', () => {
    const a = readBrief({ message: 'Our summer roast is back for July.', ownVoice: true });
    const b = readBrief({ message: 'Our summer roast is back for July.', ownVoice: true, voiceover: false });
    assert.ok('brief' in a && a.brief.ownVoice === true && isOwnVoice(a.brief));
    assert.ok('brief' in b && b.brief.ownVoice === undefined);
});

check('in your own voice no voiceover task is held', () => {
    const board = sb([sc('s1', 'Hello there.'), sc('s2', 'Come in.'), sc('s3', 'See you soon.')]);
    const ai = { message: 'x', lengthS: 15, voiceover: true, allowAi: 'stock_only' } as unknown as VideoBrief;
    assert.ok(buildTasks(board, ai) > 0, 'an AI voice costs');
    assert.strictEqual(buildTasks(board, { ...ai, ownVoice: true }), 0, 'your voice is free');
});

check('lines to record, and a whole-script recording covers them all', () => {
    const board = sb([sc('s1', 'Hello.', { voiceAssetId: 5, voiceS: 1.2 }), sc('s2', ''), sc('s3', 'Come in.')]);
    assert.deepStrictEqual(linesToRecord(board, false).map((s) => s.id), ['s3'], 'a scene with no words needs nothing');
    assert.deepStrictEqual(linesToRecord(board, true), []);
});

check('a recording follows its line, and never comes from the model', () => {
    const before = sb([sc('s1', 'Hello.', { voiceAssetId: 5, voiceS: 1.2 }), sc('s2', 'Come in.', { voiceAssetId: 6, voiceS: 1 })]);
    const after = sb([sc('s1', 'Hello.'), sc('s2', 'Come on in!', { voiceAssetId: 999, voiceS: 9 }), sc('s3', 'New.', { voiceAssetId: 7 })]);
    const kept = keepRecordings(before, after).scenes;
    assert.deepStrictEqual([kept[0].voiceAssetId, kept[0].voiceS], [5, 1.2], 'same words → kept');
    assert.strictEqual(kept[1].voiceAssetId, undefined, 'changed words → record again (and the model’s 999 dropped)');
    assert.strictEqual(kept[2].voiceAssetId, undefined, 'a new scene has none');
    assert.strictEqual(keepRecordings(null, after).scenes.every((s) => !s.voiceAssetId), true);
});

check('a recorded line sets its scene’s length', () => {
    const d = recordedDurations([sc('s1', 'a', { voiceAssetId: 1, voiceS: 2.04 }), sc('s2', '', { targetS: 3 }), sc('s3', 'b', { voiceAssetId: 2, voiceS: 0.5 })])!;
    assert.deepStrictEqual(d, [Math.round((2.04 + LINE_GAP_S) * 10) / 10, 3, 1.5]);
    assert.strictEqual(recordedDurations([sc('s1', 'a')]), null);
});

check('“says something different” is a loose check', () => {
    assert.strictEqual(saysSomethingElse('Our summer roast is back for July', ['our', 'summer', 'roast', 'is', 'back', 'in', 'july']), false);
    assert.strictEqual(saysSomethingElse('Our summer roast is back for July', ['hello', 'world', 'testing']), true);
    assert.strictEqual(saysSomethingElse('Anything', []), false, 'no words heard is not a mismatch');
});

check('server: line and whole recordings, org-scoped, transcribed, moderated; Make the video waits', () => {
    const ov = read('src/utils/own-voice.ts');
    assert.ok(ov.includes("eq(contentAssets.organisationId, args.orgId), eq(contentAssets.assetType, 'audio'), isNull(contentAssets.purgedAt)"));
    assert.ok(ov.includes('await moderatePrompt(said)'));
    assert.ok(ov.includes("renderParams: { ...params, kind: 'voiceover', own: true,"), 'captions read it like any voiceover');
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.includes("if (action === 'set_line_voice' || action === 'set_voice_file') {"));
    assert.ok(fn.includes("if (!isOwnVoice(brief)) return json(409, { error: 'This video uses an AI voice. Choose “My own voice” first.' });"));
    assert.ok(fn.indexOf('const missing = linesToRecord(row.storyboard as Storyboard, !!row.voiceoverAssetId);') < fn.indexOf('const hold = await holdBuild('), 'checked before anything is held');
    assert.ok(fn.includes("if ((body.voiceMode === 'own' || body.voiceMode === 'ai')"), 'switching voice drops the old one');
    assert.ok(fn.includes('const storyboard = keepRecordings(sb, tightened.storyboard);'));
    assert.ok(read('netlify.toml').includes('[functions.video-projects]\n  timeout = 26'));
});

check('build: no voice made, a track per line at its scene, levelled, words on the timeline', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('if (brief.voiceover && script && !ownLines) {'));
    assert.ok(vp.includes("throw new Error('This video is in your own voice, and its recording is missing. Record it again.');"), 'never falls back to an AI voice');
    assert.ok(vp.includes('audio.push({ id: `vp_vo_${s.id}_${rec.assetId}`, assetId: lv?.assetId ?? rec.assetId,'));
    assert.ok(vp.includes('for (const w of rec.words) words.push({ start: Math.round((t + w.start) * 100) / 100'));
    assert.ok(vp.includes('storyboard = keepRecordings(current, storyboard);'), 'replans keep unchanged lines');
});

check('tab: the choice, the recording panel, WAV before upload, Make the video waits', () => {
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('name="ownVoice"'));
    assert.ok(tab.includes('data-vid-act="voice-record"') && tab.includes('data-vid-act="voice-upload"') && tab.includes('data-vid-act="voice-whole-upload"'));
    assert.ok(tab.includes("new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)"));
    assert.ok(tab.includes("assetType: 'audio', mimeType: file.type"));
    assert.ok(tab.includes('&& !needsScript && !needsRecording;'));
    assert.ok(tab.includes('Your recording says something different from this line.'));
    assert.ok(read('src/components/audio-recorder.js').includes("sc.textContent = opts.script;"), 'the line is shown as text, never HTML');
});

check('Record a video: a camera recorder into the footage flow', () => {
    const rec = read('src/components/video-recorder.js');
    assert.ok(rec.includes('window.VideoRecorder = { open, supported };'));
    assert.ok(rec.includes('stopTracks();   // releases the camera light'));
    assert.ok(read('workspace.html').includes('<script src="/src/components/video-recorder.js"></script>'));
    assert.ok(read('src/components/assistant-videos.js').includes("window.VideoRecorder.open({ shape, onDone: (file) => { if (file) addFootageFiles([file]); } });"));
});

check('chat: the switch on a card, recording status in the list, no recording by chat', () => {
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("if (ui.voiceMode === 'own' || ui.voiceMode === 'ai') body.voiceMode = ui.voiceMode;"));
    const o = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(o.includes('"voiceMode": "own" | "ai"') && o.includes("You can't record for them."));
    assert.ok(read('src/utils/video-producer.ts').includes('still to record (on the "Videos" tab)'));
});

check('help section is guarded with no semicolons in its body', () => {
    const sql = read('db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzz-video-own-voice.sql');
    assert.ok(!sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')).includes(';'));
    assert.ok(sql.includes("AND content_md NOT LIKE '%## Your own voice%'"));
});

console.log(`\n${passed} passed`);
