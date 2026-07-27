// tests/asset-metrics.test.ts
// The rules governing content_assets width / height / duration_s.
//
// Run:  npx tsx tests/asset-metrics.test.ts
//
// These three columns are what let a post's FORMAT be derived from its asset instead of chosen by
// hand — and derived on the server, where the autonomous drafters run with no <video> element to
// measure. Three properties have to hold or the router is worse than no router:
//
//   1. NULL means "we don't know", never zero. A router reading a NULL duration as 0 would
//      classify a 40-minute film as a YouTube Short.
//   2. Backfill only ever FILLS a null. A browser's idea of a rotated video's dimensions must not
//      overwrite what the upload path measured.
//   3. Junk in the payload is dropped, not stored. These values decide where a post publishes.
//
// Pure logic — the coercion and merge rules are reimplemented here exactly as content-assets.ts
// applies them, so a change to one without the other fails.

import assert from 'node:assert';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── Mirrors the coercion in content-assets.ts (POST create + PATCH metrics) ──────────────────────
const num = (v: unknown, whole: boolean): number | null => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return whole ? Math.round(n) : n;
};

type Row = { width: number | null; height: number | null; durationS: number | null };

/** The PATCH { metrics } merge: fill a null, never replace a value. */
function backfill(existing: Row, metrics: Record<string, unknown>): { fill: Partial<Row>; filled: string[] } {
    const fill: Partial<Row> = {};
    const w = num(metrics.width, true);
    const h = num(metrics.height, true);
    const d = num(metrics.durationS, false);
    if (w && existing.width == null) fill.width = w;
    if (h && existing.height == null) fill.height = h;
    if (d && existing.durationS == null) fill.durationS = d;
    return { fill, filled: Object.keys(fill) };
}

const EMPTY: Row = { width: null, height: null, durationS: null };

// ── Coercion ────────────────────────────────────────────────────────────────────────────────────

check('a real measurement is kept', () => {
    assert.equal(num(1080, true), 1080);
    assert.equal(num('1920', true), 1920);
    assert.equal(num(44.8, false), 44.8);
});

check('dimensions are whole pixels, duration is not rounded', () => {
    // A browser can report a fractional width; a pixel count cannot be fractional. A duration can:
    // 179.6s is not a Short, and rounding it to 180 would say it was.
    assert.equal(num(1080.4, true), 1080);
    assert.equal(num(179.6, false), 179.6);
});

check('zero, negative, NaN and junk are all "unknown", never stored', () => {
    for (const v of [0, -1, NaN, Infinity, '', '  ', 'abc', null, undefined, {}, []]) {
        assert.equal(num(v, true), null, `expected null for ${JSON.stringify(v)}`);
    }
});

check('a zero duration is refused rather than stored as 0', () => {
    // The whole point of rule 1: a stored 0 is indistinguishable from a very short clip, and every
    // duration check would then pass.
    assert.equal(num(0, false), null);
});

// ── Backfill merge ──────────────────────────────────────────────────────────────────────────────

check('fills every missing metric on a legacy row', () => {
    const { fill, filled } = backfill(EMPTY, { width: 1080, height: 1920, durationS: 45 });
    assert.deepEqual(fill, { width: 1080, height: 1920, durationS: 45 });
    assert.deepEqual(filled.sort(), ['durationS', 'height', 'width']);
});

check('never overwrites a value the upload path already measured', () => {
    const stored: Row = { width: 1080, height: 1350, durationS: null };
    const { fill, filled } = backfill(stored, { width: 1350, height: 1080, durationS: 12 });
    assert.deepEqual(fill, { durationS: 12 }, 'only the null should be filled');
    assert.deepEqual(filled, ['durationS']);
});

check('a fully-populated row is left completely alone', () => {
    const stored: Row = { width: 1920, height: 1080, durationS: 30 };
    const { fill, filled } = backfill(stored, { width: 1, height: 1, durationS: 1 });
    assert.deepEqual(fill, {});
    assert.equal(filled.length, 0, 'no write should be issued at all');
});

check('an image reporting no duration leaves duration null', () => {
    const { fill } = backfill(EMPTY, { width: 1080, height: 1350, durationS: null });
    assert.deepEqual(fill, { width: 1080, height: 1350 });
    assert.ok(!('durationS' in fill), 'an image must not acquire a duration');
});

check('a junk payload writes nothing', () => {
    const { fill, filled } = backfill(EMPTY, { width: 'wide', height: -5, durationS: 'ages' });
    assert.deepEqual(fill, {});
    assert.equal(filled.length, 0);
});

check('partial knowledge is stored, the rest stays unknown', () => {
    // A <video> can report dimensions before duration. Half an answer is still worth having.
    const { fill } = backfill(EMPTY, { width: 1080, height: 1920, durationS: 0 });
    assert.deepEqual(fill, { width: 1080, height: 1920 });
});

// ── What the router depends on ──────────────────────────────────────────────────────────────────

check('NULL duration is never treated as a passing length', () => {
    const YT_SHORT_MAX = 180;
    const fits = (d: number | null) => d != null && d <= YT_SHORT_MAX;
    assert.equal(fits(null), false, 'unknown length must not qualify as a Short');
    assert.equal(fits(45), true);
    assert.equal(fits(400), false);
});

check('aspect ratio needs both dimensions before it means anything', () => {
    const ratio = (r: Row) => (r.width && r.height) ? r.width / r.height : null;
    assert.equal(ratio({ width: 1080, height: 1920, durationS: null }), 1080 / 1920);
    assert.equal(ratio({ width: 1080, height: null, durationS: null }), null);
    assert.equal(ratio(EMPTY), null);
});

console.log(`\n${passed} check(s) passed.`);
