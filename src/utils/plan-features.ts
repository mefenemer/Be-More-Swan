// src/utils/plan-features.ts
// Dynamic Product Catalog — feature gating. Features are derived at read-time from the
// user's ACTIVE plan's master_plans.features map (activating a plan grants its features,
// which is what the webhook does on checkout.session.completed / invoice.paid — AC3.2.3).
// Mirrors how numeric limits are derived in check-capacity.ts.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { plans, masterPlans } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

// The numeric capacity limits that can be frozen per-subscription in plans.featureOverrides.
// A "new subscribers only" plan change snapshots the OLD values here for existing subscribers,
// so enforcement must prefer the snapshot over the live master_plans column when present.
export type LimitKey =
    | 'assistantLimit' | 'monthlyTaskLimit' | 'monthlyTokenLimit'
    | 'appConnectionLimit' | 'seatLimit' | 'storageLimitBytes';

/** Shape of plans.featureOverrides — a frozen snapshot of a subscription's limits + features. */
export interface FeatureOverrides {
    assistantLimit?: number | null;
    monthlyTaskLimit?: number | null;
    monthlyTokenLimit?: number | null;
    appConnectionLimit?: number | null;
    seatLimit?: number | null;
    storageLimitBytes?: number | null;
    features?: Record<string, unknown>;
}

/**
 * The effective value of a single numeric limit for a subscription: the frozen snapshot value
 * when the subscription has a "new subscribers only" override, otherwise the live master value.
 * `undefined` in the snapshot means "not frozen" → fall back to live; an explicit `null` means
 * "frozen as unlimited".
 */
export function effectiveLimit(
    overrides: FeatureOverrides | null | undefined,
    key: LimitKey,
    masterValue: number | null,
): number | null {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
        return (overrides[key] ?? null) as number | null;
    }
    return masterValue ?? null;
}

/** Effective feature map: the frozen snapshot's features when present, else the live master features. */
export function effectiveFeatures(
    overrides: FeatureOverrides | null | undefined,
    masterFeatures: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
    if (overrides && overrides.features) return overrides.features;
    return masterFeatures ?? {};
}

/** The active plan's feature map (snapshot-aware), e.g. { unlock_trending_audio: true, bonus_assistants: 1 }. */
export async function getActiveFeatures(db: Db, userId: number): Promise<Record<string, unknown>> {
    const [row] = await db
        .select({ features: masterPlans.features, featureOverrides: plans.featureOverrides })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
        .orderBy(plans.startedAt)
        .limit(1);
    return effectiveFeatures(
        row?.featureOverrides as FeatureOverrides | null,
        row?.features as Record<string, unknown> | null,
    );
}

/** True when the active plan unlocks `featureKey` (truthy value). */
export async function hasFeature(db: Db, userId: number, featureKey: string): Promise<boolean> {
    const features = await getActiveFeatures(db, userId);
    return !!features[featureKey];
}

/** The active plan's feature map for an organisation (snapshot-aware) — org-scoped `getActiveFeatures`. */
export async function getActiveFeaturesByOrg(db: Db, orgId: number): Promise<Record<string, unknown>> {
    const [row] = await db
        .select({ features: masterPlans.features, featureOverrides: plans.featureOverrides })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active')))
        .orderBy(plans.startedAt)
        .limit(1);
    return effectiveFeatures(
        row?.featureOverrides as FeatureOverrides | null,
        row?.features as Record<string, unknown> | null,
    );
}

/** True when the organisation's active plan unlocks `featureKey` (truthy value). */
export async function hasFeatureByOrg(db: Db, orgId: number, featureKey: string): Promise<boolean> {
    const features = await getActiveFeaturesByOrg(db, orgId);
    return !!features[featureKey];
}

/** The active plan's tier key for an organisation (e.g. 'saver' | 'employee'), or null if none. */
export async function getActiveTierKeyByOrg(db: Db, orgId: number): Promise<string | null> {
    const [row] = await db
        .select({ tierKey: masterPlans.tierKey })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active')))
        .orderBy(plans.startedAt)
        .limit(1);
    return row?.tierKey ?? null;
}
