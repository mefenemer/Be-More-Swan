// src/utils/auto-publish-runtime.ts
// The db-aware half of the Autopilot publish gate. src/utils/publish-policy.ts stays pure (and
// therefore unit-testable); this module adds the two checks that need a database:
//
//   1. Is there a live connection to publish through? publish-instagram.ts hard-fails on a post
//      with no connection_id, so a post that cannot publish must never skip review — it would just
//      fail unattended, which is the worst place for a failure to surface.
//   2. Has this assistant already used up its rolling-7-day unattended-publish allowance?
//
// Both drafting engines call decideAutoPublish():
//   - netlify/functions/process-content-jobs.ts     (the cadence engine — the posting schedule)
//   - netlify/functions/autonomous-media-suggestions.ts (the secondary empty-slot gap-filler)
//
// Every failure path lands on 'pending_approval'. Nothing here can ever turn a review-bound draft
// into a published one; it can only decline to promote.

import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import {
    gateAutonomousDraft,
    autoPublishWeeklyCeiling,
    AUTO_PUBLISH_STALE_AFTER_H,
    AUTONOMOUS_DRAFT_PLATFORMS,
    type AutonomousDraftPlatform,
    type GateDecision,
    type MediaSource,
} from './publish-policy';
import { normalizePlatform } from '../config/platform-formats';
import { resolveLiveSocialConnections } from './live-social-connections';
import { resolveAssistantEnabledPlatforms, type AssistantPlatformScope } from './assistant-platform-selection';

type Db = ReturnType<typeof getDb>;

/**
 * The platforms an assistant should autonomously DRAFT for: the org's LIVE connections intersected
 * with the platforms a drafter actually exists for, and — when the caller passes the assistant —
 * with the platforms the user has switched ON for that assistant. Order follows
 * AUTONOMOUS_DRAFT_PLATFORMS for determinism. Empty when the org has no live connection on any
 * drafter platform — callers fall back to their legacy single-stream default.
 *
 * Liveness comes from resolveLiveSocialConnections, which reads BOTH credential stores. It used to
 * query system_connections directly, which meant a connected Threads account — whose token lives in
 * workspace_integrations — was invisible here: Autopilot fanned every cross-post across the four
 * legacy platforms and dropped Threads with no error to explain the missing post.
 *
 * `assistant` is optional and its absence means "org-level answer only", which is what the caller
 * wants when there is no single assistant in scope. Pass it wherever there is one: connected and
 * enabled are two different questions, and answering only the first is why turning a platform off
 * in an assistant's Connections tab changed nothing about what it drafted.
 */
export async function resolveConnectedDraftPlatforms(
    db: Db,
    orgId: number,
    assistant?: Omit<AssistantPlatformScope, 'organisationId'>,
): Promise<AutonomousDraftPlatform[]> {
    const live = await resolveLiveSocialConnections(db, orgId);
    const connected = AUTONOMOUS_DRAFT_PLATFORMS.filter(p => live.has(p));
    if (!assistant) return connected;
    const enabled = await resolveAssistantEnabledPlatforms(db, { organisationId: orgId, ...assistant });
    return enabled ? connected.filter(p => enabled.has(p)) : connected;
}

export interface AutoPublishDecision extends GateDecision {
    /** The connection the post must publish through. Null when review-bound. */
    connectionId: number | null;
}

/**
 * The org's live connection for a platform. Mirrors publish-social-posts' resolution, including its
 * two-store lookup.
 *
 * `live` and `connectionId` are SEPARATE answers, and conflating them was a bug: a workspace-backed
 * platform (Threads) is genuinely connected while having no system_connections row to point at, so
 * a bare `number | null` read as "not connected" and forced every Threads draft to review with
 * reason 'no_live_connection'. A null connectionId is fine downstream — scheduled_posts.connection_id
 * is nullable and the publisher falls back to resolving by (organisation, platform).
 */
async function findLiveConnection(db: Db, orgId: number, platform: string): Promise<{ live: boolean; connectionId: number | null }> {
    const key = normalizePlatform(platform);
    if (!key) return { live: false, connectionId: null };
    const conn = (await resolveLiveSocialConnections(db, orgId)).get(key);
    return { live: !!conn, connectionId: conn?.connectionId ?? null };
}

/** Posts this assistant has already published unattended inside the trailing 7 days. */
async function countRecentAutoPublishes(db: Db, assistantId: number, now: Date): Promise<number> {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.assistantId, assistantId),
            gte(scheduledPosts.autoPublishedAt, weekAgo),
        ));
    return row?.n ?? 0;
}

