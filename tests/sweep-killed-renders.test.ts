// tests/sweep-killed-renders.test.ts
// The killed-render sweeps run on a clock (netlify/functions/sweep-killed-renders.ts), so a killed render's Remotion cost
// reaches ai_usage_log (and partner commission) within about an hour, not only when someone renders again or opens their
// videos within 3 days. No database: the sweeps and the clock are stand-ins.
// Run:  npx tsx tests/sweep-killed-renders.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_MS, POST_JOBS_PER_RUN, VIDEO_ORGS_PER_RUN, sweepKilledRenders, type SweepDeps } from '../netlify/functions/sweep-killed-renders';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (err) { failures++; console.error(`✗ ${name}\n  ${err instanceof Error ? err.message : err}`); }
}

const db = {} as never;
const now = new Date('2026-11-24T10:26:00Z');

function deps(over: Partial<SweepDeps> & { orgs?: number[]; stepMs?: number } = {}) {
    let t = 0;
    const calls = { posts: [] as number[], projects: [] as number[] };
    const d: SweepDeps = {
        sweepPosts: async (_db, _now, limit) => { calls.posts.push(limit); t += over.stepMs ?? 0; return 1; },
        sweepProjects: async (_db, orgId) => { calls.projects.push(orgId); t += over.stepMs ?? 0; return 0; },
        stuckVideoOrgs: async (_db, _now, limit) => (over.orgs ?? []).slice(0, limit),
        clock: () => t,
        ...over,
    };
    return { d, calls };
}

(async () => {
await check('runs the post sweep with its small per-run limit, then each stuck video workspace', async () => {
    const { d, calls } = deps({ orgs: [7, 9] });
    const r = await sweepKilledRenders(db, now, d);
    assert.deepStrictEqual(calls.posts, [POST_JOBS_PER_RUN]);
    assert.deepStrictEqual(calls.projects, [7, 9]);
    assert.deepStrictEqual(r, { posts: 1, videoOrgs: 2, videoOrgsLeft: 0 });
});

await check('stops starting new workspaces once the time budget is spent (Netlify stops scheduled functions at 30 s)', async () => {
    const { d, calls } = deps({ orgs: [1, 2, 3, 4, 5], stepMs: 4_000 });
    const r = await sweepKilledRenders(db, now, d);
    // posts 4 s, org 1 → 8 s (= budget), so orgs 2–5 wait for the next hour.
    assert.deepStrictEqual(calls.projects, [1]);
    assert.strictEqual(r.videoOrgsLeft, 4);
    assert.ok(BUDGET_MS + 2 * 5_000 <= 20_000, 'the last step started inside the budget (two 5 s Remotion reads) still ends before 30 s');
});

await check('one workspace failing does not stop the others, and a failed lookup does not throw', async () => {
    const { d, calls } = deps({ orgs: [1, 2, 3], sweepProjects: async (_db, orgId) => { calls.projects.push(orgId); if (orgId === 2) throw new Error('boom'); return 0; } });
    const r = await sweepKilledRenders(db, now, d);
    assert.deepStrictEqual(calls.projects, [1, 2, 3]);
    assert.strictEqual(r.videoOrgs, 2);
    const broken = deps({ stuckVideoOrgs: async () => { throw new Error('db down'); } });
    assert.deepStrictEqual(await sweepKilledRenders(db, now, broken.d), { posts: 1, videoOrgs: 0, videoOrgsLeft: 0 });
});

await check('asks for at most VIDEO_ORGS_PER_RUN workspaces', async () => {
    const { d, calls } = deps({ orgs: Array.from({ length: 20 }, (_, i) => i + 1) });
    await sweepKilledRenders(db, now, d);
    assert.strictEqual(calls.projects.length, VIDEO_ORGS_PER_RUN);
});

await check('netlify.toml schedules it hourly, and the post sweep takes a per-run limit', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /\[functions\.sweep-killed-renders\]\s*\n\s*schedule = "26 \* \* \* \*"/);
    const bg = read('netlify/functions/render-post-video-background.ts');
    assert.ok(bg.includes('limit: number = KILLED_SWEEP_LIMIT') && bg.includes('.limit(limit)'), 'sweepKilledPostRenders(db, now, limit)');
    const fn = read('netlify/functions/sweep-killed-renders.ts');
    assert.ok(fn.includes('sweepKilledPostRenders(db, now, limit)') && fn.includes('sweepStuckProjects(db, orgId, now)'), 'calls both real sweeps');
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll sweep-killed-renders checks passed');
})();
