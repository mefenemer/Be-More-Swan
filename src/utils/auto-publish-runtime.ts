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
    AUTONOMOUS_DRAFT_PLATFORMS,
    type AutonomousDraftPlatform,
    type GateDecision,
    type MediaSource,
} from './publish-policy';
import { normalizePlatform } from '../config/platform-formats';
import { resolveLiveSocialConnections } from './live-social-connections';

type Db = ReturnType<typeof getDb>;

/**
 * The platforms an assistant should autonomously DRAFT for: the org's LIVE connections intersected
 * with the platforms a drafter actually exists for. This mirrors findLiveConnection's liveness
 * filter exactly, so we only ever draft for a platform the post could genuinely publish to —
 * connecting a platform is all it takes, no onboarding config to keep in sync. Order follows
 * AUTONOMOUS_DRAFT_PLATFORMS for determinism. Empty when the org has no live connection on any
 * drafter platform — callers fall back to their legacy single-stream default.
 *
 * Liveness comes from resolveLiveSocialConnections, which reads BOTH credential stores. It used to
 * query system_connections directly, which meant a connected Threads account — whose token lives in
 * workspace_integrations — was invisible here: Autopilot fanned every cross-post across the four
 * legacy platforms and dropped Threads with no error to explain the missing post.
 */
export async function resolveConnectedDraftPlatforms(db: Db, orgId: number): Promise<AutonomousDraftPlatform[]> {
    const live = await resolveLiveSocialConnections(db, orgId);
    return AUTONOMOUS_DRAFT_PLATFORMS.filter(p => live.has(p));
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

    return { ...gate, connectionId };
}

/** Human-readable trail for generationReason, so a queue can be debugged without reading code. */
export function describeDecision(decision: AutoPublishDecision): string {
    return decision.status === 'scheduled'
        ? 'Auto-published: Autopilot is in publish mode for this platform and the caption scored green with no factual claims.'
        : `Sent for review (${decision.reason.replace(/_/g, ' ')}).`;
}
