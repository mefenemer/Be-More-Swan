// tests/one-post-per-slot.test.ts
// A scheduled slot gets ONE post, however many jobs were queued for it.
//
// 2026-09-30 on PROD: requeuing the September outage backlog drafted ~30 posts per slot — 139 Review
// cards for Be More Swan over two weeks at 4 posts/week, and the same across four other customers.
// A failed job does not cover its slot, so while drafting was down the hourly gap-fill enqueued a
// fresh job every hour; ~30 accumulated per slot, and the requeue ran them all. Two guards now:
//   · process-content-jobs completes a scheduled job WITHOUT drafting when its slot already holds a
//     live post — whatever queued the job;
//   · the requeue script releases at most one job per slot, and none for a filled or queued slot.
//
// Run:  npx tsx tests/one-post-per-slot.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const drain = readFileSync(join(root, 'netlify/functions/process-content-jobs.ts'), 'utf8');
const requeue = readFileSync(join(root, 'scripts/requeue-failed-content-jobs.ts'), 'utf8');

const guardStart = drain.indexOf('── One post per SLOT');
const guard = drain.slice(guardStart, drain.indexOf('let consumedIdeaId', guardStart));

check('the drain has a slot guard', () => {
    assert.notStrictEqual(guardStart, -1, 'the slot guard is gone');
    assert.match(guard, /FROM scheduled_posts[\s\S]*assistant_id = \$\{Number\(job\.assistant_id\)\}/);
    assert.match(guard, /status IN \('draft','pending_approval','in_review','approved','scheduled'\)/,
        'only LIVE posts fill a slot — a rejected one must not block its replacement');
});

check('it compares the slot exactly as stored, never a re-serialised timestamp', () => {
    assert.match(guard, /publish_date = \(SELECT target_publish_date FROM content_generation_jobs WHERE id = \$\{job\.id\}\)/);
});

check('a filled slot completes the job without drafting, and says why', () => {
    assert.match(guard, /status = 'completed', result_post_id = \$\{existingId\}/);
    assert.match(guard, /Superseded: this slot already has a post/);
    assert.match(guard, /return;/);
});

check('it runs BEFORE any work: after the claim, before the idea claim and the model call', () => {
    const claim = drain.indexOf("SET status = 'processing', attempt = attempt + 1");
    const idea = drain.indexOf('let consumedIdeaId');
    const model = drain.indexOf('buildInspoBlock(db');
    assert.ok(claim < guardStart && guardStart < idea && idea < model,
        'a skipped job must not consume a queued idea or spend a model call');
});

check('scope: scheduled slot jobs only — revisions and the weekly Short are handled correctly', () => {
    assert.match(guard, /job\.trigger_type === 'scheduled' && job\.target_publish_date && job\.assistant_id && !job\.revised_from_post_id/,
        'a revision targets its rejected post\'s slot on purpose');
    assert.match(guard, /isShortJob = job\.platform === 'youtube' && !job\.crosspost_group_id/);
    assert.match(guard, /NOT \(platform = 'youtube' AND crosspost_group_id IS NULL\)/,
        'the Short shares the day\'s slot time on purpose — it must not cancel the cross-post, or vice versa');
});

check('the requeue releases one job per slot, and none for a filled or already-queued slot', () => {
    assert.match(requeue, /SELECT DISTINCT ON \(assistant_id, target_publish_date,\s*\(platform = 'youtube' AND crosspost_group_id IS NULL\)\)/);
    assert.match(requeue, /NOT EXISTS \(\s*SELECT 1 FROM scheduled_posts sp/);
    assert.match(requeue, /NOT EXISTS \(\s*SELECT 1 FROM content_generation_jobs q[\s\S]*q\.status IN \('queued','processing'\)/,
        'batched runs must not queue a second job behind the first');
});

// ── Blog: the same rule in the separate blog worker ──────────────────────────────────────────
const blog = readFileSync(join(root, 'netlify/functions/process-blog-jobs.ts'), 'utf8');
const bStart = blog.indexOf('── One post per SLOT');
const bGuard = blog.slice(bStart, blog.indexOf('const idea = await ideateBlogTopic', bStart));

check('blog: a scheduled job whose slot already holds a live blog post completes without drafting', () => {
    assert.notStrictEqual(bStart, -1, 'the blog slot guard is gone');
    assert.match(bGuard, /FROM blog_posts[\s\S]*assistant_id = \$\{job\.assistant_id\}/);
    assert.match(bGuard, /publish_date = \(SELECT target_publish_date FROM content_generation_jobs WHERE id = \$\{job\.id\}\)/);
    assert.match(bGuard, /status: 'completed', resultBlogPostId: existingId/);
    assert.match(bGuard, /\.catch\(/, 'must fail open');
});

check('blog: scheduled jobs only, own leftovers ignored, and it runs before ideation', () => {
    assert.match(bGuard, /job\.trigger_type === 'scheduled' && job\.target_publish_date/,
        'a campaign order (on_demand) asked for THIS article and must not be skipped');
    assert.match(bGuard, /job_id IS NULL OR job_id <> \$\{job\.job_id\}/,
        "this job's own half-written row from an earlier attempt must not count as the slot's post");
    assert.ok(bStart < blog.indexOf('const idea = await ideateBlogTopic'), 'before the model call');
    assert.match(blog, /context_prompt, target_publish_date, result_blog_post_id, created_at, trigger_type/,
        'trigger_type must be SELECTed, or the guard never fires');
});

console.log(`\n${passed} checks passed`);
