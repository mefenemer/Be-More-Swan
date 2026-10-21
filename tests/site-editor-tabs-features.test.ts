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
    assert.ok(ed.includes("const tabs = [['pages', 'Pages'], ['design', 'Design'], ['templates', 'Templates'], ['details', 'Details']]"), 'the Website tab keeps only its own panels — Templates its own, or nobody with a site finds it');
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
    assert.ok(ed.includes("['draft', (fresh ? step === 3 || s.drafting : s.drafting || (def().settings.template && !s.publishedVersion)) ? draftCard('start') : '']"), 'step 3 of a new site, or up front on one started from a template');
    assert.ok(ed.includes("detailsPanel() + draftCard('again')") && ed.includes('Start again from scratch'));
    assert.ok(!ed.includes('          ${draftCard()}'), 'no longer under every panel');
});

console.log('\nPainting (UI review, 2026-10-21)');

check('a click or the drafting poll no longer reloads the preview or wipes what was typed', () => {
    const ed = read('src/components/assistant-site-editor.js');
    // The preview frame is made once; its address changes only when what it shows changed.
    assert.ok(ed.includes("if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src; }"));
    assert.ok(!/host\.innerHTML = `[\s\S]{0,200}previewHtml/.test(ed), 'the whole tab is no longer one innerHTML write');
    // The template galleries are rewritten only when their HTML changed.
    assert.ok(ed.includes("['templates', step === 2 && !def().settings.template ? templatesCard(true) : '', { keep: true }]"));
    // A poll with nothing new does not repaint.
    assert.ok(/const same = state\.loaded && sig === state\.dataSig;[\s\S]{0,120}if \(!same\) \{ keepEditing\(\); state\.version\+\+; rerender\(\); \}/.test(ed));
    // Typed text is kept unless the server changed that box; the section form keeps its own (by position).
    assert.ok(ed.includes('if (t && defaultOf(c) === t.was)') && ed.includes("if (el.closest('[data-site-section-form]')) return null;"));
});

check('labels name their boxes, buttons are 44px at phone width, and notes are announced and seen', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(/function nameFields\(root\)[\s\S]{0,600}l\.htmlFor = box\.id;/.test(ed));
    assert.ok(/function afterPaint\(host\) \{\s*nameFields\(host\);/.test(ed));
    assert.ok(ed.includes('aria-label="Picture ${i + 1}: what it shows (needed)"'));
    assert.ok(ed.includes("'@media (max-width: 639px) { .sb-tap { min-height: 44px; min-width: 44px; }"));
    assert.ok(/const btn = [^\n]*sb-tap/.test(ed), 'every btn() gets the phone tap size');
    assert.ok(!/class="text-xs text-gray-[56]00 underline[^"]*">(Remove|\+ Add another|Cancel)/.test(ed), 'no small text-link buttons in the section form');
    assert.ok(ed.includes("['note', noteHtml(), { live: true }]") && ed.includes("el.setAttribute('aria-live', 'polite')"));
    assert.ok(/state\.focusSection = ed\.sectionId \|\|/.test(ed), 'after a save the edited section comes back into view');
    assert.ok(/r\.top < 0 \|\| r\.bottom > window\.innerHeight[\s\S]{0,120}showToast\(state\.note\.text/.test(ed), 'a note out of sight is also a toast');
});

console.log('\nMedium items (UI review, 2026-10-21)');

check('a new site is set up one numbered step at a time, with one main button, and nothing to publish yet', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(/function setupStep\(\) \{[\s\S]{0,300}if \(!featuresOn\(\)\) return 1;[\s\S]{0,200}return 2;[\s\S]{0,40}return 3;/.test(ed));
    assert.ok(ed.includes('aria-current="step"') && ed.includes('data-site-setup-step') && ed.includes('data-site-setup-skip'));
    assert.ok(ed.includes("['publish', fresh ? '' : publishCard()]"), 'Publish waits for a draft');
    assert.ok(ed.includes("primary && !quietPrimary ? 'btn-primary'") && ed.includes('quietPrimary = fresh && !state.editing;'));
    assert.ok(ed.includes("btn('data-site-words-open', 'Add your own words')"), '"Add your own words" is an option, not a main button');
});

check('narrow screens: a Preview button in reach opens it full screen; no device switch on a phone; the frame fits the screen', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("'Preview my site'") && ed.includes("{ attrs: { 'data-sb-narrow-only': '', style: 'position:sticky;bottom:12px;"), 'sticky on the block wrapper, so it stays in reach');
    assert.ok(ed.includes("slot.toggleAttribute('data-sb-full', !!state.previewFull)") && ed.includes("btn('data-site-preview-close', 'Close preview', true)"));
    assert.ok(/<div class="flex gap-1" data-sb-wide-only>/.test(ed));
    assert.ok(ed.includes('height:min(720px, 70vh)'));
    assert.ok(/activate\(surface\) \{\s*setPreviewFull\(false\);/.test(ed), 'leaving the tab never leaves the preview covering the page');
});

check('dialogs built here keep keyboard focus and give it back; switching device or mode changes only the frame', () => {
    const dj = read('dialogs.js');
    assert.ok(/window\.holdDialogFocus = function \(root, first\)/.test(dj) && /before\.focus\(\)/.test(dj));
    const ed = read('src/components/assistant-site-editor.js');
    assert.strictEqual((ed.match(/window\.holdDialogFocus\(back, back\.querySelector\('\[data-tpl-close\]'\)\)/g) || []).length, 2, 'template viewer and gallery');
    assert.ok(ed.includes("if (dv) { view.device = dv.dataset.tplDevice; update(); return; }") && !/view\.(mode|keepColours) = [^;]+; paint\(\);/.test(ed));
    assert.ok(/window\.holdDialogFocus\(back, \$\('\[data-mp-close\]'\)\)/.test(read('src/components/media-picker.js')));
});

check('adding a section: a picker that says what each is for, and "+ Add here" between sections', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(!ed.includes('data-site-new-type'), 'the bare list of names is gone');
    assert.ok(/const TYPE_INFO = \{[\s\S]{0,200}hero: \[/.test(ed) && ed.includes('data-site-new-section="${esc(t)}"'));
    assert.ok(ed.includes('data-site-add-open data-at="${i}"'));
    assert.ok(ed.includes("...(ed.index != null && !moving ? { index: ed.index } : {})"), 'added where it was asked for');
    const r = applySiteOperation(site(), { op: 'add_section', pageId: site().pages[0].id, section: { type: 'faq', props: { items: [{ q: 'Q?', a: 'A.' }] } }, index: 0 } as never);
    assert.ok(r.ok && r.definition.pages[0].sections[0].type === 'faq', 'the server honours the position');
});

check('a picture with no description: said in words, announced, and Save stops before the server drops it', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('data-g-alt data-alt-needed aria-required="true"') && ed.includes("im.alt ? '' : 'aria-invalid=\"true\"'"));
    assert.ok(ed.includes('Needed — a few words on what it shows.') && ed.includes('still need${missing === 1 ?'));
    assert.ok(/const noAlt = \[\.\.\.form\.querySelectorAll\('\[data-alt-needed\]'\)\][\s\S]{0,500}role="alert"[\s\S]{0,600}return;/.test(ed));
    assert.ok(/matches\('\[data-alt-needed\]'\)\) markAlt\(e\.target\)/.test(ed), 'kept in step as they type');
});

console.log(`\n${passed}/${total} passed\n`);
