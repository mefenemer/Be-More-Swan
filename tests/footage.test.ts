// tests/footage.test.ts
// The Video Producer reviewing the owner's own footage (docs/video-producer-footage-and-ai-plan.md §4):
// own_video scenes in the storyboard, the shot-list and review rules, the timeline and captions for
// footage in its own sound, and the wiring that keeps the review a paid, ticked, browser-read step.
//
// Run:  npx tsx tests/footage.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { enforceStoryboard, fitLength, clampSegment, keepsOwnSound, minScenesFor, storyboardUserPrompt, type VideoBrief, type Scene } from '../src/lib/storyboard';
import {
    enforceShotList, enforceReview, reviewSystemPrompt, frameTimes, ownSpeechOnTimeline, silentWav, quoteIsInTranscript, suggestionLine,
    footagePlannerBlock, MAX_FRAMES, MAX_SUGGESTIONS, FOOTAGE_REVIEW_TASKS, type FootageVideo,
} from '../src/lib/footage';
import { ownWindow, sceneClips, playedDurations, readFootageIds, readBrief, livePieces } from '../src/utils/video-producer';
import { tightenSegment, tightenStoryboard, retakeIndexes, isFiller, capPieces, describeTightening, MAX_PAUSE_S, loudSeconds, restoreLoudGaps } from '../src/lib/footage';
import { MAX_CLIPS } from '../src/lib/video-edit';
import { TASK_WEIGHTS } from '../src/config/task-weights';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const brief = (o: Partial<VideoBrief> = {}): VideoBrief => ({ purpose: 'promo', lengthS: 30, message: 'Autumn menu is here', voiceover: true, allowAi: 'stock_and_ai', footageAssetIds: [11, 12], ...o });
const own = [{ id: 11, name: 'kitchen.mp4', durationS: 20 }, { id: 12, name: 'latte.mov', durationS: 6 }];
const sc = (o: Record<string, unknown> = {}) => ({ beat: 'value', voiceover: 'one two three four five', source: 'own_video', assetId: 11, inS: 2, outS: 8, targetS: 6, ...o });
const raw = (scenes: Array<Record<string, unknown>>) => ({ title: 'T', caption: 'C', scenes });

// ── Phase 1: own_video scenes ───────────────────────────────────────────────────────────────────

check('an own_video scene keeps its video and segment', () => {
    const { storyboard } = enforceStoryboard(raw([sc(), sc({ inS: 10, outS: 15 }), sc({ assetId: 12, inS: 0, outS: 4 })]), brief(), [], own);
    const s = storyboard.scenes[0];
    assert.strictEqual(s.source, 'own_video');
    assert.strictEqual(s.assetId, 11);
    assert.deepStrictEqual([s.inS, s.outS], [2, 8]);
});

check('a video the owner did NOT choose becomes stock — never someone else\'s asset id', () => {
    const { storyboard, changes } = enforceStoryboard(raw([sc({ assetId: 999 }), sc(), sc()]), brief(), [], own);
    assert.strictEqual(storyboard.scenes[0].source, 'stock_video');
    assert.strictEqual(storyboard.scenes[0].assetId, undefined);
    assert.ok(changes.some((c) => /isn't one of the videos you chose/.test(c)));
});

check('an own video in the library but not chosen for THIS video is refused too', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ assetId: 12 }), sc(), sc()]), brief({ footageAssetIds: [11] }), [], own);
    assert.strictEqual(storyboard.scenes[0].source, 'stock_video');
});

check('a segment past the end of the file is clamped to the MEASURED length', () => {
    const { storyboard, changes } = enforceStoryboard(raw([sc({ assetId: 12, inS: 4, outS: 30 }), sc(), sc()]), brief(), [], own);
    assert.ok(storyboard.scenes[0].outS! <= 6);
    assert.ok(storyboard.scenes[0].inS! < storyboard.scenes[0].outS!);
    assert.ok(changes.some((c) => /moved to fit/.test(c)));
});

check('clampSegment: order, bounds, a minimum length, and null for a file too short', () => {
    assert.deepStrictEqual(clampSegment(8, 2, 20), { inS: 2, outS: 8 });
    assert.deepStrictEqual(clampSegment(-5, 3, 20), { inS: 0, outS: 3 });
    const tiny = clampSegment(19.9, 20, 20)!;
    assert.ok(tiny.outS - tiny.inS >= 0.79 && tiny.outS <= 20);
    assert.strictEqual(clampSegment(0, 1, 0.5), null);
    assert.deepStrictEqual(clampSegment('x', undefined, 10), { inS: 0, outS: 10 });
});

