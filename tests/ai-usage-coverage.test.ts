// tests/ai-usage-coverage.test.ts
// Every AI call the product makes must land in ai_usage_log, priced, exactly once.
//
// WHY THIS EXISTS. ai_usage_log feeds the COGS dashboard (Admin → Revenue → COGS), the only place
// the real cost of a £29 workspace can be read. On 2026-10-13 it was missing:
//   • 14 callers of the AI gateway — its logging was opt-in, on the belief that callers logged for
//     themselves, and none of the gateway's callers did;
//   • 12 direct Anthropic SDK calls with no logAiUsage at all;
//   • the price of any model with no ai_model_pricing row (nothing seeds that table), so a logged
//     call could still read $0.
// A new AI call that forgets to log compiles, passes every other test and silently makes the
// margin look better than it is. This file fails instead.
//
// No database: source scans plus the pure cost function.
// Run:  npx tsx tests/ai-usage-coverage.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_PRICE_PER_1K, costUsdFor } from '../src/utils/ai-usage';

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
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(root, dir))) {
        const rel = join(dir, name);
        if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel));
        else if (rel.endsWith('.ts')) out.push(rel);
    }
    return out;
}
const sources = [...walk('netlify/functions'), ...walk('src')].map((p) => relative(root, join(root, p)));

/**
 * Direct SDK callers that log nothing THEMSELVES, on purpose: they return their token counts and
 * their caller logs them with the workspace attached. Each entry names where that happens.
 */
const RETURNS_TOKENS_TO_A_LOGGING_CALLER: Record<string, string> = {
    'src/lib/discovery-scoring.ts': 'process-discovery-jobs.ts (scoreCandidates), lead-enrichment.ts (rescoreWithIntel)',
    'src/lib/discovery-query-gen.ts': 'process-discovery-jobs.ts (generateQueries)',
    'src/lib/ai-gateway.ts': 'records every call itself (recordUsage)',
    'src/utils/provider-balance.ts': 'a 1-token health probe, not product usage',
};

console.log('\nAI usage — every call recorded, priced, once');

check('every direct Anthropic SDK call records its usage', () => {
    const missing = sources.filter((f) => {
        const s = read(f);
        if (!/messages\.(create|stream)\(/.test(s)) return false;
        if (RETURNS_TOKENS_TO_A_LOGGING_CALLER[f]) return false;
        return !/logAiUsage|logMessageUsage/.test(s);
    });
    assert.deepStrictEqual(missing, [], `these call the model and record nothing — add logMessageUsage(response, MODEL, {...}) after the call:\n    ${missing.join('\n    ')}`);
});

check('the token-returning helpers really are logged by their callers', () => {
    assert.ok(/logAiUsage\([\s\S]{0,200}gen\.inputTokens/.test(read('netlify/functions/process-discovery-jobs.ts')), 'generateQueries tokens');
    assert.ok(/logAiUsage\([\s\S]{0,200}scored\.inputTokens/.test(read('netlify/functions/process-discovery-jobs.ts')), 'scoreCandidates tokens');
    assert.ok(/logAiUsage\([\s\S]{0,300}rescored\.inputTokens/.test(read('src/utils/lead-enrichment.ts')), 'rescoreWithIntel tokens');
});

check('the gateway records every call, not only those that pass usage', () => {
    const gw = read('src/lib/ai-gateway.ts');
    const fn = gw.slice(gw.indexOf('function recordUsage('), gw.indexOf('\n}\n', gw.indexOf('function recordUsage(')));
    assert.ok(fn.length > 0, 'recordUsage() is gone');
    assert.ok(!/if \(!req\.usage\) return/.test(fn), 'recordUsage must not skip calls without usage — that is how 14 callers cost $0');
    assert.ok(/recordUsage\(req, tokensIn, tokensOut, model\)/.test(gw), 'the grounded path must record the SUM over its resumes');
});

check('no file both calls the gateway and logs for itself (that double-counts)', () => {
    const both = sources.filter((f) => {
        if (f === 'src/lib/ai-gateway.ts') return false;
        const s = read(f);
        return /gatewayGenerate(Grounded)?\(/.test(s) && /logAiUsage\(|logMessageUsage\(/.test(s) && !/messages\.(create|stream)\(/.test(s);
    });
    assert.deepStrictEqual(both, [], `these log a gateway call a second time:\n    ${both.join('\n    ')}`);
});

check('every model the code calls has a list price', () => {
    const models = new Set<string>();
    for (const f of sources) for (const m of read(f).matchAll(/'(claude-[a-z0-9.-]+)'/g)) models.add(m[1]);
    const unpriced = [...models].filter((m) => !LIST_PRICE_PER_1K[m]);
    assert.deepStrictEqual(unpriced, [], `add these to LIST_PRICE_PER_1K in src/utils/ai-usage.ts, or every call to them records $0: ${unpriced.join(', ')}`);
});

check('cost is computed from the rate, and a missing rate is $0 rather than a crash', () => {
    assert.strictEqual(costUsdFor(1000, 1000, { input: 0.003, output: 0.015 }), '0.018000');
    assert.strictEqual(costUsdFor(2_000, 500, LIST_PRICE_PER_1K['claude-haiku-4-5-20251001']), '0.004500');
    assert.strictEqual(costUsdFor(1000, 1000, null), '0');
});

check('the COGS margin query no longer interpolates an array into = ANY()', () => {
    const api = read('netlify/functions/admin-api.ts');
    const cogs = api.slice(api.indexOf("resource === 'cogs-dashboard'"), api.indexOf("resource === 'cogs-workspace-detail'"));
    assert.ok(cogs.length > 0, 'cogs-dashboard handler not found');
    assert.ok(!/= ANY\(\$\{/.test(cogs.replace(/\/\/[^\n]*/g, '')), 'drizzle expands a JS array into a row constructor — 42809. Use inArray().');
    assert.ok(/planType === 'beta' \? 0/.test(cogs), 'a free beta workspace must not be credited with the top tier\'s price');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
