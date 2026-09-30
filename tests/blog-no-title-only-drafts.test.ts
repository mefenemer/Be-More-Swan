// tests/blog-no-title-only-drafts.test.ts
// "The blog assistant creates a blog with a title and no content."
//
// ── Why it happened ─────────────────────────────────────────────────────────────────────────────
// An autopilot attempt INSERTS the post row (title only) and then drafts the body into it — a 30–60s
// model call. failJob deletes that row when the attempt fails in-process, but a run the platform
// KILLS mid-draft never reaches its catch. The row survived, and:
//   - the stuck-job reset re-queued the job, and the next attempt inserted ANOTHER title-only row;
//   - on the last attempt the reset skipped the job entirely (`attempt < max_attempts`), so it sat in
//     'processing' forever and its empty post sat in the Blogs tab with it.
//
// Run:  npx tsx tests/blog-no-title-only-drafts.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const worker = readFileSync(join(import.meta.dirname, '..', 'netlify/functions/process-blog-jobs.ts'), 'utf8');

console.log('\na killed attempt cannot leave a title-only post behind');

check('the "empty autopilot draft" predicate is narrow', () => {
    const def = worker.slice(landmark(worker, 'const EMPTY_AUTOPILOT_DRAFT ='), landmark(worker, 'const INTERRUPTED_GIVE_UP'));
    // ⚠️ body_markdown is NOT NULL DEFAULT '' — an IS NULL check alone matches nothing.
    assert.ok(def.includes("btrim(bp.body_markdown) = ''"), 'an empty-string body is not recognised as empty');
    // Only ever a draft still awaiting review: never one approved, scheduled or published.
    assert.ok(def.includes("bp.status = 'pending_approval'"), 'the cleanup can reach a post past review');
});

check('each autopilot attempt clears its own earlier orphan BEFORE inserting', () => {
    const cleanup = landmark(worker, 'DELETE FROM blog_posts bp\n                WHERE bp.job_id = ${job.job_id}');
    const insert = landmark(worker, 'await db.insert(blogPosts).values({');
    assert.ok(cleanup < insert, 'the retry inserts a second row before removing the first');
    // Scoped to THIS job and org, never a sweep of the whole table.
    const stmt = worker.slice(cleanup, insert);
    assert.ok(stmt.includes('bp.organisation_id = ${job.organisation_id}'), 'the cleanup is not org-scoped');
    assert.ok(stmt.includes('EMPTY_AUTOPILOT_DRAFT'), 'the cleanup does not use the narrow predicate');
});

check('the cleanup is on the AUTOPILOT branch only', () => {
    // The interactive branch writes into the post the author has open. Deleting it would be the worst
    // possible outcome, so the cleanup must sit after the `else` that starts the autopilot path.
    const elseAt = landmark(worker, 'const idea = await ideateBlogTopic(db, {');
    const cleanup = landmark(worker, 'DELETE FROM blog_posts bp\n                WHERE bp.job_id = ${job.job_id}');
    assert.ok(cleanup > elseAt, 'the orphan cleanup runs on the interactive path too');
});

check('a job killed on its LAST attempt is settled, and its empty post removed', () => {
    const drain = worker.slice(landmark(worker, 'export async function drainBlogJobs('), landmark(worker, 'const jobs = await db.execute<BlogJobRow>('));
    assert.ok(drain.includes('attempt >= max_attempts'), 'last-attempt strandings are still left in processing forever');
    assert.ok(drain.includes("SET status = 'failed'"), 'the stranded job is not failed');
    assert.ok(/DELETE FROM blog_posts bp USING dead[\s\S]*bp\.job_id = dead\.job_id[\s\S]*EMPTY_AUTOPILOT_DRAFT/.test(drain),
        'the stranded job\'s title-only post is not removed');
});

check('the give-up message is safe to inline into SQL', () => {
    // It is interpolated into a raw string literal; one apostrophe would break the whole drain.
    const msg = worker.slice(landmark(worker, 'const INTERRUPTED_GIVE_UP'), landmark(worker, 'type BlogJobRow'));
    assert.ok(!/[a-z]'[a-z]/i.test(msg.replace(/^[^=]*=/, '').replace(/'\s*\+\s*'/g, '')),
        'INTERRUPTED_GIVE_UP contains an apostrophe');
});

