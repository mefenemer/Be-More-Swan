// tests/site-split-pages.test.ts
// One page → several again (owner, 2026-10-16). Combining moved every page onto the home page, so
// flipping the layout back changed nothing a visitor could see. split_pages is the reverse: the home
// page splits at each later section with a menu label, proposed first and applied on approval.
//
// Run:  npx tsx tests/site-split-pages.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySiteOperation, normaliseSiteDefinition, planSplit, type Section, type SiteDefinition } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const ok = (r: ReturnType<typeof applySiteOperation>): SiteDefinition => { if (!r.ok) throw new Error(r.error); return r.definition; };

const site = normaliseSiteDefinition({
    settings: { siteName: 'Bistro' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Welcome', primaryCta: { label: 'Our menu', href: '/menu' } } }, { type: 'text', props: { body: 'About us' } }] },
        { title: 'Menu', slug: 'menu', sections: [{ type: 'text', props: { heading: 'Mains', body: 'Risotto' } }, { type: 'text', props: { body: 'Puddings' } }] },
        { title: 'Contact', slug: 'contact', sections: [{ type: 'text', props: { body: 'Call us' } }] },
    ],
}).definition;

console.log('\nSplitting back into pages');

check('combine then split gives the same pages back, with the same sections', () => {
    const one = ok(applySiteOperation(site, { op: 'combine_pages' }));
    assert.strictEqual(one.pages.length, 1);
    const back = ok(applySiteOperation(one, { op: 'split_pages' }));
    assert.strictEqual(back.structure, 'pages');
    assert.deepStrictEqual(back.pages.map((p) => [p.title, p.slug, p.sections.length]), [['Home', '', 2], ['Menu', 'menu', 2], ['Contact', 'contact', 1]]);
    assert.ok(back.pages[1].sections.every((s) => !s.look?.menuLabel), 'the generated label is cleared; the title holds it');
});
check('a button that jumped down the page goes to the new page', () => {
    const one = ok(applySiteOperation(site, { op: 'combine_pages' }));
    const hero = one.pages[0].sections[0] as { props: { primaryCta: { href: string } } };
    assert.ok(hero.props.primaryCta.href.startsWith('#'));
    const back = ok(applySiteOperation(one, { op: 'split_pages' }));
    assert.strictEqual((back.pages[0].sections[0] as { props: { primaryCta: { href: string } } }).props.primaryCta.href, '/menu');
});
check('nothing labelled further down: refused with what to do; the plan\'s page cap holds', () => {
    const plain = normaliseSiteDefinition({ settings: { siteName: 'B' }, structure: 'one_page', pages: [{ title: 'Home', slug: '', sections: [{ type: 'text', props: { body: 'Hi' } }] }] }).definition;
    const r = applySiteOperation(plain, { op: 'split_pages' });
    assert.ok(!r.ok && /nothing to split/.test(r.error));
    const one = ok(applySiteOperation(site, { op: 'combine_pages' }));
    const capped = applySiteOperation(one, { op: 'split_pages' }, { maxPages: 2 });
    assert.ok(!capped.ok && /your plan includes 2/.test(capped.error));
});

check('no menu labels (sections added straight onto Home): pages by what each section is', () => {
    const sec = (type: string, props: Record<string, unknown> = {}) => ({ id: type + Math.random(), type, props }) as unknown as Section;
    const plan = planSplit([sec('hero'), sec('text'), sec('hours'), sec('booking', { kind: 'appointment' }), sec('booking', { kind: 'class' }),
        sec('products'), sec('menu'), sec('reviews'), sec('signup'), sec('contact'), sec('faq'), sec('gallery')]);
    assert.strictEqual(plan.byLabel, false);
    assert.deepStrictEqual(plan.home.map((x) => x.type), ['hero', 'text', 'reviews', 'signup']);
    assert.deepStrictEqual(plan.parts.map((p) => [p.title, p.sections.map((x) => x.type).join('+')]),
        [['Contact', 'hours+contact'], ['Book', 'booking'], ['Classes', 'booking'], ['Shop', 'products'], ['Menu', 'menu'], ['Questions', 'faq'], ['Gallery', 'gallery']]);
});
check('a Contact page that already exists takes the contact sections instead of a second one', () => {
    const def = normaliseSiteDefinition({ settings: { siteName: 'B' }, pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Hi' } }, { type: 'faq', props: { items: [{ q: 'Parking?', a: 'Yes' }] } }, { type: 'contact', props: {} }] },
        { title: 'Contact', slug: 'contact', sections: [{ type: 'text', props: { body: 'Call us' } }] },
    ] }).definition;
    const out = ok(applySiteOperation(def, { op: 'split_pages' }));
    assert.deepStrictEqual(out.pages.map((p) => [p.slug, p.sections.map((x) => x.type).join('+')]), [['', 'hero'], ['questions', 'faq'], ['contact', 'text+contact']]);
});

console.log('\nWiring');

check('the editor proposes first; the server previews without saving; the chat knows the op', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("if (structure.value === 'pages') { await backToPages(); return; }"));
    assert.ok(ed.includes("if (t('[data-site-split]')) { await backToPages(); return; }") && ed.includes('state.data.site.canSplit'), 'offered when already on several pages');
    assert.ok(!ed.includes("if (def().pages.length > 1) { await apply([{ op: 'set_structure', structure: 'pages' }]); return; }"), 'never switches silently');
    assert.ok(ed.includes("post({ action: 'split_preview', assistantId: state.assistantId })") && ed.includes("await apply([{ op: 'split_pages' }]"));
    const api = read('netlify/functions/sites.ts');
    assert.ok(api.includes("'combine_pages', 'split_pages'];") && api.includes("if (action === 'split_preview') {"));
    assert.ok(api.includes('canSplit: planSplit(definition.pages[0]?.sections ?? []).parts.length > 0,'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('- {"op":"split_pages"}'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes('split_pages: () =>'));
});

console.log('\nSide menu');

check('Team Chat sits under Inbox; the collapse button\'s ring is not painted over', () => {
    const side = read('components/sidebar.html');
    const at = (id: string) => side.indexOf(`id="${id}"`);
    assert.ok(at('nav-inbox') < at('nav-team') && at('nav-team') < at('nav-assistants'));
    const ws = read('workspace.html');
    assert.ok(ws.includes('#sidebar-collapse-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px #D6006B; }'));
    assert.ok(/#sidebar-collapse-row \{[^}]*z-index: 1;/.test(ws));
});

console.log(`\n${passed}/${total} passed\n`);
