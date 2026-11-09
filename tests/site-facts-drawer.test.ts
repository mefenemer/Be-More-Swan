// tests/site-facts-drawer.test.ts — Business Information facts entered beside the Website Assistant
// (docs/website-business-info-inline-plan.md, Phase 1). The Products and Stays editors are ONE component
// each, mounted by the Business Information page and by the Website Assistant's side drawer, saving
// through the same endpoint. Nothing is stored twice and no link sends the owner to another page.
//
// Run:  npx tsx tests/site-facts-drawer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const products = read('src/components/products-editor.js');
const stays = read('src/components/stays-editor.js');
const drawer = read('src/components/site-facts-drawer.js');
const site = read('src/components/assistant-site-editor.js');
const assets = read('assets.html');
const workspace = read('workspace.html');

console.log('\nthe editors open anywhere');

check('Products is one mountable editor, saved through org-products', () => {
    assert.ok(products.includes('window.BizInfoEditors.products = { mount }'));
    assert.ok(products.includes("const API = '/.netlify/functions/org-products';"));
    assert.ok(products.includes("const byId = (id) => root.querySelector('#' + id);"));
    // Every lookup is inside its root, except finding the Business Information panel to mount into.
    const lookups = products.match(/document\.(getElementById|querySelector(All)?)\(/g) || [];
    assert.strictEqual(lookups.length, 2, `document lookups: ${lookups.length}`);
});

check('the drawer copy leaves out the business-wide questions; the page keeps them', () => {
    assert.ok(products.includes('root.innerHTML = (opts.compact ? TOP_COMPACT : TOP + SETTINGS) + BOTTOM;'));
    const settings = products.slice(products.indexOf('const SETTINGS = `'), products.indexOf('const BOTTOM = `'));
    assert.ok(settings.includes('id="op-offer"') && settings.includes('id="op-intro"') && settings.includes('id="op-cta"'));
    const compact = products.slice(products.indexOf('const TOP_COMPACT = `'), products.indexOf('const SETTINGS = `'));
    assert.ok(compact.includes('Prices live here only') && !compact.includes('<h2'), 'no second heading under the drawer title');
});

check('Business Information still shows both editors, and the Hours tab still gets the offer', () => {
    assert.ok(assets.includes('<div id="products-root">') && assets.includes('src="/src/components/products-editor.js'));
    // An added external script runs after the inline Hours script, so BizOffer stays inline.
    const bizOffer = assets.indexOf('window.BizOffer = window.BizOffer ||');
    const hoursUse = assets.indexOf('window.BizOffer?.get().then(applyOffer)');
    assert.ok(bizOffer > 0 && hoursUse > bizOffer, 'BizOffer is defined inline before the Hours script uses it');
    assert.ok(!assets.includes("const listEl = document.getElementById('op-list');"), 'the old inline Products script is gone');
    assert.ok(stays.includes('window.BizInfoEditors.stays = { mount }'));
});

check('both editors say when something changed, after every kind of save', () => {
    assert.strictEqual((products.match(/changed\(\);/g) || []).length, 4);
    assert.ok(products.includes("new CustomEvent('bizinfo:products'"));
    assert.ok((stays.match(/changed\(\);/g) || []).length >= 5);
    assert.ok(stays.includes("new CustomEvent('bizinfo:stays'"));
});

check('the drawer can open straight into a new or existing item', () => {
    assert.ok(products.includes('if (!opened && opts.openNew)') && products.includes('opts.productId'));
    assert.ok(stays.includes("opts.newType === 'whole' || opts.newType === 'room'") && stays.includes('opts.stayId'));
});

console.log('\nthe drawer');

check('loaded on the workspace, a modal dialog below the media picker and dialogs', () => {
    assert.ok(workspace.includes('<script src="/src/components/site-facts-drawer.js"></script>'));
    assert.ok(drawer.includes('z-index:10500') && read('src/components/media-picker.js').includes('z-index:11000'));
    assert.ok(drawer.includes('role="dialog" aria-modal="true" aria-labelledby="sfd-title"'));
    // Esc and Tab are left to a picker or dialog opened from inside it.
    assert.ok(drawer.includes(`[...document.querySelectorAll('[aria-modal="true"]')].some((x) => !el.contains(x))`));
});

check('it says where things are saved, and offers the full page', () => {
    assert.ok(drawer.includes('Saved to your Business Information, so your other assistants use it too.'));
    assert.ok(drawer.includes('Open in Business Information'));
    assert.ok(drawer.includes("editor.mount(host, { ...((o && o.options) || {}), compact: true, onSaved: o && o.onSaved })"));
});

console.log('\nthe website editor');

check('Products and Stays open in the drawer — no trip to another page', () => {
    assert.ok(site.includes("openFacts('products', openProducts.dataset.siteOpenProducts === 'new' ? { openNew: true } : {})"));
    assert.ok(!site.includes("window._bizinfoInitialTab = 'products'"), 'no hand-off to the Products tab');
    assert.ok(!site.includes("'Business Information ▸ Products & Services')}"), 'no button labelled with the other page');
    assert.ok(site.includes("btn('data-site-open-products=\"new\"', '+ Add a product or service')"));
});

check('what is saved in the drawer is read back and the preview reloads', () => {
    const at = site.indexOf('function factsSaved()');
    assert.ok(at > 0);
    const body = site.slice(at, at + 400);
    assert.ok(body.includes('await load();') && body.includes('state.version++;') && body.includes('rerender();'));
    assert.ok(site.includes('window.SiteFactsDrawer.open({ kind, options, onSaved: factsSaved })'));
});

console.log(`\n${passed}/${total} passed`);
