// tests/admin-kanban-boards.test.ts
// The Fix pipeline and Feature requests boards (src/components/admin-board.js + admin.html). Pins the
// column mapping from statuses (run against the real functions pulled out of admin.html), the drag
// rules (only human decisions accept a drop), and the toolbar/view-state contract.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const html = read('admin.html');
const board = read('src/components/admin-board.js');
const between = (a: string, b: string) => {
    const i = html.indexOf(a); const j = html.indexOf(b, i);
    assert.ok(i > 0 && j > i, `markers ${a} … ${b}`);
    return html.slice(i, j);
};

// Pull the two column mappings out of admin.html and run them.
const ctx: any = {};
vm.createContext(ctx);
vm.runInContext(`${between('const IR_REVIEW_MERGE', 'const IR_SOURCE_LABEL')}; this.irColumnOf = irColumnOf;`, ctx);
vm.runInContext(`${between('const FR_COLUMN_OF_STATUS', 'const FR_PRIORITY_RANK')}; const frColumnOf = (it) => FR_COLUMN_OF_STATUS[it.status] || 'review'; this.frColumnOf = frColumnOf; this.FR_STATUS_FOR_COLUMN = FR_STATUS_FOR_COLUMN;`, ctx);

console.log('admin-kanban-boards');

check('Fix pipeline: statuses and dev fields land in the right column', () => {
    const c = ctx.irColumnOf;
    assert.strictEqual(c({ status: 'reported' }), 'new');
    assert.strictEqual(c({ status: 'more_info_required' }), 'new');
    assert.strictEqual(c({ status: 'on_hold' }), 'waiting');        // shown as Waiting on Others; Backlog removed 2026-11-13
    assert.strictEqual(c({ status: 'investigating' }), 'fixing');
    assert.strictEqual(c({ status: 'fix_in_progress', devHandoffStatus: 'in_progress' }), 'fixing');
    assert.strictEqual(c({ status: 'reported', devHandoffStatus: 'queued' }), 'fixing');
    assert.strictEqual(c({ status: 'fix_in_progress', devHandoffStatus: 'completed', devMergeStatus: 'ready' }), 'review');
    assert.strictEqual(c({ status: 'merge', devMergeStatus: 'merged', devSqlStatus: 'pending' }), 'review');
    assert.strictEqual(c({ status: 'merge', devMergeStatus: 'merged' }), 'golive');
    assert.strictEqual(c({ status: 'fixed_ready_to_test', devMergeStatus: 'merged' }), 'live');
    assert.strictEqual(c({ status: 'closed', devMergeStatus: 'merged' }), 'closed');
    assert.strictEqual(c({ status: 'roadmap' }), 'closed');
});

check('Feature requests: nine statuses fold into six columns, and each column has a status to drop to', () => {
    const c = ctx.frColumnOf;
    assert.deepStrictEqual(
        ['pending_review', 'under_review', 'open', 'planned', 'brief_ready', 'in_progress', 'released', 'declined', 'duplicate'].map((s) => c({ status: s })),
        ['review', 'backlog', 'backlog', 'planned', 'building', 'building', 'released', 'closed', 'closed']);
    for (const col of ['review', 'backlog', 'planned', 'building', 'released', 'closed']) {
        const st = ctx.FR_STATUS_FOR_COLUMN[col];
        assert.ok(st, col);
        assert.strictEqual(c({ status: st }), col, `${col} → ${st} lands back in ${col}`);
    }
});

check('Fix pipeline drops: only Waiting on others and close; Claude moves the rest (2026-11-13)', () => {
    const rules = between('canDrop: (i, to) => {', 'onDrop: async (i, to) => {');
    assert.ok(rules.includes("if (to === 'review') return 'Moves here by itself"));
    assert.ok(rules.includes("if (to === 'golive') return 'Moves here by itself"));
    assert.ok(rules.includes("if (to === 'live') return 'Moves here by itself"));
    assert.ok(rules.includes("if (to === 'fixing') return 'Claude moves a ticket here"));
    assert.ok(rules.includes("if (to === 'waiting') return ['new', 'fixing'].includes(from)"));
    const drop = between("onDrop: async (i, to) => {", 'onOpen: (i) => openIssuePanel(i.id)');
    assert.ok(!drop.includes('action=handoff') && drop.includes('window.confirmModal') && drop.includes("'on_hold'"));
});

