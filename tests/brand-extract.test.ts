// tests/brand-extract.test.ts
// Website → brand kit extraction (src/utils/brand-extract.ts) and the retry backoff in
// src/utils/brand-kit.ts.
//
// Run:  npx tsx tests/brand-extract.test.ts
//
// The failure that matters here is not "found nothing" — that's a safe outcome that leaves the org
// on the neutral default. It's finding the WRONG thing confidently: shipping every one of a
// client's posts in a colour that is on their site but isn't their brand. So most of these cases
// are about what must LOSE — greys, page canvas, body ink, transparent overlays, a utility
// framework's bulk palette — and about the extractor refusing to answer when it has no real
// candidate. Pure functions only; no network.

import assert from 'node:assert';
import {
    harvestBrandSignals, signalsToBrandKit, parseColour, isAccentCandidate,
} from '../src/utils/brand-extract';
import { shouldExtractBrandKit, normalizeBrandKit, cleanFontFamily, EXTRACT_RETRY_DAYS } from '../src/utils/brand-kit';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const BASE = 'https://harbourandco.com/';

// A realistic SMB homepage: design tokens in :root, a utility palette of greys in bulk, a CTA,
// a Google font, an apple-touch-icon and a share image.
const PAGE = `<!doctype html><html><head>
<title>Harbour &amp; Co — Independent coffee roasters | Bristol</title>
<meta property="og:site_name" content="Harbour &amp; Co">
<meta name="theme-color" content="#0b2545">
<meta property="og:image" content="https://harbourandco.com/share-card.jpg">
<link rel="apple-touch-icon" href="/icons/touch-icon.png">
<link rel="stylesheet" href="/assets/site.css">
<link rel="stylesheet" href="https://cdn.example.net/vendor.css">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --brand-primary: #0b2545; --brand-ink: #12131a; --surface: #ffffff; }
  body { background: #ffffff; color: #12131a; font-family: 'Poppins', sans-serif; }
  .muted { color: #6b7280; } .muted-2 { color: #6b7280; } .muted-3 { color: #6b7280; }
  .border { border-color: #e5e7eb; } .border-2 { border-color: #e5e7eb; }
  .shadow { box-shadow: 0 1px 2px rgba(11, 37, 69, 0.08); }
  .btn-primary { background-color: #0b2545; color: #ffffff; }
</style></head>
<body><header><img src="/img/logo-harbour.png" alt="Harbour and Co logo"></header></body></html>`;

check('a colour literal parses from every form CSS actually uses', () => {
    assert.equal(parseColour('#0B2545'), '#0b2545');
    assert.equal(parseColour('#f0a'), '#ff00aa');
    assert.equal(parseColour('rgb(11, 37, 69)'), '#0b2545');
    assert.equal(parseColour('rgba(11,37,69,0.9)'), '#0b2545');
    assert.equal(parseColour('#0b2545ff'), '#0b2545');
});

check('transparent colours are discarded — a shadow is not a brand colour', () => {
    assert.equal(parseColour('rgba(11,37,69,0.08)'), null);
    assert.equal(parseColour('#0b254511'), null);
    assert.equal(parseColour('rgb(300,0,0)'), null);
    assert.equal(parseColour('chartreuse'), null);
});

check('canvas, ink and greys are excluded as accent candidates', () => {
    assert.equal(isAccentCandidate('#ffffff'), false, 'white is the canvas');
    assert.equal(isAccentCandidate('#000000'), false, 'black is ink');
    assert.equal(isAccentCandidate('#6b7280'), false, 'a neutral grey is not a brand colour');
    assert.equal(isAccentCandidate('#e5e7eb'), false, 'a border grey is not a brand colour');
    assert.equal(isAccentCandidate('#0b2545'), true);
    assert.equal(isAccentCandidate('#ff007f'), true);
});

check('the named brand token wins over colours that merely appear more often', () => {
    const s = harvestBrandSignals(PAGE, BASE);
    assert.equal(s.candidates[0]?.hex, '#0b2545');
    // The greys appear more times than the brand navy; they must not be candidates at all.
    assert.ok(!s.candidates.some((c) => c.hex === '#6b7280'), 'a bulk grey reached the shortlist');
    assert.ok(!s.candidates.some((c) => c.hex === '#ffffff'), 'the page canvas reached the shortlist');
});

check('the evidence for the winning colour is recorded, not just the colour', () => {
    const s = harvestBrandSignals(PAGE, BASE);
    const top = s.candidates[0];
    assert.ok(top.reasons.some((r) => r.includes('brand-primary')), `missing the token reason: ${top.reasons}`);
    assert.ok(top.reasons.some((r) => r.includes('theme-color')), `missing the theme-color reason: ${top.reasons}`);
    assert.ok(top.reasons.some((r) => r.includes('button')), `missing the CTA reason: ${top.reasons}`);
});

