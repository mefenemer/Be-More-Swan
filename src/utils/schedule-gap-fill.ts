// src/utils/schedule-gap-fill.ts
// Posting Schedule gap-fill: given an assistant's posting schedule (frequency / days / times) and
// its draft horizon, compute the calendar slots that should be filled within the horizon, subtract
// what is already planned or in-flight, and enqueue one content_generation_job per remaining slot —
// each carrying target_publish_date so process-content-jobs stamps the draft at the right time.
//
// Shared by:
//   • draft-horizon-fill.ts        (hourly cron — keeps every active SMM assistant's queue topped up)
//   • set-draft-horizon.ts         (horizon expanded — fill the newly-opened window immediately)

import { and, eq, gte, lte, desc, sql, inArray, isNull, ne } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { getDb } from '../../db/client';
import { aiBlueprints, scheduledPosts, contentGenerationJobs, contentAssets, notifications } from '../../db/schema';
import { createNotification } from './notify';
import { resolvePostingSchedule, computeScheduleSlots, readCadence, resolveHorizonDays } from '../config/posting-cadence';
import { assembleBlueprint } from './blueprint';
import { resolveConnectedDraftPlatforms } from './auto-publish-runtime';
import { resolveLiveSocialConnections } from './live-social-connections';
import { isPlatformOptedInForAssistant } from './assistant-platform-selection';
import { remotionConfigured } from '../lib/remotion-lambda';
import { r2IsConfigured } from '../lib/media-persist';

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
    /**
     * Why nothing (or fewer) jobs were enqueued — useful for cron telemetry.
     *
     * `on_demand` used to cover every empty slot list, which made the counter a lie in the one case
     * that mattered: an assistant the user believes is on a schedule, whose posting_frequency we
     * simply failed to parse, was tallied next to the ones deliberately switched off and thrown
     * away. That is how an assistant went from hire to a whole month without drafting a single post
     * while its dashboard reported autopilot ACTIVE (prod org 40, found 2026-08-05). The three
     * states are now distinct, because only one of them is a problem:
     *   on_demand           — the user turned scheduling off. Correct. Silent.
     *   unrecognised_cadence— we cannot read what they set. Broken, and nobody would ever find out.
     *   no_slot_in_horizon  — readable and scheduled, but no slot falls inside the horizon (a short
     *                         horizon and a weekday that isn't in it). Benign; resolves itself.
     */
    reason?: 'on_demand' | 'unrecognised_cadence' | 'no_slot_in_horizon' | 'no_blueprint'
        | 'blocking_gaps' | 'fully_covered' | 'empty_library_skipped' | 'ok';
}

/**
 * The reasons that mean a human has to change something before this assistant will ever draft.
 * Each is permanent until acted on — re-running the cron changes nothing — which is exactly what
 * made them invisible while they were only ever counted and discarded.
 *
 * `fully_covered` and `no_slot_in_horizon` are deliberately absent: both are healthy states that
 * resolve on their own as the horizon moves.
 */