check('own sound: each own scene IS its segment, and fitLength never stretches it', () => {
    const b = brief({ voiceover: false, lengthS: 15 });
    assert.ok(keepsOwnSound(b));
    const { storyboard } = enforceStoryboard(raw([sc({ inS: 0, outS: 2, voiceover: '' }), sc({ inS: 5, outS: 9, voiceover: '' }), sc({ source: 'brand_card', voiceover: '', targetS: 3 })]), b, [], own);
    assert.strictEqual(storyboard.scenes[0].targetS, 2);
    assert.strictEqual(storyboard.scenes[1].targetS, 4);
    // Only the card took up the difference to 15 s.
    assert.ok(Math.abs(storyboard.scenes[2].targetS - 9) < 0.2);
});

check('fitLength with fixed scenes: a fixed hook over 3 s is NOT cut (mid-sentence is worse)', () => {
    const scenes: Scene[] = [
        { id: 's1', beat: 'hook', voiceover: '', source: 'own_video', targetS: 5 },
        { id: 's2', beat: 'value', voiceover: '', source: 'stock_video', targetS: 5 },
        { id: 's3', beat: 'cta', voiceover: '', source: 'brand_card', targetS: 5 },
    ];
    const out = fitLength(scenes, 15, [], (s) => s.source === 'own_video');
    assert.strictEqual(out[0].targetS, 5);
});

check('with a voiceover, own scenes are timed like any other (the voice sets the cut)', () => {
    assert.ok(!keepsOwnSound(brief({ voiceover: true })));
    assert.ok(!keepsOwnSound(brief({ voiceover: false, footageAssetIds: [] })));
});

check('the planner prompt carries the footage, the ticked edits and the turned-down ones', () => {
    const p = storyboardUserPrompt({
        brief: brief({ voiceover: false }), businessName: 'Cafe', businessFacts: '', library: [], today: '2026-11-09',
        footageBlock: 'THE OWNER\'S OWN FOOTAGE …', acceptedEdits: ['Cut 0:12–0:19'], declinedEdits: ['Add music'],
    });
    assert.ok(p.includes('THE OWNER\'S OWN FOOTAGE'));
    assert.ok(/ACCEPTED[\s\S]*Cut 0:12–0:19/.test(p));
    assert.ok(/TURNED DOWN[\s\S]*Add music/.test(p));
    assert.ok(/OWN sound/.test(p));
});

check('a footage video may be one take plus a card (staging 2026-11-09: the 3-scene rule failed it)', () => {
    const { storyboard, changes } = enforceStoryboard(raw([sc({ inS: 0, outS: 25, voiceover: '' }), sc({ source: 'brand_card', voiceover: '', targetS: 3 })]), brief({ voiceover: false }), [], own);
    assert.strictEqual(storyboard.scenes.length, 2);
    assert.ok(!changes.some((c) => /needs at least/.test(c)));
    assert.strictEqual(minScenesFor(brief({ footageAssetIds: [] })), 3);
    assert.ok(read('src/utils/video-producer.ts').includes('scenes.length < minScenesFor(brief)'));
    const p = reviewSystemPrompt();
    assert.ok(/never over someone speaking/.test(p) && /crop and reframe/.test(p));
});

check('readBrief keeps up to 10 unique own video ids', () => {
    assert.deepStrictEqual(readFootageIds([3, '3', 4, -1, 'x', 0, 5.5]), [3, 4]);
    assert.strictEqual(readFootageIds(Array.from({ length: 20 }, (_, i) => i + 1)).length, 10);
    const r = readBrief({ message: 'A video about our menu', footageAssetIds: [7] });
    assert.ok('brief' in r && r.brief.footageAssetIds?.[0] === 7);
    const r2 = readBrief({ message: 'A video about our menu' });
    assert.ok('brief' in r2 && r2.brief.footageAssetIds === undefined);
});

// ── The timeline ────────────────────────────────────────────────────────────────────────────────

