// tests/captions.test.ts
// Voiceover captions (Video Producer plan, Phase 3) — src/lib/captions.ts, the audio `captions`
// flag, the render fingerprint, the worker and the composition.
//
// What goes wrong silently if these drift:
//   · words placed at their voiceover-relative time instead of the timeline (captions early/late by
//     exactly the clip's start — looks like a sync bug nobody can explain)
//   · captions shown for words the clip cuts off before they are heard
//   · a dark brand colour used as the highlight, so the spoken word disappears
//   · toggling captions not changing the fingerprint, so a sibling post is handed the other cut
//   · the composition requiring `captions` — an old input on a new bundle would fail to render
// No network, no database, no renderer.
//
// Run:  npx tsx tests/captions.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withScriptPunctuation, normalizeCaptionStyle, DEFAULT_CAPTION_STYLE, alignTextToWords } from '../src/lib/captions';
import {
    timelineWords, buildCaptionCues, cueAt, captionAccent, captionLayout,
    CAPTION_MAX_WORDS, CAPTION_MAX_CHARS, CAPTION_HOLD_S, CAPTION_FALLBACK_ACCENT,
} from '../src/lib/captions';
import { sanitiseAudioOverlays } from '../src/lib/audio-overlays';
import { renderFingerprint } from '../src/lib/post-render';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const w = (word: string, start: number, end: number) => ({ word, start, end });

check('words land on the TIMELINE: voiceover start + the word’s own time', () => {
    const out = timelineWords([{ startS: 3, words: [w('Hello', 0.2, 0.5)] }]);
    assert.deepStrictEqual(out, [{ text: 'Hello', startS: 3.2, endS: 3.5 }]);
});

check('a word the clip cuts off is never captioned; one cut mid-word ends at the cut', () => {
    const out = timelineWords([{ startS: 0, endS: 1, words: [w('one', 0.1, 0.4), w('two', 0.8, 1.3), w('three', 1.4, 1.8)] }]);
    assert.deepStrictEqual(out.map((x) => x.text), ['one', 'two']);
    assert.strictEqual(out[1].endS, 1);
});

check('phrases break at 4 words, 26 characters, sentence ends and pauses', () => {
    const many = buildCaptionCues([{ words: ['a', 'b', 'c', 'd', 'e'].map((x, i) => w(x, i * 0.3, i * 0.3 + 0.25)) }]);
    assert.strictEqual(many[0].words.length, CAPTION_MAX_WORDS);
    const long = buildCaptionCues([{ words: [w('extraordinarily', 0, 0.4), w('wonderful', 0.45, 0.8), w('things', 0.85, 1.1)] }]);
    assert.ok(long.every((c) => c.words.map((x) => x.text).join(' ').length <= CAPTION_MAX_CHARS));
    const sentence = buildCaptionCues([{ words: [w('Done.', 0, 0.3), w('Next', 0.35, 0.6)] }]);
    assert.strictEqual(sentence.length, 2);
    const pause = buildCaptionCues([{ words: [w('wait', 0, 0.3), w('for', 1.2, 1.4)] }]);
    assert.strictEqual(pause.length, 2);
});

check('a phrase holds after its last word but never over the next phrase', () => {
    const cues = buildCaptionCues([{ words: [w('First.', 0, 0.5), w('Second', 0.6, 1.0)] }]);
    assert.strictEqual(cues[0].endS, 0.6, 'held only until the next phrase starts');
    assert.strictEqual(cues[1].endS, 1.0 + CAPTION_HOLD_S);
});

check('cueAt finds the phrase and the word being spoken', () => {
    const cues = buildCaptionCues([{ startS: 2, words: [w('Big', 0, 0.3), w('autumn', 0.35, 0.7), w('sale', 0.75, 1.0)] }]);
    assert.strictEqual(cueAt(cues, 1.9), null);
    assert.strictEqual(cueAt(cues, 2.1)!.wordIndex, 0);
    assert.strictEqual(cueAt(cues, 2.5)!.wordIndex, 1);
    assert.strictEqual(cueAt(cues, 2.9)!.wordIndex, 2);
    assert.strictEqual(cueAt(cues, 10), null);
});

check('no words, no captions — never invented', () => {
    assert.deepStrictEqual(buildCaptionCues([]), []);
    assert.deepStrictEqual(buildCaptionCues([{ words: [] }]), []);
});

