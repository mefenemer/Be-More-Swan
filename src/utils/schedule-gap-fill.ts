// src/utils/schedule-gap-fill.ts
// Posting Schedule gap-fill: given an assistant's posting schedule (frequency / days / times) and
// its draft horizon, compute the calendar slots that should be filled within the horizon, subtract
// what is already planned or in-flight, and enqueue one content_generation_job per remaining slot —
// each carrying target_publish_date so process-content-jobs stamps the draft at the right time.
//
// Shared by:
//   • draft-horizon-fill.ts        (daily cron — keeps every active SMM assistant's queue topped up)
//   • set-draft-horizon.ts         (horizon expanded — fill the newly-opened window immediately)

import { and, eq, gte, lte, desc, sql, inArray, isNull, ne } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { getDb } from '../../db/client';
import { aiBlueprints, scheduledPosts, contentGenerationJobs, contentAssets, notifications } from '../../db/schema';
import { resolvePostingSchedule, computeScheduleSlots } from '../config/posting-cadence';
import { assembleBlueprint } from './blueprint';

type Db = ReturnType<typeof getDb>;

export interface GapFillAssistant {
    id: number;
    userId: number;
    organisationId: number;
    name: string;
    onboardingContext: unknown;
    draftHorizonDays: number | null;
    /** aiAssistants.configuration jsonb — carries appliedDefaults.autonomousFallback. Optional so
     *  legacy callers that don't select it fall back to the safe default (fallback enabled). */
    configuration?: unknown;
}

export interface GapFillResult {
    enqueued: number;
    /** Why nothing (or fewer) jobs were enqueued — useful for cron telemetry. */
    reason?: 'on_demand' | 'no_blueprint' | 'blocking_gaps' | 'fully_covered' | 'empty_library_skipped' | 'ok';
}

const UTC_DAY = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Enqueue generation jobs to fill any uncovered posting slots inside the assistant's draft horizon.
 * Idempotent in practice: a day already covered by a planned post or an in-flight job is skipped,
 * so repeated runs (cron + horizon change) won't double-book.
 */
export async function enqueueScheduleGapFill(
    db: Db,
    assistant: GapFillAssistant,
    now: Date = new Date(),
): Promise<GapFillResult> {
    const ctx = (assistant.onboardingContext as Record<string, unknown>) ?? {};
    const schedule = resolvePostingSchedule(ctx);
    const horizonDays = assistant.draftHorizonDays ?? 7;

    const slots = computeScheduleSlots({ schedule, horizonDays, now });
    if (!slots.length) return { enqueued: 0, reason: 'on_demand' };

    // Resolve the latest blueprint; skip if it has blocking gaps (mirror generate-post).
    let [bp] = await db
        .select({ id: aiBlueprints.id, missingFields: aiBlueprints.missingFields })
        .from(aiBlueprints)
        .where(and(eq(aiBlueprints.assistantId, assistant.id), eq(aiBlueprints.organisationId, assistant.organisationId)))
        .orderBy(desc(aiBlueprints.compiledAt))
        .limit(1);

    // Self-serve assistants are never compiled by the admin Blueprint tool. Unlike generate-post
    // (an on-demand user click), this cron runs unattended — if we just skip here, an assistant that
    // was activated without ever having "Generate Post" clicked manually will silently never produce
    // a draft. Compile the blueprint now instead of leaving the assistant stuck.
    if (!bp) {
        try {
            const result = await assembleBlueprint(assistant.id, 'system-cron', 'auto-scheduled');
            bp = { id: result.blueprint.id, missingFields: result.blueprint.missingFields };
        } catch (err) {
            console.error(`enqueueScheduleGapFill: auto-compile blueprint failed for assistant ${assistant.id}`, err);
            return { enqueued: 0, reason: 'no_blueprint' };
        }
    }
    const blockingGaps = ((bp.missingFields as Array<{ severity: string }>) || []).filter(f => f.severity === 'blocking');
    if (blockingGaps.length > 0) return { enqueued: 0, reason: 'blocking_gaps' };

    const windowEnd = slots[slots.length - 1];

    // Posts already planned within the window, counted per calendar day.
    const plannedRows = await db
        .select({ publishDate: scheduledPosts.publishDate })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.assistantId, assistant.id),
            gte(scheduledPosts.publishDate, now),
            lte(scheduledPosts.publishDate, windowEnd),
            sql`status IN ('draft','pending_approval','in_review','approved','scheduled')`,
        ));

    // Generation jobs still in flight that already target a slot in the window.
    const inflightRows = await db
        .select({ targetPublishDate: contentGenerationJobs.targetPublishDate })
        .from(contentGenerationJobs)
        .where(and(
            eq(contentGenerationJobs.assistantId, assistant.id),
            inArray(contentGenerationJobs.status, ['queued', 'processing']),
        ));

    // Per-day coverage counts (a day with two preferred times needs two posts to be "covered").
    const coverage = new Map<string, number>();
    const bump = (d: Date | null) => {
        if (!d) return;
        const key = UTC_DAY(new Date(d));
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
    };
    plannedRows.forEach(r => bump(r.publishDate));
    inflightRows.forEach(r => bump(r.targetPublishDate));

    // Walk desired slots in chronological order; collect only the per-day deficit.
    const uncovered: Date[] = [];
    for (const slot of slots) {
        const key = UTC_DAY(slot);
        const remaining = coverage.get(key) ?? 0;
        if (remaining > 0) { coverage.set(key, remaining - 1); continue; } // already covered
        uncovered.push(slot);
    }
    if (!uncovered.length) return { enqueued: 0, reason: 'fully_covered' };

    // Empty-Library Draft Fallback (assistant-detail toggle). When ENABLED (default), the assistant
    // always drafts for uncovered slots — the drafts use AI/stock media and still route to the Review
    // Queue for approval. When the user has explicitly turned it OFF, we only draft if the org's
    // My Content library has media to draw on; otherwise we skip these slots and nudge the user once
    // to upload media. Missing/true → enabled (preserves the historical always-draft behaviour).
    const fallbackEnabled =
        (assistant.configuration as { appliedDefaults?: { autonomousFallback?: boolean } } | null)
            ?.appliedDefaults?.autonomousFallback !== false;
    if (!fallbackEnabled) {
        const hasMedia = await orgHasAvailableManualAsset(db, assistant.organisationId);
        if (!hasMedia) {
            await notifyEmptyLibrarySkip(db, assistant);
            return { enqueued: 0, reason: 'empty_library_skipped' };
        }
    }

    let enqueued = 0;
    for (const slot of uncovered) {
        await db.insert(contentGenerationJobs).values({
            jobId: randomUUID(),
            blueprintId: bp.id,
            assistantId: assistant.id,
            organisationId: assistant.organisationId,
            userId: assistant.userId,
            status: 'queued',
            attempt: 0,
            maxAttempts: 3,
            triggerType: 'scheduled',
            targetPublishDate: slot,
        });
        enqueued++;
    }

    return { enqueued, reason: enqueued ? 'ok' : 'fully_covered' };
}

