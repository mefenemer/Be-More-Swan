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

check('Set up, Design, Pages and Publish are sub tabs of Website, not the page\'s tabs; an old name opens the sub tab', () => {
    const html = read('assistant-detail.html');
    for (const k of ['setup', 'design', 'pages', 'publish']) assert.ok(!html.includes(`maintab-btn-site${k}`), k);
    assert.ok(!html.includes('site-pages-badge') && !html.includes('site-publish-dot'), 'their marks are on the sub tabs');
    const a = read('assistants.js');
    assert.ok(a.includes("const _SITE_SUBTAB_OF = { sitesetup: 'setup', sitedesign: 'design', sitepages: 'pages', sitepublish: 'publish' };"));
    assert.ok(a.includes("if (siteSubtab) name = 'sitebuilder';") && a.includes("ed.activate('website', siteSubtab)"));
});

check('Website, Enquiries, Orders, Bookings — each its own tab, in that order, rendered into its own host', () => {
    const html = read('assistant-detail.html');
    const at = (id: string) => html.indexOf(`id="maintab-btn-${id}"`);
    assert.ok(at('sitebuilder') < at('siteenquiries') && at('siteenquiries') < at('siteorders') && at('siteorders') < at('sitebookings') && at('sitebookings') < html.indexOf('id="maintab-btn-calendar"'));
    for (const h of ['website', 'enquiries', 'orders', 'bookings']) assert.ok(html.includes(`data-site-host="${h}"`), h);
    const a = read('assistants.js');
    assert.ok(a.includes("if (name === 'siteorders') siteEditor((ed) => ed.activate('orders'));"));
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes("const SUBTABS = [['chat', 'Preview'], ['setup', 'Set up'], ['design', 'Design'], ['pages', 'Pages'], ['publish', 'Publish']];") && ed.includes("['templates', templatesCard(false), { keep: true }]"), 'the Website tab keeps only its own panels — Templates its own, or nobody with a site finds it');
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
    assert.ok(ed.includes("['first-draft', step === 3 || s.drafting ? draftCard('start') : '', stepOpen]") && ed.includes("['draft', !fresh && (s.drafting || (def().settings.template && !s.publishedVersion)) ? draftCard('start') : '']") && ed.includes("['draft-again', draftCard('again')]"), 'step 3 of a new site, or up front on one started from a template');
    assert.ok(ed.includes("['details', detailsPanel()],\n      ['draft-again', draftCard('again')],") && ed.includes('Start again from scratch'));
    assert.ok(!ed.includes('          ${draftCard()}'), 'no longer under every panel');
});

console.log('\nPainting (UI review, 2026-10-21)');

