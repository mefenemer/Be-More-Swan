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
import { LIST_PRICE_PER_1K, MEDIA_LIST_PRICE_USD, SERVICE_UNIT_PRICE_USD, costUsdFor, mediaCostUsd, serviceUnitPriceUsd } from '../src/utils/ai-usage';

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
    assert.ok(/planType === 'beta'\) \{ planMrrMap\[p\.orgId\] = \{ amount: 0/.test(cogs), 'a free beta workspace must not be credited with the top tier\'s price');
});

console.log('\nAI media — images, video and music cost something too');

check('every default media model has a price', () => {
    const defaults = [
        ...read('src/lib/fal-gateway.ts').matchAll(/FAL_(?:IMAGE|VIDEO)_MODEL \?\? '([^']+)'/g),
        ...read('src/lib/stability-audio.ts').matchAll(/STABILITY_AUDIO_MODEL \|\| '([^']+)'/g),
    ].map((m) => m[1]);
    assert.strictEqual(defaults.length, 3, `expected the image, video and music defaults, found ${defaults.join(', ')}`);
    const unpriced = defaults.filter((m) => !MEDIA_LIST_PRICE_USD[m]);
    assert.deepStrictEqual(unpriced, [], `add these to MEDIA_LIST_PRICE_USD or they record $0: ${unpriced.join(', ')}`);
});

check('media cost follows the published prices', () => {
    // FLUX: $0.04/MP rounded UP per image — 1024×1024 is 1.05 MP, so 2 MP; 1280×720 is 0.92, so 1.
    assert.strictEqual(mediaCostUsd('fal-ai/flux-pro/v1.1', { images: [{ width: 1024, height: 1024 }, { width: 1280, height: 720 }] }), '0.120000');
    assert.strictEqual(mediaCostUsd('fal-ai/minimax/hailuo-2.3/standard/text-to-video', { durationSeconds: 6 }), '0.280000');
    assert.strictEqual(mediaCostUsd('fal-ai/minimax/hailuo-2.3/standard/text-to-video', { durationSeconds: 10 }), '0.560000');
    assert.strictEqual(mediaCostUsd('stable-audio-3', {}), '0.260000');
    assert.strictEqual(mediaCostUsd('some-unknown-model', { durationSeconds: 6 }), '0');
});

check('every successful generation records its cost — once, where the provider charges', () => {
    const fal = read('src/lib/fal-gateway.ts');
    const gen = fal.slice(fal.indexOf('export async function generateImages('), fal.indexOf('export type VideoDurationSeconds'));
    assert.ok(/logMediaCost\(IMAGE_MODEL, \{ images \}/.test(gen), 'generateImages no longer records image cost');
    assert.ok(/logMediaCost\(job\.model, \{ durationSeconds/.test(read('netlify/functions/process-media-job-background.ts')), 'a completed video job records nothing');
    assert.ok(/extractVideo\([\s\S]{0,120}\n\s*logMediaCost\(VIDEO_MODEL/.test(read('src/utils/visual-briefs.ts')), 'a brief video records nothing');
    const music = read('netlify/functions/process-music-job-background.ts');
    assert.ok(/success: true[\s\S]{0,300}logMediaCost\(job\.model/.test(music), 'a finished music track records nothing (and it must be after the SUCCESS settle)');
    // Nothing reaches fal or Stability around these: a new direct caller would be unpriced.
    const direct = sources.filter((f) => !['src/lib/fal-gateway.ts', 'src/lib/stability-audio.ts', 'src/utils/provider-balance.ts', 'netlify/functions/admin-system-status.ts'].includes(f)
        && /queue\.fal\.run|fal\.run\/|api\.stability\.ai/.test(read(f)));
    assert.deepStrictEqual(direct, [], `these call fal/Stability directly and record no cost:\n    ${direct.join('\n    ')}`);
});

console.log('\nSearch, contact lookups and embeddings');

check('every Serper search, Hunter lookup and Voyage embedding records its cost', () => {
    const search = read('src/lib/discovery-search.ts');
    assert.ok(/searchSerper\([^)]*\);\s*\/\/[^\n]*\n\s*logServiceCost\('serper-search', 1/.test(search), 'a Serper search is not recorded');
    const hunter = read('src/lib/discovery-enrich-provider.ts');
    assert.ok(/logServiceCost\('hunter-domain-search', raw\.length/.test(hunter),
        'Hunter bills a credit per email RETURNED — record raw.length, not 1');
    const embed = read('src/utils/kb-embeddings.ts');
    assert.ok(/payload\.usage\?\.total_tokens/.test(embed) && /logAiUsage\(\{ \.\.\.usage, model: EMBEDDING_MODEL/.test(embed), 'embedding tokens are not recorded');
    assert.ok(LIST_PRICE_PER_1K['voyage-3.5-lite'], 'voyage-3.5-lite has no price');
});

check('callers that know the workspace pass it on', () => {
    assert.ok(/search\(query, \{[^}]*usage: \{ workspaceId: job\.organisation_id/.test(read('netlify/functions/process-discovery-jobs.ts')));
    assert.ok(/lookupProviderContact\(s\.lead\.domain, \{[^}]*usage: \{ workspaceId: job\.organisation_id/.test(read('netlify/functions/process-discovery-jobs.ts')));
    for (const f of ['netlify/functions/kb-articles.ts', 'netlify/functions/inspo-items.ts', 'netlify/functions/process-inspo-background.ts', 'netlify/functions/chat-orchestrator.ts', 'src/utils/inspo-profile.ts']) {
        assert.ok(/embedTexts\([^)]*\{ workspaceId:/.test(read(f)), `${f} embeds without saying whose workspace it is`);
    }
});

check('service prices default to the published rate and can be overridden', () => {
    assert.strictEqual(serviceUnitPriceUsd('serper-search'), Number(process.env.SERPER_COST_USD_PER_QUERY || SERVICE_UNIT_PRICE_USD['serper-search'].fallback));
    const prev = process.env.HUNTER_COST_USD_PER_CREDIT;
    process.env.HUNTER_COST_USD_PER_CREDIT = '0.0105';
    assert.strictEqual(serviceUnitPriceUsd('hunter-domain-search'), 0.0105);
    process.env.HUNTER_COST_USD_PER_CREDIT = 'nonsense';
    assert.strictEqual(serviceUnitPriceUsd('hunter-domain-search'), SERVICE_UNIT_PRICE_USD['hunter-domain-search'].fallback);
    if (prev === undefined) delete process.env.HUNTER_COST_USD_PER_CREDIT; else process.env.HUNTER_COST_USD_PER_CREDIT = prev;
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
