// tests/job-generates-once.test.ts
// Winning the claim says nobody else is running this job RIGHT NOW. It does not say the job has
// never run before — and process-content-jobs re-queues itself on any throw, from a whole try block
// that contains the post INSERT. So an attempt that died after inserting came back and generated a
// SECOND post, stamped with the job's own crosspost_group_id, which put two independently-written
// posts inside ONE cross-post group. The Review Queue collapses a group into a single card, so the
// duplicate is invisible at the only point a human is asked to approve it, and every row publishes
// on its own — one audience, the same slot, two different posts.
//
// Measured on PROD 2026-09-03 (Love Cat Studio, reported as "two Instagram icons on one calendar
// chip"), all from ONE job each:
//   job 461ad38e → post 511 (generated 18:50:26, "Around 47 moments…")   instagram
//                → posts 512 + 513 (19:01:00, "Three minutes…")          instagram + facebook
//     …all three 'scheduled' for 2026-09-03 08:00, so Instagram was due two unrelated posts.
//   job b91d1acc → 8 posts: instagram, facebook, linkedin and x, each TWICE — a complete run that
//     then threw in its follow-up, AFTER the job was already recorded 'completed'.
//
// Two independent guards, so this test checks both:
//   1. a job that has already produced a post never generates again;
//   2. nothing after the 'completed' update can push the job back to 'queued'.
//
// Pure: the worker's control flow is simulated in memory, then the real source is scanned to prove
// the simulated shape is the shipped one. No DB, no network.
// Run:  npx tsx tests/job-generates-once.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── A model of one job and the posts it writes ──────────────────────────────────────────────────
interface Job { id: number; status: string; attempt: number; maxAttempts: number; groupId: string }
interface Post { id: number; jobId: number; platform: string; groupId: string; caption: string }

/**
 * One drain of one job. `failAt` says where the FIRST attempt dies — only the first, because that is
 * what prod showed: a transient (a media step, a missing notification template, a Neon blip) takes
 * one attempt and the retry then runs cleanly, which is exactly what makes the duplicate a finished,
 * approvable post rather than an obvious failure.
 *   'after-insert' — prod job 461ad38e: the primary row exists, the fan-out never ran.
 *   'in-follow-up' — prod job b91d1acc: the job is already 'completed', a notification throws.
 *   null           — a clean run.
 * `guarded` selects the fixed worker.
 */
function runJob(job: Job, posts: Post[], opts: { failAt: 'after-insert' | 'in-follow-up' | null; guarded: boolean }) {
    if (job.status !== 'queued') return;              // the status-guarded claim
    job.status = 'processing';
    job.attempt += 1;

    // GUARD 1 — this job has produced content before, so producing more duplicates it.
    if (opts.guarded && posts.some(p => p.jobId === job.id)) {
        job.status = 'completed';
        return;
    }

    const firstAttempt = job.attempt === 1;
    let completed = false;
    try {
        const nth = posts.filter(p => p.jobId === job.id).length + 1;
        posts.push({ id: posts.length + 1, jobId: job.id, platform: 'instagram', groupId: job.groupId, caption: `caption ${nth}` });
        if (firstAttempt && opts.failAt === 'after-insert') throw new Error('media step blew up');
        posts.push({ id: posts.length + 1, jobId: job.id, platform: 'facebook', groupId: job.groupId, caption: `caption ${nth}` });

        job.status = 'completed';
        completed = true;                              // ← the flag, set with the UPDATE

        if (firstAttempt && opts.failAt === 'in-follow-up') throw new Error('notification template missing');
    } catch {
        // GUARD 2 — the post exists and the job is recorded completed; only the notice was lost.
        if (opts.guarded && completed) return;
        job.status = job.attempt >= job.maxAttempts ? 'failed' : 'queued';
    }
}

const freshJob = (): Job => ({ id: 1, status: 'queued', attempt: 0, maxAttempts: 3, groupId: 'g1' });
/** Drain until the job stops asking to be retried, as the cron does. */
const drain = (opts: { failAt: 'after-insert' | 'in-follow-up' | null; guarded: boolean }) => {
    const job = freshJob();
    const posts: Post[] = [];
    for (let tick = 0; tick < 5 && job.status === 'queued'; tick++) runJob(job, posts, opts);
    return { job, posts };
};
const onPlatform = (posts: Post[], platform: string) => posts.filter(p => p.platform === platform);

