// src/utils/feature-revenue.ts — the revenue behind each feature request (2026-11-12).
//
// Votes count people; this counts money: for each request, the monthly LIST price of every distinct
// paying workspace behind it — the submitter's workspace plus each voter's workspaces. A workspace
// counts once per request however many of its people voted. Shown beside votes on Feature requests
// (card, "Most revenue" sort, "From paying customers" filter), so the roadmap can weigh both without
// following the biggest accounts alone. Prices come from org-plan-value.ts (list, not discounted).

import { inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { featureRequestVotes, userOrganisations } from '../../db/schema';
import { loadOrgPlanValues, type OrgPlanValue } from './org-plan-value';

type Db = ReturnType<typeof getDb>;

export interface FeatureRevenue { monthlyGbp: number; payingWorkspaces: number }

/** Pure: sum the distinct paying workspaces behind each request. */
export function sumFeatureRevenue(orgsByFeature: Map<number, Set<number>>, values: Map<number, OrgPlanValue>): Map<number, FeatureRevenue> {
    const out = new Map<number, FeatureRevenue>();
    for (const [featureId, orgs] of orgsByFeature) {
        let monthlyGbp = 0; let payingWorkspaces = 0;
        for (const org of orgs) {
            const v = values.get(org);
            if (v && v.paying) { monthlyGbp += v.monthlyGbp; payingWorkspaces++; }
        }
        out.set(featureId, { monthlyGbp: Math.round(monthlyGbp * 100) / 100, payingWorkspaces });
    }
    return out;
}

/** Feature id → revenue behind it. Never throws (zeros on failure). */
export async function loadFeatureRevenue(db: Db, features: Array<{ id: number; organisationId: number | null }>): Promise<Map<number, FeatureRevenue>> {
    const orgsByFeature = new Map<number, Set<number>>();
    for (const f of features) {
        const set = new Set<number>();
        if (Number.isInteger(f.organisationId)) set.add(f.organisationId as number);
        orgsByFeature.set(f.id, set);
    }
    if (!features.length) return new Map();
    try {
        const votes = await db.select({ featureId: featureRequestVotes.featureId, userId: featureRequestVotes.userId })
            .from(featureRequestVotes).where(inArray(featureRequestVotes.featureId, features.map((f) => f.id)));
        const voterIds = [...new Set(votes.map((v) => v.userId))];
        const memberships = voterIds.length
            ? await db.select({ userId: userOrganisations.userId, organisationId: userOrganisations.organisationId })
                .from(userOrganisations).where(inArray(userOrganisations.userId, voterIds))
            : [];
        const orgsOfUser = new Map<number, number[]>();
        for (const m of memberships) {
            if (!orgsOfUser.has(m.userId)) orgsOfUser.set(m.userId, []);
            orgsOfUser.get(m.userId)!.push(m.organisationId);
        }
        for (const v of votes) for (const org of orgsOfUser.get(v.userId) || []) orgsByFeature.get(v.featureId)?.add(org);
        const allOrgs = [...new Set([...orgsByFeature.values()].flatMap((s) => [...s]))];
        return sumFeatureRevenue(orgsByFeature, await loadOrgPlanValues(db, allOrgs));
    } catch (e) {
        console.error('[feature-revenue] failed:', e instanceof Error ? e.message : e);
        return new Map();
    }
}