check('ownWindow: never past the end of the file, shifts earlier when the voice runs long', () => {
    assert.deepStrictEqual(ownWindow(2, 4, 20), { inS: 2, outS: 6 });
    assert.deepStrictEqual(ownWindow(18, 5, 20), { inS: 15, outS: 20 });
    assert.deepStrictEqual(ownWindow(1, 9, 6), { inS: 0, outS: 6 });
});

check('sceneClips: own clips get explicit gain; stock is silenced only in own sound', () => {
    const scenes: Scene[] = [
        { id: 's1', beat: 'hook', voiceover: '', source: 'own_video', assetId: 11, inS: 2, outS: 6, targetS: 4 },
        { id: 's2', beat: 'value', voiceover: '', source: 'stock_video', targetS: 3 },
        { id: 's3', beat: 'cta', voiceover: '', source: 'brand_card', targetS: 3 },
    ];
    const ids = { s1: 11, s2: 50, s3: 60 };
    const fileS = new Map([[11, 20]]);
    const ownSound = sceneClips(scenes, ids, [4, 3, 3], { fileS, ownSound: true });
    assert.deepStrictEqual([ownSound[0].inS, ownSound[0].outS, ownSound[0].gain], [2, 6, 1]);
    assert.strictEqual(ownSound[1].gain, 0);
    assert.strictEqual(ownSound[2].kind, 'image');
    const voiced = sceneClips(scenes, ids, [4, 3, 3], { fileS, ownSound: false });
    assert.strictEqual(voiced[0].gain, 0);
    assert.strictEqual(voiced[1].gain, undefined);
});

check('playedDurations: a scene is never longer than its own video', () => {
    const scenes: Scene[] = [{ id: 's1', beat: 'hook', voiceover: 'x', source: 'own_video', assetId: 12, targetS: 3 }, { id: 's2', beat: 'cta', voiceover: 'y', source: 'stock_video', targetS: 3 }];
    assert.deepStrictEqual(playedDurations(scenes, [9, 9], new Map([[12, 6]])), [6, 9]);
});

check('ownSpeechOnTimeline: words inside the played part move onto the timeline', () => {
    const scenes: Scene[] = [
        { id: 's1', beat: 'hook', voiceover: '', source: 'brand_card', targetS: 2 },
        { id: 's2', beat: 'value', voiceover: '', source: 'own_video', assetId: 11, inS: 10, outS: 13, targetS: 3 },
    ];
    const words = new Map([[11, [{ word: 'before', start: 9, end: 9.5 }, { word: 'hello', start: 10.2, end: 10.6 }, { word: 'there', start: 12.5, end: 12.9 }, { word: 'after', start: 13.5, end: 14 }]]]);
    const out = ownSpeechOnTimeline(scenes, [2, 3], words);
    assert.deepStrictEqual(out.map((w) => w.word), ['hello', 'there']);
    assert.deepStrictEqual([out[0].start, out[0].end], [2.2, 2.6]);
});

check('silentWav is a valid 8-bit mono WAV of silence', () => {
    const b = silentWav(1);
    assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(b.toString('ascii', 8, 12), 'WAVE');
    assert.strictEqual(b.readUInt32LE(24), 8000);
    assert.strictEqual(b.length, 44 + 8000);
    assert.strictEqual(b[100], 128);
});

// ── Phase 2–3: frames, shot lists, the review ───────────────────────────────────────────────────

check('frameTimes: about every 2 s, at most 40, all inside the video — and the browser uses the same rule', () => {
    assert.strictEqual(frameTimes(10).length, 5);
    assert.strictEqual(frameTimes(300).length, MAX_FRAMES);
    assert.ok(frameTimes(300).every((t) => t > 0 && t < 300));
    assert.deepStrictEqual(frameTimes(0), []);
    const js = read('src/components/footage-reader.js');
    assert.ok(js.includes('const MAX_FRAMES = 40;') && js.includes('const FRAME_EVERY_S = 2;'));
});

const words = [{ word: 'Welcome', start: 1, end: 1.4 }, { word: 'to', start: 1.4, end: 1.5 }, { word: 'the', start: 1.5, end: 1.6 }, { word: 'cafe!', start: 1.6, end: 2 }];

