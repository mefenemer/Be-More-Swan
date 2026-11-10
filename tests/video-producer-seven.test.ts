// tests/video-producer-seven.test.ts
// Seven Video Producer improvements (2026-11-10): music, even loudness, audience and goal in the brief,
// script first, notes on moments of a finished video, a studio's Results tab, and other shapes / colour
// look / name captions / source files.
//
// Run:  npx tsx tests/video-producer-seven.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { TARGET_LUFS, MAX_GAIN, gainToTarget, footageLufs, mixLevels, voiceLufs, musicLufs, landedLufs, MUSIC_UNDER_DB } from '../src/lib/loudness';
import { isMusicChoice, readMusicChoice, moodFor, pickTrack, speechWindows, musicTrack, type LibraryTrack } from '../src/lib/video-music';
import { audioGainAt, duckAt, sanitiseAudioOverlays } from '../src/lib/audio-overlays';
import { lookStyle, saturation } from '../src/lib/video-look';
import { lowerThirdOverlays, readNameCaption } from '../src/lib/lower-third';
import { sceneTimes, sceneAt, addNote, readNotes, notesByScene, mergeNotedScenes, mergeScript } from '../src/lib/video-notes';
import { videoResults, turnaroundText } from '../src/lib/video-results';
import { enforceStoryboard, storyboardUserPrompt, storyboardSystemPrompt, type Storyboard, type VideoBrief } from '../src/lib/storyboard';
import { musicFromBrief, readBrief, withSetupDefaults, loopToLength, assetsForShape, shapeRoot, sceneOverlays, sceneClips, timesOf, sceneLooks, buildTasks } from '../src/utils/video-producer';
import { videoSceneRequestFromUiElement, videoSceneCard } from '../src/utils/chat-video-scene';
import { renderFailureNote } from '../src/utils/video-render';
import table from '../src/config/media-loudness.json';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const close = (a: number, b: number, eps = 0.02) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

const brief: VideoBrief = { purpose: 'promo', lengthS: 30, message: 'Our autumn menu is here this week only', voiceover: true, allowAi: 'stock_and_ai' };
const sb: Storyboard = {
    title: 'Autumn', caption: 'Come in', scenes: [
        { id: 's1', beat: 'hook', voiceover: 'Autumn is here.', source: 'stock_video', keywords: 'autumn cafe', targetS: 3 },
        { id: 's2', beat: 'value', voiceover: 'Pumpkin lattes and cinnamon buns.', onScreenText: 'New menu', source: 'ai_image', prompt: 'a latte', targetS: 6 },
        { id: 's3', beat: 'cta', voiceover: 'Pop in this week.', onScreenText: 'Pop in', source: 'brand_card', targetS: 4 },
    ],
};

// ── 2. Even loudness ────────────────────────────────────────────────────────────────────────────
check('every voice and every library track was measured, and gains aim at −14 LUFS', () => {
    const t = table as { voices: Record<string, number>; music: Record<string, number> };
    assert.ok(Object.keys(t.voices).length >= 30 && Object.keys(t.music).length === 40);
    assert.ok(Object.values(t.voices).every((v) => v < -10 && v > -45));
    assert.strictEqual(TARGET_LUFS, -14);
    close(gainToTarget(-20), 1.995, 0.01);        // +6 dB
    close(gainToTarget(-8), 0.501, 0.01);         // −6 dB
    assert.strictEqual(gainToTarget(-60), MAX_GAIN, 'a near-silent input is never pumped past +12 dB');
    close(landedLufs(-20, gainToTarget(-20)), -14, 0.1);
    assert.ok(voiceLufs('british_woman') !== null && voiceLufs('nope') === null);
    assert.ok(musicLufs(Object.keys(t.music)[0]) !== null);
});

check('footage loudness is estimated from the browser\'s RMS over the parts with sound in them', () => {
    assert.strictEqual(footageLufs([]), null);
    assert.strictEqual(footageLufs([0, 0, 0]), null);
    // RMS 0.1 (×1000 = 100) is −20 dBFS; silence is gated out.
    close(footageLufs([0, 1, 100, 100, 100, 100, 2])!, -20, 0.1);
});

