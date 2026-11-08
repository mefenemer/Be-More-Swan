// tests/pdf-parse-external.test.ts
// Every Netlify function that imports pdf-parse must ship it unbundled (netlify.toml
// external_node_modules), and must load it inside the handler, not at the top of the file.
//
// WHY. Bundled to CJS, pdfjs-dist 5 loses import.meta.url, can't load @napi-rs/canvas for its
// DOMMatrix polyfill, and throws "DOMMatrix is not defined" as the module loads. On prod that
// killed process-asset-background before its handler ran, so from July to 2026-11-08 every brand
// document sat at 'confirmed' with no text and no assistant ever read one (Kudzu, feature request
// #4: "the assistant has no access to brand documents").
//
// Run:  npx tsx tests/pdf-parse-external.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const toml = readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const fnDir = path.join(root, 'netlify/functions');
const utilDir = path.join(root, 'src/utils');

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const importsPdf = (src: string) => /from 'pdf-parse'|import\('pdf-parse'\)|require\('pdf-parse'\)/.test(src);
const utilsWithPdf = readdirSync(utilDir).filter((f) => f.endsWith('.ts') && importsPdf(readFileSync(path.join(utilDir, f), 'utf8'))).map((f) => f.replace(/\.ts$/, ''));

function block(name: string): string {
    const at = toml.indexOf(`[functions.${name}]`);
    if (at < 0) return '';
    const next = toml.indexOf('\n[', at + 1);
    return toml.slice(at, next < 0 ? undefined : next);
}

for (const file of readdirSync(fnDir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(fnDir, file), 'utf8');
    const direct = importsPdf(src);
    const viaUtil = utilsWithPdf.find((u) => src.includes(`src/utils/${u}'`));
    if (!direct && !viaUtil) continue;
    const name = file.replace(/\.ts$/, '');
    check(`${name} ships pdf-parse, pdfjs-dist and @napi-rs/canvas unbundled`, () => {
        const b = block(name);
        assert.ok(b, `no [functions.${name}] block in netlify.toml`);
        for (const m of ['pdf-parse', 'pdfjs-dist', '@napi-rs/canvas']) assert.ok(b.includes(`"${m}"`), `${m} missing from external_node_modules`);
    });
    check(`${name} includes the files the trace misses (canvas binary, pdf.worker.mjs)`, () => {
        const b = block(name);
        for (const f of ['node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'node_modules/@napi-rs/canvas/**', 'node_modules/@napi-rs/canvas-*/**']) {
            assert.ok(b.includes(`"${f}"`), `${f} missing from included_files`);
        }
    });
    if (direct) check(`${name} loads pdf-parse inside the handler, not at the top`, () => {
        assert.ok(!/^import [^;]*from 'pdf-parse'/m.test(src), 'top-level import of pdf-parse');
    });
}

console.log(`\n${passed}/${total} passed`);
if (passed !== total || total === 0) process.exit(1);
