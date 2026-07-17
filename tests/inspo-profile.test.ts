// tests/inspo-profile.test.ts
// The two properties the Inspo design rests on (src/utils/inspo-profile.ts).
//
// Run:  npx tsx tests/inspo-profile.test.ts
//
// 1. BOUNDED COMPILE — prompt cost must not scale with library size. The distilled profile's
//    OUTPUT being capped is the easy half; the trap is that compiling it means feeding items
//    to a model, and that input is O(items) unless it's explicitly bounded. A regression here
//    doesn't fail loudly — it just makes generation quietly more expensive for the users who
//    adopt the feature most, until someone's compile blows the context window.
//
// 2. AC6 CACHE INVALIDATION — "delete an item and the assistant stops using it immediately".
//    The style profile is a cache, so a deleted item's influence survives inside profile_text
//    until recompile. fingerprintItems() is what makes that detectable, so it's pinned here.
//
// Pure functions only — no DB, no network, no LLM.

import assert from 'node:assert';
import {
    fingerprintItems,
    buildCompileInput,
    COMPILE_BOUNDS,
    type ActiveItem,
} from '../src/utils/inspo-profile';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const t0 = new Date('2026-07-01T00:00:00Z');

function item(id: number, over: Partial<ActiveItem> = {}): ActiveItem {
    return {
        id,
        title: `Item ${id}`,
        kind: 'text',
        userNote: `Note for ${id}`,
        body: `Body for ${id}`,
        updatedAt: t0,
        ...over,
    };
}

console.log('\ninspo-profile: AC6 — cache invalidation fingerprint');

check('same set produces a stable fingerprint', () => {
    assert.equal(fingerprintItems([item(1), item(2)]), fingerprintItems([item(1), item(2)]));
});

check('row order does not change the fingerprint', () => {
    // Guards against the DB returning a different order and forcing pointless recompiles.
    assert.equal(fingerprintItems([item(1), item(2)]), fingerprintItems([item(2), item(1)]));
});

check('REMOVING an item changes the fingerprint (deleted/paused stops counting)', () => {
    // The AC6 assertion: if this ever returned equal, a deleted item's influence would live
    // on inside the cached profile and keep shaping drafts.
    assert.notEqual(fingerprintItems([item(1), item(2)]), fingerprintItems([item(1)]));
});

check('ADDING an item changes the fingerprint', () => {
    assert.notEqual(fingerprintItems([item(1)]), fingerprintItems([item(1), item(2)]));
});

check('EDITING an item changes the fingerprint (updatedAt moves)', () => {
    const edited = item(1, { updatedAt: new Date('2026-07-02T00:00:00Z') });
    assert.notEqual(fingerprintItems([item(1)]), fingerprintItems([edited]));
});

check('an empty set has a stable fingerprint', () => {
    assert.equal(fingerprintItems([]), fingerprintItems([]));
});

console.log('\ninspo-profile: bounded compile input');

check('a small library is included in full', () => {
    const { material, usedIds } = buildCompileInput([item(1), item(2), item(3)]);
    assert.deepEqual(usedIds, [1, 2, 3]);
    assert.ok(material.includes('Note for 1'));
    assert.ok(material.includes('Body for 3'));
});

check('item count is capped — a huge library does not grow the compile call', () => {
    // 500 items: the scenario the whole design exists for.
    const many = Array.from({ length: 500 }, (_, i) => item(i + 1));
    const { usedIds } = buildCompileInput(many);
    assert.equal(usedIds.length, COMPILE_BOUNDS.MAX_COMPILE_ITEMS);
});

check('compile input stays under the char budget even with max-size items', () => {
    // Worst case: every item carrying a full-length note and body.
    const fat = Array.from({ length: 500 }, (_, i) => item(i + 1, {
        userNote: 'n'.repeat(10_000),
        body: 'b'.repeat(100_000),
    }));
    const { material } = buildCompileInput(fat);
    assert.ok(
        material.length <= COMPILE_BOUNDS.MAX_COMPILE_INPUT_CHARS,
        `material was ${material.length} chars, budget is ${COMPILE_BOUNDS.MAX_COMPILE_INPUT_CHARS}`,
    );
});

check('per-item note and excerpt are truncated', () => {
    const { material } = buildCompileInput([item(1, {
        userNote: 'n'.repeat(10_000),
        body: 'b'.repeat(10_000),
    })]);
    assert.ok(!material.includes('n'.repeat(COMPILE_BOUNDS.MAX_NOTE_IN_COMPILE + 1)));
    assert.ok(!material.includes('b'.repeat(COMPILE_BOUNDS.MAX_EXCERPT_IN_COMPILE + 1)));
});

check('newest-first: the cap keeps the most recent items, not arbitrary ones', () => {
    // loadActiveItems orders by updatedAt DESC, so index 0 is newest. Recent inspo best
    // represents current taste — dropping it in favour of stale items would invert the point.
    const many = Array.from({ length: 100 }, (_, i) => item(i + 1));
    const { usedIds } = buildCompileInput(many);
    assert.equal(usedIds[0], 1);
    assert.equal(usedIds[usedIds.length - 1], COMPILE_BOUNDS.MAX_COMPILE_ITEMS);
});

check('usedIds lists ONLY items actually in the material (AC6 correctness)', () => {
    // sourceItemIds is what the AC6 contamination check compares against, so claiming an
    // item shaped the profile when its text never reached the model would be a real lie.
    const fat = Array.from({ length: 200 }, (_, i) => item(i + 1, { body: 'b'.repeat(100_000) }));
    const { material, usedIds } = buildCompileInput(fat);
    for (const id of usedIds) {
        assert.ok(material.includes(`--- INSPO ITEM ${id} (`), `usedIds claims ${id} but material lacks it`);
    }
    // And nothing outside usedIds snuck in.
    const present = [...material.matchAll(/--- INSPO ITEM (\d+) \(/g)].map((m) => Number(m[1]));
    assert.deepEqual(present, usedIds);
});

check('items with neither note nor body are skipped, not counted', () => {
    const { usedIds } = buildCompileInput([
        item(1, { userNote: null, body: null }),
        item(2),
    ]);
    assert.deepEqual(usedIds, [2]);
});

check('an empty library compiles to nothing', () => {
    const { material, usedIds } = buildCompileInput([]);
    assert.equal(material, '');
    assert.deepEqual(usedIds, []);
});

console.log(`\n${passed} passed`);