check('the mix: voice to the target, the music bed under it, own sound never above its clip ceiling', () => {
    const m = mixLevels({ voice: -20, music: -12, hasVoice: true, hasOwnSound: false, hasMusic: true });
    close(m.voice, 1.995, 0.01);
    close(landedLufs(-12, m.musicUnder), TARGET_LUFS + MUSIC_UNDER_DB, 0.2);
    assert.ok(m.music > m.musicUnder, 'louder between sentences');
    const own = mixLevels({ footage: -30, music: -12, hasVoice: false, hasOwnSound: true, hasMusic: true });
    assert.strictEqual(own.ownSound, 1, 'quiet footage plays at full, never above (resolveClipGain caps at 1)');
    close(landedLufs(-12, own.musicUnder), -30 + MUSIC_UNDER_DB, 0.2);   // the bed follows where the speech landed
    const solo = mixLevels({ music: -12, hasVoice: false, hasOwnSound: false, hasMusic: true });
    close(landedLufs(-12, solo.music), TARGET_LUFS, 0.2);
});

check('a track\'s level above 1 and its duck reach the gain; nothing else changes for old tracks', () => {
    assert.strictEqual(audioGainAt({ frame: 10, durationInFrames: 100, fps: 30, volume: 1 }), 1);
    close(audioGainAt({ frame: 10, durationInFrames: 100, fps: 30, volume: 1, level: 2 }), 2);
    assert.strictEqual(audioGainAt({ frame: 10, durationInFrames: 100, fps: 30, volume: 1, level: 99 }), 4);
    const duck = { volume: 0.25, windows: [{ startS: 1, endS: 2 }] };
    close(duckAt(duck, 1.5), 0.25);
    assert.strictEqual(duckAt(duck, 0.5), 1);
    close(duckAt(duck, 0.875), 0.625);   // halfway down the ramp, before the words
    close(audioGainAt({ frame: 45, durationInFrames: 300, fps: 30, volume: 0.8, duck }), 0.2);
    const [a] = sanitiseAudioOverlays([{ assetId: 5, volume: 1, level: 2.5, duck }])!;
    assert.strictEqual(a.level, 2.5);
    assert.deepStrictEqual(a.duck, duck);
});

check('the render carries level, duck and the look through to Remotion', () => {
    const pr = read('src/lib/post-render.ts');
    assert.ok(pr.includes('...(a.level != null ? { level: a.level } : {})') && pr.includes('...(a.duck ? { duck: a.duck } : {})'));
    const comp = read('remotion/PostOverlay.tsx');
    assert.ok(comp.includes('level: a.level,') && comp.includes('duck: a.duck,'));
    assert.ok(comp.includes("mixBlendMode: 'soft-light'") && comp.includes('look && look.filter ? { filter: look.filter }'));
    assert.ok(read('src/utils/video-render.ts').includes('...(tl.look ? { look: tl.look } : {})'));
});

// ── 1. Music ────────────────────────────────────────────────────────────────────────────────────
check('the music choice: four moods, auto, or No music — old free text maps onto them', () => {
    assert.strictEqual(readMusicChoice(undefined), 'auto');
    assert.strictEqual(readMusicChoice('none'), 'none');
    assert.strictEqual(readMusicChoice('no music please'), 'none');
    assert.strictEqual(readMusicChoice('Energetic'), 'upbeat');
    assert.strictEqual(readMusicChoice('lo-fi'), 'chill');
    assert.strictEqual(moodFor({ musicMood: 'none' }), null);
    assert.strictEqual(moodFor({ musicMood: 'ambient' }), 'ambient');
    assert.strictEqual(moodFor({ musicMood: 'auto', purpose: 'tip', message: 'how to brew' }), 'chill');
    assert.strictEqual(moodFor({ purpose: 'offer', message: 'half price' }), 'upbeat');
});

