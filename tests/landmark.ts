// tests/landmark.ts
// indexOf for a source landmark, but LOUD when the landmark is gone.
//
// Not a test file — the runner (scripts/run-tests.mjs) globs `*.test.ts`, so this is only ever
// imported, never executed on its own.
//
// WHY THIS EXISTS
//
// Most suites here assert on source TEXT: they slice a file between two string markers and check
// what is inside. That is the right tool for the silent failures — a control that stops saving, a
// guard that moved after the write it was guarding — but a bare `indexOf` makes it lie in two
// different directions, and both were live in this repo:
//
//   1. FALSE RED, at slice bounds.
//        src.slice(src.indexOf('async function foo()'), src.indexOf('// marker'))
//      A renamed `foo` gives -1, and `slice(-1, n)` is an EMPTY STRING (start > end). The assertion
//      then runs against '' and reports "foo must do the important thing" about code that does it
//      perfectly well. It reads as a regression in the feature; it is a stale anchor.
//      Seen 2026-08-14: openGeneratePostSheet gained an optional parameter, the anchor still said
//      `openGeneratePostSheet()`, and CI went red blaming the destination picker.
//
//   2. FALSE GREEN, in ordering checks — the worse one.
//        assert.ok(src.indexOf('escapeHtml') < src.indexOf('<br>'))
//      A renamed `escapeHtml` gives -1, and -1 is less than every real index, so the assertion
//      PASSES. The check goes on reporting green while guarding nothing at all.
//
// Both collapse to the same root cause: -1 is a valid number, so it flows onward as data instead of
// stopping as an error. `landmark` refuses to return it.

import assert from 'node:assert';

/**
 * Find `needle` in `hay`, asserting it is actually there.
 *
 * Drop-in for `hay.indexOf(needle[, from])` at any site where a missing marker means the test can
 * no longer check what it claims to check — which is every slice bound and every ordering
 * comparison. The failure names the marker, so the fix is obvious: re-anchor the test, or restore
 * whatever the source lost.
 *
 * Anchor on `'async function foo('` — WITHOUT the closing paren — so that adding a parameter
 * cannot break the anchor. That single character is what caused the 2026-08-14 outage.
 */
export function landmark(hay: string, needle: string, from?: number): number;
/**
 * Array overload. The ordering trap is not unique to source text: `DEFAULT_ORDER.indexOf('x') <
 * DEFAULT_ORDER.indexOf('y')` passes just as silently when 'x' was renamed out of the array.
 */
export function landmark<T>(hay: readonly T[], needle: T, from?: number): number;
export function landmark(hay: string | readonly unknown[], needle: unknown, from = 0): number {
    const at = typeof hay === 'string' ? hay.indexOf(needle as string, from) : hay.indexOf(needle, from);
    assert.notStrictEqual(at, -1, `source landmark missing (renamed or removed?): ${JSON.stringify(needle)}`);
    return at;
}

/**
 * A landmark used as an END bound, where running off the end of the file is legitimate.
 *
 * The idiom is "slice up to the next declaration": `src.indexOf('\nexport const ', start + 1)`.
 * When the thing being sliced is the LAST one in the file there is no next declaration, and -1 is
 * not a stale marker — it means "to the end". `landmark` would be wrong here and would fail the
 * day someone appends nothing; this returns `hay.length` instead, which is what the slice wanted.
 *
 * Use this ONLY for that shape. An end marker that must exist is still a `landmark`.
 */
export function landmarkEnd(hay: string, needle: string, from = 0): number {
    const at = hay.indexOf(needle, from);
    return at === -1 ? hay.length : at;
}
