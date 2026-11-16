// src/utils/calculator-prices.ts
// price(<id>) in a calculator form's formula (FR#43 Phase 2): the product's price, read from Products
// at submit time so a price change applies to the next visitor.
//
// ⚠️ ONLY THE FORM'S OWN WORKSPACE. The id comes from a formula anyone with builder access wrote; the
// organisation comes from the stored form. Another workspace's product is "no price", never its price.
// Only active products with a 'fixed' or 'from' price count: "on request" has no number to give.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { orgProducts } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/** Pence → pounds (or cents → dollars), by product id. Missing ids simply aren't in the result. */
export async function loadCalculatorPrices(db: Db, organisationId: number, ids: number[]): Promise<Record<number, number>> {
    const wanted = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
    if (!wanted.length) return {};
    const rows = await db
        .select({ id: orgProducts.id, priceType: orgProducts.priceType, priceAmount: orgProducts.priceAmount, status: orgProducts.status })
        .from(orgProducts)
        .where(and(eq(orgProducts.organisationId, organisationId), inArray(orgProducts.id, wanted)));
    const out: Record<number, number> = {};
    for (const r of rows) {
        if (r.status !== 'active' || r.priceAmount == null) continue;
        if (r.priceType !== 'fixed' && r.priceType !== 'from') continue;
        out[r.id] = r.priceAmount / 100;
    }
    return out;
}