check('a shot list is clamped, ordered, de-overlapped; invented quotes become the real words', () => {
    const sl = enforceShotList({
        summary: 'A cafe tour', music: true,
        shots: [
            { inS: 5, outS: 50, what: 'Counter', strength: 7, problems: ['shaky'] },
            { inS: 0, outS: 3, what: 'Door', speech: 'Hi and welcome everyone', strength: 2 },
            { inS: 2, outS: 6, what: 'Overlap', strength: 1 },
            { inS: 'x', outS: 2 },
        ],
    }, 10, words);
    assert.deepStrictEqual(sl.shots.map((s) => [s.inS, s.outS]), [[0, 3], [3, 6], [6, 10]]);
    assert.strictEqual(sl.shots[0].speech, 'Welcome to the cafe!');
    assert.strictEqual(sl.shots[2].strength, 3);
    assert.ok(sl.speech && sl.music);
});

check('an empty shot list still covers the whole video', () => {
    const sl = enforceShotList(null, 8, []);
    assert.deepStrictEqual(sl.shots.map((s) => [s.inS, s.outS]), [[0, 8]]);
    assert.strictEqual(sl.speech, false);
});

check('quoteIsInTranscript ignores case and punctuation, and rejects what was never said', () => {
    assert.ok(quoteIsInTranscript('welcome to the cafe', words));
    assert.ok(!quoteIsInTranscript('free coffee', words));
});

const videos: FootageVideo[] = [
    { id: 11, name: 'kitchen.mp4', durationS: 20, analysis: { summary: 'A kitchen', shots: [{ inS: 0, outS: 20, what: 'Cooking', problems: [], strength: 2 }], speech: false, music: false }, words: [] },
    { id: 12, name: 'latte.mov', durationS: 6, analysis: null, words: [] },
];

check('the review: every chosen video gets a line; suggestions arrive ticked, capped, tied only to chosen videos', () => {
    const r = enforceReview({
        seen: [{ assetId: 999, summary: 'not chosen' }, { assetId: 12, summary: 'Latte art', problems: ['dark'] }],
        suggestions: [
            { kind: 'cut', text: 'Cut the wobble', reason: 'shaky', assetId: 11, inS: 4, outS: 99 },
            { kind: 'nonsense', text: 'Add a card', assetId: 999 },
            { kind: 'cut', text: '' },
            ...Array.from({ length: 20 }, (_, i) => ({ kind: 'text', text: `Words ${i}` })),
        ],
    }, videos, 2);
    assert.deepStrictEqual(r.seen.map((x) => x.assetId), [11, 12]);
    assert.strictEqual(r.seen[0].summary, 'A kitchen');
    assert.deepStrictEqual(r.seen[1].problems, ['dark']);
    assert.strictEqual(r.suggestions.length, MAX_SUGGESTIONS);
    assert.ok(r.suggestions.every((x) => x.ticked));
    assert.deepStrictEqual([r.suggestions[0].inS, r.suggestions[0].outS], [4, 20]);
    assert.strictEqual(r.suggestions[1].kind, 'other');
    assert.strictEqual(r.suggestions[1].assetId, undefined);
    assert.strictEqual(r.charged, 2);
});

check('a stretch is kept only on edits about one; the prompt rules out what it cannot do', () => {
    const r = enforceReview({ suggestions: [
        { kind: 'fill', text: 'Add a card', assetId: 11, inS: 0, outS: 20 },
        { kind: 'trim', text: 'Trim the start', assetId: 11, inS: 0, outS: 2 },
    ] }, videos, 0);
    assert.strictEqual(r.suggestions[0].inS, undefined);
    assert.strictEqual(r.suggestions[0].assetId, 11);
    assert.deepStrictEqual([r.suggestions[1].inS, r.suggestions[1].outS], [0, 2]);
    const p = reviewSystemPrompt();
    assert.ok(/can NOT add background music/.test(p) && /never 8:00/.test(p));
});

check('suggestion lines and the planner block name the video and the stretch', () => {
    assert.strictEqual(suggestionLine({ id: 'e1', kind: 'cut', text: 'Cut it', reason: 'shaky', assetId: 11, inS: 4, outS: 6, ticked: true }), 'Cut it (video 11, 4.0–6.0 s) — shaky');
    const block = footagePlannerBlock(videos);
    assert.ok(block.includes('VIDEO id 11') && block.includes('0.0–20.0 s'));
    assert.ok(block.includes('VIDEO id 12') && block.includes('not analysed'));
});

