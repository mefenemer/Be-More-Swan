// src/utils/publish-policy.ts
// Autopilot's publish gate — the pure, db-free half. See auto-publish-runtime.ts for the checks
// that need a database (live connection, rolling weekly ceiling).
//
// Autopilot is ONE feature with two modes. Its drafting half already exists: draft-horizon-fill
// derives slots from the assistant's posting schedule and process-content-jobs turns each into a
// dated draft. This module decides, per platform, what happens to a finished draft:
//
//   'review'       → it waits in the queue for a human (the default, everywhere)
//   'auto_publish' → it may publish itself, if every safety condition below holds
//
// Policy lives in aiAssistants.onboardingContext.publishPolicy, keyed by platform:
//
//   { "publishPolicy": { "instagram": "auto_publish", "linkedin": "review" } }
//
// A draft publishes unattended only when ALL of these hold:
//   1. The deployer put this platform in 'auto_publish' (default: 'review').
//   2. Its media was NOT AI-generated — the scorer reads the caption, never the image — UNLESS the
//      deployer has explicitly opted in via onboardingContext.allowAiMediaAutoPublish (default off).
//   3. The confidence scorer genuinely rated the caption green with zero factual claims.
//   4. (runtime) A live connection exists to publish through.
//   5. (runtime) The assistant is under its rolling-7-day unattended-publish ceiling.
//
// Everything else routes to 'pending_approval' — never dropped. A missing or malformed policy, a
// scorer timeout, an unreadable model response, or an outright LLM error all fall back to review,
// so the fail-safe direction is always "a human looks at it".
//
// Only the two autonomous drafting engines call this. Manual posts and chat-orchestrator drafts
// already have a human present and stay always-review.

import {
    scoreCaption,
    isAutoPublishEligible,
    isScoreTrustworthy,
    type ConfidenceResult,
} from './post-confidence';
import { resolvePostingSchedule, computeScheduleSlots } from '../config/posting-cadence';
import { normalizePlatform } from '../config/platform-formats';

/**
 * The platforms an autonomous drafter actually exists for. THE single source of truth:
 * autonomous-media-suggestions.ts drafts for these, and get-assistant-context.ts serves this
 * list to the settings UI so the toggles can't drift out of sync with what the backend does.
 * Adding a platform here without a drafter would render a toggle that silently does nothing.
 */
export const AUTONOMOUS_DRAFT_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x'] as const;
export type AutonomousDraftPlatform = typeof AUTONOMOUS_DRAFT_PLATFORMS[number];

/**
 * The platforms an assistant should autonomously DRAFT for: its configured primary_platforms
 * (normalised) intersected with the platforms a drafter actually exists for. Order follows
 * AUTONOMOUS_DRAFT_PLATFORMS for determinism. Empty when the assistant has no recognised platforms
 * configured — callers fall back to their legacy single-platform behaviour in that case.
 */
export function resolveAutonomousDraftPlatforms(onboardingContext: unknown): AutonomousDraftPlatform[] {
    const ctx = (onboardingContext && typeof onboardingContext === 'object')
        ? (onboardingContext as Record<string, unknown>) : {};
    const raw = Array.isArray(ctx.primary_platforms) ? ctx.primary_platforms : [];
    const wanted = new Set(raw.map(normalizePlatform).filter((p): p is AutonomousDraftPlatform => p !== null));
    return AUTONOMOUS_DRAFT_PLATFORMS.filter(p => wanted.has(p));
}

/** 'review' = always queue for human approval. 'auto_publish' = allow a clean green post to schedule itself. */
export type PublishMode = 'review' | 'auto_publish';

/** Fail-safe default for any platform the deployer hasn't explicitly opted in. */
export const DEFAULT_PUBLISH_MODE: PublishMode = 'review';

export type PublishPolicy = Record<string, PublishMode>;

/** Status the drafter writes. 'scheduled' is what publish-social-posts.ts picks up. */
export type DraftStatus = 'scheduled' | 'pending_approval';

/** Where the post's media came from — mirrors resolveMediaForPost()'s `source`. */
export type MediaSource = 'manual' | 'stock' | 'ai';

/** Why the draft landed where it did — surfaced in generationReason and useful when debugging a queue. */
export type GateReason =
    | 'platform_in_review_mode'   // deployer never opted this platform into auto-publish
    | 'unreviewed_ai_media'       // AI-generated image nobody has ever looked at
    | 'low_confidence'            // scorer returned amber/red on the caption itself
    | 'factual_claims'            // green, but claims need verifying
    | 'scoring_unavailable'       // timeout / unparseable response → amber fallback, not a verdict
    | 'no_live_connection'        // nothing to publish through — runtime gate downgrades
    | 'weekly_cap_reached'        // runaway guard tripped — routed to review, never dropped
    | 'auto_published';           // cleared every gate

// Headroom above the schedule's own weekly slot count. Absorbs timezone/boundary effects and the
// secondary gap-filler engine, while still catching a runaway (duplicated cron, bad schedule, a bug
// in this gate). Also the floor for on-demand assistants, whose schedule implies zero slots.
export const AUTO_PUBLISH_WEEKLY_BUFFER = 2;

