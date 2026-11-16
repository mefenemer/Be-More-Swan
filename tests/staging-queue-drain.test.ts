// tests/staging-queue-drain.test.ts
// Staging's queues stopped draining (2026-11-15): an on-demand social draft sat at `queued` for
// minutes on end, and every staging-crons.yml run since 2026-11-14 failed, so its timestamps never
// saved. Four separate causes; one check each.
//
//  1. poll-mailboxes is a SCHEDULED function. Netlify answers a URL call to one with a bare 403 before
//     the handler runs, so the workflow must call the plain run-poll-mailboxes wrapper instead.
//  2. run-site-domain-checks 404'd because it reached main without passing through staging; it is on
//     this branch now, and the workflow row must point at a function that exists here.
//  3. poke() counted ANY response as "handed off" — fetch does not throw on 404/403 — so callers
//     skipped their in-process fallback for a drain that never started.
//  4. The drain claimed strictly oldest-first and stopped starting work after 8 s even in the
//     15-minute background lane, so a backlog put the job a human was waiting on behind it.
//
// Run:  npx tsx tests/staging-queue-drain.test.ts

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const workflow = read('.github/workflows/staging-crons.yml');
const jobsBlock = workflow.slice(workflow.indexOf('JOBS="'), workflow.indexOf('"', workflow.indexOf('JOBS="') + 6));
const jobNames = jobsBlock.split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

async function main(): Promise<void> {
console.log('\n──── staging-crons.yml calls only functions that can answer it ────');

await check('every JOBS row names a function on this branch', () => {
    assert.ok(jobNames.length > 10, `parsed only ${jobNames.length} rows`);
    for (const n of jobNames) {
        assert.ok(existsSync(join(root, 'netlify/functions', `${n}.ts`)), `${n}.ts does not exist — the workflow would get 404`);
    }
});

await check('no JOBS row names a scheduled function (Netlify 403s a URL call to one)', () => {
    for (const n of jobNames) {
        const src = read(`netlify/functions/${n}.ts`);
        assert.ok(!/export const config\s*=\s*\{[^}]*schedule/.test(src), `${n} declares a schedule — call a run-* wrapper instead`);
    }
});

await check('mailboxes are polled through run-poll-mailboxes, which shares the poll and fails closed', () => {
    assert.ok(jobNames.includes('run-poll-mailboxes'));
    assert.ok(!jobNames.includes('poll-mailboxes'));
    const wrapper = read('netlify/functions/run-poll-mailboxes.ts');
    assert.match(wrapper, /import \{ pollDueMailboxes \} from '\.\/poll-mailboxes'/);
    assert.match(wrapper, /CRON_TRIGGER_SECRET/);
    assert.match(wrapper, /statusCode: 503/);
    assert.match(wrapper, /statusCode: 401/);
    assert.ok(!/schedule/.test(wrapper.replace(/^\/\/.*$/gm, '')), 'the wrapper must not be scheduled itself');
});

console.log('\n──── poke() only reports a hand-off the target accepted ────');

const realFetch = globalThis.fetch;
process.env.CRON_TRIGGER_SECRET = 'test-secret';
process.env.BASE_URL = 'https://staging.example.test';
const { triggerContentDrain } = await import('../src/utils/trigger-drain');
const quiet = console.warn; console.warn = () => {};

for (const [status, want] of [[202, true], [200, true], [404, false], [403, false], [500, false]] as const) {
    await check(`HTTP ${status} → ${want ? 'handed off' : 'not handed off (caller drains itself)'}`, async () => {
        let body = '';
        globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { body = String(init?.body); return new Response(null, { status }); }) as typeof fetch;
        assert.strictEqual(await triggerContentDrain(undefined, 'abc', 'test'), want);
        assert.match(body, /"jobId":"abc"/, 'the poke must carry the jobId so the drain can claim it first');
    });
}
globalThis.fetch = realFetch; console.warn = quiet;

console.log('\n──── the drain claims the waiting job first and uses the background lane\'s time ────');

const drain = read('netlify/functions/process-content-jobs.ts');
const bg = read('netlify/functions/run-content-jobs-background.ts');

await check('the poked job is ordered first, and only after a UUID check', () => {
    assert.match(drain, /ORDER BY \$\{priority \? `\(job_id = '\$\{priority\}'\) DESC, ` : ''\}created_at/);
    assert.match(drain, /JOB_ID_RE\.test\(opts\.priorityJobId\)/);
});

await check('the 26 s lanes keep the 8 s start budget; the background lane passes its own', () => {
    assert.match(drain, /const START_BUDGET_MS = opts\.startBudgetMs \?\? 8_000;/);
    assert.match(bg, /priorityJobId, startBudgetMs: BACKGROUND_START_BUDGET_MS/);
    assert.match(read('netlify/functions/run-content-jobs.ts'), /await drainContentJobs\(\)/);
});

await check('the background start budget leaves time to finish inside Netlify\'s 15 minutes', async () => {
    const { BACKGROUND_START_BUDGET_MS } = await import('../netlify/functions/run-content-jobs-background');
    assert.ok(BACKGROUND_START_BUDGET_MS >= 60_000 && BACKGROUND_START_BUDGET_MS <= 12 * 60_000, String(BACKGROUND_START_BUDGET_MS));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