check('the brand colour highlights only when it reads over footage', () => {
    assert.strictEqual(captionAccent('#1f1e1b'), CAPTION_FALLBACK_ACCENT, 'near-black would vanish');
    assert.strictEqual(captionAccent('#ffd400'), '#FFD400');
    assert.strictEqual(captionAccent('#00e5ff'), '#00E5FF');
    assert.strictEqual(captionAccent('not a colour'), CAPTION_FALLBACK_ACCENT);
    assert.strictEqual(captionAccent(null), CAPTION_FALLBACK_ACCENT);
});

check('caption size scales with the frame and sits above the platform UI', () => {
    const tall = captionLayout(1920);
    assert.ok(tall.fontSizePx > 100 && tall.fontSizePx < 125);
    assert.ok(tall.bottomPct! >= 18, 'Reels/Shorts draw their own UI in the bottom ~18%');
});

check('the captions flag survives the save sanitiser, and only as a boolean', () => {
    const out = sanitiseAudioOverlays([{ id: 'a', assetId: 5, captions: false }, { id: 'b', assetId: 6, captions: 'yes' }, { id: 'c', assetId: 7 }])!;
    assert.strictEqual(out[0].captions, false);
    assert.strictEqual('captions' in out[1], false);
    assert.strictEqual('captions' in out[2], false);
});

check('switching captions off changes the render fingerprint (no sibling gets the wrong cut)', () => {
    const base = { videoEdit: null, baseAssetId: 1, hasTimelineAudio: true, targetRatio: null, framePosition: null, imageOverlays: [] } as const;
    const on = renderFingerprint({ ...base, audioOverlays: [{ id: 'a', assetId: 5, volume: 1, captions: true }] } as never);
    const off = renderFingerprint({ ...base, audioOverlays: [{ id: 'a', assetId: 5, volume: 1, captions: false }] } as never);
    const absent = renderFingerprint({ ...base, audioOverlays: [{ id: 'a', assetId: 5, volume: 1 }] } as never);
    assert.notStrictEqual(on, off);
    assert.strictEqual(on, absent, 'absent means captioned, so it must fingerprint the same as true');
});

check('worker sends captions only when there are words, and never fails a render over them', () => {
    const fn = readFileSync(join(root, 'netlify/functions/render-post-video-background.ts'), 'utf8');
    assert.ok(fn.includes('resolveCaptionTrack(db, post.audioOverlays, job.organisationId).catch('), 'a caption read failure must not fail the render');
    assert.ok(fn.includes('...(captions ? { captions } : {}),'), 'captions must be absent, not empty, when nothing is said');
    const pr = readFileSync(join(root, 'src/lib/post-render.ts'), 'utf8');
    assert.ok(pr.includes("p?.kind !== 'voiceover'"), 'only voiceover assets carry words');
    assert.ok(pr.includes('eq(contentAssets.organisationId, orgId)'), 'caption words are org-scoped like the audio');
});

