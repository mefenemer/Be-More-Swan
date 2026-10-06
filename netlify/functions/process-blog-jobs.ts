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
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { generateBlogSeo } from '../../src/utils/blog-seo-generate';
import { aiAssistants, blogPosts, contentGenerationJobs } from '../../db/schema';
import { generateBlogBody } from '../../src/utils/blog-generate';
import { decodeInteractiveBrief } from '../../src/utils/blog-interactive-brief';
import { ideateBlogTopic } from '../../src/utils/blog-topic-ideation';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { triggerBlogDrain } from '../../src/utils/trigger-drain';
import { createNotification } from '../../src/utils/notify';
import { fireOrchestrations } from '../../src/utils/orchestration';
import { withLambda } from '@netlify/aws-lambda-compat';
import { isUpstreamBlocked } from '../../src/lib/ai-gateway';

const BACKOFF_SECS = [30, 120, 300];
/**
 * How long a blog job waits out a failure at OUR end, and how long it will wait in total.
 *
 * ⚠️ This worker had none of the social worker's outage protections, and the September credit outage
 * showed what that costs: 36 jobs across three organisations failed, every one of them reported to
 * the customer as "Could not ground a topic for this slot." — blaming their business profile for our
 * unpaid bill. All three had a business description and a target audience.
 *
 * Fifteen minutes because there is nothing to learn by asking a refusing API sooner; 72 hours because
 * a revoked key never comes back and a job that can never run has to say so eventually. Same numbers
 * as process-content-jobs, deliberately — two workers with two waiting policies is two things to
 * reason about during an incident.
 */
const PARK_RETRY_MINS = 15;
const PARK_MAX_HOURS = 72;
const BATCH = 5;

/**
 * A row an autopilot attempt inserted but never finished: a title and no body.
 *
 * ⚠️ The post row is inserted BEFORE the body is drafted (generateBlogBody writes into an existing
 * row), so every attempt that dies between the two leaves one of these behind. failJob removes it
 * when the attempt fails in-process — but a run the platform KILLS mid-draft never reaches its catch,
 * and that is the ordinary way a 30–60s draft ends inside a time-limited function. Those are the
 * "blog with a title and no content" reports.
 *
 * Scoped tightly on purpose: only rows still awaiting review, with no body at all. A draft someone
 * has since written into, approved or published is never touched — and an interactive draft is
 * never matched, because the author's post is not stamped with the job's id.
 */
const EMPTY_AUTOPILOT_DRAFT =
    `bp.status = 'pending_approval' AND (bp.body_markdown IS NULL OR btrim(bp.body_markdown) = '')`;

const INTERRUPTED_GIVE_UP =
    'The draft was interrupted before it could be written, too many times to keep trying. '
    + 'The next scheduled post will be written normally.';