export const GAP_FILL_ATTENTION_REASONS: ReadonlySet<string> = new Set([
    'unrecognised_cadence',  // stored posting_frequency cannot be parsed → user fixes the value
    'blocking_gaps',         // blueprint refuses to generate  → user (or we) clear the blockers
    'no_blueprint',          // the auto-compile threw          → ours; no user-facing notification
]);

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
    const horizonDays = resolveHorizonDays(assistant);

    const slots = computeScheduleSlots({ schedule, horizonDays, now });
    if (!slots.length) {
        // Ask the cadence parser WHY there are no slots rather than assuming the charitable answer.
        // readCadence is the same function the Autopilot card reads, so the card and the cron can
        // no longer disagree about whether this assistant is running.
        const { kind } = readCadence(schedule.frequency);
        if (kind === 'unrecognised') {
            await notifyUnreadableCadence(db, assistant, schedule.frequency);
            return { enqueued: 0, reason: 'unrecognised_cadence' };
        }
        return { enqueued: 0, reason: kind === 'on_demand' ? 'on_demand' : 'no_slot_in_horizon' };
    }

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
    const blockingGaps = (bp.missingFields as BlueprintGap[] | null || []).filter(f => f.severity === 'blocking');
    if (blockingGaps.length > 0) {
        await notifyBlockedSetup(db, assistant, blockingGaps);
        return { enqueued: 0, reason: 'blocking_gaps' };
    }

    const windowEnd = slots[slots.length - 1];

    // Autopilot drafts ONE idea per slot and fans it across every platform the org has a LIVE
    // connection for (∩ the platforms a drafter exists for). One content_generation_job per slot
    // carries that platform list; process-content-jobs generates a single caption/media and creates one
    // post per platform, all sharing a crosspost_group_id → one Review Queue card, preview per platform.
    // Orgs with no live connection on any drafter platform keep the single stream (platforms null → the
    // worker resolves the org's fallback connection).
    // Scoped to THIS assistant, not just the org: a platform the user has switched off in the
    // assistant's Connections tab ("Use for this assistant") must drop out of the fan-out. The org
    // stays connected — another assistant may still post there — but this one stops drafting for it.
    const targetPlatforms = await resolveConnectedDraftPlatforms(db, assistant.organisationId, {
        onboardingContext: assistant.onboardingContext,
        configuration: assistant.configuration,
    });

    // A cross-post's per-platform rows all share ONE publish_date, so coverage is per SLOT, not per
    // platform: a day with two preferred times needs two cross-posts to be "covered". We dedupe planned
    // rows / in-flight jobs by their exact slot timestamp first so one cross-post counts once, then
    // tally per calendar day.
    const plannedRows = await db
        .select({
            id: scheduledPosts.id,
            platform: scheduledPosts.platform,
            publishDate: scheduledPosts.publishDate,
            crosspostGroupId: scheduledPosts.crosspostGroupId,
        })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.assistantId, assistant.id),
            gte(scheduledPosts.publishDate, now),
            lte(scheduledPosts.publishDate, windowEnd),
            sql`status IN ('draft','pending_approval','in_review','approved','scheduled')`,
        ));
    const inflightRows = await db
        .select({
            jobId: contentGenerationJobs.jobId,
            platform: contentGenerationJobs.platform,
            targetPublishDate: contentGenerationJobs.targetPublishDate,
        })
        .from(contentGenerationJobs)
        .where(and(
            eq(contentGenerationJobs.assistantId, assistant.id),
            inArray(contentGenerationJobs.status, ['queued', 'processing']),
        ));

    // The weekly YouTube Short is a SEPARATE stream, and it must not be counted as cross-post
    // coverage. It shares a slot time with the day's cross-post (both take the first slot), and
    // coverage is tallied per DAY — so without this exclusion one Short would make its day look
    // covered and silently cancel that day's Instagram/LinkedIn/X post.
    const isWeeklyShort = (platform: string | null, crosspostGroupId?: string | null) =>
        platform === 'youtube' && !crosspostGroupId;

    // Count DISTINCT LOGICAL posts per day. A cross-post's per-platform rows share one
    // crosspost_group_id and one publish_date, so they collapse to a single unit — but two
    // INDEPENDENT posts that happen to sit on the same instant must still count as two.
    // The previous code deduped by timestamp alone, so N independent posts on one slot counted
    // as 1, the day looked under-covered, and the cron kept enqueuing more jobs onto a slot that
    // was already over-subscribed. Keying on the group id (falling back to the row's own id)
    // preserves the cross-post collapse without swallowing genuine duplicates.
    const seenUnits = new Set<string>();
    const coverage = new Map<string, number>();
    const addCoverage = (when: Date | string, unitKey: string) => {
        if (seenUnits.has(unitKey)) return;
        seenUnits.add(unitKey);
        const key = UTC_DAY(new Date(when));
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
    };
    plannedRows.forEach(r => {
        if (!r.publishDate || isWeeklyShort(r.platform, r.crosspostGroupId)) return;
        addCoverage(r.publishDate, r.crosspostGroupId ? `grp:${r.crosspostGroupId}` : `post:${r.id}`);
    });
    inflightRows.forEach(r => {
        if (!r.targetPublishDate || isWeeklyShort(r.platform)) return;
        addCoverage(r.targetPublishDate, `job:${r.jobId}`);
    });

    // Walk desired slots chronologically; collect only the deficit (one entry per uncovered slot).
    const uncovered: Date[] = [];
    for (const slot of slots) {
        const key = UTC_DAY(slot);
        const remaining = coverage.get(key) ?? 0;
        if (remaining > 0) { coverage.set(key, remaining - 1); continue; } // already covered
        uncovered.push(slot);
    }
    // The weekly YouTube Short rides alongside the cross-post stream rather than inside it: a
    // different format (9:16 video), different media (a brand card rendered to an mp4) and a
    // different cadence. Keeping it as its own standalone job is what lets all three differ without
    // touching the one-idea fan-out every other assistant depends on.
    const shortSlot = await resolveWeeklyShortSlot(db, assistant, slots, now);

    if (!uncovered.length && !shortSlot) return { enqueued: 0, reason: 'fully_covered' };

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

    // One job per uncovered slot. When the assistant targets 2+ platforms the job fans out into a
    // single cross-post (shared crosspost_group_id); a lone platform (or the legacy single stream)
    // stays standalone (null group id, null platforms → the worker resolves the fallback connection).
    const fanOut = targetPlatforms.length > 0;
    const isCrossPost = targetPlatforms.length > 1;

    let enqueued = 0;

    if (shortSlot) {
        await enqueueYoutubeShortJob(db, {
            blueprintId: bp.id,
            assistantId: assistant.id,
            organisationId: assistant.organisationId,
            userId: assistant.userId,
            targetPublishDate: shortSlot,
            triggerType: 'scheduled',
        });
        enqueued++;
    }

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
            // platforms drives the fan-out; platform stays null (resolved from the list, or the org
            // fallback when there is no list).
            platform: null,
            platforms: fanOut ? targetPlatforms : null,
            targetPublishDate: slot,
            crosspostGroupId: isCrossPost ? randomUUID() : null,
        });
        enqueued++;
    }

    return { enqueued, reason: enqueued ? 'ok' : 'fully_covered' };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Enqueue ONE YouTube Short job. The single definition of what a Short job looks like.
 *
 * Shared by the weekly cron and the on-demand trigger, because the shape is load-bearing and not
 * obvious from reading it: `platform` set, `platforms` NULL and no `crosspost_group_id` is what
 * process-content-jobs reads as "one post, this platform" — which is what makes the drafter take the
 * Short branch (9:16 card, yt_short, rendered to video) instead of treating it as a cross-post.
 * A second hand-written copy of this object that set `platforms: ['youtube']` would look identical
 * at a glance and would silently draft an ordinary 16:9 YouTube post that can never publish.
 */