check('canvas and ink are picked up as background and text', () => {
    const s = harvestBrandSignals(PAGE, BASE);
    assert.equal(s.lights[0], '#ffffff');
    assert.equal(s.darks[0], '#12131a');
});

check('extraction never sets a logo, however many the page offers', () => {
    // A card renders in two polarities and a fetched mark is usually on transparency, so nothing
    // can tell us it will be visible on both. stripe.com's favicon rendered as a white sliver in
    // the corner of every card; the wordmark always works. Manual kits keep full logo support.
    const kit = signalsToBrandKit(harvestBrandSignals(PAGE, BASE))!;
    assert.equal(kit.logoUrl, null);
    assert.ok(kit.wordmark, 'the wordmark must be there to stand in for the logo');
});

check('the brand name comes off og:site_name, and a title is trimmed to its first segment', () => {
    assert.equal(harvestBrandSignals(PAGE, BASE).wordmark, 'Harbour & Co');
    const noOg = '<html><head><title>Harbour &amp; Co — Independent roasters | Bristol</title></head></html>';
    assert.equal(harvestBrandSignals(noOg, BASE).wordmark, 'Harbour & Co');
});

check('the display font is read from the Google Fonts link', () => {
    assert.equal(harvestBrandSignals(PAGE, BASE).fontFamily, 'Poppins');
    // …and from CSS when there is no link, ignoring the generic fallbacks.
    const css = '<html><head><style>body { font-family: "Space Grotesk", Helvetica, sans-serif; }</style></head></html>';
    assert.equal(harvestBrandSignals(css, BASE).fontFamily, 'Space Grotesk');
});

check('stylesheets are offered same-origin first, but cross-origin is NOT dropped', () => {
    // Regression from live testing: same-origin-only found zero stylesheets on stripe.com, whose
    // own compiled CSS is served from b.stripecdn.com — as is every Next.js/Shopify/Squarespace
    // site. Dropping cross-origin CSS silently disabled extraction for most real businesses.
    const s = harvestBrandSignals(PAGE, BASE);
    assert.deepEqual(s.stylesheets, [
        'https://harbourandco.com/assets/site.css',
        'https://cdn.example.net/vendor.css',
    ]);
});

check('font and consent-vendor stylesheets are skipped as noise', () => {
    const html = `<html><head>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins">
      <link rel="stylesheet" href="https://cdn.cookielaw.org/banner.css">
      <link rel="stylesheet" href="https://assets.example.net/site.css"></head></html>`;
    assert.deepEqual(harvestBrandSignals(html, BASE).stylesheets, ['https://assets.example.net/site.css']);
});

// ── Ranking lessons from real sites ───────────────────────────────────────────────────────────

check('categorical evidence counts once, so a much-used button fill cannot bury the brand token', () => {
    // monzo.com in miniature: a near-black fills dozens of buttons; the coral is named --color-brand.
    const css = `<style>
      :root { --color-brand: #ff4f40; }
      .btn-a{background:#091723}.btn-b{background:#091723}.btn-c{background:#091723}
      .btn-d{background:#091723}.btn-e{background:#091723}.btn-f{background:#091723}
      .x{color:#091723}.y{color:#091723}.z{color:#091723}
    </style>`;
    const s = harvestBrandSignals(`<html><head>${css}</head></html>`, BASE);
    assert.equal(s.candidates[0]?.hex, '#ff4f40', `ranked ${s.candidates[0]?.hex} over the named brand colour`);
});

check('a token calling itself the brand outranks one calling itself an accent', () => {
    const css = '<style>:root{--color-brand:#ff4f40;--color-blue-accent:#009ace}</style>';
    const s = harvestBrandSignals(`<html><head>${css}</head></html>`, BASE);
    assert.equal(s.candidates[0]?.hex, '#ff4f40');
});

check('the middle of a design-token ramp wins, not its darkest step', () => {
    // stripe.com in miniature: the ramp's dark end appeared under two token names and was winning.
    const css = `<style>:root{
      --brand-400:#7f7dfc; --brand-600:#533afd; --brand-800:#2e2b8c;
      --brand-900:#1c1e54; --brand-925:#1c1e54; --brand-50:#e2e4ff;
    }</style>`;
    const s = harvestBrandSignals(`<html><head>${css}</head></html>`, BASE);
    assert.equal(s.candidates[0]?.hex, '#533afd');
    assert.ok(s.candidates.findIndex((c) => c.hex === '#1c1e54') > 1, 'the dark end of the ramp still ranks too high');
});

check('an alpha-suffixed ramp step is treated as a step, not as an unnumbered token', () => {
    const css = '<style>:root{--brand-400a:#5452fb;--brand-600:#533afd}</style>';
    const s = harvestBrandSignals(`<html><head>${css}</head></html>`, BASE);
    // Without the suffix rule "--brand-400a" read as "the brand itself" and beat the real accent.
    assert.equal(s.candidates[0]?.hex, '#533afd');
});

