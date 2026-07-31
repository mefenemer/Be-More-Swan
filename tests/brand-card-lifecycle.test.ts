// tests/brand-card-lifecycle.test.ts
// "Unused generated cards expire; edited ones are kept." The rule, and the cases that make it safe.
//
// ── What this is protecting ─────────────────────────────────────────────────────────────────────
// Auto-generated brand cards had no lifecycle: content-assets.ts lists every row the user owns, so
// a card whose post was deleted, replaced or never published stayed in My Content for ever, and
// nothing ever set retention_delete_after on it. On prod, 26 of the 30 content_assets rows with real
// R2 bytes were brand cards — effectively the whole footprint of post media.
//
// The fix removes an unused card after 30 days, which means this predicate now decides whether
// somebody's file gets deleted. The dangerous direction is a FALSE POSITIVE — calling a card unused
// when a human had touched it — so most of what follows is the exemptions, not the happy path.
//
// Run:  npx tsx tests/brand-card-lifecycle.test.ts

import assert from 'node:assert';
import {
    BRAND_CARD_UNUSED_RETENTION_MS,
    BRAND_CARD_PROVIDER,
    isExpiringBrandCard,
    brandCardExpiresAt,
    type BrandCardLifecycleRow,
} from '../src/utils/brand-card-lifecycle';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const DAY = 24 * 60 * 60 * 1000;
const card = (over: Partial<BrandCardLifecycleRow> = {}): BrandCardLifecycleRow => ({
    id: 1,
    provider: BRAND_CARD_PROVIDER,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    purgedAt: null,
    libraryKeptAt: null,
    ...over,
});

console.log('\nbrand card lifecycle\n');

// ── The rule ────────────────────────────────────────────────────────────────────────────────────
check('a generated card nobody used or touched is on the clock', () => {
    assert.strictEqual(isExpiringBrandCard(card(), false), true);
});

check('the window is 30 days from creation, not from the sweep', () => {
    assert.strictEqual(BRAND_CARD_UNUSED_RETENTION_MS, 30 * DAY);
    const at = brandCardExpiresAt(card(), false);
    assert.strictEqual(at?.toISOString(), '2026-07-31T00:00:00.000Z');
});

// ── The exemptions. Every one of these is a card that must NOT be deleted ───────────────────────
check('a card attached to a post is never unused', () => {
    assert.strictEqual(isExpiringBrandCard(card(), true), false);
    assert.strictEqual(brandCardExpiresAt(card(), true), null);
});

check('a card the user edited or Kept is exempt for good', () => {
    const kept = card({ libraryKeptAt: new Date('2026-07-02T00:00:00Z') });
    assert.strictEqual(isExpiringBrandCard(kept, false), false);
    assert.strictEqual(brandCardExpiresAt(kept, false), null);
});

check('being edited outranks being old — age never overrides the exemption', () => {
    const ancient = card({ createdAt: new Date('2020-01-01T00:00:00Z'), libraryKeptAt: new Date('2020-01-02T00:00:00Z') });
    assert.strictEqual(isExpiringBrandCard(ancient, false), false);
});

// ── Blast radius. This rule applies to ONE provider and must not reach anything else ────────────
check('uploads, stock and AI images are untouched', () => {
    for (const provider of [null, 'fal', 'pexels', 'canva', 'remotion']) {
        assert.strictEqual(
            isExpiringBrandCard(card({ provider }), false), false,
            `provider ${String(provider)} must not expire under the brand-card rule`,
        );
    }
});

check('an already-purged row is not re-clocked', () => {
    assert.strictEqual(isExpiringBrandCard(card({ purgedAt: new Date() }), false), false);
});

// ── The countdown the user sees and the purge the cron runs read the SAME predicate ─────────────
// If these ever diverge the failure is silent and one-way: a card with no visible countdown that
// disappears anyway. Asserting they agree is the only cheap way to keep them honest.
check('expiry date is non-null exactly when the card is expiring', () => {
    const cases: Array<[BrandCardLifecycleRow, boolean]> = [
        [card(), false],
        [card(), true],
        [card({ libraryKeptAt: new Date() }), false],
        [card({ provider: 'fal' }), false],
        [card({ purgedAt: new Date() }), false],
    ];
    for (const [row, attached] of cases) {
        assert.strictEqual(
            brandCardExpiresAt(row, attached) !== null,
            isExpiringBrandCard(row, attached),
            'brandCardExpiresAt and isExpiringBrandCard disagreed',
        );
    }
});

console.log(`\n${passed}/${total} passed\n`);
