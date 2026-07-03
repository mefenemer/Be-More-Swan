// src/utils/feature-requests.ts
// Shared constants/helpers for the Feature Requests & Roadmap module (see db/feature-requests.sql).
//
// Single source of truth for the category/status/priority sets, their labels, the public-board
// and roadmap status groupings, quarter parsing, and the status-change notification broadcast.
// KEEP IN SYNC with the SQL CHECK constraints in db/feature-requests.sql.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { featureRequests, featureRequestVotes, notifications } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

// ── Category ──────────────────────────────────────────────────────────────────
export const FR_CATEGORIES = ['app_core', 'existing_assistant', 'new_assistant'] as const;
export type FeatureCategory = (typeof FR_CATEGORIES)[number];

export const FR_CATEGORY_LABEL: Record<FeatureCategory, string> = {
    app_core: 'App Core',
    existing_assistant: 'Existing Assistant',
    new_assistant: 'New Assistant',
};

export const isFeatureCategory = (v: unknown): v is FeatureCategory =>
    typeof v === 'string' && (FR_CATEGORIES as readonly string[]).includes(v);

// ── Status ────────────────────────────────────────────────────────────────────
export const FR_STATUSES = [
    'pending_review', 'under_review', 'open', 'planned',
    'in_progress', 'released', 'declined', 'duplicate',
] as const;
export type FeatureStatus = (typeof FR_STATUSES)[number];

export const FR_STATUS_LABEL: Record<FeatureStatus, string> = {
    pending_review: 'Pending Review',
    under_review: 'Under Review',
    open: 'Open',
    planned: 'Planned',
    in_progress: 'In Progress',
    released: 'Released',
    declined: 'Declined',
    duplicate: 'Duplicate',
};

export const isFeatureStatus = (v: unknown): v is FeatureStatus =>
    typeof v === 'string' && (FR_STATUSES as readonly string[]).includes(v);

// Statuses that appear on the PUBLIC board (US02): approved/visible to everyone.
export const PUBLIC_STATUSES: readonly FeatureStatus[] = ['open', 'planned', 'in_progress', 'released'];
// Statuses that appear on the read-only ROADMAP / Gantt (US03/US05).
export const ROADMAP_STATUSES: readonly FeatureStatus[] = ['planned', 'in_progress'];

export const isPublicStatus = (s: string): boolean => (PUBLIC_STATUSES as readonly string[]).includes(s);

// ── Priority (carried over from the old admin roadmap) ──────────────────────────
export const FR_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FeaturePriority = (typeof FR_PRIORITIES)[number];

export const FR_PRIORITY_LABEL: Record<FeaturePriority, string> = {
    critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};

export const isFeaturePriority = (v: unknown): v is FeaturePriority =>
    typeof v === 'string' && (FR_PRIORITIES as readonly string[]).includes(v);

// ── Quarters ───────────────────────────────────────────────────────────────────
// target_quarter is stored as 'YYYY-Qn' (e.g. '2026-Q3').
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

export const isQuarter = (v: unknown): v is string =>
    typeof v === 'string' && QUARTER_RE.test(v);

/** Parse 'YYYY-Qn' → { year, quarter } (numbers), or null if malformed. */
export function parseQuarter(v: string): { year: number; quarter: number } | null {
    const m = QUARTER_RE.exec(v);
    return m ? { year: Number(m[1]), quarter: Number(m[2]) } : null;
}

/** Sort key so quarters order chronologically (e.g. 2026-Q3 → 20263). */
export function quarterSortKey(v: string): number {
    const p = parseQuarter(v);
    return p ? p.year * 10 + p.quarter : Number.MAX_SAFE_INTEGER;
}

// ── sort_order helper (mirrors feature-roadmap.ts) ──────────────────────────────
/** sort_order placing a new item at the TOP of the admin board (one below the current min). */
export async function nextTopSortOrder(db: Db): Promise<number> {
    const [row] = await db
        .select({ min: sql<number | null>`min(${featureRequests.sortOrder})` })
        .from(featureRequests);
    const min = row?.min;
    return (typeof min === 'number' ? min : 0) - 1;
}

// ── US06: status-change notifications ───────────────────────────────────────────
// Notify the original submitter + everyone who upvoted when a feature's status changes.
// Best-effort: never throws — a notification failure must not roll back the admin's status update.
export async function broadcastFeatureStatusChange(
    db: Db,
    feature: { id: number; title: string; submittedBy: number | null },
    newStatus: FeatureStatus,
): Promise<number> {
    try {
        // Recipients = submitter ∪ voters (deduped).
        const voters = await db
            .select({ userId: featureRequestVotes.userId })
            .from(featureRequestVotes)
            .where(eq(featureRequestVotes.featureId, feature.id));

        const ids = new Set<number>();
        if (feature.submittedBy) ids.add(feature.submittedBy);
        for (const v of voters) ids.add(v.userId);
        if (!ids.size) return 0;

        const released = newStatus === 'released';
        const type = released ? 'feature_released' : 'feature_status_change';
        const statusLabel = FR_STATUS_LABEL[newStatus] || newStatus;
        const title = released
            ? `🎉 A feature you backed has shipped: ${feature.title}`
            : `Feature update: ${feature.title}`;
        const message = released
            ? `"${feature.title}" is now Released. Thanks for helping shape Be More Swan.`
            : `"${feature.title}" moved to ${statusLabel}.`;

        const rows = [...ids].map((userId) => ({
            userId,
            type,
            title,
            message,
            metadata: { featureId: feature.id, status: newStatus },
        }));
        await db.insert(notifications).values(rows);
        return rows.length;
    } catch (err) {
        console.error('[feature-requests] broadcastFeatureStatusChange failed:', err);
        return 0;
    }
}

// ── Vote-count maintenance ──────────────────────────────────────────────────────
/** Recompute and persist vote_count for a feature from the votes table. Returns the count. */
export async function syncVoteCount(db: Db, featureId: number): Promise<number> {
    const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(featureRequestVotes)
        .where(eq(featureRequestVotes.featureId, featureId));
    const count = row?.n ?? 0;
    await db.update(featureRequests)
        .set({ voteCount: count, updatedAt: new Date() })
        .where(eq(featureRequests.id, featureId));
    return count;
}

/** The set of feature ids the given user has upvoted, among the supplied ids. */
export async function votedFeatureIds(db: Db, userId: number, featureIds: number[]): Promise<Set<number>> {
    if (!featureIds.length) return new Set();
    const rows = await db
        .select({ featureId: featureRequestVotes.featureId })
        .from(featureRequestVotes)
        .where(and(
            eq(featureRequestVotes.userId, userId),
            inArray(featureRequestVotes.featureId, featureIds),
        ));
    return new Set(rows.map((r) => r.featureId));
}
