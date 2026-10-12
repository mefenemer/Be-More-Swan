// tests/early-access-gate.test.ts
// The 25-task "early access" milestone (US-AUD-2.3.1) used to unlock COMING-SOON roles in
// hire-assistant.ts — any plan could hire a teaser that wasn't built (or, like crm_enricher, was
// parked there for fabricating data). Now: coming soon is never hireable; the milestone (or the
// org's Beta access) opens BETA roles only. Server rule + both catalogue pages + milestone-progress
// must agree.
//
// Run:  npx tsx tests/early-access-gate.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    hireDecision, milestoneReached, milestoneCanUnlock, statusOf, columnsFor, ASSISTANT_STATUSES,
} from '../src/utils/assistant-go-live';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function slice(text: string, start: string, end: string): string {
    const i = text.indexOf(start);
    assert.ok(i >= 0, `marker not found: ${start}`);
    assert.strictEqual(text.indexOf(start, i + 1), -1, `marker not unique: ${start}`);
    const j = text.indexOf(end, i + start.length);
    assert.ok(j > i, `end marker not found after ${start}`);
    return text.slice(i, j);
}

console.log('\nhireDecision');

check('coming soon is refused at any task count, with or without Beta access', () => {
    for (const completedTasks of [0, 24, 25, 10_000]) {
        for (const betaAccess of [false, true]) {
            const d = hireDecision({ status: 'coming_soon', betaAccess, completedTasks, milestoneTasksRequired: 25 });
            assert.deepStrictEqual(d, { ok: false, code: 'COMING_SOON' }, `${completedTasks} tasks, beta=${betaAccess}`);
        }
    }
});

check('the stored coming-soon columns (crm_enricher today) resolve to a refusal', () => {
    const row = { isActive: true, comingSoon: true, lifecycleState: 'review' };
    assert.strictEqual(statusOf(row), 'coming_soon');
    // Even a stray lifecycle 'beta' on a coming-soon row is still coming soon.
    assert.strictEqual(statusOf({ ...row, lifecycleState: 'beta' }), 'coming_soon');
    assert.strictEqual(hireDecision({ status: statusOf(row), betaAccess: true, completedTasks: 999, milestoneTasksRequired: 1 }).ok, false);
});

check('beta: locked below the milestone without Beta access', () => {
    const d = hireDecision({ status: 'beta', betaAccess: false, completedTasks: 24, milestoneTasksRequired: 25 });
    assert.deepStrictEqual(d, { ok: false, code: 'BETA_LOCKED', required: 25 });
});

check('beta: the task milestone unlocks it', () => {
    assert.ok(hireDecision({ status: 'beta', betaAccess: false, completedTasks: 25, milestoneTasksRequired: 25 }).ok);
    assert.ok(hireDecision({ status: 'beta', betaAccess: false, completedTasks: 10, milestoneTasksRequired: 10 }).ok);
});

check('beta: Beta access unlocks it with zero tasks', () => {
    assert.ok(hireDecision({ status: 'beta', betaAccess: true, completedTasks: 0, milestoneTasksRequired: 25 }).ok);
});

check('beta: a null milestone falls back to 25, matching the UI', () => {
    assert.strictEqual(hireDecision({ status: 'beta', betaAccess: false, completedTasks: 24, milestoneTasksRequired: null }).ok, false);
    assert.ok(milestoneReached(25, null));
});

check('live is open; hidden and retired are not available', () => {
    assert.ok(hireDecision({ status: 'live', betaAccess: false, completedTasks: 0, milestoneTasksRequired: 25 }).ok);
    for (const status of ['hidden', 'retired'] as const) {
        assert.deepStrictEqual(hireDecision({ status, betaAccess: true, completedTasks: 999, milestoneTasksRequired: 1 }), { ok: false, code: 'NOT_AVAILABLE' });
    }
});

