// tests/storyboard.test.ts
// The Video Producer's storyboard rules (src/lib/storyboard.ts) — every rule the plan lists is
// enforced in code; this proves each one holds whatever the model returns.
//
// Run:  npx tsx tests/storyboard.test.ts

import assert from 'node:assert';
import {
    enforceStoryboard, fitLength, sceneTimingsFromWords, snapToPause, estimateCredits, scriptOf, parseStoryboardJson,
    storyboardUserPrompt, isStillSource, MAX_AI_CLIPS, MAX_HOOK_S, type VideoBrief, type Scene,
} from '../src/lib/storyboard';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const brief = (o: Partial<VideoBrief> = {}): VideoBrief => ({ purpose: 'promo', lengthS: 30, message: 'Autumn menu is here', voiceover: true, allowAi: 'stock_and_ai', ...o });
const raw = (scenes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ title: 'T', caption: 'C', scenes, ...extra });
const sc = (o: Record<string, unknown> = {}) => ({ beat: 'value', voiceover: 'one two three four five', source: 'stock_video', keywords: 'coffee shop', targetS: 6, ...o });

check('hook first, call to action last — whatever the model labelled them', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ beat: 'value' }), sc(), sc({ beat: 'proof' })]), brief());
    assert.strictEqual(storyboard.scenes[0].beat, 'hook');
    assert.strictEqual(storyboard.scenes.at(-1)!.beat, 'cta');
});

check('the hook is never longer than 3 s; the total lands on the asked length', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ targetS: 9 }), sc({ targetS: 9 }), sc({ targetS: 9 })]), brief({ lengthS: 30 }));
    assert.ok(storyboard.scenes[0].targetS <= MAX_HOOK_S);
    const total = storyboard.scenes.reduce((a, s) => a + s.targetS, 0);
    assert.ok(total >= 27 && total <= 33, `total ${total}`);
});

check('stock only means no AI, and the scene still has search words', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ source: 'ai_video', prompt: 'steam over a latte cup', keywords: undefined }), sc({ source: 'ai_image', prompt: 'autumn leaves table' }), sc()]), brief({ allowAi: 'stock_only' }));
    assert.deepStrictEqual(storyboard.scenes.map((s) => s.source), ['stock_video', 'stock_photo', 'stock_video']);
    assert.ok(storyboard.scenes[0].keywords);
});

check(`at most ${MAX_AI_CLIPS} AI clips — the earliest are kept`, () => {
    const { storyboard, changes } = enforceStoryboard(raw([1, 2, 3, 4, 5].map(() => sc({ source: 'ai_video', prompt: 'a cafe' }))), brief({ allowAi: 'ai_first' }));
    assert.deepStrictEqual(storyboard.scenes.map((s) => s.source), ['ai_video', 'ai_video', 'ai_video', 'stock_video', 'stock_video']);
    assert.ok(changes.some((c) => c.includes('AI clips')));
});

check('a product photo must be one of OUR pictures, else stock — never AI', () => {
    const library = [{ id: 7, name: 'Our latte' }];
    const ok = enforceStoryboard(raw([sc({ source: 'product_photo', assetId: 7 }), sc(), sc()]), brief(), library).storyboard;
    assert.strictEqual(ok.scenes[0].source, 'product_photo');
    assert.strictEqual(ok.scenes[0].assetId, 7);
    const bad = enforceStoryboard(raw([sc({ source: 'product_photo', assetId: 99 }), sc(), sc()]), brief(), library);
    assert.strictEqual(bad.storyboard.scenes[0].source, 'stock_photo');
    assert.ok(bad.changes[0].includes("isn't in your library"));
});

check('no URLs read aloud or painted on screen', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ voiceover: 'Visit https://example.com today', onScreenText: 'www.x.com now' }), sc(), sc()]), brief());
    assert.ok(!/http|www\./.test(storyboard.scenes[0].voiceover + (storyboard.scenes[0].onScreenText ?? '')));
});

check('stills get a movement, clips do not', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ source: 'stock_photo' }), sc({ source: 'brand_card' }), sc()]), brief());
    assert.ok(storyboard.scenes[0].motion && storyboard.scenes[1].motion);
    assert.strictEqual(storyboard.scenes[2].motion, undefined);
    assert.ok(isStillSource('brand_card') && !isStillSource('stock_video'));
});

check('the call to action words reach the last scene', () => {
    const { storyboard } = enforceStoryboard(raw([sc(), sc(), sc({ voiceover: 'see you soon' })]), brief({ cta: 'Book at the link in bio' }));
    assert.strictEqual(storyboard.scenes.at(-1)!.onScreenText, 'Book at the link in bio');
});

check('too few scenes is reported, never padded with invented ones', () => {
    const { storyboard, changes } = enforceStoryboard(raw([sc()]), brief());
    assert.strictEqual(storyboard.scenes.length, 1);
    assert.ok(changes.some((c) => c.includes('at least 3')));
    assert.strictEqual(enforceStoryboard(null, brief()).storyboard.scenes.length, 0);
});

check('the voice sets the cut: each scene lasts from its first word to the next scene’s', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ voiceover: 'a b' }), sc({ voiceover: 'c d' }), sc({ voiceover: 'e f' })]), brief());
    const words = [0, 0.5, 2, 2.5, 4, 4.5].map((t) => ({ start: t, end: t + 0.4 }));
    const d = sceneTimingsFromWords(storyboard, words)!;
    assert.deepStrictEqual(d, [2, 2, 1.5].map((x, i) => (i === 2 ? Math.max(1.5, 4.9 + 0.4 - 4) : x)).map((x) => Math.round(x * 10) / 10));
    assert.strictEqual(sceneTimingsFromWords(storyboard, []), null);
});

