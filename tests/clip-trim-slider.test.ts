// tests/clip-trim-slider.test.ts
//
// The trim slider on a clip, and the reason it went missing.
//
// Reported as "the sliders are missing for the clips" with a screenshot showing a complete,
// correctly numbered timeline — four clips, their ranges, the text on each — and no slider anywhere.
// Both halves of that were true. Every number on the page comes from the stored `outS`, which needs
// no measurement; the slider alone was drawn against the SOURCE length, which is measured off a
// <video> element and is NULL in the database for any asset that arrived without one. The moment
// that measurement fails the slider is replaced by "Reading this clip…" and nothing else changes.
//
// These exercise the real functions, lifted out of workspace.html — the page has no build step and
// no module boundary, so typecheck sees none of this.
//
// Run:  npx tsx tests/clip-trim-slider.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(import.meta.dirname, '..');
const workspace = readFileSync(join(root, 'workspace.html'), 'utf8');

function only(hay: string, needle: string, where: string): number {
    const first = hay.indexOf(needle);
    assert.notStrictEqual(first, -1, `marker missing in ${where}: ${needle}`);
    assert.strictEqual(hay.indexOf(needle, first + 1), -1, `marker not unique in ${where}: ${needle}`);
    return first;
}

function slice(from: string, to: string): string {
    const a = only(workspace, from, 'workspace.html');
    const b = workspace.indexOf(to, a + 1);
    assert.ok(b > a, `end marker missing after ${from}: ${to}`);
    return workspace.slice(a, b);
}

const prelude = `
const _pceClipDurations = {};
const _pceClipMeasureFailed = new Set();
const _rqEsc = (s) => String(s);
const _pceFmtS = (s) => (Math.round(s * 10) / 10) + 's';
`;
const src = prelude
    + slice('function _pceClipFullLength(c) {', 'function _pceClipLength(c) {')
    + slice('function _pceTrimTrackHtml(clip, index) {', '\n/** Write the cut back to the post.');
const mod = new Function(src
    + '; return { _pceClipFullLength, _pceTrimAxis, _pceTrimTrackHtml, _pceClipDurations, _pceClipMeasureFailed };')() as any;
const { _pceTrimAxis: axis, _pceTrimTrackHtml: track, _pceClipDurations: durations,
    _pceClipMeasureFailed: failed } = mod;

const clip = (over: Record<string, unknown> = {}) => ({ id: 'c1', assetId: 7, ...over });
const hasSlider = (html: string) => html.includes('data-trim-track=') && html.includes('data-trim-edge="in"');

console.log('\nthe axis a slider is drawn against');

check('a measured clip uses its real length', () => {
    durations[7] = 12;
    const a = axis(clip({ outS: 5 }));
    assert.strictEqual(a.len, 12);
    assert.strictEqual(a.provisional, false);
    delete durations[7];
});

check('an unmeasured clip falls back to what it is trimmed to', () => {
    // THE FIX. sourceDurationS is null (Pexels stamps no duration) and the measurement failed, but
    // the clip is trimmed to 5.9s — so it is at least 5.9s long and a slider over 0–5.9s is real.
    const a = axis(clip({ outS: 5.9 }));
    assert.strictEqual(a.len, 5.9);
    assert.strictEqual(a.provisional, true);
});

check('stored durationS is used when nothing has been measured', () => {
    const a = axis(clip({ sourceDurationS: 8 }));
    assert.strictEqual(a.len, 8);
    assert.strictEqual(a.provisional, false);
});

check('an untrimmed, unmeasured clip has no axis — and must not invent one', () => {
    const a = axis(clip());
    assert.strictEqual(a.len, null);
});

console.log('\nwhat the row actually renders');

check('the reported case now has a slider', () => {
    // Exactly the screenshot: four clips, every length known from outS, nothing measured.
    for (const outS of [3, 4.6, 6, 5.9]) {
        const html = track(clip({ outS }));
        assert.ok(hasSlider(html), `no slider for a clip trimmed to ${outS}s`);
    }
});