check('only beta is milestone-unlockable', () => {
    assert.deepStrictEqual(ASSISTANT_STATUSES.filter(milestoneCanUnlock), ['beta']);
    assert.strictEqual(statusOf(columnsFor('beta')), 'beta');
});

console.log('\nServer wiring');

check('hire-assistant refuses coming soon BEFORE counting tasks, and gates beta through hireDecision', () => {
    const src = code('netlify/functions/hire-assistant.ts');
    const gate = slice(src, 'const status = statusOf(master);', 'dpaAcceptances.id');
    const refuse = gate.indexOf("if (status === 'coming_soon')");
    assert.ok(refuse >= 0, 'no coming-soon refusal');
    assert.ok(/return json\(403[^\n]*COMING_SOON/.test(gate.slice(refuse, refuse + 400)), 'coming-soon branch does not 403');
    assert.ok(gate.indexOf('taskRuns') > refuse, 'tasks counted before the coming-soon refusal');
    assert.ok(/hireDecision\(/.test(gate), 'beta not gated through hireDecision');
    assert.ok(/organisations\.betaAccess/.test(gate), 'Beta access not read');
    assert.ok(!/if \(master\.comingSoon\)/.test(src), 'the old comingSoon-only milestone gate is back');
    assert.ok(/lifecycleState: masterAssistants\.lifecycleState/.test(src), 'lifecycle column not selected');
});

check('milestone-progress lists only beta roles, never coming soon', () => {
    const src = code('netlify/functions/milestone-progress.ts');
    assert.ok(!/eq\(masterAssistants\.comingSoon, true\)/.test(src), 'still selects coming-soon roles');
    assert.ok(/eq\(masterAssistants\.lifecycleState, 'beta'\)/.test(src), 'not filtered to beta');
    assert.ok(/milestoneCanUnlock\(statusOf\(/.test(src), 'not filtered through statusOf');
    assert.ok(/milestoneReached\(n, a\.milestoneTasksRequired\)/.test(src), 'unlock not via milestoneReached');
});

check('master-assistants shows beta to exactly who can hire it, and flags it by statusOf', () => {
    const src = code('netlify/functions/master-assistants.ts');
    assert.ok(/beta: statusOf\(r\) === 'beta'/.test(src), 'beta flag reads the raw column');
    assert.ok(/hireDecision\(\{ status: 'beta', betaAccess, completedTasks/.test(src), 'visibility not through hireDecision');
});

console.log('\nCatalogue pages');

// Indent of the renderCard body differs per page (assistants.html: 2, assistant-catalogue.html: 4).
for (const [page, ind] of [['assistants.html', '  '], ['assistant-catalogue.html', '    ']] as const) {
    check(`${page}: a coming-soon card has no progress bar, unlock state or Hire button`, () => {
        const html = read(page);
        const card = slice(html, `${ind}if (a.comingSoon) {`, `\n${ind}}\n\n`);
        assert.ok(!/to go for early access|tasks needed to unlock|unlocked early access|Early Access/.test(card), 'unlock copy on a coming-soon card');
        assert.ok(!/hireAssistant\(|_catHire\(/.test(card), 'Hire button on a coming-soon card');
        assert.ok(!/a\.unlocked/.test(card), 'reads the milestone unlock');
    });
    check(`${page}: the early-access card is the beta card, rendered first`, () => {
        const html = read(page);
        const beta = html.indexOf('if (a.beta) {');
        const soon = html.indexOf('if (a.comingSoon) {');
        assert.ok(beta >= 0 && soon > beta, 'beta branch missing or after coming soon');
        assert.ok(/You've unlocked early access!/.test(html.slice(beta, soon)), 'early-access copy not on the beta card');
        assert.ok(/a\.beta && byId\[a\.id\]/.test(html), 'milestone data still merged into coming-soon cards');
        assert.ok(!/a\.comingSoon && byId\[a\.id\]/.test(html), 'milestone data still merged into coming-soon cards');
    });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