check('a dark navy is a valid brand colour', () => {
    // #0b2545 sits at luminance 0.0200 and was being rejected by a 0.02 floor — a silent failure
    // for one of the most common SMB brand colours there is.
    assert.equal(isAccentCandidate('#0b2545'), true);
    assert.equal(isAccentCandidate('#12131a'), false, 'near-black body ink must still lose');
});

check('a font family that could escape into a URL is refused', () => {
    assert.equal(cleanFontFamily('Poppins'), 'Poppins');
    assert.equal(cleanFontFamily('"Space Grotesk"'), 'Space Grotesk');
    assert.equal(cleanFontFamily('Evil/../../etc'), null);
    assert.equal(cleanFontFamily('Evil&family=Other'), null);
    assert.equal(cleanFontFamily('a'), null);
});

// ── Signals → kit ─────────────────────────────────────────────────────────────────────────────

check('a full harvest becomes a website-sourced kit', () => {
    const kit = signalsToBrandKit(harvestBrandSignals(PAGE, BASE), { website: 'harbourandco.com' })!;
    assert.ok(kit, 'no kit produced');
    assert.equal(kit.primaryColor, '#0b2545');
    assert.equal(kit.backgroundColor, '#ffffff');
    assert.equal(kit.textColor, '#12131a');
    assert.equal(kit.wordmark, 'Harbour & Co');
    assert.equal(kit.fontFamily, 'Poppins');
    assert.equal(kit.source, 'website');
    assert.ok(kit.extractedAt && kit.lastExtractAttemptAt, 'extraction not stamped');
});

check('a site with no brand-like colour yields NO kit, so the org stays on the neutral default', () => {
    // The important negative: returning a defaults-only kit would mark the org 'website'-sourced
    // and suppress every future retry.
    const grey = '<html><head><style>body{background:#fff;color:#111}.a{color:#6b7280}</style></head></html>';
    const s = harvestBrandSignals(grey, BASE);
    assert.equal(s.candidates.length, 0);
    assert.equal(signalsToBrandKit(s), null);
});

check("a model's pick is honoured only when it is genuinely on the page", () => {
    const s = harvestBrandSignals(PAGE, BASE);
    // A hex that IS a candidate: accepted.
    const onList = s.candidates[0].hex;
    assert.equal(signalsToBrandKit(s, { chosenAccent: onList })!.primaryColor, onList);
    // A plausible-looking invention: ignored, deterministic pick stands.
    assert.equal(signalsToBrandKit(s, { chosenAccent: '#7c3aed' })!.primaryColor, '#0b2545');
    assert.equal(signalsToBrandKit(s, { chosenAccent: 'not a colour' })!.primaryColor, '#0b2545');
});

check('unreadable body text on the page does not become unreadable text on the card', () => {
    // A site setting near-white text on white (behind an image, say) would poison the footer.
    const s = harvestBrandSignals(PAGE, BASE);
    const kit = signalsToBrandKit({ ...s, darks: [], lights: ['#ffffff'] })!;
    assert.notEqual(kit.textColor, '#ffffff');
    assert.equal(kit.textColor, '#1f1e1b');
});

check('an extracted kit survives a normalize round-trip unchanged', () => {
    const kit = signalsToBrandKit(harvestBrandSignals(PAGE, BASE), { website: 'harbourandco.com' })!;
    assert.deepEqual(normalizeBrandKit(kit), kit);
});

// ── Retry backoff ─────────────────────────────────────────────────────────────────────────────

const now = new Date('2026-07-24T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

check('a never-attempted org is extracted', () => {
    assert.equal(shouldExtractBrandKit(normalizeBrandKit(null), now), true);
});

check('a hand-configured kit is never overwritten by an automatic guess', () => {
    assert.equal(shouldExtractBrandKit(normalizeBrandKit({ primaryColor: '#ff007f', source: 'manual' }), now), false);
});

check('a failed attempt backs off instead of re-fetching on every post', () => {
    const justTried = normalizeBrandKit({ lastExtractAttemptAt: daysAgo(1) });
    assert.equal(shouldExtractBrandKit(justTried, now), false);
    const stale = normalizeBrandKit({ lastExtractAttemptAt: daysAgo(EXTRACT_RETRY_DAYS + 1) });
    assert.equal(shouldExtractBrandKit(stale, now), true);
});

check('a garbage timestamp does not become an Invalid Date that blocks extraction forever', () => {
    assert.equal(normalizeBrandKit({ lastExtractAttemptAt: 'not a date' }).lastExtractAttemptAt, null);
    assert.equal(shouldExtractBrandKit(normalizeBrandKit({ lastExtractAttemptAt: 'not a date' }), now), true);
});

console.log(`\n${passed}/${total} passed`);
