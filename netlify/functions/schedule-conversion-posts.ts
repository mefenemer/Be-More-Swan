// netlify/functions/schedule-conversion-posts.ts
// US-SMM (AC7): Periodic conversion-post scheduler.
//
// Conversion posts ("path-to-working-with-me" posts built around the assistant's offerings) were
// previously only produced on demand or woven into normal posts. This daily cron enqueues ONE
// conversion-type generation job per eligible Social Media Manager assistant on a steady cadence
// (default: at most one per 7 days), so the funnel gets a regular direct-CTA post without spamming.
//
// Migration-free: reuses the existing content_generation_jobs pipeline (trigger_type='conversion',
// already honoured by process-content-jobs.ts) and reads cadence from onboarding_context.
//
// Schedule: "0 7 * * *" (07:00 UTC daily — just after draft-horizon-fill at 06:00).

import { Handler } from '@netlify/functions';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants, aiBlueprints, contentGenerationJobs, notifications } from '../../db/schema';
import { postsPerWeekFor } from '../../src/config/posting-cadence';
import { SMM_ROLE_KEYS } from '../../src/constants/roles';

// At most one scheduled conversion post per assistant per this many days. Tunable; a conversion
// post is a direct ask, so it should stay infrequent relative to value-first content.
const CONVERSION_INTERVAL_DAYS = 7;

export const handler: Handler = async (event) => {
    // Allow scheduled invocations and manual POST (for testing), matching draft-horizon-fill.
    if (event.httpMethod !== 'POST' && !(event as { schedule?: unknown }).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();
    const now = new Date();
    const intervalAgo = new Date(now.getTime() - CONVERSION_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

    // Active Social Media Manager assistants + their onboarding context (cadence + offerings).
    const smmAssistants = await db
        .select({
            id: aiAssistants.id,
            userId: aiAssistants.userId,
            organisationId: aiAssistants.organisationId,
            name: aiAssistants.name,
            onboardingContext: aiAssistants.onboardingContext,
        })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(
            eq(aiAssistants.isActive, true),
            inArray(masterAssistants.roleKey, SMM_ROLE_KEYS),
        ));

    let enqueued = 0;
    const skipped: Record<string, number> = { no_offerings: 0, on_demand: 0, recent_conversion: 0, no_blueprint: 0, blocking_gaps: 0 };

    for (const assistant of smmAssistants) {
        const ctx = (assistant.onboardingContext as Record<string, unknown>) ?? {};

        // Need offerings to build a conversion post around; otherwise there's nothing to convert toward.
        const serviceOfferings = (ctx.service_offerings as string) ?? '';
        if (!serviceOfferings.trim()) { skipped.no_offerings++; continue; }

        // Respect cadence — don't schedule for on-demand assistants.
        if (postsPerWeekFor(ctx.posting_frequency) <= 0) { skipped.on_demand++; continue; }

        // Cadence guard: skip if a conversion job was created within the interval, or one is still
        // queued/processing (avoid piling up if a worker is backed up).
        const [recent] = await db
            .select({ id: contentGenerationJobs.id })
            .from(contentGenerationJobs)
            .where(and(
                eq(contentGenerationJobs.assistantId, assistant.id),
                eq(contentGenerationJobs.triggerType, 'conversion'),
                sql`(${contentGenerationJobs.createdAt} >= ${intervalAgo} OR ${contentGenerationJobs.status} IN ('queued','processing'))`,
            ))
            .limit(1);
        if (recent) { skipped.recent_conversion++; continue; }

        // Resolve the latest blueprint; skip if missing or it has blocking gaps (mirror generate-post).
        const [bp] = await db
            .select({ id: aiBlueprints.id, missingFields: aiBlueprints.missingFields })
            .from(aiBlueprints)
            .where(and(eq(aiBlueprints.assistantId, assistant.id), eq(aiBlueprints.organisationId, assistant.organisationId)))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(1);
        if (!bp) { skipped.no_blueprint++; continue; }

        const blockingGaps = ((bp.missingFields as Array<{ severity: string }>) || []).filter(f => f.severity === 'blocking');
        if (blockingGaps.length > 0) { skipped.blocking_gaps++; continue; }

        // Enqueue the conversion generation job — process-content-jobs picks it up next tick.
        const jobId = randomUUID();
        await db.insert(contentGenerationJobs).values({
            jobId,
            blueprintId: bp.id,
            assistantId: assistant.id,
            organisationId: assistant.organisationId,
            userId: assistant.userId,
            status: 'queued',
            attempt: 0,
            maxAttempts: 3,
            triggerType: 'conversion',
        });

        await db.insert(notifications).values({
            userId: assistant.userId,
            type: 'post_generation_queued',
            title: 'Generating a conversion post…',
            message: `${assistant.name} is drafting a conversion post to invite your audience to work with you. It'll appear in your review queue shortly.`,
            metadata: { jobId, triggerType: 'conversion' },
        }).catch(() => {});

        enqueued++;
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, assistantsChecked: smmAssistants.length, conversionJobsEnqueued: enqueued, skipped }),
    };
};
