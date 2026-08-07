// tests/discovery-start-now.test.ts
// A search a human just started must actually start.
//
// The bug this exists for: creating a search only INSERTed a discovery_jobs row at status 'queued'.
// Nothing invoked the worker, so the Searches tab showed a "Queued" chip for up to ten minutes on
// production — and forever on a branch deploy, because Netlify fires scheduled functions only on
// the production deploy. The fix is an awaited poke to a looping background drain.
//
// These are source-shape checks, not behavioural ones: every property below is a property of how
// the code is WIRED (awaited vs not, loops vs drains once, claims atomically vs in two statements),
// and each one has a known failure mode that a mocked run would not reproduce.
// Run:  npx tsx tests/discovery-start-now.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');

console.log('\n──── every enqueue pokes the queue ────');

// The three places a discovery job is created. A fourth appearing without a poke is the exact
// regression that put the "Queued" chip on screen in the first place.
const ENQUEUE_SITES: Array<[string, string]> = [
    ['netlify/functions/discovery-campaigns.ts', 'the create + run_now API (the form and the Start search button)'],
    ['netlify/functions/lead-generation.ts', 'approve_idea (the chat path that claims "discovery running")'],
];

for (const [file, what] of ENQUEUE_SITES) {
    check(`${path.basename(file)} triggers the drain — ${what}`, () => {
        const s = read(file);
        assert.match(s, /triggerDiscoveryDrain/,
            `${file} enqueues a discovery job but never pokes the queue, so the run waits for the `
            + 'ten-minute cron — and on a branch deploy, where native crons never fire, forever.');
    });
}