check('a cut lands in the pause before a sentence, even when the transcript counts words differently (staging video 46, 2026-11-18)', () => {
    // The script said "fifteen minute"; the transcriber heard "15-minute" — one word fewer, so the count put scene 5's
    // start on "online" and the AI presenter's clip missed "Book". The cut now moves to the 0.54 s pause before "Book".
    const lines = ['Want a video that shows off your business?', 'Most small businesses never get one. It feels big and hard.',
        'We film short brand videos made for small businesses.', 'Start with a free fifteen minute call to plan yours.', 'Book online today.'];
    const { storyboard } = enforceStoryboard(raw(lines.map((voiceover) => sc({ voiceover }))), brief());
    const heard = 'Want@0.1-0.28 a@0.34-0.38 video@0.42-0.74 that@0.78-0.92 shows@0.96-1.24 off@1.3-1.44 your@1.48-1.6 business?@1.62-2.1 Most@2.62-2.84 small@2.88-3.1 businesses@3.12-3.7 never@3.84-4.08 get@4.12-4.3 one.@4.4-4.54 It@4.98-5.08 feels@5.12-5.44 big@5.48-5.68 and@5.8-5.94 hard.@6.02-6.38 We@6.78-6.9 film@6.96-7.16 short@7.26-7.46 brand@7.54-7.78 videos@7.82-8.24 made@8.28-8.54 for@8.56-8.64 small@8.74-8.98 businesses.@9.02-9.68 Start@10.28-10.5 with@10.52-10.62 a@10.68-10.78 free@10.82-11.12 15-minute@11.14-11.86 call@11.98-12.22 to@12.26-12.34 plan@12.38-12.6 yours.@12.68-13.02 Book@13.56-13.72 online@13.8-14.24 today.@14.42-14.78'
        .split(' ').map((w) => { const [, a, b] = /@([\d.]+)-([\d.]+)/.exec(w)!; return { start: Number(a), end: Number(b) }; });
    const d = sceneTimingsFromWords(storyboard, heard)!;
    const starts = d.reduce<number[]>((acc, x, i) => [...acc, i ? acc[i - 1] + d[i - 1] : 0], []);
    assert.ok(Math.abs(starts[4] - 13.6) < 0.06, `scene 5 starts at "Book" (13.56 s), not "online" (13.8 s): ${starts[4]}`);
    assert.ok(Math.abs(starts[3] - 10.3) < 0.06 && Math.abs(starts[1] - 2.6) < 0.06, 'the other cuts still sit before their sentences');
    // After a silent scene, the next cut isn't moved (review of #723): its first words stay its own.
    const silent = enforceStoryboard(raw([sc({ voiceover: 'a b c' }), sc({ voiceover: '' }), sc({ voiceover: 'd e f g' })]), brief()).storyboard;
    const w2 = [0, 0.3, 0.6, 1.5, 1.8, 3.0, 3.3].map((t) => ({ start: t, end: t + 0.25 }));
    const d2 = sceneTimingsFromWords(silent, w2)!;
    // Its first word kept: it runs 1.5 → 3.95 s (2.5); snapped to the later pause it would shrink to the 1.5 s minimum.
    assert.ok(d2[2] >= 2.4, `scene 3 keeps its first word: ${d2[2]}`);
    // No pause nearby: the estimate stands.
    assert.strictEqual(snapToPause([0, 0.3, 0.6, 0.9].map((t) => ({ start: t, end: t + 0.28 })), 2, 1), 2);
});

check('credit estimate: AI images and clips and one voiceover; stock and cards are free', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ source: 'ai_video', prompt: 'x' }), sc({ source: 'ai_image', prompt: 'y' }), sc({ source: 'brand_card' })]), brief());
    assert.strictEqual(estimateCredits(storyboard, brief(), { image: 1, video: 5, voiceover: 1 }), 7);
    assert.strictEqual(estimateCredits(storyboard, brief({ voiceover: false }), { image: 1, video: 5, voiceover: 1 }), 6);
});

check('the script is the scenes’ voiceover in order', () => {
    const { storyboard } = enforceStoryboard(raw([sc({ voiceover: 'Hello.' }), sc({ voiceover: 'World.' }), sc({ voiceover: '' })]), brief());
    assert.strictEqual(scriptOf(storyboard), 'Hello. World.');
});

check('JSON is pulled out of a chatty reply; garbage is null', () => {
    assert.deepStrictEqual(parseStoryboardJson('Sure! {"a":1} hope that helps'), { a: 1 });
    assert.strictEqual(parseStoryboardJson('no json here'), null);
});

check('the prompt carries the length, the CTA, the library ids and the owner’s notes', () => {
    const p = storyboardUserPrompt({ brief: brief({ cta: 'Book now', allowAi: 'stock_only' }), businessName: 'Bean', businessFacts: 'Cafe', library: [{ id: 3, name: 'Latte' }], today: '2026-10-31', feedback: 'more energy' });
    for (const bit of ['30-second', 'Book now', '3: Latte', 'more energy', 'Do NOT use ai_image', '2026-10-31']) assert.ok(p.includes(bit), bit);
});

check('fitLength keeps every scene at least 1.5 s', () => {
    const out = fitLength([{ targetS: 0.2 } as Scene, { targetS: 0.2 } as Scene, { targetS: 50 } as Scene], 15);
    assert.ok(out.every((s) => s.targetS >= 1.5));
});

console.log(`\n${passed} checks passed`);
