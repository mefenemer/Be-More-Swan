// netlify/functions/generate-blog.ts
// Autonomous Content Engine — US 1.1: draft a full blog post in the assistant's voice.
//
// This is the INTERACTIVE entry point for Blog Studio's "Ask your assistant to draft". It does NOT
// generate the post: it enqueues the work and answers immediately.
//
// ⚠️ WHY IT NO LONGER GENERATES IN-REQUEST. It used to call generateBlogBody() and return the body,
// and in production that could never work. A draft is a 6,000-token model call plus KB retrieval, a
// blueprint compile and up to three stock-image lookups — 30 to 60 seconds — inside a synchronous
// Netlify function, which is capped at 10 seconds by default and at 26 seconds even with a raise in
// netlify.toml. The invocation was killed mid-flight every time and returned a raw 502 with no JSON
// body, so the draft was never written and the button simply hung. It only ever appeared to work
// under `netlify dev`, which does not enforce the limit. Blog Autopilot was unaffected because its
// worker runs as a scheduled function, on a far longer budget — the same worker this now uses.
//
// The shape mirrors generate-post.ts, the social twin, deliberately:
//   POST { blogPostId, topic, keywords?, notes?, tone?, articleType? } → 202 { jobId, status, started }
//   POST { blogPostId, resize: 'shorter'|'longer' }      → 202 { jobId, … } — "Make it shorter/longer"
//        (src/utils/blog-resize.ts): rewrites the saved body to a new length; metered as a helper,
//        like the social post editor's same two buttons.
//   GET  ?jobId=<uuid>                                   → 200 { status, resultBlogPostId, errorMessage }
//
// The job carries the blogPostId in `result_blog_post_id`, which is what tells the worker to draft
// into a post that already exists rather than ideate a topic and insert one — see
// src/utils/blog-interactive-brief.ts for why that column and not `trigger_type`.

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { aiAssistants, blogPosts, contentGenerationJobs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { encodeInteractiveBrief } from '../../src/utils/blog-interactive-brief';
import { BLOG_BATCH_PROPOSAL_TYPE, blogBatchFromUiElement } from '../../src/utils/blog-chat-batch';
import { triggerBlogDrain } from '../../src/utils/trigger-drain';
import { meterInteraction } from '../../src/utils/task-credit';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Matches generate-post.ts. A queue this deep is a stuck worker, not a busy user. */
const MAX_PENDING_JOBS = 50;

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    // ── GET: poll job status ────────────────────────────────────────────────────────────────────
    // Org-scoped, so a job id from another tenant reads as "not found" rather than leaking status.
    if (event.httpMethod === 'GET') {
        const jobId = event.queryStringParameters?.jobId;
        if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId required.' }) };

        const [job] = await db
            .select({
                status: contentGenerationJobs.status,
                resultBlogPostId: contentGenerationJobs.resultBlogPostId,
                errorMessage: contentGenerationJobs.errorMessage,
            })
            .from(contentGenerationJobs)
            .where(and(
                eq(contentGenerationJobs.jobId, jobId),
                eq(contentGenerationJobs.organisationId, organisationId),
            ))
            .limit(1);

        if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(job),
        };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Checked before the row is written, not after: a job enqueued while AI is off would sit in the
    // queue and run the moment it came back, hours later, into an editor nobody has open.
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    // ── Several articles at once: the Blog Writer chat's "Write all N" card (owner, 2026-10-27) ──
    //   POST { assistantId, batch: [{ title, brief? }, …] } → 202 { queued, jobIds }
    // One blog_posts row and one job per article, through the SAME interactive path as Blog Studio's
    // draft button (result_blog_post_id pre-set, so the worker drafts into the row and never ideates).
    // The row is stamped with its job and parked in pending_approval with an empty body, which is
    // exactly what notStillGenerating() hides — so nobody opens an empty page while it is written,
    // and it appears in Review the moment its body lands. Each article is a task, charged by the
    // worker when it runs, as for any other draft.
    if (Array.isArray(body.batch)) {
        const assistantId = Number(body.assistantId);
        if (!Number.isInteger(assistantId)) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
        const card = blogBatchFromUiElement({ type: BLOG_BATCH_PROPOSAL_TYPE, topics: body.batch });
        if (!card) return { statusCode: 400, body: JSON.stringify({ error: 'Add at least one article title.' }) };
        const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
            .limit(1);
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        try {
            const [{ jobCount }] = await db.execute<{ jobCount: number }>(
                `SELECT COUNT(*)::int AS "jobCount" FROM content_generation_jobs
                 WHERE organisation_id = ${organisationId} AND status IN ('queued','processing')`
            );
            if (jobCount + card.topics.length > MAX_PENDING_JOBS) {
                return { statusCode: 429, body: JSON.stringify({ error: 'Too many drafts are already being written. Please wait for them to finish.' }) };
            }
            const jobIds: string[] = [];
            for (const t of card.topics) {
                const jobId = randomUUID();
                const [post] = await db.insert(blogPosts).values({
                    organisationId,
                    userId,
                    assistantId: assistant.id,
                    ownerLabel: `AI: ${assistant.name}`,
                    title: t.title,
                    status: 'pending_approval',
                    isAutonomous: false,
                    generationReason: 'chat_request',
                    jobId,
                }).returning({ id: blogPosts.id });
                await db.insert(contentGenerationJobs).values({
                    jobId,
                    assistantId: assistant.id,
                    organisationId,
                    userId,
                    status: 'queued',
                    attempt: 0,
                    maxAttempts: 3,
                    triggerType: 'on_demand',
                    contentType: 'blog',
                    contextPrompt: encodeInteractiveBrief({ topic: t.title, notes: t.brief ?? undefined }),
                    resultBlogPostId: post.id,
                });
                jobIds.push(jobId);
            }
            const started = await triggerBlogDrain(
                event.headers as Record<string, string | undefined>, jobIds[0], 'generate-blog-batch');
            console.log(`[generate-blog] queued a batch of ${jobIds.length} for assistant ${assistant.id} (org ${organisationId}), drain started=${started}`);
            return {
                statusCode: 202,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ queued: jobIds.length, jobIds, started }),
            };
        } catch (error) {
            console.error('[generate-blog] could not queue the batch:', error, (error as { cause?: unknown })?.cause ?? '');
            return { statusCode: 500, body: JSON.stringify({ error: 'Could not start those drafts. Please try again.' }) };
        }
    }

    const id = Number(body.blogPostId);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'blogPostId is required.' }) };

    const resize = body.resize === 'shorter' || body.resize === 'longer' ? body.resize as 'shorter' | 'longer' : undefined;
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    if (!topic && !resize) return { statusCode: 400, body: JSON.stringify({ error: 'Add a topic to draft from.' }) };

    // Ownership is settled HERE, while there is still someone to tell. The worker re-checks by
    // org-scoping its write, but it runs minutes later with no way to answer the browser — and this
    // is the request that decides whose post a queued job is allowed to overwrite.
    const [post] = await db
        .select({ id: blogPosts.id, assistantId: blogPosts.assistantId, status: blogPosts.status })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
    // A live article is not rewritten underneath its readers: the new body would sit in the editor
    // while the published copy stayed as it was. Take it off the site first.
    if (resize && (post.status === 'published' || post.status === 'publishing')) {
        return { statusCode: 409, body: JSON.stringify({ error: 'This article is live. Unpublish it first, then make it shorter or longer.' }) };
    }

    // Shorter / Longer cost what the social editor's same buttons cost: a helper, under fair use —
    // not a task, which is what a whole new article is charged. Settled here, while there is
    // someone to tell; the worker skips the task check for these.
    if (resize) {
        const credit = await meterInteraction(db, organisationId, 'helpers');
        if (!credit.allowed) {
            const code = credit.failed ? 503 : credit.fairUse ? 429 : 403;
            return { statusCode: code, body: JSON.stringify({ error: credit.limitMessage }) };
        }
    }

    // ⚠️ EVERYTHING BELOW IS WRAPPED. The first version of this handler was not, and an unhandled
    // throw here does NOT reach the browser as { error }: Lambda answers 500 with its own
    // { errorType, errorMessage } shape, which has no `error` key, so the Studio fell through to its
    // bare "Draft failed — try again." with the real cause visible nowhere. A queue write that fails
    // must say so in the logs and send a sentence a human can act on.
    try {
        const [{ jobCount }] = await db.execute<{ jobCount: number }>(
            `SELECT COUNT(*)::int AS "jobCount" FROM content_generation_jobs
             WHERE organisation_id = ${organisationId} AND status IN ('queued','processing')`
        );
        if (jobCount >= MAX_PENDING_JOBS) {
            return { statusCode: 429, body: JSON.stringify({ error: 'Too many jobs are already running. Please wait for them to finish.' }) };
        }

        const jobId = randomUUID();

        await db.insert(contentGenerationJobs).values({
        jobId,
        // No blueprintId: blog drafting doesn't read one (see blog-gap-fill.ts).
        assistantId: post.assistantId,
        organisationId,
        userId,
        status: 'queued',
        attempt: 0,
        maxAttempts: 3,
        triggerType: 'on_demand',
        contentType: 'blog',
        contextPrompt: encodeInteractiveBrief({
            topic,
            keywords: typeof body.keywords === 'string' ? body.keywords : undefined,
            notes: typeof body.notes === 'string' ? body.notes : undefined,
            tone: typeof body.tone === 'string' ? body.tone : undefined,
            // Blog Studio's "Type of article" — validated where it is used (articleTypeByKey).
            articleType: typeof body.articleType === 'string' ? body.articleType : undefined,
            resize,
        }),
        // ⚠️ THE DISCRIMINATOR. Pre-set to the post already open in the editor, which is what tells
        // process-blog-jobs to draft into it rather than insert a second one.
        resultBlogPostId: post.id,
    });

        // Someone is watching this one, so start the drain rather than leaving it for the ten-minute
        // cron. Best-effort: a failed poke leaves the job queued and the cron picks it up, which is
        // why the answer says which of the two happened instead of letting the UI guess.
        const started = await triggerBlogDrain(
            event.headers as Record<string, string | undefined>, jobId, 'generate-blog');

        console.log(`[generate-blog] queued ${jobId} for post ${post.id} (org ${organisationId}), drain started=${started}`);

        return {
            statusCode: 202,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, status: 'queued', started }),
        };
    } catch (error) {
        // Log the CAUSE as well as the error: a postgres-js failure reports a generic "Failed query"
        // and puts the real message (a missing column, a violated constraint) on `cause`.
        console.error('[generate-blog] could not queue the draft:', error,
            (error as { cause?: unknown })?.cause ?? '');
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Could not start the draft. Please try again — if it keeps happening, the queue write is failing.' }),
        };
    }
});