type BlogJobRow = {
    id: number; job_id: string; assistant_id: number; organisation_id: number;
    user_id: number; attempt: number; max_attempts: number;
    context_prompt: string | null; target_publish_date: string | null; created_at: string;
    trigger_type: string | null;
    // Pre-set by generate-blog.ts to the post already open in Blog Studio. NULL for every
    // autopilot/campaign job, which ideate a topic and insert their own row. See the branch in
    // processBlogJob and src/utils/blog-interactive-brief.ts.
    result_blog_post_id: number | null;
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

    // ...and settle the ones that were killed on their LAST attempt. The reset above skips them, so
    // before this they sat in 'processing' forever — and the title-only post their final attempt
    // inserted sat in the Blogs tab with them, looking like a real draft. A run killed mid-draft never
    // reaches its catch, so failJob's cleanup cannot be what removes it; this is.
    await db.execute(
        `WITH dead AS (
             UPDATE content_generation_jobs
             SET status = 'failed', error_message = '${INTERRUPTED_GIVE_UP}', updated_at = now()
             WHERE status = 'processing' AND content_type = 'blog'
               AND updated_at < now() - interval '10 minutes' AND attempt >= max_attempts
             RETURNING job_id, organisation_id
         )
         DELETE FROM blog_posts bp USING dead
         WHERE bp.job_id = dead.job_id AND bp.organisation_id = dead.organisation_id
           AND ${EMPTY_AUTOPILOT_DRAFT}`
    );

    const jobs = await db.execute<BlogJobRow>(
        `SELECT id, job_id, assistant_id, organisation_id, user_id, attempt, max_attempts,
                context_prompt, target_publish_date, result_blog_post_id, created_at, trigger_type
         FROM content_generation_jobs
         WHERE status = 'queued'
           AND content_type = 'blog'
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY created_at
         LIMIT ${BATCH}
         -- Retained as a cheap first filter under real concurrent load, but it is NOT what makes
         -- this safe: these locks die at autocommit, before any job runs. The status-guarded claim
         -- in processBlogJob is the guarantee. See the note there before changing either.
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
    // Claim the job ATOMICALLY. `AND status = 'queued'` is the whole guard — the SELECT in
    // drainBlogJobs uses FOR UPDATE SKIP LOCKED, but it runs as a standalone statement, so
    // postgres-js autocommits and those row locks are gone before the first job is touched. Two
    // overlapping drains therefore claim the SAME rows.
    //
    // Measured on prod 2026-08-18 (assistant 6, Lyra): five jobs produced NINE blog posts. Job
    // aa86c6a5 was already flipped to 'processing' when the second drain ran its SELECT, so it made
    // one post; the other four were still 'queued' and made two each — three of them empty-bodied,
    // sitting in the Blogs tab looking like real drafts. Every one reported attempt = 1, because
    // both drains read attempt 0 and both wrote 1, so the counter hid the double-run as well.
    //
    // Same claim-then-verify shape as publish-blog-posts.ts, which had it right all along.
    const [claimed] = await db.update(contentGenerationJobs)
        .set({
            status: 'processing',
            // Incremented in SQL, not from the SELECTed value: two racers computing job.attempt + 1
            // both write the same number, so the count silently under-reports.
            attempt: sql`${contentGenerationJobs.attempt} + 1`,
            updatedAt: new Date(),
        })
        .where(and(
            eq(contentGenerationJobs.id, job.id),
            eq(contentGenerationJobs.status, 'queued'),
        ))
        .returning({ attempt: contentGenerationJobs.attempt });

    // Lost the race — the other drain owns this job and will complete it, fail it, or leave it to
    // the stuck-job reclaim above. Doing nothing is the only safe move: this invocation must not
    // write a second post for the same slot.
    if (!claimed) return;
    const attempt = claimed.attempt;

    // Track the row we create so a mid-flight failure can clean it up.
    let createdPostId: number | null = null;

    // Which of the two shapes this job is. An INTERACTIVE job (Blog Studio's "Ask your assistant to
    // draft") arrives with result_blog_post_id ALREADY set, naming the post open in the author's
    // editor: it has a human brief, it must not ideate a topic, and above all it must not insert a
    // second post — the author is looking at the one it is writing into.
    //
    // ⚠️ result_blog_post_id is the discriminator and `trigger_type` is NOT: campaign orders enqueue
    // blog jobs as 'on_demand' as well, and those take the autopilot path. See
    // src/utils/blog-interactive-brief.ts.
    const interactive = job.result_blog_post_id != null;

    // Set with the 'completed' write. Everything after that point is a follow-up — a notification, a
    // hand-off — and a failure there must not re-queue a job whose post is already written: the
    // retry would draft the article a second time. Same fault, and the same latch, as
    // process-content-jobs.ts (one job wrote eight posts on prod, 2026-09-03).
    let jobCompleted = false;

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
        // An interactive draft survives it: Blog Studio can be opened on a post with no Blog Writer
        // at all, and the author asking for a draft is not asking about an assistant. Voice simply
        // falls back to the tone on the brief.
        if (!assistant && !interactive) {
            await failJob(db, job, attempt, 'Assistant no longer exists.', { terminal: true });
            return;
        }

        // What to write, and where. The two shapes converge on ONE generateBlogBody call below —
        // deliberately, so voice, grounding, Inspo and provenance cannot drift between the button
        // an author presses and the schedule that runs overnight.
        let targetPostId: number;
        let postTitle: string;
        let topic: string | undefined;
        let keywords: string | undefined;
        let notes: string | undefined;
        let tone: string | undefined;
        let articleType: string | undefined;

        if (interactive) {
            // The author's own words. A brief that won't decode costs the steer, not the draft —
            // generateBlogBody falls back to the post's stored title.
            const brief = decodeInteractiveBrief(job.context_prompt);
            targetPostId = job.result_blog_post_id as number;
            postTitle = brief?.topic ?? '';
            topic = brief?.topic;
            keywords = brief?.keywords;
            notes = brief?.notes;
            tone = brief?.tone;
            articleType = brief?.articleType;
            // NOTE: createdPostId stays null on this path, and that is load-bearing. failJob()
            // DELETES the post it is given, which is right for a half-built autopilot draft and
            // catastrophic here — it is the post the author has open.
        } else {
            // ── One post per SLOT (same rule as process-content-jobs.ts) ──────────────────────────
            // A failed job does not cover its slot, so while drafting was down the daily horizon fill
            // enqueued a fresh one every day; requeuing that backlog on 2026-09-30 drafted every one
            // of them onto the same slots. A scheduled job whose slot already holds a live post
            // completes without drafting — before ideation, so a skipped duplicate costs no model
            // call. Scheduled jobs only: a campaign order ('on_demand') asked for THIS article, and
            // an interactive job never reaches this branch. Fails OPEN: a lookup error drafts as
            // before rather than stopping blog drafting for everyone. The slot is read back from the
            // job row so no timestamp is re-serialised in JS.
            if (job.trigger_type === 'scheduled' && job.target_publish_date) {
                const occupied = await db.execute<{ id: number }>(sql`
                    SELECT id FROM blog_posts
                     WHERE assistant_id = ${job.assistant_id}
                       AND publish_date = (SELECT target_publish_date FROM content_generation_jobs WHERE id = ${job.id})
                       AND status IN ('draft','pending_approval','in_review','approved','scheduled','publishing')
                       AND (job_id IS NULL OR job_id <> ${job.job_id})
                     ORDER BY id LIMIT 1`).catch((err) => {
                    console.error(`[process-blog-jobs] slot guard lookup failed for job ${job.job_id} — drafting anyway:`, err);
                    return [] as { id: number }[];
                });
                if (occupied.length) {
                    const existingId = Number(occupied[0].id);
                    console.warn(`[process-blog-jobs] job ${job.job_id}: slot already holds blog post ${existingId} — completing without drafting a duplicate.`);
                    await db.update(contentGenerationJobs)
                        .set({
                            status: 'completed', resultBlogPostId: existingId,
                            errorMessage: `Superseded: this slot already has a blog post (${existingId}).`,
                            updatedAt: new Date(),
                        })
                        .where(eq(contentGenerationJobs.id, job.id));
                    return;
                }
            }

            const idea = await ideateBlogTopic(db, {
                assistantId: job.assistant_id,
                organisationId: job.organisation_id,
                userId: job.user_id,
                slot: job.target_publish_date,
                guidance: job.context_prompt,
            });
            // Ideation returns null when it can't ground a topic (no business context, no Inspo) or
            // the model reply was unusable. Retry rather than fail: the user may fill in their
            // business profile at any point, and an ungrounded post is worse than a skipped slot.
            if (!idea) {
                await failJob(db, job, attempt, 'Could not ground a topic for this slot.');
                return;
            }

            // Clear what an earlier attempt of THIS job left behind if it was killed mid-draft: it
            // never reached failJob, so its title-only row is still there, and this attempt is about
            // to insert another. Without this, one job killed three times left three empty posts.
            await db.execute(sql`DELETE FROM blog_posts bp
                WHERE bp.job_id = ${job.job_id} AND bp.organisation_id = ${job.organisation_id}
                  AND ${sql.raw(EMPTY_AUTOPILOT_DRAFT)}`);

            const targetDate = job.target_publish_date ? new Date(job.target_publish_date) : null;

            const [post] = await db.insert(blogPosts).values({
                organisationId: job.organisation_id,
                userId: job.user_id,
                assistantId: job.assistant_id,
                ownerLabel: `AI: ${assistant.name}`,
                title: idea.title,
                // Drafts land for review, never straight to 'scheduled'. Blog has no auto-publish
                // path (decideAutoPublish is post-shaped and social-gated), so review is the only
                // route out.
                status: 'pending_approval',
                publishDate: targetDate,
                isAutonomous: true,
                generationReason: 'autopilot_schedule',
                jobId: job.job_id,
            }).returning({ id: blogPosts.id });
            createdPostId = post.id;

            targetPostId = post.id;
            postTitle = idea.title;
            topic = idea.topic;
            keywords = idea.keywords;
            notes = job.context_prompt ?? undefined;
        }

        await generateBlogBody(db, {
            blogPostId: targetPostId,
            organisationId: job.organisation_id,
            userId: job.user_id,
            topic,
            keywords,
            notes,
            tone,
            articleType,
        });

        // SEO, while the body is fresh. This used to be reachable ONLY from Blog Studio's
        // "Generate SEO" button, so every unattended draft sat with no search title, no description,
        // no tags and no slug until a human opened it and clicked — and a post that publishes
        // without metadata is precisely what a Blog Writer is for.
        //
        // Best-effort by design: the body is the expensive artifact and it is already saved. A
        // metadata failure must not fail the job, because the retry would redraft the whole post to
        // fix a title tag. The button stays as "Regenerate SEO" for exactly this case, and for
        // re-running after an edit.
        //
        // Every assistant-written draft, interactive ones included. They used to skip it — the author
        // was waiting in Blog Studio — which meant a post the assistant wrote arrived without the
        // search title and description, and the author had to know to press "Generate SEO". It is
        // one fast (Haiku) call in a background worker the Studio is already polling, and Blog
        // Studio shows the result as soon as the draft lands (applyAiDraft → populateSeo).
        try {
            await generateBlogSeo(db, {
                blogPostId: targetPostId,
                organisationId: job.organisation_id,
                userId: job.user_id,
            });
        } catch (err) {
            console.warn(`[process-blog-jobs] SEO generation failed for post ${targetPostId} (draft kept)`,
                err instanceof Error ? err.message : err);
        }

        await db.update(contentGenerationJobs)
            .set({ status: 'completed', resultBlogPostId: targetPostId, errorMessage: null, updatedAt: new Date() })
            .where(eq(contentGenerationJobs.id, job.id));
        // The body is written and the job is settled. Nothing below may re-queue it.
        jobCompleted = true;

        // Autopilot's follow-ups. An interactive draft wants neither: the author is looking at the
        // post, so a "your draft is ready" notification is noise, and a hand-off on 'drafts_a_post'
        // would set other assistants working off an article its author has not even read yet. This
        // matches what the button did when it generated in-request, which fired neither.
        if (!interactive) {
            await createNotification(db, 'blog_draft_ready', {
                userId: job.user_id,
                context: { assistant: { name: assistant?.name ?? '' }, post: { title: postTitle } },
                metadata: { assistantId: job.assistant_id, blogPostId: targetPostId },
            }).catch(err => console.error('[process-blog-jobs] notification failed', err));

            // Cross-assistant hand-off on the drafting seam, mirroring process-content-jobs.ts. The
            // publish-side counterpart lives in blog-publish.ts. Never throws by contract.
            await fireOrchestrations(db, {
                sourceAssistantId: job.assistant_id,
                orgId: job.organisation_id,
                userId: job.user_id,
                event: 'drafts_a_post',
                sourcePostId: targetPostId,
                sourceCaption: postTitle,
            });
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[process-blog-jobs] job ${job.job_id} failed`, err);
        // A throw AFTER the job completed is a failed follow-up, not a failed draft. Re-queuing here
        // is what let one content job write eight posts on prod (2026-09-03): the retry regenerates
        // an article that already exists, and on the interactive path it would overwrite the draft
        // under the author's cursor.
        if (jobCompleted) {
            console.error(`[process-blog-jobs] job ${job.job_id} completed but a follow-up threw — not re-queued`);
            return;
        }
        // ── A failure at OUR end must not spend the customer's attempts ────────────────────────
        //
        // Asked BEFORE failJob, because below it the job is already on its way to terminal: three
        // attempts against an API that cannot answer take minutes, and a failed blog job is as
        // unrecoverable as a failed social one was — nothing requeues it.
        //
        // ⚠️ Routed through failJob rather than written here, so the half-built draft is cleaned up
        // exactly as it is on an ordinary retry. Parking without that would leave an empty post row
        // per attempt, and a 72-hour outage would fill the Blogs tab with them.
        if (isUpstreamBlocked(err)) {
            const ageHours = job.created_at
                ? (Date.now() - new Date(job.created_at).getTime()) / 3_600_000
                : 0;
            if (ageHours < PARK_MAX_HOURS) {
                console.error(`[process-blog-jobs] job ${job.job_id} PARKED (${ageHours.toFixed(1)}h old) — `
                    + `the AI provider is refusing our calls, so this attempt does not count: ${message.slice(0, 200)}`);
                await failJob(db, job, attempt, message, { orphanPostId: createdPostId, park: true });
                return;
            }
            // Past the ceiling it gives up for real — and says whose fault it was, rather than
            // blaming a business profile that was never the problem.
            await failJob(db, job, attempt, UPSTREAM_GIVE_UP, { orphanPostId: createdPostId, terminal: true });
            return;
        }
        await failJob(db, job, attempt, message, { orphanPostId: createdPostId });
    }
}

