// src/utils/team-seats.ts
// Who may invite team members, and how many seats an organisation has.
//
// Inviting people into a workspace IS the "Workspace Collaboration" plan feature ("Invite team
// members, managers, or clients to view and approve outputs"), sold on The Digital Employee only.
// Until 2026-10-12 nothing read that feature: invite-member.ts gated on master_plans.seat_limit
// alone, where NULL meant "1 seat" — and every plan's seat_limit was NULL, so no customer on any plan
// could invite anyone, including the ones who had paid for collaboration.
//
// The rule now, in one place (invite-member.ts refuses, manage-members.ts reports, the Team tab shows):
//   - plan without workspace_collaboration → the owner alone (1 seat); existing members are kept
//   - plan with it → seat_limit if one is set (> 0), otherwise no cap
// Both read through plans.feature_overrides, so a "new subscribers only" plan change is honoured.

import { and, eq, inArray, desc } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { plans, masterPlans } from '../../db/schema';
import { effectiveFeatures, effectiveLimit, type FeatureOverrides } from './plan-features';

type Db = ReturnType<typeof getDb>;

export const COLLABORATION_FEATURE = 'workspace_collaboration';

export interface TeamAllowance {
    /** The plan includes Workspace Collaboration — the organisation may invite people. */
    collaboration: boolean;
    /** Most memberships (owner + members + pending invites) allowed; null = no cap. */
    maxSeats: number | null;
    /** The plan's display name, for messages ("…on The Workflow Saver"). */
    planName: string | null;
}

/** Pure: the allowance for a plan's (snapshot-aware) features and seat limit. */
export function teamAllowanceFrom(
    features: Record<string, unknown>,
    seatLimit: number | null,
    planName: string | null = null,
): TeamAllowance {
    // Strictly true: the Busywork Buster carries 'coming_soon' (owner, 2026-10-20 — invites are not
    // finished), which the pricing table shows as a pill and which must never switch invites on.
    const v = features[COLLABORATION_FEATURE];
    const collaboration = v === true || v === 'true';
    if (!collaboration) return { collaboration, maxSeats: 1, planName };
    return { collaboration, maxSeats: seatLimit && seatLimit > 0 ? seatLimit : null, planName };
}

/** Whether one more membership fits. */
export function canAddSeat(allowance: TeamAllowance, currentSeats: number): boolean {
    return allowance.maxSeats === null || currentSeats < allowance.maxSeats;
}

/** The organisation's team allowance from its current plan (active, else past_due). */
export async function getTeamAllowance(db: Db, orgId: number): Promise<TeamAllowance> {
    const rows = await db
        .select({
            status: plans.status,
            name: masterPlans.name,
            features: masterPlans.features,
            seatLimit: masterPlans.seatLimit,
            featureOverrides: plans.featureOverrides,
        })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, orgId), inArray(plans.status, ['active', 'past_due'])))
        .orderBy(desc(plans.startedAt));
    const row = rows.find((r) => r.status === 'active') ?? rows[0];
    if (!row) return teamAllowanceFrom({}, null, null);
    const overrides = row.featureOverrides as FeatureOverrides | null;
    return teamAllowanceFrom(
        effectiveFeatures(overrides, row.features as Record<string, unknown> | null),
        effectiveLimit(overrides, 'seatLimit', row.seatLimit ?? null),
        row.name ?? null,
    );
}

/** The message shown when an invite does not fit. */
export function seatRefusal(allowance: TeamAllowance): { error: string; code: string } {
    if (!allowance.collaboration) {
        return {
            error: `Inviting team members isn't available yet — it's coming soon to The Busywork Buster. For a team today, ask us about a Bespoke Assistant.`,
            code: 'COLLABORATION_NOT_IN_PLAN',
        };
    }
    return {
        error: `You've used all ${allowance.maxSeats} seats on your plan. Remove a member or contact us to add more.`,
        code: 'SEAT_LIMIT_REACHED',
    };
}
