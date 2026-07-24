// tests/platform-caption.test.ts
// Per-platform caption/hashtag fit (src/utils/platform-caption.ts).
//
// Run:  npx tsx tests/platform-caption.test.ts
//
// Guards the fix for the real prod finding: LinkedIn-length essays were fanned to X verbatim (~1,400
// chars, 10 hashtags). The invariant that must never break: an X post — caption + disclosure footer +
// hashtags — fits 280 characters, AND the legally-required footer is always present and intact. Pure
// logic — no DB required.

import assert from 'node:assert';
import { fitForPlatform, isShortForm, normalizeHashtags, platformTextLimit } from '../src/utils/platform-caption';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const FOOTER = 'This message was composed with Be More Swan AI assistance.';
// The actual "41 days" prod caption was ~1,400 chars; this stand-in is comfortably over any X limit.
const LONG = 'The average founder spends far too long on admin that never needed their brain. '.repeat(20).trim();
const SHORT = 'Founders: stop learning tools, start hiring help. Your first assistant in ~20 min → bemoreswan.com';
const HASHTAGS = '#BeMoreSwan #FounderLife #SmallBusinessOwner #WorkSmarter #AIAssistant #SaasFatigue #TimeBack #DigitalTeam #Ecommerce #StartupLife';

// The whole assembled post as the publisher sends it: caption + blank line + hashtags.
const assembled = (r: { caption: string; hashtags: string }) => (r.hashtags ? `${r.caption}\n\n${r.hashtags}` : r.caption);

check('short-form platforms are classified correctly', () => {
    assert.equal(isShortForm('x'), true);
    assert.equal(isShortForm('threads'), true);
    assert.equal(isShortForm('linkedin'), false);
    assert.equal(isShortForm('facebook'), false);
    assert.equal(isShortForm('instagram'), false);
});

check('X: full assembled post (caption+footer+hashtags) fits 280', () => {
    const r = fitForPlatform({ platform: 'x', longCaption: LONG, shortCaption: SHORT, hashtagsRaw: HASHTAGS, footer: FOOTER });
    assert.ok(assembled(r).length <= platformTextLimit('x'), `assembled length ${assembled(r).length} > 280`);
    assert.ok(r.caption.includes(FOOTER), 'footer missing on X caption');
});

check('X: even with NO short variant, a derived trim still fits 280 with footer intact', () => {
    const r = fitForPlatform({ platform: 'x', longCaption: LONG, shortCaption: null, hashtagsRaw: HASHTAGS, footer: FOOTER });
    assert.ok(assembled(r).length <= 280, `assembled length ${assembled(r).length} > 280`);
    assert.ok(r.caption.includes(FOOTER), 'footer missing when derived');
    assert.ok(!r.caption.includes(LONG), 'long caption was not trimmed for X');
});

check('X: hashtags capped at 2', () => {
    const r = fitForPlatform({ platform: 'x', longCaption: LONG, shortCaption: SHORT, hashtagsRaw: HASHTAGS, footer: FOOTER });
    assert.ok(r.hashtags.split(/\s+/).filter(Boolean).length <= 2, `too many X hashtags: "${r.hashtags}"`);
});

check('LinkedIn: keeps the full caption and up to 10 hashtags, footer appended', () => {
    const r = fitForPlatform({ platform: 'linkedin', longCaption: LONG, shortCaption: SHORT, hashtagsRaw: HASHTAGS, footer: FOOTER });
    assert.ok(r.caption.startsWith(LONG.slice(0, 40)), 'LinkedIn should keep the long caption');
    assert.ok(r.caption.includes(FOOTER), 'footer missing on LinkedIn caption');
    assert.ok(r.hashtags.split(/\s+/).filter(Boolean).length <= 10);
    assert.ok(r.hashtags.split(/\s+/).filter(Boolean).length > 2, 'LinkedIn should keep a fuller hashtag set');
});

