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
} from '../src/lib/brand-card';
import { pickFaceUrl } from '../src/lib/brand-card-webfont';
import { rotateSources, resolveMediaForPost } from '../src/utils/media-resolver';
import { normalizeMediaSources, DEFAULT_ORDER } from '../src/utils/media-sources';

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

// ── Source rotation ───────────────────────────────────────────────────────────────────────────

test('brand_card is a valid media source and rides in the default matrix', () => {
    assert.deepEqual(normalizeMediaSources(['brand_card']), ['brand_card']);
    assert.deepEqual(normalizeMediaSources(['brand-card']), ['brand_card']);  // hyphenated spelling
    assert.ok(DEFAULT_ORDER.includes('brand_card'));
    assert.ok(DEFAULT_ORDER.indexOf('brand_card') < DEFAULT_ORDER.indexOf('ai'), 'cards must be tried before paid AI generation');
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
        { show: true, align: 'right', y: 1 },
    );
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

test('a dragged element stays inside the safe area on every ratio', async () => {
    for (const ratio of ['1:1', '4:5', '9:16', '16:9'] as const) {
        const card = await renderBrandCard({
            headline: 'Placement must never print off the edge',
            kit: BE_MORE_SWAN_BRAND_KIT, aspectRatio: ratio,
            // Deliberately past both ends: this is what a drag to the very edge sends.
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
    assert.deepEqual(b.layout, { headline: DEFAULT_CARD_LAYOUT.headline, ...swapped });
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
