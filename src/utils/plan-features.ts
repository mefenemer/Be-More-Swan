// src/utils/plan-features.ts
// Dynamic Product Catalog — feature gating. Features are derived at read-time from the
// user's ACTIVE plan's master_plans.features map (activating a plan grants its features,
// which is what the webhook does on checkout.session.completed / invoice.paid — AC3.2.3).
// Mirrors how numeric limits are derived in check-capacity.ts.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { plans, masterPlans } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** The active plan's feature map, e.g. { unlock_trending_audio: true, bonus_assistants: 1 }. */
export async function getActiveFeatures(db: Db, userId: number): Promise<Record<string, unknown>> {
    const [row] = await db
        .select({ features: masterPlans.features })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
        .orderBy(plans.startedAt)
        .limit(1);
    return (row?.features as Record<string, unknown>) ?? {};
}

/** True when the active plan unlocks `featureKey` (truthy value). */
export async function hasFeature(db: Db, userId: number, featureKey: string): Promise<boolean> {
    const features = await getActiveFeatures(db, userId);
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