// ── Wiring (source scans) ───────────────────────────────────────────────────────────────────────

check('the review costs 2 tasks (owner decision D-F1) and is recorded only after it succeeds', () => {
    assert.strictEqual(TASK_WEIGHTS.footage_review, 2);
    assert.strictEqual(FOOTAGE_REVIEW_TASKS, TASK_WEIGHTS.footage_review);
    const src = read('src/utils/footage-review.ts');
    const fn = src.slice(src.indexOf('export async function reviewProject'));
    assert.ok(fn.indexOf("status: 'reviewed'") > 0);
    assert.ok(fn.indexOf("recordCompletedWork(db, orgId, 'footage_review'") > fn.indexOf("status: 'reviewed'"), 'charged after the review is saved');
    assert.ok(/const charged = fresh \? FOOTAGE_REVIEW_TASKS : 0/.test(fn), 'free when every video was analysed before');
    assert.ok(fn.includes('todo.filter((r) => r.analysis == null)'), 'a redo after a rules change is free');
});

check('create refuses footage without consent, unread videos or tasks; ticks decide the edits', () => {
    const src = read('netlify/functions/video-projects.ts');
    assert.ok(src.includes('footageConsent !== true'));
    assert.ok(src.includes('needsReading'));
    assert.ok(src.includes('canAffordReview'));
    assert.ok(src.includes("sgn.ticked = ticks[sgn.id] === true"), 'an id the owner did not tick is unticked');
});

check('prepare only accepts the workspace\'s OWN uploads and its own audio key', () => {
    const src = read('src/utils/footage-review.ts');
    const own = src.slice(src.indexOf('export async function ownVideos'), src.indexOf('export async function loadFootage'));
    assert.ok(own.includes('isNull(contentAssets.provider)') && own.includes('eq(contentAssets.organisationId, orgId)'));
    assert.ok(src.includes('audioKey.startsWith(footageAudioPrefix(orgId, input.assetId))'));
    assert.ok(src.includes('MAX_FOOTAGE_S') && src.includes('MAX_FOOTAGE_BYTES'));
});

check('the build re-checks an own video belongs to the workspace before using it', () => {
    const src = read('src/utils/video-producer.ts');
    const c = src.slice(src.indexOf("case 'own_video': {"), src.indexOf("case 'stock_video': {"));
    assert.ok(c.includes('eq(contentAssets.organisationId, orgId)') && c.includes('isNull(contentAssets.provider)'));
});

check('the SQL adds the table, the column and the two statuses', () => {
    assert.ok(existsSync(new URL('../db/z-video-producer-footage.sql', import.meta.url)));
    const sql = read('db/z-video-producer-footage.sql');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS footage_analyses'));
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS footage_review'));
    assert.ok(/'reviewing', 'reviewed'/.test(sql));
});

check('the worker runs the review; the sweep frees a stuck one', () => {
    assert.ok(read('netlify/functions/process-video-project-background.ts').includes("body.action === 'review'"));
    assert.ok(read('src/utils/video-producer.ts').includes("['reviewing', 'planning', 'building']"));
});

check('chat: the footage card exists, opens the form (never reviews), and the prompt no longer says it cannot watch footage', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('footage_review_proposal'"));
    const card = reg.slice(reg.indexOf('function renderFootageReviewProposalCard'), reg.indexOf("register('footage_review_proposal'"));
    assert.ok(card.includes('openFootage(prefill)') && !card.includes('video-projects'), 'the card only opens the form');
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(!orch.includes('You do not watch footage the user gives you'));
    assert.ok(orch.includes('"type": "footage_review_proposal"'));
});

check('the workspace page loads the reader before the Videos tab, and the Review Queue offers Suggest edits', () => {
    const html = read('workspace.html');
    const a = html.indexOf('/src/components/footage-reader.js');
    assert.ok(a > 0 && a < html.indexOf('/src/components/assistant-videos.js'));
    assert.ok(html.includes('function _rqSuggestEditsPaint') && html.includes("sessionStorage.setItem('bms-footage-prefill'"));
});

// ── Tightening ──────────────────────────────────────────────────────────────────────────────────

const W = (text: string, start: number, step = 0.4, gaps: Record<number, number> = {}) => {
    let t = start;
    return text.split(' ').map((w, i) => { t += gaps[i] ?? 0; const o = { word: w, start: t, end: t + step - 0.05 }; t += step; return o; });
};