check('a track is picked by mood, long enough, the same for the same video, and "another track" skips it', () => {
    const tracks: LibraryTrack[] = [
        { id: 1, title: 'A', storageKey: 'library/music/a.mp3', durationS: 20, tags: ['chill'] },
        { id: 2, title: 'B', storageKey: 'library/music/b.mp3', durationS: 120, tags: ['chill', 'lo-fi'] },
        { id: 3, title: 'C', storageKey: 'library/music/c.mp3', durationS: 120, tags: ['chill'] },
        { id: 4, title: 'D', storageKey: 'library/music/d.mp3', durationS: 120, tags: ['upbeat'] },
    ];
    const t = pickTrack(tracks, 'chill', 30, 7)!;
    assert.ok([2, 3].includes(t.id), 'long enough for a 30 s video');
    assert.strictEqual(pickTrack(tracks, 'chill', 30, 7)!.id, t.id);
    assert.notStrictEqual(pickTrack(tracks, 'chill', 30, 7, t.id)!.id, t.id);
    assert.strictEqual(pickTrack(tracks, 'upbeat', 30, 1)!.id, 4);
    assert.strictEqual(pickTrack([], 'upbeat', 30, 1), null);
});

check('the bed: bounded to the video, faded, ducked under every spoken stretch', () => {
    const w = speechWindows([{ start: 0.2, end: 0.6 }, { start: 0.7, end: 1.4 }, { start: 3, end: 3.5 }]);
    assert.deepStrictEqual(w, [{ startS: 0.05, endS: 1.55 }, { startS: 2.85, endS: 3.65 }]);
    const m = musicTrack({ assetId: 9, title: 'Sunny', durationS: 29.5, gap: 0.4, under: 0.1, windows: w });
    assert.strictEqual(m.endS, 29.5, 'an unbounded track would extend the render');
    assert.strictEqual(m.volume, 0.4);
    assert.strictEqual(m.duck!.volume, 0.25);
    const loud = musicTrack({ assetId: 9, title: 'Quiet track', durationS: 10, gap: 2, under: 0.5, windows: [] });
    assert.strictEqual(loud.volume, 1);
    assert.strictEqual(loud.level, 2);
});

check('the build lays music, levels every part, and keeps the chosen track on the storyboard', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('const mood = moodFor(brief);'));
    assert.ok(vp.includes('pickTrack(tracks, mood, totalS, projectId, brief.avoidTrackId)'));
    assert.ok(vp.includes('storyboard.music = { trackId: track.id, title: track.title, mood }'));
    assert.ok(vp.includes('audio.push(musicTrack({'));
    assert.ok(vp.includes('voiceLufs(brief.voice ?? DEFAULT_VOICE)') && vp.includes('footageLufs(footage.flatMap('));
    const ma = read('src/utils/video-music-asset.ts');
    assert.ok(ma.includes('offerableTo(usableTracks(tracks, now), { creditsEnabled: false })'), 'only tracks we may offer');
    assert.ok(ma.includes('eq(contentAssets.providerAssetId, String(args.track.id))'), 'one row per workspace per track');
});

// ── 3. Audience and goal ────────────────────────────────────────────────────────────────────────
check('the brief keeps who it\'s for, what they should do, music, look and name captions', () => {
    const r = readBrief({ message: 'Our autumn menu is here', audience: '  Busy  parents ', goal: 'Book a table', musicMood: 'none', look: 'brand', lowerThird: 'boxed' });
    assert.ok('brief' in r);
    assert.strictEqual(r.brief.audience, 'Busy parents');
    assert.strictEqual(r.brief.goal, 'Book a table');
    assert.strictEqual(r.brief.musicMood, 'none');
    assert.strictEqual(r.brief.look, 'brand');
    assert.strictEqual(r.brief.lowerThird, 'boxed');
    const d = readBrief({ message: 'Our autumn menu is here', look: 'sepia' });
    assert.ok('brief' in d && d.brief.look === 'natural' && d.brief.musicMood === 'auto' && d.brief.lowerThird === 'bar');
    const s = withSetupDefaults({}, { defaultAudience: 'Dog owners', defaultGoal: 'Call us', defaultMusic: 'chill', defaultLook: 'warm', defaultLowerThird: 'clean' });
    assert.deepStrictEqual([s.audience, s.goal, s.musicMood, s.look, s.lowerThird], ['Dog owners', 'Call us', 'chill', 'warm', 'clean']);
    assert.strictEqual(withSetupDefaults({ audience: 'Cats' }, { defaultAudience: 'Dogs' }).audience, 'Cats', 'the brief wins');
});