console.log('\nThe retry that wrote two posts into one cross-post group\n');

check('OLD: a throw after the insert makes the retry write a SECOND Instagram post — the prod bug', () => {
    const { posts } = drain({ failAt: 'after-insert', guarded: false });
    assert.equal(onPlatform(posts, 'instagram').length, 2, 'the simulation no longer reproduces the duplicate');
    // And they are not copies of each other: each attempt generates its own caption, which is why
    // prod showed "Around 47 moments…" and "Three minutes…" in the same group.
    assert.notEqual(posts[0].caption, posts[1].caption);
    assert.equal(new Set(posts.map(p => p.groupId)).size, 1, 'both landed in ONE group — one review card');
});

check('OLD: a throw in the FOLLOW-UP re-runs a completed job and duplicates every platform', () => {
    const { posts } = drain({ failAt: 'in-follow-up', guarded: false });
    assert.equal(onPlatform(posts, 'instagram').length, 2);
    assert.equal(onPlatform(posts, 'facebook').length, 2, 'this is the 8-posts-from-one-job shape');
});

check('NEW: a job that already produced a post never generates again', () => {
    const { posts } = drain({ failAt: 'after-insert', guarded: true });
    assert.equal(onPlatform(posts, 'instagram').length, 1, 'the retry generated a second post anyway');
});

check('NEW: bailing leaves the group SHORT rather than duplicated — the deliberate trade', () => {
    const { posts, job } = drain({ failAt: 'after-insert', guarded: true });
    assert.equal(onPlatform(posts, 'facebook').length, 0, 'the sibling the failed attempt never wrote');
    assert.equal(job.status, 'completed', 'the job must not sit queued, re-entering this path forever');
    // A missing sibling is a gap; a duplicate is a real post published twice to a real audience.
});

check('NEW: a follow-up failure never re-queues a completed job', () => {
    const { job, posts } = drain({ failAt: 'in-follow-up', guarded: true });
    assert.equal(posts.length, 2, 'the completed job was handed back to the drain and ran again');
    assert.equal(job.status, 'completed', "the follow-up failure overwrote 'completed'");
});

check('NEW: a clean run still writes exactly one row per platform', () => {
    const { posts, job } = drain({ failAt: null, guarded: true });
    assert.equal(posts.length, 2);
    assert.equal(job.status, 'completed');
});

console.log('\nThe shipped worker carries both guards\n');

const social = read('../netlify/functions/process-content-jobs.ts');
const start = landmark(social, 'async function processJob(');
// Between winning the claim and the try block that owns generation: where guard 1 has to live. Any
// later and the job has already paid for a generation it is about to throw away.
const beforeGeneration = social.slice(
    landmark(social, 'const claimedAttempt = Number(', start),
    landmark(social, 'const [bp] = await db', start),
);

check('guard 1 runs BEFORE the generation, keyed on the job id', () => {
    assert.ok(/FROM scheduled_posts WHERE job_id =/.test(beforeGeneration),
        'nothing asks whether this job has already produced a post');
    assert.ok(/return;/.test(beforeGeneration), 'the answer is read and then ignored');
});

check('guard 1 completes the job rather than leaving it queued', () => {
    assert.ok(/status = 'completed'/.test(beforeGeneration),
        'a job that bails must be closed, or every tick re-enters this path');
});

check('guard 2 marks the job completed and refuses to retry after that point', () => {
    const tail = social.slice(landmark(social, "SET status = 'completed', result_post_id", start));
    assert.ok(/jobCompleted = true;/.test(tail), 'nothing records that the job is past the point of no retry');
    assert.ok(/if \(jobCompleted\) \{[\s\S]{0,400}?return;/.test(tail),
        'the catch can still overwrite a completed job with queued');
});

check('the fan-out list is deduped before it becomes one row per entry', () => {
    const slice = social.slice(landmark(social, 'const fanoutPlatforms =', start), landmark(social, 'const promptPlatform', start));
    assert.ok(/new Set\(/.test(slice),
        'a platforms list naming one platform twice still writes two rows into one group');
});

console.log(`\n${passed} checks passed\n`);