check('fillers are hesitations only — never real words like "like" or "so"', () => {
    assert.ok(isFiller('Um,') && isFiller('uh') && isFiller('Erm…'));
    assert.ok(!isFiller('like') && !isFiller('so') && !isFiller('umbrella'));
});

check('a false start is dropped and the last take kept', () => {
    const w = W('we opened in we opened in March last year', 0);
    const { drop, retakes } = retakeIndexes(w);
    assert.strictEqual(retakes, 1);
    assert.deepStrictEqual([...drop].sort((a, b) => a - b), [0, 1, 2]);
    // With a stumble between the takes.
    const w2 = W('our new menu sorry our new menu is out', 0);
    assert.deepStrictEqual([...retakeIndexes(w2).drop].sort((a, b) => a - b), [0, 1, 2, 3]);
    // Two words repeated is speech, not a retake ("very very").
    assert.strictEqual(retakeIndexes(W('it is very very good', 0)).retakes, 0);
});

check('a long pause is cut down to the padding; short pauses stay', () => {
    const words = W('hello there everyone welcome in', 0, 0.4, { 2: 2.0, 4: 0.2 });
    const { pieces, stats } = tightenSegment(0, 6, words);
    assert.strictEqual(stats.pauses, 1);
    assert.strictEqual(pieces.length, 2);
    assert.ok(stats.savedS > 1.5);
    // Speech is never clipped: every kept word sits inside a piece.
    for (const w of words) assert.ok(pieces.some((p) => w.start >= p.inS && w.end <= p.outS), `${w.word} is kept whole`);
    assert.ok(MAX_PAUSE_S === 0.5);
});

check('ums go, the words around them stay, and nothing outside the segment is touched', () => {
    const words = [{ word: 'Hi', start: 1, end: 1.3 }, { word: 'um', start: 1.4, end: 2.4 }, { word: 'welcome', start: 3.2, end: 3.7 }, { word: 'outside', start: 9, end: 9.5 }];
    const { pieces, stats } = tightenSegment(0.5, 5, words);
    assert.strictEqual(stats.fillers, 1);
    assert.ok(pieces.every((p) => p.inS >= 0.5 && p.outS <= 5));
    assert.ok(!pieces.some((p) => p.inS < 2.0 && p.outS > 2.2), 'the um itself does not play');
});

check('silent footage, or nothing worth cutting, plays whole', () => {
    assert.deepStrictEqual(tightenSegment(2, 8, []).pieces, [{ inS: 2, outS: 8 }]);
    const tight = W('one two three four', 1, 0.4);
    assert.deepStrictEqual(tightenSegment(0.9, 2.7, tight).pieces, [{ inS: 0.9, outS: 2.7 }]);
    const onlyUm = [{ word: 'um', start: 1, end: 2 }];
    assert.deepStrictEqual(tightenSegment(0, 3, onlyUm).pieces, [{ inS: 0, outS: 3 }], 'never an empty scene');
});

check('no piece is a flash', () => {
    const words = [{ word: 'a', start: 0, end: 0.1 }, { word: 'b', start: 1.5, end: 1.6 }, { word: 'long', start: 3, end: 4 }, { word: 'tail', start: 4.05, end: 4.5 }];
    const { pieces } = tightenSegment(0, 5, words);
    assert.ok(pieces.every((p) => p.outS - p.inS >= 0.4));
});

check('capPieces rejoins the shortest gaps first, across scenes, until under the limit', () => {
    const lists = [[{ inS: 0, outS: 1 }, { inS: 1.2, outS: 2 }, { inS: 5, outS: 6 }], [{ inS: 0, outS: 1 }, { inS: 3, outS: 4 }]];
    const out = capPieces(lists, 5, 1);
    assert.strictEqual(out.reduce((a, l) => a + l.length, 0) + 1, 5);
    assert.deepStrictEqual(out[0][0], { inS: 0, outS: 2 }, 'the 0.2 s gap went first');
    assert.strictEqual(lists[0].length, 3, 'the input is not changed');
});

