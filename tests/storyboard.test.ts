// tests/storyboard.test.ts
// The Video Producer's storyboard rules (src/lib/storyboard.ts) — every rule the plan lists is
// enforced in code; this proves each one holds whatever the model returns.
//
// Run:  npx tsx tests/storyboard.test.ts

import assert from 'node:assert';
import {
    enforceStoryboard, fitLength, sceneTimingsFromWords, estimateCredits, scriptOf, parseStoryboardJson,
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