check('the planner is told who it\'s for and what they should do', () => {
    const p = storyboardUserPrompt({ brief: { ...brief, audience: 'Busy parents', goal: 'Book a table' }, businessName: 'Cafe', businessFacts: '', library: [], today: '2026-11-10' });
    assert.ok(p.includes("WHO IT'S FOR: Busy parents"));
    assert.ok(p.includes('WHAT THEY SHOULD DO AFTER WATCHING: Book a table'));
    assert.ok(!storyboardUserPrompt({ brief, businessName: 'Cafe', businessFacts: '', library: [], today: '2026-11-10' }).includes("WHO IT'S FOR"));
    assert.ok(storyboardSystemPrompt().includes('never invent one'));
});

check('setup asks the new defaults, and the GUI form and chat card send them', () => {
    const sch = read('src/public/assistant-onboarding-schemas.js');
    for (const k of ['defaultAudience', 'defaultGoal', 'defaultMusic', 'defaultLook', 'defaultLowerThird']) assert.ok(sch.includes(`key: '${k}'`), k);
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.includes('name="audience"') && ui.includes('name="goal"') && ui.includes('name="musicMood"') && ui.includes('name="look"') && ui.includes('name="lowerThird"'));
    assert.strictEqual((ui.match(/\.\.\.briefExtras\(fd\)/g) || []).length, 2, 'both brief forms');
    const card = read('src/components/disruptive-ui-registry.js');
    assert.ok(card.includes("...(clean(ui.audience, 200) ? { audience: clean(ui.audience, 200) } : {})"));
    assert.ok(card.includes("...(VIDEO_MUSIC[ui.musicMood] ? { musicMood: ui.musicMood } : {})"));
    assert.ok(card.includes("none: 'No music'"));
});

// ── 4. Script first ─────────────────────────────────────────────────────────────────────────────
check('a script rewrite changes words only — every scene keeps its picture and what was made for it', () => {
    const raw = { caption: 'New caption', scenes: [
        { voiceover: 'Autumn has landed.', source: 'ai_video', keywords: 'something else' },
        { voiceover: 'Lattes and buns.', onScreenText: '' },
        { voiceover: 'Come by.', onScreenText: 'Changed card words' },
    ] };
    const m = mergeScript(sb, raw);
    assert.deepStrictEqual(m.scenes.map((x) => x.voiceover), ['Autumn has landed.', 'Lattes and buns.', 'Come by.']);
    assert.deepStrictEqual(m.scenes.map(sceneLooks), sb.scenes.map(sceneLooks), 'no picture changes');
    assert.strictEqual(m.scenes[1].onScreenText, undefined);
    assert.strictEqual(m.scenes[2].onScreenText, 'Pop in', 'a branded card\'s words are drawn into it, so they stay');
    assert.strictEqual(m.caption, 'New caption');
    const p = storyboardUserPrompt({ brief, businessName: 'Cafe', businessFacts: '', library: [], today: '2026-11-10', scriptOf: sb });
    assert.ok(p.includes('REWRITE THE SCRIPT ONLY') && p.includes('Return exactly 3 scenes'));
});

check('approval survives an edit check, a changed line clears it, and Make the video waits for it', () => {
    const { storyboard } = enforceStoryboard({ ...sb, scriptApprovedAt: '2026-11-10T10:00:00Z', music: { trackId: 3, title: 'C', mood: 'chill' } }, brief);
    assert.strictEqual(storyboard.scriptApprovedAt, '2026-11-10T10:00:00Z');
    assert.deepStrictEqual(storyboard.music, { trackId: 3, title: 'C', mood: 'chill' });
    const ep = read('netlify/functions/video-projects.ts');
    assert.ok(ep.includes("if (action === 'approve_script')") && ep.includes('scriptApprovedAt: new Date().toISOString()'));
    assert.ok(ep.includes('if (voiceChanged) sb.scriptApprovedAt = null;'));
    assert.ok(ep.includes("wakeVideoWorker({ projectId: row.id, action: 'plan', feedback, mode: 'script' }"));
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.includes('Approve the script — free') && ui.includes('&& !needsScript;'));
    assert.ok(ui.includes('<p class="text-[10px] font-bold uppercase tracking-wide text-gray-400">Words</p>') && ui.includes('>Picture</p>'), 'words and pictures side by side');
});

