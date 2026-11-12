// tests/model-5-5-migration.test.ts — every call moved off Haiku 4.5 / Sonnet 4.6 (2026-11-12).
//
// WHY: the System Map's better-options check found two roles still on models Anthropic lists as
// legacy; the owner asked to move them to 5.5. The 5.5 models are NOT a drop-in swap: they reject
// non-default temperature and assistant prefill, and a reply can open with a thinking block, so
// `content[0].text` reads ''. Every call therefore goes through adaptForModel() and reads replyText().
// This file fails if a legacy model comes back as a call target, or a 5.5 call skips the adapter.
// Run:  npx tsx tests/model-5-5-migration.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptForModel } from '../src/config/model-options';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
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
// Comments may still name the old models (history); code may not.
const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('\nModels — off Haiku 4.5 / Sonnet 4.6');

check('no code calls Haiku 4.5 or Sonnet 4.6 (only the picker list and the price table may name them)', () => {
    const allowed = new Set(['src/config/model-options.ts', 'src/utils/ai-usage.ts']);
    const hits = sources.filter((f) => !allowed.has(f) && /'claude-haiku-4-5|'claude-sonnet-4-6/.test(code(read(f))));
    assert.deepStrictEqual(hits, []);
});

check('the gateway defaults are 5.5 and every gateway call is adapted', () => {
    const gw = read('src/lib/ai-gateway.ts');
    assert.ok(gw.includes("AI_GATEWAY_PRIMARY_MODEL  ?? 'claude-sonnet-5-5'") && gw.includes("AI_GATEWAY_FALLBACK_MODEL ?? 'claude-haiku-5-5'"));
    assert.ok(gw.includes("adaptForModel(params, model, model === req.model ? req.thinking : 'low')"), 'generate');
    assert.ok(gw.includes("adaptForModel(params, m, m === roleModel ? req.thinking : 'low')"), 'grounded');
});

check('every file that calls a 5.5 Haiku/Sonnet directly adapts the request and never reads content[0]', () => {
    const bad: string[] = [];
    for (const f of sources) {
        const src = read(f);
        if (!/messages\.create\(/.test(src) || !/'claude-(haiku|sonnet)-5-5'/.test(src)) continue;
        if (f === 'src/utils/provider-balance.ts') continue;          // a 1-token credit probe, thinking off
        if (!src.includes('adaptForModel(')) bad.push(`${f}: no adaptForModel`);
        if (/\.content\[0\]/.test(src)) bad.push(`${f}: reads content[0]`);
    }
    assert.deepStrictEqual(bad, []);
});

check('the adapter strips temperature and makes room to think on both 5.5 models', () => {
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
        const out = adaptForModel({ model, max_tokens: 120, temperature: 0.9 }, model, 'low') as Record<string, any>;
        assert.strictEqual(out.temperature, undefined, `${model} keeps temperature`);
        assert.deepStrictEqual(out.thinking, { type: 'adaptive' });
        assert.strictEqual(out.output_config?.effort, 'low');
        assert.ok(out.max_tokens > 120, `${model}: a 120-token cap would be eaten by thinking`);
    }
});

check('Off is sent the way each 5.5 model accepts it (Sonnet 5.5 rejects "disabled")', () => {
    assert.deepStrictEqual((adaptForModel({ model: 'x', max_tokens: 10 }, 'claude-haiku-5-5', 'off') as any).thinking, { type: 'disabled' });
    assert.deepStrictEqual((adaptForModel({ model: 'x', max_tokens: 10 }, 'claude-sonnet-5-5', 'off') as any).thinking, { type: 'between_tools' });
});

check('no request ends on an assistant turn (5.5 rejects prefill) in the migrated chat retry', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(/\{ role: 'assistant' as const, content: raw \}, \{ role: 'user' as const, content: CARD_FORMAT_RETRY \}/.test(chat));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
