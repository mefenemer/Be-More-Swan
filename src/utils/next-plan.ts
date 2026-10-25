// src/utils/next-plan.ts
// The next plan up: the cheapest active, self-serve plan that costs more than the current one. One query
// for the upgrade modal (check-capacity.ts nextPlan) and the Business Mentor's "who to hire next"
// (src/utils/mentor-hire.ts), so both name the same plan.

import { and, asc, eq, gt } from 'drizzle-orm';
import { masterPlans, planPrices } from '../../db/schema';
import { BETA_TIER_KEY } from '../config/beta-plan';

type Db = any;

export interface NextPlan {
    tierKey: string;
    name: string;
    monthlyPriceGbp: string;
    /** In the billing currency when it isn't GBP. */
    monthlyPrice: string;
    assistantLimit: number | null;
    monthlyTaskLimit: number | null;
}

/** null = already on the highest self-serve plan, on the beta plan, or the current price is unknown. */
export async function loadNextPlan(
    db: Db, current: { monthlyPriceGbp: unknown; tierKey: string | null | undefined }, currency = 'GBP',
): Promise<NextPlan | null> {
    // A beta plan costs £0, so "the cheapest plan above it" would offer the ENTRY plan as an
    // upgrade from top-tier limits. Beta testers get no upgrade suggestion at all.
    if (current.monthlyPriceGbp == null || current.tierKey === BETA_TIER_KEY) return null;
    const [row] = await db
        .select({
            tierKey: masterPlans.tierKey,
            name: masterPlans.name,
            monthlyPriceGbp: masterPlans.monthlyPriceGbp,
            assistantLimit: masterPlans.assistantLimit,
            // The upgrade modal's "what you get" list names the next plan's task allowance —
            // read here so workspace.html never hardcodes it (it said "2,750" by hand).
            monthlyTaskLimit: masterPlans.monthlyTaskLimit,
            masterPlanId: masterPlans.id,
        })
        .from(masterPlans)
        .where(and(
            eq(masterPlans.isActive, true),
            // Contact-sales Enterprise is never a self-serve upgrade: with the Digital Employee
            // retired (17 Oct 2026) it is the only priced plan above £79, and offering it here
            // sent buyers to a checkout with no Stripe price. null → the enterprise contact path.
            eq(masterPlans.isContactSales, false),
            gt(masterPlans.monthlyPriceGbp, current.monthlyPriceGbp as any),
        ))
        .orderBy(asc(masterPlans.monthlyPriceGbp))
        .limit(1);
    if (!row) return null;
    // US-I18N-2.1 SC5: look up price in user's billing currency
    let monthlyPrice = String(row.monthlyPriceGbp);
    if (currency !== 'GBP') {
        const [priceRow] = await db
            .select({ monthlyPriceMajorUnit: planPrices.monthlyPriceMajorUnit })
            .from(planPrices)
            .where(and(eq(planPrices.masterPlanId, row.masterPlanId), eq(planPrices.currency, currency), eq(planPrices.isActive, true)))
            .limit(1);
        if (priceRow) monthlyPrice = String(priceRow.monthlyPriceMajorUnit);
    }
    return { tierKey: row.tierKey, name: row.name, monthlyPriceGbp: String(row.monthlyPriceGbp), monthlyPrice, assistantLimit: row.assistantLimit, monthlyTaskLimit: row.monthlyTaskLimit };
}
