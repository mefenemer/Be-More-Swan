// tests/site-card-pages-issue31.test.ts
// Issue #31 (prod 2026-11-08, org 41): the Website Assistant noticed that pages proposed in a
// site_changes card never appeared in the draft. Three ways that happened, each covered here:
//   1. a menu set by hand (set_nav) never listed a new page;
//   2. a new page whose address an older page already had: its sections went onto the OLD page;
//   3. the card quietly applied only the first 25 changes (or only those it could read).
//
// Run:  npx tsx tests/site-card-pages-issue31.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applySiteOperationBatch, menuOf, normaliseSiteDefinition, type SiteOperation } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const hero = (headline: string) => ({ type: 'hero', props: { layout: 'centered', headline } });
const text = (heading: string) => ({ type: 'text', props: { heading, body: `${heading} body words.` } });

function site(nav: Array<{ label: string; pageId: string }> = []) {
    return normaliseSiteDefinition({
        settings: { siteName: 'Kudzu Test' },
        pages: [
            { id: 'p1', slug: '', title: 'Home', sections: [hero('Welcome')] },
            { id: 'p2', slug: 'services', title: 'Services', sections: [text('Old services')] },
            { id: 'p3', slug: 'contact', title: 'Contact', sections: [text('Get in touch')] },
        ],
        nav,
    }, { maxPages: 50 }).definition;
}

console.log('A new page joins a menu set by hand');
check('after set_nav, add_page puts the page at the end of the menu', () => {
    const def = site([{ label: 'Contact', pageId: 'p3' }, { label: 'Home', pageId: 'p1' }]);
    const r = applySiteOperationBatch(def, [
        { op: 'add_page', title: 'Workshops', slug: 'workshops' },
        { op: 'add_section', pageId: 'workshops', section: text('Workshops') },
    ] as SiteOperation[], { maxPages: 50 });
    assert.ok(r.ok, !r.ok ? r.error : '');
    const labels = menuOf(r.ok ? r.definition : def).map((m) => m.label);
    assert.deepStrictEqual(labels, ['Contact', 'Home', 'Workshops']);
});
check('a full hand-set menu says the page is not in it', () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({ id: `p${i + 1}`, slug: i ? `page-${i}` : '', title: `Page ${i}`, sections: [text(`P${i}`)] }));
    const def = normaliseSiteDefinition({ pages, nav: pages.map((p) => ({ label: p.title, pageId: p.id })) }, { maxPages: 50 }).definition;
    const r = applySiteOperationBatch(def, [{ op: 'add_page', title: 'Workshops' }] as SiteOperation[], { maxPages: 50 });
    assert.ok(r.ok);
    assert.ok(r.ok && r.warnings.some((w) => w.includes('menu is full') && w.includes('Workshops')));
    assert.ok(r.ok && r.definition.pages.some((p) => p.title === 'Workshops'));
});
check('with no hand-set menu nothing changes: every page is listed', () => {
    const r = applySiteOperationBatch(site(), [{ op: 'add_page', title: 'Workshops' }] as SiteOperation[], { maxPages: 50 });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.ok && r.definition.nav, []);
    assert.ok(r.ok && menuOf(r.definition).some((m) => m.label === 'Workshops'));
});

console.log('A new page with an address an older page already has');
check('the card\'s sections go onto the NEW page, not the old one', () => {
    const r = applySiteOperationBatch(site(), [
        { op: 'add_page', title: 'Services', slug: 'services' },
        { op: 'add_section', pageId: 'services', section: text('New services') },
        { op: 'add_section', pageId: '/services', section: text('Prices') },
    ] as SiteOperation[], { maxPages: 50 });
    assert.ok(r.ok, !r.ok ? r.error : '');
    const def = r.ok ? r.definition : site();
    const old = def.pages.find((p) => p.slug === 'services')!;
    const fresh = def.pages.find((p) => p.slug === 'services-2')!;
    assert.deepStrictEqual(old.sections.map((s) => (s.props as { heading?: string }).heading), ['Old services']);
    assert.deepStrictEqual(fresh.sections.map((s) => (s.props as { heading?: string }).heading), ['New services', 'Prices']);
});
check('a real page id still wins, and an existing page by its address still works', () => {
    const r = applySiteOperationBatch(site(), [
        { op: 'add_section', pageId: 'p3', section: text('Map') },
        { op: 'add_section', pageId: 'services', section: text('More') },
    ] as SiteOperation[], { maxPages: 50 });
    assert.ok(r.ok);
    const def = r.ok ? r.definition : site();
    assert.strictEqual(def.pages.find((p) => p.id === 'p3')!.sections.length, 2);
    assert.strictEqual(def.pages.find((p) => p.id === 'p2')!.sections.length, 2);
});
check('a refused change stops the whole card, with its position', () => {
    const r = applySiteOperationBatch(site(), [
        { op: 'add_page', title: 'Workshops' },
        { op: 'add_section', pageId: 'nowhere', section: text('X') },
    ] as SiteOperation[], { maxPages: 50 });
    assert.ok(!r.ok && r.index === 1);
});

console.log('The card never applies part of itself');
const registry = readFileSync(path.join(process.cwd(), 'src/components/disruptive-ui-registry.js'), 'utf8');
const card = registry.slice(registry.indexOf('function renderSiteChangesCard('), registry.indexOf("register('site_changes'"));
check('no silent cut to the first 25', () => {
    assert.ok(card.length > 500, 'card found');
    assert.ok(!/ui\.ops[^\n]*\.slice\(0, 25\)/.test(card), 'ops are not sliced before sending');
    assert.ok(card.includes('MAX_SITE_OPS'), 'the limit is named');
    assert.ok(card.includes('data-sc-blocked'), 'it says why it is blocked');
});
check('a change it cannot read blocks Apply instead of being dropped', () => {
    assert.ok(card.includes('ops.length !== given.length'));
    assert.ok(card.includes("ops.length && !blocked ? '' : 'disabled'"));
});
check('the store applies cards through the batch', () => {
    const store = readFileSync(path.join(process.cwd(), 'src/utils/site-store.ts'), 'utf8');
    assert.ok(store.includes('applySiteOperationBatch(definitionOf(site, maxPages).definition, ops, { maxPages })'));
});
check('the Website Assistant is told one card holds at most 25 ops', () => {
    const src = readFileSync(path.join(process.cwd(), 'netlify/functions/chat-orchestrator.ts'), 'utf8');
    assert.ok(src.includes('one card holds at most 25 ops'));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
