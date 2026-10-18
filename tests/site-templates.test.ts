// tests/site-templates.test.ts
// Website templates (owner, 2026-10-18): more design range (self-hosted font pairings, spacing, a
// tint, a centred header, a full-width "cover" hero), eight templates, a gallery of real previews,
// and "write the words" filling a template's layout instead of replacing it.
//
// Run:  npx tsx tests/site-templates.test.ts

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_TEMPLATES } from '../src/config/site-templates';
import { applySiteOperation, FONTS, normaliseSiteDefinition, type Section } from '../src/utils/site-definition';
import { FONT_PAIRS, renderSitePage, themeCss } from '../src/utils/site-render';
import { propsFromWords, siteFromFillReply, wordsOf } from '../src/utils/site-template-fill';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const root = (p: string) => join(__dirname, '..', p);
const base = normaliseSiteDefinition({ settings: { siteName: 'Wordsworth Hair', locality: 'Leeds' }, pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Hi', image: { url: 'https://x.example/a.jpg', alt: 'A' } } }, { type: 'text', props: { body: 'Ours' } }] }] }).definition;

console.log('\nDesign range');

check('every lettering choice has its font files on BOTH the app and the sites host, with their licence', () => {
    for (const k of FONTS) for (const f of FONT_PAIRS[k].faces) {
        for (const dir of ['site-fonts', 'sites-host/public/site-fonts']) assert.ok(existsSync(root(`${dir}/${f}.woff2`)), `${dir}/${f}.woff2`);
        assert.ok(existsSync(root(`site-fonts/${f}-OFL.txt`)), `${f} licence`);
    }
    assert.deepStrictEqual(readFileSync(root('site-fonts/fraunces.woff2')), readFileSync(root('sites-host/public/site-fonts/fraunces.woff2')), 'the two copies match');
});
check('fonts load from our own address only, and the pages allow it; the sites host serves them as files', () => {
    const css = themeCss({ ...base.theme, font: 'editorial' });
    assert.ok(css.includes('@font-face{font-family:"Fraunces";src:url(/site-fonts/fraunces.woff2)') && !/googleapis|gstatic/.test(css));
    assert.ok(!themeCss(base.theme).includes('@font-face'), 'the device fonts load nothing');
    for (const f of ['netlify/functions/site-serve.ts', 'netlify/functions/site-preview.ts']) assert.ok(read(f).includes("font-src 'self'"), f);
    assert.ok(read('sites-host/netlify.toml').includes('excludedPath = ["/site-fonts/*"]') && read('sites-host/edge-functions/serve.ts').includes("excludedPath: ['/site-fonts/*']"));
});
check('spacing, tint and header are optional — an old site draws exactly as before', () => {
    const t = normaliseSiteDefinition({ theme: { spacing: 'huge', accentColor: 'nope', header: 'sideways' } }).definition.theme;
    assert.strictEqual(t.spacing, 'regular'); assert.strictEqual(t.accentColor, null); assert.strictEqual(t.header, 'standard');
    assert.ok(themeCss(base.theme).includes('.alt{background:rgba(0,0,0,.035)}'));
    assert.ok(themeCss({ ...base.theme, accentColor: '#cfdcc6', spacing: 'airy' }).includes('--sp:104px'));
});
check('a cover hero puts the picture behind the words; without one it is a banner', () => {
    const d = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { layout: 'cover', headline: 'Hello', image: { url: 'https://x.example/a.jpg', alt: 'Shop' } } }] }] }).definition;
    const html = renderSitePage(d, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null }).html;
    assert.ok(html.includes('<section class="hero cover"') && html.includes('<img class="bg" src="https://x.example/a.jpg"'));
    const bare = normaliseSiteDefinition({ pages: [{ title: 'Home', slug: '', sections: [{ type: 'hero', props: { layout: 'cover', headline: 'Hello' } }] }] }).definition;
    assert.ok(renderSitePage(bare, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null }).html.includes('<section class="hero banner"'));
});

console.log('\nThe templates');