/**
 * True if the org's own uploaded library (My Content) has at least one available manual asset:
 * provider IS NULL (not a stock/AI asset), has a storage location, not rejected/purged, and not
 * already attached to a post. Mirrors media-resolver.pickManualAsset so "empty library" here means
 * the same thing the media pipeline would find at draft time.
 */
async function orgHasAvailableManualAsset(db: Db, orgId: number): Promise<boolean> {
    const [row] = await db
        .select({ id: contentAssets.id })
        .from(contentAssets)
        .where(and(
            eq(contentAssets.organisationId, orgId),
            isNull(contentAssets.provider),
            ne(contentAssets.status, 'rejected'),
            isNull(contentAssets.purgedAt),
            sql`(${contentAssets.storageKey} IS NOT NULL OR ${contentAssets.storageUrl} IS NOT NULL OR ${contentAssets.externalUrl} IS NOT NULL)`,
            sql`NOT EXISTS (SELECT 1 FROM scheduled_post_assets spa WHERE spa.content_asset_id = ${contentAssets.id})`,
        ))
        .limit(1);
    return !!row;
}

/**
 * Nudge the user to upload media when the Empty-Library Draft Fallback skipped their slots.
 * Deduped to at most once per 3 days per assistant so the daily cron doesn't nag an empty-library org.
 */
async function notifyEmptyLibrarySkip(db: Db, assistant: GapFillAssistant): Promise<void> {
    const [recent] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(
            eq(notifications.userId, assistant.userId),
            eq(notifications.type, 'content_library_empty'),
            sql`${notifications.metadata}->>'assistantId' = ${String(assistant.id)}`,
            sql`${notifications.createdAt} > now() - interval '3 days'`,
        ))
        .limit(1);
    if (recent) return;

    await db.insert(notifications).values({
        userId: assistant.userId,
        type: 'content_library_empty',
        title: `${assistant.name}: add media to keep posts flowing`,
        message: `${assistant.name} skipped its scheduled drafts because My Content has no available media and the Empty-Library Draft Fallback is turned off. Upload new media, or switch the fallback on so it can draft with AI or stock imagery for you to review.`,
        metadata: { assistantId: assistant.id, reason: 'empty_library_fallback_off' },
    });
}