console.log('\nthe crons hand the drain to the background function');

for (const [file, caller] of [
    ['netlify/functions/process-blog-jobs.ts', 'process-blog-jobs'],
    ['netlify/functions/run-blog-jobs.ts', 'run-blog-jobs'],
] as const) {
    check(`${caller} starts run-blog-jobs-background before draining in-process`, () => {
        // ⚠️ Both run on a seconds-long budget, and one draft is a 30–60s model call: drained in-process
        // a run was killed mid-draft as a matter of course. That is what stranded the title-only posts.
        const src = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
        const handler = src.slice(landmark(src, 'export default withLambda('));
        const poke = landmark(handler, 'triggerBlogDrain(');
        const drain = landmark(handler, 'await drainBlogJobs()');
        assert.ok(poke < drain, 'the drain runs in-process before the hand-off is even tried');
        // The in-process drain survives only as the fallback for a hand-off that could not start.
        assert.ok(/handedOff\s*\?\s*undefined\s*:\s*await drainBlogJobs\(\)|if \(await triggerBlogDrain\([\s\S]*?return[\s\S]*?\}\s*\n[\s\S]*await drainBlogJobs\(\)/.test(handler),
            'the in-process drain is not conditional on the hand-off failing');
    });
}

check('the scheduled handler honours the kill switch BEFORE handing off', () => {
    const handler = worker.slice(landmark(worker, 'export default withLambda('));
    assert.ok(landmark(handler, 'isGlobalAiDisabled()') < landmark(handler, 'triggerBlogDrain('),
        'a switched-off platform still spends a background invocation');
});

console.log('\na draft still being written is hidden from what people read');

const readSrc = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

check('the "still generating" condition is narrow', () => {
    const helper = readSrc('src/utils/blog-still-generating.ts');
    const cond = helper.slice(landmark(helper, 'export function notStillGenerating()'));
    // Every arm narrows it. Drop one and something the author should see disappears:
    assert.ok(cond.includes('${blogPosts.jobId} IS NOT NULL'), "an author's own blank post is hidden");
    assert.ok(cond.includes("${blogPosts.status} = 'pending_approval'"), 'a post past review can be hidden');
    // ⚠️ body_markdown is NOT NULL DEFAULT '' — IS NULL would match nothing and hide nothing.
    assert.ok(cond.includes("btrim(${blogPosts.bodyMarkdown}) = ''"), 'the empty-body test is missing or wrong');
    // Without this, an author who clears a FINISHED autopilot draft watches it vanish.
    assert.ok(/EXISTS \(SELECT 1 FROM content_generation_jobs j[\s\S]*j\.job_id = \$\{blogPosts\.jobId\}[\s\S]*'queued', 'processing'/.test(cond),
        "a finished job's emptied draft is hidden too");
    assert.ok(cond.includes('NOT ('), 'the condition keeps ONLY the generating drafts instead of hiding them');
});

check('the Blogs list (and the Review Queue it feeds) applies it', () => {
    const api = readSrc('netlify/functions/blog-posts.ts');
    const list = api.slice(landmark(api, 'const posts = await db'), landmark(api, '// ---- Delete ----'));
    assert.ok(list.includes('notStillGenerating(),'), 'the Blogs list shows a title-only draft mid-generation');
});

check("the assistant card's blog counts apply it", () => {
    // Otherwise "Awaiting Human Review" counts a draft no human can review yet.
    const card = readSrc('netlify/functions/get-assistants.ts');
    const q = card.slice(landmark(card, 'assistantId: blogPosts.assistantId,'), landmark(card, '.groupBy(blogPosts.assistantId, blogPosts.status)'));
    assert.ok(q.includes('notStillGenerating(),'), 'the card counts a draft that is still being written');
});

console.log(`\n${passed} checks passed.\n`);
