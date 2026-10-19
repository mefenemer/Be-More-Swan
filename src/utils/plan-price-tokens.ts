// src/utils/plan-price-tokens.ts
//
// Plan prices for text that is written once and read later — emails and help articles. Owner,
// 2026-10-19: no surface may carry its own copy of a plan price. When The Busywork Buster moved
// from £79 to £69, "£79" survived on five surfaces that had typed it in. Text now says
// {{plans.saver_price}} / {{plans.buster_price}} and the value is read from master_plans
// (Admin ▸ Master Data ▸ Plans) at the moment it is shown or sent.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { masterPlans } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** The tiers a token can name, and the token key for each. */
const PRICED_TIERS = { saver: 'saver_price', buster: 'buster_price' } as const;

export type PlanPriceVars = { saver_price: string; buster_price: string };

export function formatGbp(amount: number | string): string {
    const n = Number(amount);
    return n > 0 ? '£' + n.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '';
}

/** Monthly prices of the sold plans, formatted ("£69"). A tier that is missing reads ''. */
export async function planPriceVars(db: Db): Promise<PlanPriceVars> {
    const rows = await db.select({ tierKey: masterPlans.tierKey, price: masterPlans.monthlyPriceGbp })
        .from(masterPlans)
        .where(and(eq(masterPlans.isActive, true), inArray(masterPlans.tierKey, Object.keys(PRICED_TIERS))));
    const vars: PlanPriceVars = { saver_price: '', buster_price: '' };
    for (const r of rows) {
        const key = PRICED_TIERS[r.tierKey as keyof typeof PRICED_TIERS];
        if (key) vars[key] = formatGbp(r.price);
    }
    return vars;
}

/** Replace {{plans.saver_price}} / {{plans.buster_price}} in text. Unknown tokens are left alone. */
export function fillPlanPriceTokens(text: string, vars: PlanPriceVars): string {
    return text.replace(/\{\{\s*plans\.(saver_price|buster_price)\s*\}\}/g, (whole, key: keyof PlanPriceVars) => vars[key] || whole);
}