check('the composition treats captions as optional and loads the caption face', () => {
    const tsx = readFileSync(join(root, 'remotion/PostOverlay.tsx'), 'utf8');
    assert.ok(tsx.includes('captions?: CaptionTrack;'), 'captions must be optional for old inputs');
    assert.ok(tsx.includes('captions.cues.length ? captions : null'), 'an empty track draws nothing');
    assert.ok(tsx.includes('...(captionTrack ? [captionTrack.style?.font || CAPTION_FONT_ID] : [])'), 'the caption font (the chosen one) must load before the first frame');
    assert.ok(tsx.includes('track.style || DEFAULT_CAPTION_STYLE'), 'a track queued before styles existed renders the original look');
    assert.ok(!/from ['"](node:|fs|path|drizzle)/.test(readFileSync(join(root, 'src/lib/captions.ts'), 'utf8')), 'captions.ts is bundled into Remotion — no Node imports');
});

check('the script puts punctuation back on bare transcribed words, so phrases break at sentence ends', () => {
    const words = [
        { word: 'before', start: 0, end: 0.3 }, { word: 'they', start: 0.3, end: 0.5 }, { word: 'become', start: 0.5, end: 0.8 },
        { word: 'breakdowns', start: 0.8, end: 1.3 }, { word: 'Brightside', start: 1.5, end: 2.0 }, { word: 'Plumbing', start: 2.0, end: 2.4 },
    ];
    const fixed = withScriptPunctuation(words, 'before they become breakdowns. Brightside Plumbing and Heating.');
    assert.strictEqual(fixed[3].word, 'breakdowns.');
    const cues = buildCaptionCues([{ words: fixed }]);
    assert.ok(!cues.some((c) => c.words.map((w) => w.text).join(' ').includes('breakdowns. Brightside')), 'a sentence end breaks the phrase');
    // A word the speaker said differently keeps its own text; no script leaves the words as they are.
    assert.strictEqual(withScriptPunctuation([{ word: 'gonna', start: 0, end: 1 }], 'going to.')[0].word, 'gonna');
    // The script's spelling wins a one-letter difference in a longer word — never in a short one.
    assert.strictEqual(withScriptPunctuation([{ word: 'Harbor', start: 0, end: 1 }], 'Harbour Yoga.')[0].word, 'Harbour');
    assert.strictEqual(withScriptPunctuation([{ word: 'cat', start: 0, end: 1 }], 'can.')[0].word, 'cat');
    // A short word misheard between two that match takes the script's word ("See views", 2026-11-02);
    // a gap that isn't one-for-one keeps what was heard.
    const heard = (s: string) => s.split(' ').map((word, i) => ({ word, start: i, end: i + 1 }));
    assert.deepStrictEqual(withScriptPunctuation(heard('See views from every'), 'Sea views from every single mat.').map((w) => w.word), ['See', 'views', 'from', 'every']);
    assert.deepStrictEqual(withScriptPunctuation(heard('Mats provided. See views from every'), 'Mats provided. Sea views from every mat.').map((w) => w.word), ['Mats', 'provided.', 'Sea', 'views', 'from', 'every']);
    assert.deepStrictEqual(withScriptPunctuation(heard('Mats are kindly provided'), 'Mats are provided.').map((w) => w.word), ['Mats', 'are', 'kindly', 'provided.']);
    assert.deepStrictEqual(withScriptPunctuation(words, ''), words);
});

check('caption styles: unknown values fall back, and the default is the original look', () => {
    const d = normalizeCaptionStyle(undefined);
    assert.deepStrictEqual(d, DEFAULT_CAPTION_STYLE);
    const s = normalizeCaptionStyle({ mode: 'word', position: 'top', size: 'huge', font: 'Wingdings', textColor: '#ffeeaa', highlight: 'red', box: 'yes' });
    assert.deepStrictEqual([s.mode, s.position, s.size, s.font, s.textColor, s.highlight, s.box], ['word', 'top', 'medium', 'Impact', '#FFEEAA', 'brand', false]);
    assert.strictEqual(captionLayout(1920, { ...d, position: 'top' }).topPct, 14);
    assert.ok(captionLayout(1920, { ...d, size: 'large' }).fontSizePx > captionLayout(1920).fontSizePx);
    const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ').map((word, i) => ({ word, start: i * 0.3, end: i * 0.3 + 0.25 }));
    assert.strictEqual(buildCaptionCues([{ words }], 'word').length, 12);
    assert.ok(buildCaptionCues([{ words }], 'phrase').length < buildCaptionCues([{ words }], 'highlight').length);
    // The style survives the save sanitiser.
    const saved = sanitiseAudioOverlays([{ assetId: 9, volume: 1, captions: true, captionStyle: { mode: 'phrase', box: true } }]);
    assert.strictEqual(saved![0].captionStyle!.mode, 'phrase');
    assert.strictEqual(saved![0].captionStyle!.box, true);
});

check('text boxes are timed to the words that say them, in order, never overlapping', () => {
    const said = 'Three signs your boiler needs a service. First the flame. It should be blue. Yellow or orange is a warning. Second listen out for banging.';
    const words = said.split(' ').map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.3 }));
    const r = alignTextToWords([
        { id: 'a', text: 'Is your boiler ready?' },
        { id: 'b', text: 'Sign 1: Yellow flame' },
        { id: 'c', text: 'Sign 2: Strange noises' },
        { id: 'd', text: 'Banging?' },
    ], words, 2);
    assert.deepStrictEqual(r.unmatched, ['c']);
    assert.strictEqual(r.timings.a.startS, Math.round((2 + 2 * 0.4) * 10) / 10);   // "your boiler"
    assert.ok(r.timings.b.startS > r.timings.a.startS && r.timings.d.startS > r.timings.b.startS);
    assert.ok(r.timings.a.endS <= r.timings.b.startS);
    // A box already near its moment stays near it, even when a later sentence shares more of its words
    // (Brightside, 2026-11-02: "Is your boiler ready?" jumped to "…your boiler is never normal").
    const said2 = 'Three signs your boiler needs a service. Banging from your boiler is never normal.';
    const w2 = said2.split(' ').map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 }));
    assert.strictEqual(alignTextToWords([{ id: 'a', text: 'Is your boiler ready?', startS: 0 }], w2).timings.a.startS, 1);
    assert.ok(alignTextToWords([{ id: 'a', text: 'Is your boiler ready?' }], w2).timings.a.startS === 1, 'no hint: the first place after the last box');
});

console.log(`\n${passed} checks passed`);
