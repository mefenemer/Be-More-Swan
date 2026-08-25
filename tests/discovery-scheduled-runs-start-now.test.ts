// tests/discovery-scheduled-runs-start-now.test.ts
// A SCHEDULED search must start as promptly as one a human started.
//
// ── The defect ───────────────────────────────────────────────────────────────
// A discovery run is sliced: one search query per invocation (QUERIES_PER_SLICE = 1), five leads
// per enrichment batch (ENRICH_BATCH = 5). At the ten-minute cron cadence that is ten minutes PER
// SLICE, so a fifteen-query run takes hours.
//
// Every hand-started surface already avoids this by poking run-discovery-jobs-background, which
// loops the drain until the queue empties, so one poke carries the whole run in minutes:
//   discovery-campaigns.ts  create / approve_brief / run_now
//   lead-generation.ts      approve_idea
//
// dispatch-discovery-runs.ts did NOT. It INSERTed a queued row and returned. So the identical
// search finished in minutes when a person pressed the button and took hours when the schedule
// fired it — and the slow path was the unattended one, where nobody was watching to report it.
//
// ⚠️ THE INVARIANT: every path that ENQUEUES a discovery job pokes the drain. A new enqueue site
// that forgets is invisible in testing (the cron still runs it, eventually) and only shows up as
// a user asking why their daily search takes all morning.
//
// Run:  npx tsx tests/discovery-scheduled-runs-start-now.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const DISPATCH = read('netlify/functions/dispatch-discovery-runs.ts');
const TRIGGER = read('src/utils/trigger-drain.ts');
const LOOPER = read('netlify/functions/run-discovery-jobs-background.ts');

console.log('\n──── the scheduled path starts its own work ────');

check('the dispatcher pokes the drain after enqueueing', () => {
    assert.ok(/triggerDiscoveryDrain\(/.test(DISPATCH),
        'dispatch-discovery-runs no longer starts the queue — scheduled searches are back on the ten-minute cron, one slice at a time');
    assert.ok(/from '\.\.\/\.\.\/src\/utils\/trigger-drain'/.test(DISPATCH),
        'the dispatcher no longer imports the shared trigger');
});

check('it pokes ONCE per cycle, not once per job', () => {
    // The looper drains the whole QUEUE, and drainDiscoveryJobs claims up to five jobs per pass
    // across all campaigns. A poke per row would start N loops competing for the same rows —
    // harmless, because the claim is one atomic UPDATE ... RETURNING, but pure waste.
    const calls = DISPATCH.match(/triggerDiscoveryDrain\(/g) || [];
    assert.equal(calls.length, 1, `the dispatcher pokes ${calls.length} times — one poke drains the whole queue`);
    // Outside the per-schedule loop: guarded on the first id, which is only set when a row was
    // actually inserted.
    assert.ok(/firstJobId \?\?= jobId/.test(DISPATCH), 'the first job id is no longer captured');
    assert.ok(/if \(firstJobId\)/.test(DISPATCH),
        'the poke is no longer guarded — a cycle that enqueued nothing must not wake the queue');
});

check('the poke is best-effort and cannot fail the dispatch', () => {
    // Every failure path in `poke` leaves the rows where they are for the cron — i.e. the exact
    // behaviour this replaces. If that ever changes, a transient network blip would start
    // dropping scheduled runs instead of merely delaying them.
    assert.ok(/catch \(err\)/.test(TRIGGER), 'poke() no longer swallows its failures');
    assert.ok(/job waits for the cron/.test(TRIGGER),
        'the fallback-to-cron promise is gone from the warning — that promise is why this is safe');
});

check('a scheduled invocation can still resolve a base URL', () => {
    // ⚠️ There are no request headers on a cron invocation, so resolveBaseUrl falls through to
    // BASE_URL / DEPLOY_PRIME_URL. Passing headers here would be a lie; passing nothing must stay
    // supported by the resolver.
    const BASE = read('src/utils/base-url.ts');
    assert.ok(/headers\?: RequestHeaders/.test(BASE), 'resolveBaseUrl no longer accepts an absent headers argument');
    assert.ok(/process\.env\.BASE_URL/.test(BASE), 'BASE_URL is no longer the first fallback — a cron poke cannot resolve a host');
    assert.ok(/triggerDiscoveryDrain\(undefined,/.test(DISPATCH),
        'the dispatcher passes headers it does not have — a scheduled invocation has none');
});

console.log('\n──── every enqueue site pokes ────');

check('no function inserts a discovery job without starting the queue', () => {
    // The invariant, enforced across the whole functions directory rather than against a list —
    // a NEW enqueue site that forgets to poke is exactly the defect this file exists for, and it
    // would pass a test that only knew about today's callers.
    const dir = join(root, 'netlify/functions');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        const src = readFileSync(join(dir, f), 'utf8');
        // `.values({ ... jobId ... })` on discoveryJobs, or the shared createDiscoveryRun helper.
        const enqueues = /insert\(discoveryJobs\)/.test(src);
        if (!enqueues) continue;
        if (!/triggerDiscoveryDrain/.test(src)) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
        `these enqueue a discovery job and never start the queue, so the run waits up to ten minutes PER SLICE: ${offenders.join(', ')}`);
});

console.log('\n──── the looper this relies on ────');

check('the background looper still drains until the queue is empty', () => {
    // One poke has to carry the whole run. If this stopped looping, the poke would advance a
    // sliced run by exactly one query and strand the rest on the cron — the defect would be back
    // with the fix still in place, which is the worst version of it.
    assert.ok(/while \(Date\.now\(\) < deadline/.test(LOOPER), 'the drain loop is gone — a poke now advances one slice only');
    // Matched on the `break`, not on the whole statement: the empty-queue exit also records that
    // it emptied (for the §2.2 hand-off decision), so pinning the exact one-liner broke on a
    // change that altered nothing about the behaviour being defended.
    assert.ok(/if \(!processed\) \{? ?drained = true; break/.test(LOOPER),
        'the loop no longer stops on an empty queue');
    assert.ok(/MAX_PASSES/.test(LOOPER), 'the pass ceiling is gone — a queue that never empties would spin');
});

console.log(`\n${passed} checks passed.`);
