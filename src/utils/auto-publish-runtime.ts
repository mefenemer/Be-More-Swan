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
import { scheduledPosts, systemConnections } from '../../db/schema';
import {
    gateAutonomousDraft,
    autoPublishWeeklyCeiling,
    type GateDecision,
    type MediaSource,
} from './publish-policy';

type Db = ReturnType<typeof getDb>;

export interface AutoPublishDecision extends GateDecision {
    /** The connection the post must publish through. Null when review-bound. */
    connectionId: number | null;
}

/** The org's live connection for a platform, or null. Mirrors publish-social-posts' resolution. */
async function findLiveConnection(db: Db, orgId: number, platform: string): Promise<number | null> {
    const [conn] = await db
        .select({ id: systemConnections.id })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.serviceName, platform),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ))
        .limit(1);
    return conn?.id ?? null;
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
    const connectionId = await findLiveConnection(db, args.organisationId, args.platform);

    if (gate.status !== 'scheduled') return { ...gate, connectionId };

    if (connectionId === null) {
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
        ? 'Auto-published: Autopilot is in publish mode for this platform, the caption scored green with no factual claims, and the image was not AI-generated.'
        : `Sent for review (${decision.reason.replace(/_/g, ' ')}).`;
}
