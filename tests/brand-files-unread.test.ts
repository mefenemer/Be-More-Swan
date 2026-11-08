// tests/brand-files-unread.test.ts
// The "Your brand" panel only calls a document or link "used" once words were read from it, and
// never files a PDF or a link as a logo (src/components/brand-files.js).
//
// WHY. Until 2026-11-08 no brand document on prod ever had its words read (netlify.toml, pdf-parse),
// yet the panel listed them as used because their status was 'confirmed'. Kudzu's business
// foundation PDF was also filed under "Brand Logo / Visuals", the dropdown's first option.
//
// Run:  npx tsx tests/brand-files-unread.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = readFileSync(path.join(process.cwd(), 'src/components/brand-files.js'), 'utf8');
const win: Record<string, any> = {};
vm.runInNewContext(src, { window: win, document: {}, console });
const listHtml: (a: unknown[]) => string = win.BrandFiles.listHtml;

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const usedPart = (html: string) => html.split('Not used yet')[0];
const doc = (o: Record<string, unknown>) => ({ id: 1, name: 'Foundation.pdf', category: 'general', assetType: 'brand_document', isFile: true, ...o });

check('a confirmed document with no words yet is "reading", not used', () => {
    const html = listHtml([doc({ status: 'confirmed', hasText: false })]);
    assert.ok(!usedPart(html).includes('Foundation.pdf'));
    assert.ok(html.includes('>reading<'));
});
check('a ready document with no words says no words were found', () => {
    const html = listHtml([doc({ status: 'ready', hasText: false })]);
    assert.ok(html.includes('no words found'));
    assert.ok(!usedPart(html).includes('Foundation.pdf'));
});
check('a ready document with words is used', () => {
    const html = listHtml([doc({ status: 'ready', hasText: true })]);
    assert.ok(!html.includes('Not used yet'));
});
check('a logo needs no words to be used', () => {
    const html = listHtml([doc({ name: 'logo.png', assetType: 'brand_logo', category: 'logo', status: 'confirmed', hasText: false })]);
    assert.ok(!html.includes('Not used yet'));
});
check('a PDF or link is never sent as a logo', () => {
    assert.ok(src.includes("catEl.value === 'logo' && !(file.type || '').startsWith('image/') ? 'general' : catEl.value"));
    assert.ok(src.includes("catEl.value === 'logo' ? 'general' : catEl.value; // a link is never a logo"));
});
check('the asset list returns hasText', () => {
    const fn = readFileSync(path.join(process.cwd(), 'netlify/functions/get-workspace-assets.ts'), 'utf8');
    assert.ok(/hasText:\s+sql<boolean>/.test(fn));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
