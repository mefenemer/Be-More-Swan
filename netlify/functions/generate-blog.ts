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
//   POST { blogPostId, topic, keywords?, notes?, tone? } → 202 { jobId, status, started }
//   GET  ?jobId=<uuid>                                   → 200 { status, resultBlogPostId, errorMessage }
//
// The job carries the blogPostId in `result_blog_post_id`, which is what tells the worker to draft
// into a post that already exists rather than ideate a topic and insert one — see
// src/utils/blog-interactive-brief.ts for why that column and not `trigger_type`.

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { blogPosts, contentGenerationJobs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { encodeInteractiveBrief } from '../../src/utils/blog-interactive-brief';
import { triggerBlogDrain } from '../../src/utils/trigger-drain';
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

    const id = Number(body.blogPostId);
    if (!Number.isFinite(id)) return { statusCode: 400, body: JSON.stringify({ error: 'blogPostId is required.' }) };

    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    if (!topic) return { statusCode: 400, body: JSON.stringify({ error: 'Add a topic to draft from.' }) };

    // Ownership is settled HERE, while there is still someone to tell. The worker re-checks by
    // org-scoping its write, but it runs minutes later with no way to answer the browser — and this
    // is the request that decides whose post a queued job is allowed to overwrite.
    const [post] = await db
        .select({ id: blogPosts.id, assistantId: blogPosts.assistantId })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, id), eq(blogPosts.organisationId, organisationId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

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