/**
 * What a customer is told when an outage at our end finally defeats a blog slot.
 *
 * ⚠️ Deliberately not "Could not ground a topic for this slot." That sentence names the one cause the
 * reader can act on, so when it is wrong it sends them to edit a business profile that was never the
 * problem. It was wrong 36 times in September.
 */
const UPSTREAM_GIVE_UP =
    'Our writing service was unavailable for too long to draft this one — this is at our end, not '
    + 'yours, and nothing about your setup needs changing. The next scheduled post will be written '
    + 'normally.';

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
    opts: { terminal?: boolean; orphanPostId?: number | null; park?: boolean } = {},
): Promise<void> {
    // ⚠️ A park is never exhausted, whatever the attempt count says — that is the whole point of it.
    const exhausted = !opts.park && (opts.terminal || attempt >= job.max_attempts);

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

    const backoff = opts.park
        ? PARK_RETRY_MINS * 60
        : BACKOFF_SECS[Math.min(attempt - 1, BACKOFF_SECS.length - 1)];
    await db.update(contentGenerationJobs)
        .set({
            status: 'queued',
            errorMessage: message.slice(0, 1000),
            nextRetryAt: new Date(Date.now() + backoff * 1000),
            // ⚠️ A parked attempt is GIVEN BACK. A failure that is ours is not evidence that this job
            // is bad, and the customer's three attempts exist for jobs that are.
            ...(opts.park ? { attempt: Math.max(0, attempt - 1) } : {}),
            updatedAt: new Date(),
        })
        .where(eq(contentGenerationJobs.id, job.id));
}

