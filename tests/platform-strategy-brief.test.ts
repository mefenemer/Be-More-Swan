// tests/platform-strategy-brief.test.ts
// The per-platform strategy (context.platform_strategy) is captured at onboarding and edited in the
// profile, but for a long time it only reached the model as a raw JSON blob in the blueprint dump —
// never as a directive — because formatPlatformStrategyBrief was called only when building the
// (generation-ignored) system prompt. process-content-jobs.ts now scopes it to the job's platform(s)
// with platformStrategyFor and injects the formatted directive. These tests pin both halves.
//
// Run:  npx tsx tests/platform-strategy-brief.test.ts

import assert from 'node:assert';
import {
    formatPlatformStrategyBrief,
    platformStrategyFor,
    PLATFORM_NAME_TO_STRATEGY_KEY,
    type PlatformStrategy,
} from '../src/utils/platform-strategy-brief';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

console.log('\nPlatform strategy brief — YouTube long/shorts reaches the model\n');

// ── The richer YouTube directives ─────────────────────────────────────────────────────────────────
test('YouTube format choice renders as a clear directive', () => {
    assert.match(formatPlatformStrategyBrief({ youtube: { format: 'shorts' } }) || '', /Prioritise Shorts/);
    assert.match(formatPlatformStrategyBrief({ youtube: { format: 'longform' } }) || '', /Prioritise long-form/);
    assert.match(formatPlatformStrategyBrief({ youtube: { format: 'mix' } }) || '', /Mix Shorts and long-form/);
});

test('the new YouTube levers each add a directive line', () => {
    const brief = formatPlatformStrategyBrief({
        youtube: { format: 'mix', repurpose: true, hooks: true, contentType: 'tutorial', cadence: '3 Shorts + 1 long-form / week', seo: true },
    }) || '';
    assert.match(brief, /Cut short-form clips \(Shorts\) from every long-form/);
    assert.match(brief, /scroll-stopping hook/);
    assert.match(brief, /tutorial \/ how-to/);
    assert.match(brief, /3 Shorts \+ 1 long-form \/ week/);
    assert.match(brief, /YouTube SEO/);
});

test('an unknown contentType is dropped, not echoed raw', () => {
    const brief = formatPlatformStrategyBrief({ youtube: { format: 'mix', contentType: 'bogus' } }) || '';
    assert.doesNotMatch(brief, /bogus/);
});

test('cadence is run through the sanitizer', () => {
    const brief = formatPlatformStrategyBrief(
        { youtube: { format: 'mix', cadence: 'DROP TABLE' } },
        (s) => s.replace(/DROP TABLE/g, '[removed]'),
    ) || '';
    assert.match(brief, /\[removed\]/);
    assert.doesNotMatch(brief, /DROP TABLE/);
});

test('an empty youtube strategy contributes nothing', () => {
    assert.strictEqual(formatPlatformStrategyBrief({ youtube: {} }), null);
});

// ── Per-platform scoping (what the worker injects) ─────────────────────────────────────────────────
test('platformStrategyFor keeps only the requested platforms', () => {
    const ps: PlatformStrategy = { youtube: { format: 'shorts' }, li: { tags: '#x' }, ig: { format: 'reels' } };
    const only = platformStrategyFor(ps, ['youtube']);
    assert.deepStrictEqual(only, { youtube: { format: 'shorts' } }, 'a YouTube job must not carry LinkedIn/IG directions');
});

test('full platform names and aliases map to strategy keys', () => {
    assert.strictEqual(PLATFORM_NAME_TO_STRATEGY_KEY['facebook'], 'fb');
    assert.strictEqual(PLATFORM_NAME_TO_STRATEGY_KEY['twitter'], 'x');   // alias
    assert.strictEqual(PLATFORM_NAME_TO_STRATEGY_KEY['x'], 'x');
    const scoped = platformStrategyFor({ x: { length: 'threads' } }, ['twitter']);
    assert.deepStrictEqual(scoped, { x: { length: 'threads' } }, "the 'twitter' job name must resolve to the x strategy");
});

test('platformStrategyFor returns null when nothing applies', () => {
    assert.strictEqual(platformStrategyFor({ youtube: { format: 'mix' } }, ['linkedin']), null);
    assert.strictEqual(platformStrategyFor(null, ['youtube']), null);
    assert.strictEqual(platformStrategyFor({}, ['youtube']), null);
});

console.log(`\n${passed} passed\n`);
if (process.exitCode) process.exit(process.exitCode);