check('a reworded line that outruns its reused clip plays the clip again — never a frame past the end', () => {
    assert.deepStrictEqual(loopToLength(undefined, 5), [{ inS: 0, outS: 5 }]);
    assert.deepStrictEqual(loopToLength(10, 5), [{ inS: 0, outS: 5 }]);
    assert.deepStrictEqual(loopToLength(4, 9), [{ inS: 0, outS: 3.95 }, { inS: 0, outS: 3.95 }, { inS: 0, outS: 1.1 }]);
    const clips = sceneClips([sb.scenes[0]], { s1: 77 }, [9], { fileS: new Map(), ownSound: false, clipS: new Map([[77, 4]]) });
    assert.deepStrictEqual(clips.map((c) => c.id), ['vp_s1_1', 'vp_s1_2', 'vp_s1_3']);
    assert.ok(clips.every((c) => (c.outS ?? 0) <= 4));
});

// ── 5. Notes on a moment ────────────────────────────────────────────────────────────────────────
check('scene times come from the timeline, and old timelines are read from their clip ids', () => {
    const times = timesOf(sb.scenes, [3, 6.5, 4]);
    assert.deepStrictEqual(times.map((t) => [t.sceneId, t.startS, t.endS]), [['s1', 0, 3], ['s2', 3, 9.5], ['s3', 9.5, 13.5]]);
    assert.deepStrictEqual(sceneTimes({ sceneTimes: times }), times);
    const old = sceneTimes({ videoEdit: { clips: [{ id: 'vp_s1', inS: 0, outS: 3 }, { id: 'vp_s2_1', inS: 1, outS: 3 }, { id: 'vp_s2_2', inS: 5, outS: 6 }, { id: 'vp_s3', holdS: 4 }] } });
    assert.deepStrictEqual(old.map((t) => [t.sceneId, t.startS, t.endS]), [['s1', 0, 3], ['s2', 3, 6], ['s3', 6, 10]]);
    assert.strictEqual(sceneAt(times, 4), 's2');
    assert.strictEqual(sceneAt(times, 99), 's3');
});

check('a note is tied to the scene playing then; notes become edits of those scenes only', () => {
    const times = timesOf(sb.scenes, [3, 6.5, 4]);
    const a = addNote([], { id: 'n1', atS: 4.27, text: ' show the cake longer ', times, by: 1, now: new Date('2026-11-10T10:00:00Z') });
    assert.ok('notes' in a);
    assert.deepStrictEqual([a.note.sceneId, a.note.atS, a.note.text], ['s2', 4.3, 'show the cake longer']);
    assert.ok('error' in addNote([], { id: 'x', atS: 1, text: '   ', times, by: 1, now: new Date() }));
    assert.deepStrictEqual(notesByScene(readNotes(a.notes)), { s2: ['show the cake longer'] });
    const merged = mergeNotedScenes(sb, { scenes: [{ voiceover: 'CHANGED' }, { voiceover: 'Lattes, slower.', source: 'stock_video', keywords: 'cake' }, { voiceover: 'CHANGED' }] }, ['s2']);
    assert.strictEqual(merged.scenes[0].voiceover, 'Autumn is here.', 'un-noted scenes are kept exactly');
    assert.strictEqual(merged.scenes[2].voiceover, 'Pop in this week.');
    assert.deepStrictEqual([merged.scenes[1].voiceover, merged.scenes[1].source, merged.scenes[1].keywords], ['Lattes, slower.', 'stock_video', 'cake']);
    const p = storyboardUserPrompt({ brief, businessName: 'Cafe', businessFacts: '', library: [], today: '2026-11-10', sceneNotes: { storyboard: sb, notes: { s2: ['show the cake longer'] } } });
    assert.ok(p.includes('CHANGE ONLY THE NOTED SCENES') && p.includes('- scene 2: "show the cake longer"'));
});

