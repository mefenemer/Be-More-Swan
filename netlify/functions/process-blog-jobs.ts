// netlify/functions/process-blog-jobs.ts
// Blog Autopilot worker: drains the content_type='blog' half of content_generation_jobs, turning
// each queued job into a dated long-form draft sitting in the Blogs tab awaiting review.
//
// Separate from process-content-jobs.ts rather than a branch inside it, because the two share
// almost nothing past the queue table: no blueprint, no platform resolution, no media pipeline, no
// auto-publish decision, and a different result table. What they DO share is the queue, so both
// drains now filter on content_type — a blog job must never be claimed by the social worker (it
// would try to write a scheduled_post from a blueprint the job doesn't have), and vice versa.
//
// Per job: ideate a topic → insert the blog_posts row → generate the body → stamp the result.
// The row is inserted BEFORE generation because generateBlogBody writes into an existing post
// (that's the contract the interactive editor established, where the row exists from the moment
// the author clicks "New post"). A generation failure therefore leaves an empty-bodied draft; it
// is deleted on the final attempt so a failed slot doesn't litter the user's Blogs tab.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts, contentGenerationJobs } from '../../db/schema';
import { generateBlogBody } from '../../src/utils/blog-generate';
import { ideateBlogTopic } from '../../src/utils/blog-topic-ideation';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { createNotification } from '../../src/utils/notify';
import { withLambda } from '@netlify/aws-lambda-compat';

const BACKOFF_SECS = [30, 120, 300];
const BATCH = 5;

type BlogJobRow = {
    id: number; job_id: string; assistant_id: number; organisation_id: number;
    user_id: number; attempt: number; max_attempts: number;
    context_prompt: string | null; target_publish_date: string | null;
};

/**
 * Core queue drain: recover stuck jobs, claim up to BATCH queued blog jobs, generate each.
 * Returns the number of jobs claimed this pass.
 *
 * Exported for the same reason drainContentJobs is: Netlify runs scheduled functions ONLY on the
 * production deploy, so staging drives this over HTTP via run-blog-jobs.ts.
 */
export async function drainBlogJobs(): Promise<number> {
    const db = getDb();

    // Reset jobs stranded in 'processing' by a timed-out run. The window is wider than the social
    // worker's 3 minutes because a blog job makes two sequential model calls (ideation, then a
    // 2500-token draft) and a slow-but-live run must not be reclaimed underneath itself.
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = now()
         WHERE status = 'processing' AND content_type = 'blog'
           AND updated_at < now() - interval '10 minutes' AND attempt < max_attempts`
    );

    const jobs = await db.execute<BlogJobRow>(
        `SELECT id, job_id, assistant_id, organisation_id, user_id, attempt, max_attempts,
                context_prompt, target_publish_date
         FROM content_generation_jobs
         WHERE status = 'queued'
           AND content_type = 'blog'
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY created_at
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`
    );

    if (!jobs.length) return 0;

    // Sequential, unlike the social worker's Promise.allSettled: each job is two model calls, and a
    // parallel batch of those is the shape most likely to trip org-level AI rate limits.
    for (const job of jobs) {
        await processBlogJob(db, job).catch(err =>
            console.error(`[process-blog-jobs] job ${job.job_id} threw outside its handler`, err));
    }

    return jobs.length;
}

async function processBlogJob(db: ReturnType<typeof getDb>, job: BlogJobRow): Promise<void> {
    const attempt = job.attempt + 1;
    await db.update(contentGenerationJobs)
        .set({ status: 'processing', attempt, updatedAt: new Date() })
        .where(eq(contentGenerationJobs.id, job.id));

    // Track the row we create so a mid-flight failure can clean it up.
    let createdPostId: number | null = null;

    try {
        const [assistant] = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name })
            .from(aiAssistants)
            .where(and(
                eq(aiAssistants.id, job.assistant_id),
                eq(aiAssistants.organisationId, job.organisation_id),
            ))
            .limit(1);
        // The assistant was deleted (or moved org) after the job was enqueued — the slot is moot.
        if (!assistant) {
            await failJob(db, job, attempt, 'Assistant no longer exists.', { terminal: true });
            return;
        }

        const idea = await ideateBlogTopic(db, {
            assistantId: job.assistant_id,
            organisationId: job.organisation_id,
            userId: job.user_id,
        });
        // Ideation returns null when it can't ground a topic (no business context, no Inspo) or the
        // model reply was unusable. Retry rather than fail: the user may fill in their business
        // profile at any point, and an ungrounded post is worse than a skipped slot.
        if (!idea) {
            await failJob(db, job, attempt, 'Could not ground a topic for this slot.');
            return;
        }

        const targetDate = job.target_publish_date ? new Date(job.target_publish_date) : null;

        const [post] = await db.insert(blogPosts).values({
            organisationId: job.organisation_id,
            userId: job.user_id,
            assistantId: job.assistant_id,
            ownerLabel: `AI: ${assistant.name}`,
            title: idea.title,
            // Drafts land for review, never straight to 'scheduled'. Blog has no auto-publish path
            // (decideAutoPublish is post-shaped and social-gated), so review is the only route out.
            status: 'pending_approval',
            publishDate: targetDate,
            isAutonomous: true,
            generationReason: 'autopilot_schedule',
            jobId: job.job_id,
        }).returning({ id: blogPosts.id });
        createdPostId = post.id;

        await generateBlogBody(db, {
            blogPostId: post.id,
            organisationId: job.organisation_id,
            userId: job.user_id,
            topic: idea.topic,
            keywords: idea.keywords,
            notes: job.context_prompt ?? undefined,
        });

        await db.update(contentGenerationJobs)
            .set({ status: 'completed', resultBlogPostId: post.id, errorMessage: null, updatedAt: new Date() })
            .where(eq(contentGenerationJobs.id, job.id));

        await createNotification(db, 'blog_draft_ready', {
            userId: job.user_id,
            context: { assistant: { name: assistant.name }, post: { title: idea.title } },
            metadata: { assistantId: job.assistant_id, blogPostId: post.id },
        }).catch(err => console.error('[process-blog-jobs] notification failed', err));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[process-blog-jobs] job ${job.job_id} failed`, err);
        await failJob(db, job, attempt, message, { orphanPostId: createdPostId });
    }
}

