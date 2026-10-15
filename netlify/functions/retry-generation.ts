// netlify/functions/retry-generation.ts
// "Try again" on a post or blog article that could not be written (the Activity tab, reached from
// the "Post generation failed" notification). tests/generation-failure.test.ts.
//
// POST { jobId }  → { ok: true, started: boolean }
//
// Puts the SAME job back in the queue — its assistant, brief, platform and cross-post group are
// unchanged — with a fresh set of attempts, and pokes the drain so it is written now rather than on
// the next ten-minute tick. Only a FAILED job of the caller's own organisation, from the last 30
// days. A job whose slot has already passed is re-queued without that slot, so the post becomes a
// draft to schedule rather than being stamped with a time that has gone.
//
// The worker still asks for task capacity before it writes (work-metering.ts), so a retry when the
// allowance is used up fails again with that reason — it never writes past the cap.

import { and, eq, gte } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { contentGenerationJobs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { triggerBlogDrain, triggerContentDrain } from '../../src/utils/trigger-drain';
import { explainGenerationFailure } from '../../src/utils/generation-failure';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const RETRY_WINDOW_DAYS = 30;
const JOB_ID_RE = /^[0-9a-f-]{8,64}$/i;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: { jobId?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const jobId = String(body.jobId || '');
    if (!JOB_ID_RE.test(jobId)) return json(400, { error: 'Which post?' });

    const since = new Date(Date.now() - RETRY_WINDOW_DAYS * 86_400_000);
    const [job] = await db.select().from(contentGenerationJobs).where(and(
        eq(contentGenerationJobs.jobId, jobId),
        eq(contentGenerationJobs.organisationId, ctx.organisationId),
        gte(contentGenerationJobs.createdAt, since),
    )).limit(1);
    if (!job) return json(404, { error: 'That post can no longer be retried — ask your assistant for a new one.' });
    if (job.status !== 'failed') return json(409, { error: job.status === 'completed' ? 'That post has already been written.' : 'That post is already being written.' });

    // Some failures cannot clear by trying again (a flagged brief, an empty allowance). Say so
    // rather than spending an attempt on a certain failure.
    const why = explainGenerationFailure(job.errorMessage, job.contentType === 'blog' ? 'article' : 'post');
    if (!why.canRetry) return json(409, { error: `${why.reason} ${why.action ?? ''}`.trim() });

    const slotPassed = job.targetPublishDate && new Date(job.targetPublishDate).getTime() < Date.now();
    const [requeued] = await db.update(contentGenerationJobs).set({
        status: 'queued', attempt: 0, nextRetryAt: null, errorMessage: null, updatedAt: new Date(),
        ...(slotPassed ? { targetPublishDate: null } : {}),
    }).where(and(eq(contentGenerationJobs.id, job.id), eq(contentGenerationJobs.status, 'failed'))).returning({ id: contentGenerationJobs.id });
    if (!requeued) return json(409, { error: 'That post is already being written.' });

    const headers = event.headers as Record<string, string | undefined>;
    const started = job.contentType === 'blog'
        ? await triggerBlogDrain(headers, job.jobId, 'retry-generation')
        : await triggerContentDrain(headers, job.jobId, 'retry-generation');
    return json(200, { ok: true, started });
});
