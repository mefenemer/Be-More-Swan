// tests/brand-card.test.ts
// Branded text cards: the brand kit (src/utils/brand-kit.ts), the card renderer
// (src/lib/brand-card.ts) and the stock↔card rotation (src/utils/media-resolver.ts).
//
// Run:  npx tsx tests/brand-card.test.ts
//
// The invariants worth protecting, in order of how badly they'd hurt in production:
//   1. A card is never illegible. The renderer picks foreground colours at runtime against a
//      palette nobody has eyeballed, so pale-accent orgs must fall back rather than ship white
//      on cream.
//   2. An org never borrows another org's brand. A missing/garbage kit renders monochrome —
//      never Be More Swan's pink on a client's post.
//   3. Enabling both stock and brand_card actually mixes them. Without rotation the lower-priority
//      source would never run once, and the feature would look like it had never shipped.
//   4. A missing cardHeadline still yields a card, with no hashtags/links/emoji on it.
// Pure logic + one real render — no DB required.

import assert from 'node:assert';
import {
    normalizeBrandKit, normalizeHex, contrastRatio, readableInkOn, resolveCardEditorKit,
    DEFAULT_BRAND_KIT, BE_MORE_SWAN_BRAND_KIT, MIN_DISPLAY_CONTRAST,
} from '../src/utils/brand-kit';
import {
    headlineFromCaption, pickVariant, resolveCardPalette, headlineFontSize,
    renderBrandCard, normalizeCardLayout, MAX_HEADLINE_CHARS, DEFAULT_CARD_LAYOUT,
    estimateWrappedLines,
} from '../src/lib/brand-card';
import { overlaysFingerprint, isBakedFor } from '../src/lib/post-render';
import { pickFaceUrl } from '../src/lib/brand-card-webfont';
import { rotateSources, resolveMediaForPost } from '../src/utils/media-resolver';
import { normalizeMediaSources, DEFAULT_ORDER } from '../src/utils/media-sources';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const tests: Array<() => Promise<void>> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push(() => check(name, fn));

// ── Brand kit ─────────────────────────────────────────────────────────────────────────────────

test('hex colours are normalized, and non-colours rejected', () => {
    assert.equal(normalizeHex('#FF007F'), '#ff007f');
    assert.equal(normalizeHex('#f0a'), '#ff00aa');
    assert.equal(normalizeHex('  #FdFcF9 '), '#fdfcf9');
    assert.equal(normalizeHex('red'), null);
    assert.equal(normalizeHex('#12345'), null);
    assert.equal(normalizeHex(null), null);
});

test('a missing or garbage kit falls back to neutral monochrome, never a borrowed brand', () => {
    for (const raw of [null, undefined, 'nonsense', 42, { primaryColor: 'chartreuse' }]) {
        const kit = normalizeBrandKit(raw);
        assert.equal(kit.primaryColor, DEFAULT_BRAND_KIT.primaryColor, `leaked a palette for ${JSON.stringify(raw)}`);
        assert.notEqual(kit.primaryColor, BE_MORE_SWAN_BRAND_KIT.primaryColor, 'default kit is Be More Swan pink');
        assert.equal(kit.source, 'default');
    }
});

test('a half-filled kit keeps what it has and defaults the rest', () => {
    const kit = normalizeBrandKit({ primaryColor: '#0055AA', wordmark: '  Acme   Coffee  ', source: 'website' });
    assert.equal(kit.primaryColor, '#0055aa');
    assert.equal(kit.wordmark, 'Acme Coffee');
    assert.equal(kit.backgroundColor, DEFAULT_BRAND_KIT.backgroundColor);
    assert.equal(kit.source, 'website');
});

test('only http(s) logo URLs survive normalization', () => {
    assert.equal(normalizeBrandKit({ logoUrl: 'https://example.com/l.png' }).logoUrl, 'https://example.com/l.png');
    assert.equal(normalizeBrandKit({ logoUrl: 'javascript:alert(1)' }).logoUrl, null);
    assert.equal(normalizeBrandKit({ logoUrl: 'data:image/png;base64,AAAA' }).logoUrl, null);
    assert.equal(normalizeBrandKit({ logoUrl: 'not a url' }).logoUrl, null);
});

test('contrast maths matches WCAG at the known extremes', () => {
    assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01);
    assert.ok(Math.abs(contrastRatio('#ffffff', '#ffffff') - 1) < 0.01);
});

test('readableInkOn prefers white wherever it is legible, and falls back only when it is not', () => {
    assert.equal(readableInkOn('#1f1e1b'), '#ffffff');
    // The regression this guards: dark ink out-contrasts white on the BMS pink (4.4 vs 3.8), so a
    // max-contrast rule set every bold card in near-black. White clears the floor here, so it wins.
    assert.equal(readableInkOn('#ff007f'), '#ffffff');
    assert.ok(contrastRatio('#1f1e1b', '#ff007f') > contrastRatio('#ffffff', '#ff007f'), 'premise of the above changed');
    assert.equal(readableInkOn('#ffe600'), '#1f1e1b');   // pale yellow — white would be unreadable
    assert.equal(readableInkOn('#ffffff'), '#1f1e1b');
});

// ── Palette resolution ────────────────────────────────────────────────────────────────────────

test('bold variant fills with the accent and writes in a readable ink', () => {
    const p = resolveCardPalette(BE_MORE_SWAN_BRAND_KIT, 'bold');
    assert.equal(p.background, '#ff007f');
    assert.equal(p.headline, '#ffffff');
    assert.ok(contrastRatio(p.headline, p.background) >= MIN_DISPLAY_CONTRAST);
});

