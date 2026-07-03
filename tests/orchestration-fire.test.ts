// tests/orchestration-fire.test.ts
// Phase 5 — orchestration runtime. Locks the JS control flow of fireOrchestrations():
// per-link enqueue, idempotency skip, triggerType tagging, and the no-blueprint path.
// (SQL-level link filtering and the caller-side loop guard are verified on staging.)
// Run:  npx tsx tests/orchestration-fire.test.ts

import assert from 'node:assert';
import { fireOrchestrations } from '../src/utils/orchestration';
import {
    orchestrationLinks, orchestrationRuns, aiAssistants, aiBlueprints,
    contentGenerationJobs, notifications,
} from '../db/schema';

let passed = 0;
function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; });
}

// Minimal chainable drizzle-ish stub. Conditions are opaque (SQL-evaluated in prod), so each
// table returns canned data regardless of .where(); we assert the JS behaviour around it.
function makeDb(canned: {
    links: any[]; names: any[]; blueprint: any[]; runReturns: any[][];
}) {
    const calls = { jobs: [] as any[], runs: [] as any[], notifications: [] as any[], updates: [] as any[] };
    const thenable = (value: any) => {
        const obj: any = {
            from: () => obj, where: () => obj, orderBy: () => obj, limit: () => obj, groupBy: () => obj,
            then: (res: any, rej: any) => Promise.resolve(value).then(res, rej),
        };
        return obj;
    };
    const db: any = {
        _calls: calls,
        select: (_cols?: any) => ({
            from: (table: any) => {
                if (table === orchestrationLinks) return thenable(canned.links);
                if (table === aiAssistants) return thenable(canned.names);
                if (table === aiBlueprints) return thenable(canned.blueprint);
                return thenable([]);
            },
        }),
        insert: (table: any) => ({
            values: (v: any) => {
                if (table === contentGenerationJobs) { calls.jobs.push(v); return Promise.resolve(); }
                if (table === notifications) { calls.notifications.push(v); return Promise.resolve(); }
                if (table === orchestrationRuns) {
                    calls.runs.push(v);
                    const ret = canned.runReturns.shift() ?? [];
                    return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(ret) }) };
                }
                return Promise.resolve();
            },
        }),
        update: (_table: any) => ({ set: (v: any) => ({ where: () => { calls.updates.push(v); return Promise.resolve(); } }) }),
    };
    return db;
}

const baseLink = { id: 10, targetAssistantId: 2, targetAction: 'design the visual', sourceEvent: 'drafts_a_post' };
const names = [{ id: 1, name: 'Aria' }, { id: 2, name: 'Max' }];
const fireOpts = { sourceAssistantId: 1, orgId: 7, userId: 3, event: 'drafts_a_post' as const, sourcePostId: 77, sourceCaption: 'Hello world' };

(async () => {
    await check('enqueues a triggerType=orchestration draft for the target, links caption', async () => {
        const db = makeDb({ links: [baseLink], names, blueprint: [{ id: 99 }], runReturns: [[{ id: 500 }]] });
        await fireOrchestrations(db, fireOpts);
        assert.equal(db._calls.jobs.length, 1, 'one job enqueued');
        const job = db._calls.jobs[0];
        assert.equal(job.triggerType, 'orchestration', 'loop-safe triggerType');
        assert.equal(job.assistantId, 2, 'enqueued for the target');
        assert.equal(job.status, 'queued');
        assert.ok(/design the visual/.test(job.contextPrompt), 'context carries the action');
        assert.ok(/Hello world/.test(job.contextPrompt), 'context carries the source caption');
        assert.equal(db._calls.runs.length, 1, 'run logged');
        assert.equal(db._calls.updates.length, 1, 'targetJobId stamped on the run');
        assert.equal(db._calls.notifications.length, 1, 'user notified');
    });

    await check('idempotent: a conflicting run (already fired) enqueues nothing', async () => {
        const db = makeDb({ links: [baseLink], names, blueprint: [{ id: 99 }], runReturns: [[]] }); // [] = onConflictDoNothing hit
        await fireOrchestrations(db, fireOpts);
        assert.equal(db._calls.jobs.length, 0, 'no job on duplicate firing');
        assert.equal(db._calls.notifications.length, 0, 'no notification on duplicate firing');
        assert.equal(db._calls.updates.length, 0);
    });

    await check('no target blueprint → records the hand-off but produces no draft', async () => {
        const db = makeDb({ links: [baseLink], names, blueprint: [], runReturns: [[{ id: 501 }]] });
        await fireOrchestrations(db, fireOpts);
        assert.equal(db._calls.jobs.length, 0, 'no draft without a blueprint');
        assert.equal(db._calls.runs.length, 1, 'run still logged');
        assert.equal(db._calls.notifications.length, 1, 'user still notified');
        assert.equal(db._calls.updates.length, 0, 'no targetJobId to stamp');
    });

    await check('no matching links → completely inert', async () => {
        const db = makeDb({ links: [], names: [], blueprint: [], runReturns: [] });
        await fireOrchestrations(db, fireOpts);
        assert.equal(db._calls.jobs.length + db._calls.runs.length + db._calls.notifications.length, 0);
    });

    await check('contextPrompt is capped at the 500-char job limit', async () => {
        const db = makeDb({ links: [baseLink], names, blueprint: [{ id: 99 }], runReturns: [[{ id: 502 }]] });
        await fireOrchestrations(db, { ...fireOpts, sourceCaption: 'x'.repeat(5000) });
        assert.ok(db._calls.jobs[0].contextPrompt.length <= 500, 'prompt stays within the content_generation_jobs cap');
    });

    console.log(`\n${passed} checks passed.`);
})();
