// netlify/functions/suggest-post-idea.ts
// "Create Post" → Suggest an idea mode. The user submits a short post idea only. It's stored in
// post_idea_suggestions (status='pending') AND a generation job is enqueued immediately so the next
// process-content-jobs tick (runs every minute) FIFO-consumes the idea into a draft — see
// process-content-jobs.ts. Previously the idea was only consumed passively by the daily
// draft-horizon-fill cron, so an on-demand assistant (or one whose horizon was already full) left the
// idea stuck in 'pending' forever and "nothing happened". Enqueuing here guarantees a prompt draft.

import { Handler } from '@netlify/functions';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { aiAssistants, aiBlueprints, contentGenerationJobs, postIdeaSuggestions } from '../../db/schema';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { requireTenant } from '../../src/utils/tenant';
import { assembleBlueprint } from '../../src/utils/blueprint';

const VALID_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x'];

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: { assistantId?: number; idea?: string; platform?: string; platforms?: string[] };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { assistantId } = body;
    const idea = (body.idea || '').trim();

    // Platform targeting: accept a multi-select `platforms` array (new) or a single `platform`
    // string (legacy). Stored as a comma-separated list in the `platform` column. An empty selection
    // — or one covering every platform — is stored as null, meaning "all platforms".
    const requested = Array.isArray(body.platforms)
        ? body.platforms
        : (body.platform ? [body.platform] : []);
    const selected = [...new Set(requested.filter((p): p is string => VALID_PLATFORMS.includes(p)))];
    const platform = (selected.length === 0 || selected.length === VALID_PLATFORMS.length)
        ? null
        : selected.join(',');

    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    if (!idea) return { statusCode: 400, body: JSON.stringify({ error: 'Please describe your post idea.' }) };
    if (idea.length > 500) return { statusCode: 400, body: JSON.stringify({ error: 'Your idea must be 500 characters or fewer.' }) };

    // Hard-block severe-violation prompts (mirrors generate-post.ts).
    const modBlock = await enforcePromptModeration({ text: idea, userId, organisationId, source: 'suggest-post-idea' });
    if (modBlock) return modBlock;

    // Verify the assistant belongs to this org.
    const [asst] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
        .limit(1);
    if (!asst) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    await db.insert(postIdeaSuggestions).values({
        organisationId,
        assistantId,
        userId,
        idea,
        platform,
        status: 'pending',
    });

    // Immediately enqueue a generation job so process-content-jobs (every minute) drafts this idea
    // rather than leaving it to sit in 'pending' until the daily gap-fill cron happens to run. The
    // job carries NO context_prompt and trigger_type 'scheduled', which is exactly the branch in
    // process-content-jobs that FIFO-pulls the oldest pending idea, links it to the resulting draft,
    // and flips it to 'in_review'. Best-effort: the idea is already saved, so a queueing failure here
    // must not fail the request — it'll still be picked up by the next scheduled gap-fill.
    try {
        const [bp] = await db
            .select({ id: aiBlueprints.id, missingFields: aiBlueprints.missingFields })
            .from(aiBlueprints)
            .where(and(eq(aiBlueprints.assistantId, assistantId), eq(aiBlueprints.organisationId, organisationId)))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(1);

        // Self-serve assistants may have no compiled blueprint yet — compile one now (mirrors
        // generate-post.ts) so the idea can be drafted on first use instead of 404-ing the job.
        let blueprint = bp;
        if (!blueprint) {
            const result = await assembleBlueprint(assistantId, String(userId), 'auto-suggest-idea');
            blueprint = { id: result.blueprint.id, missingFields: result.blueprint.missingFields };
        }

        const blockingGaps = ((blueprint.missingFields as Array<{ severity: string }>) || [])
            .filter(f => f.severity === 'blocking');

        // Only enqueue when the assistant can actually generate. If the blueprint has blocking gaps,
        // leave the idea pending — the existing gap-fill / review flow surfaces those gaps to the user.
        if (blockingGaps.length === 0) {
            // The idea may target several platforms (stored comma-separated). A job drafts one
            // platform, so honour a single-platform hint and otherwise let the assistant default.
            const jobPlatform = selected.length === 1 ? selected[0] : null;
            await db.insert(contentGenerationJobs).values({
                jobId: randomUUID(),
                blueprintId: blueprint.id,
                assistantId,
                organisationId,
                userId,
                status: 'queued',
                attempt: 0,
                maxAttempts: 3,
                triggerType: 'scheduled',
                platform: jobPlatform,
            });
        }
    } catch (e) {
        console.warn('[suggest-post-idea] could not enqueue generation job (idea stays pending):', e instanceof Error ? e.message : e);
    }

    return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
    };
};