const talk = W('hi um welcome to the cafe we opened in we opened in March', 0, 0.4, { 5: 2.5 });
const tvids: FootageVideo[] = [{ id: 11, name: 'talk.mp4', durationS: 20, analysis: null, words: talk }];
const tsb = () => ({ title: 'T', caption: '', scenes: [
    { id: 's1', beat: 'hook' as const, voiceover: '', source: 'own_video' as const, assetId: 11, inS: 0, outS: 10, targetS: 10 },
    { id: 's2', beat: 'cta' as const, voiceover: '', source: 'brand_card' as const, targetS: 3 },
] });

check('tightenStoryboard: own sound tightens, the scene gets its pieces, length and what was cut', () => {
    const { storyboard, changes } = tightenStoryboard(tsb(), brief({ voiceover: false, footageAssetIds: [11] }), tvids);
    const s = storyboard.scenes[0];
    assert.ok(s.cuts && s.cuts.length >= 2);
    assert.ok(s.targetS < 10 && Math.abs(s.targetS - s.cuts!.reduce((a, p) => a + p.outS - p.inS, 0)) < 0.11);
    assert.deepStrictEqual([s.tightened!.fillers, s.tightened!.retakes, s.tightened!.pauses], [1, 1, 1]);
    assert.ok(/shorter/.test(changes[0]));
    assert.strictEqual(storyboard.scenes[1].cuts, undefined);
    assert.ok(/1 pause, 1 “um”, 1 repeated take cut — /.test(describeTightening(s.tightened!)));
});

check('no tightening under a voiceover, with it switched off, or on a scene kept as filmed', () => {
    const voiced = tightenStoryboard(tsb(), brief({ voiceover: true, footageAssetIds: [11] }), tvids).storyboard.scenes[0];
    assert.strictEqual(voiced.cuts, undefined);
    const off = tightenStoryboard(tsb(), brief({ voiceover: false, footageAssetIds: [11], tighten: false }), tvids).storyboard.scenes[0];
    assert.strictEqual(off.cuts, undefined);
    assert.strictEqual(off.targetS, 10, 'back to its whole segment');
    const sb = tsb(); (sb.scenes[0] as Scene).tighten = false;
    assert.strictEqual(tightenStoryboard(sb, brief({ voiceover: false, footageAssetIds: [11] }), tvids).storyboard.scenes[0].cuts, undefined);
});

check('"Keep as filmed" survives the storyboard rules', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ tighten: false }), sc(), sc()]), brief({ voiceover: false }), [], own);
    assert.strictEqual(storyboard.scenes[0].tighten, false);
    assert.strictEqual(storyboard.scenes[1].tighten, undefined);
});

check('the build plays a tightened scene as one clip per piece, inside the file, and times captions to them', () => {
    const tightened = tightenStoryboard(tsb(), brief({ voiceover: false, footageAssetIds: [11] }), tvids).storyboard;
    const fileS = new Map([[11, 20]]);
    const d = playedDurations(tightened.scenes, tightened.scenes.map((s) => s.targetS), fileS, true);
    const clips = sceneClips(tightened.scenes, { s1: 11, s2: 60 }, d, { fileS, ownSound: true });
    const own1 = clips.filter((c) => c.assetId === 11);
    assert.strictEqual(own1.length, tightened.scenes[0].cuts!.length);
    assert.ok(own1.every((c) => c.gain === 1 && c.id.startsWith('vp_s1_')));
    const words = ownSpeechOnTimeline(tightened.scenes, d, new Map([[11, talk]]));
    assert.ok(!words.some((w) => w.word === 'um'), 'the cut um is not captioned');
    assert.ok(words.every((w, i) => i === 0 || w.start >= words[i - 1].start), 'captions stay in order');
    assert.ok(words[words.length - 1].end <= d[0] + 0.01, 'every caption is inside the scene');
    assert.deepStrictEqual(livePieces([{ inS: 18, outS: 25 }, { inS: 30, outS: 31 }], 20), [{ inS: 18, outS: 20 }]);
});

check('a library video is downloaded fresh, never read from the cached non-CORS copy (staging, 2026-11-09)', () => {
    const js = read('src/components/footage-reader.js');
    assert.ok(js.includes("cache: 'no-store'"));
    const prep = js.slice(js.indexOf('async function prepare'));
    assert.ok(prep.indexOf('await download(') > 0 && prep.indexOf('await download(') < prep.indexOf('openVideo('), 'downloaded before it is opened');
});

