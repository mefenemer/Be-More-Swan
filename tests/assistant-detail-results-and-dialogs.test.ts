// tests/assistant-detail-results-and-dialogs.test.ts
// The assistant details page, after the 2026-10-21 UI/UX reviews:
//   • the Social Media Assistant's Goal Progress + Performance cards live in its Goals tab, renamed
//     "Results" (a registry flag, so the other roles can follow if the owner likes it);
//   • every hand-built dialog on the page gets its dialog behaviour from /dialogs.js;
//   • every Kick Off checklist item has a way to put it right.
// Source-scan checks — the page is a fragment loaded into workspace.html.
// Run:  npx tsx tests/assistant-detail-results-and-dialogs.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const page = read('assistant-detail.html');
const js = read('assistants.js');
const registry = read('src/components/assistant-dashboard-registry.js');
const dialogs = read('dialogs.js');

console.log('\nResults tab (Social Media trial)');

check('every role\'s Goals tab is "Results" and holds its results — goal-less roles too, minus the goals', () => {
    assert.match(js, /const goalsTab = cfg\.goalsTab \|\| \{ label: 'Results', bringsResults: true \};/);
    assert.ok(!/goalsTab:/.test(registry.replace(/^\s*\*.*$/gm, '')), 'no role opts out; one that does should be a deliberate change here');
    assert.match(js, /toggle\('maintab-btn-goals', !cfg\.hideGoals \|\| window\._detailResultsInGoalsTab\);/);
    assert.match(js, /toggle\('tab-goals', !cfg\.hideGoals\);/);
});

check('the move keeps the cards\' ids and puts them above the goals list', () => {
    assert.match(page, /<div id="performance-metrics-card" class="mb-8" style="order:-1">/);
    const apply = js.slice(js.indexOf('const goalsTab = cfg.goalsTab ||'), js.indexOf('const showDataHub'));
    assert.match(apply, /\['goal-progress-card', 'performance-metrics-card', 'autopilot-status-card'\]/);
    assert.match(apply, /panel\.insertBefore\(card, goalsList\)/);
    assert.match(apply, /setText\('maintab-btn-goals', goalsTab\.label \|\| 'Goals'\)/);
});

check('"Manage goals" scrolls to the goals list, which a tab switch alone would not do in the same tab', () => {
    assert.match(page, /onclick="window\._openGoalsList && window\._openGoalsList\(\)"/);
    assert.match(js, /window\._openGoalsList = function[\s\S]{0,200}getElementById\('tab-goals'\)\?\.scrollIntoView/);
});

console.log('\nTab order and My Content');

check('Calendar sits right after the Posts tab\'s siblings and before Inspo', () => {
    const order = [...page.matchAll(/data-maintab="([a-z-]+)" class="main-tab-btn/g)].map((m) => m[1]);
    assert.ok(order.indexOf('calendar') < order.indexOf('inspo'), order.join(' '));
    assert.ok(order.indexOf('inspo') < order.indexOf('mycontent'));
});

check('My Content says it is shared before anything can be deleted', () => {
    const tab = page.slice(page.indexOf('id="maintab-mycontent"'), page.indexOf('<div id="mycontent-host">'));
    assert.match(tab, /Shared with all your assistants\./);
});

console.log('\nDialogs');

const PAGE_DIALOGS = ['modal-copy-rules', 'modal-tuning', 'modal-tuning-picker', 'modal-review-progress', 'modal-wand',
    'modal-strategy-fix', 'modal-safety-benchmark', 'modal-safety-feedback', 'modal-connect', 'modal-preconnect'];

check('every hand-built dialog is marked for /dialogs.js, with a labelled close button', () => {
    for (const id of PAGE_DIALOGS) {
        const at = page.indexOf(`<div id="${id}" data-dialog `);
        assert.ok(at >= 0, `${id} is not marked data-dialog`);
        const head = page.slice(at, at + 2500);
        assert.match(head, /<button[^>]*data-dialog-cancel[^>]*aria-label="Close"/, `${id} has no data-dialog-cancel close button`);
    }
    assert.strictEqual((page.match(/ data-dialog /g) || []).length, PAGE_DIALOGS.length, 'a new page dialog must be added to this list');
});

check('/dialogs.js gives them role, focus, Tab, Escape and focus return — and defers to its own modals', () => {
    const block = dialogs.slice(dialogs.indexOf('Page dialogs —'), dialogs.indexOf('// Lightweight, dependency-free toast.'));
    assert.match(block, /setAttribute\('role', 'dialog'\)/);
    assert.match(block, /setAttribute\('aria-modal', 'true'\)/);
    assert.match(block, /e\.key === 'Escape'[\s\S]{0,200}querySelector\('\[data-dialog-cancel\]'\)/);
    assert.match(block, /before\.focus\(\)/);
    assert.match(block, /const top = opened\[opened\.length - 1\]\?\.el;/, 'only the topmost of stacked dialogs may hold the keys');
    assert.match(block, /document\.querySelector\(BUILT_HERE\)/, 'a confirmModal over a page dialog owns the keys');
});

check('Disconnect and Revoke all are /dialogs.js confirms, not page markup', () => {
    assert.ok(!page.includes('id="modal-disconnect"') && !page.includes('id="modal-revoke-all"'));
    assert.match(read('integrations.js'), /_intPromptDisconnect = async function[\s\S]{0,300}window\.confirmModal\(/);
    assert.match(page, /_revokeAllConnections = async function[\s\S]{0,200}window\.confirmModal\(/);
});

console.log('\nKick Off checklist');

check('every customer-fixable item has a way there; the two with no control go to support', () => {
    for (const key of ['brand_strategy', 'connections', 'disclosure', 'guardrails', 'tos', 'dpa', 'prohibited_use', 'conformity']) {
        assert.match(js, new RegExp(`\\n    ${key}:\\s+\\{ where:`), `${key} has no fix link`);
    }
    assert.match(js, /prohibited_use:\s+\{ where: 'support'/);
    assert.match(js, /conformity:\s+\{ where: 'support'/);
    assert.strictEqual((js.match(/\$\{_kickoffFixLink\(it\.key\)\}/g) || []).length, 2, 'both checklist renderings use it');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