check('all eight build whole: every section through the gate, no warnings, their name and town filled in', () => {
    assert.strictEqual(SITE_TEMPLATES.length, 8);
    for (const t of SITE_TEMPLATES) {
        const r = applySiteOperation(base, { op: 'apply_template', templateId: t.id, mode: 'full' }, { maxPages: 5 });
        assert.ok(r.ok, t.id);
        if (!r.ok) continue;
        assert.deepStrictEqual(r.warnings, [], t.id);
        assert.strictEqual(r.definition.pages.reduce((n, p) => n + p.sections.length, 0), t.pages.reduce((n, p) => n + p.sections.length, 0), `${t.id} kept every section`);
        const words = JSON.stringify(r.definition);
        assert.ok(!words.includes('{name}') && !words.includes('{town}'), `${t.id} filled in`);
        assert.strictEqual(r.definition.settings.template, t.id);
    }
});
check('no made-up testimonials; facts are left in [square brackets]', () => {
    for (const t of SITE_TEMPLATES) assert.ok(!t.pages.some((p) => p.sections.some((s) => s.type === 'testimonials')), t.id);
    assert.ok(JSON.stringify(SITE_TEMPLATES).includes('[price]'));
});
check('design only keeps every word and picture; switched-off features are left out of a fresh start', () => {
    const r = applySiteOperation(base, { op: 'apply_template', templateId: 'forge', mode: 'design' });
    assert.ok(r.ok && r.definition.theme.font === 'bold' && (r.definition.pages[0].sections[0] as any).props.layout === 'cover');
    assert.ok(r.ok && JSON.stringify(r.definition.pages[0].sections.map((s) => s.props)) === JSON.stringify(base.pages[0].sections.map((s) => ({ ...s.props, ...(s.type === 'hero' ? { layout: 'cover' } : {}) }))));
    const kept = applySiteOperation(base, { op: 'apply_template', templateId: 'forge', mode: 'design', keepColours: true });
    assert.ok(kept.ok && kept.definition.theme.primaryColor === base.theme.primaryColor, 'keep my colours');
    const off = normaliseSiteDefinition({ ...base, settings: { ...base.settings, features: ['faq'] } }).definition;
    const f = applySiteOperation(off, { op: 'apply_template', templateId: 'willow', mode: 'full' });
    assert.ok(f.ok && !f.definition.pages.some((p) => p.sections.some((s) => s.type === 'booking' || s.type === 'gallery')));
});

console.log('\nWriting the words into a template');

check('only words change — links, pictures and how many items there are stay', () => {
    const r = applySiteOperation(base, { op: 'apply_template', templateId: 'stride', mode: 'full' });
    assert.ok(r.ok);
    if (!r.ok) return;
    const hero = r.definition.pages[0].sections[0] as Section;
    const w = wordsOf(hero) as Record<string, unknown>;
    assert.ok(!('primaryCta' in w) && 'primaryButton' in w && !('image' in w));
    const props = propsFromWords(hero, { headline: 'Stronger in Leeds', primaryButton: 'Book a chat', image: 'https://evil.example/x.jpg' }) as any;
    assert.strictEqual(props.headline, 'Stronger in Leeds');
    assert.strictEqual(props.primaryCta.href, (hero.props as any).primaryCta.href, 'the link stays');
    assert.ok(!('image' in props), 'a picture can never come from the reply');
    const steps = r.definition.pages[0].sections.find((s) => s.type === 'steps') as Section;
    const sp = propsFromWords(steps, { items: [{ title: 'One' }] }) as any;
    assert.strictEqual(sp.items.length, (steps.props as any).items.length, 'same number of items');
    const filled = siteFromFillReply({ sections: { [hero.id]: { headline: 'Stronger in Leeds' } }, description: 'Personal training in Leeds.' }, r.definition, 5);
    assert.strictEqual(filled.changed, 1);
    assert.strictEqual((filled.definition.pages[0].sections[0].props as any).headline, 'Stronger in Leeds');
    assert.strictEqual(filled.definition.settings.description, 'Personal training in Leeds.');
});
check('the draft worker fills a template site instead of replacing it; chat and cards know the op', () => {
    const st = read('src/utils/site-store.ts');
    assert.ok(st.includes('const fromTemplate = !!current.settings.template;') && st.includes('buildFillPrompt(brief, current)'));
    assert.ok(read('netlify/functions/sites.ts').includes("'split_pages', 'apply_template'];"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('{"op":"apply_template","templateId":"<id>"'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes('apply_template: (o) =>'));
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('function openTemplate(id)') && ed.includes("op: 'apply_template', templateId: t.id, mode: view.mode, keepColours: view.keepColours"));
    assert.ok(read('netlify/functions/site-preview.ts').includes("op: 'apply_template', templateId, mode:"));
});

console.log(`\n${passed}/${total} passed\n`);