/**
 * The ten-minute cron. It STARTS the drain in run-blog-jobs-background rather than running it here.
 *
 * ⚠️ A scheduled function runs on a time budget measured in seconds, and one blog draft is a 30–60s
 * model call — five of them, sequentially, per batch. Drained here, a run was killed mid-draft as a
 * matter of course: the job stranded in 'processing' until the ten-minute reclaim, and the title-only
 * post the killed attempt had inserted sat in the Blogs tab (prod orgs 37 and 40, see EMPTY_AUTOPILOT_DRAFT).
 * The `-background` function gets fifteen minutes, which fits a full batch several times over.
 *
 * Same move dispatch-discovery-runs made for the same reason. The drain is safe to overlap with a
 * poke from generate-blog: the status-guarded claim in processBlogJob is what makes it so.
 */
export default withLambda(async () => {
    // Respect the global kill switch — this is an unattended, cost-incurring path. Checked here as
    // well as in the background function, so a switched-off platform does not spend an invocation.
    if (await isGlobalAiDisabled()) {
        return { statusCode: 200, body: JSON.stringify({ ran: false, reason: 'ai_disabled' }) };
    }

    // No request headers on a cron, so the target resolves from BASE_URL — as publish-blog-posts'
    // does on the same schedule.
    if (await triggerBlogDrain(undefined, 'cron', 'process-blog-jobs')) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ran: true, handedOff: true }),
        };
    }

    // The hand-off could not be started (no CRON_TRIGGER_SECRET, no base URL, or the invoke was
    // refused). Drain here rather than not at all: a run that is killed part-way still finishes the
    // jobs it reached, and the orphan cleanup above means a killed attempt no longer leaves a
    // title-only post behind. Logged, because this is the slow path and it should not be the usual one.
    console.warn('[process-blog-jobs] background drain not started — draining in-process, and a long batch may be cut short.');
    const processed = await drainBlogJobs();
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, handedOff: false, processed }),
    };
});
