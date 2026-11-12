// src/utils/org-plan-value.ts — what each workspace pays, for support triage (2026-11-12).
//
// One read used by the Fix pipeline (a plan tag and a paying-customer alert on issues) and
// Feature requests (weighting ideas by the revenue behind them). LIST prices from master_plans,
// not Stripe: these are list screens and an hourly-ish signal, and a Stripe call per row would be
// slow and rate-limited. Discounts are therefore not applied — the COGS dashboard (billed-mrr.ts)
// is where exact billed revenue lives. Beta and trial plans pay nothing, so count £0.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { plans, masterPlans } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Plan states that still bill (or will this period). */
export const PAYING_PLAN_STATUSES = ['active', 'past_due', 'cancelling', 'downgrading'] as const;

export interface OrgPlanValue { planName: string; monthlyGbp: number; paying: boolean }

/** Pure: one plan row → its value. Beta / trial → £0, not paying. */
export function planValue(row: { planName: string | null; planType: string | null; monthlyPriceGbp: string | number | null; status: string | null }): OrgPlanValue {
    const free = row.planType === 'beta' || row.planType === 'trial';
    const price = free ? 0 : Number.parseFloat(String(row.monthlyPriceGbp ?? '0')) || 0;
    const billing = (PAYING_PLAN_STATUSES as readonly string[]).includes(String(row.status));
    return { planName: row.planName || 'No plan', monthlyGbp: billing ? price : 0, paying: billing && price > 0 };
}

/** Workspace id → plan value, for the given workspaces. Never throws (an empty map on failure). */
export async function loadOrgPlanValues(db: Db, orgIds: Array<number | null | undefined>): Promise<Map<number, OrgPlanValue>> {
    const out = new Map<number, OrgPlanValue>();
    const ids = [...new Set(orgIds.filter((x): x is number => Number.isInteger(x)))];
    if (!ids.length) return out;
    try {
        const rows = await db
            .select({ orgId: plans.organisationId, planName: plans.planName, planType: plans.planType, status: plans.status, monthlyPriceGbp: masterPlans.monthlyPriceGbp })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(inArray(plans.organisationId, ids), inArray(plans.status, [...PAYING_PLAN_STATUSES])));
        for (const r of rows) {
            const v = planValue(r);
            const prev = out.get(r.orgId);
            // A workspace mid-change can have two rows: keep the one that pays more.
            if (!prev || v.monthlyGbp > prev.monthlyGbp) out.set(r.orgId, v);
        }
    } catch (e) {
        console.error('[org-plan-value] read failed:', e instanceof Error ? e.message : e);
    }
    return out;
}
