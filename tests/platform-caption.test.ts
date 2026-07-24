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
import { fitForPlatform, isShortForm, normalizeHashtags, platformTextLimit, stripDisclosureEchoes } from '../src/utils/platform-caption';
import { resolveWorkspaceFooterDefault } from '../src/utils/disclosure-footer';

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

const BRAND = { canonical: ['BeMoreSwan', 'HireNotLearn'], aliases: { hiredontlearn: 'HireNotLearn', saasfatigue: 'SaaSFatigue' } };

check('canonical brand tags are forced in first, spelled exactly', () => {
    const out = normalizeHashtags('#FounderLife #WorkSmarter', 'linkedin', BRAND).split(/\s+/);
    assert.equal(out[0], '#BeMoreSwan');
    assert.equal(out[1], '#HireNotLearn');
    assert.ok(out.includes('#FounderLife'));
});

check('variant hashtags are rewritten to their canonical spelling', () => {
    const out = normalizeHashtags('#HireDontLearn #SaasFatigue #FounderLife', 'linkedin', BRAND);
    assert.ok(out.includes('#HireNotLearn'), 'HireDontLearn not rewritten to HireNotLearn');
    assert.ok(out.includes('#SaaSFatigue'), 'SaasFatigue not re-cased to SaaSFatigue');
    assert.ok(!/HireDontLearn/i.test(out) || out.split('HireNotLearn').length === 2, 'variant survived');
    assert.ok(!out.includes('#HireDontLearn'), 'raw variant still present');
});

check('a canonical tag the model already emitted is not duplicated', () => {
    const out = normalizeHashtags('#bemoreswan #HireDontLearn', 'linkedin', BRAND).split(/\s+/);
    assert.equal(out.filter(t => t.toLowerCase() === '#bemoreswan').length, 1);
    assert.equal(out.filter(t => t === '#HireNotLearn').length, 1);
});

check('brand enforcement respects the X cap (2)', () => {
    const out = normalizeHashtags('#FounderLife #WorkSmarter #Growth', 'x', BRAND).split(/\s+/).filter(Boolean);
    assert.ok(out.length <= 2, `X exceeded 2 tags: ${out.join(' ')}`);
    assert.equal(out[0], '#BeMoreSwan'); // brand tags win the limited slots
});

check('fitForPlatform threads the brand config through to the hashtags', () => {
    const r = fitForPlatform({ platform: 'linkedin', longCaption: LONG, shortCaption: SHORT, hashtagsRaw: '#HireDontLearn #FounderLife', footer: FOOTER, brand: BRAND });
    assert.ok(r.hashtags.includes('#HireNotLearn') && !r.hashtags.includes('#HireDontLearn'), 'brand not applied via fitForPlatform');
});

// ── Duplicate AI disclosures ──────────────────────────────────────────────────────────────────
// A real prod post shipped THREE disclosures, each worded differently:
//   "Composed with Marvin, my Be More Swan AI Digital Employee."
//   "*Some content on this account is created with the help of Be More Swan AI.*"
//   "Composed with Marvin, my Be More Swan AI Digital Assistant. What's yours called 😉?"
// The blueprint's COMPLIANCE section was dumped into the system prompt verbatim, so the model read
// the workspace footer and the per-assistant disclosure and wrote its own copies into the body;
// the code then appended the real one. process-content-jobs now withholds those keys, and this is
// the second line of defence for blueprints compiled before that change.

check('echoed disclosure lines are stripped so only the real footer survives', () => {
    const leaked = 'Your best people are doing your worst jobs.\n\n'
        + 'Composed with Marvin, my Be More Swan AI Digital Employee.\n'
        + '*Some content on this account is created with the help of Be More Swan AI.*';
    const r = fitForPlatform({ platform: 'linkedin', longCaption: leaked, hashtagsRaw: '', footer: FOOTER });
    assert.equal((r.caption.match(/Digital Employee/g) || []).length, 0, 'echoed disclosure survived');
    assert.equal((r.caption.match(/Some content on this account/g) || []).length, 0, 'echoed org footer survived');
    assert.equal((r.caption.match(new RegExp(FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, 'the real footer must appear exactly once');
    assert.ok(r.caption.startsWith('Your best people are doing your worst jobs.'), 'body was damaged');
});

check('a disclosure hidden behind a leaked hashtag block is still removed', () => {
    // The two leaks interleave; one pass of each would strand whichever came first.
    const leaked = 'Real body line.\n\nComposed with Marvin, our AI assistant.\n\n#BeMoreSwan #FounderLife';
    const r = fitForPlatform({ platform: 'linkedin', longCaption: leaked, hashtagsRaw: '', footer: FOOTER });
    assert.ok(!r.caption.includes('Composed with Marvin, our AI assistant'), 'disclosure behind hashtags survived');
    assert.ok(r.caption.startsWith('Real body line.'), 'body was damaged');
    assert.ok(r.hashtags.includes('#BeMoreSwan'), 'leaked tags should still feed the hashtags field');
});

check('the various phrasings a model reaches for are all caught', () => {
    for (const line of [
        'AI-generated content.',
        'This post was created with AI.',
        'Written with the help of AI.',
        '*Some content on this account is created with the help of Be More Swan AI.*',
        '> Composed with Ava, our Digital Assistant.',
    ]) {
        assert.equal(stripDisclosureEchoes(`Body text here.\n\n${line}`), 'Body text here.', `not stripped: ${line}`);
    }
});

check('a post that legitimately discusses AI keeps its body intact', () => {
    // Shape-based matching earns its keep only if it does not eat real content.
    for (const body of [
        'We built our whole onboarding with AI and it halved the work.',
        'AI-generated images are banned in our brand guidelines — here is why.',
        'Three things AI still cannot do for your business.',
    ]) {
        assert.equal(stripDisclosureEchoes(body), body, `false positive on: ${body}`);
    }
});

check('the workspace default footer says "our", not "my"', () => {
    // It goes out on a BUSINESS account — the assistant belongs to the company, not the reviewer.
    const resolved = resolveWorkspaceFooterDefault('Marvin');
    assert.ok(resolved.includes('our Be More Swan AI Digital Assistant'), `wrong possessive: ${resolved}`);
    assert.ok(!/\bmy Be More Swan\b/.test(resolved), `still says "my": ${resolved}`);
    assert.ok(resolved.startsWith('Composed with Marvin,'), 'assistant name not substituted');
});

console.log(`\n${passed} checks passed`);
