// src/utils/blog-gap-fill.ts
// Blog Autopilot gap-fill: the long-form counterpart to schedule-gap-fill.ts. Given a Blog Writer's
// publishing schedule (frequency / days / times) and its draft horizon, compute the slots that
// should be filled inside the horizon, subtract what is already planned or in flight, and enqueue
// one content_generation_job (content_type='blog') per remaining slot.
//
// Shared by:
//   • blog-horizon-fill.ts   (daily cron — keeps every active Blog Writer's queue topped up)
//   • set-draft-horizon.ts   (horizon expanded — fill the newly-opened window immediately)
//
// Deliberately simpler than the social path, because the differences are real rather than
// incidental:
//   · No platform fan-out. A blog post is one artifact; social drafts one post per platform per slot.
//   · No blueprint. Blog generation has never read aiBlueprints — voice comes from the assistant's
//     tone_of_voice and Inspo — so there is no compile step and no blocking-gaps skip.
//   · No empty-library media check. That guard exists because a social post without an image is a
//     weak post; long-form stands on its text, and the hero graphic is optional.

import { and, eq, gte, lte, sql, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { getDb } from '../../db/client';
import { blogPosts, contentGenerationJobs } from '../../db/schema';
import { resolvePostingSchedule, computeScheduleSlots, resolveHorizonDays } from '../config/posting-cadence';

type Db = ReturnType<typeof getDb>;

export interface BlogGapFillAssistant {
    id: number;
    userId: number;
    organisationId: number;
    name: string;
    onboardingContext: unknown;
    draftHorizonDays: number | null;
}

export interface BlogGapFillResult {
    enqueued: number;
    /** Why nothing (or fewer) jobs were enqueued — useful for cron telemetry. */
    reason?: 'on_demand' | 'fully_covered' | 'ok';
}

const UTC_DAY = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Enqueue generation jobs to fill any uncovered publishing slots inside the assistant's horizon.
 * Idempotent in practice: a slot already covered by a planned post or an in-flight job is skipped,
 * so repeated runs (daily cron + a horizon change on the same day) won't double-book.
 */
export async function enqueueBlogGapFill(
    db: Db,
    assistant: BlogGapFillAssistant,
    now: Date = new Date(),
): Promise<BlogGapFillResult> {
    const ctx = (assistant.onboardingContext as Record<string, unknown>) ?? {};
    const schedule = resolvePostingSchedule(ctx);
    const horizonDays = resolveHorizonDays(assistant);

    const slots = computeScheduleSlots({ schedule, horizonDays, now });
    if (!slots.length) return { enqueued: 0, reason: 'on_demand' };

    const windowEnd = slots[slots.length - 1];

    // Posts already planned within the window. 'published' is absent deliberately: a post that has
    // already gone out is history, not coverage of a future slot. The statuses here mirror the
    // pre-publication half of the blog_posts_status_check constraint.
    const plannedRows = await db
        .select({ publishDate: blogPosts.publishDate })
        .from(blogPosts)
        .where(and(
            eq(blogPosts.assistantId, assistant.id),
            gte(blogPosts.publishDate, now),
            lte(blogPosts.publishDate, windowEnd),
            sql`status IN ('draft','pending_approval','in_review','approved','scheduled','publishing')`,
        ));

    // Blog generation jobs still in flight that already target a slot in the window. Scoped to
    // content_type='blog' so this assistant's social jobs — if it ever has any — can't mask a
    // blog slot as covered.
    const inflightRows = await db
        .select({ targetPublishDate: contentGenerationJobs.targetPublishDate })
        .from(contentGenerationJobs)
        .where(and(
            eq(contentGenerationJobs.assistantId, assistant.id),
            eq(contentGenerationJobs.contentType, 'blog'),
            inArray(contentGenerationJobs.status, ['queued', 'processing']),
        ));

    // Coverage counts keyed by calendar day. A day configured with two preferred times needs two
    // posts before it counts as covered, so this counts rather than just marking presence.
    const coverage = new Map<string, number>();
    const bump = (d: Date | null) => {
        if (!d) return;
        const key = UTC_DAY(new Date(d));
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
    };
    plannedRows.forEach(r => bump(r.publishDate));
    inflightRows.forEach(r => bump(r.targetPublishDate));

    // Walk desired slots chronologically; collect only the deficit.
    const uncovered: Date[] = [];
    for (const slot of slots) {
        const key = UTC_DAY(slot);
        const remaining = coverage.get(key) ?? 0;
        if (remaining > 0) { coverage.set(key, remaining - 1); continue; } // already covered
        uncovered.push(slot);
    }
    if (!uncovered.length) return { enqueued: 0, reason: 'fully_covered' };

    for (const slot of uncovered) {
        await db.insert(contentGenerationJobs).values({
            jobId: randomUUID(),
            // No blueprintId: blog drafting doesn't read one (see header).
            assistantId: assistant.id,
            organisationId: assistant.organisationId,
            userId: assistant.userId,
            status: 'queued',
            attempt: 0,
            maxAttempts: 3,
            triggerType: 'scheduled',
            contentType: 'blog',
            targetPublishDate: slot,
        });
    }

    return { enqueued: uncovered.length, reason: 'ok' };
}