check('notes are stored on the video, move to the new version, and the planner keeps what was made', () => {
    assert.ok(read('db/z-video-producer-seven.sql').includes('ADD COLUMN IF NOT EXISTS moment_notes JSONB'));
    assert.ok(read('db/schema.ts').includes('momentNotes: jsonb("moment_notes").notNull().default([])'));
    const ep = read('netlify/functions/video-projects.ts');
    assert.ok(ep.includes("newVersion(db, row, { status: 'planning', momentNotes: notes })"));
    assert.ok(ep.includes("action: 'plan', mode: 'notes'"));
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('if (!b || sceneLooks(b) !== sceneLooks(sc)) delete assets[sc.id];'), 'only a scene whose picture changed is made again');
    assert.ok(read('netlify/functions/process-video-project-background.ts').includes("mode: body.mode === 'script' || body.mode === 'notes' ? body.mode : null"));
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.includes('data-vid-strip=') && ui.includes('Note on this moment') && ui.includes('Make a new version from my notes — free'));
});

// ── 6. Results and Calendar ─────────────────────────────────────────────────────────────────────
check('Results: videos made, made without changes, turnaround, times used', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const at = (m: number) => new Date(now.getTime() - m * 60000);
    const r = videoResults([
        { id: 1, status: 'ready', version: 1, editCount: 0, parentProjectId: null, shapeCopy: false, createdAt: at(120), readyAt: at(60) },
        { id: 2, status: 'ready', version: 1, editCount: 2, parentProjectId: null, shapeCopy: false, createdAt: at(100), readyAt: at(70) },
        { id: 3, status: 'ready', version: 1, editCount: 0, parentProjectId: null, shapeCopy: false, createdAt: at(50), readyAt: at(20) },
        { id: 4, status: 'ready', version: 2, editCount: 0, parentProjectId: 3, shapeCopy: false, createdAt: at(15), readyAt: at(5) },
        { id: 5, status: 'ready', version: 1, editCount: 0, parentProjectId: 1, shapeCopy: true, createdAt: at(30), readyAt: at(25) },
        { id: 6, status: 'planned', version: 1, editCount: 0, parentProjectId: null, shapeCopy: false, createdAt: at(10), readyAt: null },
    ], 3, now);
    assert.strictEqual(r.made, 5);
    assert.strictEqual(r.madeWithoutChanges, 0.33, '1 of 3 first versions: one edited, one changed later');
    assert.strictEqual(r.avgTurnaroundMin, Math.round((60 + 30 + 30 + 10 + 5) / 5));
    assert.strictEqual(r.timesUsed, 3);
    assert.strictEqual(videoResults([], 0, now).madeWithoutChanges, null);
    assert.strictEqual(turnaroundText(95), '1 h 35 min');
});

check('the Results tab reads the studio figures; the Calendar shows videos, not posting days', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    const vpEntry = reg.slice(reg.indexOf('    video_producer: {'), reg.indexOf('    website_assistant: {'));
    assert.ok(vpEntry.includes("metricsSource: 'video'") && vpEntry.includes("calendarItems: 'videos'"));
    for (const k of ['Videos Made', 'Made Without Changes', 'Average Turnaround', 'Times Used']) assert.ok(vpEntry.includes(`label: '${k}'`), k);
    assert.ok(!vpEntry.includes('Engagement Rate by Reach'));
    const as = read('assistants.js');
    assert.ok(as.includes("if (source === 'video') {") && as.includes('async function _loadVideoMetrics(assistantId)'));
    const cal = read('calendar.js');
    assert.ok(cal.includes("if (t.datedSource === 'videos') {") && cal.includes("video_ready:    { icon: '✅', label: 'Video finished' }"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(!orch.includes('your videos on their posting days'));
    assert.ok(orch.includes('"Calendar" tab — each video on the day it was started and the day it was finished.'));
    const ep = read('netlify/functions/video-projects.ts');
    assert.ok(ep.includes('if (qs.performance) {') && ep.includes('if (qs.calendar) {'));
    assert.ok(read('src/utils/video-producer.ts').includes('blogPostAssets'), 'articles count as uses');
});

// ── 7. Shapes, look, name captions, source files ────────────────────────────────────────────────
check('another shape keeps the voiceover, own footage and paid AI scenes; free stock and cards are remade', () => {
    const kept = assetsForShape(sb, { s1: 11, s2: 12, s3: 13 });
    assert.deepStrictEqual(kept, { s2: 12 });
    assert.strictEqual(buildTasks(sb, { ...brief, shape: '1:1' }, { sceneAssets: kept, voiceoverAssetId: 99 }), 0, 'so it costs nothing');
    assert.strictEqual(shapeRoot({ id: 9, brief: { shapeOf: 4 } }), 4);
    assert.strictEqual(shapeRoot({ id: 9, brief: {} }), 9);
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes("status: free ? 'building' : 'planned'"), 'starts making only when free');
    assert.ok(read('src/components/assistant-videos.js').includes('data-vid-act="reshape"'));
});