check('a measured clip renders the slider across the whole file', () => {
    durations[7] = 20;
    const html = track(clip({ inS: 2, outS: 6 }));
    assert.ok(hasSlider(html));
    assert.ok(html.includes('left:10%'), 'the in handle should sit at 2/20');
    assert.ok(!/Still reading/.test(html), 'a measured clip must not claim to be provisional');
    delete durations[7];
});

check('a provisional slider says so rather than lying about the length', () => {
    const html = track(clip({ outS: 5.9 }));
    assert.ok(/Still reading/.test(html), 'no note that the far end is a floor');
});

check('a provisional slider on a FAILED clip does not claim to still be reading', () => {
    failed.add(7);
    const html = track(clip({ outS: 5.9 }));
    assert.ok(hasSlider(html), 'a failed measure must still leave a usable slider');
    assert.ok(/Could not read the full clip/.test(html), 'it says "Still reading" about something that will never arrive');
    assert.ok(!/Still reading/.test(html));
    failed.delete(7);
});

check('a clip with no axis at all distinguishes slow from dead', () => {
    const waiting = track(clip());
    assert.ok(/Reading this clip/.test(waiting));
    assert.ok(!hasSlider(waiting));
    failed.add(7);
    const dead = track(clip());
    assert.ok(/Could not read/.test(dead), 'a failed measure still says "Reading…" forever');
    failed.delete(7);
});

console.log('\nthe measurement that feeds it');

check('the in-flight guard actually guards', () => {
    // It was `_pceClipDurations[id] = null` checked with `!= null`, which is false for null — so it
    // guarded nothing and every repaint spawned another <video> for every unmeasured clip.
    const fn = slice('function _pceMeasureClips(clips) {', '\n/**\n * ── Trimming by eye');
    assert.ok(fn.includes('_pceClipMeasuring.has(c.assetId)'), 'no in-flight set is consulted');
    assert.ok(!/_pceClipDurations\[c\.assetId\] = null/.test(fn), 'the null-as-in-flight marker is back');
});

check('a failed measure is recorded and repainted, not swallowed', () => {
    const fn = slice('function _pceMeasureClips(clips) {', '\n/**\n * ── Trimming by eye');
    const onerror = fn.slice(fn.indexOf('v.onerror'));
    assert.ok(onerror.includes('_pceClipMeasureFailed.add'), 'the failure is not recorded');
    assert.ok(onerror.includes('_pceRenderClips()'), 'nothing redraws, so the row cannot say so');
});

check('a measured clip length is written back to the asset', () => {
    // Otherwise every session re-measures, and the slider is only ever as reliable as the clip url.
    only(workspace, 'function _pceReportClipMetrics(assetId, w, h, durationS) {', 'workspace.html');
    const fn = slice('function _pceReportClipMetrics(assetId, w, h, durationS) {', '\nfunction _pceRenderMediaProps');
    assert.ok(fn.includes('content-assets?id='), 'not sent to the backfill endpoint');
    assert.ok(fn.includes("method: 'PATCH'"), 'wrong method for the metric backfill');
    assert.ok(fn.includes('_pceMetricsSent'), 'nothing stops it re-sending on every repaint');
    const measure = slice('function _pceMeasureClips(clips) {', '\n/**\n * ── Trimming by eye');
    assert.ok(measure.includes('_pceReportClipMetrics('), 'the clip measurement never reports what it learned');
});

console.log('\nnothing reads the raw duration map any more');

check('every trim path goes through one helper', () => {
    // Five copies of the same ternary is how the fallback got missed in four of them.
    const uses = workspace.split('_pceClipDurations[').length - 1;
    assert.ok(uses <= 4, `_pceClipDurations is read directly ${uses} times — route it through _pceClipFullLength`);
});

console.log(`\n${passed} checks passed`);