export async function enqueueYoutubeShortJob(db: Db, args: {
    blueprintId: number;
    assistantId: number;
    organisationId: number;
    userId: number;
    targetPublishDate: Date;
    triggerType: 'scheduled' | 'on_demand';
}): Promise<string> {
    const jobId = randomUUID();
    await db.insert(contentGenerationJobs).values({
        jobId,
        blueprintId: args.blueprintId,
        assistantId: args.assistantId,
        organisationId: args.organisationId,
        userId: args.userId,
        status: 'queued',
        attempt: 0,
        maxAttempts: 3,
        triggerType: args.triggerType,
        platform: 'youtube',
        platforms: null,
        targetPublishDate: args.targetPublishDate,
        crosspostGroupId: null,
    });
    return jobId;
}

/**
 * When the assistant's next weekly YouTube Short should be drafted, or null if it shouldn't.
 *
 * Due when the assistant is explicitly ticked for YouTube, the org has a LIVE YouTube connection,
 * and there is no Short already planned or in flight in the next seven days.
 *
 * The opt-in check is separate from the liveness one on purpose, and it is the one that was
 * missing: YouTube is deliberately absent from AUTONOMOUS_DRAFT_PLATFORMS, so the Short is the ONLY
 * thing that autonomously drafts for YouTube — which made this function the single reason a user
 * who had turned YouTube off for their assistant kept finding a new Short in the Review Queue every
 * week. Nothing else read the switch, so there was no way to stop it without disconnecting the
 * channel for the whole workspace.
 *
 * Opt-in rather than the default-on rule the ordinary stream uses (isPlatformEnabledForAssistant):
 * a live channel is not a request for a video a week, and in practice the assistants hit by this
 * had no recorded selection at all — falling open on a blank one would have left them producing
 * exactly the Short the user was trying to stop.
 *
 * The lookahead is a fixed week rather than the draft horizon deliberately:
 * an assistant with a 3-day horizon would otherwise never see the Short it queued for day five and
 * would enqueue another every hour the cron ran.
 *
 * The slot is the first one of the week, per the cadence decision — it shares an instant with that
 * day's cross-post, which is fine (two independent posts to different platforms) as long as the
 * coverage tally excludes it. See isWeeklyShort above; that exclusion is what stops the Short from
 * cannibalising the day's ordinary post.
 */
