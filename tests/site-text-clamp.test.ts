// tests/site-text-clamp.test.ts
// Website text that is too long for its place is shortened so it still reads — and the owner is told.
//
// Run:  npx tsx tests/site-text-clamp.test.ts
//
// Found on prod 2026-10-18: a live site's hero line ended "…connect to the tools y". The starter site
// copied the business description in with .slice(0, 300), and the site gate cut the same way, silently.
// What matters:
//  1. clampText never cuts a word or an emoji in half, and never goes over the limit.
//  2. Every cut the gate or an edit makes comes back as a warning the owner can act on.
//  3. The limits the editor counts against are the limits the gate enforces.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { clampText } from '../src/utils/text-safe';
import {
    applySiteOperation, cleanSection, cleanText, normaliseSiteDefinition, EDITOR_LIMITS, LIMITS, DEFAULT_THEME, type SectionType,
} from '../src/utils/site-definition';
import { starterSite } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const LONG = 'Be More Swan gives businesses a digital team of specialised, pre-trained AI assistants: a Social Media Assistant, '
    + 'Lead Generation Assistant, Blog Writer, Email Marketing Assistant, Minute Taker and more, with new roles being added. '
    + 'They work in the background around the clock, connect to the tools you already use and ask before anything goes out.';
const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

console.log('clampText');

check('short text is returned untouched', () => {
    assert.strictEqual(clampText('Fresh coffee.', 300), 'Fresh coffee.');
    assert.strictEqual(clampText(LONG.slice(0, 300), 300), LONG.slice(0, 300));
});

check('the prod case: ends on a whole sentence, not "the tools y"', () => {
    const out = clampText(LONG, 300);
    assert.ok(out.length <= 300, `${out.length}`);
    assert.ok(out.endsWith('with new roles being added.'), out);
});

check('no sentence end late enough: ends on a whole word with an ellipsis', () => {
    const text = 'Handmade candles poured in small batches in our Leeds studio using soy wax cotton wicks and essential oils from growers we know by name';
    const out = clampText(text, 60);
    assert.ok(out.length <= 60, `${out.length}`);
    assert.ok(out.endsWith('…'), out);
    const words = out.slice(0, -1);
    assert.ok(text.startsWith(words) && text[words.length] === ' ', `cut mid-word: "${out}"`);
});

check('no trailing comma or dash before the ellipsis', () => {
    const out = clampText('Cuts, colour, blow-dries, treatments, bridal hair, and more besides for everyone', 40);
    assert.ok(!/[,;:–—-]…$/.test(out), out);
});

check('never splits an emoji, and never goes over', () => {
    for (let max = 2; max <= 40; max++) {
        const out = clampText('🌸🌸🌸 Spring 🌸 flowers 🌸🌸 for every 🌸 occasion 🌸🌸🌸🌸', max);
        assert.ok(out.length <= max, `max ${max}: ${out.length}`);
        assert.ok(!hasLoneSurrogate(out), `max ${max}: half an emoji in "${out}"`);
    }
});

check('one enormous word is still cut to fit', () => {
    const out = clampText('a'.repeat(100), 20);
    assert.ok(out.length <= 20 && out.endsWith('…'), out);
});

console.log('\nThe owner is told');

const site = (subheadline: string) => ({
    pages: [{ id: 'home', slug: '', title: 'Home', sections: [{ id: 'hero', type: 'hero', props: { headline: 'Be More Mum', subheadline } }] }],
});

check('the gate warns, naming where the text now ends', () => {
    const r = normaliseSiteDefinition(site(LONG));
    const hero = r.definition.pages[0].sections[0];
    assert.strictEqual(hero.type, 'hero');
    const kept = hero.type === 'hero' ? hero.props.subheadline! : '';
    assert.ok(kept.endsWith('with new roles being added.'), kept);
    const w = r.warnings.find((x) => x.includes('shortened'));
    assert.ok(w, `no warning: ${JSON.stringify(r.warnings)}`);
    assert.ok(w!.includes('with new roles being added.'), w);
});

check('text that fits raises no warning — re-reading a saved site stays quiet', () => {
    const once = normaliseSiteDefinition(site(LONG)).definition;
    const again = normaliseSiteDefinition(once);
    assert.deepStrictEqual(again.warnings, []);
});

check('an edit warns too, though it cleans the section before the gate runs', () => {
    const def = normaliseSiteDefinition(site('Short.')).definition;
    const r = applySiteOperation(def, { op: 'update_section', pageId: 'home', sectionId: 'hero', props: { subheadline: LONG } });
    assert.ok(r.ok);
    assert.ok(r.ok && r.warnings.some((x) => x.includes('shortened')), JSON.stringify(r.ok && r.warnings));
});