/**
 * How many posts may publish unattended for this assistant in any rolling 7 days.
 *
 * Derived from the posting schedule the user already configured — deliberately NOT a separate
 * user-facing field. Volume is chosen once, by the schedule; a second knob would silently contradict
 * it, and a ceiling the user can raise is a ceiling that gets raised the first time it fires.
 *
 * Exceeding it must route the excess to review, never drop it.
 */
export function autoPublishWeeklyCeiling(onboardingContext: unknown, now: Date = new Date()): number {
    const schedule = resolvePostingSchedule((onboardingContext as Record<string, unknown> | null) ?? {});
    // Slot count over the next 7 days accounts for posting_days × posting_times, which the raw
    // posting_frequency string does not (e.g. "daily" with only Mon/Wed selected is 2, not 7).
    const slotsThisWeek = computeScheduleSlots({ schedule, horizonDays: 7, now }).length;
    return slotsThisWeek + AUTO_PUBLISH_WEEKLY_BUFFER;
}

/** Plain-language volume for the settings UI: what the user's own schedule implies. */
export function describeAutoPublishVolume(onboardingContext: unknown, now: Date = new Date()): string {
    const schedule = resolvePostingSchedule((onboardingContext as Record<string, unknown> | null) ?? {});
    const slots = computeScheduleSlots({ schedule, horizonDays: 7, now }).length;
    if (slots === 0) return 'This assistant has no posting schedule, so Autopilot will rarely publish on its own.';
    return `About ${slots} post${slots === 1 ? '' : 's'} a week will publish without review, matching your posting schedule.`;
}

export interface GateDecision {
    status: DraftStatus;
    reason: GateReason;
    /** null when we short-circuited before scoring (review mode, or AI media). */
    confidence: ConfidenceResult | null;
}

/**
 * Pull the publishPolicy map out of an assistant's onboardingContext, tolerating
 * null / non-object / garbage values (the column is free-form jsonb).
 */
export function readPublishPolicy(onboardingContext: unknown): PublishPolicy {
    if (!onboardingContext || typeof onboardingContext !== 'object') return {};

    const raw = (onboardingContext as Record<string, unknown>).publishPolicy;
    if (!raw || typeof raw !== 'object') return {};

    const policy: PublishPolicy = {};
    for (const [platform, mode] of Object.entries(raw as Record<string, unknown>)) {
        if (mode === 'auto_publish' || mode === 'review') policy[platform] = mode;
    }
    return policy;
}

/** Resolved mode for one platform, defaulting to review. */
export function getPlatformMode(onboardingContext: unknown, platform: string): PublishMode {
    return readPublishPolicy(onboardingContext)[platform] ?? DEFAULT_PUBLISH_MODE;
}

/**
 * Whether the deployer has opted this assistant into auto-publishing posts whose image was
 * AI-generated. Off by default (condition #2 below): an AI image built from an AI-written prompt
 * would otherwise reach a real account with nobody having seen it. Stored as a top-level boolean on
 * onboardingContext.allowAiMediaAutoPublish, toggled in the Operational Setup → Autopilot card.
 */
export function readAllowAiMediaAutoPublish(onboardingContext: unknown): boolean {
    if (!onboardingContext || typeof onboardingContext !== 'object') return false;
    return (onboardingContext as Record<string, unknown>).allowAiMediaAutoPublish === true;
}

/**
 * The gate itself. Call once per autonomous draft, before the scheduledPosts insert.
 *
 * Both short-circuits skip the LLM call: review mode is the default for every assistant, and
 * AI media is disqualifying regardless of what the caption scores, so there is nothing to buy
 * by scoring it.
 */
export async function gateAutonomousDraft(args: {
    caption: string;
    platform: string;
    onboardingContext: unknown;
    /** From resolveMediaForPost(). AI-generated media can never auto-publish — see below. */
    mediaSource: MediaSource;
}): Promise<GateDecision> {
    if (getPlatformMode(args.onboardingContext, args.platform) !== 'auto_publish') {
        return { status: 'pending_approval', reason: 'platform_in_review_mode', confidence: null };
    }

    // The confidence scorer reads the CAPTION only. On an image-first platform that leaves the
    // riskiest half of the post ungated: an AI image generated from an AI-written prompt would
    // reach a real account with no human ever having seen it. Stock photos and library assets
    // were chosen or uploaded by a person, so they carry that review already. The deployer can
    // opt out of this hold via allowAiMediaAutoPublish (default off) — see readAllowAiMediaAutoPublish.
    if (args.mediaSource === 'ai' && !readAllowAiMediaAutoPublish(args.onboardingContext)) {
        return { status: 'pending_approval', reason: 'unreviewed_ai_media', confidence: null };
    }

    const confidence = await scoreCaption(args.caption);

    if (isAutoPublishEligible(confidence)) {
        return { status: 'scheduled', reason: 'auto_published', confidence };
    }

    // Distinguish the "needs a human" cases for the audit trail. A fallback amber (timeout or an
    // unreadable response) is NOT a verdict on the caption, so it must not be reported as
    // low_confidence — otherwise a permanently broken scorer reads as a cautious one.
    const reason: GateReason = !isScoreTrustworthy(confidence)
        ? 'scoring_unavailable'
        : confidence.confidenceScore !== 'green'
            ? 'low_confidence'
            : 'factual_claims';

    return { status: 'pending_approval', reason, confidence };
}
