// tests/button-system.test.ts
// Button colour by INTENT (2026-10-03): six semantic classes, defined once, and the buttons that
// were re-classed carry no colour utilities of their own to fight them.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const CATS = ['assistant', 'primary', 'golive', 'secondary', 'destructive', 'utility'];

check('all six are defined in input.css (built on deploy) and the committed style.css', () => {
    for (const f of ['input.css', 'style.css']) {
        const css = read(f);
        for (const c of CATS) {
            assert.match(css, new RegExp(`\\.btn-${c}\\s*\\{[^}]*background-color`), `${f}: .btn-${c} has no colour`);
            assert.match(css, new RegExp(`\\.btn-${c}:focus-visible`), `${f}: .btn-${c} has no focus ring`);
        }
    }
});

check('they sit in @layer components, so a JS state utility still wins', () => {
    const css = read('input.css');
    const at = css.indexOf('.btn-assistant   {');
    assert.ok(css.lastIndexOf('@layer components {', at) !== -1 && css.lastIndexOf('@layer components {', at) > css.lastIndexOf('BUTTON SYSTEM'));
});

check('the brand-correct, AA-contrast values', () => {
    const css = read('input.css');
    assert.match(css, /\.btn-primary\s+\{ background-color: #d6006b; color: #fff;/);
    assert.match(css, /\.btn-assistant\s+\{ background-color: #d6006b;/);
    assert.match(css, /\.btn-golive\s+\{ background-color: #00e55c; color: #1f1e1b;/);
    assert.match(css, /\.btn-destructive \{ background-color: #dc2626;/);
});

check('a re-classed button carries no colour utilities of its own', () => {
    const COL = /\b(?:hover:)?(?:bg|text)-(?:emerald|green|red|indigo|violet|blue|pink)-\d{3}\b/;
    for (const f of ['workspace.html', 'assistant-detail.html', 'admin.html', 'assistants.js', 'integrations.js']) {
        const s = read(f);
        for (const m of s.matchAll(/class="(btn-(?:assistant|primary|golive|secondary|destructive|utility)\b[^"]*)"/g)) {
            assert.doesNotMatch(m[1], COL, `${f}: "${m[1].slice(0, 80)}" still carries a colour utility`);
        }
    }
});

check('the key buttons sit in the right category', () => {
    const d = read('assistant-detail.html');
    assert.match(d, /id="btn-detail-chat" type="button"\s*\n\s*class="btn-assistant /);
    assert.match(d, /id="btn-primary-action"[^>]*\n\s*class="hidden btn-assistant /);
    assert.match(d, /class="btn-assistant transition-colors cursor-pointer shrink-0" type="button">\s*\n\s*<img src="\/images\/BeMoreSwan_SwanAI\.png"/);
    const a = read('assistants.js');
    assert.match(a, /const primary = 'btn-golive /, 'Approve on a review card commits outward');
    assert.match(read('src/components/assistant-onboarding-shell.js'), /data-aos-next class="btn-primary /);
});

console.log(`\n${passed} checks passed`);
