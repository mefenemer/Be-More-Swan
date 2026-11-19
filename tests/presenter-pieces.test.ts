// tests/presenter-pieces.test.ts
// Phase 4c-2 (docs/video-producer-screen-walkthrough-plan.md §12, "4c design"): a long presenter scene is made as
// ~15 s pieces cut at pauses, all sent at once, played back to back; every piece's job is recorded so the NEXT build
// run collects it instead of paying again; a run hands over to a fresh one before the worker's 15-minute ceiling.
//
// Run:  npx tsx tests/presenter-pieces.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presenterPieces, PRESENTER_PIECE_S, PRESENTER_MAX_PIECE_S, PRESENTER_AUDIO_TAIL_S } from '../src/lib/presenters';
import { presenterPieceKey, presenterPieceKeys, dropPresenterScene, presenterJobKey, sceneClips, buildRunBudgetMs, pieceSecondsFromKey } from '../src/utils/video-producer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Words every 0.4 s, with a wider pause after every 10th word.
function talk(fromS: number, toS: number): Array<{ start: number; end: number }> {
    const out: Array<{ start: number; end: number }> = [];
    let t = fromS, n = 0;
    while (t < toS - 0.3) { out.push({ start: t, end: t + 0.3 }); n++; t += n % 10 === 0 ? 0.9 : 0.4; }
    return out;
}

console.log('pieces');

check('a scene up to 20 s is one piece, as before', () => {
    assert.deepStrictEqual(presenterPieces(3, 18, talk(3, 18)), [{ startS: 3, endS: 18 }]);
    assert.deepStrictEqual(presenterPieces(0, PRESENTER_MAX_PIECE_S, []), [{ startS: 0, endS: 20 }]);
});

check('a long scene is cut into pieces of at most 20 s, back to back, covering it exactly, cuts in pauses', () => {
    const words = talk(10, 95);
    const pieces = presenterPieces(10, 95, words);
    assert.ok(pieces.length >= 5);
    assert.strictEqual(pieces[0].startS, 10);
    assert.strictEqual(pieces[pieces.length - 1].endS, 95);
    for (let k = 0; k < pieces.length; k++) {
        const len = pieces[k].endS - pieces[k].startS;
        assert.ok(len <= PRESENTER_MAX_PIECE_S + 1e-6 && len > 0.9, `piece ${k} is ${len} s`);
        if (k) assert.strictEqual(pieces[k].startS, pieces[k - 1].endS, 'no gap, no overlap');
        if (k < pieces.length - 1) {
            const cut = pieces[k].endS;
            assert.ok(!words.some((w) => w.start < cut && w.end > cut), `the cut at ${cut} falls inside a word`);
        }
    }
    // Most pieces land near the aim, not all at the limit.
    assert.ok(pieces.slice(0, -1).some((p) => p.endS - p.startS <= PRESENTER_PIECE_S + 3));
});

check('no pauses at all: still never longer than 20 s', () => {
    const pieces = presenterPieces(0, 61, []);
    assert.ok(pieces.every((p) => p.endS - p.startS <= PRESENTER_MAX_PIECE_S + 1e-6));
    assert.strictEqual(pieces.at(-1)!.endS, 61);
});

console.log('keys and jobs');

check('piece keys, finding them, and dropping a scene with its pieces', () => {
    assert.strictEqual(presenterPieceKey('s3', 0), 's3~p1');
    const assets: Record<string, number> = { s3: 10, 's3~p1': 10, 's3~p2': 11, 's3~p10': 19, 's3~cover': 5, s31: 7, 's31~p1': 8 };
    assert.deepStrictEqual(presenterPieceKeys(assets, 's3'), ['s3~p1', 's3~p2', 's3~p10']);
    dropPresenterScene(assets, 's3');
    assert.deepStrictEqual(assets, { 's3~cover': 5, s31: 7, 's31~p1': 8 }, 'the cover and another scene stay');
});

check('a job key names the project, the voiceover and the window: a new voiceover never reuses an old clip', () => {
    const a = presenterJobKey(48, 400, 's2~p1', { startS: 10, endS: 24.5 });
    assert.strictEqual(a, 'video_project:48:vo400:s2~p1:10.00-24.50');
    assert.notStrictEqual(a, presenterJobKey(48, 401, 's2~p1', { startS: 10, endS: 24.5 }));
    assert.notStrictEqual(a, presenterJobKey(48, 400, 's2~p1', { startS: 10, endS: 25 }));
});

console.log('the timeline');

