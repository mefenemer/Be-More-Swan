// tests/post-editor-single-surface.test.ts
// There is ONE post editor, it has ONE layout, and that layout leads with the content.
//
// Run:  npx tsx tests/post-editor-single-surface.test.ts
//
// Source-level, like tests/crosspost-grouping.test.ts, and for the same reason: every failure this
// guards against is a silent one. Nothing throws when a second editor exists, when a layout flag
// quietly defaults to the old layout, or when a borrowed control block loses the home it gets put
// back into — you just get the wrong screen, or a control that stops saving.
//
// Three decisions are pinned here:
//   1. The step rail is the ONLY layout. It shipped behind window.__bmsRail defaulting to OFF, so
//      the converged editor was built, committed, and invisible to everyone.
//   2. The steps run content first — write before targeting.
//   3. The Content Calendar opens the real editor. It used to carry a second, older post panel with
//      its own platform/format controls, so the same post offered different tools depending on
//      where it was clicked.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const workspace = read('workspace.html');
const calendarJs = read('calendar.js');
const calendarHtml = read('calendar.html');

console.log('\nPost editor — one surface, one layout\n');

// ── 1. One layout ───────────────────────────────────────────────────────────────────────────────
check('the layout flag and its switch are gone', () => {
    for (const token of ['__bmsRail', 'bms_rail', '_railOn', '_railSet', 'pce-layout-toggle', '_railToggleLayout']) {
        // Comments are allowed to mention the flag — that is the record of why it went.
        const live = workspace
            .split('\n')
            .filter(l => l.includes(token) && !/^\s*(\/\/|\*|<!--|\s*-->)/.test(l) && !l.trimStart().startsWith('//'))
            .filter(l => !l.includes('was flagged') && !l.includes('lived here'));
        assert.deepStrictEqual(live, [],
            `'${token}' is still live code — the step rail is the only layout, there is nothing to flag`);
    }
});

check('the collapsible panes are gone', () => {
    for (const token of ['_pceApplyPanes', '_pceTogglePane', '_pceShowLeftPane', '_pceCollapsed', 'pce-left-reopen', 'pce-right-reopen']) {
        const live = workspace
            .split('\n')
            .filter(l => l.includes(token) && !l.trimStart().startsWith('//'));
        assert.deepStrictEqual(live, [], `'${token}' survived the pane removal`);
    }
});

// The panes are gone, but the BLOCKS inside them are not: _railMount lends them to a step and
// _railRestoreAll puts them back before the rail's next innerHTML write. A block with no home is
// destroyed by that write, and #post-review-caption specifically is the field the save reads.
check('every block the rail borrows still has a home to be restored to', () => {
    const mounts = [...workspace.matchAll(/mount:\s*'([a-z0-9-]+)'/g)].map(m => m[1]);
    const also   = [...workspace.matchAll(/also:\s*'([a-z0-9-]+)'/g)].map(m => m[1]);
    const borrowed = [...mounts, ...also, 'post-review-changes'];
    assert.ok(borrowed.length >= 8, `expected to find the rail's mounts, got ${JSON.stringify(borrowed)}`);
    for (const id of borrowed) {
        assert.ok(workspace.includes(`id="${id}"`),
            `the rail borrows #${id}, but no element with that id exists — _railRestoreAll would have nowhere to put it back`);
    }
});

check('the caption field the save reads from still exists, parked and hidden', () => {
    assert.match(workspace, /id="post-review-caption"/,
        'rqReviewSaveAmend saves from #post-review-caption — deleting it stops the editor saving captions');
    assert.match(workspace, /<aside id="post-review-inspector" class="hidden"/,
        'the parking container must be hidden in the markup, not shown as a pane');
    assert.match(workspace, /<aside id="pce-left" class="hidden"/,
        'the parking container must be hidden in the markup, not shown as a pane');
});

// ── 2. Content first ────────────────────────────────────────────────────────────────────────────
check('the rail steps run content first', () => {
    const block = workspace.slice(workspace.indexOf('const _RAIL = ['), workspace.indexOf('];', workspace.indexOf('const _RAIL = [')));
    const keys = [...block.matchAll(/key:\s*'(\w+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(keys, ['write', 'media', 'text', 'link', 'setup', 'check', 'when'],
        'the editor opens on the work, not on the targeting form — writing comes before platforms & format');
    assert.ok(keys.indexOf('write') < keys.indexOf('setup'),
        '"Write" must come before "Platforms & format"');
});

check('no step is auto-opened, so the order is an offer and not a wizard', () => {
    assert.match(workspace, /let _railOpen = null;/,
        'the rail must open with every step collapsed — the post is what you see first');
});

// ── 3. One surface ──────────────────────────────────────────────────────────────────────────────
check('the calendar opens the real editor', () => {
    // Anchor on the DEFINITION — the name also appears in every chip's onclick.
    const at = calendarJs.indexOf('window._calOpenPost = ');
    assert.ok(at > 0, 'could not find the _calOpenPost definition');
    assert.match(calendarJs.slice(at, at + 900), /window\.openPostReview\(postId\)/,
        'clicking a calendar chip must open the shared editor, not a panel of the calendar\'s own');
});

check('the calendar\'s own post panel is deleted', () => {
    for (const id of ['aura-panel', 'panel-logistics-platform', 'panel-logistics-format', 'panel-caption-edit', 'modal-reject-post', 'modal-approve-past']) {
        assert.ok(!calendarHtml.includes(`id="${id}"`),
            `#${id} is part of the calendar's old post editor — it was replaced by openPostReview`);
    }
    // The drag-to-another-day confirmation is the calendar's OWN gesture and stays.
    assert.ok(calendarHtml.includes('id="modal-reschedule"'),
        'dragging a chip to another day is the calendar\'s own gesture and keeps its confirmation');
});

check('nothing still calls the deleted panel actions', () => {
    const gone = ['_calClosePanel', '_calToggleEdit', '_calSaveEdits', '_calApprovePost', '_calOpenRejectPanel',
                  '_calCancelPost', '_calDetachAsset', '_calSubmitRejection', '_calNavPost', 'toggleQualityPanel'];
    for (const rel of ['calendar.js', 'calendar.html', 'workspace.html', 'assistant-detail.html']) {
        const src = read(rel);
        for (const name of gone) {
            assert.ok(!src.includes(name), `${rel} still references ${name}, which was deleted with the calendar panel`);
        }
    }
});

check('closing the editor refreshes the calendar', () => {
    const close = workspace.slice(workspace.indexOf('function closePostReview()'));
    assert.match(close.slice(0, 1600), /window\._calRefreshAfterEdit\?\.\(\)/,
        'the calendar\'s posts are stale once the editor has saved — closing it must ask for a reload');
    assert.match(calendarJs, /window\._calRefreshAfterEdit\s*=/,
        'calendar.js must expose the refresh hook closePostReview calls');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
