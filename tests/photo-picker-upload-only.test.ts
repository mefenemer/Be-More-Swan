// tests/photo-picker-upload-only.test.ts
// A product drafted from a photo must show the real product (owner 2026-11-27): the Shopkeeper's photo pickers — the
// Shop tab's "Add a product from a photo" and the Shopkeeper chat's paperclip — offer only "Upload or library", never
// "find stock" or "create one" (media-picker.js filesOnly). Every other picker is unchanged.
//
// Run:  npx tsx tests/photo-picker-upload-only.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nphoto-picker-upload-only');

check('the picker: filesOnly drops the stock and AI tabs and never opens on stock', () => {
    const mp = read('src/components/media-picker.js');
    assert.ok(mp.includes('const filesOnly = !!opts.filesOnly;'));
    assert.ok(mp.includes("${tabBtn('files', 'Upload or library')}${filesOnly ? '' : `${tabBtn('stock', `Ask ${who} to find stock`)}${tabBtn('ai', `Ask ${who} to create one`)}`}"));
    assert.ok(mp.includes('if (opts.findNow && opts.topic && !filesOnly)'));
    // review #926: a stock or AI picture already saved in the library can't be chosen either.
    // owner 2026-11-27: photos imported from the owner's own website (site_import) are theirs too.
    assert.ok(mp.includes(".filter((a) => !filesOnly || !a.provider || a.provider === 'site_import');"));
    const keep = (a: { provider?: string | null }) => !a.provider || a.provider === 'site_import';
    assert.deepStrictEqual([{ provider: null }, { provider: 'site_import' }, { provider: 'pexels' }, { provider: 'fal' }, { provider: 'brand_card' }].filter(keep).map((a) => a.provider), [null, 'site_import']);
    assert.ok(mp.includes("None of your own photos in your library yet — upload one above."));
});

check('used by the Shop tab photo card and the Shopkeeper chat only', () => {
    const shop = read('src/components/assistant-shop.js');
    const call = shop.slice(shop.indexOf("title: 'Choose a photo of the product'"));
    assert.ok(call.slice(0, 400).includes('filesOnly: true'));
    const chat = read('src/components/chat-session.js');
    const cfg = chat.slice(chat.indexOf('    shopkeeper: {'), chat.indexOf('    shopkeeper: {') + 700);
    assert.ok(cfg.includes('filesOnly: true'), 'the Shopkeeper chat config');
    assert.ok(chat.includes('...(attachCfg.filesOnly ? { filesOnly: true } : {}),'));
    assert.strictEqual((chat.match(/filesOnly: true,/g) || []).length, 1, 'no other chat turns it on');
});

console.log(`\n${passed}/${total} passed`);
