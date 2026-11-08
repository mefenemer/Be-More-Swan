// tests/site-builders.test.ts
// The platform adapters behind the Website import (src/utils/site-builders/): every platform has one,
// they are found most-specific first, and a broken adapter can never stop an import.
//
// Run:  npx tsx tests/site-builders.test.ts

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS, adapterFor } from '../src/utils/site-builders';
import { readImportPage } from '../src/utils/site-extract';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;

check('every adapter file is listed once, under its own key', () => {
    const files = readdirSync(join(root, 'src/utils/site-builders')).filter((f) => f.endsWith('.ts') && !['index.ts', 'types.ts'].includes(f)).map((f) => f.replace(/\.ts$/, '')).sort();
    assert.deepStrictEqual(ADAPTERS.map((a) => a.key).sort(), files);
    assert.strictEqual(new Set(ADAPTERS.map((a) => a.key)).size, ADAPTERS.length);
    assert.ok(ADAPTERS.length >= 34);
});

check('the more specific platform wins: Elementor and WooCommerce over WordPress, Wix Studio over Wix', () => {
    const at = (k: string) => ADAPTERS.findIndex((a) => a.key === k);
    assert.ok(at('elementor') < at('wordpress') && at('woocommerce') < at('wordpress') && at('wix-studio') < at('wix'));
    assert.strictEqual(found('<html><head><meta name="generator" content="WordPress 6.6"></head><body class="elementor-kit-5"><main>x</main></body></html>'), 'elementor');
    assert.strictEqual(found('<html><head><meta name="generator" content="WordPress 6.6"></head><body><main>x</main></body></html>'), 'wordpress');
});

check('the saved builder pages are recognised', () => {
    assert.strictEqual(found(readFileSync(join(root, 'tests/fixtures/site-import/wix-home.html'), 'utf8')), 'wix');
    assert.strictEqual(found(readFileSync(join(root, 'tests/fixtures/site-import/sqsp-home.html'), 'utf8')), 'squarespace');
    assert.strictEqual(found('<html><body><main><p>Hand-made page</p></main></body></html>'), null);
});

check('a broken adapter never stops an import, and the page says which adapter read it', () => {
    const a = ADAPTERS.find((x) => x.key === 'carrd')! as { detect: unknown; prepare?: unknown };
    const [d, p] = [a.detect, a.prepare];
    a.detect = () => true;
    a.prepare = () => { throw new Error('boom'); };
    try {
        const page = readImportPage('<html><body><main><h1>Still read</h1><p>Words of the business.</p></main></body></html>', 'https://x.example/');
        assert.strictEqual(page.platform, 'carrd');
        assert.ok(page.blocks.some((b) => b.kind === 'heading'));
    } finally { a.detect = d; a.prepare = p; }
});

check('each platform has its report template to fill in', () => {
    assert.ok(readFileSync(join(root, 'docs/site-import-platforms/README.md'), 'utf8').includes('## Can\'t be done'));
});

console.log(`\n${passed}/${total} passed`);