async function resolveWeeklyShortSlot(
    db: Db,
    assistant: GapFillAssistant,
    slots: Date[],
    now: Date,
): Promise<Date | null> {
    // No renderer, no Short. A Short's whole existence depends on turning its card into an mp4, and
    // the render is the LAST step — so without this the assistant would spend a model call writing a
    // caption, draw a card, gate the post on a render that can never run, and leave a permanently
    // unpublishable draft in the queue every single week. trigger-post-render refuses up front for
    // exactly this reason (503 RENDER_UNAVAILABLE); refusing at ENQUEUE is the cheaper version of the
    // same decision. When the Lambda is deployed this starts returning true on its own — nothing to
    // switch on.
    if (!remotionConfigured() || !r2IsConfigured()) return null;

    const optedIn = await isPlatformOptedInForAssistant(
        db,
        {
            organisationId: assistant.organisationId,
            onboardingContext: assistant.onboardingContext,
            configuration: assistant.configuration,
        },
        'youtube',
    );
    if (!optedIn) return null;

    const live = await resolveLiveSocialConnections(db, assistant.organisationId);
    if (!live.has('youtube')) return null;

    const weekEnd = new Date(now.getTime() + WEEK_MS);
    const weekAgo = new Date(now.getTime() - WEEK_MS);

    // The dedupe window looks BACKWARD as well as forward, and that is what makes the cadence
    // weekly. Looking only forward is how a "weekly" Short drafted one EVERY DAY: the moment a
    // Short's 08:00 slot passed it stopped matching `publishDate >= now`, the next hourly run saw
    // no future Short, and enqueued another for tomorrow's slot — nine Shorts in nine working days
    // on the production assistant this was found on, none of them ever approved. Nothing about that
    // looked wrong from inside the function: it asked an honest question about the future and got
    // an honest answer, having forgotten everything it did yesterday.
    //
    // 'published' belongs in the status list for the same reason. A Short that actually went out is
    // the strongest possible evidence this week's is done, and leaving it out would resume the
    // daily loop for exactly the users whose Shorts are working.
    const [recentShort] = await db
        .select({ id: scheduledPosts.id })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.assistantId, assistant.id),
            eq(scheduledPosts.platform, 'youtube'),
            gte(scheduledPosts.publishDate, weekAgo),
            lte(scheduledPosts.publishDate, weekEnd),
            sql`status IN ('draft','pending_approval','in_review','approved','scheduled','publishing','published')`,
        ))
        .limit(1);
    if (recentShort) return null;

    const [inflightShort] = await db
        .select({ id: contentGenerationJobs.id })
        .from(contentGenerationJobs)
        .where(and(
            eq(contentGenerationJobs.assistantId, assistant.id),
            eq(contentGenerationJobs.platform, 'youtube'),
            inArray(contentGenerationJobs.status, ['queued', 'processing']),
        ))
        .limit(1);
    if (inflightShort) return null;

    return slots.find(s => s > now && s <= weekEnd) ?? null;
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

/** The shape of a blueprint missingFields entry that this module needs (see MissingField). */
type BlueprintGap = {
    severity: string;
    /** 'customer' — they can fix it themselves. 'internal' — ours; telling them helps nobody. */
    owner?: string;
    remedy?: { label?: string };
};

/**
 * Tell the user their assistant is not drafting, when the reason is that their setup blocks
 * generation outright.
 *
 * Same silence as the cadence bug, a different cause: a blueprint with blocking gaps refuses to
 * generate on every hourly tick and says so only in a counter. The blocking gaps are things like
 * "Accept the Data Processing Agreement" and "Choose a plan — no active subscription" — entirely
 * fixable, in seconds, by someone who has no idea they are the reason nothing is being drafted.
 *
 * Internal-owned gaps are excluded: 'Re-provision the assistant — hire-time brief never compiled'
 * is our bug, and a notification the user cannot act on is worse than none. When every blocking gap
 * is internal, this stays quiet and the cron's needsAttention entry is the only signal — which is
 * the correct audience for it.
 *
 * Deduped once per 3 days per assistant, for the same reason as the others: hourly cron.
 */
