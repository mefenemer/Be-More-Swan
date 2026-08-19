// tests/job-claim-is-atomic.test.ts
// Two content workers drain content_generation_jobs. Both SELECT with FOR UPDATE SKIP LOCKED — and
// both issue that SELECT as a STANDALONE statement, so postgres-js autocommits and the row locks are
// released before the first job is processed. SKIP LOCKED guarantees nothing across invocations.
//
// The only real mutual exclusion is the claim's `AND status = 'queued'`. Without it, two overlapping
// drains both write 'processing' and both generate content.
//
// Measured on prod 2026-08-18, assistant 6 (Lyra, Blog Writer): FIVE jobs produced NINE posts.
//   job aa86c6a5 → 1 post   (already 'processing' when the second drain SELECTed)
//   job 53bfe155 → 2 posts  (13:20:41 with a body, 13:21:01 empty)
//   job 6ebaa03b → 2 posts  · 024ee626 → 2 posts · 30a4d925 → 2 posts
// Every one of them still reporting attempt = 1, because both drains read attempt 0 and both wrote 1.
//
// Pure: the race is simulated against an in-memory table, so no DB and no network.
// Run:  npx tsx tests/job-claim-is-atomic.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── A model of the queue row, and the two claim shapes ──────────────────────────────────────────
interface Job { id: number; status: string; attempt: number }

/** What both workers did: flip to 'processing' keyed on id alone. */
function claimUnguarded(job: Job, seen: { attempt: number }): boolean {
    job.status = 'processing';
    job.attempt = seen.attempt + 1;   // recomputed from the racer's own stale SELECT
    return true;                       // always "claims"
}

/** What they do now: flip only while still queued, and count in SQL. */
function claimGuarded(job: Job, _seen: { attempt: number }): boolean {
    if (job.status !== 'queued') return false;   // WHERE ... AND status = 'queued' matched no row
    job.status = 'processing';
    job.attempt = job.attempt + 1;               // attempt = attempt + 1, evaluated by the DB
    return true;
}

/** Two drains that both SELECTed the same queued row before either processed it. */
function raceTwoDrains(claim: (j: Job, seen: { attempt: number }) => boolean) {
    const job: Job = { id: 1, status: 'queued', attempt: 0 };
    const snapshotA = { attempt: job.attempt };   // drain A's SELECT
    const snapshotB = { attempt: job.attempt };   // drain B's SELECT — same row, locks already gone
    const postsWritten = [claim(job, snapshotA), claim(job, snapshotB)].filter(Boolean).length;
    return { postsWritten, attempt: job.attempt };
}

console.log('\nThe race that produced nine posts from five jobs\n');

check('the OLD unguarded claim lets both drains through — this is the bug', () => {
    const { postsWritten, attempt } = raceTwoDrains(claimUnguarded);
    assert.equal(postsWritten, 2, 'the simulation no longer reproduces the double-claim');
    // And the counter hides it: two runs, still "attempt 1" — exactly what prod showed.
    assert.equal(attempt, 1, 'the stale-read increment no longer under-reports');
});

check('the guarded claim admits exactly ONE drain', () => {
    const { postsWritten } = raceTwoDrains(claimGuarded);
    assert.equal(postsWritten, 1);
});

check('the guarded claim counts the attempt honestly', () => {
    const { attempt } = raceTwoDrains(claimGuarded);
    assert.equal(attempt, 1, 'one successful claim is one attempt');
    // A reclaimed job attempted again must count 2, or the give-up threshold never trips.
    const job: Job = { id: 1, status: 'queued', attempt: 1 };
    claimGuarded(job, { attempt: 0 });   // a stale snapshot must not reset the count
    assert.equal(job.attempt, 2);
});

console.log('\nBoth workers actually carry the guard\n');

const blog = read('../netlify/functions/process-blog-jobs.ts');
const social = read('../netlify/functions/process-content-jobs.ts');

check('process-blog-jobs claims only while the job is still queued', () => {
    const start = landmark(blog, 'async function processBlogJob(');
    const slice = blog.slice(start, landmark(blog, 'let createdPostId', start));
    assert.ok(slice.includes("eq(contentGenerationJobs.status, 'queued')"),
        'the claim is not guarded on status — overlapping drains will both generate a post');
    assert.ok(/\.returning\(/.test(slice), 'nothing tells this invocation whether it won the race');
    assert.ok(/if \(!claimed\) return;/.test(slice), 'losing the race does not stop the work');
});

check('process-content-jobs claims only while the job is still queued', () => {
    const start = landmark(social, 'async function processJob(');
    const slice = social.slice(start, start + 2500);
    assert.ok(/AND status = 'queued'/.test(slice),
        'the claim is not guarded on status — the social fan-out will duplicate across every platform');
    assert.ok(/RETURNING attempt/.test(slice), 'the claim reports neither ownership nor the attempt');
    assert.ok(/if \(!claimed\.length\) return;/.test(slice), 'losing the race does not stop the work');
});

check('neither worker increments attempt from its own stale SELECT', () => {
    // job.attempt + 1 at claim time is what let two racers both write "1".
    const blogStart = landmark(blog, 'async function processBlogJob(');
    const blogClaim = blog.slice(blogStart, landmark(blog, 'let createdPostId', blogStart));
    assert.ok(!/attempt:\s*job\.attempt \+ 1/.test(blogClaim), 'blog still counts from the stale read');
    assert.ok(blogClaim.includes('${contentGenerationJobs.attempt} + 1'), 'blog does not count in SQL');

    const socialStart = landmark(social, 'async function processJob(');
    const socialClaim = social.slice(socialStart, socialStart + 2500);
    assert.ok(/attempt = attempt \+ 1/.test(socialClaim), 'social does not count in SQL');
});

check('the failure path decides on the CLAIMED attempt, not the stale one', () => {
    // Give-up-or-retry is decided here; a stale value makes a job retry past max_attempts.
    assert.ok(social.includes('const attempt = claimedAttempt;'),
        'the social failure path recomputed the attempt from its own SELECT');
});

check('the header no longer credits SKIP LOCKED for safety it does not provide', () => {
    assert.ok(!/Uses FOR UPDATE SKIP LOCKED to safely handle concurrent cron ticks/.test(social),
        'the comment that sent three readers past this bug is still there');
    assert.ok(/status-guarded claim|STATUS-GUARDED CLAIM/i.test(social),
        'nothing tells the next reader where the real guarantee lives');
});

console.log(`\n${passed} checks passed\n`);