test('bold variant on a PALE accent flips to dark type rather than shipping white-on-pale', () => {
    const p = resolveCardPalette(normalizeBrandKit({ primaryColor: '#ffe600' }), 'bold');
    assert.equal(p.background, '#ffe600');
    assert.notEqual(p.headline, '#ffffff');
    assert.ok(contrastRatio(p.headline, p.background) >= MIN_DISPLAY_CONTRAST);
});

test('light variant sets the headline in the accent when it is readable on the canvas', () => {
    const p = resolveCardPalette(BE_MORE_SWAN_BRAND_KIT, 'light');
    assert.equal(p.background, '#fdfcf9');
    assert.equal(p.headline, '#ff007f');
});

test('light variant demotes an unreadable accent to ink and keeps the card legible', () => {
    // Pale mint on cream: nominally the brand colour, in practice invisible as display type.
    const p = resolveCardPalette(normalizeBrandKit({ primaryColor: '#d8f5e3', backgroundColor: '#fdfcf9' }), 'light');
    assert.notEqual(p.headline, '#d8f5e3');
    assert.ok(contrastRatio(p.headline, p.background) >= MIN_DISPLAY_CONTRAST);
});

test('every variant of every kit under test clears the display-contrast floor', () => {
    const kits = [
        DEFAULT_BRAND_KIT, BE_MORE_SWAN_BRAND_KIT,
        normalizeBrandKit({ primaryColor: '#ffe600' }),
        normalizeBrandKit({ primaryColor: '#d8f5e3', backgroundColor: '#fdfcf9' }),
        normalizeBrandKit({ primaryColor: '#000080', backgroundColor: '#ffffff' }),
        normalizeBrandKit({ primaryColor: '#ffffff', backgroundColor: '#ffffff' }),
    ];
    for (const kit of kits) {
        for (const variant of ['light', 'bold'] as const) {
            const p = resolveCardPalette(kit, variant);
            assert.ok(
                contrastRatio(p.headline, p.background) >= MIN_DISPLAY_CONTRAST,
                `${variant} card on ${kit.primaryColor}/${kit.backgroundColor} is illegible`,
            );
        }
    }
});

// ── Headline salvage ──────────────────────────────────────────────────────────────────────────