check('a colour look: brand tint from the kit (never a grey), fixed grades, natural = nothing', () => {
    assert.strictEqual(lookStyle('natural'), null);
    assert.strictEqual(lookStyle('nonsense'), null);
    assert.deepStrictEqual(lookStyle('brand', ['#ff007f']), { filter: 'contrast(1.06) saturate(1.05)', tint: '#ff007f', tintOpacity: 0.18 });
    assert.strictEqual(lookStyle('brand', ['#1f1e1b'])!.tint, undefined, 'a near-black brand colour makes no wash');
    assert.ok(saturation('#ff0000') > 0.9 && saturation('#808080') === 0);
    assert.ok(lookStyle('mono')!.filter!.includes('grayscale(1)'));
});

check('name captions: three styles, clear of the captions, timed to the scene, never invented', () => {
    assert.deepStrictEqual(readNameCaption({ name: ' Sarah  Jones ', role: 'Owner' }), { name: 'Sarah Jones', role: 'Owner' });
    assert.strictEqual(readNameCaption({ name: '' }), null);
    const ov = lowerThirdOverlays({ id: 'lt', caption: { name: 'Sarah Jones', role: 'Owner' }, startS: 3, d: 6, style: 'bar', accent: '#ff007f', aspect: 9 / 16 });
    assert.strictEqual(ov.length, 2);
    assert.deepStrictEqual([ov[0].startS, ov[0].endS, ov[0].boxFill, ov[0].y], [3.3, 7.3, '#ff007f', 0.6]);
    assert.ok(ov[0].x < 0.5 && ov[0].x > 0.06, 'left-aligned by its centre');
    assert.strictEqual(lowerThirdOverlays({ id: 'lt', caption: { name: 'S' }, startS: 0, d: 4, style: 'boxed', aspect: 1, captionPosition: 'top' })[0].x, 0.5);
    assert.strictEqual(lowerThirdOverlays({ id: 'lt', caption: { name: 'S' }, startS: 0, d: 4, style: 'clean', aspect: 1, captionPosition: 'top' })[0].y, 0.8);
    const scenes = [{ ...sb.scenes[0], nameCaption: { name: 'Sarah' } }];
    assert.ok(sceneOverlays(scenes, [3], 'bottom', { style: 'bar', accent: '#ff007f', aspect: 9 / 16 }).some((o) => o.id === 'vp_lt_s1_name'));
    assert.ok(!sceneOverlays(scenes, [3]).some((o) => o.id.startsWith('vp_lt_')), 'old callers unchanged');
    const { storyboard } = enforceStoryboard({ scenes: [{ beat: 'hook', voiceover: 'Hi', source: 'stock_video', nameCaption: { name: 'Sarah', role: 'Owner' } }, { voiceover: 'a' }, { voiceover: 'b' }] }, brief);
    assert.deepStrictEqual(storyboard.scenes[0].nameCaption, { name: 'Sarah', role: 'Owner' });
});

check('a chat scene card can set or clear a name caption', () => {
    const req = videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 3, scene: 1, nameCaption: { name: 'Sarah', role: 'Owner' } })!;
    const card = videoSceneCard(req, sb)!;
    assert.deepStrictEqual(card.patch, { nameCaption: { name: 'Sarah', role: 'Owner' } });
    const off = videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 3, scene: 1, nameCaption: null })!;
    assert.strictEqual(videoSceneCard(off, sb), null, 'nothing to take off');
    assert.deepStrictEqual(videoSceneCard(off, { ...sb, scenes: [{ ...sb.scenes[0], nameCaption: { name: 'X' } }] })!.patch, { nameCaption: null });
});

check('each version lists the files it was made from', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('sourceAssetIds: [...new Set([...clips.map((c) => c.assetId), ...audio.map((a) => a.assetId)])]'));
    assert.ok(vp.includes('export async function sourceFilesOf('));
    assert.ok(read('src/utils/video-render.ts').includes('sourceAssetIds: tl.sourceAssetIds ?? []'));
    assert.ok(read('src/components/assistant-videos.js').includes('Source files for this version'));
});

