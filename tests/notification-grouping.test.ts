// tests/notification-grouping.test.ts
//
// The notification inbox's "Group by" control, read as source. Nothing here runs a browser — these
// are the properties whose absence is INVISIBLE in a passing typecheck and in a screenshot of a
// workspace that happens to have tidy data.
//
// ── What went wrong, and what each check is standing in for ─────────────────────────────────────
// The reported symptom was "grouping by something does nothing". Two separate things produced it:
//
//   1. "Group by assistant" REMOVED ITSELF from the select whenever the workspace had a single
//      assistant. An option that silently vanishes is indistinguishable, to the user, from a
//      feature that does not work — and the reasoning was wrong anyway, because system
//      notifications ("Be More Swan") are their own bucket, so even one assistant splits in two.
//
//   2. The chosen grouping was per-page-load state. Navigating away and back dropped silently
//      back to ungrouped, so the setting looked like it had never applied.
//
// The rebuilt version also has to stay COLLAPSIBLE — each group is a self-contained <li> holding
// its own header button and a nested <ul>, so collapsing is a display toggle rather than a full
// re-render that would throw away scroll position and focus.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const JS = read('notifications.js');
const HTML = read('notifications.html');

console.log('\nNotification grouping\n');

// ── The control ─────────────────────────────────────────────────────────────────────────────────
check('the markup offers all three grouping modes', () => {
    const select = HTML.slice(landmark(HTML, 'id="notif-group-by"'), landmark(HTML, '</select>'));
    for (const mode of ['none', 'type', 'assistant']) {
        assert.ok(select.includes(`value="${mode}"`), `the "${mode}" option is missing`);
    }
});

check('no option removes itself from the select at runtime', () => {
    // The old code called .remove() on the assistant option for single-assistant workspaces.
    assert.ok(!JS.includes('groupByAssistantOpt'),
        'notifications.js still references the removable assistant option');
    assert.ok(!/notif-group-by-assistant-opt/.test(JS + HTML),
        'the removable-option id is still present — every grouping mode must always stand');
});

check('the chosen grouping survives leaving the page and coming back', () => {
    assert.ok(JS.includes('GROUP_BY_STORAGE_KEY'), 'the grouping choice must be persisted');
    assert.ok(JS.includes('restoreGroupBy()'), 'the persisted grouping must be restored on init');
    // Restore has to run BEFORE the first render, or the page paints ungrouped and then jumps.
    assert.ok(landmark(JS, 'restoreGroupBy();\n    loadData();') > 0,
        'restoreGroupBy must run immediately before loadData');
});

check('only a known grouping mode is ever honoured', () => {
    // A stale or hand-edited localStorage value must not reach the renderer.
    assert.ok(JS.includes('GROUP_MODES.includes(saved)'), 'a persisted mode must be validated');
    assert.ok(JS.includes('GROUP_MODES.includes(groupBySelect.value)'), 'a selected mode must be validated');
});

// ── The rendered groups ─────────────────────────────────────────────────────────────────────────
const groupBlock = JS.slice(
    landmark(JS, 'groups.forEach(({ key, label, color, items })'),
    landmark(JS, 'renderedGroupKeys = [...groups.keys()];'),
);

check('every group renders a header', () => {
    assert.ok(groupBlock.includes("createElement('button')"),
        'the group header must be a real <button> — it carries keyboard and screen-reader semantics for free');
    assert.ok(groupBlock.includes('items.length'), 'the header must state how many items the group holds');
});

check('every group is expandable and collapsible', () => {
    assert.ok(groupBlock.includes("aria-expanded"), 'the header must expose its expanded state');
    assert.ok(groupBlock.includes("aria-controls"), 'the header must point at the region it controls');
    assert.ok(groupBlock.includes("header.addEventListener('click'"), 'the header must toggle on click');
});

check('collapsing hides the body without re-rendering the whole list', () => {
    // A full re-render on every collapse throws away scroll position and focus, and rebuilds cards
    // that may have a request in flight.
    assert.ok(groupBlock.includes("body.style.display = nowCollapsed ? 'none' : ''"),
        'collapse must be a display toggle on the group body');
    assert.ok(!/header\.addEventListener\('click', \(\) => \{[^}]*renderList\(\)/.test(groupBlock),
        'the header click handler must not call renderList()');
});

check('a group body is a nested list, not a flat run of siblings', () => {
    assert.ok(groupBlock.includes("createElement('ul')"),
        'each group must own a nested <ul>, so the divide-y rule separates GROUPS rather than headers from cards');
});

check('collapsed state is keyed per group and survives a re-render', () => {
    assert.ok(JS.includes('const collapsedGroups = new Set()'), 'collapsed groups must be tracked across renders');
    assert.ok(JS.includes('collapsedGroups.clear()'),
        'switching grouping mode must reopen every group — carrying keys across modes hides items under an unseen heading');
});

// ── The expand/collapse-all control ─────────────────────────────────────────────────────────────
check('one control covers both expand-all and collapse-all', () => {
    assert.ok(HTML.includes('id="notif-expand-all"'), 'the markup must carry the expand/collapse-all button');
    assert.ok(JS.includes("expandAllBtn.dataset.action = allCollapsed ? 'expand' : 'collapse'"),
        'the control must flip to match what the click will do');
});

check('the expand-all control hides itself when nothing is grouped', () => {
    const sync = JS.slice(landmark(JS, 'const syncExpandAllBtn'), landmark(JS, 'const tabActionBtn'));
    assert.ok(sync.includes("expandAllBtn.style.display = hasGroups ? '' : 'none'"),
        'the `hidden` class loses to the button\'s own inline-flex utility, so display must be driven directly');
});

check('every path out of renderList leaves the control in a truthful state', () => {
    // Three exits: ungrouped, empty tab, and the grouped path. An exit that forgets to sync leaves
    // "Collapse all" sitting above a list with no groups in it.
    const render = JS.slice(landmark(JS, 'const renderItem = (notif)'), landmark(JS, 'const setRead ='));
    const syncCalls = (render.match(/syncExpandAllBtn\(\)/g) || []).length;
    assert.ok(syncCalls >= 3, `expected the control to be synced on every exit, found ${syncCalls}`);
    const empty = JS.slice(landmark(JS, "if (list.length === 0) {"), landmark(JS, 'if (emptyStateEl) emptyStateEl.classList.add'));
    assert.ok(empty.includes('renderedGroupKeys = []'),
        'an empty tab must clear the group keys, or the control acts on groups that are no longer drawn');
});

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}\n`);
