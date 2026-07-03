// netlify/functions/generate-post.ts
// US-SMM-3.1.1 + US-SMM-3.4.1: Accept a POST from the workspace, insert a generation job, return <500ms.
// GET ?jobId=<uuid> polls status for on-demand generation.

import { Handler } from '@netlify/functions';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { aiBlueprints, aiAssistants, contentGenerationJobs, notifications } from '../../db/schema';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { requireTenant } from '../../src/utils/tenant';
import { assembleBlueprint } from '../../src/utils/blueprint';

export const handler: Handler = async (event) => {
    const db = getDb();
    // Resolve the active org from the session. NOTE: the JWT carries `activeOrganisationId`,
    // not `organisationId` — reading the latter directly yields undefined and crashes the
    // downstream SQL (502). requireTenant() resolves it correctly (matches the rest of the app).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    // ── GET: poll job status ────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const jobId = event.queryStringParameters?.jobId;
        if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId required.' }) };

        const [job] = await db
            .select({
                status: contentGenerationJobs.status,
                resultPostId: contentGenerationJobs.resultPostId,
                errorMessage: contentGenerationJobs.errorMessage,
            })
            .from(contentGenerationJobs)
            .where(and(eq(contentGenerationJobs.jobId, jobId), eq(contentGenerationJobs.organisationId, organisationId)))
            .limit(1);

        if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(job),
        };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: {
        blueprintId?: number;
        assistantId?: number;
        contextPrompt?: string;
        platform?: string;
        triggerType?: string;
    };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const {
        blueprintId,
        assistantId,
        contextPrompt,
        platform,
        triggerType = 'scheduled',
    } = body;

    if (!assistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    }

    if (contextPrompt && contextPrompt.length > 500) {
        return { statusCode: 400, body: JSON.stringify({ error: 'contextPrompt must be 500 characters or fewer.' }) };
    }

    // US2: hard-block severe-violation prompts before generation (AC2.1–2.3).
    if (contextPrompt) {
        const modBlock = await enforcePromptModeration({ text: contextPrompt, userId, organisationId, source: 'generate-post' });
        if (modBlock) return modBlock;
    }

    // Verify assistant belongs to this org
    const [asst] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
        .limit(1);
    if (!asst) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    // Resolve blueprint: use provided blueprintId or fall back to latest for this assistant
    const bpQuery = db
        .select({ id: aiBlueprints.id, missingFields: aiBlueprints.missingFields })
        .from(aiBlueprints)
        .where(blueprintId
            ? and(eq(aiBlueprints.id, blueprintId), eq(aiBlueprints.organisationId, organisationId))
            : and(eq(aiBlueprints.assistantId, assistantId), eq(aiBlueprints.organisationId, organisationId))
        )
        .orderBy(desc(aiBlueprints.compiledAt))
        .limit(1);

    let [bp] = await bpQuery;

    // Self-serve assistants are never compiled by the admin Blueprint tool, so on their first
    // on-demand generation no blueprint exists yet. Compile one now from the assistant's current
    // data instead of hard-failing — this is what previously surfaced as a 404 "Blueprint not found".
    // (An explicit blueprintId that can't be resolved is still an error — don't paper over that.)
    if (!bp && !blueprintId) {
        try {
            const result = await assembleBlueprint(assistantId, String(userId), 'auto-on-demand');
            bp = { id: result.blueprint.id, missingFields: result.blueprint.missingFields };
        } catch (err) {
            console.error('[generate-post] auto-compile blueprint failed', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Could not prepare your assistant for generation. Please try again shortly.' }) };
        }
    }

    if (!bp) return { statusCode: 404, body: JSON.stringify({ error: 'Blueprint not found.' }) };

    const missingFields = (bp.missingFields as Array<{ severity: string }>) || [];
    const blockingGaps = missingFields.filter(f => f.severity === 'blocking');
    if (blockingGaps.length > 0) {
        return { statusCode: 422, body: JSON.stringify({ error: 'Blueprint has blocking gaps. Resolve them before generating.' }) };
    }

    // Plan limit check: no more than 50 queued/processing jobs per org at once
    const [{ jobCount }] = await db.execute<{ jobCount: number }>(
        `SELECT COUNT(*)::int AS "jobCount" FROM content_generation_jobs WHERE organisation_id = ${organisationId} AND status IN ('queued','processing')`
    );
    if (jobCount >= 50) {
        return { statusCode: 429, body: JSON.stringify({ error: 'Too many pending generation jobs. Please wait for some to complete.' }) };
    }

    const jobId = randomUUID();

    await db.insert(contentGenerationJobs).values({
        jobId,
        blueprintId: bp.id,
        assistantId,
        organisationId,
        userId,
        status: 'queued',
        attempt: 0,
        maxAttempts: 3,
        contextPrompt: contextPrompt || null,
        triggerType,
        platform: platform || null,
    });

    await db.insert(notifications).values({
        userId,
        type: 'post_generation_queued',
        title: triggerType === 'on_demand' ? 'Generating your post on demand…' : 'Generating your post…',
        message: 'Your post is being generated. This usually takes 30–60 seconds.',
        metadata: { jobId },
    });

    return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status: 'queued', estimatedReadyIn: '30–60 seconds' }),
    };
};