test('a headline salvaged from a caption carries no hashtags, links or handles', () => {
    const caption = 'You did not start a business to become an ops manager. Hire the role, not the tool.\n\n'
        + 'See how at https://bemoreswan.com — ask @bemoreswan 🚀 #HireNotLearn #BeMoreSwan';
    const h = headlineFromCaption(caption)!;
    assert.ok(h, 'no headline salvaged');
    assert.ok(!/[#@]/.test(h), `furniture left on the card: ${h}`);
    assert.ok(!/https?:/.test(h), `link left on the card: ${h}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(h), `emoji left on the card: ${h}`);
    assert.ok(h.length <= MAX_HEADLINE_CHARS);
});

test('a caption with no short sentence is clipped at a word boundary, not mid-word', () => {
    const caption = 'The average founder spends nineteen hours every single week on administrative work that '
        + 'nobody ever needed their particular brain for and it quietly eats the whole business';
    const h = headlineFromCaption(caption)!;
    assert.ok(h.length <= MAX_HEADLINE_CHARS);
    assert.ok(caption.startsWith(h), 'clip did not come from the start of the caption');
    assert.ok(!h.endsWith(' '), 'trailing space left after the clip');
    // The clip must land on a real word — the next char in the source is a space or the end.
    assert.ok([' ', undefined].includes(caption[h.length]), `clipped mid-word: …${h.slice(-12)}`);
});

test('a caption with nothing usable yields no headline rather than a junk card', () => {
    assert.equal(headlineFromCaption('#BeMoreSwan #HireNotLearn'), null);
    assert.equal(headlineFromCaption('   '), null);
    assert.equal(headlineFromCaption('🚀🚀🚀'), null);
});

// ── Variant rotation + type sizing ────────────────────────────────────────────────────────────

test('consecutive posts alternate polarity, and the same post always re-renders the same', () => {
    assert.notEqual(pickVariant(10), pickVariant(11));
    assert.equal(pickVariant(10), pickVariant(10));
    assert.equal(pickVariant(10), pickVariant(12));
});

test('longer headlines get smaller type, and sizes scale with the canvas', () => {
    assert.ok(headlineFontSize(20, 1080) > headlineFontSize(60, 1080));
    assert.ok(headlineFontSize(60, 1080) > headlineFontSize(MAX_HEADLINE_CHARS, 1080));
    assert.ok(headlineFontSize(40, 1920) > headlineFontSize(40, 1080));
});

// ── Overlay fingerprint ───────────────────────────────────────────────────────────────────────
// A photo's text overlays are flattened by the browser and the result is attached as a new asset,
// stamped with a fingerprint of the design it came from. approve-post refuses to publish unless that
// stamp matches the post's CURRENT design — so anything the fingerprint fails to notice is a change
// that publishes with the old pixels on it.
//
// This is written field-by-field on purpose. The first version of overlaysFingerprint was written
// from memory and hashed fontSize/fontWeight/align/w/h (none of which exist on Overlay) while
// missing fontSizePct, boxStroke, boxFill and boxOpacity — every one of the restyling controls. It
// looked completely reasonable and would have shipped stale images the moment anyone recoloured a
// caption box.

const BASE_OVERLAY = {
    id: 'a', text: 'Hello', x: 0.5, y: 0.5,
    fontFamily: 'Arial', fontSizePct: 0.07, color: '#ffffff',
    boxStroke: null, boxFill: '#000000', boxOpacity: 0.5,
};

test('every drawn property of an overlay changes its fingerprint', () => {
    // Mirrors Overlay in src/lib/overlay-geometry.ts. If a property is added there and not here,
    // this list is the reminder — and the assertion below is what fails if it is not hashed.
    const variations: Array<[string, unknown]> = [
        ['text', 'Goodbye'],
        ['x', 0.25], ['y', 0.75],
        ['fontFamily', 'Georgia'],
        ['fontSizePct', 0.12],
        ['color', '#ff0000'],
        ['boxStroke', '#00ff00'],
        ['boxFill', '#123456'],
        ['boxOpacity', 0.9],
        ['startS', 2], ['endS', 5],
    ];
    const base = overlaysFingerprint([BASE_OVERLAY]);
    for (const [field, value] of variations) {
        const changed = overlaysFingerprint([{ ...BASE_OVERLAY, [field]: value }]);
        assert.notEqual(changed, base,
            `changing '${field}' did not change the fingerprint — a post restyled this way would publish its OLD flattened image`);
    }
});

test('the fingerprint ignores what does not affect the picture', () => {
    const base = overlaysFingerprint([BASE_OVERLAY]);
    // `id` is a client-generated handle. Hashing it would force a needless re-bake on every reopen.
    assert.equal(overlaysFingerprint([{ ...BASE_OVERLAY, id: 'totally-different' }]), base,
        'the overlay id is not drawn, so it must not invalidate a good bake');
    // An empty box is invisible, so it is not part of the design (renderableOverlays drops it).
    assert.equal(overlaysFingerprint([BASE_OVERLAY, { ...BASE_OVERLAY, id: 'b', text: '   ' }]), base,
        'a blank text box draws nothing and must not count');
});

test('the fingerprint separates fields, so a shift cannot look identical', () => {
    // Concatenating without a separator would make {x:1,y:12} and {x:11,y:2} the same string — two
    // genuinely different designs sharing a fingerprint, which is a stale image that never re-bakes.
    const a = overlaysFingerprint([{ ...BASE_OVERLAY, x: 1, y: 12 }]);
    const b = overlaysFingerprint([{ ...BASE_OVERLAY, x: 11, y: 2 }]);
    assert.notEqual(a, b, 'adjacent values must not be able to run together');
    // Order is part of the design: overlays paint in array order, so a reorder changes what covers what.
    const one = { ...BASE_OVERLAY, id: 'one', text: 'One' };
    const two = { ...BASE_OVERLAY, id: 'two', text: 'Two' };
    assert.notEqual(overlaysFingerprint([one, two]), overlaysFingerprint([two, one]),
        'reordering overlays changes which one is on top');
});

test('isBakedFor fails closed on anything but a current, matching stamp', () => {
    const overlays = [BASE_OVERLAY];
    const good = { kind: 'overlay_bake', postId: 7, overlaysHash: overlaysFingerprint(overlays), at: 'now' };
    assert.equal(isBakedFor(good, 7, overlays), true, 'a current stamp for this post is the one accepted case');

    assert.equal(isBakedFor(null, 7, overlays), false, 'an unstamped asset is not baked');
    assert.equal(isBakedFor({ kind: 'brand_card' }, 7, overlays), false, 'a brand card is not an overlay bake');
    assert.equal(isBakedFor({ ...good, postId: 8 }, 7, overlays), false, "another post's bake does not count");
    // The stale case — baked, then the design was edited. This is the one identity alone cannot catch.
    assert.equal(isBakedFor(good, 7, [{ ...BASE_OVERLAY, text: 'Edited after baking' }]), false,
        'a stamp from an older design must read as NOT baked, or the edit never reaches the picture');
});

// ── Wrapped-line estimate ─────────────────────────────────────────────────────────────────────
// The headline box is sized from this count and drawn with justifyContent:center + overflow:hidden.
// Under-counting therefore does not spill off the bottom — it clips the text at BOTH ends, eating
// the first and last lines. A card shipped to production with "Stop adding tools to" cut off at the
// top and "instead." cut off at the bottom, because the old estimate divided characters by
// chars-per-line and ignored word boundaries.

test('line estimate follows word boundaries, not character division', () => {
    // The exact production case: 66 chars at 23 chars/line. Character packing says 3; greedy word
    // wrap — what satori actually does — needs 4.
    const headline = 'Stop adding tools to your stack. Hire someone to use them instead.';
    assert.equal(Math.ceil(headline.length / 23), 3, 'guard: this is the estimate that was wrong');
    assert.equal(estimateWrappedLines(headline, 23), 4,
        'a headline whose words straddle the wrap point needs the line the character count denies it');
});

test('the estimate never under-counts a real greedy wrap', () => {
    // Property check across widths and shapes: re-wrap the text the same way a renderer would and
    // assert the estimate is never optimistic. Equality is the norm; being over is survivable
    // (a slightly tall box), being under is what clips words away.
    const samples = [
        'Stop adding tools to your stack. Hire someone to use them instead.',
        'One',
        'Supercalifragilisticexpialidocious antidisestablishmentarianism',
        'Short words in a long line that has to wrap somewhere sensible for once',
        'Two\nparagraphs, each\nwrapping on their own',
        'a b c d e f g h i j k l m n o p q r s t u v w x y z',
    ];
    for (const text of samples) {
        for (const perLine of [8, 12, 17, 23, 40]) {
            let actual = 0;
            for (const para of text.split('\n')) {
                const words = para.split(/\s+/).filter(Boolean);
                if (!words.length) { actual += 1; continue; }
                actual += 1;
                let used = 0;
                for (const w of words) {
                    const cand = used === 0 ? w.length : used + 1 + w.length;
                    if (cand <= perLine || used === 0) used = cand;
                    else { actual += 1; used = w.length; }
                }
            }
            assert.ok(estimateWrappedLines(text, perLine) >= actual,
                `under-counted "${text.slice(0, 24)}…" at ${perLine}/line: said ${estimateWrappedLines(text, perLine)}, needs ${actual}`);
        }
    }
});

test('a headline always fits its box — every ratio, longest allowed text', () => {
    // Shrink-to-fit is the renderer's job because satori has no such thing. The old code clamped the
    // BOX to the safe area while the text kept its size, which is precisely how text ends up drawn
    // outside the box it was measured for.
    const worst = 'W'.repeat(0) + 'Supercalifragilistic expialidocious antidisestablishment '.repeat(4);
    const headline = worst.slice(0, MAX_HEADLINE_CHARS).trim();
    for (const [w, h] of [[1080, 1080], [1080, 1350], [1080, 1920], [1920, 1080]] as const) {
        const pad = Math.round(w * 0.083);
        const rail = w - pad * 2;
        const maxHeight = h - pad * 2;
        const minSize = Math.round(w * 0.03);
        let size = headlineFontSize(headline.length, w);
        let lines = estimateWrappedLines(headline, Math.max(1, Math.floor(rail / (size * 0.52))));
        while (size > minSize && Math.round(lines * size * 1.14) > maxHeight) {
            size = Math.max(minSize, Math.round(size * 0.94));
            lines = estimateWrappedLines(headline, Math.max(1, Math.floor(rail / (size * 0.52))));
        }
        assert.ok(Math.round(lines * size * 1.14) <= maxHeight,
            `a ${MAX_HEADLINE_CHARS}-char headline still overflows the safe area at ${w}x${h}`);
    }
});

// ── Source rotation ───────────────────────────────────────────────────────────────────────────

test('brand_card is a valid media source and rides in the default matrix', () => {
    assert.deepEqual(normalizeMediaSources(['brand_card']), ['brand_card']);
    assert.deepEqual(normalizeMediaSources(['brand-card']), ['brand_card']);  // hyphenated spelling
    assert.ok(DEFAULT_ORDER.includes('brand_card'));
    assert.ok(landmark(DEFAULT_ORDER, 'brand_card') < landmark(DEFAULT_ORDER, 'ai'), 'cards must be tried before paid AI generation');
});

test('rotation alternates stock and brand_card so neither starves', () => {
    const order = ['manual', 'stock', 'brand_card', 'ai'] as const;
    assert.deepEqual(rotateSources([...order], 2), ['manual', 'stock', 'brand_card', 'ai']);
    assert.deepEqual(rotateSources([...order], 3), ['manual', 'brand_card', 'stock', 'ai']);
    // Positions trade, so every other source keeps its own priority.
    assert.equal(rotateSources([...order], 3)[0], 'manual');
    assert.equal(rotateSources([...order], 3)[3], 'ai');
});

test('rotation is a no-op unless BOTH sources are enabled', () => {
    assert.deepEqual(rotateSources(['manual', 'stock', 'ai'], 3), ['manual', 'stock', 'ai']);
    assert.deepEqual(rotateSources(['manual', 'brand_card'], 3), ['manual', 'brand_card']);
});

// The resolver is where the drafting job actually reaches a card, so the wiring is worth asserting
// end-to-end rather than trusting that a new branch in a for-loop is hooked up. No DB or network:
// with only brand_card enabled the other branches are never entered.
const noDb = null as never;

test('the resolver reaches the brand-card renderer and reports the right source', async () => {
    let called = 0;
    const r = await resolveMediaForPost(noDb, {
        assistant: { mediaSources: ['brand_card'] },
        orgId: 1, userId: 1, context: 'anything', mediaType: 'image',
        renderBrandCard: async () => { called++; return 4242; },
    });
    assert.deepEqual(r, { ok: true, assetId: 4242, source: 'brand_card' });
    assert.equal(called, 1);
});

test('a failed card render falls through instead of failing the post', async () => {
    const r = await resolveMediaForPost(noDb, {
        assistant: { mediaSources: ['brand_card'] },
        orgId: 1, userId: 1, context: 'anything', mediaType: 'image',
        // What an unconfigured R2 or a missing headline actually does.
        renderBrandCard: async () => { throw new Error('brand_card_requires_r2'); },
    });
    assert.equal(r.ok, false);
    assert.equal((r as { lastError?: string }).lastError, 'brand_card_requires_r2');
});

test('video slots skip brand cards entirely — there is no typographic video', async () => {
    let called = 0;
    const r = await resolveMediaForPost(noDb, {
        assistant: { mediaSources: ['brand_card'] },
        orgId: 1, userId: 1, context: 'anything', mediaType: 'video',
        renderBrandCard: async () => { called++; return 1; },
    });
    assert.equal(called, 0, 'a still card was offered for a video slot');
    assert.equal(r.ok, false);
});

// ── Web font selection ────────────────────────────────────────────────────────────────────────
// Real Google Fonts CSS: one @font-face per script subset per weight, each labelled by a comment.

const GF_CSS = `/* devanagari */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400;
  src: url(https://fonts.gstatic.com/s/poppins/v24/devanagari-400.woff) format('woff'); }
/* latin-ext */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400;
  src: url(https://fonts.gstatic.com/s/poppins/v24/latinext-400.woff) format('woff'); }
/* latin */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400;
  src: url(https://fonts.gstatic.com/s/poppins/v24/latin-400.woff) format('woff'); }
/* devanagari */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 700;
  src: url(https://fonts.gstatic.com/s/poppins/v24/devanagari-700.woff) format('woff'); }
/* latin */
@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 700;
  src: url(https://fonts.gstatic.com/s/poppins/v24/latin-700.woff) format('woff'); }`;

test('the latin subset is chosen at the requested weight, not the first url in the file', () => {
    // The bug this guards: taking the first/last url() picked a Devanagari subset, which contains
    // none of the glyphs a caption needs — every card would have rendered blank.
    assert.equal(pickFaceUrl(GF_CSS, 400), 'https://fonts.gstatic.com/s/poppins/v24/latin-400.woff');
    assert.equal(pickFaceUrl(GF_CSS, 700), 'https://fonts.gstatic.com/s/poppins/v24/latin-700.woff');
});

test('woff is accepted — Google serves it for static families even to an ancient user-agent', () => {
    assert.ok(pickFaceUrl(GF_CSS, 400)!.endsWith('.woff'));
    const ttf = "@font-face { font-weight: 400; src: url(https://fonts.gstatic.com/a/x.ttf) format('truetype'); }";
    assert.equal(pickFaceUrl(ttf, 400), 'https://fonts.gstatic.com/a/x.ttf');
});

test('a family with no subset comments and no matching weight still resolves', () => {
    const plain = "@font-face { font-family: 'X'; font-weight: 500; src: url(https://fonts.gstatic.com/a/only.woff); }";
    assert.equal(pickFaceUrl(plain, 400), 'https://fonts.gstatic.com/a/only.woff');
    assert.equal(pickFaceUrl('', 400), null);
});

// ── The renderer itself ───────────────────────────────────────────────────────────────────────

test('renderBrandCard produces a real PNG at the slot dimensions, in both polarities', async () => {
    for (const [variant, ratio, w, h] of [
        ['light', '1:1', 1080, 1080],
        ['bold', '4:5', 1080, 1350],
        ['light', '9:16', 1080, 1920],
        ['bold', '16:9', 1920, 1080],
    ] as const) {
        const card = await renderBrandCard({
            headline: 'You did not start a business to become an ops manager',
            kit: BE_MORE_SWAN_BRAND_KIT, aspectRatio: ratio, variant,
        });
        assert.equal(card.width, w);
        assert.equal(card.height, h);
        assert.equal(card.variant, variant);
        // PNG magic number — proves resvg rasterised rather than handing back an SVG string.
        assert.deepEqual([...card.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${ratio} ${variant} is not a PNG`);
        assert.ok(card.png.byteLength > 1000, 'suspiciously small PNG');
    }
});

test('the same post and headline render byte-identically (a retry cannot drift)', async () => {
    const args = { headline: 'Hire the role, not the tool', kit: BE_MORE_SWAN_BRAND_KIT, seed: 7 } as const;
    const [a, b] = await Promise.all([renderBrandCard({ ...args }), renderBrandCard({ ...args })]);
    assert.deepEqual(a.png, b.png);
    assert.equal(a.variant, 'bold');   // seed 7 is odd
});

test('a longest-allowed headline still renders on the tightest ratio', async () => {
    const card = await renderBrandCard({
        headline: 'x'.repeat(MAX_HEADLINE_CHARS),
        kit: DEFAULT_BRAND_KIT, aspectRatio: '16:9', variant: 'light',
    });
    assert.ok(card.png.byteLength > 1000);
});

test('an empty headline is refused rather than rendering a blank card', async () => {
    await assert.rejects(() => renderBrandCard({ headline: '   ', kit: DEFAULT_BRAND_KIT }));
});

// ── Which kit the review-time editor opens with ───────────────────────────────────────────────
// Found on PROD: both of org 37's brand cards predate render_params, so the editor had nothing
// stored to seed from. The neutral default would have previewed a pink card in monochrome with no
// name and no website, then baked that over the real card on save.

test('a card with no stored kit falls back to the ORG kit, not the neutral default', () => {
    const orgKit = {
        source: 'manual', wordmark: 'BE MORE SWAN', website: 'bemoreswan.com',
        primaryColor: '#ff007f', backgroundColor: '#fdfcf9', textColor: '#1f1e1b', logoUrl: null,
    };
    for (const missing of [null, undefined]) {
        const { kit } = resolveCardEditorKit(missing, orgKit, 'Be More Swan');
        assert.equal(kit.primaryColor, '#ff007f', 'the org accent was lost to the neutral default');
        assert.equal(kit.wordmark, 'BE MORE SWAN');
        assert.equal(kit.website, 'bemoreswan.com');
        assert.notEqual(kit.primaryColor, DEFAULT_BRAND_KIT.primaryColor);
    }
});

test('a stored kit always wins, and never picks up the org name behind the user', () => {
    const storedKit = { source: 'manual', primaryColor: '#0000ff', wordmark: null, website: null };
    const orgKit = { source: 'manual', primaryColor: '#ff007f', wordmark: 'BE MORE SWAN' };
    const { kit, orgName } = resolveCardEditorKit(storedKit, orgKit, 'Be More Swan');
    assert.equal(kit.primaryColor, '#0000ff', 'the org kit overrode a kit the card had recorded');
    // A card that recorded its own kit has already said what it should show; injecting the org
    // name would make an eyebrow appear on a card the user had deliberately left without one.
    assert.equal(orgName, null);
});

test('org name rides alongside the kit rather than being baked into it as a wordmark', () => {
    const { kit, orgName } = resolveCardEditorKit(null, { primaryColor: '#ff007f' }, '  Be More Swan  ');
    assert.equal(kit.wordmark, null, 'a derived name must not become a stored wordmark');
    assert.equal(orgName, 'Be More Swan', 'and must be trimmed for the renderer');
    for (const blank of [null, undefined, '   ']) {
        assert.equal(resolveCardEditorKit(null, {}, blank).orgName, null);
    }
});

test('an org with no kit either still lands on the neutral default, never a borrowed brand', () => {
    const { kit } = resolveCardEditorKit(null, null, null);
    assert.deepEqual(kit, DEFAULT_BRAND_KIT);
    assert.notEqual(kit.primaryColor, BE_MORE_SWAN_BRAND_KIT.primaryColor);
});

test('the org-kit fallback actually renders a branded card, not a blank one', async () => {
    const orgKit = {
        source: 'manual', wordmark: null, website: 'bemoreswan.com',
        primaryColor: '#ff007f', backgroundColor: '#fdfcf9', textColor: '#1f1e1b',
    };
    const { kit, orgName } = resolveCardEditorKit(undefined, orgKit, 'Be More Swan');
    const card = await renderBrandCard({ headline: 'Reopened from a pre-render_params card', kit, orgName });
    // Both elements must be placeable — under the old fallback both reported unavailable, which
    // is what disabled the toggles and dropped the furniture off the card.
    assert.equal(card.elements.wordmark.available, true, 'the org name did not reach the eyebrow');
    assert.equal(card.elements.website.available, true, 'the website was lost');

    const neutral = await renderBrandCard({ headline: 'Reopened from a pre-render_params card', kit: DEFAULT_BRAND_KIT });
    assert.notDeepEqual(card.png, neutral.png, 'the fallback rendered the same as the neutral default');
});

// ── Element visibility and placement ──────────────────────────────────────────────────────────
// The reviewer can now hide and drag the company name and the website independently. The values
// arrive from a browser and are stored as JSON, so the ONLY thing standing between a junk `y` and
// a card with its wordmark printed off the canvas is normalizeCardLayout and the render clamp.

test('a missing, partial or junk layout falls back to the original fixed placement', () => {
    for (const raw of [null, undefined, 'nonsense', 42, {}, { wordmark: 'left' }]) {
        assert.deepEqual(normalizeCardLayout(raw), DEFAULT_CARD_LAYOUT, `bad fallback for ${JSON.stringify(raw)}`);
    }
    // A half-specified element keeps the default for the fields it left out.
    assert.deepEqual(
        normalizeCardLayout({ website: { align: 'right' } }).website,
        { show: true, align: 'right', y: 1, x: null },
    );
    // The migration that matters: every card saved before dragging was free has no `x`, and must
    // keep rendering off `align` alone. Nothing may back-fill it.
    assert.strictEqual(normalizeCardLayout({ headline: { align: 'center', y: 0.5 } }).headline.x, null,
        'a stored card with no x must not acquire one — it would move a card nobody touched');
});

test('out-of-range and junk placement values are corrected, never passed through', () => {
    const l = normalizeCardLayout({
        wordmark: { show: 'yes', align: 'middle', y: 9 },
        website: { show: false, align: 'center', y: -4 },
    });
    assert.equal(l.wordmark.show, true, 'a non-boolean show must fall back, not coerce');
    assert.equal(l.wordmark.align, 'left', 'an unknown align must fall back');
    assert.equal(l.wordmark.y, 1, 'y clamps to 0..1');
    assert.equal(l.website.show, false);
    assert.equal(l.website.y, 0);
    // x gets the same treatment, but junk must land on null (use the anchor), never on 0 (hard left).
    const x = normalizeCardLayout({
        headline: { x: 4 }, wordmark: { x: -2 }, website: { x: 'over there' },
    });
    assert.equal(x.headline.x, 1, 'x clamps to 0..1');
    assert.equal(x.wordmark.x, 0);
    assert.strictEqual(x.website.x, null, 'an unparseable x must not become a hard-left drag');
});

test('hiding an element takes it off the card, and says so in the reported geometry', async () => {
    const args = { headline: 'Hire the role, not the tool', kit: BE_MORE_SWAN_BRAND_KIT, seed: 2 } as const;
    const shown = await renderBrandCard(args);
    const hidden = await renderBrandCard({
        ...args,
        layout: { wordmark: { show: false, align: 'left', y: 0 }, website: { show: false, align: 'left', y: 1 } },
    });
    assert.ok(shown.elements.wordmark.shown && shown.elements.website.shown);
    assert.equal(hidden.elements.wordmark.shown, false);
    assert.equal(hidden.elements.website.box, null, 'a hidden element has no box to drag');
    // Still "available" — the org HAS a website, the user just hid it. The editor needs that
    // distinction or it would disable a toggle the user had only just switched off.
    assert.equal(hidden.elements.website.available, true);
    assert.notDeepEqual(shown.png, hidden.png, 'hiding both elements changed nothing on the canvas');
});

test('an org with nothing to draw reports unavailable rather than an empty box', async () => {
    const card = await renderBrandCard({
        headline: 'No furniture here', kit: { ...DEFAULT_BRAND_KIT, wordmark: null, website: null },
    });
    assert.equal(card.elements.wordmark.available, false);
    assert.equal(card.elements.website.available, false);
    assert.equal(card.elements.wordmark.box, null);
});

test('an out-of-range y on an UN-dragged element is clamped to the safe area, on every ratio', async () => {
    // No `x` on either element, so neither counts as hand-placed and both keep the safe-area rule.
    // (What a hand-placed element does instead is two tests below.)
    for (const ratio of ['1:1', '4:5', '9:16', '16:9'] as const) {
        const card = await renderBrandCard({
            headline: 'Placement must never print off the edge',
            kit: BE_MORE_SWAN_BRAND_KIT, aspectRatio: ratio,
            // Deliberately past both ends: junk that normalizeCardLayout has to correct.
            layout: { wordmark: { show: true, align: 'right', y: 5 }, website: { show: true, align: 'center', y: -5 } },
        });
        const pad = Math.round(card.width * 0.083);
        for (const key of ['wordmark', 'website'] as const) {
            const box = card.elements[key].box!;
            assert.ok(box.top >= pad, `${ratio} ${key} top ${box.top} is above the safe area`);
            assert.ok(box.top + box.height <= card.height - pad,
                `${ratio} ${key} bottom ${box.top + box.height} runs past the safe area`);
            assert.equal(box.left + box.width, card.width - pad, `${ratio} ${key} rail is not the safe width`);
        }
    }
});

test('placement actually moves the pixels, and the same placement re-renders identically', async () => {
    const args = { headline: 'Where this sits is the whole point', kit: BE_MORE_SWAN_BRAND_KIT, seed: 4 } as const;
    const top = { wordmark: { show: true, align: 'left', y: 0 }, website: { show: true, align: 'left', y: 1 } };
    const swapped = { wordmark: { show: true, align: 'right', y: 1 }, website: { show: true, align: 'center', y: 0 } };
    const [a, b, again] = await Promise.all([
        renderBrandCard({ ...args, layout: top }),
        renderBrandCard({ ...args, layout: swapped }),
        renderBrandCard({ ...args, layout: swapped }),
    ]);
    assert.notDeepEqual(a.png, b.png, 'moving both elements produced an identical card');
    assert.deepEqual(b.png, again.png, 'the same layout must re-render byte-identically');
    assert.ok(b.elements.wordmark.box!.top > a.elements.wordmark.box!.top, 'the name did not move down');
    // The layout the caller gets back is the normalized one — that is what gets stored. A layout
    // written before the headline was placeable gains its default, which is where the headline was
    // pinned anyway, so an old card renders unchanged.
    assert.deepEqual(b.layout, {
        headline: DEFAULT_CARD_LAYOUT.headline,
        wordmark: { ...swapped.wordmark, x: null },
        website: { ...swapped.website, x: null },
    });
});

// ── Free horizontal placement ───────────────────────────────────────────────────────────────────
// The three-anchor snap was replaced because it made dragging feel broken — the block jumped
// between thirds. The snap was load-bearing though: it was what made it impossible to drag text off
// the edge of the card. These are the tests for its replacement.
test('a free x moves the block horizontally, and align no longer decides where it sits', async () => {
    const args = { headline: 'Cold brew', kit: BE_MORE_SWAN_BRAND_KIT, seed: 11 } as const;
    const at = (x: number) => renderBrandCard({ ...args, layout: { headline: { show: true, align: 'left', y: 0.5, x } } });
    const [left, mid, right] = await Promise.all([at(0.2), at(0.5), at(0.8)]);
    const [lb, mb, rb] = [left.elements.headline.box!, mid.elements.headline.box!, right.elements.headline.box!];
    assert.ok(lb.left < mb.left && mb.left < rb.left, 'x must move the block, not snap it to thirds');
    assert.notDeepEqual(left.png, right.png, 'a horizontal drag produced an identical card');
    // Free x is a genuinely different position from any anchor, or the drag would still feel snapped.
    const anchored = await renderBrandCard({ ...args, layout: { headline: { show: true, align: 'left', y: 0.5, x: null } } });
    assert.notStrictEqual(mb.left, anchored.elements.headline.box!.left);
});

test('no x, however extreme, can put a block outside the CANVAS', async () => {
    // The guarantee that survives. A long website is the worst case: the widest single-line block,
    // dragged hard against each edge.
    //
    // It used to be the safe area, and that was the "snap": drag the website into the corner and it
    // sprang back to an invisible margin. The safe area is where text is guaranteed legible, which
    // makes it the right DEFAULT and the wrong veto over somebody who deliberately dragged something
    // into the corner. Printing off the card is still impossible — that is what this pins.
    const kit = { ...BE_MORE_SWAN_BRAND_KIT, website: 'willowbrook-coffee-roasters.example.com' };
    for (const ratio of ['1:1', '9:16', '16:9'] as const) {
        for (const x of [0, 0.5, 1]) {
            const card = await renderBrandCard({
                headline: 'A headline long enough that it has to wrap onto several lines', kit, seed: 3,
                aspectRatio: ratio,
                layout: {
                    headline: { show: true, align: 'left', y: 0.5, x },
                    wordmark: { show: true, align: 'left', y: 0, x },
                    website: { show: true, align: 'left', y: 1, x },
                },
            });
            for (const [name, e] of Object.entries(card.elements)) {
                if (!e.box) continue;
                assert.ok(e.box.left >= 0, `${name} at x=${x} on ${ratio} starts left of the canvas`);
                assert.ok(e.box.left + e.box.width <= card.width + 1,
                    `${name} at x=${x} on ${ratio} prints off the card — the one thing free placement must still never do`);
                assert.ok(e.box.top >= 0, `${name} at x=${x} on ${ratio} sits above the canvas`);
                assert.ok(e.box.top + e.box.height <= card.height + 1,
                    `${name} at x=${x} on ${ratio} runs off the bottom`);
            }
        }
    }
});

test('a dragged element CAN sit in the margin — the snap is gone', async () => {
    // The actual request: drag the furniture anywhere on the card, including outside the safe area.
    // Dragging writes both axes at once, so a non-null x is what marks an element as hand-placed.
    const kit = { ...BE_MORE_SWAN_BRAND_KIT, website: 'willowbrook.example.com' };
    const card = await renderBrandCard({
        headline: 'Corner to corner', kit, seed: 7, aspectRatio: '1:1',
        layout: {
            wordmark: { show: true, align: 'left', y: 0, x: 0 },     // hard into the top-left
            website: { show: true, align: 'left', y: 1, x: 1 },      // hard into the bottom-right
        },
    });
    const pad = Math.round(card.width * 0.083);
    const wm = card.elements.wordmark.box!;
    const web = card.elements.website.box!;
    assert.ok(wm.left < pad, `the company name should reach into the margin, but sits at ${wm.left} (pad ${pad})`);
    assert.ok(wm.top < pad, `it should reach the top margin too, but sits at ${wm.top}`);
    assert.ok(web.left + web.width > card.width - pad, 'the website should reach the right margin');
    assert.ok(web.top + web.height > card.height - pad, 'and the bottom margin');
});

test('a block dropped in a corner has room for ALL of its text', async () => {
    // The defect that free placement exposed. Until the safe area stopped holding blocks back from
    // the edge, the width estimate always had the whole rail to be wrong inside. At the edge it has
    // only itself — and it was ~7% short, so "WILLOWBROOK COFFEE" wrapped and lost its second line
    // to overflow:hidden, and a long website lost its final character.
    //
    // Mirrors the renderer's own sizing maths (as the safe-area test mirrors `pad`) and asserts the
    // box is WIDER than a tight estimate — i.e. that the slack which stops the clip is really there.
    const wordmark = 'WILLOWBROOK COFFEE';
    const website = 'willowbrook-coffee-roasters.example.com';
    const card = await renderBrandCard({
        headline: 'Corners', kit: { ...BE_MORE_SWAN_BRAND_KIT, wordmark, website }, seed: 11, aspectRatio: '1:1',
        layout: {
            wordmark: { show: true, align: 'left', y: 0, x: 0 },
            website: { show: true, align: 'left', y: 1, x: 1 },
        },
    });
    const eyebrowSize = Math.round(card.width * 0.024);
    const tracking = Math.round(card.width * 0.004);
    const websiteSize = Math.round(card.width * 0.026);
    const tight = {
        wordmark: Math.ceil(wordmark.length * (eyebrowSize * 0.62 + tracking)),
        website: Math.ceil(website.length * (websiteSize * 0.52)),
    };
    for (const key of ['wordmark', 'website'] as const) {
        const box = card.elements[key].box!;
        assert.ok(box.width > tight[key],
            `${key} box ${box.width} has no slack over the raw estimate ${tight[key]} — this is what clipped the text`);
        // And the slack must not have pushed it off the card, which is the whole reason the estimate
        // was tight in the first place.
        assert.ok(box.left >= 0 && box.left + box.width <= card.width,
            `${key} box ${box.left}..${box.left + box.width} left the canvas`);
    }
});

test('an element nobody dragged still keeps the safe area', async () => {
    // The other half of the rule, and the reason existing cards do not all shift at once: the safe
    // area is still what an untouched y:0 / y:1 means.
    const card = await renderBrandCard({
        headline: 'Untouched', kit: BE_MORE_SWAN_BRAND_KIT, seed: 8, aspectRatio: '1:1',
        layout: {
            wordmark: { show: true, align: 'left', y: 0, x: null },
            website: { show: true, align: 'left', y: 1, x: null },
        },
    });
    const pad = Math.round(card.width * 0.083);
    assert.ok(card.elements.wordmark.box!.top >= pad, 'an un-dragged name must stay at the padding');
    assert.ok(card.elements.website.box!.top + card.elements.website.box!.height <= card.height - pad,
        'an un-dragged website must stay at the padding');
});

test('a card stored before free x renders exactly as it always did', async () => {
    // The migration, end to end: the same layout with `x` absent and with `x: null` must be the
    // same PNG, byte for byte.
    const args = { headline: 'Cold brew season is here', kit: BE_MORE_SWAN_BRAND_KIT, seed: 5 } as const;
    const [legacy, explicit] = await Promise.all([
        renderBrandCard({ ...args, layout: { wordmark: { show: true, align: 'right', y: 0 } } as never }),
        renderBrandCard({ ...args, layout: { wordmark: { show: true, align: 'right', y: 0, x: null } } }),
    ]);
    assert.deepEqual(legacy.png, explicit.png, 'adding the x field must not restyle a single stored card');
});

test('the headline is placeable, and reports the box the editor draws its handle on', async () => {
    const args = { headline: 'Cold brew season is here', kit: BE_MORE_SWAN_BRAND_KIT, seed: 7 } as const;
    const [high, low] = await Promise.all([
        renderBrandCard({ ...args, layout: { headline: { show: true, align: 'left', y: 0.15 } } }),
        renderBrandCard({ ...args, layout: { headline: { show: true, align: 'left', y: 0.85 } } }),
    ]);
    assert.notDeepEqual(high.png, low.png, 'moving the headline produced an identical card');
    const hBox = high.elements.headline.box!;
    const lBox = low.elements.headline.box!;
    assert.ok(lBox.top > hBox.top, 'the headline did not move down');
    // The handle is positioned from this box, so it must describe a real band on the canvas.
    assert.ok(hBox.height > 0 && hBox.width > 0, 'the headline box has no area to grab');
    assert.strictEqual(high.elements.headline.shown, true, 'a card always shows its headline');

    // Clamped into the safe area at both extremes — a headline dragged off the card is not an option.
    const pad = Math.round(high.width * 0.083);
    for (const y of [-5, 0, 1, 9]) {
        const r = await renderBrandCard({ ...args, layout: { headline: { show: true, align: 'left', y } } });
        const box = r.elements.headline.box!;
        assert.ok(box.top >= pad, `y=${y} put the headline above the safe area (top ${box.top} < ${pad})`);
        assert.ok(box.top + box.height <= r.height - pad + 1, `y=${y} put the headline below the safe area`);
    }
});

test('the default layout reproduces the original top-left/bottom-left card', async () => {
    const args = { headline: 'Nothing changes for a card nobody has edited', kit: BE_MORE_SWAN_BRAND_KIT, seed: 3 } as const;
    const implicit = await renderBrandCard(args);
    const explicit = await renderBrandCard({ ...args, layout: DEFAULT_CARD_LAYOUT });
    assert.deepEqual(implicit.png, explicit.png);
    assert.deepEqual(implicit.layout, DEFAULT_CARD_LAYOUT);
    const pad = Math.round(implicit.width * 0.083);
    assert.equal(implicit.elements.wordmark.box!.top, pad, 'the name should sit at the top of the safe area');
    assert.equal(
        implicit.elements.website.box!.top + implicit.elements.website.box!.height,
        implicit.height - pad, 'the website should sit at the bottom of the safe area',
    );
});

// Sequential, and wrapped in a main(): tsx transpiles these to CJS, where top-level await is a
// build error rather than a runtime one.
async function main(): Promise<void> {
    for (const t of tests) await t();
    console.log(`\n${passed}/${tests.length} passed`);
}

void main();