check('every poke is AWAITED', () => {
    // The documented way to strand a job on this platform: an un-awaited fetch can be frozen with
    // the lambda before the request leaves the sandbox, and nothing in the logs explains why.
    for (const [file] of ENQUEUE_SITES) {
        const s = read(file);
        for (const m of s.matchAll(/(.{6})triggerDiscoveryDrain\(/g)) {
            assert.ok(/await $/.test(m[1]),
                `${file} calls triggerDiscoveryDrain without awaiting it. An un-awaited fetch dies `
                + 'with the frozen lambda and the job is never started.');
        }
    }
});

check('the poke never fails the enqueue it follows', () => {
    const s = read('src/utils/trigger-drain.ts');
    const fn = s.slice(s.indexOf('async function poke'), s.indexOf('/** Start the content'));
    assert.match(fn, /catch \(err\)/,
        'poke() must swallow its own failures — the job row is already committed, and throwing here '
        + 'would report a failure for work that was successfully queued.');
    assert.match(fn, /console\.warn/,
        'a swallowed failure must still be visible in the logs, or a queue that silently stopped '
        + 'being poked looks identical to one that is simply slow.');
});

console.log('\n──── the drain loops, because a run is sliced ────');

check('the background drain loops until the queue is empty or its budget expires', () => {
    const s = read('netlify/functions/run-discovery-jobs-background.ts');
    assert.match(s, /while \(/,
        'One drain advances a run by ONE search query (QUERIES_PER_SLICE) and re-queues it. Draining '
        + 'once moves the chip from Queued to Searching and then strands the run on the cron for '
        + 'another ten minutes per query — over two hours for a fifteen-query run.');
    assert.match(s, /deadline|BUDGET_MS/,
        'the loop needs a wall-clock budget: a background function is killed at 15 minutes, and a '
        + 'slice killed mid-write is the "stuck in processing" case the worker must then time out.');
    assert.match(s, /if \(!processed\) break/,
        'the loop must stop when a pass claims nothing, or an empty queue spins until the budget ends.');
});

check('the background drain fails closed without the shared secret', () => {
    const s = read('netlify/functions/run-discovery-jobs-background.ts');
    assert.match(s, /CRON_TRIGGER_SECRET/, 'the endpoint must be secret-guarded.');
    assert.match(s, /statusCode: 503/,
        'an unset secret must disable the endpoint, not leave it open — a drain spends real money '
        + '(Serper calls and model tokens).');
    assert.match(s, /statusCode: 401/, 'a wrong secret must be rejected.');
});

console.log('\n──── two drainers cannot claim the same slice ────');

check('the job claim is a single atomic statement', () => {
    const s = read('netlify/functions/process-discovery-jobs.ts');
    const fn = s.slice(s.indexOf('export async function drainDiscoveryJobs'), s.indexOf('export default'));

    // It was SELECT ... FOR UPDATE SKIP LOCKED, then a separate UPDATE inside processJob. db.execute
    // does not open a transaction, so the row lock ended with the SELECT and two drainers could
    // return the same row. That was survivable when the only drainer was a ten-minute cron. It is
    // not, now that the background function loops for minutes and can overlap a cron tick — a
    // double-claimed slice bills the same search twice and inserts its leads twice.
    assert.match(fn, /UPDATE discovery_jobs SET status = 'processing'[\s\S]*RETURNING/,
        'drainDiscoveryJobs must claim and select in one UPDATE ... RETURNING.');
    assert.match(fn, /FOR UPDATE SKIP LOCKED/,
        'concurrent drainers must skip each other\'s rows rather than queue behind them.');

    const worker = s.slice(s.indexOf('async function processJob'));
    assert.ok(
        !/UPDATE discovery_jobs SET status = 'processing'/.test(worker.slice(0, worker.indexOf('try {'))),
        'processJob must NOT re-claim: the row arrives already claimed, and a second claim '
        + 'statement is what re-opens the window this test closes.',
    );
});

console.log('\n──── the UI states when it next runs ────');

check('both list endpoints return the schedule, not just the cadence', () => {
    for (const f of ['netlify/functions/signal-inbox.ts', 'netlify/functions/discovery-campaigns.ts']) {
        const s = read(f);
        assert.match(s, /nextRunAt: discoverySchedules\.nextRunAt/,
            `${f} must return next_run_at — without it the UI can only print a generic "it repeats `
            + 'daily", which never tells the user whether that means tomorrow or in six days.');
        assert.match(s, /scheduleEnabled: discoverySchedules\.isEnabled/,
            `${f} must return isEnabled. nextRunAt alone cannot distinguish a scheduled run from a `
            + "draft's disabled schedule, so the UI would promise a run nothing will make.");
    }
});

check('neither surface prints a next-run time for a one-off search', () => {
    // one_off is the DEFAULT cadence, so this is most searches. createDiscoveryRun stores
    // nextRunAt: null for them — there is genuinely no next run, and inventing one would be the
    // same class of lie as the fixed cadence string this replaced.
    const helper = read('src/utils/discovery.ts');
    assert.match(helper, /nextRunAt: cadence === 'one_off' \? null : new Date\(\)/,
        'a one_off campaign must store a null nextRunAt.');

    for (const f of ['src/components/assistant-signal-inbox.js', 'src/components/assistant-discovery-campaigns.js']) {
        const s = read(f);
        const fn = s.slice(s.search(/function (cadenceLine|scheduleLine)\(/));
        const body = fn.slice(0, fn.indexOf('\n  }'));
        assert.match(body, /cadence === 'one_off'\) return/,
            `${f} must return early for one_off, before any nextRunAt is read.`);
        assert.match(body, /scheduleEnabled/,
            `${f} must check scheduleEnabled — a draft has a cadence but no scheduled run yet.`);
    }
});

check('the Queued chip no longer promises a time it cannot keep', () => {
    const s = read('src/components/assistant-signal-inbox.js');
    // Only the rendered strings, never the prose around them — the comment explaining this bug
    // necessarily quotes the copy it replaced, and a whole-file grep would fail on the fix's own
    // documentation.
    const rendered = s.match(/^\s*line: .*$/gm)?.join('\n') ?? '';
    assert.ok(rendered, 'searchState no longer builds `line:` strings — retarget this check.');
    assert.ok(!/within a few minutes|in a minute|shortly/.test(rendered),
        'The old copy said a queued search "starts within a few minutes". It was wrong on prod (a '
        + 'ten-minute cron) and badly wrong on staging (branch deploys never fire native crons, so '
        + 'it never started at all). The poke makes it start immediately, but it is best-effort and '
        + 'falls back to the cron, so this copy must not name a clock time.');
});

console.log(`\n${passed} checks passed.`);
