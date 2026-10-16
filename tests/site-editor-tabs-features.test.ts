// tests/site-editor-tabs-features.test.ts
// The Website Assistant's page, reshaped (owner, 2026-10-16): Enquiries, Orders and Bookings are tabs
// of their own; the site's features can be switched off (hidden from the editor, the chat and the
// draft, and their tabs); a swan beside every section asks for a change; "Draft my whole site" is the
// start of a new site, or "Start again" — never a card under every panel.
//
// Run:  npx tsx tests/site-editor-tabs-features.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySiteOperation, featureOf, normaliseSiteDefinition, sectionAllowed } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const site = (features?: unknown) => normaliseSiteDefinition({ settings: { siteName: 'B', ...(features !== undefined ? { features } : {}) }, pages: [{ title: 'Home', slug: '', sections: [{ type: 'text', props: { body: 'Hi' } }] }] }).definition;

console.log('\nWhat the website does');

check('never chosen = everything offered; a choice keeps only known features, in order', () => {
    assert.strictEqual(site().settings.features, null);
    assert.deepStrictEqual(site(['faq', 'nonsense', 'shop']).settings.features, ['shop', 'faq']);
    assert.strictEqual(featureOf('products'), 'shop');
    assert.strictEqual(featureOf('hero'), null, 'the basics are always offered');
});
check('a switched-off kind of section is refused, with where to switch it on; the basics never are', () => {
    const d = site(['faq']);
    assert.ok(!sectionAllowed(d.settings, 'booking') && sectionAllowed(d.settings, 'hero'));
    const r = applySiteOperation(d, { op: 'add_section', pageId: d.pages[0].id, section: { type: 'faq', props: { items: [{ q: 'a?', a: 'b' }] } } });
    assert.ok(r.ok);
    const off = applySiteOperation(d, { op: 'add_section', pageId: d.pages[0].id, section: { type: 'hours', props: {} } });
    assert.ok(!off.ok && /switched off.*What your website does/.test(off.error));
});
check('set_settings changes them; other settings keep them', () => {
    const d = site();
    const on = applySiteOperation(d, { op: 'set_settings', settings: { features: ['shop'] } });
    assert.ok(on.ok && JSON.stringify(on.definition.settings.features) === '["shop"]');
    const named = applySiteOperation(on.ok ? on.definition : d, { op: 'set_settings', settings: { siteName: 'C' } });
    assert.ok(named.ok && JSON.stringify(named.definition.settings.features) === '["shop"]');
});
check('the AI draft keeps their choice and drafts nothing switched off; the chat is told', () => {
    const draft = read('src/utils/site-draft.ts');
    assert.ok(draft.includes('settings.features = current.settings.features;') && draft.includes('sectionAllowed(current.settings,'));
    assert.ok(read('src/utils/site-store.ts').includes('Switched OFF — never propose these kinds of section'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"features" is the FULL list of what the website does'));
});

console.log('\nTabs');

check('Website, Enquiries, Orders, Bookings — each its own tab, in that order, rendered into its own host', () => {
    const html = read('assistant-detail.html');
    const at = (id: string) => html.indexOf(`id="maintab-btn-${id}"`);
    assert.ok(at('sitebuilder') < at('siteenquiries') && at('siteenquiries') < at('siteorders') && at('siteorders') < at('sitebookings') && at('sitebookings') < html.indexOf('id="maintab-btn-calendar"'));
    for (const h of ['website', 'enquiries', 'orders', 'bookings']) assert.ok(html.includes(`data-site-host="${h}"`), h);
    const a = read('assistants.js');
    assert.ok(a.includes("if (name === 'siteorders') window.AssistantSiteEditor?.activate('orders');"));
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("const tabs = [['pages', 'Pages'], ['design', 'Design'], ['details', 'Details']]"), 'the Website tab keeps only its own panels');
    assert.ok(ed.includes("show('maintab-btn-siteorders', featureOn('shop')); show('maintab-btn-sitebookings', featureOn('bookings'));"));
    assert.ok(read('netlify/functions/sites.ts').includes('&tab=siteorders&payments=return'), 'back from Stripe on the Orders tab');
    assert.ok(read('notifications.js').includes("site_order_received: ['Open orders', 'siteorders']"));
});

console.log('\nAsking for a change, and drafting');

check('a swan on every section (list and preview) sends the request to the chat, which proposes a card', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('${swanBtn(p.id, s.id)}') && ed.includes("doc.getElementById(sec.id)") && ed.includes("document.addEventListener('load', (e) => {"));
    assert.ok(ed.includes('send: `Please change the "${label}" section on the ${pg.title} page (section ${sectionId}): ${text.trim()}`'));
    const m = read('src/components/assistant-chat-modal.js');
    assert.ok(m.includes("var sendBtn = opts.send && el('bms-chat-mount').querySelector('[data-chat-send]');"));
});
check('"Draft my whole site": up front on a new site, otherwise "Start again" folded into Details', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("${isFresh() || state.data.site.drafting ? draftCard('start') : ''}"));
    assert.ok(ed.includes("detailsPanel() + draftCard('again')") && ed.includes('Start again from scratch'));
    assert.ok(!ed.includes('          ${draftCard()}'), 'no longer under every panel');
});

console.log(`\n${passed}/${total} passed\n`);