/**
 * Decide whether one autonomously-drafted post may skip human review.
 *
 * Order matters: the cheap, local checks (policy, media source) run first inside
 * gateAutonomousDraft, which short-circuits before paying for the confidence-scoring LLM call.
 * Only a draft that has already cleared those reaches the two database round-trips below.
 */
export async function decideAutoPublish(db: Db, args: {
    assistantId: number;
    organisationId: number;
    platform: string;
    caption: string;
    mediaSource: MediaSource;
    onboardingContext: unknown;
    /**
     * The slot this post is for. Absent means unknown, which is treated as on time — a caller that
     * cannot say when the post is due must not have its drafts silently held back.
     */
    publishDate?: Date | null;
    now?: Date;
}): Promise<AutoPublishDecision> {
    const now = args.now ?? new Date();

    const gate = await gateAutonomousDraft({
        caption: args.caption,
        platform: args.platform,
        onboardingContext: args.onboardingContext,
        mediaSource: args.mediaSource,
    });

    // The connection is stamped on the row either way: a review-bound post still needs it to publish
    // once a human approves, and nothing else in the codebase ever sets scheduled_posts.connection_id.
    const { live, connectionId } = await findLiveConnection(db, args.organisationId, args.platform);

    if (gate.status !== 'scheduled') return { ...gate, connectionId };

    if (!live) {
        return { ...gate, status: 'pending_approval', reason: 'no_live_connection', connectionId };
    }

    // Runaway guard. Counted, not reserved: two jobs in the same batch can both read a count just
    // under the ceiling and both promote. Overshoot is bounded by the batch size and the buffer, and
    // the failure direction is "one extra post published", not "a post lost" — acceptable for a
    // safety net whose job is catching a duplicated cron, not enforcing an exact quota.
    const ceiling = autoPublishWeeklyCeiling(args.onboardingContext, now);
    const used = await countRecentAutoPublishes(db, args.assistantId, now);
    if (used >= ceiling) {
        return { ...gate, status: 'pending_approval', reason: 'weekly_cap_reached', connectionId };
    }

    // ── Is this draft still for a moment that is coming? ─────────────────────────────────────────
    //
    // ⚠️ Nothing here asked. The gate weighed publish mode, media, confidence, claims, the connection
    // and the weekly ceiling, then promoted the draft to 'scheduled' — and publish-social-posts takes
    // anything scheduled with publish_date <= now() on its next tick. So a post drafted a week after
    // its slot published INSTANTLY, unread, and read to the customer as the product deciding by
    // itself to post something stale.
    //
    // Whether a draft is late is not something the drafter can know. The job carries the slot, the
    // post inherits it, and how long the job waited in a queue is invisible from here — which is why
    // the check belongs at the moment of the decision rather than anywhere upstream of it.
    //
    // Review, never a drop: the post is complete and a human may still want it out. It arrives in the
    // queue with generationReason explaining that the moment passed.
    const dueAt = args.publishDate ? args.publishDate.getTime() : null;
    if (dueAt != null && Number.isFinite(dueAt)) {
        const hoursLate = (now.getTime() - dueAt) / 3_600_000;
        if (hoursLate > AUTO_PUBLISH_STALE_AFTER_H) {
            return { ...gate, status: 'pending_approval', reason: 'slot_has_passed', connectionId };
        }
    }

    return { ...gate, connectionId };
}

/** Human-readable trail for generationReason, so a queue can be debugged without reading code. */
export function describeDecision(decision: AutoPublishDecision): string {
    if (decision.status === 'scheduled') {
        return 'Auto-published: Autopilot is in publish mode for this platform and the caption scored green with no factual claims.';
    }
    // ⚠️ Spelled out rather than left as "slot has passed". Every other reason here names something
    // the reviewer already knows about — their publish mode, their connection, their weekly ceiling.
    // This one names something they have never seen: the post was written for a moment that went by
    // while it waited, which sounds like a fault unless it says why it is in front of them and what
    // publishing it now would mean.
    if (decision.reason === 'slot_has_passed') {
        return 'Sent for review: this was written for a time that has already passed, so Autopilot did '
            + 'not publish it unattended. Approving it will publish straight away — check it still reads '
            + 'as current, or move it to a new slot first.';
    }
    return `Sent for review (${decision.reason.replace(/_/g, ' ')}).`;
}