/**
 * Record a failed attempt: schedule a backoff retry, or give up once attempts are exhausted.
 * On the final attempt any half-built draft is removed — an empty-bodied post in the Blogs tab
 * reads as a bug to the user, and the slot will simply be re-filled by the next horizon pass.
 */
async function failJob(
    db: ReturnType<typeof getDb>,
    job: BlogJobRow,
    attempt: number,
    message: string,
    opts: { terminal?: boolean; orphanPostId?: number | null } = {},
): Promise<void> {
    const exhausted = opts.terminal || attempt >= job.max_attempts;

    if (exhausted && opts.orphanPostId) {
        await db.delete(blogPosts)
            .where(and(
                eq(blogPosts.id, opts.orphanPostId),
                eq(blogPosts.organisationId, job.organisation_id),
            ))
            .catch(err => console.error('[process-blog-jobs] orphan cleanup failed', err));
    }

    if (exhausted) {
        await db.update(contentGenerationJobs)
            .set({ status: 'failed', errorMessage: message.slice(0, 1000), updatedAt: new Date() })
            .where(eq(contentGenerationJobs.id, job.id));
        return;
    }

    // A retry keeps its draft: the next attempt inserts a fresh row, so drop this one too rather
    // than leaving an empty post behind for every failed attempt.
    if (opts.orphanPostId) {
        await db.delete(blogPosts)
            .where(and(
                eq(blogPosts.id, opts.orphanPostId),
                eq(blogPosts.organisationId, job.organisation_id),
            ))
            .catch(err => console.error('[process-blog-jobs] retry cleanup failed', err));
    }

    const backoff = BACKOFF_SECS[Math.min(attempt - 1, BACKOFF_SECS.length - 1)];
    await db.update(contentGenerationJobs)
        .set({
            status: 'queued',
            errorMessage: message.slice(0, 1000),
            nextRetryAt: new Date(Date.now() + backoff * 1000),
            updatedAt: new Date(),
        })
        .where(eq(contentGenerationJobs.id, job.id));
}

export default withLambda(async () => {
    // Respect the global kill switch — this is an unattended, cost-incurring path.
    if (await isGlobalAiDisabled()) {
        return { statusCode: 200, body: JSON.stringify({ ran: false, reason: 'ai_disabled' }) };
    }
    const processed = await drainBlogJobs();
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, processed }),
    };
});