check('cleanText outside the gate (visitor forms) shortens quietly and safely', () => {
    const out = cleanText(LONG, 100);
    assert.ok(out.length <= 100 && !hasLoneSurrogate(out));
});

check('the starter site keeps a long description whole-worded', () => {
    const def = starterSite({ name: 'Be More Swan', industry: null, description: LONG, audience: null, websiteUrl: null, email: null }, DEFAULT_THEME);
    const hero = def.pages[0].sections[0];
    const sub = hero.type === 'hero' ? hero.props.subheadline! : '';
    assert.ok(sub.length <= LIMITS.subheadline);
    assert.ok(!/\sy$/.test(sub) && /[.…]$/.test(sub), sub);
    assert.ok(def.settings.description!.length <= LIMITS.description && /[.…]$/.test(def.settings.description!), def.settings.description!);
});

console.log('\nEditor limits match the gate');

/** The smallest valid props for each section type, so one field can be made too long. */
const BASE: Partial<Record<SectionType, Record<string, unknown>>> = {
    hero: { headline: 'H' },
    features: { items: [{ title: 'T', body: 'B' }] },
    steps: { items: [{ title: 'T', body: 'B' }, { title: 'T2', body: 'B2' }] },
    text: { body: 'B' },
    faq: { items: [{ q: 'Q', a: 'A' }] },
    testimonials: { items: [{ quote: 'Q', name: 'N' }] },
    cta: { heading: 'H', button: { label: 'Go', href: '/' } },
    contact: {},
};
const words = (n: number) => 'word '.repeat(Math.ceil(n / 5) + 20).trim();
const fieldIn = (s: unknown, path: string[]): string => path.reduce((o: any, k) => (o == null ? o : o[k]), s as any);

check('every editor limit is the length cleanSection keeps', () => {
    const cases: Array<[SectionType, string[], number]> = [];
    for (const type of Object.keys(BASE) as SectionType[]) {
        const own = EDITOR_LIMITS.sectionFields[type] ?? {};
        for (const [k, max] of Object.entries({ ...EDITOR_LIMITS.fields, ...own })) cases.push([type, [k], max]);
    }
    for (const [k, max] of Object.entries(EDITOR_LIMITS.itemFields)) {
        const type: SectionType = k === 'q' || k === 'a' ? 'faq' : ['quote', 'name', 'detail'].includes(k) ? 'testimonials' : 'features';
        cases.push([type, ['items', '0', k], max]);
    }
    let checked = 0;
    for (const [type, path, max] of cases) {
        const props = JSON.parse(JSON.stringify(BASE[type]));
        if (path.length === 1) props[path[0]] = words(max); else props.items[0][path[2]] = words(max);
        const out = cleanSection(type, props, () => {});
        const kept = fieldIn(out?.props, path);
        if (typeof kept !== 'string') continue;   // that section has no such field
        assert.ok(kept.length <= max, `${type}.${path.join('.')}: kept ${kept.length}, editor says ${max}`);
        assert.ok(kept.length > max - 8, `${type}.${path.join('.')}: kept only ${kept.length} — the gate's limit is lower than the editor's ${max}`);
        checked++;
    }
    assert.ok(checked >= 20, `only ${checked} fields checked`);
});

check('a button label limit matches the gate', () => {
    const out = cleanSection('cta', { heading: 'H', button: { label: words(EDITOR_LIMITS.linkLabel), href: '/' } }, () => {});
    const label = fieldIn(out?.props, ['button', 'label']) ?? '';
    assert.ok(label.length <= EDITOR_LIMITS.linkLabel && label.length > EDITOR_LIMITS.linkLabel - 8, `${label.length}`);
});

check('the editor counts against the limits and never uses maxlength on these boxes', () => {
    const src = readFileSync(new URL('../src/components/assistant-site-editor.js', import.meta.url), 'utf8');
    const start = src.indexOf('function fieldHtml(');
    assert.ok(start > 0, 'fieldHtml not found');
    const body = src.slice(start, src.indexOf('\n  function readForm(', start));
    assert.ok(body.includes('limitAttr(max)') && body.includes('limitAttr(lmax)') && body.includes('limitAttr(itemMax(k))'), 'a text box lost its counter');
    assert.ok(!/maxlength/.test(body), 'maxlength silently cuts pasted text — count instead');
    assert.ok(/document\.addEventListener\('input',[\s\S]{0,120}updateLenNote/.test(src), 'counter must be bound to document at load');
    const sites = readFileSync(new URL('../netlify/functions/sites.ts', import.meta.url), 'utf8');
    assert.ok(/limits: EDITOR_LIMITS/.test(sites), 'sites.ts must send EDITOR_LIMITS to the editor');
});

console.log(`\n${passed}/${total} passed`);