// ── Every capability in chat, proposed on a card, never spending ────────────────────────────────
check('chat cards exist for each new action, and the chat can only send those actions', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    for (const t of ['video_script_proposal', 'video_options_proposal', 'video_note_proposal', 'video_notes_version_proposal', 'video_reshape_proposal']) {
        assert.ok(reg.includes(`register('${t}'`), t);
        assert.ok(read('netlify/functions/chat-orchestrator.ts').includes(`"type": "${t}"`), `the prompt teaches ${t}`);
    }
    const cs = read('src/components/chat-session.js');
    assert.ok(cs.includes("const VIDEO_CARD_ACTIONS = ['approve_script', 'rewrite_script', 'set_options', 'add_note', 'notes_to_version', 'reshape'];"));
    assert.ok(!cs.slice(cs.indexOf('VIDEO_CARD_ACTIONS')).slice(0, 300).includes("'build'"), 'no card can make (spend on) a video');
    const snap = read('src/utils/video-producer.ts');
    assert.ok(snap.includes("' · script APPROVED'") && snap.includes('their note at ${mmss(n.atS)}'));
});

// ── A track of the owner's own, and a missing file never costs the video (staging test, 2026-11-10) ──
check('"A track from My Content" needs a track id; a mood clears it', () => {
    assert.ok(isMusicChoice('mine'));
    assert.deepStrictEqual(musicFromBrief('mine', 42), { musicMood: 'mine', musicAssetId: 42 });
    assert.deepStrictEqual(musicFromBrief('mine', null), { musicMood: 'auto' }, 'no track → auto');
    assert.deepStrictEqual(musicFromBrief('mine', -3), { musicMood: 'auto' });
    assert.deepStrictEqual(musicFromBrief('upbeat', 42), { musicMood: 'upbeat' }, 'the id only counts with mine');
    assert.strictEqual(moodFor({ musicMood: 'mine', message: 'grand opening' }), null, 'the owner\'s track, not a library mood');
    const r = readBrief({ message: 'Our new studio is open', musicMood: 'mine', musicAssetId: 7 });
    assert.ok('brief' in r && r.brief.musicMood === 'mine' && r.brief.musicAssetId === 7);
});

check('the build checks a track\'s file is there, and uses the owner\'s own track org-scoped', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.match(vp, /if \(track && await storedFileExists\(track\.storageKey\)\)/, 'a library track with no file is left out');
    assert.match(vp, /ownMusicTrack\(db, orgId, brief\.musicAssetId\)/);
    assert.ok(vp.includes('musicNote'), 'the version says why it has no music');
    const asset = read('src/utils/video-music-asset.ts');
    assert.ok(asset.includes("<> ${LIBRARY_PROVIDER}") && asset.includes("->>'kind', '') <> 'voiceover'"), 'never a library row, voiceover or caption track');
    assert.ok(asset.includes('eq(contentAssets.organisationId, orgId)'));
});

check('a failed render can change its music and be made again; its note carries no links', () => {
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.includes("['planned', 'failed', 'render_failed'].includes(row.status)"), 'set_options on a failed render');
    assert.ok(fn.includes("row.status === 'render_failed' ? { status: 'planned', note: null }"), 'back to "Make the video" (free: all made)');
    assert.ok(fn.includes("That track isn’t in your My Content."));
    const url = 'Error while downloading https://bucket.r2.cloudflarestorage.com/library/music/b86d.mp3?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';
    const note = renderFailureNote(url);
    assert.ok(!/https?:/.test(note) && note.includes('the music couldn’t be downloaded'), note);
    assert.ok(renderFailureNote('Error while downloading https://x/content/org-1/voice.mp3?sig=1').includes('one of its sound files'));
    assert.ok(!renderFailureNote('Something broke at https://x/y?z=1').includes('https'));
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.includes("['mine', 'A track from My Content']") && ui.includes('?tracks=1'));
    assert.ok(ui.includes('overflow-wrap:anywhere'), 'a long note wraps inside its box');
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('body.musicAssetId = trackId'), 'chat can propose a track too');
});

console.log(`\nvideo producer seven: ${passed} passed`);
