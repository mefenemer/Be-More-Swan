// src/utils/feature-roadmap.ts
// Shared constants/helpers for the admin Feature Roadmap board (see db/feature-roadmap.sql).

import { eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { featureRoadmap, featureRequests } from '../../db/schema';
import { nextTopSortOrder as nextTopFeatureRequestSortOrder } from './feature-requests';

type Db = ReturnType<typeof getDb>;

// Priority signal. KEEP IN SYNC with db/feature-roadmap.sql feature_roadmap_priority_check.
export const ROADMAP_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type RoadmapPriority = (typeof ROADMAP_PRIORITIES)[number];

export const ROADMAP_PRIORITY_LABEL: Record<RoadmapPriority, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
};

export function isRoadmapPriority(v: unknown): v is RoadmapPriority {
    return typeof v === 'string' && (ROADMAP_PRIORITIES as readonly string[]).includes(v);
}

// Lifecycle. KEEP IN SYNC with db/feature-roadmap.sql feature_roadmap_status_check.
export const ROADMAP_STATUSES = ['planned', 'in_progress', 'shipped', 'declined'] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const ROADMAP_STATUS_LABEL: Record<RoadmapStatus, string> = {
    planned: 'Planned',
    in_progress: 'In Progress',
    shipped: 'Shipped',
    declined: 'Declined',
};

export function isRoadmapStatus(v: unknown): v is RoadmapStatus {
    return typeof v === 'string' && (ROADMAP_STATUSES as readonly string[]).includes(v);
}

/**
 * The sort_order to use for a brand-new item so it lands at the TOP of the board (lower
 * sorts higher). One below the current minimum; 0 for an empty board.
 */
export async function nextTopSortOrder(db: Db): Promise<number> {
    const [row] = await db
        .select({ min: sql<number | null>`min(${featureRoadmap.sortOrder})` })
        .from(featureRoadmap);
    const min = row?.min;
    return (typeof min === 'number' ? min : 0) - 1;
}

/**
 * Promote a reported issue into the unified Feature Requests board (see
 * feature-requests-roadmap epic). Idempotent on issueId: re-promoting refreshes
 * title/description/priority rather than inserting a duplicate. Admin-originated, so it
 * skips 'pending_review' and lands as 'planned' (source='issue'). Returns the request id.
 */
export async function createRoadmapItemFromIssue(
    db: Db,
    opts: {
        issueId: number;
        title: string;
        description?: string | null;
        priority?: RoadmapPriority;
        createdBy?: number | null;
    },
): Promise<number> {
    const priority: RoadmapPriority = isRoadmapPriority(opts.priority) ? opts.priority : 'medium';
    const title = (opts.title || '').trim().slice(0, 200) || `Feature request from issue #${opts.issueId}`;
    const description = opts.description ?? null;

    const [existing] = await db
        .select({ id: featureRequests.id })
        .from(featureRequests)
        .where(eq(featureRequests.issueId, opts.issueId))
        .limit(1);

    if (existing) {
        await db.update(featureRequests)
            .set({ title, description, priority, updatedAt: new Date() })
            .where(eq(featureRequests.id, existing.id));
        return existing.id;
    }

    const sortOrder = await nextTopFeatureRequestSortOrder(db);
    const [inserted] = await db.insert(featureRequests).values({
        title,
        description,
        priority,
        status: 'planned',
        source: 'issue',
        issueId: opts.issueId,
        sortOrder,
        reviewedBy: opts.createdBy ?? null,
        reviewedAt: new Date(),
    }).returning({ id: featureRequests.id });
    return inserted.id;
}