check('Feature requests: Released and Declined ask first (they notify voters)', () => {
    const drop = between("onDrop: async (it, to) => {", 'onOpen: (it) =>');
    assert.ok(drop.includes("if (to === 'released' || to === 'closed')") && drop.includes('window.confirmModal'));
    assert.ok(drop.includes('await frSetStatus(it.id, status)'));
});

check('both pages default to the board and remember the choice; List keeps the old views', () => {
    assert.ok(html.includes('<script src="/src/components/admin-board.js"></script>'));
    assert.ok(html.includes(`localStorage.getItem('admin-board:fix:mode') || 'board'`));
    assert.ok(html.includes(`localStorage.getItem('admin-board:features:pane') || 'board'`));
    assert.ok(html.includes('<div id="ir-list-wrap">') && html.includes('id="fr-pane-moderation" class="hidden"'));
    assert.ok(html.includes("if (_irMode === 'board') return loadIssueBoard();"));
});

check('board component: search, filters, group, sort, quick view, folding, safe storage, escaped output', () => {
    for (const marker of ['data-ab="q"', "sel('filter'", "sel('group'", "sel('sort'", 'data-ab="quick"', 'data-ab="fold"', 'data-ab="reset"']) {
        assert.ok(board.includes(marker), marker);
    }
    assert.ok(board.includes('const esc = (v) =>'), 'the component escapes what it prints itself');
    assert.ok(/function readStore[\s\S]*?try \{[\s\S]*?\} catch/.test(board), 'localStorage read is guarded');
    assert.ok(/function writeStore[\s\S]*?try \{[\s\S]*?\} catch/.test(board), 'localStorage write is guarded');
    assert.ok(board.includes('window.history.replaceState'), 'view mirrored into the URL');
    assert.strictEqual((board.match(/data-ab-drop="\$\{esc\(col\.key\)\}"/g) || []).length, 2, 'open AND folded columns are drop zones');
});

check('the Fix pipeline list carries the live-check fields the board shows', () => {
    const api = read('netlify/functions/admin-issue-reports.ts');
    assert.ok(api.includes('fixedAt: fixLive.get(r.id)?.fixedAt ?? null'));
    assert.ok(api.includes('awaitingLive:'));
});

check('items added by hand land in the first bucket (owner 2026-11-13)', () => {
    // Fix pipeline: + Add issue → POST admin-issue-reports → Reported, the admin as reporter.
    assert.ok(html.includes('onclick="irOpenAdd()"'), 'Fix pipeline has an Add issue button');
    const submit = between('async function irSubmitAdd()', 'async function loadIssueReports()');
    assert.ok(submit.includes("api(IR_API, {") && submit.includes("method: 'POST'"), 'posts to the Fix pipeline API');
    const api = read('netlify/functions/admin-issue-reports.ts');
    const i = api.indexOf("if (event.httpMethod === 'POST' && !action && !id)");
    assert.ok(i > 0, 'plain POST creates an issue');
    const create = api.slice(i, api.indexOf("action === 'version'", i));
    assert.ok(create.includes("status: 'reported'"), 'lands in Reported');
    assert.ok(create.includes('userId: admin.id'), 'the admin is the reporter (never a customer)');
    assert.ok(!create.includes('notifyIssueUser') && !create.includes('notifyAdmins'), 'adding tells nobody');
    assert.strictEqual(ctx.irColumnOf({ status: 'reported' }), 'new');
    // Feature requests: + Add request → pending_review → the To review column.
    const fr = read('netlify/functions/admin-feature-requests.ts');
    const ins = fr.slice(fr.indexOf('const [inserted] = await db.insert(featureRequests)'));
    assert.ok(/status: 'pending_review',\s*source: 'manual'/.test(ins.slice(0, 600)), 'admin-added request is pending_review');
    assert.strictEqual(ctx.frColumnOf({ status: 'pending_review' }), 'review');
});

console.log(`\n${passed} passed`);
