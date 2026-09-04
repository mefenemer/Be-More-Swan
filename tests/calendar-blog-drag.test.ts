// tests/calendar-blog-drag.test.ts
// Blog chips on the Content Calendar are DRAGGABLE. They were not: long-form was the one thing on
// the grid that could be seen but not moved, so rescheduling next Tuesday's article to Thursday
// meant opening Blog Studio and re-picking the date by hand.
//
// WHY A TEST. A drag is three separate pieces of code that have to agree on one string, and none of
// them is checked by the compiler (calendar.js is vanilla JS built out of template literals):
//
//   1. _blogChip      emits  ondragstart="…_calDragStart(event, { kind: 'blog', … })"
//   2. _calDrop       routes  item.kind === 'blog'  →  _dropBlog
//   3. _attachDragDrop clears the drag opacity via the chip's data attribute
//
// Break any one and the chip either refuses to lift, silently does nothing when dropped, or stays
// at 50% opacity looking like it is mid-save forever. All three failures look like "drag and drop
// doesn't work", which is the report this fixed.
//
// The fourth check is the one with teeth: the drop must POST a `publishDate`, NOT
// `action: 'approve'`. Both are valid schedule-blog.ts calls and both return 200 — but `approve`
// makes the assistant pick the next free CADENCE slot and ignore the date the user dropped on. The
// post would move to a date nobody chose, and the calendar would repaint showing it.
//
// No database: source-consistency checks only, like the rest of tests/ except rls-enforcement.
// Run:  npx tsx tests/calendar-blog-drag.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const calendar = readFileSync(join(root, 'calendar.js'), 'utf8');

/**
 * The body of a top-level `function name(` (or `async function name(`) in calendar.js, up to the
 * next top-level function or `window.` assignment.
 *
 * Both ends matter. A stale NAME would slice from -1 and hand every check below an empty string,
 * which passes silently — hence the assert. A too-greedy END would let a check pass on text from a
 * NEIGHBOURING function, which is the same failure wearing a different hat.
 */
function fnBody(source: string, name: string): string {
    const open = new RegExp(`\\n(?:async )?function ${name}\\(`);
    const start = source.search(open);
    assert.notEqual(start, -1, `calendar.js no longer defines a top-level function ${name}() — `
        + 'this test slices on that marker, so an empty slice would pass every check below.');
    const rest = source.slice(start).replace(open, '');
    const end = rest.search(/\n(?:async )?function |\nwindow\./);
    return end === -1 ? rest : rest.slice(0, end);
}

/** The body of a `window.name = function` assignment. */
function windowFnBody(source: string, name: string): string {
    const marker = `window.${name} = function`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `calendar.js no longer defines window.${name} — see fnBody's note.`);
    const rest = source.slice(start + marker.length);
    const end = rest.indexOf('\nwindow.');
    return end === -1 ? rest : rest.slice(0, end);
}

const blogChip = fnBody(calendar, '_blogChip');
const dropBlog = fnBody(calendar, '_dropBlog');
const attach = fnBody(calendar, '_attachDragDrop');
const calDrop = windowFnBody(calendar, '_calDrop');

// ── 1. The chip can be picked up ─────────────────────────────────────────────
check('a blog chip starts a drag tagged kind:"blog"', () => {
    assert.ok(/ondragstart="window\._calDragStart\(event, \{ kind: 'blog'/.test(blogChip),
        '_blogChip no longer emits a _calDragStart with { kind: \'blog\' } — the chip cannot be lifted.');
});

check('only a SCHEDULED blog is draggable, and never in the list view', () => {
    assert.ok(/isDraggable = post\.status === 'scheduled' && viewType !== 'list'/.test(blogChip),
        'The draggability test changed. A published article must never be draggable (it is live), '
        + 'and the list view has no drop targets, so a chip lifted there can never be put down.');
    // The draggable attribute must be GATED on it, not emitted unconditionally.
    assert.ok(/\$\{isDraggable \? `draggable="true"/.test(blogChip),
        'draggable="true" is no longer gated on isDraggable.');
});

// ── 2. The drop is routed ────────────────────────────────────────────────────
check('_calDrop routes the blog kind to _dropBlog', () => {
    assert.ok(/item\.kind === 'blog'/.test(calDrop),
        '_calDrop has no branch for kind:\'blog\' — dropping a blog chip would fall through to the '
        + 'post path, find no _dragPostId, and silently do nothing.');
    assert.ok(/_dropBlog\(item\.id, dateKey\)/.test(calDrop),
        'The blog branch no longer calls _dropBlog(item.id, dateKey).');
});

// ── 3. The drop persists the date the user chose ─────────────────────────────
check('_dropBlog POSTs a publishDate to schedule-blog', () => {
    assert.ok(/schedule-blog/.test(dropBlog), '_dropBlog no longer calls schedule-blog.');
    assert.ok(/publishDate: newDate\.toISOString\(\)/.test(dropBlog),
        '_dropBlog no longer sends the dropped date as publishDate.');
});

check('_dropBlog never uses the approve path', () => {
    assert.ok(!/action:\s*'approve'/.test(dropBlog),
        "_dropBlog sends action:'approve'. That path makes the assistant pick the next free CADENCE "
        + 'slot and DISCARD the date the user dropped on — the post moves somewhere nobody chose, '
        + 'and the calendar repaints showing it. The drop must send an explicit publishDate.');
});

check('_dropBlog keeps the time of day and refuses the past', () => {
    assert.ok(/_dropTarget\(dateKey, post\.publishDate\)/.test(dropBlog),
        '_dropBlog no longer builds its target through _dropTarget, which is what preserves the '
        + "post's own time of day across the move.");
    assert.ok(/newDate\.getTime\(\) <= Date\.now\(\)/.test(dropBlog),
        '_dropBlog no longer refuses a past instant on the client. schedule-blog.ts 400s on one, so '
        + 'without this the user gets a bare "could not move" for something explainable.');
});

// ── 4. The chip is cleaned up after the drag ─────────────────────────────────
check('_attachDragDrop clears drag opacity on blog chips too', () => {
    assert.ok(/data-cal-blog-id/.test(attach),
        '_attachDragDrop does not select [data-cal-blog-id], so a blog chip left after a cancelled '
        + 'drag stays at 50% opacity — indistinguishable from one that is mid-save.');
});

check('the chip actually carries the attribute _attachDragDrop looks for', () => {
    assert.ok(/data-cal-blog-id="\$\{post\.id\}"/.test(blogChip),
        '_blogChip no longer emits data-cal-blog-id — the selector in _attachDragDrop matches nothing.');
});

console.log(`\n${passed} checks passed`);