check('pieces play back to back: each its slot (file less the tail), the last filling the scene', () => {
    const scenes = [{ id: 's1', beat: 'hook', voiceover: 'x', source: 'ai_presenter', targetS: 40 }] as never;
    const assets = { s1: 101, 's1~p1': 101, 's1~p2': 102, 's1~p3': 103 };
    const clipS = new Map([[101, 15 + PRESENTER_AUDIO_TAIL_S], [102, 14 + PRESENTER_AUDIO_TAIL_S], [103, 11.4 + PRESENTER_AUDIO_TAIL_S]]);
    const clips = sceneClips(scenes, assets, [40.4], { fileS: new Map(), ownSound: false, clipS });
    assert.deepStrictEqual(clips.map((c) => [c.id, c.assetId, c.inS, c.outS]), [['vp_s1_1', 101, 0, 15], ['vp_s1_2', 102, 0, 14], ['vp_s1_3', 103, 0, 11.4]]);
    // One piece: as before.
    const one = sceneClips(scenes, { s1: 101, 's1~p1': 101 }, [12], { fileS: new Map(), ownSound: false, clipS: new Map([[101, 12.3]]) });
    assert.deepStrictEqual(one.map((c) => [c.id, c.outS]), [['vp_s1', 12]]);
});

console.log('the build');

check('every piece is recorded as a job, collected by the next run, and a run hands over before the ceiling', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.match(vp, /if \(done\[keys\[k\]\] \|\| byKey\.has\(jobKeys\[k\]\)\) continue;/, 'a piece already made or at the model is never sent again');
    assert.match(vp, /if \(Date\.now\(\) - runStarted > buildRunBudgetMs\(\)\) \{ handOver = true; await save\(\{\}\); return; \}/);
    assert.strictEqual(buildRunBudgetMs({}), 11 * 60 * 1000);
    assert.strictEqual(buildRunBudgetMs({ VIDEO_BUILD_RUN_BUDGET_MS: '90000' }), 90_000, 'lowered to test a hand-over');
    assert.strictEqual(buildRunBudgetMs({ VIDEO_BUILD_RUN_BUDGET_MS: '99999999' }), 11 * 60 * 1000, 'never raised past the ceiling');
    assert.strictEqual(buildRunBudgetMs({ VIDEO_BUILD_RUN_BUDGET_MS: '5' }), 11 * 60 * 1000, 'junk ignored');
    assert.match(vp, /if \(handOver\) \{[\s\S]{0,1200}woken = await wakeVideoWorker\(\{ projectId, action: 'build' \}\);[\s\S]{0,300}return;/);
    assert.match(vp, /await save\(\{\}\);   \/\/ keeps updatedAt fresh/, 'the stuck sweep leaves a long build alone');
    assert.match(vp, /done\[scene\.id\] = done\[keys\[0\]\];/, 'the scene counts as made only when every piece is in');
    assert.match(vp, /const loadVoice = \(\) => \(voicePcm \?\?= /, 'the voiceover is decoded once a run, not once a scene');
    assert.match(read('netlify/functions/video-projects.ts'), /dropPresenterScene\(assets, scene\.id\);/);
});

console.log('review of #757');

check('a piece\'s clip length is exact (from its window plus the tail), never a rounded-up whole second', () => {
    assert.strictEqual(pieceSecondsFromKey('video_project:48:vo400:s2~p1:10.00-24.31'), 14.61);
    assert.strictEqual(pieceSecondsFromKey('nonsense'), null);
    assert.match(read('src/utils/video-producer.ts'), /const seconds = pieceSecondsFromKey\(args\.job\.prompt\) \?\? args\.job\.durationSeconds \?\? 0;/);
});

check('pieces never count as running tasks or show in the Activity feed: they are in the video\'s build hold', () => {
    assert.match(read('src/utils/work-metering.ts'), /AND prompt NOT LIKE 'video_project:%'/);
    assert.match(read('src/utils/task-balance.ts'), /AND prompt NOT LIKE 'video_project:%'/);
    assert.match(read('netlify/functions/get-assistant-activity.ts'), /notLike\(mediaGenerationJobs\.prompt, 'video_project:%'\)/);
});

check('a piece finished at the model is collected before any timeout; collecting is claimed; a scene is charged once', () => {
    const vp = read('src/utils/video-producer.ts');
    const status = vp.indexOf("const state = row.falStatusUrl ? await falStatus(row.falStatusUrl) : 'IN_PROGRESS';");
    const timeout = vp.indexOf('> PRESENTER_PIECE_MAX_MS) {');
    assert.ok(status > 0 && timeout > status, 'falStatus is read before the 45-minute timeout');
    assert.match(vp, /\.set\(\{ errorMessage: `collecting:\$\{runStarted\}`, updatedAt: new Date\(\) \}\)/);
    assert.match(vp, /set\(\{ status: 'completed', resultAssetIds: \[asset\.id\], errorMessage: null, updatedAt: new Date\(\) \}\)/, 'the claim is cleared when the piece is done (staging project 53)');
    assert.match(vp, /if \(already > 0\) \{ done\[scene\.id\] = already; return; \}/, 'another run finished the scene: no second charge');
});

check('a failed or swept build stops its pieces; a hand-over says which scenes failed and retries the wake', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.match(vp, /await abandonPresenterPieces\(db, projectId\)/);
    assert.match(vp, /if \(claimed\) await abandonPresenterPieces\(db, p\.id\)/);
    assert.match(vp, /couldn’t be made and \$\{failed\.size === 1 \? 'is' : 'are'\} being tried again/);
    assert.match(vp, /for \(let attempt = 0; attempt < 3 && !woken; attempt\+\+\)/);
});

console.log(`\n${passed} checks passed.`);