// ── Fixes from the first real-speech run (staging, 2026-11-09) ──────────────────────────────────

check('the transcription is TOLD the language (English unless the brief says otherwise)', () => {
    assert.ok(read('src/lib/tts.ts').includes("form.append('language', file.language)"));
    const src = read('src/utils/footage-review.ts');
    assert.ok(src.includes('language: ctx.language'));
    assert.ok(src.includes("languageLabel(brief.language) ? brief.language : 'en'"));
});

check('a footage storyboard always states the language for the caption and on-screen words', () => {
    const p = storyboardUserPrompt({ brief: brief({ voiceover: false }), businessName: 'B', businessFacts: '', library: [], today: '2026-11-09', language: 'English', footageBlock: 'X' });
    assert.ok(/LANGUAGE: write .* in English/.test(p));
    const q = storyboardUserPrompt({ brief: brief({ footageAssetIds: [] }), businessName: 'B', businessFacts: '', library: [], today: '2026-11-09', language: 'English' });
    assert.ok(!/LANGUAGE:/.test(q), 'an ordinary English video is unchanged');
});

check('loudness safety net: a loud stretch the transcript has no words for is never cut', () => {
    // Speech from 1 s to 9 s, but the transcript only heard words from 6 s on (the staging failure).
    const loud = Array.from({ length: 100 }, (_, i) => (i >= 10 && i < 90 ? 30 : 2));
    const heard = W('and this is our studio we film here', 6, 0.35);
    const without = tightenSegment(0, 10, heard);
    assert.ok(without.pieces[0].inS > 5, 'without loudness it would cut the opening');
    const withIt = tightenSegment(0, 10, heard, loud);
    assert.strictEqual(withIt.pieces[0].inS, 0, 'the unheard opening stays');
});

check('loudness safety net: a real silent pause is still cut, and an um is still cut', () => {
    const words = [...W('hello there everyone', 0, 0.4), ...W('welcome in', 3.2, 0.4), { word: 'um', start: 4.2, end: 4.9 }, ...W('to the studio', 5.0, 0.4)];
    const loud = Array.from({ length: 70 }, (_, i) => { const t = i / 10; return words.some((w) => t >= w.start && t < w.end) ? 30 : 1; });
    const r = tightenSegment(0, 7, words, loud);
    assert.ok(r.pieces.length >= 2 && r.stats.savedS > 1, 'the silent gap went');
    assert.ok(!r.pieces.some((p) => p.inS < 4.4 && p.outS > 4.7), 'the um did not come back');
});

check('loudSeconds and restoreLoudGaps', () => {
    assert.strictEqual(loudSeconds([0, 50, 50, 0, 50], 0, 0.5, 10), 0.30000000000000004);
    const kept = [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 3, end: 4 }];
    const loud = [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
    assert.deepStrictEqual(restoreLoudGaps([{ inS: 0, outS: 1.2 }, { inS: 2.9, outS: 4 }], 0, 4, loud, kept, []), [{ inS: 0, outS: 4 }]);
});

check('a video reviewed before is free to review again; the form says so', () => {
    const src = read('src/utils/footage-review.ts');
    assert.ok(src.includes('reviewedBefore: r?.analysis != null'));
    assert.ok(src.includes('status.every((s) => s.reviewedBefore)'));
    assert.ok(read('src/components/assistant-videos.js').includes('known.get(id).reviewedBefore'));
    assert.ok(read('src/components/footage-reader.js').includes('frames, audioKey, loudness'));
});

check('the finished video is rendered right after it is made, so the review shows the real cut', () => {
    const src = read('src/utils/video-producer.ts');
    const b = src.slice(src.indexOf('export async function buildProject'));
    assert.ok(b.indexOf('renderFinishedVideo(db') > b.indexOf("status: 'built'"));
    assert.ok(src.includes('queuePostRender(db, {'));
    assert.ok(read('src/components/assistant-videos.js').includes("(v.postRenderStatus === 'pending' || v.postRenderStatus === 'rendering') ? 'rendering'"), 'both render states say so');
});

check('the clip limit is 40 in the render and in the post editor', () => {
    assert.strictEqual(MAX_CLIPS, 40);
    assert.ok(read('workspace.html').includes('const _PCE_MAX_CLIPS = 40;'));
});

console.log(`\nfootage: ${passed} passed`);
