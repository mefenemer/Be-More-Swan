// tests/system-map.test.ts — System Map Phase 1 (docs/system-map-plan.md).
// Every priced model groups under a real system; the last unlogged paid calls (Remotion renders,
// whisper, tour narration) now log; fixed bills pro-rate correctly.
// Run:  npx tsx tests/system-map.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    LIST_PRICE_PER_1K, MEDIA_LIST_PRICE_USD, SERVICE_UNIT_PRICE_USD, REMOTION_USAGE_MODEL,
    transcriptionCostUsd, speechCostFromTextUsd,
} from '../src/utils/ai-usage';
import { systemForUsageModel, fixedCostForPeriod } from '../src/utils/system-map';
import { renderCostUsd } from '../src/lib/remotion-lambda';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

console.log('\nSystem Map — costs group by system, every paid call logs');

const registry = read('src/utils/system-registry.ts');
const registryKeys = new Set([
    ...[...registry.matchAll(/key: '([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...registry.matchAll(/connector\('([a-z0-9]+)'/g)].map((m) => m[1]),
]);

check('every priced model maps to a system', () => {
    const models = [
        ...Object.keys(LIST_PRICE_PER_1K), ...Object.keys(MEDIA_LIST_PRICE_USD), ...Object.keys(SERVICE_UNIT_PRICE_USD),
        REMOTION_USAGE_MODEL, 'whisper-1', 'gpt-4o-mini-tts', 'eleven_multilingual_v2', 'omni-moderation-latest',
    ];
    const orphans = models.filter((m) => !systemForUsageModel(m));
    assert.deepStrictEqual(orphans, [], `no system for: ${orphans.join(', ')} — add a rule in src/utils/system-map.ts`);
});

check('every system a rule names exists in the registry', () => {
    const named = ['claude-x', 'fal-ai/x', 'stable-audio-3', 'voyage-x', 'eleven_x', 'gpt-x', 'gemini-x', 'serper-search', 'hunter-x', 'remotion-lambda']
        .map(systemForUsageModel);
    const missing = named.filter((s) => !s || !registryKeys.has(s));
    assert.deepStrictEqual(missing, []);
});

check('an unknown or empty model maps to nothing', () => {
    assert.strictEqual(systemForUsageModel('mystery-model'), null);
    assert.strictEqual(systemForUsageModel(''), null);
    assert.strictEqual(systemForUsageModel(null), null);
});

check('the registry lists the systems that were missing', () => {
    for (const k of ['openai', 'elevenlabs', 'stability', 'remotion', 'hunter', 'companies-house', 'gemini', 'canva', 'googlecalendar', 'outlook']) {
        assert.ok(registryKeys.has(k), `registry has no ${k}`);
    }
});

check('Remotion cost: USD only, finite, not negative', () => {
    assert.strictEqual(renderCostUsd({ accruedSoFar: 0.0123, currency: 'USD' }), 0.0123);
    assert.strictEqual(renderCostUsd({ accruedSoFar: 0.5 }), 0.5);
    assert.strictEqual(renderCostUsd({ accruedSoFar: 0.5, currency: 'EUR' }), null);
    assert.strictEqual(renderCostUsd({ accruedSoFar: -1, currency: 'USD' }), null);
    assert.strictEqual(renderCostUsd(null), null);
});

check('whisper and speech prices', () => {
    assert.strictEqual(transcriptionCostUsd(60), '0.006000');
    assert.strictEqual(transcriptionCostUsd(null), '0.000100');      // 1 s floor
    assert.strictEqual(speechCostFromTextUsd(Array(150).fill('word').join(' ')), '0.015000');
});

check('both render paths log the render cost, before the retry', () => {
    for (const f of ['src/utils/video-render.ts', 'netlify/functions/render-post-video-background.ts']) {
        const src = read(f);
        const log = src.indexOf('logRenderCost(progress.costUsd');
        const retry = src.indexOf('shouldRetryRender(progress.error');
        assert.ok(log > 0, `${f} never logs the render cost`);
        assert.ok(retry > log, `${f} must log before the retry, or a retried render's compute is lost`);
    }
});

check('whisper callers and tour narration log their cost', () => {
    assert.ok(read('src/utils/own-voice.ts').includes('logTranscriptionCost('));
    assert.ok(read('src/utils/footage-review.ts').includes('logTranscriptionCost('));
    assert.ok(read('netlify/functions/tour-narration.ts').includes('speechCostFromTextUsd(text)'));
});

check('fixed bill: pro-rated by day and clipped to when it ran', () => {
    const from = new Date('2026-10-01T00:00:00Z'), to = new Date('2026-10-31T00:00:00Z');   // 30 days
    assert.strictEqual(fixedCostForPeriod({ amountMonthly: 30.44, startedOn: '2026-01-01', endedOn: null }, from, to), 30);
    assert.strictEqual(fixedCostForPeriod({ amountMonthly: 30.44, startedOn: '2026-10-21', endedOn: null }, from, to), 10);
    assert.strictEqual(fixedCostForPeriod({ amountMonthly: 30.44, startedOn: '2026-01-01', endedOn: '2026-10-05' }, from, to), 5);
    assert.strictEqual(fixedCostForPeriod({ amountMonthly: 30.44, startedOn: '2026-11-01', endedOn: null }, from, to), 0);
});

check('fixed-costs SQL and Drizzle mirror agree on the table', () => {
    assert.ok(read('db/z-system-fixed-costs.sql').includes('CREATE TABLE IF NOT EXISTS system_fixed_costs'));
    assert.ok(read('db/schema.ts').includes('pgTable("system_fixed_costs"'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
