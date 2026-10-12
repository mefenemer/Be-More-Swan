// tests/onboarding-status-gate.test.ts
// onboarding.ts creates an ai_assistants row for whatever master role the roleKey names, and used
// to do it with no status check at all: a hidden, retired or coming-soon role (teasers, mostly
// unbuilt — crm_enricher was parked there for fabricating data) could be hired by opening the setup
// wizard with its roleKey. hire-assistant.ts already refused those through hireDecision; onboarding
// now runs the same gate, before it writes anything.
//
// Also pins that onboarding and hire-assistant are the only code paths that insert ai_assistants
// rows outside dev seed scripts — a new one must be gated too.
//
// Run:  npx tsx tests/onboarding-status-gate.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hireDecision, statusOf, columnsFor, ASSISTANT_STATUSES } from '../src/utils/assistant-go-live';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function slice(text: string, start: string, end: string): string {
    const i = text.indexOf(start);
    assert.ok(i >= 0, `marker not found: ${start}`);
    assert.strictEqual(text.indexOf(start, i + 1), -1, `marker not unique: ${start}`);
    const j = text.indexOf(end, i + start.length);
    assert.ok(j > i, `end marker not found after ${start}`);
    return text.slice(i, j);
}

console.log('\nThe rule onboarding applies (hireDecision over statusOf)');

check('every status a stored row can be in: only live is open with no access and no tasks', () => {
    const open = ASSISTANT_STATUSES.filter((s) =>
        hireDecision({ status: statusOf(columnsFor(s)), betaAccess: false, completedTasks: 0, milestoneTasksRequired: 25 }).ok);
    assert.deepStrictEqual(open, ['live']);
});

check('coming soon is refused with COMING_SOON even with Beta access and a huge task count', () => {
    const d = hireDecision({ status: statusOf({ isActive: true, comingSoon: true, lifecycleState: 'review' }), betaAccess: true, completedTasks: 10_000, milestoneTasksRequired: 1 });
    assert.deepStrictEqual(d, { ok: false, code: 'COMING_SOON' });
});

check('hidden and retired rows are NOT_AVAILABLE', () => {
    for (const row of [{ isActive: false, comingSoon: false, lifecycleState: 'draft' }, { isActive: false, comingSoon: false, lifecycleState: 'archived' }]) {
        assert.deepStrictEqual(hireDecision({ status: statusOf(row), betaAccess: true, completedTasks: 999, milestoneTasksRequired: 1 }), { ok: false, code: 'NOT_AVAILABLE' });
    }
});

check('beta opens on Beta access or the milestone, BETA_LOCKED otherwise', () => {
    const beta = statusOf(columnsFor('beta'));
    assert.deepStrictEqual(hireDecision({ status: beta, betaAccess: false, completedTasks: 24, milestoneTasksRequired: null }), { ok: false, code: 'BETA_LOCKED', required: 25 });
    assert.ok(hireDecision({ status: beta, betaAccess: true, completedTasks: 0, milestoneTasksRequired: 25 }).ok);
    assert.ok(hireDecision({ status: beta, betaAccess: false, completedTasks: 25, milestoneTasksRequired: null }).ok);
});

console.log('\nonboarding.ts wiring');

const src = code('netlify/functions/onboarding.ts');

check('the gate goes through statusOf + hireDecision and 403s with the decision code', () => {
    const gate = slice(src, 'const status = statusOf(assistantRecord);', "const targetName = customAssistantName");
    assert.ok(/hireDecision\(\{/.test(gate), 'not gated through hireDecision');
    assert.ok(/statusCode: 403/.test(gate), 'refusal is not a 403');
    assert.ok(/code: decision\.code/.test(gate), 'refusal does not return the decision code');
    assert.ok(/'COMING_SOON'/.test(gate) && /'BETA_LOCKED'/.test(gate), 'refusal copy does not cover both codes');
});

check('beta reads organisations.betaAccess and the USER\'s completed task_runs, like hire-assistant', () => {
    const gate = slice(src, 'const status = statusOf(assistantRecord);', "const targetName = customAssistantName");
    assert.ok(/organisations\.betaAccess/.test(gate), 'Beta access not read');
    assert.ok(/eq\(organisations\.id, orgId\)/.test(gate), 'Beta access not read for the active org');
    assert.ok(/eq\(taskRuns\.userId, currentUserId\)/.test(gate), 'task count not scoped to the user');
    assert.ok(/eq\(taskRuns\.status, 'completed'\)/.test(gate), 'task count not limited to completed runs');
    assert.ok(/milestoneTasksRequired: assistantRecord\.milestoneTasksRequired/.test(gate), 'role milestone not passed');
});

check('the gate runs BEFORE the dedup delete, the profile/org writes and the insert', () => {
    const gateAt = src.indexOf('const status = statusOf(assistantRecord);');
    assert.ok(gateAt >= 0, 'no status gate');
    for (const later of [
        'await db.delete(aiAssistants)',
        'await db.update(userProfiles)',
        'await db.update(organisations)',
        'db.insert(aiAssistants)',
    ]) {
        const at = src.indexOf(later);
        assert.ok(at >= 0, `marker not found: ${later}`);
        assert.ok(at > gateAt, `${later} runs before the status gate`);
    }
    // And the master row it gates on is the one the insert links to.
    assert.ok(src.indexOf('db.select().from(masterAssistants)') < gateAt, 'master looked up after the gate');
    assert.strictEqual(src.split('db.select().from(masterAssistants)').length - 1, 1, 'master looked up twice');
    assert.ok(/masterAssistantId: assistantRecord\.id/.test(src), 'insert not linked to the gated row');
});

console.log('\nNo other ungated hire path');

check('only hire-assistant.ts and onboarding.ts insert ai_assistants rows in netlify/ and src/', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
            const p = `${dir}/${e.name}`;
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
            if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
            const text = code(p);
            if (/\.insert\(\s*(\w+\.)?aiAssistants\s*\)|insert\s+into\s+"?ai_assistants"?/i.test(text)) hits.push(p);
        }
    };
    walk('netlify');
    walk('src');
    assert.deepStrictEqual(hits.sort(), ['netlify/functions/hire-assistant.ts', 'netlify/functions/onboarding.ts'],
        'a new path creates assistants — gate it with hireDecision and add it here');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}\n`);