check('stock credit line rides after the footer and X still fits 280', () => {
    const credit = '\n\nPhoto: Jane Doe / Pexels';
    const r = fitForPlatform({ platform: 'x', longCaption: LONG, shortCaption: SHORT, hashtagsRaw: HASHTAGS, footer: FOOTER, creditSuffix: credit });
    assert.ok(r.caption.includes(FOOTER), 'footer missing');
    assert.ok(r.caption.trimEnd().endsWith('Pexels'), 'credit should be last');
    assert.ok(assembled(r).length <= 280, `assembled length ${assembled(r).length} > 280`);
});

check('normalizeHashtags de-dupes case-insensitively and acronym-cases standalone tags', () => {
    const out = normalizeHashtags('#ai #AI #seo #SaaS #founderlife', 'linkedin').split(/\s+/);
    assert.deepEqual(out.filter(t => t.toLowerCase() === '#ai').length, 1, 'duplicate #ai/#AI not de-duped');
    assert.ok(out.includes('#AI'), 'acronym #ai not upper-cased');
    assert.ok(out.includes('#SEO'), 'acronym #seo not upper-cased');
});

check('empty/absent hashtags and footer never crash', () => {
    const r1 = fitForPlatform({ platform: 'x', longCaption: LONG, shortCaption: SHORT, hashtagsRaw: null, footer: null });
    assert.equal(r1.hashtags, '');
    assert.ok(r1.caption.length <= 280);
    const r2 = fitForPlatform({ platform: 'linkedin', longCaption: LONG, shortCaption: null, hashtagsRaw: '', footer: null });
    assert.equal(r2.caption, LONG);
});

check('leaked trailing hashtags in the caption body are stripped, footer stays last (LinkedIn)', () => {
    // Reproduces the prod post-3 defect: the model appended a hashtag block (with a typo) to the
    // caption itself, in addition to the hashtags field.
    const leaky = `${LONG}\n\n#BeMorSwan #HireDontLearn #FounderLife`;
    const r = fitForPlatform({ platform: 'linkedin', longCaption: leaky, hashtagsRaw: HASHTAGS, footer: FOOTER });
    assert.ok(!r.caption.includes('#BeMorSwan'), 'misspelled leaked hashtag survived in the caption');
    assert.ok(!r.caption.includes('#HireDontLearn'), 'leaked hashtag left in caption body');
    assert.ok(r.caption.trimEnd().endsWith(FOOTER), 'footer is not last — hashtags stranded it');
});

check('leaked hashtags are stripped on X too, and the post still fits 280', () => {
    const leakyShort = `${SHORT} #BeMorSwan #HireDontLearn`;
    const r = fitForPlatform({ platform: 'x', longCaption: LONG, shortCaption: leakyShort, hashtagsRaw: HASHTAGS, footer: FOOTER });
    assert.ok(!r.caption.includes('#BeMorSwan'), 'leaked tag survived on X caption');
    assert.ok(r.caption.includes(FOOTER), 'footer missing on X');
    assert.ok(assembled(r).length <= 280, `assembled length ${assembled(r).length} > 280`);
});

check('when the hashtags field is empty, leaked trailing tags are recovered into it', () => {
    const leaky = `${LONG}\n\n#BeMoreSwan #FounderLife`;
    const r = fitForPlatform({ platform: 'linkedin', longCaption: leaky, hashtagsRaw: '', footer: FOOTER });
    assert.ok(r.hashtags.includes('#BeMoreSwan'), 'leaked tags not recovered when field was empty');
    assert.ok(!r.caption.includes('#BeMoreSwan'), 'recovered tags should not also remain in the body');
});

check('a caption with NO trailing hashtags is left untouched', () => {
    const r = fitForPlatform({ platform: 'linkedin', longCaption: LONG, hashtagsRaw: HASHTAGS, footer: FOOTER });
    assert.ok(r.caption.startsWith(LONG.slice(0, 40)), 'body altered when it had no trailing hashtags');
});

console.log(`\n${passed} checks passed`);
