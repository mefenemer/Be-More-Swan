// tests/reject-regeneration.test.ts
// Rejecting a post must actually produce a revised one — and it must land somewhere a human can see.
//
// Run:  npx tsx tests/reject-regeneration.test.ts
//
// A SOURCE-level invariant test, in the same spirit as crosspost-grouping.test.ts and for the same
// reason: the bug this exists for produced no error and no failing request.
//
// reject-post.ts used to INSERT a clone of the rejected post at status 'draft', commented "Create a
// revised draft (clone of original) for AI regeneration". Every part of that except the INSERT was
// aspirational. No worker or cron selected the row. No surface displayed it: the Review Queue's
// columns match `status` by exact equality (get-social-drafts.ts) and none of them is 'draft', and
// the Calendar excludes it via SCHEDULE_INACTIVE_STATUSES. archive-cleanup only hard-deletes
// 'rejected', so it was never collected either. Meanwhile both callers told the user a rewrite was
// on its way, and reject-post sent a notification titled "your revised post is ready to review".
//
// The whole failure lived in the gap between a status a writer picks and the statuses a reader
// looks for — so that gap is what is asserted, along with the wiring that replaced the clone.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const rejectPost = read('netlify/functions/reject-post.ts');
const worker = read('netlify/functions/process-content-jobs.ts');
const workspace = read('workspace.html');
const schema = read('db/schema.ts');

console.log('\nRejection → regeneration\n');

// ── The dead end itself ──────────────────────────────────────────────────────────────────────────

check('reject-post writes no scheduled_posts row of its own', () => {
    assert.ok(
        !rejectPost.includes('insert(scheduledPosts)'),
        'reject-post inserts a scheduled_posts row again. The clone it used to write was invisible ' +
        'to every reader; if a revised post is needed, the generation job must produce it.',
    );
});

check("no post creator parks a row at 'draft' expecting a human to find it", () => {
    // The Review Queue matches status by exact equality, so 'draft' is unreachable from the UI.
    // (`draft` remains a legitimate write-only status elsewhere — this only guards reject-post.)
    assert.ok(
        !/status:\s*'draft'/.test(rejectPost),
        "reject-post creates a post at status 'draft', which no Review Queue column and no Calendar " +
        'view reads. The revision must land at pending_approval.',
    );
});

check("the Review Queue still has no 'draft' column", () => {
    const block = workspace.slice(workspace.indexOf('const RQ_COLUMNS'));
    const columns = block.slice(0, block.indexOf('};'));
    assert.ok(columns.includes("postStatus: 'pending_approval'"), 'RQ_COLUMNS lost its review column.');
    assert.ok(
        !columns.includes("postStatus: 'draft'"),
        "RQ_COLUMNS now has a 'draft' column. If that is intended, this test's premise changed — but " +
        'check every writer of draft rows before relying on it.',
    );
});

// ── The replacement wiring ───────────────────────────────────────────────────────────────────────

check('reject-post enqueues a real regeneration job', () => {
    assert.ok(
        rejectPost.includes('insert(contentGenerationJobs)'),
        'reject-post no longer enqueues a generation job, so the rewrite both callers promise the ' +
        'user never happens.',
    );
});

check('the job carries the rejected post id, and the feedback as context', () => {
    const i = rejectPost.indexOf('insert(contentGenerationJobs)');
    const body = rejectPost.slice(i, i + 1400);
    assert.ok(body.includes('revisedFromPostId: postId'),
        'The job must name the post it revises, or the resulting draft cannot be badged "Revised".');
    assert.ok(body.includes('contextPrompt:'),
        'Without the rejection feedback as context the redraft is free to reproduce what was rejected.');
});

check('the queue poke is awaited', () => {
    assert.ok(
        /await\s+triggerContentDrain\(/.test(rejectPost),
        'triggerContentDrain must be awaited — an un-awaited background invoke can be frozen with the ' +
        'lambda before it leaves the sandbox, stranding the job.',
    );
});

check('the rejection survives a failed enqueue', () => {
    const i = rejectPost.indexOf('insert(contentGenerationJobs)');
    assert.ok(i !== -1, 'no enqueue to check');
    // The rejection UPDATE must already be committed before the enqueue is attempted.
    assert.ok(
        rejectPost.indexOf("status: 'rejected'") < i,
        'The post must be marked rejected BEFORE the regeneration is attempted, so a generation ' +
        'failure never silently un-rejects a post the user rejected.',
    );
    assert.ok(
        /catch[\s\S]{0,200}revision enqueue failed/.test(rejectPost),
        'The enqueue must be wrapped in a catch that lets the rejection stand.',
    );
    assert.ok(
        /success:\s*true/.test(rejectPost.slice(rejectPost.indexOf('statusCode: 200'))),
        'A rejection whose regeneration could not be queued must still report success — the post IS ' +
        'rejected. revisionQueued/revisionSkippedReason say what happened to the redraft.',
    );
});

// ── The worker end ───────────────────────────────────────────────────────────────────────────────

check('the worker reads revised_from_post_id', () => {
    assert.ok(
        worker.includes('revised_from_post_id'),
        'process-content-jobs never selects the column, so a revision is indistinguishable from any ' +
        'other job and the resulting draft is never badged.',
    );
    const select = worker.slice(worker.indexOf('FROM content_generation_jobs') - 600, worker.indexOf('FROM content_generation_jobs'));
    assert.ok(select.includes('revised_from_post_id'), 'the column is used but not SELECTed');
});

check('a revision draft is stamped isRevised and lands at pending_approval', () => {
    assert.ok(
        /isRevised:\s*true,\s*revisedFromPostId:\s*job\.revised_from_post_id/.test(worker),
        'The draft produced from a revision job must carry isRevised/revisedFromPostId — those are ' +
        'what calendar.js and workspace.html badge on.',
    );
    assert.ok(
        worker.includes("status: isAdminTest ? 'admin_test' : 'pending_approval'"),
        'The generated draft must still land in the review column.',
    );
});

check('cross-post siblings of a revision are badged too', () => {
    // Otherwise one card in a group says "Revised" and its siblings say nothing.
    const stamps = worker.match(/isRevised:\s*true/g) || [];
    assert.ok(stamps.length >= 2,
        `only ${stamps.length} insert(s) stamp isRevised — the sibling fan-out must stamp it as well.`);
});

check('"revised post is ready" is sent when it IS ready', () => {
    assert.ok(
        /createNotification\(db,\s*'post_revised'/.test(worker),
        'post_revised must be sent by the worker, once the revised draft actually exists.',
    );
    assert.ok(
        !/createNotification\(db,\s*'post_revised'/.test(rejectPost),
        'reject-post sends post_revised again. Sent at rejection time it announces a draft that has ' +
        'not been generated yet — the promise that made the original bug invisible.',
    );
});

// ── Schema ───────────────────────────────────────────────────────────────────────────────────────

check('the column is declared and has DDL to match', () => {
    assert.ok(
        /revisedFromPostId:\s*integer\("revised_from_post_id"\)/.test(schema),
        'content_generation_jobs.revised_from_post_id missing from db/schema.ts',
    );
    const ddl = read('db/reject-regeneration.sql');
    assert.ok(
        /ALTER TABLE content_generation_jobs[\s\S]*ADD COLUMN IF NOT EXISTS revised_from_post_id/.test(ddl),
        'db/reject-regeneration.sql must add the column (applied manually — see project convention).',
    );
});

console.log(`\n${passed}/${total} checks passed\n`);
if (passed !== total) process.exitCode = 1;