check('a click or the drafting poll no longer reloads the preview or wipes what was typed', () => {
    const ed = read('src/components/assistant-site-editor.js');
    // The preview frame is made once; its address changes only when what it shows changed.
    assert.ok(ed.includes("if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src; }"));
    assert.ok(!/host\.innerHTML = `[\s\S]{0,200}previewHtml/.test(ed), 'the whole tab is no longer one innerHTML write');
    // The template galleries are rewritten only when their HTML changed.
    assert.ok(ed.includes("['first-templates', step === 2 && !def().settings.template ? templatesCard(true) : '', { keep: true, ...stepOpen }]"));
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
    assert.ok(ed.includes("['publish', fresh ? card(") && ed.includes("There's nothing to publish yet."), 'Publish waits for a draft');
    assert.ok(ed.includes("primary && !quietPrimary ? 'btn-primary'") && ed.includes("quietPrimary = fresh && !state.editing && state.panel !== 'setup';"));
    assert.ok(ed.includes("btn('data-site-words-open', 'Add your own words')"), '"Add your own words" is an option, not a main button');
});

check('narrow screens: a Preview button in reach opens it full screen; no device switch on a phone; the frame fits the screen', () => {
    const ed = read('src/components/assistant-site-editor.js');
    // In the tab header, left of Full screen (owner, 2026-11-10); on the Preview tab only on a phone.
    assert.ok(ed.includes(">Preview my site</button>`") && ed.includes("right: `${preview}${full}${newPage}`"), 'Preview my site sits left of Full screen');
    assert.ok(ed.includes("${state.panel === 'chat' ? 'data-sb-narrow-only ' : ''}"), 'beside the preview on a wide screen, no second way to it');
    assert.ok(!ed.includes("['preview-open',") && !ed.includes("['preview-jump',"), 'no button at the bottom of the column any more');
    assert.ok(ed.includes("slot.toggleAttribute('data-sb-full', !!state.previewFull)") && ed.includes("btn('data-site-preview-close', 'Close preview', true)"));
    // Desktop / Phone: a grey two-way toggle, wide screens only (owner, 2026-11-07).
    assert.ok(/<span class="inline-flex gap-1 p-1 rounded-lg bg-gray-100" data-sb-wide-only role="group" aria-label="Preview size">/.test(ed));
    assert.ok(ed.includes('height:min(720px, 70vh)'));
    assert.ok(/activate\(surface, panel\) \{[\s\S]{0,300}setPreviewFull\(false\);/.test(ed), 'leaving the tab never leaves the preview covering the page');
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

console.log('\nLow items (UI review, 2026-10-21)');

check('tabs say which is selected; loading text is readable; Publish says why it is greyed out; no second accent colour', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(ed.includes('data-site-page="${esc(x.id)}" aria-pressed="${x.id === p.id}"'));
    assert.ok(!/text-gray-400[^"]*">Loading/.test(ed), 'loading text at least gray-500');
    assert.ok(ed.includes("${s.publishBlocker ? `<p class=\"text-xs font-semibold text-amber-800 mt-2\">${esc(s.publishBlocker)}</p>` : ''}"), 'shown before an address exists too');
    assert.ok(!ed.includes('indigo'), 'emphasis uses the brand pink (emerald-200/800, remapped in input.css)');
    assert.ok(/aria-label="Use picture \$\{i \+ 1\} of \$\{all\.length\}" data-mp-ai-pick/.test(read('src/components/media-picker.js')));
});

check('the editor loads only for a Website Assistant, when first needed', () => {
    const ws = read('workspace.html');
    const a = read('assistants.js');
    assert.ok(!ws.includes('<script src="/src/components/assistant-site-editor.js">'));
    assert.ok(/function siteEditor\(fn\) \{\s*if \(window\.AssistantSiteEditor\) \{ fn\(window\.AssistantSiteEditor\); return; \}/.test(a));
    assert.ok(!/window\.AssistantSiteEditor\?\./.test(a), 'every call goes through siteEditor()');
    assert.ok(a.includes('siteEditor((ed) => ed.init({ assistantId: data.id, assistantName: data.name }));'));
});

check('owner 2026-11-10: delete the page you are on, from beside its sections; never the home page', () => {
    const ed = read('src/components/assistant-site-editor.js');
    const panel = ed.slice(ed.indexOf('function pagesPanel()'), ed.indexOf('function menuPlaceHtml('));
    assert.ok(panel.includes("btn(`data-site-remove-page aria-label=\"Delete the page ${esc(p.title)}\"`, 'Delete this page')"));
    assert.ok(panel.indexOf('Delete this page') < panel.indexOf('Sections on') + 400, 'beside the heading, not at the bottom of Page details');
    assert.ok(panel.includes("The home page can\\'t be deleted"));
});

check('owner 2026-11-10: What your website does is questions in order, follow-ups shown when relevant', () => {
    const ed = read('src/components/assistant-site-editor.js');
    assert.ok(/const FEATURE_STEPS = \[[\s\S]{0,200}How do customers buy from you or book\?/.test(ed));
    assert.ok(ed.includes("keys: [['hours', ['visit', 'bookings']], ['menu', ['visit']]]"), 'hours when people visit or book; a menu when they visit');
    assert.ok(ed.includes('data-site-visit') && ed.includes('function syncFeatureReveal(form)'));
    assert.ok(ed.includes("if (!show) { const cb = row.querySelector('input'); if (cb) cb.checked = false; }"), 'a hidden choice is never saved as on');
    // Every feature is still offered somewhere: the steps and the "More" fallback.
    const keys = ['shop', 'bookings', 'menu', 'hours', 'gallery', 'reviews', 'signup', 'faq', 'listings', 'stays'];
    const steps = ed.slice(ed.indexOf('const FEATURE_STEPS'), ed.indexOf('function featuresCard('));
    for (const k of keys) assert.ok(steps.includes(`'${k}'`), `${k} is in a step`);
});

check('owner 2026-11-10: Add a section shows the kinds in groups; every kind has a group', () => {
    const ed = read('src/components/assistant-site-editor.js');
    const g = ed.slice(ed.indexOf('const SECTION_GROUPS'), ed.indexOf('function addPickerHtml('));
    const types = ['hero', 'features', 'steps', 'text', 'faq', 'testimonials', 'cta', 'contact', 'signup', 'products', 'booking', 'hours', 'menu', 'gallery', 'reviews', 'social_feed', 'blog_posts', 'listings', 'stays'];
    for (const t of types) assert.ok(g.includes(`'${t}'`), `${t} is grouped`);
    assert.ok(ed.includes("['More', types.filter((t) => !grouped.has(t))]"), 'a new kind still shows');
});

check('owner 2026-11-10: the chat picture cards open My Content', () => {
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('data-sp-go="library"') && reg.includes('function fromLibrary()') && reg.includes('window.MediaPicker.open({'));
    assert.ok(reg.includes("ui.source === 'library' ? 'library' : 'ai'"));
    assert.ok(reg.includes('data-pp-go="library"'));
    assert.ok(read('workspace.html').includes("if (d.source === 'library') {\n        gpAiUseOwn();"));
    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(orch.includes('"source":"library"|"ai"|"stock"') && orch.includes('add "source": "library" when they want one of their own from My Content'));
    assert.ok(!orch.includes('point them to the paperclip in this chat, or "Choose picture or video" on the section'));
});

console.log(`\n${passed}/${total} passed\n`);
