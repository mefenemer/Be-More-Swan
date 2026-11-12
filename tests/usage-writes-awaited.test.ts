// tests/usage-writes-awaited.test.ts — every ai_usage_log write is awaited (2026-11-12).
//
// WHY: every cost write used to be fire-and-forget (`void logAiUsage(...)`, and helpers that did the
// same inside). A Netlify function can be frozen the moment it returns, so a write started just
// before the return often never ran: a live Haiku 5.5 call on staging returned 200 and left no row,
// and COGS and the System Map read low by however many were lost. This fails if one comes back.
// Run:  npx tsx tests/usage-writes-awaited.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(root, dir))) {
        const rel = join(dir, name);
        if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel));
        else if (rel.endsWith('.ts')) out.push(relative(root, join(root, rel)));
    }
    return out;
}
const sources = [...walk('netlify/functions'), ...walk('src')];
const WRITERS = 'logAiUsage|logMessageUsage|logMediaCost|logServiceCost|logRenderCost|logTranscriptionCost';

console.log('\nUsage writes — awaited, never fire-and-forget');

check('no `void` cost write anywhere', () => {
    const hits = sources.filter((f) => new RegExp(`void (${WRITERS})\\(`).test(readFileSync(join(root, f), 'utf8')));
    assert.deepStrictEqual(hits, []);
});

check('every cost-write call is awaited or returned', () => {
    const bad: string[] = [];
    for (const f of sources) {
        const lines = readFileSync(join(root, f), 'utf8').split('\n');
        lines.forEach((ln, i) => {
            if (/^\s*(\/\/|\*|\/\*|import )/.test(ln)) return;
            const re = new RegExp(`(?<![\\w.])(${WRITERS})\\(`, 'g');
            let m: RegExpExecArray | null;
            while ((m = re.exec(ln))) {
                const before = ln.slice(0, m.index);
                if (/(export )?(async )?function\s*$/.test(before)) continue;                 // the definition
                if (/(await|return)\s*$/.test(before) || /\?\s*$/.test(before)) continue;   // awaited, returned, or a returned ternary arm
                bad.push(`${f}:${i + 1}: ${ln.trim().slice(0, 100)}`);
            }
        });
    }
    assert.deepStrictEqual(bad, []);
});

check('the helpers return their write, so a caller can await it', () => {
    const src = readFileSync(join(root, 'src/utils/ai-usage.ts'), 'utf8');
    for (const h of ['logMessageUsage', 'logMediaCost', 'logServiceCost', 'logRenderCost', 'logTranscriptionCost']) {
        const at = src.indexOf(`export function ${h}(`);
        assert.ok(at > 0, `${h} missing`);
        const sig = src.slice(at, src.indexOf('{\n', at));
        assert.ok(sig.includes('Promise<void>'), `${h} must return Promise<void>`);
    }
    assert.ok(!src.includes('call with `void logAiUsage'), 'the old "call with void" advice is gone');
});

check('the gateway awaits its own usage row', () => {
    const gw = readFileSync(join(root, 'src/lib/ai-gateway.ts'), 'utf8');
    assert.ok(gw.includes('async function recordUsage(') && (gw.match(/await recordUsage\(req/g) ?? []).length === 2);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
