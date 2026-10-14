// tests/no-native-dialogs.test.ts
// No browser alert() / confirm() / prompt() in the app's own client code.
//
// /dialogs.js replaced all 233 of them on 2026-08-14, with no guard — and by 2026-10-14 twenty-five
// had come back, including "Brief your assistants with this plan?" on the Campaign Assistant, the
// one a user approving a 39-task plan actually sees. Each is a grey box that says "bemoreswan.com
// says" instead of the house dialog. This guard keeps the count at zero.
//
// Allowed: a FALLBACK for a component built to run without /dialogs.js — the native call sits in
// the same statement as the house one (`typeof window.confirmModal === 'function' ? … : confirm`,
// `(window.alertModal || window.alert)`). Excluded: dialogs.js itself, server code, and
// subscribe.js / widget.js, which render on CUSTOMERS' sites where /dialogs.js does not exist.
//
// Run:  npx tsx tests/no-native-dialogs.test.ts

import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = /^(node_modules|dist|docs|tests|scripts|netlify|db|src\/utils|src\/config|src\/generated)\/|^(dialogs|subscribe|widget)\.js$|\.min\.js$/;
const files = execSync("git ls-files '*.js' '*.html'", { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => !EXCLUDE.test(f));

const NATIVE = /(^|[^.\w])(window\.)?(alert|confirm|prompt)\(/;

console.log('no native dialogs');

check('client code uses /dialogs.js, never the browser dialog', () => {
    const offenders: string[] = [];
    for (const f of files) {
        const lines = readFileSync(join(root, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '').trim();
            if (!code || code.startsWith('*') || !NATIVE.test(code)) return;
            // A fallback sits right after the house dialog it stands in for: look at the eight lines above.
            const near = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
            if (/(confirm|prompt|alert|showConfirm)Modal/.test(near)) return;
            offenders.push(`${f}:${i + 1}  ${code.slice(0, 100)}`);
        });
    }
    assert.deepStrictEqual(offenders, [], `native dialogs found:\n      ${offenders.join('\n      ')}`);
});

check('the dialog colours its confirm button by intent, like the app buttons', () => {
    const d = readFileSync(join(root, 'dialogs.js'), 'utf8');
    assert.ok(/golive:\s*\{\s*bg:\s*'#00e55c'/.test(d) && /primary:\s*\{\s*bg:\s*'#d6006b'/.test(d), 'tones do not match input.css');
    assert.ok(!d.includes('#059669'), 'a green that is not the brand is back in the dialog');
});

console.log(`\n${passed} passed`);
