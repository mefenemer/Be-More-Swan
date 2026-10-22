// tests/chat-plan-snapshot.test.ts
// Every assistant chat knows the workspace's plan and this month's task balance — the same figures as
// the usage bar — so "how many tasks do I have left?" gets the real number, not a guess.
//
// WHY THIS EXISTS. No chat prompt carried the plan; the only sign of the allowance was the upgrade
// card once it had run out. These pin the wording of each state (no plan, a failed payment, an
// uncapped plan, bonus and held tasks), the reset date, and that the chat and check-capacity.ts
// compute the balance through ONE helper (task-balance.ts), so the two cannot drift.
//
// Run:  npx tsx tests/chat-plan-snapshot.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPlanSnapshot, formatPlanBlock } from '../src/utils/chat-plan-snapshot';
import { nextResetAt, tasksRemaining } from '../src/utils/task-balance';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const NOW = new Date('2026-10-22T12:00:00Z');
const base = { planName: 'Growth', status: 'active' as const, gracePeriodEndsAt: null, monthlyTaskLimit: 300, taskCount: 120, bonusTasks: 0, tasksInFlight: 0, unified: true, now: NOW };

async function main() {
    await check('the balance: allowance left + bonus − held, never below zero; null when uncapped', () => {
        assert.strictEqual(tasksRemaining(300, { taskCount: 120, bonusTasks: 10, tasksInFlight: 20 }), 170);
        assert.strictEqual(tasksRemaining(300, { taskCount: 400, bonusTasks: 5, tasksInFlight: 0 }), 5);
        assert.strictEqual(tasksRemaining(300, { taskCount: 400, bonusTasks: 0, tasksInFlight: 20 }), 0);
        assert.strictEqual(tasksRemaining(null, { taskCount: 400, bonusTasks: 0, tasksInFlight: 0 }), null);
    });
    await check('the allowance resets on the 1st of next month, UTC — December rolls into January', () => {
        assert.strictEqual(nextResetAt(NOW).toISOString(), '2026-11-01T00:00:00.000Z');
        assert.strictEqual(nextResetAt(new Date('2026-12-31T23:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
    });
    await check('an active plan states used, limit, left and the reset date', () => {
        const b = formatPlanBlock(base);
        assert.match(b, /Plan: Growth\./);
        assert.match(b, /120 used of 300\. 180 left\./);
        assert.match(b, /resets on 1 November 2026/);
        assert.match(b, /nothing is ever charged extra/);
        assert.match(b, /Chatting with you costs none/);
    });
    await check('bonus and held tasks are named; the old meter says chat costs a task', () => {
        const b = formatPlanBlock({ ...base, bonusTasks: 10, tasksInFlight: 20, unified: false });
        assert.match(b, /plus 10 bonus tasks that never expire \(20 held for AI media still being made\)\. 170 left\./);
        assert.match(b, /Each chat message, and each piece of work an assistant does, uses 1 task\./);
    });
    await check('a failed payment, an uncapped plan, and no plan', () => {
        assert.match(formatPlanBlock({ ...base, status: 'past_due', gracePeriodEndsAt: new Date('2026-10-29T00:00:00Z') }),
            /a payment failed; everything keeps running until 29 October 2026/);
        assert.match(formatPlanBlock({ ...base, monthlyTaskLimit: null }), /no monthly task limit/);
        assert.match(formatPlanBlock({ ...base, status: null }), /No active plan/);
    });
    await check('a failed read says so rather than inviting a guess', async () => {
        const db = { select: () => { throw new Error('db down'); } } as any;
        assert.match(await buildPlanSnapshot(db, 1, NOW), /could not be read this turn/);
    });
    await check('chat and the usage bar share one computation; every chat turn reads it', () => {
        const cap = read('netlify/functions/check-capacity.ts');
        assert.ok(cap.includes('const usage = await readTaskUsage(db, orgId, periodStart);'));
        assert.ok(cap.includes('remainingTasks(monthlyTaskLimit, { taskCount, bonusTasks, tasksInFlight })'));
        assert.ok(!cap.includes('FROM task_bonus'), 'the counter query lives in task-balance.ts only');
        assert.ok(read('src/utils/chat-plan-snapshot.ts').includes('readTaskUsage(db, organisationId)'));
        assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('const planBlock = await buildPlanSnapshot(db, orgId);'));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