async function notifyBlockedSetup(db: Db, assistant: GapFillAssistant, gaps: BlueprintGap[]): Promise<void> {
    try {
        // Pluralisation and list-joining happen at the call site by convention — the merge engine
        // has no plural rules (see notification-templates-catalog.ts).
        const actionable = gaps
            .filter(g => g.owner !== 'internal')
            .map(g => g.remedy?.label?.trim())
            .filter((l): l is string => !!l);
        if (!actionable.length) return;
        const blockers = actionable.length === 1
            ? actionable[0]
            : `${actionable.slice(0, -1).join(', ')} and ${actionable[actionable.length - 1]}`;

        const [recent] = await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(and(
                eq(notifications.userId, assistant.userId),
                eq(notifications.type, 'autopilot_setup_blocked'),
                sql`${notifications.metadata}->>'assistantId' = ${String(assistant.id)}`,
                sql`${notifications.createdAt} > now() - interval '3 days'`,
            ))
            .limit(1);
        if (recent) return;

        await createNotification(db, 'autopilot_setup_blocked', {
            userId: assistant.userId,
            context: { assistant: { name: assistant.name }, setup: { blockers } },
            metadata: { assistantId: assistant.id, reason: 'blocking_gaps', blockers: actionable },
            assistantId: assistant.id,
        });
    } catch (err) {
        console.error(`notifyBlockedSetup: assistant ${assistant.id} failed`, err);
    }
}

/**
 * Tell the user their assistant is not drafting, when the reason is that we cannot read the
 * posting schedule they set.
 *
 * This is the alert for the failure with no other symptom. A skipped gap-fill produced a counter in
 * a cron response nobody reads; the Review Queue just stayed empty, and the Autopilot card (before
 * it learned to ask readCadence) actively said ACTIVE. Prod org 40 sat like that from hire until a
 * human happened to ask why — 9 posts in a month, none of them scheduled.
 *
 * Deliberately NOT sent for `on_demand`: that user switched scheduling off and does not need
 * telling. Only an unreadable value gets here, which is always a bug on our side — the wizard
 * accepted free text — and always needs a human to fix the stored value.
 *
 * Deduped to once per 3 days per assistant, matching notifyEmptyLibrarySkip. Load-bearing: the cron
 * is hourly and a broken cadence does not self-heal, so without this the user is nagged 24x a day
 * forever.
 */
async function notifyUnreadableCadence(db: Db, assistant: GapFillAssistant, frequency: unknown): Promise<void> {
    try {
        const [recent] = await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(and(
                eq(notifications.userId, assistant.userId),
                eq(notifications.type, 'autopilot_schedule_unreadable'),
                sql`${notifications.metadata}->>'assistantId' = ${String(assistant.id)}`,
                sql`${notifications.createdAt} > now() - interval '3 days'`,
            ))
            .limit(1);
        if (recent) return;

        // The stored value is quoted back at the user deliberately — "we cannot read your schedule"
        // is not actionable without showing them WHICH value we mean. It is user-supplied text, so
        // it reaches the template as a merge variable (escaped on render — see notify.ts) rather
        // than being concatenated into the copy.
        const stored = String(frequency ?? '').trim();
        await createNotification(db, 'autopilot_schedule_unreadable', {
            userId: assistant.userId,
            context: { assistant: { name: assistant.name }, schedule: { frequency: stored } },
            metadata: { assistantId: assistant.id, reason: 'unrecognised_cadence', frequency: stored },
            assistantId: assistant.id,
        });
    } catch (err) {
        // Never let telemetry break the cron: the other assistants in this tick still need filling.
        console.error(`notifyUnreadableCadence: assistant ${assistant.id} failed`, err);
    }
}

/**
 * Nudge the user to upload media when the Empty-Library Draft Fallback skipped their slots.
 * Deduped to at most once per 3 days per assistant. That dedupe is load-bearing now the cron is
 * HOURLY rather than daily — without it an empty-library org would be nagged 24 times a day.
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

    await createNotification(db, 'content_library_empty', {
        userId: assistant.userId,
        context: { assistant: { name: assistant.name } },
        metadata: { assistantId: assistant.id, reason: 'empty_library_fallback_off' },
    });
}
